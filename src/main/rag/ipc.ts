import { join } from 'node:path'
import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import {
  RAG_GET_DOCS_CHANNEL,
  RAG_IMPORT_EVENT_CHANNEL,
  RAG_IMPORT_PICK_CHANNEL,
  RAG_LOGIN_CHANNEL,
  RAG_REMOVE_DOC_CHANNEL,
  RAG_SEARCH_TEST_CHANNEL,
  type RagDocInfo,
  type RagGetDocsResponse,
  type RagImportPickResponse,
  type RagLoginRequest,
  type RagLoginResponse,
  type RagRemoveDocRequest,
  type RagSearchTestRequest,
  type RagSearchTestResponse
} from '../../shared/protocol.ts'
import { openDb } from '../db.ts'
import { answerQuestion } from './answer.ts'
import { ensureAdminSeed, loginAdmin, verifyJwt } from './auth.ts'
import { createImportQueue } from './importer.ts'
import { parsePdf, resolveParsePdfScriptPath } from './pymupdf.ts'
import { retrieve } from './retrieval.ts'
import { createRagClientFromSettings } from './siliconflow.ts'
import { deleteDoc, listDocs } from './store.ts'

function sendToWindow(getWindow: () => BrowserWindow | null, channel: string, payload: unknown): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

export function registerRagIpc(getWindow: () => BrowserWindow | null): void {
  const db = openDb()
  ensureAdminSeed(db)

  const client = createRagClientFromSettings(db)
  const queue = createImportQueue({
    db,
    client,
    parsePdf: (pdfPath, outDir) => parsePdf({ pdfPath, outDir, scriptPath: resolveParsePdfScriptPath(), db }),
    workRoot: join(app.getPath('userData'), 'rag-work'),
    onEvent: (event) => sendToWindow(getWindow, RAG_IMPORT_EVENT_CHANNEL, event)
  })

  // 三个门控 handler 共用的 token 校验（写一次）
  const requireToken = (request: unknown): string => {
    const token = typeof request === 'object' && request !== null ? (request as { token?: unknown }).token : undefined
    if (typeof token !== 'string' || !verifyJwt(db, token)) throw new Error('unauthorized')
    return token
  }

  ipcMain.handle(RAG_LOGIN_CHANNEL, (_event, request: unknown): RagLoginResponse => {
    if (
      typeof request !== 'object' ||
      request === null ||
      typeof (request as RagLoginRequest).username !== 'string' ||
      typeof (request as RagLoginRequest).password !== 'string'
    ) {
      throw new Error(`invalid ${RAG_LOGIN_CHANNEL} request`)
    }
    const token = loginAdmin(db, (request as RagLoginRequest).username, (request as RagLoginRequest).password)
    if (token === null) throw new Error('用户名或密码错误')
    return { token }
  })

  ipcMain.handle(RAG_GET_DOCS_CHANNEL, (_event, request: unknown): RagGetDocsResponse => {
    requireToken(request)
    return {
      docs: listDocs(db).map((doc): RagDocInfo => ({
        id: doc.id,
        title: doc.title,
        summary: doc.summary,
        pageCount: doc.pageCount,
        chunkCount: doc.chunkCount,
        status: doc.status,
        formatIssues: JSON.parse(doc.formatIssues ?? '[]') as string[],
        createdAt: doc.createdAt
      }))
    }
  })

  ipcMain.handle(RAG_IMPORT_PICK_CHANNEL, async (_event, request: unknown): Promise<RagImportPickResponse> => {
    requireToken(request)
    const picked = await dialog.showOpenDialog({
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { jobId: '' }
    return { jobId: queue.enqueue(picked.filePaths[0]) }
  })

  ipcMain.handle(RAG_REMOVE_DOC_CHANNEL, (_event, request: unknown): void => {
    requireToken(request)
    const docId = typeof request === 'object' && request !== null ? (request as RagRemoveDocRequest).docId : undefined
    if (typeof docId !== 'string') throw new Error(`invalid ${RAG_REMOVE_DOC_CHANNEL} request`)
    deleteDoc(db, docId)
  })

  // 检索/作答抛错就让它 reject（渲染层把消息显示成错误行），不在主进程吞
  ipcMain.handle(RAG_SEARCH_TEST_CHANNEL, async (_event, request: unknown): Promise<RagSearchTestResponse> => {
    requireToken(request)
    const query = typeof request === 'object' && request !== null ? (request as RagSearchTestRequest).query : undefined
    if (typeof query !== 'string') throw new Error(`invalid ${RAG_SEARCH_TEST_CHANNEL} request`)
    const passages = await retrieve(db, client, query)
    const { answer } = await answerQuestion(client, query, passages)
    return {
      passages: passages.map(({ docId, docTitle, heading, content, score }) => ({ docId, docTitle, heading, content, score })),
      answer
    }
  })
}
