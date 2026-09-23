/**
 * Ticket 33 (MEM-01B) — memory extraction suggestions.
 *
 * Automatic extraction NEVER publishes a memory: it only creates PENDING
 * suggestions the owner reviews (accept → a real long-term memory,
 * dismiss → gone). Extraction runs ONLY after a COMPLETED answer — failed,
 * refused, cancelled or handoff answers never create suggestions, so
 * untrusted output cannot leak into the memory surface even as a suggestion.
 *
 * ponytail: extraction is a deterministic keyword heuristic over the user's
 * own message (explicit preference signals), bounded per run. When the demo
 * needs real extraction quality, replace `extractMemorySuggestions` with an
 * LLM extractor behind the same signature — the review gate and the store
 * contract do not change.
 */

import { randomUUID } from "node:crypto"
import type { DB } from "../ingestion/tracking/db"

/** Suggestions one owner keeps in the review queue before pruning. */
export const MEMORY_SUGGESTION_LIMITS = {
  /** Max suggestions created from ONE run. */
  maxPerRun: 2,
  /** Max chars of one suggestion (mirrors the memory content bound). */
  maxContentChars: 500,
  /** Max pending suggestions per owner; further extractions are dropped. */
  maxPendingPerOwner: 50,
} as const

export type MemorySuggestionStatus = "pending" | "accepted" | "dismissed"

export interface MemorySuggestion {
  id: string
  tenantId: string
  subjectId: string
  assistantId: string | null
  /** The completed run the suggestion was extracted from. */
  sourceRunId: string
  content: string
  status: MemorySuggestionStatus
  createdAt: string
  updatedAt: string
}

interface SuggestionRow {
  id: string
  tenant_id: string
  subject_id: string
  assistant_id: string | null
  source_run_id: string
  content: string
  status: string
  created_at: string
  updated_at: string
}

function toSuggestion(row: SuggestionRow): MemorySuggestion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subjectId: row.subject_id,
    assistantId: row.assistant_id,
    sourceRunId: row.source_run_id,
    content: row.content,
    status: row.status as MemorySuggestionStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Sentences carrying an explicit durable-preference signal. */
const MEMORY_TRIGGER_PATTERN =
  /(记住|记一下|记下|请记得|以后|以后每次|每次都|我偏好|偏好是|我喜欢|我不喜欢|我想要|我的名字|请勿|请不要|别再)/

/**
 * The extraction heuristic: sentences of the user's message that carry an
 * explicit preference/memory signal, bounded and deduplicated. Deterministic
 * and free — the review gate (not extraction quality) is the product
 * contract here.
 */
export function extractMemorySuggestions(
  message: string,
  limit: number = MEMORY_SUGGESTION_LIMITS.maxPerRun
): string[] {
  if (limit <= 0) return []
  const sentences = message
    .split(/[。！？!?\n；;]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
  const picked: string[] = []
  for (const sentence of sentences) {
    if (!MEMORY_TRIGGER_PATTERN.test(sentence)) continue
    const bounded = sentence.slice(0, MEMORY_SUGGESTION_LIMITS.maxContentChars)
    if (picked.includes(bounded)) continue
    picked.push(bounded)
    if (picked.length >= limit) break
  }
  return picked
}

export interface MemorySuggestionStoreOptions {
  db: DB
  now?: () => Date
  generateId?: () => string
}

export class MemorySuggestionStore {
  private readonly db: DB
  private readonly now: () => Date
  private readonly generateId: () => string

  constructor(options: MemorySuggestionStoreOptions) {
    this.db = options.db
    this.now = options.now ?? (() => new Date())
    this.generateId = options.generateId ?? (() => `memsug-${randomUUID()}`)
  }

  /**
   * Create one PENDING suggestion. Returns null (and writes nothing) when an
   * identical suggestion already exists for the owner as pending or accepted
   * — re-running the same conversation never floods the review queue.
   */
  createPending(input: {
    tenantId: string
    subjectId: string
    assistantId: string | null
    sourceRunId: string
    content: string
  }): MemorySuggestion | null {
    const duplicate = this.db
      .prepare(
        `SELECT id FROM memory_suggestions
         WHERE tenant_id = ? AND subject_id = ? AND content = ?
           AND status IN ('pending', 'accepted')`
      )
      .get(input.tenantId, input.subjectId, input.content)
    if (duplicate) return null
    const pendingCount = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_suggestions
         WHERE tenant_id = ? AND subject_id = ? AND status = 'pending'`
      )
      .get(input.tenantId, input.subjectId) as { n: number }
    if (pendingCount.n >= MEMORY_SUGGESTION_LIMITS.maxPendingPerOwner) return null
    const timestamp = this.now().toISOString()
    const suggestion: MemorySuggestion = {
      id: this.generateId(),
      tenantId: input.tenantId,
      subjectId: input.subjectId,
      assistantId: input.assistantId,
      sourceRunId: input.sourceRunId,
      content: input.content,
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.db
      .prepare(
        `INSERT INTO memory_suggestions (id, tenant_id, subject_id, assistant_id, source_run_id, content, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(
        suggestion.id,
        suggestion.tenantId,
        suggestion.subjectId,
        suggestion.assistantId,
        suggestion.sourceRunId,
        suggestion.content,
        suggestion.createdAt,
        suggestion.updatedAt
      )
    return suggestion
  }

  /** The owner's suggestions, newest first; default filters to pending. */
  list(
    tenantId: string,
    subjectId: string,
    status: MemorySuggestionStatus = "pending"
  ): MemorySuggestion[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM memory_suggestions WHERE tenant_id = ? AND subject_id = ? AND status = ?
           ORDER BY created_at DESC, id DESC`
        )
        .all(tenantId, subjectId, status) as SuggestionRow[]
    ).map(toSuggestion)
  }

  get(tenantId: string, subjectId: string, id: string): MemorySuggestion | null {
    const row = this.db
      .prepare(
        `SELECT * FROM memory_suggestions WHERE id = ? AND tenant_id = ? AND subject_id = ?`
      )
      .get(id, tenantId, subjectId) as SuggestionRow | undefined
    return row ? toSuggestion(row) : null
  }

  /**
   * Move a PENDING suggestion to accepted (the caller creates the memory
   * itself, then marks it here). Only pending rows move — a settled
   * suggestion is never re-settled. Returns the updated suggestion or null
   * (unknown, foreign, or already settled).
   */
  markAccepted(tenantId: string, subjectId: string, id: string): MemorySuggestion | null {
    const existing = this.get(tenantId, subjectId, id)
    if (!existing || existing.status !== "pending") return null
    const updatedAt = this.now().toISOString()
    this.db
      .prepare(
        `UPDATE memory_suggestions SET status = 'accepted', updated_at = ?
         WHERE id = ? AND tenant_id = ? AND subject_id = ?`
      )
      .run(updatedAt, id, tenantId, subjectId)
    return { ...existing, status: "accepted", updatedAt }
  }

  /** Move a PENDING suggestion to dismissed. Same settle-once rule. */
  dismiss(tenantId: string, subjectId: string, id: string): MemorySuggestion | null {
    const existing = this.get(tenantId, subjectId, id)
    if (!existing || existing.status !== "pending") return null
    const updatedAt = this.now().toISOString()
    this.db
      .prepare(
        `UPDATE memory_suggestions SET status = 'dismissed', updated_at = ?
         WHERE id = ? AND tenant_id = ? AND subject_id = ?`
      )
      .run(updatedAt, id, tenantId, subjectId)
    return { ...existing, status: "dismissed", updatedAt }
  }
}
