// UT-16：索引条目清单与内容核验。
//
// 契约（UP-09 AC 1/2/5，经 16 票继承）：索引逐项写入与期望来源块一致——
// 逻辑身份、数量、正文哈希、向量缺一不可（同数量错正文/漏一块/缺向量/
// 多余条目都不通过并给出稳定理由码）；bulk 错误与部分写入可观察、不激活；
// 重复写入不造出重复有效条目（确定性 id 幂等）；条目校验≠检索可见（联合
// 门槛仍拒绝）。集成测试用真实 Elasticsearch + 受控确定性向量。
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { config as dotenvConfig } from "dotenv"
import type { Client } from "@elastic/elasticsearch"
import type { OpenAI } from "openai"
import { closeDb, openDb } from "./tracking"
import { DocumentRepo } from "./tracking/doc_repo"
import { ExpectedChunkRepository } from "./tracking/expected_chunk_repo"
import { IngestionLifecycle } from "./lifecycle"
import { PipelineStageRunner } from "./pipeline"
import { verifyIndexEntries, type IndexEntrySnapshot } from "./index_verification"
import { evaluateActivationGate } from "./activation_gate"
import { IngestionStoreImpl } from "./storage"
import type { Chunk } from "../types"
import { createElasticsearchClient } from "../clients"
import { loadConfig, resolveChunkIndexName } from "../config"

const HERE = dirname(__filename)
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
// 真实 ES/嵌入配置来自生产 .env（与生产代码一致；不覆盖已有环境变量）。
dotenvConfig({ path: process.env.DOTENV_CONFIG_PATH, override: false })
// loadConfig() 是进程级 memoize：必须在任何 loadConfig 调用之前固定隔离库。
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "kefu-rag-ut16-")), "ingestion.db")

const TRUTH_DIR_TXT = resolve(HERE, "../../golden/upload-truth/txt")
const TRUTH_DIR_PDF = resolve(HERE, "../../golden/upload-truth/pdf")

// ---------------------------------------------------------------------------
// 单元：verifyIndexEntries
// ---------------------------------------------------------------------------

function makeEntries(count: number): Array<{ chunkId: string; contentSha256: string }> {
  return Array.from({ length: count }, (_, i) => ({
    chunkId: `chunk-${i}`,
    contentSha256: `hash-${i}`,
  }))
}

function snapshot(content: string | null, embeddingDims: number | null): IndexEntrySnapshot {
  return {
    content,
    embedding: embeddingDims === null ? null : Array.from({ length: embeddingDims }, () => 0.1),
  }
}

test("UT-16 单元：身份/数量/正文哈希/向量全部一致才 pass", () => {
  const entries = new Map<string, IndexEntrySnapshot>([
    ["chunk-0", snapshot("正文零", 1024)],
    ["chunk-1", snapshot("正文一", 1024)],
  ])
  // 期望哈希必须与真实内容一致——先算出来再放进期望清单。
  const fixed = makeEntries(2).map((entry, i) => ({
    chunkId: entry.chunkId,
    contentSha256: createHash("sha256")
      .update(`正文${["零", "一"][i]}`, "utf8")
      .digest("hex"),
  }))
  const ok = verifyIndexEntries({ expected: fixed, entries })
  assert.equal(ok.verdict, "pass")
  assert.equal(ok.verifiedCount, 2)
  assert.deepEqual(ok.reasonCodes, [])

  // 漏一块
  const entriesMissing = new Map(entries)
  entriesMissing.delete("chunk-1")
  const missing = verifyIndexEntries({ expected: fixed, entries: entriesMissing })
  assert.equal(missing.verdict, "fail")
  assert.ok(missing.reasonCodes.includes("index_missing_chunks"))
  assert.deepEqual(missing.missingChunkIds, ["chunk-1"])

  // 同数量错正文（哈希不匹配）
  const entriesWrong = new Map<string, IndexEntrySnapshot>([
    ["chunk-0", snapshot("正文零", 1024)],
    ["chunk-1", snapshot("被篡改的正文", 1024)],
  ])
  const mismatch = verifyIndexEntries({ expected: fixed, entries: entriesWrong })
  assert.equal(mismatch.verdict, "fail")
  assert.ok(mismatch.reasonCodes.includes("index_content_hash_mismatch"))

  // 缺向量
  const entriesNoVector = new Map<string, IndexEntrySnapshot>([
    ["chunk-0", snapshot("正文零", null)],
    ["chunk-1", snapshot("正文一", 1024)],
  ])
  const noVector = verifyIndexEntries({ expected: fixed, entries: entriesNoVector })
  assert.equal(noVector.verdict, "fail")
  assert.ok(noVector.reasonCodes.includes("index_missing_vectors"))

  // 期望之外的多余条目
  const entriesExtra = new Map(entries)
  entriesExtra.set("chunk-rogue", snapshot("凭空条目", 1024))
  const extra = verifyIndexEntries({ expected: fixed, entries: entriesExtra })
  assert.equal(extra.verdict, "fail")
  assert.ok(extra.reasonCodes.includes("index_extra_entries"))
  assert.equal(extra.extraEntryCount, 1)
})

// ---------------------------------------------------------------------------
// 集成：真实 Elasticsearch + 受控确定性向量
// ---------------------------------------------------------------------------

async function esAvailable(es: Client): Promise<boolean> {
  try {
    await Promise.race([
      es.info(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("probe timeout")), 5000)),
    ])
    return true
  } catch {
    return false
  }
}

function deterministicEmbeddingClient(dims: number): OpenAI {
  return {
    embeddings: {
      create: async (request: { input: string[] }) => ({
        data: request.input.map((_, index) => ({
          index,
          embedding: Array.from({ length: dims }, (_, d) => ((d + 1) % 7) / 10),
        })),
      }),
    },
  } as unknown as OpenAI
}

test("UT-16 集成：真实 ES 写入后核验通过，重复写入幂等且故障注入可观察", async (t) => {
  const config = loadConfig()
  const es = createElasticsearchClient({ node: config.esNode, apiKey: config.esApiKey || undefined })
  if (!(await esAvailable(es))) {
    t.skip("Elasticsearch 不可达——真实索引核验未验收（如实单列）")
    return
  }

  const store = new IngestionStoreImpl({
    esClient: es,
    embeddingClient: deterministicEmbeddingClient(config.embeddingDimensions),
    embeddingModel: config.embeddingModel,
    embeddingDimensions: config.embeddingDimensions,
    indexName: resolveChunkIndexName(undefined, config),
  })

  const captured: Chunk[] = []
  const storeProxy = {
    storeChunks: async (chunks: Chunk[], meta: unknown, signal?: AbortSignal) => {
      captured.push(...chunks)
      return store.storeChunks(chunks, meta as never, signal)
    },
    readIndexEntries: (documentId: string, chunkIds: string[]) =>
      store.readIndexEntries(documentId, chunkIds),
    countVisibleIndexEntries: (documentId: string, chunkIds: string[]) =>
      store.countVisibleIndexEntries(documentId, chunkIds),
    storeEntities: async () => {},
    storeWikilinks: async () => {},
    chunkIndexName: store.chunkIndexName,
    close: async () => {},
  } as unknown as IngestionStoreImpl

  const db = openDb()
  const lifecycle = new IngestionLifecycle(db, new PipelineStageRunner(db, undefined as never, storeProxy))
  const submitted = lifecycle.submit({
    title: "UT-16 索引核验",
    content: "",
    rawContent: readFileSync(join(TRUTH_DIR_TXT, "utf8-baseline.txt")),
    fileName: "utf8-baseline.txt",
    mimeType: "text/plain",
    knowledgeBaseId: "kb-ut16",
    sourceIdentity: { kind: "file", uriOrExternalId: "C:/truth/ut16/baseline.txt", namespace: "ut16", tenantId: "ut16" },
  })
  const result = await lifecycle.runNext()
  assert.ok(result?.success, "摄取必须完成")

  const documentRepo = new DocumentRepo(db)
  const manifest = new (await import("./tracking/expected_chunk_repo")).ExpectedChunkRepository(db).list(submitted.docId)
  assert.ok(manifest.length > 0)

  // 核验通过：写入即核验，indexProof pass 与清单一致。
  const evidence = documentRepo.getCandidateEvidence(submitted.docId) as {
    contentProof: { verdict: string }
    indexProof: {
      verdict: "pass" | "fail"
      reasonCodes: string[]
      expectedCount: number
      verifiedCount: number
      missingChunkIds: string[]
      contentMismatchChunkIds: string[]
      missingVectorChunkIds: string[]
    }
  }
  assert.equal(evidence.contentProof.verdict, "pass")
  assert.equal(evidence.indexProof.verdict, "pass", JSON.stringify(evidence.indexProof))
  assert.equal(evidence.indexProof.expectedCount, manifest.length)
  assert.equal(evidence.indexProof.verifiedCount, manifest.length)

  // 门槛：内容 pass + 索引 pass + 绑定一致 + 检索可见 → 联合激活放行（UT-17）。
  const gate = evaluateActivationGate(documentRepo.getCandidateEvidence(submitted.docId))
  assert.equal(gate.passed, true, `联合核验应放行：${JSON.stringify(gate.reasonCodes)}`)
  assert.deepEqual(gate.reasonCodes, [])
  const gateDoc = documentRepo.get(submitted.docId)
  const gateSourceId = gateDoc?.sourceId ?? ""
  const activeRow = db.prepare("SELECT active_doc_id FROM sources WHERE source_id = ?").get(gateSourceId) as { active_doc_id: string | null }
  assert.equal(activeRow.active_doc_id, submitted.docId, "联合核验通过 → 活动身份已切换（端到端激活）")

  // 重复写入：确定性身份幂等，核验仍 pass 且数量不变（不造重复条目）。
  const access = {
    tenantId: "ut16",
    allowedGroups: [] as string[],
    knowledgeBaseId: "kb-ut16",
  }
  await store.storeChunks(captured, access)
  const reread = await store.readIndexEntries(submitted.docId, manifest.map((entry) => entry.chunkId))
  const rereadProof = verifyIndexEntries({ expected: manifest, entries: reread })
  assert.equal(rereadProof.verdict, "pass")
  assert.equal(rereadProof.verifiedCount, manifest.length)

  // 故障注入：删掉一个 ES 条目 → 核验 fail，丢块可观察；门槛拒绝。
  const victim = manifest[0].chunkId
  await es.delete({ index: store.chunkIndexName, id: `${submitted.docId}:${victim}` }, { ignore: [404] })
  await es.indices.refresh({ index: store.chunkIndexName })
  const afterDelete = await store.readIndexEntries(submitted.docId, manifest.map((entry) => entry.chunkId))
  const failProof = verifyIndexEntries({ expected: manifest, entries: afterDelete })
  assert.equal(failProof.verdict, "fail")
  assert.deepEqual(failProof.missingChunkIds, [victim])
  assert.ok(failProof.reasonCodes.includes("index_missing_chunks"))

  // 门槛消费 indexProof fail → 稳定理由码 + 明细。
  documentRepo.setCandidateEvidence(submitted.docId, {
    schemaVersion: 1,
    contentProof: evidence.contentProof,
    indexProof: failProof,
  })
  const gateAfterFailure = evaluateActivationGate(documentRepo.getCandidateEvidence(submitted.docId))
  assert.equal(gateAfterFailure.passed, false)
  assert.equal(gateAfterFailure.reasonCodes[0], "activation_index_proof_failed")
  assert.ok(gateAfterFailure.reasonCodes.includes("index_missing_chunks"))

  // 清理隔离测试数据。
  await es.deleteByQuery({
    index: store.chunkIndexName,
    query: { bool: { filter: [{ term: { documentId: submitted.docId } }, { term: { tenantId: "ut16" } }] } },
    conflicts: "proceed",
    refresh: true,
  })
  await store.close()
})

test("UT-17 收尾前：旧版本保护——v2 内容待校验被拒后 v1 仍保持活动身份", async (t) => {
  const config = loadConfig()
  const es = createElasticsearchClient({ node: config.esNode, apiKey: config.esApiKey || undefined })
  if (!(await esAvailable(es))) {
    t.skip("Elasticsearch 不可达——真实索引核验未验收（如实单列）")
    return
  }

  const store = new IngestionStoreImpl({
    esClient: es,
    embeddingClient: deterministicEmbeddingClient(config.embeddingDimensions),
    embeddingModel: config.embeddingModel,
    embeddingDimensions: config.embeddingDimensions,
    indexName: resolveChunkIndexName(undefined, config),
  })
  const storeProxy = {
    storeChunks: async (chunks: Chunk[], meta: unknown, signal?: AbortSignal) =>
      store.storeChunks(chunks, meta as never, signal),
    readIndexEntries: (documentId: string, chunkIds: string[]) =>
      store.readIndexEntries(documentId, chunkIds),
    countVisibleIndexEntries: (documentId: string, chunkIds: string[]) =>
      store.countVisibleIndexEntries(documentId, chunkIds),
    storeEntities: async () => {},
    storeWikilinks: async () => {},
    chunkIndexName: store.chunkIndexName,
    close: async () => {},
  } as unknown as IngestionStoreImpl

  const db = openDb()
  const documentRepo = new DocumentRepo(db)
  const lifecycle = new IngestionLifecycle(db, new PipelineStageRunner(db, undefined as never, storeProxy))

  // v1：完整样本 → 双凭证通过 → 激活。
  const v1 = lifecycle.submit({
    title: "UT-17 旧版本保护 v1",
    content: "",
    rawContent: readFileSync(join(TRUTH_DIR_PDF, "simple-body.pdf")),
    fileName: "policy.pdf",
    mimeType: "application/pdf",
    sourceIdentity: { kind: "file", uriOrExternalId: "C:/truth/ut17/policy.pdf", namespace: "ut17", tenantId: "ut17" },
  })
  const run1 = await lifecycle.runNext()
  assert.ok(run1?.success)
  const gate1 = evaluateActivationGate(documentRepo.getCandidateEvidence(v1.docId))
  assert.equal(gate1.passed, true, "v1 联合核验通过")
  const activeAfterV1 = db.prepare(
    "SELECT active_doc_id FROM sources WHERE source_id = (SELECT source_id FROM documents WHERE doc_id = ?)"
  ).get(v1.docId) as { active_doc_id: string | null }
  assert.equal(activeAfterV1.active_doc_id, v1.docId, "v1 已激活")

  // v2：混合扫描（内容待校验）→ 被拒，v1 持续可用。
  const v2 = lifecycle.submit({
    title: "UT-17 旧版本保护 v2",
    content: "",
    rawContent: readFileSync(join(TRUTH_DIR_PDF, "mixed-scan.pdf")),
    fileName: "policy.pdf",
    mimeType: "application/pdf",
    versionIntent: "new_version",
    sourceIdentity: { kind: "file", uriOrExternalId: "C:/truth/ut17/policy.pdf", namespace: "ut17", tenantId: "ut17" },
  })
  const run2 = await lifecycle.runNext()
  assert.ok(run2?.success, "v2 阶段完成（内容待校验在门槛层拒绝）")
  const gate2 = evaluateActivationGate(documentRepo.getCandidateEvidence(v2.docId))
  assert.equal(gate2.passed, false, "v2 内容待校验 → 拒绝")
  const activeAfterV2 = db.prepare(
    "SELECT active_doc_id FROM sources WHERE source_id = ?"
  ).get(documentRepo.get(v1.docId)?.sourceId) as { active_doc_id: string | null }
  assert.equal(activeAfterV2.active_doc_id, v1.docId, "被拒候选不切换活动身份，v1 持续可用")

  // 清理隔离测试数据（v1+v2 同源）。
  await es.deleteByQuery({
    index: store.chunkIndexName,
    query: { bool: { filter: [{ term: { documentId: v1.docId } }, { term: { tenantId: "ut17" } }] } },
    conflicts: "proceed",
    refresh: true,
  })
  await es.deleteByQuery({
    index: store.chunkIndexName,
    query: { bool: { filter: [{ term: { documentId: v2.docId } }, { term: { tenantId: "ut17" } }] } },
    conflicts: "proceed",
    refresh: true,
  })
  await store.close()
})

test("UT-16 收尾：关闭隔离库", () => {
  closeDb()
})
