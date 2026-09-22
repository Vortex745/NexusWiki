/**
 * Ticket 20 (CONV-01A) — server-owned conversation history.
 *
 * Two layers, deliberately separate from VALIDATED MEMORY:
 *
 * 1. `conversation_directories` — one row per thread, owned by
 *    (tenant_id, subject_id). The id is the thread/session id the browser
 *    already generates; the title is derived from the first user message.
 * 2. Turns, in two tables with ONE read view:
 *      - `conversation_turns` (kind='validated') — written by the memory
 *        adapter when a run's answer passed the Critic. These are the
 *        validated pairs the runtime feeds back as memory.
 *      - `conversation_history_turns` — written by the transport for runs
 *        that produced NO validated pair (refusal, cancellation, failure),
 *        carrying the terminal status. A failed answer is therefore
 *        history-visible but NEVER enters validated runtime memory.
 *
 * Writes happen at the chat transport after the run settles. Reads are
 * user-scoped — another user's directory is the same 404 as an unknown one.
 */

import type { DB } from "../ingestion/tracking/db"
import type { AnswerTerminalStatus } from "../types/answer"

const TITLE_MAX = 100
const IMPORTED_TRUE = 1

export interface ConversationDirectorySummary {
  id: string
  title: string
  imported: boolean
  createdAt: string
  updatedAt: string
  /** Number of messages currently stored for the thread. */
  messageCount: number
}

export interface HistoryTurn {
  role: "user" | "assistant"
  content: string
  runId: string
  /**
   * Assistant turns: how the run ended ("completed" for validated memory
   * pairs; refusal/failure/cancellation codes for history-only turns). User
   * turns and imported legacy messages: null.
   */
  terminalStatus: AnswerTerminalStatus | null
  createdAt: string
}

interface DirectoryRow {
  id: string
  tenant_id: string
  subject_id: string
  title: string
  imported: number
  created_at: string
  updated_at: string
}

interface TurnRow {
  role: "user" | "assistant"
  content: string
  run_id: string
  terminal_status: string | null
  created_at: string
  source: number
  seq: number
}

export class ConversationHistoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConversationHistoryError"
  }
}

export class SqliteConversationHistoryStore {
  constructor(private readonly db: DB) {}

  /**
   * Ensure the directory row exists for this thread, owned by the caller.
   * The title is set once (from the first user message); later runs only
   * touch `updated_at` — and only when the caller owns the row.
   */
  ensureDirectory(
    sessionId: string,
    tenantId: string,
    subjectId: string,
    titleHint: string
  ): void {
    const now = new Date().toISOString()
    const title = titleHint.trim().slice(0, TITLE_MAX) || "新对话"
    this.db
      .prepare(
        `INSERT INTO conversation_directories (id, tenant_id, subject_id, title, imported, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
         WHERE conversation_directories.tenant_id = excluded.tenant_id
           AND conversation_directories.subject_id = excluded.subject_id`
      )
      .run(sessionId, tenantId, subjectId, title, now, now)
  }

  /**
   * Record a run that produced NO validated memory pair (refusal /
   * cancellation / failure). Both turns land in the history-only table with
   * the terminal status attached, so the user turn is visible too — but the
   * memory layer never reads this table.
   */
  recordUnvalidatedRun(
    sessionId: string,
    tenantId: string,
    subjectId: string,
    userContent: string,
    assistantContent: string,
    runId: string,
    terminalStatus: AnswerTerminalStatus
  ): void {
    this.assertOwned(sessionId, tenantId, subjectId)
    const now = new Date().toISOString()
    const write = this.db.transaction(() => {
      const insert = this.db.prepare(
        `INSERT INTO conversation_history_turns
           (session_id, tenant_id, role, content, run_id, terminal_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      insert.run(sessionId, tenantId, "user", userContent, runId, null, now)
      insert.run(sessionId, tenantId, "assistant", assistantContent, runId, terminalStatus, now)
      this.db
        .prepare(`UPDATE conversation_directories SET updated_at = ? WHERE id = ?`)
        .run(now, sessionId)
    })
    write()
  }

  listDirectories(tenantId: string, subjectId: string): ConversationDirectorySummary[] {
    const rows = this.db
      .prepare(
        `SELECT d.*, (
           SELECT (SELECT COUNT(*) FROM conversation_turns t WHERE t.session_id = d.id)
                + (SELECT COUNT(*) FROM conversation_history_turns h WHERE h.session_id = d.id)
         ) AS message_count
         FROM conversation_directories d
         WHERE d.tenant_id = ? AND d.subject_id = ?
         ORDER BY d.updated_at DESC`
      )
      .all(tenantId, subjectId) as Array<DirectoryRow & { message_count: number }>
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      imported: row.imported === IMPORTED_TRUE,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: row.message_count,
    }))
  }

  /**
   * The unified, chronological read view: validated memory pairs (source 0,
   * assistant turns read as "completed" — that is the only way a pair gets
   * written) + history-only turns (source 1, with their terminal status).
   */
  getTurns(sessionId: string, tenantId: string, subjectId: string): HistoryTurn[] {
    this.assertOwned(sessionId, tenantId, subjectId)
    const rows = this.db
      .prepare(
        `SELECT role, content, run_id, NULL AS terminal_status, created_at, 0 AS source, id AS seq
         FROM conversation_turns
         WHERE session_id = ? AND tenant_id = ? AND kind = 'validated'
         UNION ALL
         SELECT role, content, run_id, terminal_status, created_at, 1 AS source, id AS seq
         FROM conversation_history_turns
         WHERE session_id = ? AND tenant_id = ?
         ORDER BY created_at ASC, source ASC, seq ASC`
      )
      .all(sessionId, tenantId, sessionId, tenantId) as TurnRow[]
    return rows.map((row) => ({
      role: row.role,
      content: row.content,
      runId: row.run_id,
      terminalStatus:
        (row.terminal_status as AnswerTerminalStatus | null) ??
        (row.source === 0 && row.role === "assistant" ? "completed" : null),
      createdAt: row.created_at,
    }))
  }

  /**
   * One-time import of browser-local threads. Idempotent by (owner, thread
   * id): an existing directory of the SAME user is SKIPPED (never merged,
   * never overwritten); the browser's local storage is never touched. All
   * imported messages land in the history-only table — an import must never
   * feed validated runtime memory.
   */
  importThreads(
    tenantId: string,
    subjectId: string,
    threads: ReadonlyArray<{
      id: string
      title?: string
      messages?: ReadonlyArray<{ role: "user" | "assistant"; content: string }>
    }>
  ): { imported: number; skipped: number } {
    let imported = 0
    let skipped = 0
    for (const thread of threads) {
      if (!thread || typeof thread.id !== "string" || thread.id.trim().length === 0) {
        throw new ConversationHistoryError("every thread must carry a non-empty id")
      }
      const existing = this.db
        .prepare(
          `SELECT id FROM conversation_directories WHERE id = ? AND tenant_id = ? AND subject_id = ?`
        )
        .get(thread.id, tenantId, subjectId)
      if (existing) {
        skipped += 1
        continue
      }
      const now = new Date().toISOString()
      const title =
        (typeof thread.title === "string" && thread.title.trim().slice(0, TITLE_MAX)) ||
        thread.messages?.find((m) => m.role === "user")?.content?.trim().slice(0, TITLE_MAX) ||
        "导入的对话"
      const write = this.db.transaction(() => {
        // A same-id row of ANOTHER user collides on the PK — caught below and
        // reported as a skip (no existence information beyond the count).
        let inserted = true
        try {
          this.db
            .prepare(
              `INSERT INTO conversation_directories (id, tenant_id, subject_id, title, imported, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(thread.id, tenantId, subjectId, title, IMPORTED_TRUE, now, now)
        } catch {
          inserted = false
        }
        if (!inserted) return false
        const insertTurn = this.db.prepare(
          `INSERT INTO conversation_history_turns
             (session_id, tenant_id, role, content, run_id, terminal_status, created_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?)`
        )
        let position = 0
        for (const message of thread.messages ?? []) {
          if (!message || (message.role !== "user" && message.role !== "assistant")) continue
          position += 1
          insertTurn.run(
            thread.id,
            tenantId,
            message.role,
            typeof message.content === "string" ? message.content : "",
            `imported-${thread.id}-${position}`,
            now
          )
        }
        return true
      })
      if (write()) imported += 1
      else skipped += 1
    }
    return { imported, skipped }
  }

  /** Another user's directory is indistinguishable from an unknown one. */
  private assertOwned(sessionId: string, tenantId: string, subjectId: string): void {
    const row = this.db
      .prepare(`SELECT subject_id FROM conversation_directories WHERE id = ? AND tenant_id = ?`)
      .get(sessionId, tenantId) as { subject_id: string } | undefined
    if (!row || row.subject_id !== subjectId) {
      throw new ConversationHistoryError("conversation not found")
    }
  }
}
