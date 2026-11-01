import type { DB } from "./db"
import { v4 as uuid } from "uuid"
import type { DeadLetter, IngestionTask, TaskStatus } from "../../types"
import type { TaskTraceContext } from "../../tracing/contract"

interface TaskRow {
  id: number
  doc_id: string
  op: string
  payload: string
  fail_count: number
  status: string
  claimed_at: string | null
  next_attempt_at: string | null
  enqueued_at: string
  execution_id: string | null
}

interface DeadLetterRow {
  id: number
  task_id: number
  doc_id: string
  op: string
  payload: string
  fail_count: number
  error_message: string
  error_stack: string | null
  failed_at: string
}

function rowToTask(row: TaskRow): IngestionTask {
  return {
    id: row.id,
    docId: row.doc_id,
    op: row.op,
    payload: row.payload ? JSON.parse(row.payload) : null,
    failCount: row.fail_count,
    status: row.status as TaskStatus,
    claimedAt: row.claimed_at,
    executionId: row.execution_id,
    nextAttemptAt: row.next_attempt_at,
    enqueuedAt: row.enqueued_at,
  }
}

function rowToDeadLetter(row: DeadLetterRow): DeadLetter {
  return {
    id: row.id,
    taskId: row.task_id,
    docId: row.doc_id,
    op: row.op,
    payload: row.payload ? JSON.parse(row.payload) : null,
    failCount: row.fail_count,
    errorMessage: row.error_message,
    errorStack: row.error_stack,
    failedAt: row.failed_at,
  }
}

export interface EnqueueInput {
  docId: string
  op: string
  payload: Record<string, unknown>
}

export class TaskRepo {
  constructor(
    private db: DB,
    private now: () => Date = () => new Date()
  ) {}

  enqueue(input: EnqueueInput): number {
    const now = this.now().toISOString()
    const stmt = this.db.prepare(
      `INSERT INTO task_pending_ops (doc_id, op, payload, status, enqueued_at)
       VALUES (@docId, @op, @payload, 'pending', @enqueuedAt)`
    )
    const info = stmt.run({
      docId: input.docId,
      op: input.op,
      payload: JSON.stringify(input.payload),
      enqueuedAt: now,
    })
    return Number(info.lastInsertRowid)
  }

  claimNext(): IngestionTask | null {
    const now = this.now().toISOString()
    // Ticket 25: every claim mints a fresh execution identity — the durable
    // fence that later writes must present.
    const executionId = uuid()
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT * FROM task_pending_ops
         WHERE status = 'pending'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY id ASC
         LIMIT 1`
      ).get(now) as TaskRow | undefined
      if (!row) return null
      const info = this.db.prepare(
        `UPDATE task_pending_ops
         SET status = 'running', claimed_at = ?, next_attempt_at = NULL, execution_id = ?
         WHERE id = ? AND status = 'pending'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`
      ).run(now, executionId, row.id, now)
      if (info.changes !== 1) return null
      return {
        ...row,
        status: "running",
        claimed_at: now,
        next_attempt_at: null,
        execution_id: executionId,
      }
    })
    const row = tx() as TaskRow | null
    return row ? rowToTask(row) : null
  }

  claimStale(cutoff: string): IngestionTask | null {
    const now = this.now().toISOString()
    // Ticket 25: recovery mints a NEW execution identity. A pre-restart
    // process that is somehow still alive loses ownership — its writes are
    // fenced off and cannot duplicate or overwrite the recovered run.
    const executionId = uuid()
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT * FROM task_pending_ops
         WHERE status = 'running' AND claimed_at IS NOT NULL AND claimed_at <= ?
         ORDER BY claimed_at ASC, id ASC
         LIMIT 1`
      ).get(cutoff) as TaskRow | undefined
      if (!row) return null

      const info = this.db.prepare(
        `UPDATE task_pending_ops
         SET claimed_at = ?, execution_id = ?
         WHERE id = ? AND status = 'running' AND claimed_at = ?`
      ).run(now, executionId, row.id, row.claimed_at)
      if (info.changes !== 1) return null
      return { ...row, claimed_at: now, execution_id: executionId }
    })
    const row = tx() as TaskRow | null
    return row ? rowToTask(row) : null
  }

  /** Ticket 25: whether this execution still owns the claim it is writing under. */
  owns(taskId: number, executionId: string): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM task_pending_ops WHERE id = ? AND execution_id = ? AND status = 'running'`
    ).get(taskId, executionId)
    return row !== undefined
  }

  recordFailure(
    taskId: number,
    nextAttemptAt: string | null,
    executionId: string | null
  ): boolean {
    // Ticket 25: fenced by execution identity, not by wall-clock claim time.
    const info = this.db.prepare(
      `UPDATE task_pending_ops
       SET fail_count = fail_count + 1,
           status = CASE WHEN ? IS NULL THEN 'failed' ELSE 'pending' END,
           claimed_at = NULL,
           next_attempt_at = ?,
           execution_id = NULL
       WHERE id = ? AND status = 'running' AND execution_id = ?`
    ).run(nextAttemptAt, nextAttemptAt, taskId, executionId)
    return info.changes === 1
  }

  deadLetter(
    task: IngestionTask,
    errorMessage: string,
    errorStack: string | null,
    failedAt: string
  ): boolean {
    return this.db.transaction(() => {
      const failCount = task.failCount + 1
      // Ticket 25: fenced by execution identity — a stale run cannot dead-letter
      // a task that a newer execution now owns.
      const info = this.db.prepare(
        `UPDATE task_pending_ops
         SET fail_count = ?, status = 'failed', claimed_at = NULL, next_attempt_at = NULL, execution_id = NULL
         WHERE id = ? AND status = 'running' AND execution_id = ?`
      ).run(failCount, task.id, task.executionId)
      if (info.changes === 1) {
        this.db.prepare(
          `INSERT INTO task_dead_letters
            (task_id, doc_id, op, payload, fail_count, error_message, error_stack, failed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id) DO NOTHING`
        ).run(
          task.id,
          task.docId,
          task.op,
          JSON.stringify(task.payload ?? {}),
          failCount,
          errorMessage,
          errorStack,
          failedAt
        )
        return true
      }

      const current = this.db.prepare(
        `SELECT status FROM task_pending_ops WHERE id = ?`
      ).get(task.id) as { status: string } | undefined
      return current?.status === "failed" && this.getDeadLetter(task.id) !== null
    })()
  }

  getDeadLetter(taskId: number): DeadLetter | null {
    const row = this.db.prepare(
      `SELECT * FROM task_dead_letters WHERE task_id = ?`
    ).get(taskId) as DeadLetterRow | undefined
    return row ? rowToDeadLetter(row) : null
  }

  cancel(taskId: number): boolean {
    const info = this.db.prepare(
      `UPDATE task_pending_ops
       SET status = 'cancelled', claimed_at = NULL, next_attempt_at = NULL, execution_id = NULL
       WHERE id = ? AND status IN ('pending', 'running')`
    ).run(taskId)
    return info.changes === 1
  }

  /**
   * Ticket 12 (DOC-01B): requeue a TERMINAL task for a manual retry or a
   * reprocess. The retry budget restarts (fail_count reset) — a manual retry
   * is a human decision, not another automatic attempt. Only terminal states
   * are eligible; pending/running tasks are owned by the worker loop.
   */
  requeue(taskId: number, trace?: TaskTraceContext): boolean {
    const requeued = this.db.prepare(
      `UPDATE task_pending_ops
       SET status = 'pending', fail_count = 0, claimed_at = NULL, next_attempt_at = NULL
       WHERE id = ? AND status IN ('failed', 'cancelled', 'completed')`
    ).run(taskId)
    if (requeued.changes !== 1) return false
    // LO-14: a manual retry/reprocess is a NEW operator action, so the next
    // execution continues the operator's trace. Only the trace field is
    // replaced; the original payload (title, content length, …) is preserved
    // byte-for-byte so business readers see no change.
    if (trace) this.mergePayloadTrace(taskId, trace)
    // A stale dead letter would shadow the NEXT terminal failure's error.
    this.db.prepare(`DELETE FROM task_dead_letters WHERE task_id = ?`).run(taskId)
    return true
  }

  /** Replace only the neutral handoff field of an existing payload. */
  private mergePayloadTrace(taskId: number, trace: TaskTraceContext): void {
    const row = this.db
      .prepare("SELECT payload FROM task_pending_ops WHERE id = ?")
      .get(taskId) as { payload: string } | undefined
    if (!row) return
    let payload: Record<string, unknown> = {}
    try {
      const parsed = row.payload ? JSON.parse(row.payload) : {}
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>
      }
    } catch {
      // A corrupt payload is not repaired here: the task still runs under the
      // root policy, and its business fields are left exactly as they were.
      return
    }
    this.db
      .prepare("UPDATE task_pending_ops SET payload = ? WHERE id = ?")
      .run(JSON.stringify({ ...payload, trace }), taskId)
  }

  finalize(
    taskId: number,
    status: "completed" | "failed",
    executionId: string | null
  ): boolean {
    // Ticket 25: fenced by execution identity, not by wall-clock claim time.
    const info = this.db.prepare(
      `UPDATE task_pending_ops
       SET status = ?, claimed_at = NULL, next_attempt_at = NULL, execution_id = NULL
       WHERE id = ? AND status = 'running' AND execution_id = ?`
    ).run(status, taskId, executionId)
    return info.changes === 1
  }

  getByDocId(docId: string): IngestionTask | null {
    const row = this.db.prepare(
      `SELECT * FROM task_pending_ops WHERE doc_id = ? ORDER BY id DESC LIMIT 1`
    ).get(docId) as TaskRow | undefined
    return row ? rowToTask(row) : null
  }

  getById(taskId: number): IngestionTask | null {
    const row = this.db.prepare(
      `SELECT * FROM task_pending_ops WHERE id = ?`
    ).get(taskId) as TaskRow | undefined
    return row ? rowToTask(row) : null
  }
}
