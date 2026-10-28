import assert from "node:assert/strict"
import test from "node:test"
import { openDb, type DB } from "./tracking/db"
import { DocumentRepo } from "./tracking/doc_repo"
import {
  IngestionLifecycle,
  type IngestionStageRunner,
  type StageExecution,
} from "./lifecycle"
import { SqliteCandidateReviewStore } from "../knowledge/candidate_review_store"

/**
 * P6.3 historical review smoke, updated for the technical-completion policy:
 * completed imports activate immediately. The CandidateReviewStore remains
 * readable for historical rows and preserves its audit/idempotency contract,
 * but it is no longer an activation gate.
 */

function noopRunner(): IngestionStageRunner {
  return {
    close: async () => {},
    async run(_document, execution: StageExecution): Promise<void> {
      for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
        await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
      }
    },
  }
}

interface CandidateAuditRow {
  candidate_state: string
  reviewed_by: string | null
  reviewed_at: string | null
  review_reason: string | null
}

function readCandidateAudit(db: DB, docId: string): CandidateAuditRow {
  const row = db.prepare(
    `SELECT candidate_state, reviewed_by, reviewed_at, review_reason
     FROM documents WHERE doc_id = ?`
  ).get(docId) as CandidateAuditRow | undefined
  return row ?? {
    candidate_state: "<missing>",
    reviewed_by: null,
    reviewed_at: null,
    review_reason: null,
  }
}

function readActiveDocId(db: DB, sourceId: string): string | null {
  const row = db.prepare(
    `SELECT active_doc_id FROM sources WHERE source_id = ?`
  ).get(sourceId) as { active_doc_id: string | null } | undefined
  return row?.active_doc_id ?? null
}

test("P6.3 review mode is ignored: completed docs activate while the review store stays readable", async () => {
  const db = openDb(":memory:")
  let clock = new Date("2026-07-22T08:00:00.000Z")
  const lifecycle = new IngestionLifecycle(db, noopRunner(), () => clock, "review")
  const documentRepo = new DocumentRepo(db)
  const reviewStore = new SqliteCandidateReviewStore(db, documentRepo, () => clock)

  try {
    const submitted = lifecycle.submit({
      title: "Policy",
      content: "version one",
      source: "policy:p6_3_smoke",
    })
    await lifecycle.runNext()
    assert.equal(lifecycle.getStatus(submitted.docId)?.documentVersion.active, true)
    assert.equal(readCandidateAudit(db, submitted.docId).candidate_state, "approved")
    assert.equal(reviewStore.getCandidate(submitted.docId, "default")?.candidateState, "approved")

    // Historical pending row: the operator audit surface still works, but an
    // approve is an idempotent no-op for an already-active document.
    documentRepo.markPendingReview(submitted.docId)
    clock = new Date("2026-07-22T09:00:00.000Z")
    const approve = reviewStore.review(
      submitted.docId,
      "default",
      "approve",
      "LGTM — historical row",
      "reviewer-alice"
    )
    assert.equal(approve?.candidateState, "approved")
    assert.equal(approve?.activatedAsActive, false)
    assert.equal(approve?.reviewedBy, "reviewer-alice")
    assert.equal(approve?.reviewedAt, "2026-07-22T09:00:00.000Z")
    assert.equal(approve?.reviewReason, "LGTM — historical row")
    assert.equal(lifecycle.getStatus(submitted.docId)?.documentVersion.active, true)

    // A reject on a historical pending row changes the audit state but never
    // rewrites the active pointer.
    const rejected = lifecycle.submit({
      title: "Rejected policy",
      content: "version two",
      source: "policy:p6_3_reject",
      versionIntent: "new_version",
    })
    await lifecycle.runNext()
    const rejectedSource = new DocumentRepo(db).get(rejected.docId)!.sourceId
    assert.equal(readActiveDocId(db, rejectedSource), rejected.docId)
    documentRepo.markPendingReview(rejected.docId)
    const reject = reviewStore.review(
      rejected.docId,
      "default",
      "reject",
      "Bad content",
      "reviewer-bob"
    )
    assert.equal(reject?.candidateState, "rejected")
    assert.equal(reject?.activatedAsActive, false)
    assert.equal(readActiveDocId(db, rejectedSource), rejected.docId)
  } finally {
    db.close()
  }
})

test("P6.3 replay invariant: re-approve preserves the FIRST reviewer's audit fields", async () => {
  const db = openDb(":memory:")
  const clock = new Date("2026-07-22T08:00:00.000Z")
  const lifecycle = new IngestionLifecycle(db, noopRunner(), () => clock, "review")
  const documentRepo = new DocumentRepo(db)
  const reviewStore = new SqliteCandidateReviewStore(db, documentRepo, () => clock)

  try {
    const submitted = lifecycle.submit({
      title: "Replay",
      content: "replay content",
      source: "policy:p6_3_replay",
    })
    await lifecycle.runNext()
    documentRepo.markPendingReview(submitted.docId)

    const first = reviewStore.review(
      submitted.docId,
      "default",
      "approve",
      "first review — LGTM",
      "reviewer-first"
    )
    assert.equal(first?.candidateState, "approved")
    assert.equal(first?.reviewedBy, "reviewer-first")
    assert.equal(first?.reviewedAt, "2026-07-22T08:00:00.000Z")
    assert.equal(first?.reviewReason, "first review — LGTM")

    const second = new SqliteCandidateReviewStore(
      db,
      documentRepo,
      () => new Date("2026-07-22T10:00:00.000Z")
    ).review(
      submitted.docId,
      "default",
      "approve",
      "second review — also LGTM",
      "reviewer-second"
    )
    assert.equal(second?.candidateState, "approved")
    assert.equal(second?.activatedAsActive, false)
    assert.equal(second?.reviewedBy, "reviewer-first")
    assert.equal(second?.reviewedAt, "2026-07-22T08:00:00.000Z")
    assert.equal(second?.reviewReason, "first review — LGTM")
    assert.deepEqual(readCandidateAudit(db, submitted.docId), {
      candidate_state: "approved",
      reviewed_by: "reviewer-first",
      reviewed_at: "2026-07-22T08:00:00.000Z",
      review_reason: "first review — LGTM",
    })
  } finally {
    db.close()
  }
})

test("P6.3 蓝军 static contract: no new CandidateReviewStore methods for retry/cancel", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const storeSource = fs.readFileSync(
    path.join(__dirname, "..", "knowledge", "candidate_review_store.ts"),
    "utf8"
  )
  assert.ok(
    /getCandidate\(docId:\s*string,\s*tenantId:\s*string\)/.test(storeSource),
    "CandidateReviewStore must expose getCandidate(docId, tenantId)"
  )
  assert.ok(
    /review\(\s*docId:\s*string,\s*tenantId:\s*string,\s*decision:\s*ReviewDecision/.test(storeSource),
    "CandidateReviewStore must expose review(docId, tenantId, decision, ...)"
  )
  assert.doesNotMatch(
    storeSource,
    /\b(retry|cancel|abandon|replay)\s*\(/,
    "CandidateReviewStore must NOT expose retry/cancel/abandon/replay methods"
  )
  const governanceSource = fs.readFileSync(
    path.join(__dirname, "..", "types", "governance.ts"),
    "utf8"
  )
  assert.ok(
    /DocumentCandidateState\s*=\s*"pending_review"\s*\|\s*"approved"\s*\|\s*"rejected"/.test(governanceSource),
    "DocumentCandidateState must remain pending_review|approved|rejected"
  )
})

test("P6.3 蓝军 static contract: technical completion activates inside the lifecycle", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const lifecycleSource = fs.readFileSync(
    path.join(__dirname, "lifecycle.ts"),
    "utf8"
  )
  const updateStatusBlock = lifecycleSource.match(
    /updateStatus\([^)]+, "completed"\)([\s\S]*?)\}\)\(\)/
  )
  assert.ok(updateStatusBlock, "found updateStatus('completed') transaction block")
  assert.match(
    updateStatusBlock[1],
    /this\.docRepo\.activate\(task\.docId\)/,
    "technical completion must activate the candidate"
  )
  assert.doesNotMatch(lifecycleSource, /activationMode === "review"/, "review mode must not gate activation")
  assert.doesNotMatch(lifecycleSource, /markPendingReview/, "completed runs must not enter pending_review")

  const docRepoSource = fs.readFileSync(
    path.join(__dirname, "tracking", "doc_repo.ts"),
    "utf8"
  )
  const markPendingReviewBlock = docRepoSource.match(
    /markPendingReview\(docId:\s*string\):\s*void\s*\{([\s\S]*?)\n  \}/
  )
  assert.ok(markPendingReviewBlock, "found markPendingReview method body")
  assert.doesNotMatch(
    markPendingReviewBlock[1],
    /active_doc_id/,
    "markPendingReview must not touch active_doc_id"
  )
})
