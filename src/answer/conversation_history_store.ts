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

/** Frozen by the first message of a session. Later runs cannot move it. */
export interface SessionLock {
  assistantId: string | null
  assistantVersion: number | null
  knowledgeBaseIds: string[]
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

  /**
   * Ticket 21 (CONV-01B): freeze assistant version and the authorized knowledge
   * subset on the first message. A later call returns the original lock and
   * writes nothing. The directory must already belong to the caller.
   */
  lockSession(
    sessionId: string,
    tenantId: string,
    subjectId: string,
    snapshot: { assistantId: string | null; assistantVersion: number | null; knowledgeBaseIds: string[] }
  ): SessionLock {
    this.assertOwned(sessionId, tenantId, subjectId)
    const existing = this.readLock(sessionId)
    if (existing) return existing
    this.db
      .prepare(
        `UPDATE conversation_directories
         SET assistant_id = ?, assistant_version = ?, knowledge_base_ids = ?
         WHERE id = ? AND assistant_id IS NULL AND knowledge_base_ids IS NULL`
      )
      .run(
        snapshot.assistantId,
        snapshot.assistantVersion,
        JSON.stringify(snapshot.knowledgeBaseIds),
        sessionId
      )
    return this.readLock(sessionId) ?? {
      assistantId: snapshot.assistantId,
      assistantVersion: snapshot.assistantVersion,
      knowledgeBaseIds: [...snapshot.knowledgeBaseIds],
    }
  }

  /** The lock, or null when the caller does not own the directory. */
  getSessionLock(sessionId: string, tenantId: string, subjectId: string): SessionLock | null {
    const row = this.db
      .prepare(`SELECT subject_id FROM conversation_directories WHERE id = ? AND tenant_id = ?`)
      .get(sessionId, tenantId) as { subject_id: string } | undefined
    if (!row || row.subject_id !== subjectId) return null
    return this.readLock(sessionId)
  }

  /**
   * Ticket 21 (CONV-01B): drop the anchored run AND every later turn —
   * validated memory and history. This is the branch an edit or a regenerate
   * replaces, so it is matched by run id (a run's user and assistant rows can
   * carry different timestamps) and everything after the anchor's last row
   * goes too. An unknown anchor removes nothing.
   */
  truncateFromRun(
    sessionId: string,
    tenantId: string,
    subjectId: string,
    anchorRunId: string
  ): { validated: number; history: number } {
    return this.truncateBranch(sessionId, tenantId, subjectId, anchorRunId, true)
  }

  /**
   * Ticket 20 (CONV-01A): drop every turn recorded strictly after
   * `anchorRunId`. Kept beside `truncateFromRun` because the two branch roots
   * differ: "after" keeps the anchor's own pair (reply to another question),
   * "from" replaces it (edit / regenerate).
   */
  truncateAfterRun(
    sessionId: string,
    tenantId: string,
    subjectId: string,
    anchorRunId: string
  ): { validated: number; history: number } {
    return this.truncateBranch(sessionId, tenantId, subjectId, anchorRunId, false)
  }

  private truncateBranch(
    sessionId: string,
    tenantId: string,
    subjectId: string,
    anchorRunId: string,
    inclusive: boolean
  ): { validated: number; history: number } {
    this.assertOwned(sessionId, tenantId, subjectId)
    // The two tables have independent id sequences, so the cutoff is the
    // anchor run's created_at; inclusivity additionally matches the anchor's
    // own rows exactly, by run id.
    const stamp = this.anchorStamp(sessionId, tenantId, anchorRunId)
    if (!stamp) return { validated: 0, history: 0 }
    const predicate = inclusive
      ? "(run_id = ? OR created_at > ?)"
      : "created_at > ?"
    const cut = this.db.transaction(() => {
      const validated = this.db
        .prepare(
          `DELETE FROM conversation_turns
           WHERE session_id = ? AND tenant_id = ? AND kind = 'validated' AND ${predicate}`
        )
        .run(sessionId, tenantId, ...(inclusive ? [anchorRunId, stamp] : [stamp])).changes
      const history = this.db
        .prepare(
          `DELETE FROM conversation_history_turns
           WHERE session_id = ? AND tenant_id = ? AND ${predicate}`
        )
        .run(sessionId, tenantId, ...(inclusive ? [anchorRunId, stamp] : [stamp])).changes
      // The rolling summary is derived from validated turns and is read back
      // BEFORE them, so a truncated branch would leak through it. Dropping the
      // record is honest: the next summarization rebuilds from what is left.
      this.db
        .prepare(
          `DELETE FROM conversation_rolling_summaries WHERE session_id = ? AND tenant_id = ?`
        )
        .run(sessionId, tenantId)
      return { validated, history }
    })
    return cut()
  }

  private anchorStamp(sessionId: string, tenantId: string, runId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT MAX(created_at) AS created_at FROM (
           SELECT created_at FROM conversation_turns
           WHERE session_id = ? AND tenant_id = ? AND run_id = ? AND kind = 'validated'
           UNION ALL
           SELECT created_at FROM conversation_history_turns
           WHERE session_id = ? AND tenant_id = ? AND run_id = ?
         )`
      )
      .get(sessionId, tenantId, runId, sessionId, tenantId, runId) as { created_at: string | null }
    return row.created_at
  }

  private readLock(sessionId: string): SessionLock | null {
    const row = this.db
      .prepare(
        `SELECT assistant_id, assistant_version, knowledge_base_ids
         FROM conversation_directories WHERE id = ?`
      )
      .get(sessionId) as {
        assistant_id: string | null
        assistant_version: number | null
        knowledge_base_ids: string | null
      } | undefined
    if (!row || row.knowledge_base_ids == null) return null
    return {
      assistantId: row.assistant_id,
      assistantVersion: row.assistant_version,
      knowledgeBaseIds: JSON.parse(row.knowledge_base_ids) as string[],
    }
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
