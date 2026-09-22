/**
 * Ticket 20 (CONV-01A) — server-owned conversation history.
 *
 * Two layers, deliberately separate:
 *
 * 1. `conversation_directories` — one row per thread, owned by
 *    (tenant_id, subject_id). The id is the thread/session id the browser
 *    already generates; the title is derived from the first user message.
 * 2. `conversation_turns` — the messages, shared with the memory subsystem.
 *    A `terminal_status` column (added in ticket 20) records HOW an assistant
 *    turn ended (completed / clarification_required / insufficient_evidence /
 *    provider_error / cancelled …) so success, refusal, failure and
 *    cancellation stay distinguishable after reload. Validated memory keeps
 *    using `kind` — a failed answer is HISTORY-visible but never enters
 *    validated memory.
 *
 * Writes happen at the chat transport: the user turn is appended when the
 * run starts, the assistant turn when the terminal event arrives. Reads are
 * user-scoped queries — another user's directory is the same 404 as an
 * unknown one.
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
  /** Assistant turns only — null for user turns and legacy rows. */
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
   * Ensure the directory row exists for this thread. The title is set once
   * (from the first user message); later runs only touch `updated_at`.
   */
  ensureDirectory(
    sessionId: string,
    tenantId: string,
    subjectId: string,
    titleHint: string
  ): void {
    const now = new Date().toISOString()
    const title =
      titleHint.trim().slice(0, TITLE_MAX) || "新对话"
    this.db
      .prepare(
        `INSERT INTO conversation_directories (id, tenant_id, subject_id, title, imported, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`
      )
      .run(sessionId, tenantId, subjectId, title, now, now)
  }

  appendUserTurn(sessionId: string, tenantId: string, subjectId: string, content: string, runId: string): void {
    this.assertOwned(sessionId, tenantId, subjectId)
    this.db
      .prepare(
        `INSERT INTO conversation_turns (session_id, tenant_id, role, content, run_id, created_at, kind)
         VALUES (?, ?, 'user', ?, ?, ?, 'validated')`
      )
      .run(sessionId, tenantId, content, runId, new Date().toISOString())
  }

  /**
   * Append the assistant turn with its terminal status. Even a failure or a
   * cancellation is recorded (with the partial reply) so history stays
   * honest — memory validity is a separate dimension and untouched here.
   */
  appendAssistantTurn(
    sessionId: string,
    tenantId: string,
    subjectId: string,
    content: string,
    runId: string,
    terminalStatus: AnswerTerminalStatus
  ): void {
    this.assertOwned(sessionId, tenantId, subjectId)
    const now = new Date().toISOString()
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO conversation_turns (session_id, tenant_id, role, content, run_id, created_at, kind, terminal_status)
           VALUES (?, ?, 'assistant', ?, ?, ?, 'validated', ?)`
        )
        .run(sessionId, tenantId, content, runId, now, terminalStatus)
      this.db
        .prepare(`UPDATE conversation_directories SET updated_at = ? WHERE id = ?`)
        .run(now, sessionId)
    })
    insert()
  }

  listDirectories(tenantId: string, subjectId: string): ConversationDirectorySummary[] {
    const rows = this.db
      .prepare(
        `SELECT d.*, (
           SELECT COUNT(*) FROM conversation_turns t WHERE t.session_id = d.id
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

  getTurns(sessionId: string, tenantId: string, subjectId: string): HistoryTurn[] {
    this.assertOwned(sessionId, tenantId, subjectId)
    const rows = this.db
      .prepare(
        `SELECT role, content, run_id, terminal_status, created_at
         FROM conversation_turns
         WHERE session_id = ? AND tenant_id = ?
         ORDER BY created_at ASC, id ASC`
      )
      .all(sessionId, tenantId) as TurnRow[]
    return rows.map((row) => ({
      role: row.role,
      content: row.content,
      runId: row.run_id,
      terminalStatus: row.terminal_status as AnswerTerminalStatus | null,
      createdAt: row.created_at,
    }))
  }

  /**
   * One-time import of browser-local threads. Idempotent by thread id: an
   * existing directory is SKIPPED (never merged, never overwritten), so a
   * repeated import neither duplicates nor destroys anything — and the
   * browser's local storage is never touched by the server.
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
        .prepare(`SELECT id FROM conversation_directories WHERE id = ?`)
        .get(thread.id)
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
        this.db
          .prepare(
            `INSERT INTO conversation_directories (id, tenant_id, subject_id, title, imported, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(thread.id, tenantId, subjectId, title, IMPORTED_TRUE, now, now)
        const insertTurn = this.db.prepare(
          `INSERT INTO conversation_turns (session_id, tenant_id, role, content, run_id, created_at, kind)
           VALUES (?, ?, ?, ?, ?, ?, 'validated')`
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
      })
      write()
      imported += 1
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
