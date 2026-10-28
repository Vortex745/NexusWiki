/**
 * Ticket 22 (ATT-01) — temporary, session-isolated attachments.
 *
 * What this module owns:
 *
 * 1. LIMITS. Up to five live attachments per session, 20 MB each and 50 MB
 *    in total. Every file is reported on individually (accepted / rejected
 *    with a typed reason), so a batch never fails as a whole because one
 *    file is too big.
 * 2. PARSING. Every format the import accepts is accepted here too. Plain
 *    text is decoded in-process with the SAME chunker the ingestion pipeline
 *    uses; binary documents (PDF/images/Office/…) run through the SAME parser
 *    routes the import pipeline selects, in the background, because those
 *    parsers need external executables or the OCR API and an upload must not
 *    hang on them. Promotion is where the full ingestion pipeline runs.
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
import { selectParserRoute, SUPPORTED_DOCUMENT_EXTENSIONS } from "../ingestion/parser"
import {
  createConfiguredParser,
  createIngestionLifecycle,
  type ParserResolver,
} from "../ingestion/pipeline"
import {
  SameNameIntentRequiredError,
  type IngestionLifecycle,
  type IngestionSubmission,
} from "../ingestion/lifecycle"
import type { Document, RetrievalResult } from "../types"
import type { AttachmentSearchOperations, AttachmentSearchRequest } from "../types/retrieval"
import {
  SqliteSessionAttachmentStore,
  type SessionAttachment,
} from "./session_attachment_store"

export const MAX_ATTACHMENTS_PER_SESSION = 5
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_SESSION_ATTACHMENT_BYTES = 50 * 1024 * 1024

/**
 * The composer accepts exactly what the import accepts — the router's own
 * format list. `.txt/.md/.markdown/.json/.csv` keep an in-process text decode;
 * every other extension is extracted by the import parser route.
 */
export const SUPPORTED_ATTACHMENT_EXTENSIONS = SUPPORTED_DOCUMENT_EXTENSIONS

/** Formats decoded in-process; everything else needs the import parsers. */
const DECODED_TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".json", ".csv"])

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
  /** Same parser override contract as the import API (`x-parser`). */
  parserOverride?: string
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
  /** Test/assembly seam: the SAME parser factory the import pipeline uses. */
  parserFor?: ParserResolver
  now?: () => Date
}

export class SessionAttachmentService implements AttachmentSearchOperations {
  private readonly store: SqliteSessionAttachmentStore
  private readonly lifecycle: IngestionLifecycle
  private readonly parserFor: ParserResolver
  private readonly now: () => Date
  /** Serializes limit accounting across concurrent uploads (one process). */
  private submitQueue: Promise<void> = Promise.resolve()

  constructor(db: DB, options: SessionAttachmentServiceOptions = {}) {
    this.store = new SqliteSessionAttachmentStore(db)
    this.lifecycle = options.lifecycle ?? createIngestionLifecycle(db)
    this.parserFor = options.parserFor ?? createConfiguredParser
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
    // Limits are accounted from what the session already holds, so two
    // concurrent uploads must not both read the same base. This process owns
    // the database file, so an in-process queue is the whole story.
    const run = this.submitQueue.then(() => this.submitSerialized(sessionId, tenantId, subjectId, files))
    this.submitQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async submitSerialized(
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
      const id = `att-${randomUUID()}`
      this.store.insert({
        id,
        sessionId,
        tenantId,
        subjectId,
        name: file.name,
        mimeType: file.mimeType ?? null,
        bytes: file.content.length,
        // The text lands once extraction finishes; the row is observable as
        // `parsing` from this insert on.
        content: "",
        // Ticket 21: keep the uploaded bytes so a promotion re-submits the
        // original file, not a re-encode of the decoded text.
        rawContent: file.content,
        now: this.now().toISOString(),
      })
      liveCount += 1
      liveBytes += file.content.length
      if (DECODED_TEXT_EXTENSIONS.has(extname(file.name).toLowerCase())) {
        // Text decodes in microseconds — awaiting keeps the ready row in the
        // upload response, as it always was.
        await this.runParse(id, sessionId, tenantId, subjectId, file.name, () => decodeText(file.content))
      } else {
        // Binary documents run through the import parsers (python/markitdown/
        // OCR): they must not hold the upload request open, so the row settles
        // in the background and the composer polls its status.
        void this.runParse(id, sessionId, tenantId, subjectId, file.name, () => this.extractText(file, id))
      }
      outcomes.push({
        name: file.name,
        ok: true,
        attachment: this.store.get(id, sessionId, tenantId, subjectId) as SessionAttachment,
      })
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
    // Ticket 21: the knowledge-base candidate is the UPLOADED file, byte for
    // byte — not a re-encoded decode of it. Only a legacy row (uploaded before
    // the original bytes were retained) falls back to the decoded text.
    const rawBytes = this.store.getRawContent(attachmentId, sessionId, tenantId, subjectId)

    const submission = this.lifecycle.submit({
      title: attachment.name,
      content,
      rawContent: rawBytes ?? Buffer.from(content, "utf8"),
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
        message: `${file.name}: unsupported file type; attachments accept the same document formats as import`,
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
   * Settle one accepted file. The row exists as "parsing" before the work
   * starts and is settled to "ready" or "failed", so a client polling the
   * session sees which file is being worked on and why one failed instead of
   * a silent gap in the list.
   */
  private async runParse(
    id: string,
    sessionId: string,
    tenantId: string,
    subjectId: string,
    name: string,
    extract: () => string | Promise<string>
  ): Promise<void> {
    try {
      const content = await extract()
      this.store.setContent(id, sessionId, tenantId, subjectId, content, this.now().toISOString())
      const chunks = await chunkText(id, name, content)
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
  }

  /**
   * The binary branch: the import router names the parser, the import parser
   * factory builds it, and its blocks become this attachment's text. The
   * route can refuse a type the picker allowed (unconfirmable/masquerading
   * bytes), so a refusal is reported on the row like any parse failure.
   */
  private async extractText(file: AttachmentFile, documentId: string): Promise<string> {
    const route = selectParserRoute({
      fileName: file.name,
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
      ...(file.parserOverride ? { override: file.parserOverride } : {}),
    })
    const blocks = await this.parserFor(route.candidates[0], route).parse({
      content: file.content,
      fileName: file.name,
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
      documentId,
    })
    const text = blocks.map((block) => block.text).join("\n\n")
    if (!text.trim()) {
      throw new Error(`${file.name}: the ${route.candidates[0]} parser produced no text`)
    }
    return text
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
  return chunks.filter((chunk) => chunk.metadata.kind !== "parent")
    .map((chunk, position) => ({ position, content: chunk.content }))
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
