// UT-15：内容凭证与可解释待校验状态。
//
// 契约（UP-08 AC 1/2/4/5，经 15 票继承）：提取/清洗/切块证据汇成内容凭证
// （绑定同一原件、产物清单与解析配置）；漏页/乱码/结构风险/解码待校验
// 进入 pending_review 并给出稳定理由码；只有内容凭证 pass 且证据完整才
// 具备索引核验资格——页数/无警告/非空输出不单独构成证明；pass 不激活
// （索引半边 fail-closed）；业务批准走同一门槛，不能点击绕过。
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { closeDb, openDb } from "./tracking"
import { DocumentRepo } from "./tracking/doc_repo"
import { ExpectedChunkRepository } from "./tracking/expected_chunk_repo"
import { ExtractionEvidenceRepository } from "./tracking/extraction_evidence_repo"
import { IngestionLifecycle } from "./lifecycle"
import { PipelineStageRunner } from "./pipeline"
import { evaluateActivationGate } from "./activation_gate"
import { SqliteCandidateReviewStore } from "../knowledge/candidate_review_store"
import type { IngestionStoreImpl } from "./storage"

const HERE = dirname(__filename)
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
// loadConfig() 是进程级 memoize：必须在任何 loadConfig 调用之前固定隔离库。
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "kefu-rag-ut15-")), "ingestion.db")

const TRUTH_DIR_TXT = resolve(HERE, "../../golden/upload-truth/txt")
const TRUTH_DIR_PDF = resolve(HERE, "../../golden/upload-truth/pdf")

interface IngestResult {
  docId: string
  sourceId: string
  tenantId: string
}

async function ingestPdf(file: string, uriSuffix = ""): Promise<IngestResult> {
  const db = openDb()
  const fakeStore = {
    async storeChunks(): Promise<unknown> {
      return {
        chunkCount: 1, passageCount: 1, batchCount: 1,
        embeddingBatchCount: 1, embeddingRequestCount: 1, embeddingRetryCount: 0,
        embeddingRateLimitCount: 0, embeddingDurationMs: 1, rateLimitWaitMs: 0,
        bulkRequestCount: 1, bulkDurationMs: 1,
      }
    },
    async storeEntities(): Promise<void> {},
    async storeWikilinks(): Promise<void> {},
    get chunkIndexName(): string { return "fake-index" },
    async close(): Promise<void> {},
  } as unknown as IngestionStoreImpl
  const lifecycle = new IngestionLifecycle(
    db,
    new PipelineStageRunner(db, undefined as never, fakeStore)
  )
  const submitted = lifecycle.submit({
    title: `UT-15 ${file}${uriSuffix}`,
    content: "",
    rawContent: readFileSync(join(TRUTH_DIR_PDF, file)),
    fileName: file,
    mimeType: "application/pdf",
    sourceIdentity: {
      kind: "file",
      uriOrExternalId: `C:/truth/ut15/${file}${uriSuffix}`,
      namespace: "ut15",
    },
  })
  const result = await lifecycle.runNext()
  assert.ok(result?.success, `${file} 必须完成摄取`)
  const document = new DocumentRepo(db).get(submitted.docId)
  assert.ok(document)
  return { docId: submitted.docId, sourceId: document.sourceId, tenantId: document.tenantId ?? "default" }
}

function proofOf(docId: string): {
  verdict: "pass" | "pending_review"
  reasonCodes: string[]
  bindings: {
    rawExtractionSha256: string | null
    parserConfigVersion: string | null
    expectedChunkCount: number
    expectedChunksSha256: string
  }
} {
  const evidence = new DocumentRepo(openDb()).getCandidateEvidence(docId) as {
    schemaVersion: number
    contentProof: {
      verdict: "pass" | "pending_review"
      reasonCodes: string[]
      bindings: {
        rawExtractionSha256: string | null
        parserConfigVersion: string | null
        expectedChunkCount: number
        expectedChunksSha256: string
      }
    }
    indexProof: unknown
  }
  assert.equal(evidence.schemaVersion, 1)
  assert.equal(evidence.indexProof, null, "索引凭证由 UT-16 产出，本票恒缺")
  assert.ok(evidence.contentProof, "内容凭证必须存在")
  return evidence.contentProof
}

test("UT-15 a) 简单 PDF：内容凭证 pass 且绑定原件/清单；pass 只获得索引核验资格", async () => {
  const { docId } = await ingestPdf("simple-body.pdf")

  const proof = proofOf(docId)
  assert.equal(proof.verdict, "pass", `已验证简单范围应为 pass：${JSON.stringify(proof.reasonCodes)}`)
  assert.deepEqual(proof.reasonCodes, [])
  // 绑定：原件哈希与证据行一致；清单大小与期望检索清单一致。
  const evidence = new ExtractionEvidenceRepository(openDb()).get(docId)
  assert.ok(evidence)
  assert.equal(proof.bindings.rawExtractionSha256, evidence.artifact.rawExtractionSha256)
  const manifest = new ExpectedChunkRepository(openDb()).list(docId)
  assert.equal(proof.bindings.expectedChunkCount, manifest.length)
  assert.match(proof.bindings.parserConfigVersion ?? "", /^[0-9a-f]{64}$/)

  // 门槛：内容 pass → 只剩索引半边 fail-closed；绝不激活。
  const gate = evaluateActivationGate(new DocumentRepo(openDb()).getCandidateEvidence(docId))
  assert.equal(gate.passed, false)
  assert.deepEqual(gate.reasonCodes, ["activation_index_proof_missing"])
  const doc = new DocumentRepo(openDb()).get(docId)
  assert.ok(doc)
  assert.equal(
    new DocumentRepo(openDb()).getOperationalState(docId)?.candidateState !== undefined,
    true
  )
  void doc
})

test("UT-15 b) 混合扫描：pending_review 带稳定理由码，门槛拒绝且原因可解释", async () => {
  const { docId } = await ingestPdf("mixed-scan.pdf")

  const proof = proofOf(docId)
  assert.equal(proof.verdict, "pending_review")
  assert.ok(
    proof.reasonCodes.some((code) => code.startsWith("pages_without_text_layer_or_empty")),
    `漏页进入内容结论：${JSON.stringify(proof.reasonCodes)}`
  )
  assert.ok(
    proof.reasonCodes.some((code) => code.includes("structural_risk")),
    "结构风险理由也在结论中"
  )

  const gate = evaluateActivationGate(new DocumentRepo(openDb()).getCandidateEvidence(docId))
  assert.equal(gate.passed, false)
  assert.equal(gate.reasonCodes[0], "activation_content_proof_pending_review")
  assert.ok(
    gate.reasonCodes.some((code) => code.startsWith("pages_without_text_layer_or_empty")),
    "明细码随门槛理由透出"
  )
  // 上传者可从持久状态读到完整阻碍原因。
  const blockReason = new DocumentRepo(openDb()).getActivationBlockReason(docId)
  assert.ok(blockReason?.includes("pages_without_text_layer_or_empty"))
})

test("UT-15 c) GBK 待校验：解码理由进入内容凭证，不以非空文本判完整", async () => {
  const db = openDb()
  const fakeStore = {
    async storeChunks(): Promise<unknown> {
      return {
        chunkCount: 1, passageCount: 1, batchCount: 1,
        embeddingBatchCount: 1, embeddingRequestCount: 1, embeddingRetryCount: 0,
        embeddingRateLimitCount: 0, embeddingDurationMs: 1, rateLimitWaitMs: 0,
        bulkRequestCount: 1, bulkDurationMs: 1,
      }
    },
    async storeEntities(): Promise<void> {},
    async storeWikilinks(): Promise<void> {},
    get chunkIndexName(): string { return "fake-index" },
    async close(): Promise<void> {},
  } as unknown as IngestionStoreImpl
  const lifecycle = new IngestionLifecycle(
    db,
    new PipelineStageRunner(db, undefined as never, fakeStore)
  )
  const submitted = lifecycle.submit({
    title: "UT-15 legacy-gbk",
    content: "",
    rawContent: readFileSync(join(TRUTH_DIR_TXT, "legacy-gbk.txt")),
    fileName: "legacy-gbk.txt",
    mimeType: "text/plain",
    sourceIdentity: { kind: "file", uriOrExternalId: "C:/truth/ut15/legacy-gbk.txt", namespace: "ut15" },
  })
  const result = await lifecycle.runNext()
  assert.ok(result?.success)

  const proof = proofOf(submitted.docId)
  assert.equal(proof.verdict, "pending_review")
  assert.ok(
    proof.reasonCodes.some((code) => code.includes("ambiguous_encoding")),
    `解码待校验进入结论：${JSON.stringify(proof.reasonCodes)}`
  )
})

test("UT-15 d) 业务批准不能点击绕过：approve 后仍不激活且阻碍原因保留", async () => {
  const { docId, sourceId, tenantId } = await ingestPdf("mixed-scan.pdf", "-review")
  const documentRepo = new DocumentRepo(openDb())
  const store = new SqliteCandidateReviewStore(openDb(), documentRepo)

  const reviewResult = store.review(docId, tenantId, "approve", "admin-user", "业务确认通过")
  assert.ok(reviewResult, "审批必须有结果")
  assert.equal(reviewResult!.candidateState, "approved", "业务批准照常记录")
  assert.equal(reviewResult!.activatedAsActive, false, "业务批准不得绕过完整性门槛")

  const sourceRow = openDb().prepare("SELECT active_doc_id FROM sources WHERE source_id = ?").get(sourceId) as { active_doc_id: string | null }
  assert.equal(sourceRow.active_doc_id, null, "候选未激活")
  const blockReason = documentRepo.getActivationBlockReason(docId)
  assert.ok(
    blockReason?.includes("activation_content_proof_pending_review"),
    `审批后阻碍原因仍在：${blockReason}`
  )
})

test("UT-15 收尾：关闭隔离库", () => {
  closeDb()
})
