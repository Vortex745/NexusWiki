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
  ACTIVATION_POLICY_VERSION,
  ACTIVATION_WARNING_OCR_CONTENT_UNVERIFIED,
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

test("OCR 软提示政策：唯一通用理由放行，任何混入理由仍拒绝", () => {
  const bindings = { expectedChunksSha256: "digest-ocr", expectedChunkCount: 2 }
  const indexProof = {
    verdict: "pass",
    reasonCodes: [],
    manifestSha256: "digest-ocr",
    searchVisibleCount: 2,
  }
  const accepted = evaluateActivationGate({
    schemaVersion: 1,
    contentProof: {
      verdict: "pending_review",
      reasonCodes: [ACTIVATION_WARNING_OCR_CONTENT_UNVERIFIED],
      bindings,
    },
    indexProof,
  })
  assert.equal(accepted.passed, true)
  assert.deepEqual(accepted.reasonCodes, [])
  assert.deepEqual(accepted.warningCodes, [ACTIVATION_WARNING_OCR_CONTENT_UNVERIFIED])
  assert.equal(accepted.policyVersion, ACTIVATION_POLICY_VERSION)

  const rejectedReasonSets: unknown[] = [
    [],
    undefined,
    ["ocr_content_unverified"],
    ["structural_risk: OCR_CONTENT_UNVERIFIED"],
    [ACTIVATION_WARNING_OCR_CONTENT_UNVERIFIED, "structural_risk: ocr_empty_textblock"],
    [ACTIVATION_WARNING_OCR_CONTENT_UNVERIFIED, ""],
  ]
  for (const reasonCodes of rejectedReasonSets) {
    const decision = evaluateActivationGate({
      schemaVersion: 1,
      contentProof: { verdict: "pending_review", reasonCodes, bindings },
      indexProof,
    })
    assert.equal(decision.passed, false, JSON.stringify(reasonCodes))
    assert.equal(decision.reasonCodes[0], ACTIVATION_BLOCKED_CONTENT_PROOF_PENDING_REVIEW)
    assert.deepEqual(decision.warningCodes, [])
    assert.equal(decision.policyVersion, null)
  }
})

test("OCR 软提示只买来索引检查资格：索引缺失/失败/绑定不一致/不可见仍拒绝", () => {
  const contentProof = {
    verdict: "pending_review",
    reasonCodes: [ACTIVATION_WARNING_OCR_CONTENT_UNVERIFIED],
    bindings: { expectedChunksSha256: "digest-ocr", expectedChunkCount: 1 },
  }
  const cases: Array<{ indexProof: unknown; expected: string }> = [
    { indexProof: null, expected: ACTIVATION_BLOCKED_INDEX_PROOF_MISSING },
    {
      indexProof: {
        verdict: "fail",
        reasonCodes: ["index_missing_chunks"],
        manifestSha256: "digest-ocr",
        searchVisibleCount: 1,
      },
      expected: ACTIVATION_BLOCKED_INDEX_PROOF_FAILED,
    },
    {
      indexProof: {
        verdict: "pass",
        reasonCodes: [],
        manifestSha256: "digest-old",
        searchVisibleCount: 1,
      },
      expected: ACTIVATION_BLOCKED_PROOF_BINDING_MISMATCH,
    },
    {
      indexProof: {
        verdict: "pass",
        reasonCodes: [],
        manifestSha256: "digest-ocr",
        searchVisibleCount: 0,
      },
      expected: ACTIVATION_BLOCKED_NOT_SEARCHABLE,
    },
  ]
  for (const { indexProof, expected } of cases) {
    const decision = evaluateActivationGate({ schemaVersion: 1, contentProof, indexProof })
    assert.equal(decision.passed, false)
    assert.equal(decision.reasonCodes[0], expected)
    assert.ok(!decision.reasonCodes.includes(ACTIVATION_WARNING_OCR_CONTENT_UNVERIFIED))
    assert.deepEqual(decision.warningCodes, [])
    assert.equal(decision.policyVersion, null)
  }
})

test("技术完成自动激活：阶段成功即成为活动身份", async () => {
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
    assert.equal(status?.activationBlockReason, null)

    const source = db.prepare(
      "SELECT active_doc_id, last_outcome FROM sources WHERE source_id = (SELECT source_id FROM documents WHERE doc_id = ?)"
    ).get(submitted.docId) as { active_doc_id: string | null; last_outcome: string }
    assert.equal(source.active_doc_id, submitted.docId, "技术成功直接成为活动身份")
    assert.equal(source.last_outcome, "completed", "生命周期结论如实记录阶段成功")
  } finally {
    db.close()
  }
})

test("新候选技术完成切换活动身份，旧版本原件不变", async () => {
  const db = openDb(":memory:")
  try {
    const lifecycle = new IngestionLifecycle(db, completingRunner())

    const v1 = lifecycle.submit({ title: "v1", content: "旧版本正文", source: "protect-test" })
    await lifecycle.runNext()
    assert.equal(
      (db.prepare("SELECT active_doc_id FROM sources WHERE source_id = (SELECT source_id FROM documents WHERE doc_id = ?)").get(v1.docId) as { active_doc_id: string }).active_doc_id,
      v1.docId
    )
    const v1RawBefore = (db.prepare("SELECT length(raw_content) AS n FROM documents WHERE doc_id = ?").get(v1.docId) as { n: number | null }).n

    const v2 = lifecycle.submit({
      title: "v2",
      content: "新候选正文",
      versionIntent: "new_version",
      source: "protect-test",
    })
    assert.notEqual(v2.docId, v1.docId)
    const result = await lifecycle.runNext()
    assert.equal(result?.success, true)

    const after = db.prepare(
      "SELECT active_doc_id FROM sources WHERE source_id = (SELECT source_id FROM documents WHERE doc_id = ?)"
    ).get(v1.docId) as { active_doc_id: string }
    assert.equal(after.active_doc_id, v2.docId, "较新的技术完成版本成为活动身份")
    assert.equal(lifecycle.getStatus(v1.docId)?.documentVersion.active, false)
    assert.equal(lifecycle.getStatus(v2.docId)?.documentVersion.active, true)
    assert.equal(lifecycle.getStatus(v2.docId)?.activationBlockReason, null)
    const v1RawAfter = (db.prepare("SELECT length(raw_content) AS n FROM documents WHERE doc_id = ?").get(v1.docId) as { n: number | null }).n
    assert.equal(v1RawAfter, v1RawBefore, "旧版本原件不被触碰")
  } finally {
    db.close()
  }
})

test("review 模式不再阻断新导入：完成即激活，历史审批存储不改变指针", async () => {
  const db: DB = openDb(":memory:")
  try {
    const lifecycle = new IngestionLifecycle(db, completingRunner(), () => new Date(), "review")
    const submitted = lifecycle.submit({ title: "待审候选", content: "正文", source: "review-gate" })
    await lifecycle.runNext()
    assert.equal(lifecycle.getStatus(submitted.docId)?.documentStatus, "completed")
    assert.equal(lifecycle.getStatus(submitted.docId)?.activationBlockReason, null)

    const source = db.prepare(
      "SELECT active_doc_id FROM sources WHERE source_id = (SELECT source_id FROM documents WHERE doc_id = ?)"
    ).get(submitted.docId) as { active_doc_id: string | null }
    assert.equal(source.active_doc_id, submitted.docId, "review 配置不再阻止技术完成激活")

    // The historical store remains readable for old rows, but approving an
    // already-active candidate is an idempotent no-op, not an activation path.
    const review = new SqliteCandidateReviewStore(db, new DocumentRepo(db))
    const result = review.review(submitted.docId, "default", "approve", "业务批准", "reviewer-1")
    assert.ok(result)
    assert.equal(result.candidateState, "approved")
    assert.equal(result.activatedAsActive, false)
    const afterReview = db.prepare(
      "SELECT active_doc_id FROM sources WHERE source_id = (SELECT source_id FROM documents WHERE doc_id = ?)"
    ).get(submitted.docId) as { active_doc_id: string | null }
    assert.equal(afterReview.active_doc_id, submitted.docId)
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

test("内容凭证与 OCR 软提示不再参与激活，也不生成接受记录", async () => {
  const db = openDb(":memory:")
  try {
    const lifecycle = new IngestionLifecycle(db, completingRunner())
    const docRepo = new DocumentRepo(db)
    const submitted = lifecycle.submit({ title: "普通 OCR 图", content: "正文", source: "ocr-advisory-test" })
    docRepo.setCandidateEvidence(submitted.docId, {
      schemaVersion: 1,
      contentProof: {
        verdict: "pending_review",
        reasonCodes: [ACTIVATION_WARNING_OCR_CONTENT_UNVERIFIED],
        bindings: { expectedChunksSha256: "digest-ocr", expectedChunkCount: 1 },
      },
      indexProof: {
        verdict: "pass",
        reasonCodes: [],
        manifestSha256: "digest-ocr",
        searchVisibleCount: 1,
      },
    })
    await lifecycle.runNext()

    const source = db.prepare(
      "SELECT active_doc_id FROM sources WHERE source_id = (SELECT source_id FROM documents WHERE doc_id = ?)"
    ).get(submitted.docId) as { active_doc_id: string | null }
    assert.equal(source.active_doc_id, submitted.docId, "旧内容证据不影响技术完成激活")

    const status = lifecycle.getStatus(submitted.docId)
    assert.equal(status?.activationBlockReason, null)
    assert.deepEqual(status?.activationWarnings, [])
    assert.equal(status?.activationPolicyVersion, null)
    assert.equal(docRepo.getActivationAcceptance(submitted.docId), null)

    const evidence = docRepo.getCandidateEvidence(submitted.docId) as {
      contentProof: { verdict: string; reasonCodes: string[] }
    }
    assert.equal(evidence.contentProof.verdict, "pending_review", "历史证据保留原样")
    assert.deepEqual(evidence.contentProof.reasonCodes, [ACTIVATION_WARNING_OCR_CONTENT_UNVERIFIED])
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
