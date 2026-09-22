/**
 * Ticket 30 (FAQ-01A) — the FAQ tables' only owner.
 *
 * Nothing outside this module runs SQL against faq_entries /
 * faq_entry_versions. The repository is deliberately dumb: it stores and reads
 * rows, it never invents a timestamp (the service passes them) and it never
 * decides a lifecycle question (activation conflicts live in the service).
 */

import type { DB } from "../ingestion/tracking/db"
import type {
  FaqEntry,
  FaqEntryStatus,
  FaqEntryVersion,
  FaqSource,
} from "../types/faq"

interface EntryRow {
  id: string
  tenant_id: string
  knowledge_base_id: string
  status: FaqEntryStatus
  current_version: number
  created_at: string
  updated_at: string
}

interface VersionRow {
  faq_entry_id: string
  version: number
  question: string
  normalized_question: string
  variants: string
  answer: string
  source: string | null
  created_by: string
  created_at: string
}

/** One active entry's identity, as the conflict rule and retrieval see it. */
export interface FaqActiveIdentityRow {
  entryId: string
  version: number
  question: string
  normalizedQuestion: string
  variants: string[]
  answer: string
  source: FaqSource | null
}

const ENTRY_COLUMNS =
  "id, tenant_id, knowledge_base_id, status, current_version, created_at, updated_at"
const VERSION_COLUMNS =
  "faq_entry_id, version, question, normalized_question, variants, answer, source, created_by, created_at"

function rowToEntry(row: EntryRow): FaqEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    knowledgeBaseId: row.knowledge_base_id,
    status: row.status,
    currentVersion: row.current_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseSource(raw: string | null): FaqSource | null {
  if (!raw) return null
  const parsed = JSON.parse(raw) as Partial<FaqSource>
  if (typeof parsed?.title !== "string") return null
  return { title: parsed.title, uri: typeof parsed.uri === "string" ? parsed.uri : null }
}

function rowToVersion(row: VersionRow): FaqEntryVersion {
  return {
    version: row.version,
    question: row.question,
    normalizedQuestion: row.normalized_question,
    variants: JSON.parse(row.variants) as string[],
    answer: row.answer,
    source: parseSource(row.source),
    createdBy: row.created_by,
    createdAt: row.created_at,
  }
}

export interface FaqEntryRepo {
  /** INSERT OR IGNORE — the id is deterministic, so a repeat is a no-op. */
  insertEntry(entry: FaqEntry): boolean
  insertVersion(entryId: string, version: FaqEntryVersion): boolean
  getEntry(id: string, tenantId: string): FaqEntry | null
  getVersion(entryId: string, version: number): FaqEntryVersion | null
  listVersions(entryId: string): FaqEntryVersion[]
  /** Tenant + knowledge-base scoped, oldest first (deterministic order). */
  listByKnowledgeBase(
    tenantId: string,
    knowledgeBaseId: string,
    options?: { status?: FaqEntryStatus }
  ): FaqEntry[]
  setStatus(id: string, tenantId: string, status: FaqEntryStatus, updatedAt: string): boolean
  setCurrentVersion(
    id: string,
    tenantId: string,
    version: number,
    updatedAt: string
  ): boolean
  /**
   * The two composite writes a lifecycle transition performs. Each runs in ONE
   * transaction: a crash between the two statements rolls both back, so no
   * orphan entry (an entry whose version row is missing — it would break every
   * list) and no half-applied version (a leftover row a later edit's
   * INSERT OR IGNORE would silently keep instead of the new content) can ever
   * be observed. Both refuse to ignore a swallowed INSERT OR IGNORE.
   */
  createEntryWithVersion(entry: FaqEntry, version: FaqEntryVersion): void
  appendVersion(
    id: string,
    tenantId: string,
    version: FaqEntryVersion,
    updatedAt: string
  ): void
  /**
   * The current version of every ACTIVE entry in the given knowledge bases of
   * one tenant. Both the conflict rule and (ticket 31) retrieval read this:
   * a disabled entry is structurally absent here, so it can never be matched.
   */
  listActiveIdentities(
    tenantId: string,
    knowledgeBaseIds: readonly string[]
  ): FaqActiveIdentityRow[]
}

export class SqliteFaqEntryRepo implements FaqEntryRepo {
  constructor(private db: DB) {}

  insertEntry(entry: FaqEntry): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO faq_entries (${ENTRY_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.id,
        entry.tenantId,
        entry.knowledgeBaseId,
        entry.status,
        entry.currentVersion,
        entry.createdAt,
        entry.updatedAt
      )
    return result.changes > 0
  }

  insertVersion(entryId: string, version: FaqEntryVersion): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO faq_entry_versions (${VERSION_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entryId,
        version.version,
        version.question,
        version.normalizedQuestion,
        JSON.stringify(version.variants),
        version.answer,
        version.source ? JSON.stringify(version.source) : null,
        version.createdBy,
        version.createdAt
      )
    return result.changes > 0
  }

  getEntry(id: string, tenantId: string): FaqEntry | null {
    const row = this.db
      .prepare(`SELECT ${ENTRY_COLUMNS} FROM faq_entries WHERE id = ? AND tenant_id = ?`)
      .get(id, tenantId) as EntryRow | undefined
    return row ? rowToEntry(row) : null
  }

  getVersion(entryId: string, version: number): FaqEntryVersion | null {
    const row = this.db
      .prepare(
        `SELECT ${VERSION_COLUMNS} FROM faq_entry_versions
         WHERE faq_entry_id = ? AND version = ?`
      )
      .get(entryId, version) as VersionRow | undefined
    return row ? rowToVersion(row) : null
  }

  listVersions(entryId: string): FaqEntryVersion[] {
    const rows = this.db
      .prepare(
        `SELECT ${VERSION_COLUMNS} FROM faq_entry_versions
         WHERE faq_entry_id = ? ORDER BY version ASC`
      )
      .all(entryId) as VersionRow[]
    return rows.map(rowToVersion)
  }

  listByKnowledgeBase(
    tenantId: string,
    knowledgeBaseId: string,
    options: { status?: FaqEntryStatus } = {}
  ): FaqEntry[] {
    const conditions = ["tenant_id = ?", "knowledge_base_id = ?"]
    const params: string[] = [tenantId, knowledgeBaseId]
    if (options.status) {
      conditions.push("status = ?")
      params.push(options.status)
    }
    const rows = this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM faq_entries
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at ASC, id ASC`
      )
      .all(...params) as EntryRow[]
    return rows.map(rowToEntry)
  }

  setStatus(
    id: string,
    tenantId: string,
    status: FaqEntryStatus,
    updatedAt: string
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE faq_entries SET status = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?`
      )
      .run(status, updatedAt, id, tenantId)
    return result.changes > 0
  }

  setCurrentVersion(
    id: string,
    tenantId: string,
    version: number,
    updatedAt: string
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE faq_entries SET current_version = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?`
      )
      .run(version, updatedAt, id, tenantId)
    return result.changes > 0
  }

  createEntryWithVersion(entry: FaqEntry, version: FaqEntryVersion): void {
    this.db.transaction(() => {
      if (!this.insertEntry(entry)) {
        throw new Error(`faq entry ${entry.id} could not be created`)
      }
      if (!this.insertVersion(entry.id, version)) {
        throw new Error(`faq entry ${entry.id}: version ${version.version} could not be stored`)
      }
    })()
  }

  appendVersion(id: string, tenantId: string, version: FaqEntryVersion, updatedAt: string): void {
    this.db.transaction(() => {
      if (!this.insertVersion(id, version)) {
        throw new Error(`faq entry ${id}: version ${version.version} could not be stored`)
      }
      if (!this.setCurrentVersion(id, tenantId, version.version, updatedAt)) {
        throw new Error(`faq entry ${id}: the version pointer could not be moved`)
      }
    })()
  }

  listActiveIdentities(
    tenantId: string,
    knowledgeBaseIds: readonly string[]
  ): FaqActiveIdentityRow[] {
    if (knowledgeBaseIds.length === 0) return []
    const placeholders = knowledgeBaseIds.map(() => "?").join(",")
    const rows = this.db
      .prepare(
        `SELECT e.id AS entry_id, v.version, v.question, v.normalized_question,
                v.variants, v.answer, v.source
         FROM faq_entries e
         JOIN faq_entry_versions v
           ON v.faq_entry_id = e.id AND v.version = e.current_version
         WHERE e.tenant_id = ?
           AND e.status = 'active'
           AND e.knowledge_base_id IN (${placeholders})
         ORDER BY e.created_at ASC, e.id ASC`
      )
      .all(tenantId, ...knowledgeBaseIds) as Array<{
      entry_id: string
      version: number
      question: string
      normalized_question: string
      variants: string
      answer: string
      source: string | null
    }>
    return rows.map((row) => ({
      entryId: row.entry_id,
      version: row.version,
      question: row.question,
      normalizedQuestion: row.normalized_question,
      variants: JSON.parse(row.variants) as string[],
      answer: row.answer,
      source: parseSource(row.source),
    }))
  }
}
