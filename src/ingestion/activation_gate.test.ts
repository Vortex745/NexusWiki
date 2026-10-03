// UT-04/UT-15/UT-17：联合激活门槛——未知候选不激活与旧版本保护。
//
// 契约（UP-08 AC 2-5 / UP-09 / UT-04/15/16/17）：缺任一凭证、内容待校验、
// 索引核验失败、绑定不一致或检索不可见的候选，在阶段成功、自动激活和人工
// 批准三条路径上都不得切换活动身份，状态给出稳定理由码；双凭证 pass、
// 绑定一致且检索可见的候选由 UT-17 联合核验放行（本文件正向路径用例）。
// 失败/未知/取消候选保留原件；既有活动版本不被批量下架。
import assert from "node:assert/strict"
import test from "node:test"
import { openDb, type DB } from "./tracking/db"
import { DocumentRepo } from "./tracking/doc_repo"
import {
  IngestionLifecycle,
  type IngestionStageRunner,
  type StageExecution,
} from "./lifecycle"
import {
  ACTIVATION_BLOCKED_CONTENT_PROOF_PENDING_REVIEW,
  ACTIVATION_BLOCKED_CONTENT_PROOF_MISSING,
  ACTIVATION_BLOCKED_EVIDENCE_RECORD_MISSING,
  ACTIVATION_BLOCKED_EVIDENCE_SCHEMA_MISMATCH,
  ACTIVATION_BLOCKED_INDEX_PROOF_FAILED,
  ACTIVATION_BLOCKED_INDEX_PROOF_MISSING,
  ACTIVATION_BLOCKED_NOT_SEARCHABLE,
  ACTIVATION_BLOCKED_PROOF_BINDING_MISMATCH,
  evaluateActivationGate,
} from "./activation_gate"
import { SqliteCandidateReviewStore } from "../knowledge/candidate_review_store"
import { activeTermsFilterFor, NO_ACTIVE_DOCUMENT_SENTINEL } from "../retrieval/search/searcher"

function completingRunner(): IngestionStageRunner {
  return {
    close: async () => {},
    async run(_document, execution: StageExecution): Promise<void> {
      for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
        await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
      }
    },
  }
}

test("UT-04 门槛判定：缺记录/畸形/缺任一凭证都以稳定理由码拒绝", () => {
  const missing = evaluateActivationGate(null)
  assert.equal(missing.passed, false)
  assert.deepEqual(missing.reasonCodes, [ACTIVATION_BLOCKED_EVIDENCE_RECORD_MISSING])
  assert.equal(missing.reason, ACTIVATION_BLOCKED_EVIDENCE_RECORD_MISSING)

  for (const malformed of ["evidence", [], 42]) {
    const decision = evaluateActivationGate(malformed)
    assert.equal(decision.passed, false)
    assert.deepEqual(decision.reasonCodes, [ACTIVATION_BLOCKED_EVIDENCE_SCHEMA_MISMATCH])
  }

  // UT-15 更新：内容核验先于索引核验——记录缺失时首先报内容凭证缺失。
  const empty = evaluateActivationGate({ schemaVersion: 1, contentProof: null, indexProof: null })
  assert.deepEqual(empty.reasonCodes, [ACTIVATION_BLOCKED_CONTENT_PROOF_MISSING])

  // 内容凭证 malformed → schema mismatch；内容 pass 而索引缺失 → 索引理由码。
  const malformedContent = evaluateActivationGate({ schemaVersion: 1, contentProof: { hash: "x" }, indexProof: null })
  assert.deepEqual(malformedContent.reasonCodes, [ACTIVATION_BLOCKED_EVIDENCE_SCHEMA_MISMATCH])
  const half = evaluateActivationGate({
    schemaVersion: 1,
    contentProof: { verdict: "pass", reasonCodes: [], bindings: { expectedChunksSha256: "d", expectedChunkCount: 1 } },
    indexProof: null,
  })
  assert.deepEqual(half.reasonCodes, [ACTIVATION_BLOCKED_INDEX_PROOF_MISSING])

  const wrongSchema = evaluateActivationGate({ schemaVersion: 2, contentProof: {}, indexProof: {} })
  assert.deepEqual(wrongSchema.reasonCodes, [ACTIVATION_BLOCKED_EVIDENCE_SCHEMA_MISMATCH])
})

test("UT-04/UT-15 门槛判定：内容待校验带明细码；索引 fail 带明细码", () => {
  // UT-15：内容凭证结论非 pass → 附内容凭证自身的明细码（漏页/乱码/风险）。
  const pending = evaluateActivationGate({
    schemaVersion: 1,
    contentProof: { verdict: "pending_review", reasonCodes: ["pages_without_text_layer_or_empty: 2"] },
    indexProof: null,
  })
  assert.equal(pending.passed, false)
  assert.deepEqual(pending.reasonCodes, [
    ACTIVATION_BLOCKED_CONTENT_PROOF_PENDING_REVIEW,
    "pages_without_text_layer_or_empty: 2",
  ])

  // UT-16：索引核验 fail → 稳定理由码 + 明细（丢块/哈希不匹配/缺向量）。
  const indexFailed = evaluateActivationGate({
    schemaVersion: 1,
    contentProof: { verdict: "pass", reasonCodes: [] },
    indexProof: { verdict: "fail", reasonCodes: ["index_missing_chunks"] },
  })
  assert.equal(indexFailed.passed, false)
  assert.deepEqual(indexFailed.reasonCodes, [
    ACTIVATION_BLOCKED_INDEX_PROOF_FAILED,
    "index_missing_chunks",
  ])
})

test("UT-17 联合核验：绑定一致且检索可见才放行；陈旧凭证/不可见均拒绝", () => {
  const contentProof = {
    verdict: "pass",
    reasonCodes: [],
    bindings: { expectedChunksSha256: "digest-1", expectedChunkCount: 3 },
  }
  const indexProofPass = {
    verdict: "pass",
    reasonCodes: [],
    manifestSha256: "digest-1",
    searchVisibleCount: 3,
  }

  // 双凭证 pass、绑定一致、检索可见 → 联合激活放行（UT-17 正向路径）。
  const passed = evaluateActivationGate({ schemaVersion: 1, contentProof, indexProof: indexProofPass })
  assert.equal(passed.passed, true)
  assert.deepEqual(passed.reasonCodes, [])

  // 绑定不一致（索引凭证是另一份产物的）→ 拒绝。
  const staleIndex = evaluateActivationGate({
    schemaVersion: 1,
    contentProof,
    indexProof: { ...indexProofPass, manifestSha256: "digest-old" },
  })
  assert.equal(staleIndex.passed, false)
  assert.deepEqual(staleIndex.reasonCodes, [ACTIVATION_BLOCKED_PROOF_BINDING_MISMATCH])

  // 可见数与期望数量不一致 → 不放行。
  const countMismatch = evaluateActivationGate({
    schemaVersion: 1,
    contentProof,
    indexProof: { ...indexProofPass, searchVisibleCount: 2 },
  })
  assert.equal(countMismatch.passed, false)
  assert.deepEqual(countMismatch.reasonCodes, [ACTIVATION_BLOCKED_NOT_SEARCHABLE])

  // 探针未运行（searchVisibleCount null，如受限存储）→ 不放行。
  const noProbe = evaluateActivationGate({
    schemaVersion: 1,
    contentProof,
    indexProof: { ...indexProofPass, searchVisibleCount: null },
  })
  assert.equal(noProbe.passed, false)
  assert.deepEqual(noProbe.reasonCodes, [ACTIVATION_BLOCKED_NOT_SEARCHABLE])
})

test("UT-04 自动激活：阶段成功的候选保持未激活并记录缺失原因", async () => {
  const db = openDb(":memory:")
  try {
    const lifecycle = new IngestionLifecycle(db, completingRunner())
    const submitted = lifecycle.submit({ title: "首个候选", content: "正文内容", source: "gate-test" })
    assert.equal(submitted.status, "pending")
    const result = await lifecycle.runNext()
    assert.equal(result?.success, true, "阶段成功")

    const status = lifecycle.getStatus(submitted.docId)
    assert.equal(status?.task?.status, "completed")
    assert.equal(status?.documentStatus, "completed")
    assert.ok(status?.activationBlockReason?.includes(ACTIVATION_BLOCKED_EVIDENCE_RECORD_MISSING))

    const source = db.prepare(
      "SELECT active_doc_id, last_outcome FROM sources WHERE source_id = (SELECT source_id FROM documents WHERE doc_id = ?)"
    ).get(submitted.docId) as { active_doc_id: string | null; last_outcome: string }
    assert.equal(source.active_doc_id, null, "首个未验证候选不得成为活动身份")
    assert.equal(source.last_outcome, "completed", "生命周期结论如实记录阶段成功")
  } finally {
    db.close()
  }
})

test("UT-04 旧版本保护：新候选被拒后既有活动版本身份与原件不变", async () => {
  const db = openDb(":memory:")
  try {
    const lifecycle = new IngestionLifecycle(db, completingRunner())
    const docRepo = new DocumentRepo(db)

    // v1：直接以仓库命令构造"既有活动版本"（状态构造，非激活决策）；
    // 其任务照常运行一次以清空队列。
    const v1 = lifecycle.submit({ title: "v1", content: "旧版本正文", source: "protect-test" })
    docRepo.activate(v1.docId)
    await lifecycle.runNext()
    assert.equal(
      (db.prepare("SELECT active_doc_id FROM sources WHERE source_id = (SELECT source_id FROM documents WHERE doc_id = ?)").get(v1.docId) as { active_doc_id: string }).active_doc_id,
      v1.docId
    )
    const v1RawBefore = (db.prepare("SELECT length(raw_content) AS n FROM documents WHERE doc_id = ?").get(v1.docId) as { n: number | null }).n

    // v2：不同内容的新候选 → 阶段成功但被门槛拒绝。
    const v2 = lifecycle.submit({
      title: "v2",
      content: "新候选正文（缺凭证）",
      versionIntent: "new_version",
      source: "protect-test",
    })
    assert.notEqual(v2.docId, v1.docId)
    const result = await lifecycle.runNext()
    assert.equal(result?.success, true)

    const after = db.prepare(
      "SELECT active_doc_id FROM sources WHERE source_id = (SELECT source_id FROM documents WHERE doc_id = ?)"
    ).get(v1.docId) as { active_doc_id: string }
    assert.equal(after.active_doc_id, v1.docId, "旧正常版本持续作为活动身份")
    assert.equal(
      lifecycle.getStatus(v2.docId)?.activationBlockReason,
      ACTIVATION_BLOCKED_EVIDENCE_RECORD_MISSING,
      "新候选状态给出缺失原因"
    )
    const v1RawAfter = (db.prepare("SELECT length(raw_content) AS n FROM documents WHERE doc_id = ?").get(v1.docId) as { n: number | null }).n
    assert.equal(v1RawAfter, v1RawBefore, "旧版本原件不被触碰")

    // 重处理被拒候选：再次运行仍被拒，活动身份仍不变。
    const reprocess = lifecycle.reprocess(v2.docId)
    assert.equal(reprocess?.changed, true)
    await lifecycle.runNext()
    assert.equal(
      lifecycle.getStatus(v2.docId)?.activationBlockReason,
      ACTIVATION_BLOCKED_EVIDENCE_RECORD_MISSING
    )
    assert.equal(
      (db.prepare("SELECT active_doc_id FROM sources WHERE source_id = (SELECT source_id FROM documents WHERE doc_id = ?)").get(v1.docId) as { active_doc_id: string }).active_doc_id,
      v1.docId
    )
  } finally {
    db.close()
  }
})

test("UT-04 人工批准不绕过门槛：approved 但不激活，理由可见", async () => {
  const db: DB = openDb(":memory:")
  try {
    const lifecycle = new IngestionLifecycle(db, completingRunner(), () => new Date(), "review")
    const submitted = lifecycle.submit({ title: "待审候选", content: "正文", source: "review-gate" })
    await lifecycle.runNext()
    assert.equal(lifecycle.getStatus(submitted.docId)?.documentStatus, "completed")

    const review = new SqliteCandidateReviewStore(db, new DocumentRepo(db))
    const result = review.review(submitted.docId, "default", "approve", "业务批准", "reviewer-1")
    assert.ok(result)
    assert.equal(result.candidateState, "approved")
    assert.equal(result.activatedAsActive, false, "批准不得切换活动身份（缺联合凭证）")
    assert.equal(
      lifecycle.getStatus(submitted.docId)?.activationBlockReason,
      ACTIVATION_BLOCKED_EVIDENCE_RECORD_MISSING
    )
    const source = db.prepare(
      "SELECT active_doc_id FROM sources WHERE source_id = (SELECT source_id FROM documents WHERE doc_id = ?)"
    ).get(submitted.docId) as { active_doc_id: string | null }
    assert.equal(source.active_doc_id, null)
  } finally {
    db.close()
  }
})

test("UT-17 双凭证 pass 且绑定一致 → 联合激活放行；取消约束保留", async () => {
  const db = openDb(":memory:")
  try {
    const lifecycle = new IngestionLifecycle(db, completingRunner())
    const docRepo = new DocumentRepo(db)
    const submitted = lifecycle.submit({ title: "带证据候选", content: "正文", source: "evidence-test" })
    // 生产者侧（UT-15/16 起由管线产出）：双凭证 pass 且绑定一致。
    docRepo.setCandidateEvidence(submitted.docId, {
      schemaVersion: 1,
      contentProof: {
        verdict: "pass",
        reasonCodes: [],
        bindings: { expectedChunksSha256: "digest-1", expectedChunkCount: 1 },
      },
      indexProof: { verdict: "pass", reasonCodes: [], manifestSha256: "digest-1", searchVisibleCount: 1 },
    })
    await lifecycle.runNext()
    assert.equal(
      lifecycle.getStatus(submitted.docId)?.activationBlockReason,
      null,
      "双凭证通过后无阻碍原因"
    )
    const source = db.prepare(
      "SELECT active_doc_id FROM sources WHERE source_id = (SELECT source_id FROM documents WHERE doc_id = ?)"
    ).get(submitted.docId) as { active_doc_id: string | null }
    assert.equal(source.active_doc_id, submitted.docId, "联合核验通过 → 活动身份切换")

    // 取消约束保留：pending 任务仍可取消（既有生命周期语义不变）。
    const second = lifecycle.submit({ title: "取消候选", content: "另一段待取消正文", source: "evidence-test-2" })
    assert.equal(second.status, "pending")
    const cancellation = lifecycle.cancel(second.docId)
    assert.equal(cancellation?.status, "cancelled")
    assert.equal(cancellation?.changed, true)
  } finally {
    db.close()
  }
})

test("UT-04 检索过滤器 fail-closed：零活跃文档时隐藏全部而非放开过滤", () => {
  const empty = activeTermsFilterFor([])
  assert.deepEqual(empty, [{ terms: { documentId: [NO_ACTIVE_DOCUMENT_SENTINEL] } }])
  const some = activeTermsFilterFor(["doc-1", "doc-2"])
  assert.deepEqual(some, [{ terms: { documentId: ["doc-1", "doc-2"] } }])
})
