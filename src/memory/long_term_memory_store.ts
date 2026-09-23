/**
 * Ticket 32 (MEM-01A) — user-owned durable long-term memories.
 *
 * Ownership IS the query: every read and write carries the full
 * (tenantId, subjectId) owner triple resolved from the caller's
 * AccessContext, never from a request body. Another user's record is the
 * same missing row as an unknown id — there is no listing, editing,
 * recalling or deleting across owners by construction.
 *
 * Scope: a record is either user-global (`assistantId: null` — applies to
 * every assistant of the owner) or pinned to one assistant. `recall` is the
 * single scoping rule the answer path (ticket 33) will read through: global
 * records plus the records of the assistant being run, never anyone else's.
 *
 * Forgetting is a hard DELETE. Cleared is cleared: nothing restores
 * forgotten rows, and the browser seed list this table replaces is not read
 * by anything anymore.
 */

import { randomUUID } from "node:crypto"
import type { DB } from "../ingestion/tracking/db"

/** Bounded, explicit input envelope. */
export const MEMORY_LIMITS = {
  maxContentChars: 2_000,
  /** Records one owner may hold. */
  maxRecordsPerOwner: 200,
} as const

export interface LongTermMemory {
  id: string
  tenantId: string
  subjectId: string
  /** null → user-global; otherwise pinned to this assistant id. */
  assistantId: string | null
  content: string
  createdAt: string
  updatedAt: string
}

export class MemoryContentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MemoryContentError"
  }
}

export class MemoryQuotaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MemoryQuotaError"
  }
}

interface MemoryRow {
  id: string
  tenant_id: string
  subject_id: string
  assistant_id: string | null
  content: string
  created_at: string
  updated_at: string
}

function toMemory(row: MemoryRow): LongTermMemory {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subjectId: row.subject_id,
    assistantId: row.assistant_id,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function assertMemoryContent(content: unknown): string {
  if (typeof content !== "string" || !content.trim()) {
    throw new MemoryContentError("content is required")
  }
  const contentTrimmed = content.trim()
  if (contentTrimmed.length > MEMORY_LIMITS.maxContentChars) {
    throw new MemoryContentError(
      `content must be at most ${MEMORY_LIMITS.maxContentChars} characters`
    )
  }
  return contentTrimmed
}

export interface LongTermMemoryStoreOptions {
  db: DB
  now?: () => Date
  generateId?: () => string
}

export class LongTermMemoryStore {
  private readonly db: DB
  private readonly now: () => Date
  private readonly generateId: () => string

  constructor(options: LongTermMemoryStoreOptions) {
    this.db = options.db
    this.now = options.now ?? (() => new Date())
    this.generateId = options.generateId ?? (() => `mem-${randomUUID()}`)
  }

  create(input: {
    tenantId: string
    subjectId: string
    assistantId?: string | null
    content: unknown
  }): LongTermMemory {
    const content = assertMemoryContent(input.content)
    const activeCount = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM long_term_memories WHERE tenant_id = ? AND subject_id = ?`
      )
      .get(input.tenantId, input.subjectId) as { n: number }
    if (activeCount.n >= MEMORY_LIMITS.maxRecordsPerOwner) {
      throw new MemoryQuotaError(
        `an owner holds at most ${MEMORY_LIMITS.maxRecordsPerOwner} memories`
      )
    }
    const timestamp = this.now().toISOString()
    const memory: LongTermMemory = {
      id: this.generateId(),
      tenantId: input.tenantId,
      subjectId: input.subjectId,
      assistantId: input.assistantId ?? null,
      content,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.db
      .prepare(
        `INSERT INTO long_term_memories (id, tenant_id, subject_id, assistant_id, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        memory.id,
        memory.tenantId,
        memory.subjectId,
        memory.assistantId,
        memory.content,
        memory.createdAt,
        memory.updatedAt
      )
    return memory
  }

  /** Every record the owner can inspect and manage, newest first. */
  list(tenantId: string, subjectId: string): LongTermMemory[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM long_term_memories WHERE tenant_id = ? AND subject_id = ?
           ORDER BY created_at DESC, id DESC`
        )
        .all(tenantId, subjectId) as MemoryRow[]
    ).map(toMemory)
  }

  /**
   * The records a RUN may read: the owner's global memories plus the ones
   * pinned to the assistant being run. `assistantId: null` (legacy/default
   * assistant) reads global memories only.
   */
  recall(
    tenantId: string,
    subjectId: string,
    assistantId: string | null
  ): LongTermMemory[] {
    return this.list(tenantId, subjectId).filter(
      (memory) => memory.assistantId === null || memory.assistantId === assistantId
    )
  }

  /** Own record by id; another user's or unknown → null (same 404). */
  get(tenantId: string, subjectId: string, id: string): LongTermMemory | null {
    const row = this.db
      .prepare(
        `SELECT * FROM long_term_memories WHERE id = ? AND tenant_id = ? AND subject_id = ?`
      )
      .get(id, tenantId, subjectId) as MemoryRow | undefined
    return row ? toMemory(row) : null
  }

  edit(
    tenantId: string,
    subjectId: string,
    id: string,
    content: unknown
  ): LongTermMemory | null {
    const contentTrimmed = assertMemoryContent(content)
    const existing = this.get(tenantId, subjectId, id)
    if (!existing) return null
    const updatedAt = this.now().toISOString()
    this.db
      .prepare(
        `UPDATE long_term_memories SET content = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND subject_id = ?`
      )
      .run(contentTrimmed, updatedAt, id, tenantId, subjectId)
    return { ...existing, content: contentTrimmed, updatedAt }
  }

  /** Hard delete of one own record. True when a row was forgotten. */
  forget(tenantId: string, subjectId: string, id: string): boolean {
    const result = this.db
      .prepare(
        `DELETE FROM long_term_memories WHERE id = ? AND tenant_id = ? AND subject_id = ?`
      )
      .run(id, tenantId, subjectId)
    return result.changes > 0
  }

  /** Clear every own record. Returns how many were forgotten. */
  forgetAll(tenantId: string, subjectId: string): number {
    const result = this.db
      .prepare(`DELETE FROM long_term_memories WHERE tenant_id = ? AND subject_id = ?`)
      .run(tenantId, subjectId)
    return result.changes
  }
}
