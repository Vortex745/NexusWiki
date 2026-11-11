import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain, type BrowserWindow } from 'electron'
import {
  MEMORY_EVENT_CHANNEL,
  MEMORY_RUN_CHANNEL,
  MEMORY_SET_PINNED_CHANNEL,
  MEMORY_STATE_CHANNEL,
  type MemoryEvent,
  type MemorySetPinnedRequest,
  type MemoryState
} from '../../shared/protocol.ts'
import { MEMORY_PINNED_KEY, MEMORY_PINNED_POS_KEY, getSetting, openDb, setSetting } from '../db.ts'
import { errorMessageOf } from '../chat/pi-shared.ts'
import { MODEL_LLM } from '../rag/config.ts'
import { createRagClientFromSettings } from '../rag/siliconflow.ts'
import {
  MEMORY_FILE_NAME,
  createFakeMemoryClient,
  hasNewContent,
  readMemoryMeta,
  runConsolidation,
  type MemoryChatClient
} from './consolidator.ts'

function parsePos(raw: string | undefined): {
  pos?: { x: number; y: number }
  size?: { w: number; h: number }
} {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw) as { x?: unknown; y?: unknown; w?: unknown; h?: unknown }
    if (
      typeof value.x !== 'number' ||
      !Number.isFinite(value.x) ||
      typeof value.y !== 'number' ||
      !Number.isFinite(value.y)
    ) {
      return {}
    }
    const out: { pos: { x: number; y: number }; size?: { w: number; h: number } } = {
      pos: { x: value.x, y: value.y }
    }
    // 老值只有 x/y：尺寸缺省，卡片回落默认正方形
    if (
      typeof value.w === 'number' &&
      Number.isFinite(value.w) &&
      value.w > 0 &&
      typeof value.h === 'number' &&
      Number.isFinite(value.h) &&
      value.h > 0
    ) {
      out.size = { w: value.w, h: value.h }
    }
    return out
  } catch {
    // 坏值按缺省位置处理
    return {}
  }
}

export function registerMemoryIpc(options: {
  getWindow: () => BrowserWindow | null
  rebuildRouterIfIdle: () => void
}): void {
  const { getWindow, rebuildRouterIfIdle } = options
  const db = openDb()
  // 与 chat 同款目录与模式开关：fake 只用于离线验收（3s 延迟给 UI 留出可观测的整理中窗口）
  const agentDir = join(app.getPath('userData'), 'pi-agent')
  const client: MemoryChatClient =
    process.env.SUPER_AGENT_MODE === 'fake' ? createFakeMemoryClient(3000) : createRagClientFromSettings(db)

  let running = false
  let lastError: string | undefined

  const state = (): MemoryState => {
    const file = join(agentDir, MEMORY_FILE_NAME)
    const { pos, size } = parsePos(getSetting(db, MEMORY_PINNED_POS_KEY))
    return {
      status: running ? 'summarizing' : lastError !== undefined ? 'error' : 'idle',
      content: existsSync(file) ? readFileSync(file, 'utf8') : '',
      updatedAt: readMemoryMeta(agentDir).updatedAt,
      pinned: getSetting(db, MEMORY_PINNED_KEY) === '1',
      ...(pos ? { pos } : {}),
      ...(size ? { size } : {}),
      ...(lastError !== undefined ? { error: lastError } : {})
    }
  }

  const sendToWindow = (event: MemoryEvent): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(MEMORY_EVENT_CHANNEL, event)
  }

  const consolidate = async (manual: boolean): Promise<MemoryState> => {
    if (running) throw new Error('记忆整理进行中')
    // 启动触发：无新增连事件都不发（状态保持 idle）；手动触发照常走（runConsolidation 自带无新增短路）
    if (!manual && !hasNewContent(agentDir)) return state()
    running = true
    lastError = undefined
    sendToWindow({ status: 'summarizing' })
    try {
      const result = await runConsolidation({ agentDir, client, model: MODEL_LLM })
      if (result.kind === 'ok') {
        sendToWindow(result.updatedAt ? { status: 'idle', updatedAt: result.updatedAt } : { status: 'idle' })
        rebuildRouterIfIdle()
      } else {
        sendToWindow({ status: 'idle' })
      }
    } catch (err) {
      lastError = errorMessageOf(err)
      sendToWindow({ status: 'error', error: lastError })
    } finally {
      running = false
    }
    return state()
  }

  ipcMain.handle(MEMORY_STATE_CHANNEL, (): MemoryState => state())

  ipcMain.handle(MEMORY_RUN_CHANNEL, async (): Promise<MemoryState> => consolidate(true))

  ipcMain.handle(MEMORY_SET_PINNED_CHANNEL, (_event, request: unknown): void => {
    if (
      typeof request !== 'object' ||
      request === null ||
      typeof (request as MemorySetPinnedRequest).pinned !== 'boolean'
    ) {
      throw new Error(`invalid ${MEMORY_SET_PINNED_CHANNEL} request`)
    }
    const req = request as MemorySetPinnedRequest
    setSetting(db, MEMORY_PINNED_KEY, req.pinned ? '1' : '0')
    if (
      typeof req.x === 'number' &&
      Number.isFinite(req.x) &&
      typeof req.y === 'number' &&
      Number.isFinite(req.y)
    ) {
      const hasSize =
        typeof req.w === 'number' &&
        Number.isFinite(req.w) &&
        req.w > 0 &&
        typeof req.h === 'number' &&
        Number.isFinite(req.h) &&
        req.h > 0
      // 拖动位置时本次可能不带尺寸：合并旧值，别把尺寸丢掉
      const prev = parsePos(getSetting(db, MEMORY_PINNED_POS_KEY))
      const size = hasSize ? { w: req.w, h: req.h } : prev.size
      setSetting(
        db,
        MEMORY_PINNED_POS_KEY,
        JSON.stringify({ x: req.x, y: req.y, ...(size ? { w: size.w, h: size.h } : {}) })
      )
    }
  })

  // 启动即静默整理（有新增才真正跑）；事件早于渲染层就绪会被丢弃，就绪后的 getState 兜底拿全量状态
  void consolidate(false).catch((err) => console.error('[memory] consolidate failed:', err))
}
