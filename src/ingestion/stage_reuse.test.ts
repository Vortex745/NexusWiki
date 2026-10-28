// UT-19：已验证产物复用与分阶段失效。
//
// 契约（UP-10 AC 2/4，经 19 票继承）：恢复/重处理复用"配置匹配且校验通过"
// 的已验证提取——以 parseRaw 调用次数证明节省了哪一阶段；解析配置漂移、
// 证据哈希不匹配（半写/篡改）一律拒绝复用并从保留原件重跑；复用不清除
// 待校验原因；嵌入/索引配置不参与提取复用判定（嵌入变化不无谓废弃原提取）。
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { closeDb, openDb, type DB } from "./tracking"
import { DocumentRepo } from "./tracking/doc_repo"
import { IngestionLifecycle } from "./lifecycle"
import { PipelineStageRunner } from "./pipeline"
import { DirectTextParser, type Parser } from "./parser"
import type { IngestionStoreImpl } from "./storage"
import { loadConfig } from "../config"

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
// loadConfig() 是进程级 memoize：必须在任何 loadConfig 调用之前固定隔离库，
// 否则会落到开发库 data/kefu-rag.db。
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "kefu-rag-ut19-")), "ingestion.db")

const ORIGINAL = Buffer.from(
  "UT-19 复用样本。否定校验：不支持口头申请。结尾校验词：复用-42。\n",
  "utf8"
)

function makeStore() {
  const runs: Array<Array<{ id: string; content: string }>> = []
  const store = {
    async storeChunks(chunks: Array<{ id: string; content: string }>): Promise<unknown> {
      runs.push(chunks.map((chunk) => ({ id: chunk.id, content: chunk.content })))
      return {
        chunkCount: chunks.length, passageCount: chunks.length, batchCount: 1,
        embeddingBatchCount: 1, embeddingRequestCount: 1, embeddingRetryCount: 0,
        embeddingRateLimitCount: 0, embeddingDurationMs: 1, rateLimitWaitMs: 0,
        bulkRequestCount: 1, bulkDurationMs: 1,
      }
    },
    async storeEntities(): Promise<void> {},
    async storeWikilinks(): Promise<void> {},
    get chunkIndexName(): string { return "fake-index" },
    async close(): Promise<void> {},
  }
  return { store: store as unknown as IngestionStoreImpl, runs }
}

function makeCountingResolveParser(counter: { parseRawCalls: number }) {
  const inner = new DirectTextParser()
  return (_type: string): Parser => ({
    type: "direct-txt",
    parse: (input) => inner.parse(input),
    parseRaw: async (input) => {
      counter.parseRawCalls += 1
      return inner.parseRaw(input)
    },
    normalizeRaw: (raw, documentId) => inner.normalizeRaw(raw, documentId),
    extractionProvenance: () => inner.extractionProvenance(),
  })
}

function makeLifecycle(db: DB, counter: { parseRawCalls: number }) {
  const { store, runs } = makeStore()
  const lifecycle = new IngestionLifecycle(
    db,
    new PipelineStageRunner(db, makeCountingResolveParser(counter) as never, store)
  )
  return { lifecycle, runs }
}

test("UT-19 a) completed reprocess creates a new version and re-extracts", async () => {
  const counter = { parseRawCalls: 0 }
  const db = openDb()
  const { lifecycle, runs } = makeLifecycle(db, counter)
  const submitted = lifecycle.submit({
    title: "UT-19 新版本",
    content: "",
    rawContent: ORIGINAL,
    fileName: "reuse.txt",
    mimeType: "text/plain",
    sourceIdentity: { kind: "file", uriOrExternalId: "C:/truth/ut19/reuse.txt", namespace: "ut19" },
  })
  const first = await lifecycle.runNext()
  assert.ok(first?.success)
  assert.equal(counter.parseRawCalls, 1, "首次运行真实解码一次")
  assert.equal(lifecycle.getStatus(submitted.docId)?.documentVersion.active, true)

  const reprocess = lifecycle.reprocess(submitted.docId)
  assert.ok(reprocess, "重处理命令有结果")
  assert.equal(reprocess.changed, true)
  assert.notEqual(reprocess.docId, submitted.docId, "重处理必须创建新文档版本")
  const second = await lifecycle.runNext()
  assert.ok(second?.success)
  assert.equal(counter.parseRawCalls, 2, "新版本重新提取，不复用旧版本缓存")
  assert.ok(runs[1].length > 0, "新版本产生独立块集合")
  assert.equal(lifecycle.getStatus(submitted.docId)?.documentVersion.active, false)
  assert.equal(lifecycle.getStatus(reprocess.docId)?.documentVersion.active, true)
})

test("UT-19 b) completed reprocess ignores old evidence drift and re-extracts", async () => {
  const counter = { parseRawCalls: 0 }
  const db = openDb()
  const { lifecycle } = makeLifecycle(db, counter)
  const submitted = lifecycle.submit({
    title: "UT-19 配置漂移",
    content: "",
    rawContent: ORIGINAL,
    fileName: "drift.txt",
    mimeType: "text/plain",
    sourceIdentity: { kind: "file", uriOrExternalId: "C:/truth/ut19/drift.txt", namespace: "ut19" },
  })
  await lifecycle.runNext()
  assert.equal(counter.parseRawCalls, 1)

  db.prepare(
    "UPDATE extraction_artifacts SET parser_config_version = 'drifted-fingerprint' WHERE doc_id = ?"
  ).run(submitted.docId)

  const reprocess = lifecycle.reprocess(submitted.docId)
  assert.ok(reprocess)
  await lifecycle.runNext()
  assert.equal(counter.parseRawCalls, 2, "completed reprocess re-extracts regardless of old evidence")
  assert.notEqual(reprocess.docId, submitted.docId)
})

test("UT-19 c) 证据损坏：哈希不匹配的半写证据拒绝复用", async () => {
  const counter = { parseRawCalls: 0 }
  const db = openDb()
  const { lifecycle } = makeLifecycle(db, counter)
  const submitted = lifecycle.submit({
    title: "UT-19 损坏证据",
    content: "",
    rawContent: ORIGINAL,
    fileName: "tampered.txt",
    mimeType: "text/plain",
    sourceIdentity: { kind: "file", uriOrExternalId: "C:/truth/ut19/tampered.txt", namespace: "ut19" },
  })
  await lifecycle.runNext()

  db.prepare(
    "UPDATE extraction_artifacts SET raw_extraction = raw_extraction || 'x' WHERE doc_id = ?"
  ).run(submitted.docId)

  lifecycle.reprocess(submitted.docId)
  await lifecycle.runNext()
  assert.equal(counter.parseRawCalls, 2, "半写/篡改证据不能借缓存绕过核验——从原件重跑")
})

test("UT-19 d) 复用不清除待校验：GBK 样本重处理后理由码保留", async () => {
  const counter = { parseRawCalls: 0 }
  const db = openDb()
  const { lifecycle } = makeLifecycle(db, counter)
  const documentRepo = new DocumentRepo(db)
  const submitted = lifecycle.submit({
    title: "UT-19 GBK 复用",
    content: "",
    rawContent: readFileSync("golden/upload-truth/txt/legacy-gbk.txt"),
    fileName: "legacy-gbk.txt",
    mimeType: "text/plain",
    sourceIdentity: { kind: "file", uriOrExternalId: "C:/truth/ut19/gbk.txt", namespace: "ut19" },
  })
  await lifecycle.runNext()
  const decodeBefore = (documentRepo.get(submitted.docId)?.metadata.system as {
    decode?: { reviewRequired?: boolean; reviewReason?: string }
  }).decode
  assert.equal(decodeBefore?.reviewReason, "ambiguous_encoding")
  assert.equal(documentRepo.getActivationBlockReason(submitted.docId), null)

  lifecycle.reprocess(submitted.docId)
  await lifecycle.runNext()
  const decodeAfter = (documentRepo.get(submitted.docId)?.metadata.system as {
    decode?: { reviewRequired?: boolean; reviewReason?: string }
  }).decode
  assert.deepEqual(decodeAfter, decodeBefore, "复用不清除解码风险元数据")
  assert.equal(documentRepo.getActivationBlockReason(submitted.docId), null)
})

test("UT-19 收尾：关闭隔离库", () => {
  closeDb()
})
