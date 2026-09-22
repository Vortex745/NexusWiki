import type { DB } from "./db"
import type { Document, DocumentStatus } from "../../types"
import { defaultKnowledgeBaseId } from "../../types/knowledge_base"

interface DocumentRow {
  doc_id: string
  source_id: string
  content_hash: string
  version: number
  activation_order: number
  title: string
  source: string
  content: string
  raw_content: Buffer | null
  file_name: string | null
  mime_type: string | null
  parser_override: string | null
  metadata: string
  status: string
  created_at: string
  updated_at: string
  tenant_id: string
  allowed_groups: string
  knowledge_base_id: string
}

function rowToDocument(row: DocumentRow): Document {
  return {
    id: row.doc_id,
    sourceId: row.source_id,
    contentHash: row.content_hash,
    version: row.version,
    title: row.title,
    source: row.source,
    content: row.content,
    rawContent: row.raw_content,
    fileName: row.file_name,
    mimeType: row.mime_type,
    parserOverride: row.parser_override,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
    createdAt: new Date(row.created_at),
    tenantId: row.tenant_id,
    allowedGroups: JSON.parse(row.allowed_groups),
    knowledgeBaseId: row.knowledge_base_id,
  }
}

export interface InsertDocumentInput {
  docId: string
  sourceId: string
  contentHash: string
  version: number
  title: string
  source: string
  content: string
  rawContent?: Buffer
  fileName?: string
  mimeType?: string
  parserOverride?: string
  metadata?: Record<string, unknown>
  /**
   * Ticket 06 P2: access metadata inherited from the Source. Optional so
   * legacy callers (e.g. pipeline.t54.test.ts) fall back to SCHEMA DEFAULT
   * 'default' / '[]' when omitted.
   */
  tenantId?: string
  allowedGroups?: string[]
  /**
   * Ticket 03 (KB-02A): the knowledge base that owns this document. Optional
   * so legacy callers fall back to the tenant's deterministic default
   * knowledge base — never to an unowned row (criterion 4).
   */
  knowledgeBaseId?: string
}

export interface SourceIdentityInput {
  sourceId: string
  sourceKey: string
  kind: string
  uri: string
  namespace: string
  tenantId?: string
  allowedGroups?: string[]
  /** Ticket 03 (KB-02A): the owning knowledge base (defaults to the tenant default). */
  knowledgeBaseId?: string
}

export interface SourceRecord {
  sourceId: string
  /**
   * Ticket 06 P2: access metadata persisted on the sources row. Required on
   * the record because the SQLite columns are NOT NULL DEFAULT — repo reads
   * always populate these. New ingestion (lifecycle.submit) reads them from
   * the source row and passes them to DocumentRepo.insert.
   */
  tenantId: string
  allowedGroups: string[]
  /** Ticket 03 (KB-02A): the owning knowledge base, always populated. */
  knowledgeBaseId: string
}

export interface LegacySourceRecord extends SourceRecord {
  uri: string
}

export interface DocumentVersionInfo {
  version: number
  contentHash: string
  active: boolean
}

/**
 * Ticket 11 (DOC-01A): one catalog row — document metadata without content.
 * Tags/folder come from the metadata JSON (`$.tags` / `$.folder`).
 */
export interface DocumentCatalogEntry {
  docId: string
  title: string
  source: string
  fileName: string | null
  mimeType: string | null
  status: string
  candidateState: string
  version: number
  active: boolean
  tags: string[]
  folder: string | null
  createdAt: string
  updatedAt: string
}

export interface DocumentCatalogQuery {
  tenantId: string
  knowledgeBaseId: string
  page: number
  pageSize: number
  status?: string
  tag?: string
  folder?: string
  /**
   * The viewer's groups. Mirrors the retrieval ACL (graph_acl.ts): the group
   * filter only applies when the viewer HAS groups; a zero-group viewer (or
   * an admin) sees every same-tenant row. Non-admin viewers with groups see
   * rows whose allowedGroups is empty (tenant-wide) or intersects their own
   * (ticket 10 import semantics).
   */
  viewerGroups?: string[]
  admin?: boolean
}

export interface DocumentCatalogPage {
  documents: DocumentCatalogEntry[]
  total: number
  page: number
  pageSize: number
  tags: string[]
  folders: string[]
}

export class DocumentRepo {
  constructor(private db: DB) {}

  insert(input: InsertDocumentInput): void {
    const now = new Date().toISOString()
    this.db.prepare(
      `INSERT INTO documents (
        doc_id, source_id, content_hash, version, activation_order,
        title, source, content, raw_content, file_name, mime_type, parser_override,
        metadata, status, created_at, updated_at,
        tenant_id, allowed_groups, knowledge_base_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
    ).run(
      input.docId,
      input.sourceId,
      input.contentHash,
      input.version,
      input.version,
      input.title,
      input.source,
      input.content,
      input.rawContent ?? null,
      input.fileName ?? null,
      input.mimeType ?? null,
      input.parserOverride ?? null,
      input.metadata ? JSON.stringify(input.metadata) : "{}",
      now,
      now,
      input.tenantId ?? "default",
      JSON.stringify(input.allowedGroups ?? []),
      input.knowledgeBaseId ?? defaultKnowledgeBaseId(input.tenantId ?? "default")
    )
  }

  get(docId: string): Document | null {
    const row = this.db.prepare(
      `SELECT * FROM documents WHERE doc_id = ?`
    ).get(docId) as DocumentRow | undefined
    return row ? rowToDocument(row) : null
  }

  exists(docId: string): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM documents WHERE doc_id = ?`
    ).get(docId) as { 1: number } | undefined
    return !!row
  }

  createSource(input: SourceIdentityInput): SourceRecord {
    const now = new Date().toISOString()
    this.db.prepare(
      `INSERT INTO sources (
        source_id, source_key, source_kind, source_uri, namespace,
        active_doc_id, last_doc_id, last_outcome, created_at, updated_at,
        tenant_id, allowed_groups, knowledge_base_id
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)`
    ).run(
      input.sourceId,
      input.sourceKey,
      input.kind,
      input.uri,
      input.namespace,
      now,
      now,
      input.tenantId ?? "default",
      JSON.stringify(input.allowedGroups ?? []),
      input.knowledgeBaseId ?? defaultKnowledgeBaseId(input.tenantId ?? "default")
    )
    const row = this.db.prepare(
      `SELECT tenant_id, allowed_groups, knowledge_base_id
       FROM sources WHERE source_id = ?`
    ).get(input.sourceId) as {
      tenant_id: string
      allowed_groups: string
      knowledge_base_id: string
    }
    return {
      sourceId: input.sourceId,
      tenantId: row.tenant_id,
      allowedGroups: JSON.parse(row.allowed_groups),
      knowledgeBaseId: row.knowledge_base_id,
    }
  }

  updateSourceIdentity(
    sourceId: string,
    input: Omit<SourceIdentityInput, "sourceId">
  ): void {
    const info = this.db.prepare(
      `UPDATE sources
       SET source_key = ?, source_kind = ?, source_uri = ?, namespace = ?,
           tenant_id = ?, allowed_groups = ?, knowledge_base_id = ?, updated_at = ?
       WHERE source_id = ?`
    ).run(
      input.sourceKey,
      input.kind,
      input.uri,
      input.namespace,
      input.tenantId ?? "default",
      JSON.stringify(input.allowedGroups ?? []),
      input.knowledgeBaseId ?? defaultKnowledgeBaseId(input.tenantId ?? "default"),
      new Date().toISOString(),
      sourceId
    )
    if (info.changes !== 1) {
      throw new Error(`Source ${sourceId} could not adopt its canonical identity`)
    }
  }

  getSourceByKey(sourceKey: string): SourceRecord | null {
    const row = this.db.prepare(
      `SELECT COALESCE(canonical_source_id, source_id) AS source_id,
              tenant_id, allowed_groups, knowledge_base_id
       FROM sources WHERE source_key = ?`
    ).get(sourceKey) as
      | {
          source_id: string
          tenant_id: string
          allowed_groups: string
          knowledge_base_id: string
        }
      | undefined
    return row
      ? {
          sourceId: row.source_id,
          tenantId: row.tenant_id,
          allowedGroups: JSON.parse(row.allowed_groups),
          knowledgeBaseId: row.knowledge_base_id,
        }
      : null
  }

  listLegacySources(): LegacySourceRecord[] {
    const rows = this.db.prepare(
      `SELECT source_id, source_uri, tenant_id, allowed_groups, knowledge_base_id
       FROM sources
       WHERE source_kind = 'legacy' AND namespace = 'default'
         AND canonical_source_id IS NULL`
    ).all() as Array<{
      source_id: string
      source_uri: string
      tenant_id: string
      allowed_groups: string
      knowledge_base_id: string
    }>
    return rows.map((row) => ({
      sourceId: row.source_id,
      uri: row.source_uri,
      tenantId: row.tenant_id,
      allowedGroups: JSON.parse(row.allowed_groups),
      knowledgeBaseId: row.knowledge_base_id,
    }))
  }

  adoptCanonicalSource(
    sourceId: string,
    aliasSourceIds: string[],
    input: Omit<SourceIdentityInput, "sourceId">,
    activeDocId: string | null
  ): void {
    if (activeDocId) {
      const active = this.get(activeDocId)
      if (active && active.sourceId !== sourceId) {
        const history = this.db.prepare(
          `SELECT doc_id
           FROM documents
           WHERE source_id = ? OR doc_id = ?
           ORDER BY created_at ASC, doc_id ASC`
        ).all(sourceId, activeDocId) as Array<{ doc_id: string }>
        this.db.prepare(
          `UPDATE documents
           SET source_id = ?, version = ?, activation_order = 0, updated_at = ?
           WHERE doc_id = ?`
        ).run(
          sourceId,
          this.getNextVersion(sourceId),
          new Date().toISOString(),
          activeDocId
        )
        const updateActivationOrder = this.db.prepare(
          `UPDATE documents SET activation_order = ? WHERE doc_id = ?`
        )
        history.forEach((document, index) => {
          updateActivationOrder.run(index + 1, document.doc_id)
        })
      }
    }
    this.updateSourceIdentity(sourceId, input)
    this.db.prepare(
      `UPDATE documents
       SET tenant_id = ?, allowed_groups = ?, knowledge_base_id = ?, updated_at = ?
       WHERE source_id = ?`
    ).run(
      input.tenantId ?? "default",
      JSON.stringify(input.allowedGroups ?? []),
      input.knowledgeBaseId ?? defaultKnowledgeBaseId(input.tenantId ?? "default"),
      new Date().toISOString(),
      sourceId
    )
    if (activeDocId) {
      this.db.prepare(
        `UPDATE sources
         SET active_doc_id = ?, last_doc_id = ?, last_outcome = 'completed', updated_at = ?
         WHERE source_id = ?`
      ).run(activeDocId, activeDocId, new Date().toISOString(), sourceId)
    }
    const updateAlias = this.db.prepare(
      `UPDATE sources
       SET canonical_source_id = ?, active_doc_id = NULL, updated_at = ?
       WHERE source_id = ?`
    )
    for (const aliasSourceId of aliasSourceIds) {
      updateAlias.run(sourceId, new Date().toISOString(), aliasSourceId)
    }
  }

  getActive(sourceId: string): Document | null {
    const row = this.db.prepare(
      `SELECT d.*
       FROM sources s
       JOIN documents d ON d.doc_id = s.active_doc_id
       WHERE s.source_id = ?`
    ).get(sourceId) as DocumentRow | undefined
    return row ? rowToDocument(row) : null
  }

  updateMetadata(docId: string, metadata: Record<string, unknown>): void {
    const info = this.db.prepare(
      "UPDATE documents SET metadata = ?, updated_at = ? WHERE doc_id = ?"
    ).run(JSON.stringify(metadata), new Date().toISOString(), docId)
    if (info.changes !== 1) {
      throw new Error(`Document metadata could not be updated: ${docId}`)
    }
  }

  getInFlightByHash(sourceId: string, contentHash: string): Document | null {
    const row = this.db.prepare(
      `SELECT d.*
       FROM documents d
       JOIN task_pending_ops t ON t.doc_id = d.doc_id
       WHERE d.source_id = ? AND d.content_hash = ?
         AND t.status IN ('pending', 'running')
       ORDER BY d.version DESC
       LIMIT 1`
    ).get(sourceId, contentHash) as DocumentRow | undefined
    return row ? rowToDocument(row) : null
  }

  getNextVersion(sourceId: string): number {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(version), 0) + 1 AS version
       FROM documents WHERE source_id = ?`
    ).get(sourceId) as { version: number }
    return row.version
  }

  recordOutcome(
    sourceId: string,
    docId: string,
    outcome: DocumentStatus | "unchanged"
  ): void {
    this.db.prepare(
      `UPDATE sources
       SET last_doc_id = ?, last_outcome = ?, updated_at = ?
       WHERE source_id = ?`
    ).run(docId, outcome, new Date().toISOString(), sourceId)
  }

  activate(docId: string): void {
    this.db.prepare(
      `UPDATE sources
       SET active_doc_id = ?, updated_at = ?
       WHERE source_id = (SELECT source_id FROM documents WHERE doc_id = ?)
         AND canonical_source_id IS NULL
         AND (
           active_doc_id IS NULL OR
           (SELECT activation_order FROM documents WHERE doc_id = active_doc_id) <
             (SELECT activation_order FROM documents WHERE doc_id = ?)
         )`
    ).run(docId, new Date().toISOString(), docId, docId)
  }

  getStatus(docId: string): DocumentStatus | null {
    const row = this.db.prepare(
      `SELECT status FROM documents WHERE doc_id = ?`
    ).get(docId) as { status: string } | undefined
    return (row?.status as DocumentStatus | undefined) ?? null
  }

  getLifecycleOutcome(docId: string): DocumentStatus | "unchanged" | null {
    const row = this.db.prepare(
      `SELECT d.status,
              CASE WHEN s.last_doc_id = d.doc_id THEN s.last_outcome END AS latest_outcome
       FROM documents d
       JOIN sources s ON s.source_id = d.source_id
       WHERE d.doc_id = ?`
    ).get(docId) as { status: string; latest_outcome: string | null } | undefined
    return (row?.latest_outcome ?? row?.status ?? null) as
      | DocumentStatus
      | "unchanged"
      | null
  }

  getVersionInfo(docId: string): DocumentVersionInfo | null {
    const row = this.db.prepare(
      `SELECT d.version, d.content_hash, s.active_doc_id = d.doc_id AS active
       FROM documents d
       JOIN sources s ON s.source_id = d.source_id
       WHERE d.doc_id = ?`
    ).get(docId) as {
      version: number
      content_hash: string
      active: number
    } | undefined
    return row
      ? {
          version: row.version,
          contentHash: row.content_hash,
          active: row.active === 1,
        }
      : null
  }

  updateStatus(docId: string, status: "completed" | "failed" | "cancelled"): void {
    const info = this.db.prepare(
      `UPDATE documents SET status = ?, updated_at = ? WHERE doc_id = ?`
    ).run(status, new Date().toISOString(), docId)
    if (info.changes !== 1) return
    this.db.prepare(
      `UPDATE sources
       SET last_outcome = ?, updated_at = ?
       WHERE last_doc_id = ?`
    ).run(status, new Date().toISOString(), docId)
  }

  /**
   * P6.1 (spec §11 L1574, L73): Mark a completed candidate as
   * `pending_review`. Called by IngestionLifecycle.runNext() when
   * `ACTIVATION_MODE=review` — the candidate is queryable for review but
   * does NOT become the active version. Terminal activation is deferred to
   * `CandidateReviewStore.review()` on approve (spec L1575).
   *
   * Silent no-op if the doc doesn't exist (matches `activate`'s contract) —
   * callers always operate on a confirmed-existing doc within a transaction.
   */
  markPendingReview(docId: string): void {
    this.db.prepare(
      `UPDATE documents SET candidate_state = 'pending_review', updated_at = ?
       WHERE doc_id = ?`
    ).run(new Date().toISOString(), docId)
  }

  /**
   * Ticket 11 (DOC-01A): the knowledge-base document catalog — paginated,
   * tenant+knowledge-base scoped, filtered by processing state (status),
   * metadata tag and one-level folder. Group visibility mirrors the retrieval
   * ACL (graph_acl.ts): only viewers WITH groups are restricted, and they see
   * tenant-wide rows (allowedGroups '[]') plus rows addressed to their own
   * groups; zero-group viewers and admins see every same-tenant row. Content
   * is never returned — catalog rows are metadata only.
   */
  listCatalog(query: DocumentCatalogQuery): DocumentCatalogPage {
    const conditions: string[] = ["d.tenant_id = ?", "d.knowledge_base_id = ?"]
    const params: Array<string | number> = [query.tenantId, query.knowledgeBaseId]
    if (query.status) {
      conditions.push("d.status = ?")
      params.push(query.status)
    }
    if (query.tag) {
      conditions.push(
        "EXISTS (SELECT 1 FROM json_each(d.metadata, '$.tags') je WHERE je.value = ?)"
      )
      params.push(query.tag)
    }
    if (query.folder) {
      conditions.push("json_extract(d.metadata, '$.folder') = ?")
      params.push(query.folder)
    }
    // Group visibility mirrors the retrieval ACL: the filter only applies
    // when the viewer HAS groups; zero-group viewers and admins see all
    // same-tenant rows.
    if (!query.admin) {
      const groups = query.viewerGroups ?? []
      if (groups.length > 0) {
        conditions.push(
          `(d.allowed_groups = '[]' OR EXISTS (
             SELECT 1 FROM json_each(d.allowed_groups) ag
             WHERE ag.value IN (${groups.map(() => "?").join(", ")})))`
        )
        params.push(...groups)
      }
    }
    const where = conditions.join(" AND ")
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM documents d WHERE ${where}`).get(...params) as {
        n: number
      }
    ).n

    const page = Math.max(1, Math.floor(query.page))
    const pageSize = Math.max(1, Math.floor(query.pageSize))
    const rows = this.db
      .prepare(
        `SELECT d.doc_id, d.title, d.source, d.file_name, d.mime_type, d.status,
                d.candidate_state, d.version, d.metadata, d.created_at, d.updated_at,
                (s.active_doc_id = d.doc_id) AS is_active
         FROM documents d
         LEFT JOIN sources s ON s.source_id = d.source_id
         WHERE ${where}
         ORDER BY d.created_at DESC, d.doc_id ASC
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, (page - 1) * pageSize) as Array<{
      doc_id: string
      title: string
      source: string
      file_name: string | null
      mime_type: string | null
      status: string
      candidate_state: string
      version: number
      metadata: string
      created_at: string
      updated_at: string
      is_active: number | null
    }>
    const documents: DocumentCatalogEntry[] = rows.map((row) => {
      const metadata = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {}
      const tags = Array.isArray(metadata.tags)
        ? metadata.tags.filter((tag): tag is string => typeof tag === "string")
        : []
      return {
        docId: row.doc_id,
        title: row.title,
        source: row.source,
        fileName: row.file_name,
        mimeType: row.mime_type,
        status: row.status,
        candidateState: row.candidate_state,
        version: row.version,
        active: row.is_active === 1,
        tags,
        folder: typeof metadata.folder === "string" && metadata.folder !== "" ? metadata.folder : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    })
    return {
      documents,
      total,
      page,
      pageSize,
      tags: this.listFacets(query, "tags"),
      folders: this.listFacets(query, "folder"),
    }
  }

  /** Distinct tag values / folder names over the visible rows of the KB. */
  private listFacets(query: DocumentCatalogQuery, kind: "tags" | "folder"): string[] {
    const conditions = ["d.tenant_id = ?", "d.knowledge_base_id = ?"]
    const params: Array<string | number> = [query.tenantId, query.knowledgeBaseId]
    if (!query.admin) {
      const groups = query.viewerGroups ?? []
      if (groups.length > 0) {
        conditions.push(
          `(d.allowed_groups = '[]' OR EXISTS (
             SELECT 1 FROM json_each(d.allowed_groups) ag
             WHERE ag.value IN (${groups.map(() => "?").join(", ")})))`
        )
        params.push(...groups)
      }
    }
    const expr =
      kind === "tags"
        ? "je.value"
        : "json_extract(d.metadata, '$.folder')"
    const rows = this.db
      .prepare(
        kind === "tags"
          ? `SELECT DISTINCT ${expr} AS v
             FROM documents d, json_each(d.metadata, '$.tags') je
             WHERE ${conditions.join(" AND ")} ORDER BY v ASC`
          : `SELECT DISTINCT ${expr} AS v
             FROM documents d
             WHERE ${conditions.join(" AND ")}
               AND json_extract(d.metadata, '$.folder') IS NOT NULL
               AND json_extract(d.metadata, '$.folder') != ''
             ORDER BY v ASC`
      )
      .all(...params) as Array<{ v: unknown }>
    return rows.map((row) => row.v).filter((v): v is string => typeof v === "string")
  }
}
