import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureRagTables, listDocs, listPassages, getDoc, getImport, listGroups } from './store.ts'
import { splitPassages, createImportQueue, sanitizeOcrText } from './importer.ts'
import { MODEL_OCR, MODEL_LLM, MODEL_DECISION, OCR_MIN_TEXT_CHARS } from './config.ts'
import type { SiliconFlowClient, SystemOneAnswer } from './siliconflow.ts'
import type { RagImportEvent } from '../../shared/protocol.ts'

interface FakeScript {
  judge?: Record<string, number> | 'throw'
  summary?: string
  ocr?: string
}

function fakeClient(script: FakeScript = {}): {
  client: SiliconFlowClient
  chatCalls: Array<{ model: string }>
  judgeCalls: Array<{ model: string; state: unknown }>
} {
  const chatCalls: Array<{ model: string }> = []
  const judgeCalls: Array<{ model: string; state: unknown }> = []
  const client: SiliconFlowClient = {
    async chatComplete(req) {
      chatCalls.push({ model: req.model })
      if (req.model === MODEL_OCR) return script.ocr ?? '这是扫描页的OCR文本。'
      return script.summary ?? '这是一句话摘要。'
    },
    async systemOne(req) {
      judgeCalls.push({ model: req.model, state: req.state })
      if (script.judge === 'throw') throw new Error('judge down')
      const answers: Record<string, SystemOneAnswer> = {}
      for (const [key, value] of Object.entries(script.judge ?? {})) {
        answers[key] = { type: 'noul', noul: value }
      }
      return answers
    }
  }
  return { client, chatCalls, judgeCalls }
}

const LONG_TEXT = '这是文本层的长内容。'.repeat(40)

function fakeParsePdf(pages: Array<{ text: string }>) {
  return async (_pdfPath: string, outDir: string) => {
    mkdirSync(outDir, { recursive: true })
    return {
      pageCount: pages.length,
      pages: pages.map((page, index) => {
        const imagePath = join(outDir, `page-${index}.png`)
        writeFileSync(imagePath, 'PNGDATA')
        return { index, imagePath, text: page.text }
      })
    }
  }
}

function setup(script: FakeScript = {}, pages: Array<{ text: string }> = [{ text: LONG_TEXT }]) {
  const db = new DatabaseSync(':memory:')
  ensureRagTables(db)
  const { client, chatCalls, judgeCalls } = fakeClient(script)
  const events: RagImportEvent[] = []
  const queue = createImportQueue({
    db,
    client,
    parsePdf: fakeParsePdf(pages),
    onEvent: (event) => events.push(event),
    workRoot: join(tmpdir(), 'rag-importer-test')
  })
  return { db, queue, events, chatCalls, judgeCalls }
}

function waitFor(events: RagImportEvent[], stage: string, timeoutMs = 3000): Promise<void> {
  return waitForPredicate(() => events.some((e) => e.stage === stage), timeoutMs)
}

function waitForPredicate(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout waiting for condition'))
      setTimeout(poll, 5)
    }
    poll()
  })
}

test('splitPassages splits markdown by headings and captures heading names', () => {
  const passages = splitPassages(['## 标题甲\n\n内容一。\n\n## 标题乙\n\n内容二。'])
  assert.deepEqual(passages.map((p) => p.heading), ['标题甲', '标题乙'])
  assert.match(passages[0].content, /内容一/)
  assert.match(passages[1].content, /内容二/)
})

test('splitPassages keeps short text whole and hard-splits oversize text', () => {
  assert.equal(splitPassages(['短文本']).length, 1)
  const big = '这是一个很长的段落句子。'.repeat(200)
  const parts = splitPassages([big], 1000)
  assert.ok(parts.length >= 3)
  assert.ok(parts.every((p) => p.content.length <= 1000))
  assert.equal(parts.map((p) => p.content).join('').replace(/\n/g, '').length, big.length)
})

test('mixed pages: text-layer page skips OCR, scanned page goes to DeepSeek-OCR, doc lands ok', async () => {
  const longText = '字'.repeat(OCR_MIN_TEXT_CHARS + 10)
  const { db, queue, events, chatCalls, judgeCalls } = setup(
    { judge: { title_accuracy: 0.9, chunk_integrity: 0.9, structure_clarity: 0.9 } },
    [{ text: longText }, { text: 'x' }]
  )
  const jobId = queue.enqueue('C:/论文.pdf')
  await waitFor(events, 'done')

  assert.equal(chatCalls.filter((c) => c.model === MODEL_OCR).length, 1)
  assert.equal(chatCalls.filter((c) => c.model === MODEL_LLM).length, 1)
  assert.equal(judgeCalls.length, 1)
  assert.equal(judgeCalls[0].model, MODEL_DECISION)

  const docs = listDocs(db)
  assert.equal(docs.length, 1)
  const doc = docs[0]
  assert.equal(doc.status, 'ok')
  assert.equal(doc.summary, '这是一句话摘要。')
  assert.equal(doc.pageCount, 2)
  assert.equal(doc.chunkCount, listPassages(db, doc.id).length)
  assert.ok(listPassages(db, doc.id).length >= 2)

  const stages = [...new Set(events.map((e) => e.stage))]
  assert.deepEqual(stages, ['parsing', 'extracting', 'chunking', 'summarizing', 'judging', 'done'])
  assert.ok(events.some((e) => e.pageDone === 1 && e.pageCount === 2))
  assert.equal(events.some((e) => e.jobId === jobId), true)
  assert.equal(getImport(db, jobId)?.status, 'done')
})

test('judgement below threshold marks needs-review with the failing question names', async () => {
  const { db, queue, events } = setup(
    { judge: { title_accuracy: 0.95, chunk_integrity: 0.3, structure_clarity: 0.8 } },
    [{ text: LONG_TEXT }]
  )
  queue.enqueue('C:/t.pdf')
  await waitFor(events, 'done')
  const doc = listDocs(db)[0]
  assert.equal(doc.status, 'needs-review')
  assert.deepEqual(JSON.parse(doc.formatIssues ?? '[]'), ['chunk_integrity'])
})

test('judge API failure degrades to unverified without failing the import', async () => {
  const { db, queue, events } = setup({ judge: 'throw' }, [{ text: LONG_TEXT }])
  queue.enqueue('C:/t.pdf')
  await waitFor(events, 'done')
  const doc = listDocs(db)[0]
  assert.equal(doc.status, 'unverified')
  assert.equal(getImport(db, getImportIds(db)[0])?.status, 'done')
})

function getImportIds(db: DatabaseSync): string[] {
  return (db.prepare('SELECT id FROM rag_imports').all() as Array<{ id: string }>).map((r) => r.id)
}

test('OCR grounding layout markers are stripped from passage content', () => {
  assert.equal(
    sanitizeOcrText('<|ref|>title<|/ref|><|det|>[[132, 107, 841, 131]]<|/det|>\n# 标题\n<|ref|>text<|/ref|><|det|>[[1, 2, 3, 4]]<|/det|>\n正文内容。'),
    '# 标题\n正文内容。'
  )
})

test('parse failure fails the import with the error message and persists no doc', async () => {
  const db = new DatabaseSync(':memory:')
  ensureRagTables(db)
  const { client } = fakeClient()
  const events: RagImportEvent[] = []
  const queue = createImportQueue({
    db,
    client,
    parsePdf: async () => {
      throw new Error('python not found')
    },
    onEvent: (event) => events.push(event),
    workRoot: join(tmpdir(), 'rag-importer-test')
  })
  queue.enqueue('C:/bad.pdf')
  await waitFor(events, 'failed')
  assert.deepEqual(listDocs(db), [])
  const failed = getImport(db, getImportIds(db)[0])
  assert.equal(failed?.status, 'failed')
  assert.match(failed?.message ?? '', /python not found/)
})

test('two enqueued jobs run sequentially, not interleaved', async () => {
  const { db, queue, events } = setup({ judge: { title_accuracy: 0.9, chunk_integrity: 0.9, structure_clarity: 0.9 } }, [{ text: LONG_TEXT }])
  const first = queue.enqueue('C:/1.pdf')
  const second = queue.enqueue('C:/2.pdf')
  await waitForPredicate(() => events.some((e) => e.jobId === second && e.stage === 'done'))
  const firstDoneIndex = events.findIndex((e) => e.jobId === first && e.stage === 'done')
  const secondStartIndex = events.findIndex((e) => e.jobId === second && e.stage === 'parsing')
  assert.ok(firstDoneIndex >= 0 && secondStartIndex > firstDoneIndex, 'second job must start only after the first is done')
  assert.equal(listDocs(db).length, 2)
})

test('large docs get positional groups with LLM summaries; small docs get none', async () => {
  const pages = Array.from({ length: 70 }, () => ({ text: '段落内容文字。'.repeat(10) }))
  const { db, queue, events, chatCalls } = setup({ judge: { title_accuracy: 0.9, chunk_integrity: 0.9, structure_clarity: 0.9 } }, pages)
  queue.enqueue('C:/大文档.pdf')
  await waitFor(events, 'done')

  const doc = listDocs(db)[0]
  assert.equal(doc.chunkCount, 70)
  const groups = listGroups(db, doc.id)
  assert.equal(groups.length, 2, '70 passages / 48 per group -> 2 groups')
  assert.deepEqual(groups.map((g) => g.seq), [0, 1])
  assert.equal(groups[0].summary, '这是一句话摘要。')
  const groupSummaryCalls = chatCalls.filter((c) => c.model === MODEL_LLM).length
  assert.equal(groupSummaryCalls, 3, 'doc summary + 2 group summaries')
  const stages = [...new Set(events.map((e) => e.stage))]
  assert.deepEqual(stages, ['parsing', 'extracting', 'chunking', 'grouping', 'summarizing', 'judging', 'done'])

  const small = setup({ judge: { title_accuracy: 0.9, chunk_integrity: 0.9, structure_clarity: 0.9 } }, [{ text: LONG_TEXT }])
  small.queue.enqueue('C:/小文档.pdf')
  await waitFor(small.events, 'done')
  assert.deepEqual(listGroups(small.db, listDocs(small.db)[0].id), [])
})

test('completed doc keeps source path and can be read back by id', async () => {
  const { db, queue, events } = setup({ judge: { title_accuracy: 0.9, chunk_integrity: 0.9, structure_clarity: 0.9 } }, [{ text: LONG_TEXT }])
  queue.enqueue('C:/论文.pdf')
  await waitFor(events, 'done')
  const doc = listDocs(db)[0]
  assert.equal(doc.sourcePath, 'C:/论文.pdf')
  assert.ok(getDoc(db, doc.id))
})
