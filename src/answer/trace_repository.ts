import type { DB } from "../ingestion/tracking/db"
import type { AnswerRunEvent } from "../types"
import type { AnswerRunObserver } from "./generation"

export interface AnswerRunHistory {
  runId: string
  sessionId: string
  events: AnswerRunEvent[]
}

interface StoredEvent {
  session_id: string
  event_json: string
}

/**
 * T49: AnswerTraceRepository implements AnswerRunObserver so the Answer run
 * module can own trace persistence. The HTTP route no longer appends events.
 */
export class AnswerTraceRepository implements AnswerRunObserver {
  constructor(private db: DB) {}

  onEvent(event: AnswerRunEvent): void {
    this.append(event)
  }

  append(event: AnswerRunEvent): void {
    const serialized = JSON.stringify(event)
    const append = this.db.transaction(() => {
      const run = this.db.prepare(
        `SELECT session_id
         FROM answer_run_events
         WHERE run_id = ?
         LIMIT 1`
      ).get(event.runId) as Pick<StoredEvent, "session_id"> | undefined
      if (run && run.session_id !== event.sessionId) {
        throw new Error(`Conflicting trace run session: ${event.runId}`)
      }

      this.db.prepare(
        `INSERT OR IGNORE INTO answer_run_events (
          run_id, event_id, sequence, session_id, event_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        event.runId,
        event.eventId,
        event.sequence,
        event.sessionId,
        serialized,
        event.createdAt
      )

      const existing = this.db.prepare(
        `SELECT session_id, event_json
         FROM answer_run_events
         WHERE run_id = ? AND event_id = ?`
      ).get(event.runId, event.eventId) as StoredEvent | undefined
      if (!existing) {
        throw new Error(`Conflicting trace event sequence: ${event.sequence}`)
      }
      if (existing.session_id !== event.sessionId || existing.event_json !== serialized) {
        throw new Error(`Conflicting trace event identity: ${event.eventId}`)
      }
    })
    append.immediate()
  }

  getRun(runId: string): AnswerRunHistory | null {
    const rows = this.db.prepare(
      `SELECT session_id, event_json
       FROM answer_run_events
       WHERE run_id = ?
       ORDER BY sequence ASC`
    ).all(runId) as StoredEvent[]
    if (rows.length === 0) return null
    return {
      runId,
      sessionId: rows[0].session_id,
      events: rows.map(({ event_json }) => JSON.parse(event_json) as AnswerRunEvent),
    }
  }

  /**
   * DR-18: a run is readable only by the (tenant, subject) that bound its
   * session. An unknown run id, another tenant's run and a same-tenant peer's
   * run are all the same `null` — the HTTP layer returns one identical 404.
   */
  getRunForOwner(runId: string, tenantId: string, subjectId: string): AnswerRunHistory | null {
    const rows = this.db.prepare(
      `SELECT e.session_id, e.event_json
       FROM answer_run_events e
       JOIN session_bindings b ON b.session_id = e.session_id
       WHERE e.run_id = ? AND b.tenant_id = ? AND b.subject_id = ?
       ORDER BY e.sequence ASC`
    ).all(runId, tenantId, subjectId) as StoredEvent[]
    if (rows.length === 0) return null
    return {
      runId,
      sessionId: rows[0].session_id,
      events: rows.map(({ event_json }) => JSON.parse(event_json) as AnswerRunEvent),
    }
  }

}
