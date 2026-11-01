/**
 * Long-term memory (2026-10-30) — ONE account-level profile per owner.
 *
 * The profile replaces the old record list and suggestion queue. It holds
 * three editable sections (work background, personal background, recent
 * activity). Ownership IS the query: every read and write carries the full
 * (tenantId, subjectId) owner pair resolved from the caller's AccessContext,
 * never from a request body. Another account's profile is the same missing
 * row as an account that never wrote one.
 *
 * Automatic summary metadata (`lastSessionId` + `lastSessionFingerprint`)
 * makes running the summarizer twice on an unchanged session a no-op. A
 * manual edit keeps that metadata: the owner edits the text, not the
 * summarizer's checkpoint. Reset is a hard DELETE of the whole row.
 */

import type { DB } from "../ingestion/tracking/db"

export const MEMORY_SECTION_KEYS = [
  "workBackground",
  "personalBackground",
  "recentActivity",
] as const

export type MemorySectionKey = (typeof MEMORY_SECTION_KEYS)[number]

export const MEMORY_PROFILE_LIMITS = {
  /** Max characters of one section (applies to edits and summaries). */
  maxSectionChars: 800,
} as const

export interface MemoryProfile {
  tenantId: string
  subjectId: string
  workBackground: string
  personalBackground: string
  recentActivity: string
  /** null until the owner (or the summarizer) writes the profile. */
  updatedAt: string | null
}

export interface MemoryProfileSummaryMeta {
  lastSessionId: string | null
  lastSessionFingerprint: string | null
}

export class MemoryProfileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MemoryProfileError"
  }
}

interface ProfileRow {
  tenant_id: string
  subject_id: string
  work_background: string
  personal_background: string
  recent_activity: string
  last_session_id: string | null
  last_session_fingerprint: string | null
  updated_at: string
}

function toProfile(row: ProfileRow): MemoryProfile {
  return {
    tenantId: row.tenant_id,
    subjectId: row.subject_id,
    workBackground: row.work_background,
    personalBackground: row.personal_background,
    recentActivity: row.recent_activity,
    updatedAt: row.updated_at,
  }
}

/** An empty profile for an owner who has never written one. */
export function emptyProfile(tenantId: string, subjectId: string): MemoryProfile {
  return {
    tenantId,
    subjectId,
    workBackground: "",
    personalBackground: "",
    recentActivity: "",
    updatedAt: null,
  }
}

export function assertMemorySection(
  key: MemorySectionKey,
  value: unknown
): string {
  if (typeof value !== "string") {
    throw new MemoryProfileError(`${key} must be a string`)
  }
  const trimmed = value.trim()
  if (trimmed.length > MEMORY_PROFILE_LIMITS.maxSectionChars) {
    throw new MemoryProfileError(
      `${key} must be at most ${MEMORY_PROFILE_LIMITS.maxSectionChars} characters`
    )
  }
  return trimmed
}

export interface MemoryProfileStoreOptions {
  db: DB
  now?: () => Date
}

export class MemoryProfileStore {
  private readonly db: DB
  private readonly now: () => Date

  constructor(options: MemoryProfileStoreOptions) {
    this.db = options.db
    this.now = options.now ?? (() => new Date())
  }

  get(tenantId: string, subjectId: string): MemoryProfile {
    const row = this.row(tenantId, subjectId)
    return row
      ? toProfile(row)
      : emptyProfile(tenantId, subjectId)
  }

  summaryMeta(tenantId: string, subjectId: string): MemoryProfileSummaryMeta {
    const row = this.row(tenantId, subjectId)
    return {
      lastSessionId: row?.last_session_id ?? null,
      lastSessionFingerprint: row?.last_session_fingerprint ?? null,
    }
  }

  /**
   * Owner edit. Only the provided sections change; summary metadata is
   * preserved so a later automatic summary still dedupes correctly.
   */
  save(
    tenantId: string,
    subjectId: string,
    sections: Partial<Record<MemorySectionKey, unknown>>
  ): MemoryProfile {
    const current = this.get(tenantId, subjectId)
    const next = {
      workBackground:
        sections.workBackground === undefined
          ? current.workBackground
          : assertMemorySection("workBackground", sections.workBackground),
      personalBackground:
        sections.personalBackground === undefined
          ? current.personalBackground
          : assertMemorySection("personalBackground", sections.personalBackground),
      recentActivity:
        sections.recentActivity === undefined
          ? current.recentActivity
          : assertMemorySection("recentActivity", sections.recentActivity),
    }
    const updatedAt = this.now().toISOString()
    this.db
      .prepare(
        `INSERT INTO memory_profiles
           (tenant_id, subject_id, work_background, personal_background, recent_activity, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, subject_id) DO UPDATE SET
           work_background = excluded.work_background,
           personal_background = excluded.personal_background,
           recent_activity = excluded.recent_activity,
           updated_at = excluded.updated_at`
      )
      .run(
        tenantId,
        subjectId,
        next.workBackground,
        next.personalBackground,
        next.recentActivity,
        updatedAt
      )
    return { ...current, ...next, updatedAt }
  }

  /** Automatic summary: replace all three sections and advance the checkpoint. */
  recordSummary(
    tenantId: string,
    subjectId: string,
    sections: Record<MemorySectionKey, unknown>,
    meta: { sessionId: string; fingerprint: string }
  ): MemoryProfile {
    const next = {
      workBackground: assertMemorySection("workBackground", sections.workBackground),
      personalBackground: assertMemorySection("personalBackground", sections.personalBackground),
      recentActivity: assertMemorySection("recentActivity", sections.recentActivity),
    }
    const updatedAt = this.now().toISOString()
    this.db
      .prepare(
        `INSERT INTO memory_profiles
           (tenant_id, subject_id, work_background, personal_background, recent_activity,
            last_session_id, last_session_fingerprint, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, subject_id) DO UPDATE SET
           work_background = excluded.work_background,
           personal_background = excluded.personal_background,
           recent_activity = excluded.recent_activity,
           last_session_id = excluded.last_session_id,
           last_session_fingerprint = excluded.last_session_fingerprint,
           updated_at = excluded.updated_at`
      )
      .run(
        tenantId,
        subjectId,
        next.workBackground,
        next.personalBackground,
        next.recentActivity,
        meta.sessionId,
        meta.fingerprint,
        updatedAt
      )
    return { tenantId, subjectId, ...next, updatedAt }
  }

  /**
   * Reset: forget the three sections but KEEP the summary checkpoint. A
   * session that was already summarized before the reset is not immediately
   * re-summarized into the profile the owner just cleared; a new/different
   * session still summarizes normally.
   */
  reset(tenantId: string, subjectId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE memory_profiles
         SET work_background = '', personal_background = '', recent_activity = '', updated_at = ?
         WHERE tenant_id = ? AND subject_id = ?`
      )
      .run(this.now().toISOString(), tenantId, subjectId)
    return result.changes > 0
  }

  private row(tenantId: string, subjectId: string): ProfileRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM memory_profiles WHERE tenant_id = ? AND subject_id = ?`
      )
      .get(tenantId, subjectId) as ProfileRow | undefined
  }
}
