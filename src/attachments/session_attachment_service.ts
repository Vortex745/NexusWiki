/**
 * Ticket 22 (ATT-01) — temporary, session-isolated attachments.
 *
 * What this module owns:
 *
 * 1. LIMITS. Up to five live attachments per session, 20 MB each and 50 MB
 *    in total. Every file is reported on individually (accepted / rejected
 *    with a typed reason), so a batch never fails as a whole because one
 *    file is too big.
 * 2. PARSING. Supported text documents are decoded and chunked in-process
 *    with the SAME chunker the ingestion pipeline uses. Binary parser routes
 *    (marker/mineru/markitdown) stay out of the chat path: they need external
 *    executables, and an attachment is a temporary convenience, not an
 *    import. Promotion is where the full ingestion pipeline runs.
 * 3. ISOLATION. Every read and write is scoped to the exact
 *    (sessionId, tenantId, subjectId) triple. A session can only ever
 *    retrieve and cite its OWN attachments.
 * 4. PROMOTION. Explicit, authorized and on the normal ingestion rules: the
 *    stored text is re-submitted through `IngestionLifecycle.submit`, so
 *    source identity, versioning and the same-name intent rule are exactly
 *    the ones every other import obeys. Cleanup retires only this session's
 *    unpromoted rows and never touches a promoted document.
 */

import { randomUUID } from "node:crypto"
import { extname } from "node:path"

import type { DB } from "../ingestion/tracking/db"
import { RecursiveChunker } from "../ingestion/chunker/chunker"
import {
  SameNameIntentRequiredError,
  type IngestionLifecycle,
  type IngestionSubmission,
} from "../ingestion/lifecycle"
import { createIngestionLifecycle } from "../ingestion/pipeline"
import type { Document, RetrievalResult } from "../types"
import type { AttachmentSearchOperations, AttachmentSearchRequest } from "../types/retrieval"
import {
  SqliteSessionAttachmentStore,
  type SessionAttachment,
} from "./session_attachment_store"

export const MAX_ATTACHMENTS_PER_SESSION = 5
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_SESSION_ATTACHMENT_BYTES = 50 * 1024 * 1024

/** The supported set is the composer's historical one: text-like documents. */
export const SUPPORTED_ATTACHMENT_EXTENSIONS = [".txt", ".md", ".markdown", ".json", ".csv"] as const

/** The channel asks for the same top-k the knowledge channels use. */
const ATTACHMENT_TOP_K = 20

export type AttachmentRejectionKind =
  | "count"
  | "file_size"
  | "session_size"
  | "unsupported_type"
  | "empty"

export interface AttachmentFile {
  name: string
  mimeType?: string
  content: Buffer
}

export type AttachmentSubmitOutcome =
  | { name: string; ok: true; attachment: SessionAttachment }
  | { name: string; ok: false; error: { kind: AttachmentRejectionKind; message: string } }

export interface AttachmentPromotionResult {
  attachment: SessionAttachment
  submission: IngestionSubmission
}

export class SessionAttachmentNotFoundError extends Error {
  constructor(message = "attachment not found") {
    super(message)
    this.name = "SessionAttachmentNotFoundError"
  }
}

export class AttachmentNotPromotableError extends Error {
  constructor(readonly status: string) {
    super(`attachment in status "${status}" cannot be promoted`)
    this.name = "AttachmentNotPromotableError"
  }
}

export interface SessionAttachmentServiceOptions {
  /** Test/assembly seam: the SAME ingestion lifecycle the import path uses. */
  lifecycle?: IngestionLifecycle
  now?: () => Date
}

export class SessionAttachmentService implements AttachmentSearchOperations {
  private readonly store: SqliteSessionAttachmentStore
  private readonly lifecycle: IngestionLifecycle
  private readonly now: () => Date

  constructor(db: DB, options: SessionAttachmentServiceOptions = {}) {
    this.store = new SqliteSessionAttachmentStore(db)
    this.lifecycle = options.lifecycle ?? createIngestionLifecycle(db)
    this.now = options.now ?? (() => new Date())
  }

  /**
   * Accept a batch of files for one session. Each file gets its own outcome:
   * a rejected file never hides the files that were accepted, and an accepted
   * file never hides a rejected one. Limits are checked against the files
   * that are ALREADY live in the session, so a second upload cannot exceed
   * five files or fifty megabytes in total.
   */
  async submit(
    sessionId: string,
    tenantId: string,
    subjectId: string,
    files: readonly AttachmentFile[]
  ): Promise<AttachmentSubmitOutcome[]> {
    const outcomes: AttachmentSubmitOutcome[] = []
    const live = this.store.listLive(sessionId, tenantId, subjectId)
    let liveCount = live.length
    let liveBytes = live.reduce((sum, attachment) => sum + attachment.bytes, 0)

    for (const file of files) {
      const rejection = this.reject(file, liveCount, liveBytes)
      if (rejection) {
        outcomes.push({ name: file.name, ok: false, error: rejection })
        continue
      }
      const attachment = await this.parseOne(sessionId, tenantId, subjectId, file)
      outcomes.push({ name: file.name, ok: true, attachment })
      if (attachment.status !== "failed") {
        liveCount += 1
        liveBytes += attachment.bytes
      }
    }
    return outcomes
  }

  list(sessionId: string, tenantId: string, subjectId: string): SessionAttachment[] {
    return this.store.listForSession(sessionId, tenantId, subjectId)
  }

  /** A session's attachment, or the same null an unknown one returns. */
  get(attachmentId: string, sessionId: string, tenantId: string, subjectId: string): SessionAttachment | null {
    return this.store.get(attachmentId, sessionId, tenantId, subjectId)
  }

  /**
   * The attachment channel of one retrieval call. Only this session's READY
   * attachments are searched — a retired, failed or promoted-away row cannot
   * leak, and neither can another session's.
   */
  async search(request: AttachmentSearchRequest): Promise<RetrievalResult[]> {
    const { sessionId, tenantId, subjectId, query, limit } = request
    const ready = this.store
      .listLive(sessionId, tenantId, subjectId)
      .filter((attachment) => attachment.status === "ready")
    if (ready.length === 0) return []
    const tokens = tokenize(query)
    if (tokens.length === 0) return []
    const names = new Map(ready.map((attachment) => [attachment.id, attachment.name]))
    const chunks = this.store.listChunks(
      sessionId,
      tenantId,
      subjectId,
      ready.map((attachment) => attachment.id)
    )
    const scored = chunks
      .map((chunk) => ({ chunk, score: scoreChunk(chunk.content, tokens) }))
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.chunk.attachmentId.localeCompare(right.chunk.attachmentId) ||
          left.chunk.position - right.chunk.position
      )
      .slice(0, Math.max(0, Math.min(limit, ATTACHMENT_TOP_K)))

    return scored.map(({ chunk, score }) => ({
      chunk: {
        id: `${chunk.attachmentId}:${chunk.position}`,
        documentId: chunk.attachmentId,
        content: chunk.content,
        childrenIds: [],
        metadata: {
          origin: "attachment",
          attachmentId: chunk.attachmentId,
          attachmentName: names.get(chunk.attachmentId) ?? "附件",
          attachmentSessionId: sessionId,
          title: names.get(chunk.attachmentId) ?? "附件",
          source: `附件:${names.get(chunk.attachmentId) ?? "附件"}`,
        },
        tenantId,
      },
      score,
      source: "attachment",
      channels: ["attachment"],
      wikilinks: [],
    }))
  }

  /**
   * Explicit promotion into an authorized knowledge base. The target base is
   * the caller's responsibility (the route resolves and authorizes it); this
   * service only guarantees the NORMAL ingestion rules: same source identity
   * + different content without an explicit version intent is the same 409
   * `SameNameIntentRequiredError` every other import raises, and the version
   * numbers come from the same lifecycle.
   */
  promote(
    attachmentId: string,
    sessionId: string,
    tenantId: string,
    subjectId: string,
    target: { knowledgeBaseId: string; versionIntent?: "new_version" | "new_document" },
    actorId: string
  ): AttachmentPromotionResult {
    const attachment = this.store.get(attachmentId, sessionId, tenantId, subjectId)
    if (!attachment) throw new SessionAttachmentNotFoundError()
    if (attachment.status !== "ready") throw new AttachmentNotPromotableError(attachment.status)
    const content = this.store.getContent(attachmentId, sessionId, tenantId, subjectId) ?? ""

    const submission = this.lifecycle.submit({
      title: attachment.name,
      content,
      rawContent: Buffer.from(content, "utf8"),
      fileName: attachment.name,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      knowledgeBaseId: target.knowledgeBaseId,
      ...(target.versionIntent ? { versionIntent: target.versionIntent } : {}),
      // The identity is the session plus the file NAME: the same name with
      // different content inside one session is the same source, which is
      // exactly what makes the normal same-name/version rules apply.
      sourceIdentity: {
        kind: "attachment",
        uriOrExternalId: `${sessionId}:${attachment.name}`,
        namespace: "session-attachment",
        tenantId,
      },
      metadata: {
        attachmentId: attachment.id,
        sessionId,
        promotedBy: actorId,
      },
    })
    this.store.markPromoted(attachment.id, sessionId, tenantId, subjectId, {
      documentId: submission.docId,
      knowledgeBaseId: submission.knowledgeBaseId,
      now: this.now().toISOString(),
    })
    return {
      attachment: this.store.get(attachment.id, sessionId, tenantId, subjectId) as SessionAttachment,
      submission,
    }
  }

  /**
   * Drop ONE attachment of this session. Explicit and one-way: a promoted
   * attachment belongs to a knowledge base now and is refused here.
   */
  remove(attachmentId: string, sessionId: string, tenantId: string, subjectId: string): void {
    const attachment = this.store.get(attachmentId, sessionId, tenantId, subjectId)
    if (!attachment) throw new SessionAttachmentNotFoundError()
    if (attachment.status === "promoted") throw new AttachmentNotPromotableError(attachment.status)
    this.store.retireOne(attachmentId, sessionId, tenantId, subjectId, this.now().toISOString())
  }

  /**
   * Session cleanup. It retires this session's own unpromoted attachments and
   * nothing else: a promoted attachment became a knowledge-base document and
   * must outlive the session, and no other session's or source's rows are
   * part of this operation at all.
   */
  retire(sessionId: string, tenantId: string, subjectId: string): { retired: number; kept: number } {
    const before = this.store.listForSession(sessionId, tenantId, subjectId)
    const retired = this.store.retireUnpromoted(sessionId, tenantId, subjectId, this.now().toISOString())
    return {
      retired,
      kept: before.filter((attachment) => attachment.status === "promoted").length,
    }
  }

  private reject(
    file: AttachmentFile,
    liveCount: number,
    liveBytes: number
  ): { kind: AttachmentRejectionKind; message: string } | null {
    const extension = extname(file.name).toLowerCase()
    if (!(SUPPORTED_ATTACHMENT_EXTENSIONS as readonly string[]).includes(extension)) {
      return {
        kind: "unsupported_type",
        message: `${file.name}: supported attachment types are ${SUPPORTED_ATTACHMENT_EXTENSIONS.join(", ")}`,
      }
    }
    if (file.content.length === 0) {
      return { kind: "empty", message: `${file.name}: the file is empty` }
    }
    if (file.content.length > MAX_ATTACHMENT_BYTES) {
      return {
        kind: "file_size",
        message: `${file.name}: exceeds the ${MAX_ATTACHMENT_BYTES} byte per-file limit`,
      }
    }
    if (liveCount >= MAX_ATTACHMENTS_PER_SESSION) {
      return {
        kind: "count",
        message: `this session already holds ${MAX_ATTACHMENTS_PER_SESSION} live attachments`,
      }
    }
    if (liveBytes + file.content.length > MAX_SESSION_ATTACHMENT_BYTES) {
      return {
        kind: "session_size",
        message: `adding ${file.name} would exceed the ${MAX_SESSION_ATTACHMENT_BYTES} byte session limit`,
      }
    }
    return null
  }

  /**
   * Parse one accepted file. The row exists as "parsing" before the work
   * starts and is settled to "ready" or "failed", so a client polling the
   * session sees which file is being worked on and why one failed instead of
   * a silent gap in the list.
   */
  private async parseOne(
    sessionId: string,
    tenantId: string,
    subjectId: string,
    file: AttachmentFile
  ): Promise<SessionAttachment> {
    const id = `att-${randomUUID()}`
    const content = decodeText(file.content)
    this.store.insert({
      id,
      sessionId,
      tenantId,
      subjectId,
      name: file.name,
      mimeType: file.mimeType ?? null,
      bytes: file.content.length,
      content,
      now: this.now().toISOString(),
    })
    try {
      const chunks = await chunkText(id, file.name, content)
      this.store.saveChunks(id, sessionId, tenantId, chunks)
      this.store.markStatus(id, sessionId, tenantId, subjectId, "ready", {
        now: this.now().toISOString(),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.store.markStatus(id, sessionId, tenantId, subjectId, "failed", {
        // Bounded and single-line: a parse failure is reported, not dumped.
        error: message.replace(/\s+/g, " ").slice(0, 300),
        now: this.now().toISOString(),
      })
    }
    return this.store.get(id, sessionId, tenantId, subjectId) as SessionAttachment
  }
}

export function createSessionAttachmentService(
  db: DB,
  options?: SessionAttachmentServiceOptions
): SessionAttachmentService {
  return new SessionAttachmentService(db, options)
}

function decodeText(content: Buffer): string {
  return content.toString("utf8").replace(/^\uFEFF/, "")
}

async function chunkText(
  attachmentId: string,
  name: string,
  content: string
): Promise<Array<{ position: number; content: string }>> {
  const document: Document = {
    id: attachmentId,
    sourceId: attachmentId,
    contentHash: "",
    version: 1,
    title: name,
    source: `附件:${name}`,
    content,
    metadata: { origin: "attachment", attachmentName: name },
    createdAt: new Date(0),
  }
  const chunks = await new RecursiveChunker().chunk(document)
  return chunks.map((chunk, position) => ({ position, content: chunk.content }))
}

function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((token) => token.length >= 2)
    ),
  ]
}

/**
 * Deterministic in-process overlap score (distinct query tokens found). This
 * is the attachment channel's own ranker — it does not pretend to be BM25 and
 * never runs when the session has no live attachments.
 */
function scoreChunk(content: string, tokens: readonly string[]): number {
  if (tokens.length === 0) return 0
  const haystack = content.toLowerCase()
  let hits = 0
  for (const token of tokens) {
    if (haystack.includes(token)) hits += 1
  }
  return hits / tokens.length
}

/** Re-exported so routes can map the same-name conflict without importing the lifecycle. */
export { SameNameIntentRequiredError }
