import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { openDb } from "../ingestion/tracking/db"
import { SqliteConversationHistoryStore } from "./conversation_history_store"
import { SqliteConversationStore } from "./conversation_store"

function branchStore(t: TestContext) {
  const db = openDb(":memory:")
  t.after(() => db.close())
  const history = new SqliteConversationHistoryStore(db)
  const memory = new SqliteConversationStore(db)
  history.ensureDirectory("sess-main", "t1", "owner", "Question 1")
  for (let run = 1; run <= 3; run += 1) {
    for (const role of ["user", "assistant"] as const) {
      memory.saveValidatedTurn({
        sessionId: "sess-main", tenantId: "t1", role, runId: `run-${run}`,
        content: `${role} ${run}`, createdAt: `2026-01-01T00:00:0${run}.000Z`,
      })
    }
  }
  history.recordUnvalidatedRun("sess-main", "t1", "owner", "Later question", "Cancelled", "history-run", "cancelled")
  memory.savePendingClarification("sess-main", "t1", "旧问题：帮我查退款")
  memory.saveRollingSummary("sess-main", "t1", "Summary covering the old branch", 6, 1)
  const snapshot = () => ({
    validated: memory.loadRecentTurns("sess-main", "t1", 20),
    displayed: history.getTurns("sess-main", "t1", "owner"),
    summary: memory.getRollingSummary("sess-main", "t1"),
    pending: memory.peekPendingClarification("sess-main", "t1"),
  })
  return { db, history, memory, snapshot }
}

for (const mode of ["from", "after"] as const) {
  test(`truncate ${mode} clears current pending while preserving anchor inclusion, counts and summary rules`, (t) => {
    const { history, memory } = branchStore(t)
    const removed = mode === "from"
      ? history.truncateFromRun("sess-main", "t1", "owner", "run-2")
      : history.truncateAfterRun("sess-main", "t1", "owner", "run-2")
    assert.deepEqual(removed, { validated: mode === "from" ? 4 : 2, history: 2 })
    const expected = mode === "from" ? ["user 1", "assistant 1"] : ["user 1", "assistant 1", "user 2", "assistant 2"]
    assert.deepEqual(memory.loadRecentTurns("sess-main", "t1", 20).map((turn) => turn.content), expected)
    assert.deepEqual(history.getTurns("sess-main", "t1", "owner").map((turn) => turn.content), expected)
    assert.equal(memory.peekPendingClarification("sess-main", "t1"), null)
    assert.equal(memory.getRollingSummary("sess-main", "t1"), null)
  })

  test(`an unknown truncate-${mode} anchor leaves validated, displayed, pending and summary state unchanged`, (t) => {
    const { history, snapshot } = branchStore(t)
    const before = snapshot()
    const removed = mode === "from"
      ? history.truncateFromRun("sess-main", "t1", "owner", "missing-run")
      : history.truncateAfterRun("sess-main", "t1", "owner", "missing-run")
    assert.deepEqual(removed, { validated: 0, history: 0 })
    assert.deepEqual(snapshot(), before)
  })
}

test("branch pending cleanup is restricted to the selected session and tenant", (t) => {
  const { history, memory } = branchStore(t)
  memory.savePendingClarification("other-session", "t1", "Other session question")
  memory.savePendingClarification("sess-main", "t2", "Other tenant question")
  history.truncateFromRun("sess-main", "t1", "owner", "run-2")
  assert.equal(memory.peekPendingClarification("sess-main", "t1"), null)
  assert.equal(memory.peekPendingClarification("other-session", "t1"), "Other session question")
  assert.equal(memory.peekPendingClarification("sess-main", "t2"), "Other tenant question")
})

test("pending cleanup failure rolls back the same branch transaction", (t) => {
  const { db, history, snapshot } = branchStore(t)
  const before = snapshot()
  // Inject an isolated database failure; observe rollback only through public stores.
  db.exec(`CREATE TRIGGER fail_branch_pending_delete
    BEFORE DELETE ON conversation_turns
    WHEN OLD.kind = 'pending_clarification' AND OLD.session_id = 'sess-main' AND OLD.tenant_id = 't1'
    BEGIN SELECT RAISE(ABORT, 'synthetic pending cleanup failure'); END`)
  assert.throws(
    () => history.truncateFromRun("sess-main", "t1", "owner", "run-2"),
    /synthetic pending cleanup failure/
  )
  assert.deepEqual(snapshot(), before)
})
