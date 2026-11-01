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
 * The policy's acceptance of a passed gate, stored alongside (never inside)
 * the raw proofs. The content proof keeps its own pending_review fact; this
 * record only says which policy accepted which non-blocking warnings, against
 * which expected manifest.
 */
export interface ActivationAcceptance {
  policyVersion: string
  warningCodes: string[]
  expectedChunksSha256: string | null
  evaluatedAt: string
}

/**
 * Ticket 11 (DOC-01A): one catalog row — document metadata without content.
 * Tags/folder come from the metadata JSON (`$.tags` / `$.folder`).
 */
export interface DocumentCatalogEntry {
  docId: string
  /** Ticket 12 (DOC-01B): the owning source — retirement operates on it. */
  sourceId: string
  title: string
  source: string
  fileName: string | null
  mimeType: string | null
  status: string
  candidateState: string
  version: number
  active: boolean
  /** Why activation was denied (stable reason codes, ";"-joined); null when
   * the row is active, legacy, or was never evaluated. Lets the catalog tell
   * an integrity hold apart from a superseded version without a second read. */
  activationBlockReason: string | null
  tags: string[]
  folder: string | null
  /** Ticket 12 (DOC-01B): the owning source is retired — no operations. */
  retired: boolean
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
  /** Only rows the source's active pointer holds (true) — the usable content.
   * false asks for versions that are NOT active. Absent = every version. */
  active?: boolean
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

/**
 * The catalog's delete action retires the owning source. A retired document is
 * gone from the knowledge base, so it must stop being listed, counted, or
 * offered as a tag/folder facet — a facet only a deleted document carried
 * answers "no documents match" every time someone picks it.
 *
 * Written as NOT EXISTS(... = 'retired') rather than a join or a lifecycle
 * equality, for two reasons: the catalog LEFT JOINs sources, so a document
 * whose source row is missing has always read as live and this keeps that; and
 * the tag facet's `FROM documents d, json_each(...)` cannot take a trailing
 * LEFT JOIN without SQLite rebinding it to the table-valued function. It also
 * carries no parameter, so the same clause drops into all four catalog queries.
 */
const NOT_DELETED_BY_CATALOG =
  "NOT EXISTS (SELECT 1 FROM sources s WHERE s.source_id = d.source_id AND s.lifecycle_state = 'retired')"

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

  /**
   * Ticket UT-04: the source's most recent document regardless of activation.
   * While the joint activation gate keeps candidates inactive, the active
   * version alone can no longer anchor identity semantics (the "unchanged"
   * no-op and in-flight dedupe must reference the latest submission).
   */
  getLatestDocument(sourceId: string): Document | null {
    const row = this.db.prepare(
      `SELECT d.* FROM documents d WHERE d.source_id = ?
       ORDER BY d.version DESC LIMIT 1`
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

  /**
   * Ticket 13 (DOC-02): the operational fields the version view shows but the
   * domain Document type does not carry.
   */
  getOperationalState(docId: string): {
    status: string
    candidateState: string
    updatedAt: string
  } | null {
    const row = this.db.prepare(
      `SELECT status, candidate_state, updated_at FROM documents WHERE doc_id = ?`
    ).get(docId) as
      | { status: string; candidate_state: string; updated_at: string }
      | undefined
    return row
      ? { status: row.status, candidateState: row.candidate_state, updatedAt: row.updated_at }
      : null
  }

  /**
   * Ticket 12 (DOC-01B): the owning source's lifecycle state, for the
   * retry/reprocess precondition — retired sources must not be resurrected.
   */
  getSourceLifecycleState(sourceId: string): string | null {
    const row = this.db.prepare(
      `SELECT lifecycle_state FROM sources WHERE source_id = ?`
    ).get(sourceId) as { lifecycle_state: string } | undefined
    return row?.lifecycle_state ?? null
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

  /**
   * Ticket 21: the retained original bytes of a document, for the production
   * quality gate — the page evidence it audits must be a grounding of THESE
   * bytes, and the persisted envelope binds their hash. Null when the
   * submission carried no source bytes.
   */
  getRawContent(docId: string): Buffer | null {
    const row = this.db.prepare(
      `SELECT raw_content FROM documents WHERE doc_id = ?`
    ).get(docId) as { raw_content: Buffer | null } | undefined
    return row?.raw_content ?? null
  }

  // ---- Ticket UT-04: joint activation gate -------------------------------

  /**
   * Read the candidate's joint activation evidence
   * (documents.candidate_evidence, JSON). NULL when no integrity producer has
   * recorded evidence yet — which is the universal case until UT-15/UT-16
   * introduce them.
   */
  getCandidateEvidence(docId: string): unknown {
    const row = this.db.prepare(
      "SELECT candidate_evidence FROM documents WHERE doc_id = ?"
    ).get(docId) as { candidate_evidence: string | null } | undefined
    if (!row?.candidate_evidence) return null
    try {
      return JSON.parse(row.candidate_evidence)
    } catch {
      return null
    }
  }

  /**
   * Record the joint activation evidence for a candidate. Called by the
   * integrity producers (UT-15 content proof, UT-16 index proof).
   *
   * A producer write regenerates the proofs for THIS run, so any prior
   * activation acceptance is stale by definition and is dropped here — a new
   * product never inherits the old version's policy acceptance.
   */
  setCandidateEvidence(docId: string, evidence: Record<string, unknown>): void {
    const fresh = { ...evidence }
    delete fresh.activationAcceptance
    this.writeCandidateEvidence(docId, fresh)
  }

  /**
   * Record the policy's acceptance fact after the active pointer actually
   * moved to (or already pointed at) this version. Merges into the existing
   * evidence JSON; never rewrites contentProof/indexProof.
   */
  recordActivationAcceptance(
    docId: string,
    input: Omit<ActivationAcceptance, "expectedChunksSha256">
  ): void {
    const current = this.getCandidateEvidence(docId)
    if (current === null || typeof current !== "object" || Array.isArray(current)) return
    const record = current as Record<string, unknown>
    const contentProof = record.contentProof
    const bindings =
      contentProof !== null && typeof contentProof === "object" && !Array.isArray(contentProof)
        ? (contentProof as Record<string, unknown>).bindings
        : null
    const digest =
      bindings !== null && typeof bindings === "object" && !Array.isArray(bindings)
        ? (bindings as Record<string, unknown>).expectedChunksSha256
        : null
    this.writeCandidateEvidence(docId, {
      ...record,
      activationAcceptance: {
        policyVersion: input.policyVersion,
        warningCodes: [...input.warningCodes],
        expectedChunksSha256: typeof digest === "string" ? digest : null,
        evaluatedAt: input.evaluatedAt,
      } satisfies ActivationAcceptance,
    })
  }

  /** The recorded acceptance fact, or null for legacy/absent/unreadable rows. */
  getActivationAcceptance(docId: string): ActivationAcceptance | null {
    const evidence = this.getCandidateEvidence(docId)
    if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) return null
    const raw = (evidence as Record<string, unknown>).activationAcceptance
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null
    const record = raw as Record<string, unknown>
    if (
      typeof record.policyVersion !== "string" ||
      !Array.isArray(record.warningCodes) ||
      !record.warningCodes.every((code): code is string => typeof code === "string") ||
      typeof record.evaluatedAt !== "string"
    ) {
      return null
    }
    return {
      policyVersion: record.policyVersion,
      warningCodes: record.warningCodes,
      expectedChunksSha256:
        typeof record.expectedChunksSha256 === "string" ? record.expectedChunksSha256 : null,
      evaluatedAt: record.evaluatedAt,
    }
  }

  private writeCandidateEvidence(docId: string, evidence: Record<string, unknown>): void {
    this.db.prepare(
      `UPDATE documents SET candidate_evidence = ?, updated_at = ?
       WHERE doc_id = ?`
    ).run(JSON.stringify(evidence), new Date().toISOString(), docId)
  }

  /**
   * Record why activation was denied (stable reason codes joined by ";", from
   * evaluateActivationGate). The next attempt overwrites the previous reason;
   * a successful activation clears it.
   */
  recordActivationBlock(docId: string, reason: string): void {
    this.db.prepare(
      `UPDATE documents SET activation_block_reason = ?, updated_at = ?
       WHERE doc_id = ?`
    ).run(reason, new Date().toISOString(), docId)
  }

  clearActivationBlock(docId: string): void {
    this.db.prepare(
      `UPDATE documents SET activation_block_reason = NULL, updated_at = ?
       WHERE doc_id = ?`
    ).run(new Date().toISOString(), docId)
  }

  getActivationBlockReason(docId: string): string | null {
    const row = this.db.prepare(
      "SELECT activation_block_reason FROM documents WHERE doc_id = ?"
    ).get(docId) as { activation_block_reason: string | null } | undefined
    return row?.activation_block_reason ?? null
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

  /**
   * Ticket 38 (WIKI-01): the version history of one source, newest first,
   * each row flagged with whether it is the source's active version. The
   * Wiki revision history and restore path read this.
   */
  listVersionsBySource(sourceId: string): Array<{
    docId: string
    version: number
    title: string
    createdAt: Date
    active: boolean
  }> {
    const rows = this.db.prepare(
      `SELECT d.doc_id, d.version, d.title, d.created_at,
              s.active_doc_id = d.doc_id AS active
       FROM documents d
       JOIN sources s ON s.source_id = d.source_id
       WHERE d.source_id = ?
       ORDER BY d.version DESC`
    ).all(sourceId) as Array<{
      doc_id: string
      version: number
      title: string
      created_at: string
      active: number
    }>
    return rows.map((row) => ({
      docId: row.doc_id,
      version: row.version,
      title: row.title,
      createdAt: new Date(row.created_at),
      active: row.active === 1,
    }))
  }

  // Ticket 12 (DOC-01B): "pending" restores a requeued candidate so the
  // worker pipeline and the status surface agree.
  updateStatus(docId: string, status: "pending" | "completed" | "failed" | "cancelled"): void {
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
    const conditions: string[] = [
      "d.tenant_id = ?",
      "d.knowledge_base_id = ?",
      NOT_DELETED_BY_CATALOG,
    ]
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
    // The active filter is a correlated EXISTS (not the page query's LEFT
    // JOIN) so the COUNT query — which has no join — applies the same rule.
    if (query.active !== undefined) {
      const pointer = `EXISTS (SELECT 1 FROM sources active_src
        WHERE active_src.source_id = d.source_id
          AND active_src.active_doc_id = d.doc_id)`
      conditions.push(query.active ? pointer : `NOT ${pointer}`)
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
        `SELECT d.doc_id, d.source_id, d.title, d.source, d.file_name, d.mime_type, d.status,
                d.candidate_state, d.activation_block_reason, d.version, d.metadata,
                d.created_at, d.updated_at,
                (s.active_doc_id = d.doc_id) AS is_active, s.lifecycle_state
         FROM documents d
         LEFT JOIN sources s ON s.source_id = d.source_id
         WHERE ${where}
         ORDER BY d.created_at DESC, d.doc_id ASC
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, (page - 1) * pageSize) as Array<{
      doc_id: string
      source_id: string
      title: string
      source: string
      file_name: string | null
      mime_type: string | null
      status: string
      candidate_state: string
      activation_block_reason: string | null
      version: number
      metadata: string
      created_at: string
      updated_at: string
      is_active: number | null
      lifecycle_state: string | null
    }>
    const documents: DocumentCatalogEntry[] = rows.map((row) => {
      const metadata = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {}
      const tags = Array.isArray(metadata.tags)
        ? metadata.tags.filter((tag): tag is string => typeof tag === "string")
        : []
      return {
        docId: row.doc_id,
        sourceId: row.source_id,
        title: row.title,
        source: row.source,
        fileName: row.file_name,
        mimeType: row.mime_type,
        status: row.status,
        candidateState: row.candidate_state,
        version: row.version,
        active: row.is_active === 1,
        activationBlockReason: row.activation_block_reason,
        tags,
        folder: typeof metadata.folder === "string" && metadata.folder !== "" ? metadata.folder : null,
        retired: row.lifecycle_state === "retired",
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
    const conditions = ["d.tenant_id = ?", "d.knowledge_base_id = ?", NOT_DELETED_BY_CATALOG]
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

  /**
   * What one document folder holds inside a knowledge base: the catalog-visible
   * rows — so the number is the one the admin is looking at — and the distinct
   * sources behind them, which is what a cascade retirement actually moves.
   * Retired sources drop out through the same clause the catalog uses, so a
   * folder whose contents are already gone reads as empty instead of offering
   * them up a second time.
   */
  folderContents(
    knowledgeBaseId: string,
    tenantId: string,
    folderName: string
  ): { documents: number; sourceIds: string[] } {
    const rows = this.db
      .prepare(
        `SELECT d.doc_id, d.source_id
         FROM documents d
         WHERE d.tenant_id = ? AND d.knowledge_base_id = ?
           AND json_extract(d.metadata, '$.folder') = ?
           AND ${NOT_DELETED_BY_CATALOG}`
      )
      .all(tenantId, knowledgeBaseId, folderName) as Array<{ doc_id: string; source_id: string | null }>
    const sourceIds = [
      ...new Set(rows.map((row) => row.source_id).filter((id): id is string => Boolean(id))),
    ]
    return { documents: rows.length, sourceIds }
  }

  /**
   * Move every catalog row labelled `from` onto `to`. Membership is the folder's
   * NAME inside `documents.metadata`, so a folder rename has to rewrite its
   * members; the registry row itself is updated by the caller in the same
   * synchronous turn. Returns the rows rewritten.
   */
  renameFolderMembers(
    tenantId: string,
    knowledgeBaseId: string,
    from: string,
    to: string,
    updatedAt: string
  ): number {
    const result = this.db
      .prepare(
        `UPDATE documents
         SET metadata = json_set(metadata, '$.folder', ?), updated_at = ?
         WHERE tenant_id = ? AND knowledge_base_id = ?
           AND json_extract(metadata, '$.folder') = ?`
      )
      .run(to, updatedAt, tenantId, knowledgeBaseId, from)
    return result.changes
  }
}
