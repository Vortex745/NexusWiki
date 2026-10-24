/**
 * Ticket 22 (ATT-01) — session-scoped attachment storage.
 *
 * One table pair, owned by this module, protected by the (session_id,
 * tenant_id, subject_id) triple on EVERY read and write: another session's
 * attachment — even for the same user — is indistinguishable from an unknown
 * one (null / empty), exactly like the conversation history's ownership rule.
 *
 * Statuses: parsing → ready | failed; ready → promoted (explicit promotion)
 * or retired (session cleanup). A promoted attachment is never retired: its
 * knowledge-base copy must survive the session that produced it.
 */

import type { DB } from "../ingestion/tracking/db"

export type SessionAttachmentStatus = "parsing" | "ready" | "failed" | "promoted" | "retired"

export interface SessionAttachment {
  id: string
  sessionId: string
  tenantId: string
  subjectId: string
  name: string
  mimeType: string | null
  bytes: number
  status: SessionAttachmentStatus
  error: string | null
  promotedDocumentId: string | null
  promotedKnowledgeBaseId: string | null
  createdAt: string
  updatedAt: string
}

export interface SessionAttachmentChunk {
  attachmentId: string
  position: number
  content: string
}

interface AttachmentRow {
  id: string
  session_id: string
  tenant_id: string
  subject_id: string
  name: string
  mime_type: string | null
  bytes: number
  status: SessionAttachmentStatus
  error: string | null
  promoted_document_id: string | null
  promoted_knowledge_base_id: string | null
  created_at: string
  updated_at: string
}

function rowToAttachment(row: AttachmentRow): SessionAttachment {
  return {
    id: row.id,
    sessionId: row.session_id,
    tenantId: row.tenant_id,
    subjectId: row.subject_id,
    name: row.name,
    mimeType: row.mime_type,
    bytes: row.bytes,
    status: row.status,
    error: row.error,
    promotedDocumentId: row.promoted_document_id,
    promotedKnowledgeBaseId: row.promoted_knowledge_base_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class SqliteSessionAttachmentStore {
  constructor(private readonly db: DB) {}

  insert(record: {
    id: string
    sessionId: string
    tenantId: string
    subjectId: string
    name: string
    mimeType: string | null
    bytes: number
    content: string
    /** Ticket 21: the UPLOADED bytes, kept so promotion re-submits the original. */
    rawContent?: Buffer
    now: string
  }): void {
    this.db
      .prepare(
        `INSERT INTO session_attachments
           (id, session_id, tenant_id, subject_id, name, mime_type, bytes, status, content, raw_content,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'parsing', ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.sessionId,
        record.tenantId,
        record.subjectId,
        record.name,
        record.mimeType,
        record.bytes,
        record.content,
        record.rawContent ?? null,
        record.now,
        record.now
      )
  }

  /** Another session's or another user's attachment is the same null. */
  get(
    id: string,
    sessionId: string,
    tenantId: string,
    subjectId: string
  ): SessionAttachment | null {
    const row = this.db
      .prepare(
        `SELECT * FROM session_attachments
         WHERE id = ? AND session_id = ? AND tenant_id = ? AND subject_id = ?`
      )
      .get(id, sessionId, tenantId, subjectId) as AttachmentRow | undefined
    return row ? rowToAttachment(row) : null
  }

  /** The stored text of an owned attachment (promotion re-submits it). */
  getContent(
    id: string,
    sessionId: string,
    tenantId: string,
    subjectId: string
  ): string | null {
    const row = this.db
      .prepare(
        `SELECT content FROM session_attachments
         WHERE id = ? AND session_id = ? AND tenant_id = ? AND subject_id = ?`
      )
      .get(id, sessionId, tenantId, subjectId) as { content: string } | undefined
    return row?.content ?? null
  }

  /**
   * Ticket 21: the uploaded BYTES of an owned attachment — what promotion
   * submits so the knowledge-base candidate is the original file. NULL for
   * legacy rows uploaded before this column existed (those keep the decode).
   */
  getRawContent(
    id: string,
    sessionId: string,
    tenantId: string,
    subjectId: string
  ): Buffer | null {
    const row = this.db
      .prepare(
        `SELECT raw_content FROM session_attachments
         WHERE id = ? AND session_id = ? AND tenant_id = ? AND subject_id = ?`
      )
      .get(id, sessionId, tenantId, subjectId) as { raw_content: Buffer | null } | undefined
    return row?.raw_content ?? null
  }

  listForSession(sessionId: string, tenantId: string, subjectId: string): SessionAttachment[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM session_attachments
         WHERE session_id = ? AND tenant_id = ? AND subject_id = ?
         ORDER BY created_at ASC, id ASC`
      )
      .all(sessionId, tenantId, subjectId) as AttachmentRow[]
    return rows.map(rowToAttachment)
  }

  /**
   * Live attachments (parsing/ready) — the ones that count against the
   * session limits and can be retrieved. Retired and failed rows are kept
   * for honesty but never block a new upload.
   */
  listLive(sessionId: string, tenantId: string, subjectId: string): SessionAttachment[] {
    return this.listForSession(sessionId, tenantId, subjectId).filter(
      (attachment) => attachment.status === "parsing" || attachment.status === "ready"
    )
  }

  /**
   * Settle a row that is still `parsing`. The precondition is what keeps a
   * retired row dead: a parse that finishes after a removal must not resurrect
   * the attachment into the session's live set.
   */
  markStatus(
    id: string,
    sessionId: string,
    tenantId: string,
    subjectId: string,
    status: SessionAttachmentStatus,
    options: { error?: string | null; now: string }
  ): void {
    this.db
      .prepare(
        `UPDATE session_attachments SET status = ?, error = ?, updated_at = ?
         WHERE id = ? AND session_id = ? AND tenant_id = ? AND subject_id = ?
           AND status = 'parsing'`
      )
      .run(status, options.error ?? null, options.now, id, sessionId, tenantId, subjectId)
  }

  markPromoted(
    id: string,
    sessionId: string,
    tenantId: string,
    subjectId: string,
    promotion: { documentId: string; knowledgeBaseId: string; now: string }
  ): void {
    this.db
      .prepare(
        `UPDATE session_attachments
         SET status = 'promoted', promoted_document_id = ?, promoted_knowledge_base_id = ?, updated_at = ?
         WHERE id = ? AND session_id = ? AND tenant_id = ? AND subject_id = ?`
      )
      .run(
        promotion.documentId,
        promotion.knowledgeBaseId,
        promotion.now,
        id,
        sessionId,
        tenantId,
        subjectId
      )
  }

  /**
   * Session cleanup: retire the session's own UNPROMOTED attachments only.
   * Promoted rows keep their knowledge-base provenance and their status.
   * Nothing outside this session is ever touched.
   */
  retireUnpromoted(sessionId: string, tenantId: string, subjectId: string, now: string): number {
    const retire = this.db.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE session_attachments SET status = 'retired', content = '', raw_content = NULL, updated_at = ?
           WHERE session_id = ? AND tenant_id = ? AND subject_id = ?
             AND status IN ('parsing','ready','failed')`
        )
        .run(now, sessionId, tenantId, subjectId).changes
      // The text is the attachment: retiring it releases the bytes it held.
      this.db
        .prepare(
          `DELETE FROM session_attachment_chunks
           WHERE session_id = ? AND tenant_id = ?
             AND attachment_id IN (
               SELECT id FROM session_attachments
               WHERE session_id = ? AND tenant_id = ? AND subject_id = ? AND status = 'retired'
             )`
        )
        .run(sessionId, tenantId, sessionId, tenantId, subjectId)
      return changed
    })
    return retire()
  }

  /**
   * Retire ONE attachment. A promoted row keeps its status: its knowledge-base
   * document must survive the session, so it can never be removed here.
   */
  retireOne(
    id: string,
    sessionId: string,
    tenantId: string,
    subjectId: string,
    now: string
  ): number {
    const retire = this.db.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE session_attachments SET status = 'retired', content = '', raw_content = NULL, updated_at = ?
           WHERE id = ? AND session_id = ? AND tenant_id = ? AND subject_id = ?
             AND status IN ('parsing','ready','failed')`
        )
        .run(now, id, sessionId, tenantId, subjectId).changes
      if (changed > 0) {
        this.db
          .prepare(
            `DELETE FROM session_attachment_chunks
             WHERE attachment_id = ? AND session_id = ? AND tenant_id = ?`
          )
          .run(id, sessionId, tenantId)
      }
      return changed
    })
    return retire()
  }

  saveChunks(
    attachmentId: string,
    sessionId: string,
    tenantId: string,
    chunks: Array<{ position: number; content: string }>
  ): void {
    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM session_attachment_chunks
           WHERE attachment_id = ? AND session_id = ? AND tenant_id = ?`
        )
        .run(attachmentId, sessionId, tenantId)
      const insert = this.db.prepare(
        `INSERT INTO session_attachment_chunks (attachment_id, session_id, tenant_id, position, content)
         VALUES (?, ?, ?, ?, ?)`
      )
      for (const chunk of chunks) {
        insert.run(attachmentId, sessionId, tenantId, chunk.position, chunk.content)
      }
    })
    write()
  }

  /** Chunks of the given session (or of the given attachments of it) only. */
  listChunks(
    sessionId: string,
    tenantId: string,
    subjectId: string,
    attachmentIds?: readonly string[]
  ): SessionAttachmentChunk[] {
    const owned = this.listForSession(sessionId, tenantId, subjectId)
      .map((attachment) => attachment.id)
    if (owned.length === 0) return []
    const wanted = attachmentIds
      ? owned.filter((id) => attachmentIds.includes(id))
      : owned
    if (wanted.length === 0) return []
    const placeholders = wanted.map(() => "?").join(", ")
    const rows = this.db
      .prepare(
        `SELECT attachment_id, position, content FROM session_attachment_chunks
         WHERE session_id = ? AND tenant_id = ? AND attachment_id IN (${placeholders})
         ORDER BY attachment_id ASC, position ASC`
      )
      .all(sessionId, tenantId, ...wanted) as Array<{
        attachment_id: string
        position: number
        content: string
      }>
    return rows.map((row) => ({
      attachmentId: row.attachment_id,
      position: row.position,
      content: row.content,
    }))
  }
}
