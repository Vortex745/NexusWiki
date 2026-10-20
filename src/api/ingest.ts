import express, { Request, Response, Router } from "express"
import type { NextFunction } from "express"
import { randomUUID } from "node:crypto"
import { singleTenantAccessContext, type AccessContext } from "../access/context"
import { loadConfig } from "../config"
import { decodeUtf8HeaderValue } from "./header_encoding"
import { createIngestionLifecycle } from "../ingestion/pipeline"
import { taskTraceFromScope, type TaskTraceContext } from "../tracing/contract"
import { requestScope } from "../tracing/express"
import { detectTypeConflict } from "../ingestion/admission"
import { selectParserRoute } from "../ingestion/parser"
import type { SourceIdentityInput } from "../ingestion/source_identity"
import { openDb } from "../ingestion/tracking"
import type { DB } from "../ingestion/tracking/db"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import {
  SameNameIntentRequiredError,
} from "../ingestion/lifecycle"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import {
  DOCUMENT_FOLDER_ID_PREFIX,
  InvalidDocumentFolderCommandError,
  createDocumentFolderService,
} from "../knowledge/document_folder_service"
import {
  InvalidKnowledgeBaseScopeError,
  KnowledgeBaseArchivedError,
  KnowledgeBaseNotFoundError,
  KnowledgeBaseServiceImpl,
} from "../knowledge/knowledge_base_service"
import { knowledgeBaseEmbeddingProfile } from "../types/knowledge_base"
import {
  fetchSingleUrl,
  fetchSitemapUrls,
  SITEMAP_DEFAULT_MAX_PAGES,
  SITEMAP_HARD_MAX_PAGES,
  UrlPolicyDenyError,
} from "../ingestion/url_fetcher"

interface IngestRequestBody {
  title?: string
  content?: string
  source?: string
  sourceIdentity?: {
    kind: string
    uriOrExternalId: string
    namespace?: string
  }
  /**
   * Ticket 03 (KB-02A): the owning knowledge base. Omitted → tenant default.
   * `unknown` because this is untrusted JSON: the resolver validates the type
   * instead of trusting the cast.
   */
  knowledgeBaseId?: unknown
  /**
   * Ticket 11 (DOC-01A): catalog metadata. Tags are a string array, folder a
   * one-level name; both validated by parseCatalogMetadata before use.
   */
  tags?: unknown
  folder?: unknown
  /**
   * Ticket 12 (DOC-01B): explicit intent required when the source already
   * exists with different content ("new_version" | "new_document").
   */
  versionIntent?: unknown
}

interface IngestUrlRequestBody {
  url?: string
  mode?: "single" | "sitemap"
  title?: string
  parserOverride?: "markitdown" | "marker" | "mineru" | "builtin-pdf"
  maxPages?: number
  /**
   * Ticket 04 (KB-02B): the owning knowledge base, same contract as `/ingest`
   * and `/ingest/file`. Omitted → tenant default. `unknown` because this is
   * untrusted JSON: the resolver validates the type instead of trusting it.
   */
  knowledgeBaseId?: unknown
  /** Ticket 11 (DOC-01A): same catalog metadata contract as `/ingest`. */
  tags?: unknown
  folder?: unknown
  /** Ticket 12 (DOC-01B): same intent contract as `/ingest`. */
  versionIntent?: unknown
}

const router = Router()

/**
 * LO-13: the request's neutral handoff. Captured HERE, where the request scope
 * is explicit; the persisted task carries only ids, so the worker never reads
 * a global or trusts a client header.
 */
function submissionTrace(res: Response): TaskTraceContext | undefined {
  return taskTraceFromScope(requestScope(res))
}

export const rawIngestRouter = Router()

const RAW_FILE_LIMIT = "20mb"
const PARSER_TYPES = new Set(["markitdown", "marker", "mineru", "builtin-pdf"])
const URL_FETCH_TIMEOUT_MS = 30_000
const URL_FETCH_MAX_BYTES = 20 * 1024 * 1024 // 20MB，与单文件上传上限一致

function trustedSourceIdentity(
  res: Response,
  sourceIdentity: Omit<SourceIdentityInput, "tenantId" | "allowedGroups">
): SourceIdentityInput {
  const accessContext =
    (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
  return {
    ...sourceIdentity,
    tenantId: accessContext.tenantId,
    // Ticket 10 (KB-05B): an import by a caller holding the admin scope is
    // TENANT-WIDE. The administrator curates knowledge for the whole tenant —
    // stamping their own groups onto the content made every import
    // admin-private and left reader accounts with no evidence at all (found
    // by the KB-05B live acceptance). Group-restricted knowledge is an
    // assistant-level concern (the approved plan gives assistants an
    // allowedGroups field), never a side effect of who happened to run the
    // import; non-admin importers keep their own groups.
    allowedGroups: accessContext.scopes.includes("admin")
      ? []
      : [...accessContext.groups],
  }
}

function requestSourceIdentity(body: IngestRequestBody): Omit<SourceIdentityInput, "tenantId" | "allowedGroups"> {
  if (body.sourceIdentity) return body.sourceIdentity
  const source = body.source?.trim()
  if (!source || source === "api") {
    const id = randomUUID()
    return { kind: "submission", uriOrExternalId: id, namespace: id }
  }
  return /^https?:\/\//i.test(source)
    ? { kind: "url", uriOrExternalId: source }
    : { kind: "legacy", uriOrExternalId: source }
}

type KnowledgeBaseResolution =
  | { ok: true; knowledgeBaseId: string }
  | {
      ok: false
      status: number
      body: { error: string } & Record<string, unknown>
    }

/**
 * Ticket 11 (DOC-01A): validate the optional catalog metadata an import may
 * carry. Tags: array of non-empty strings (≤ 20, each ≤ 64 chars). Folder: see
 * {@link resolveDocumentFolder}. Absent/empty fields contribute nothing to the
 * document metadata.
 */
function parseCatalogMetadata(
  res: Response,
  db: DB,
  knowledgeBaseId: string,
  tags: unknown,
  folder: unknown
): { ok: true; metadata?: Record<string, unknown> } | { ok: false; error: string } {
  let cleanTags: string[] | undefined
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
      return { ok: false, error: "tags must be an array of strings" }
    }
    cleanTags = [...new Set((tags as string[]).map((tag) => tag.trim()).filter(Boolean))]
    if (cleanTags.length > 20 || cleanTags.some((tag) => tag.length > 64)) {
      return { ok: false, error: "tags must have at most 20 values of 64 characters" }
    }
  }
  const resolvedFolder = resolveDocumentFolder(res, db, knowledgeBaseId, folder)
  if (!resolvedFolder.ok) return { ok: false, error: resolvedFolder.error }
  const metadata: Record<string, unknown> = {}
  if (cleanTags?.length) metadata.tags = cleanTags
  if (resolvedFolder.name) metadata.folder = resolvedFolder.name
  return Object.keys(metadata).length > 0 ? { ok: true, metadata } : { ok: true }
}

/**
 * Turn the caller's `folder` into the name stored on the document, registering
 * the directory if it does not exist yet — so "create a folder and upload into
 * it" is one request rather than two.
 *
 * The caller may send either a registry id (`docf-…`, what the import dialog
 * picks from the list) or a plain name (what it types). Either way the document
 * keeps storing the NAME, because that is what the catalog filter and the folder
 * facets already read; the registry row is what makes an empty directory real.
 */
function resolveDocumentFolder(
  res: Response,
  db: DB,
  knowledgeBaseId: string,
  folder: unknown
): { ok: true; name?: string } | { ok: false; error: string } {
  if (folder === undefined || folder === null) return { ok: true }
  if (typeof folder !== "string") return { ok: false, error: "folder must be a string" }
  const value = folder.trim()
  if (value === "") return { ok: true }
  const accessContext =
    (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
  const folders = createDocumentFolderService(db)
  if (value.startsWith(DOCUMENT_FOLDER_ID_PREFIX)) {
    const existing = folders.getById(value, accessContext.tenantId)
    if (!existing) return { ok: false, error: "document folder not found" }
    return { ok: true, name: existing.name }
  }
  try {
    return { ok: true, name: folders.create(accessContext.tenantId, knowledgeBaseId, value).name }
  } catch (error) {
    if (error instanceof InvalidDocumentFolderCommandError) {
      return { ok: false, error: error.message }
    }
    throw error
  }
}

/**
 * Ticket 12 (DOC-01B): validate the optional version intent. Absent → the
 * submit-time guard decides whether one is required (→ 409).
 */
function parseVersionIntent(
  versionIntent: unknown
): { ok: true; intent?: "new_version" | "new_document" } | { ok: false; error: string } {
  if (versionIntent === undefined || versionIntent === null) return { ok: true }
  if (versionIntent === "new_version" || versionIntent === "new_document") {
    return { ok: true, intent: versionIntent }
  }
  return { ok: false, error: "versionIntent must be new_version or new_document" }
}

/** Ticket 12 (DOC-01B): map the submit-time intent guard to a 409 response. */
function sameNameConflict(error: unknown): { status: 409; body: Record<string, unknown> } | null {
  if (!(error instanceof SameNameIntentRequiredError)) return null
  return {
    status: 409,
    body: {
      error: error.message,
      activeDocId: error.activeDocId,
      activeVersion: error.activeVersion,
    },
  }
}

/**
 * Ticket 12 (DOC-01B): the document-operate routes are tenant-scoped — a doc
 * id that does not exist OR belongs to another tenant is the same 404 (this
 * closes the long-standing IDOR noted on /status and /cancel in tickets 07/04).
 */
function ownedDocumentOrNotFound(
  res: Response,
  db: DB,
  docId: string
): ReturnType<DocumentRepo["get"]> {
  const context =
    (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
  const document = new DocumentRepo(db).get(docId)
  if (!document || (document.tenantId ?? "default") !== context.tenantId) {
    res.status(404).json({ error: "document not found" })
    return null
  }
  return document
}

/** Ticket 12 (DOC-01B): retry/reprocess are administrator operations. */
function requireAdminScope(res: Response): AccessContext | null {
  const context =
    (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
  if (!context.scopes.includes("admin")) {
    res.status(403).json({ error: "admin scope required" })
    return null
  }
  return context
}

/**
 * Ticket 03 (KB-02A): resolve EXACTLY ONE authorized knowledge base for an
 * import. An absent field resolves to the tenant's deterministic default
 * knowledge base; an unknown or cross-tenant id is a 404 and a malformed one
 * (blank, or not a string at all) a 400 — never a silent widening to "all
 * knowledge bases" and never a silent fallback to the default.
 */
function resolveRequestKnowledgeBaseId(
  res: Response,
  db: DB,
  requested: unknown
): KnowledgeBaseResolution {
  const accessContext =
    (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
  let scope: readonly string[] | undefined
  if (requested === undefined) {
    scope = undefined
  } else if (typeof requested === "string") {
    scope = [requested.trim()]
  } else {
    // A non-string field (e.g. a number in the JSON body) is malformed input,
    // not an absent field: treating it as absent would silently file the
    // import under the default knowledge base.
    return {
      ok: false,
      status: 400,
      body: { error: "knowledgeBaseId must be a non-empty string" },
    }
  }
  try {
    const cfg = loadConfig()
    const currentProfile = knowledgeBaseEmbeddingProfile(
      cfg.embeddingModel,
      cfg.embeddingDimensions
    )
    const service = new KnowledgeBaseServiceImpl(
      new SqliteKnowledgeBaseRepo(db),
      currentProfile
    )
    const { knowledgeBaseIds } = service.resolveScope(accessContext.tenantId, scope)
    const [knowledgeBaseId] = knowledgeBaseIds
    if (!knowledgeBaseId) {
      throw new InvalidKnowledgeBaseScopeError("a knowledge base is required")
    }
    // Ticket 17 (MODEL-01B): a knowledge base keeps its creation-time
    // embedding profile — its vector space cannot be switched in place. When
    // the server's embedding configuration has changed since the base was
    // created, new content would embed into a different vector space than the
    // base's existing chunks, so the import is refused with the two profiles
    // named (recovery = new knowledge base + re-ingestion).
    // getById can only return null if resolveScope handed out an id it never
    // validated (unreachable: explicit ids are existence+tenant checked, the
    // default is ensureDefault-ed above) — so a null row passes through and
    // the comparison below is what fails closed on a real profile mismatch.
    const knowledgeBase = service.getById(knowledgeBaseId, accessContext.tenantId)
    if (knowledgeBase && knowledgeBase.embeddingProfile !== currentProfile) {
      return {
        ok: false,
        status: 409,
        body: {
          error: "knowledge base embedding profile mismatch",
          knowledgeBaseProfile: knowledgeBase.embeddingProfile,
          serverProfile: currentProfile,
          hint: "changing the embedding profile requires a new knowledge base and re-ingestion",
        },
      }
    }
    return { ok: true, knowledgeBaseId }
  } catch (error) {
    if (error instanceof KnowledgeBaseNotFoundError) {
      return { ok: false, status: 404, body: { error: "knowledge base not found" } }
    }
    if (error instanceof KnowledgeBaseArchivedError) {
      // Ticket 08 (KB-04): archived bases stop joining new retrieval — an
      // import naming one is a state conflict (restore first), never a 500.
      return { ok: false, status: 409, body: { error: "knowledge base is archived" } }
    }
    if (error instanceof InvalidKnowledgeBaseScopeError) {
      return { ok: false, status: 400, body: { error: error.message } }
    }
    throw error
  }
}

rawIngestRouter.post(
  "/ingest/file",
  // The raw parser bails with PayloadTooLargeError on oversize bodies; left
  // unwrapped, Express's default handler answers with an HTML error page that
  // the import popup would render verbatim. Map it to JSON like attachments.ts
  // (the 20MB in the message mirrors RAW_FILE_LIMIT above).
  (req: Request, res: Response, next: NextFunction) => {
    express.raw({ type: "application/octet-stream", limit: RAW_FILE_LIMIT })(req, res, (error?: unknown) => {
      if (error && (error as { type?: string }).type === "entity.too.large") {
        res.status(413).json({
          error: { kind: "file_size", message: "文件超过 20MB 单文件上限" },
        })
        return
      }
      next(error)
    })
  },
  (req: Request, res: Response) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({
        error: { kind: "empty_file", message: "a non-empty application/octet-stream body is required" },
      })
    }
    const fileName = decodeUtf8HeaderValue(req.get("x-file-name")).trim()
    if (!fileName) {
      return res.status(400).json({ error: "x-file-name is required" })
    }
    const parserOverride = req.get("x-parser")?.trim().toLowerCase()
    if (parserOverride && !PARSER_TYPES.has(parserOverride)) {
      return res.status(400).json({
        error: "x-parser must be markitdown, marker, mineru, or builtin-pdf",
      })
    }
    // Ticket UT-05: admission judges the DECLARED type against the actual
    // bytes before anything is persisted. Clear type masquerade (a .txt that
    // is really a PDF, or text bytes declared as PDF) is refused with a
    // stable error; generic MIME declarations never override the bytes.
    const typeConflict = detectTypeConflict(fileName, req.body)
    if (typeConflict) {
      return res.status(415).json({
        error: {
          kind: typeConflict.kind,
          detected: typeConflict.detected,
          message: typeConflict.message,
        },
      })
    }
    // Ticket UT-05: an unrouteable type is refused at admission instead of
    // consuming parse retries later — no runnable task is created for a type
    // no parser can handle.
    try {
      selectParserRoute({
        fileName,
        mimeType: req.get("x-file-mime-type")?.trim() || undefined,
        override: parserOverride,
      })
    } catch (error) {
      return res.status(415).json({
        error: {
          kind: "unsupported_type",
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
    // Ticket 12 (DOC-01B): same-name files require an explicit intent.
    const versionIntent = parseVersionIntent(req.get("x-document-intent")?.trim() || undefined)
    if (!versionIntent.ok) {
      return res.status(400).json({ error: versionIntent.error })
    }

    const sourceExternalId = decodeUtf8HeaderValue(req.get("x-source-id")).trim() || fileName
    const db = openDb()
    const resolved = resolveRequestKnowledgeBaseId(res, db, req.get("x-knowledge-base-id"))
    if (!resolved.ok) {
      return res.status(resolved.status).json(resolved.body)
    }
    // Ticket 11 (DOC-01A): optional catalog metadata via headers. Resolved after
    // the knowledge base because a folder address is meaningless without it.
    // Tags carry the same Latin-1 header constraint as the file name and the
    // folder: the client percent-encodes them, so they decode here too.
    const tagsHeader = req.get("x-document-tags")
    const catalogMetadata = parseCatalogMetadata(
      res,
      db,
      resolved.knowledgeBaseId,
      tagsHeader?.trim()
        ? decodeUtf8HeaderValue(tagsHeader).split(",").map((tag) => tag.trim())
        : undefined,
      req.get("x-document-folder")
        ? decodeUtf8HeaderValue(req.get("x-document-folder"))
        : undefined
    )
    if (!catalogMetadata.ok) {
      return res.status(400).json({ error: catalogMetadata.error })
    }
    const lifecycle = createIngestionLifecycle(db)
    let submission
    try {
      submission = lifecycle.submit({
        ...(submissionTrace(res) ? { trace: submissionTrace(res) } : {}),
        title: req.get("x-document-title")?.trim() || fileName,
        content: "",
        rawContent: req.body,
        fileName,
        mimeType: req.get("x-file-mime-type")?.trim() || "application/octet-stream",
        parserOverride,
        knowledgeBaseId: resolved.knowledgeBaseId,
        ...(catalogMetadata.metadata ? { metadata: catalogMetadata.metadata } : {}),
        ...(versionIntent.intent ? { versionIntent: versionIntent.intent } : {}),
        sourceIdentity: trustedSourceIdentity(res, {
          kind: req.get("x-source-kind")?.trim() || "file",
          uriOrExternalId: sourceExternalId,
          namespace: req.get("x-source-namespace")?.trim() || "upload",
        }),
      })
    } catch (error) {
      const conflict = sameNameConflict(error)
      if (conflict) return res.status(conflict.status).json(conflict.body)
      throw error
    }
    return res.json(submission)
  }
)

router.post("/ingest", (req: Request, res: Response) => {
  const body = req.body as IngestRequestBody
  if (!body.title || !body.content) {
    return res.status(400).json({ error: "title and content are required" })
  }

  const db = openDb()
  const resolved = resolveRequestKnowledgeBaseId(res, db, body.knowledgeBaseId)
  if (!resolved.ok) {
    return res.status(resolved.status).json(resolved.body)
  }
  // Ticket 11 (DOC-01A): optional catalog metadata.
  const catalogMetadata = parseCatalogMetadata(
    res,
    db,
    resolved.knowledgeBaseId,
    body.tags,
    body.folder
  )
  if (!catalogMetadata.ok) {
    return res.status(400).json({ error: catalogMetadata.error })
  }
  // Ticket 12 (DOC-01B): optional version intent.
  const versionIntent = parseVersionIntent(body.versionIntent)
  if (!versionIntent.ok) {
    return res.status(400).json({ error: versionIntent.error })
  }

  const lifecycle = createIngestionLifecycle(db)
  try {
    return res.json(
      lifecycle.submit({
        title: body.title,
        content: body.content,
        source: body.source,
        knowledgeBaseId: resolved.knowledgeBaseId,
        ...(submissionTrace(res) ? { trace: submissionTrace(res) } : {}),
        ...(catalogMetadata.metadata ? { metadata: catalogMetadata.metadata } : {}),
        ...(versionIntent.intent ? { versionIntent: versionIntent.intent } : {}),
        sourceIdentity: trustedSourceIdentity(res, requestSourceIdentity(body)),
      })
    )
  } catch (error) {
    const conflict = sameNameConflict(error)
    if (conflict) return res.status(conflict.status).json(conflict.body)
    throw error
  }
})

router.post("/ingest/url", async (req: Request, res: Response) => {
  const body = req.body as IngestUrlRequestBody
  const url = body.url?.trim()
  if (!url) {
    return res.status(400).json({ error: "url is required" })
  }
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return res.status(400).json({ error: "url must be a valid absolute URL" })
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return res.status(400).json({ error: "url protocol must be http or https" })
  }

  const mode = body.mode === "sitemap" ? "sitemap" : "single"
  const parserOverride = body.parserOverride
  if (parserOverride && !PARSER_TYPES.has(parserOverride)) {
    return res.status(400).json({ error: "parserOverride must be markitdown, marker, mineru, or builtin-pdf" })
  }

  // Ticket 04 (KB-02B): resolve ownership BEFORE any outbound fetch. A rejected
  // import must not perform network work, and every page of a sitemap batch is
  // filed under this one knowledge base.
  const db = openDb()
  const resolved = resolveRequestKnowledgeBaseId(res, db, body.knowledgeBaseId)
  if (!resolved.ok) {
    return res.status(resolved.status).json(resolved.body)
  }
  const { knowledgeBaseId } = resolved

  // Ticket 11 (DOC-01A): optional catalog metadata, resolved with the
  // ownership so a rejected import still does zero network work.
  const catalogMetadata = parseCatalogMetadata(res, db, knowledgeBaseId, body.tags, body.folder)
  if (!catalogMetadata.ok) {
    return res.status(400).json({ error: catalogMetadata.error })
  }
  // Ticket 12 (DOC-01B): optional version intent (a URL re-import whose page
  // content changed must declare version-or-new-document).
  const versionIntent = parseVersionIntent(body.versionIntent)
  if (!versionIntent.ok) {
    return res.status(400).json({ error: versionIntent.error })
  }

  const lifecycle = createIngestionLifecycle(db)

  if (mode === "single") {
    let fetched
    try {
      fetched = await fetchSingleUrl(parsedUrl, {
        timeoutMs: URL_FETCH_TIMEOUT_MS,
        maxBytes: URL_FETCH_MAX_BYTES,
      })
    } catch (err) {
      // P4.3: SSRF 拒绝 (UrlPolicyDenyError) 是 non-retryable — 策略层判定目标不可达。
      // 与 transient fetch error (502) 区分，让调用方不会重试被策略拒绝的 URL。
      if (err instanceof UrlPolicyDenyError) {
        return res.status(422).json({
          error: "url policy denied",
          reason: err.decision.reason,
          detail: err.decision.detail,
          stage: err.stage,
          hop: err.hop,
          retryable: false,
        })
      }
      return res.status(502).json({
        error: "failed to fetch url",
        detail: err instanceof Error ? err.message : String(err),
        retryable: true,
      })
    }
    // Ticket 21: URL imports get the same file-open validation as uploads —
    // the fetched bytes are judged against their declared name before anything
    // is persisted, so a fetched masquerade is refused at admission.
    const typeConflict = detectTypeConflict(fetched.fileName, fetched.buffer)
    if (typeConflict) {
      return res.status(415).json({
        error: {
          kind: typeConflict.kind,
          detected: typeConflict.detected,
          message: typeConflict.message,
        },
      })
    }
    let submission
    try {
      submission = lifecycle.submit({
        ...(submissionTrace(res) ? { trace: submissionTrace(res) } : {}),
        title: body.title?.trim() || fetched.title || fetched.fileName,
        content: "",
        rawContent: fetched.buffer,
        fileName: fetched.fileName,
        mimeType: fetched.mimeType,
        parserOverride,
        knowledgeBaseId,
        ...(catalogMetadata.metadata ? { metadata: catalogMetadata.metadata } : {}),
        ...(versionIntent.intent ? { versionIntent: versionIntent.intent } : {}),
        sourceIdentity: trustedSourceIdentity(res, {
          kind: "web",
          uriOrExternalId: url,
          namespace: "web",
        }),
      })
    } catch (error) {
      const conflict = sameNameConflict(error)
      if (conflict) return res.status(conflict.status).json(conflict.body)
      throw error
    }
    return res.json(submission)
  }

  // sitemap 模式（Phase 3）
  const requestedMax = body.maxPages
  const maxPages = Math.min(
    Math.max(1, Math.floor(requestedMax ?? SITEMAP_DEFAULT_MAX_PAGES)),
    SITEMAP_HARD_MAX_PAGES,
  )
  let pages: { url: URL; fileName: string }[]
  try {
    pages = (await fetchSitemapUrls(parsedUrl, {
      timeoutMs: URL_FETCH_TIMEOUT_MS,
      maxPages,
    })).urls
  } catch (err) {
    // P4.3: sitemap.xml 本身的 SSRF 拒绝也走 422 non-retryable 路径。
    if (err instanceof UrlPolicyDenyError) {
      return res.status(422).json({
        error: "url policy denied",
        reason: err.decision.reason,
        detail: err.decision.detail,
        stage: err.stage,
        hop: err.hop,
        retryable: false,
      })
    }
    return res.status(502).json({
      error: "failed to fetch sitemap",
      detail: err instanceof Error ? err.message : String(err),
      retryable: true,
    })
  }
  const batchId = `sitemap-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const submissions: { url: string; docId: string; status: string; retryable: boolean }[] = []
  for (const page of pages) {
    let pageFetched
    try {
      pageFetched = await fetchSingleUrl(page.url, {
        timeoutMs: URL_FETCH_TIMEOUT_MS,
        maxBytes: URL_FETCH_MAX_BYTES,
      })
    } catch (err) {
      // P4.3: SSRF 拒绝 (non-retryable) 与 transient fetch error (retryable) 分别标记，
      // 让批量调用方可 inspect 每页的 retryability 而不重试被策略拒绝的 URL。
      if (err instanceof UrlPolicyDenyError) {
        submissions.push({
          url: page.url.toString(),
          docId: "",
          status: `ssrf_denied: ${err.decision.reason}`,
          retryable: false,
        })
      } else {
        submissions.push({
          url: page.url.toString(),
          docId: "",
          status: `failed: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
        })
      }
      continue
    }
    // Ticket 21: a fetched page masquerading as another type is a per-page
    // admission failure, reported in the batch like any other page failure.
    const pageTypeConflict = detectTypeConflict(pageFetched.fileName, pageFetched.buffer)
    if (pageTypeConflict) {
      submissions.push({
        url: page.url.toString(),
        docId: "",
        status: `type_conflict: ${pageTypeConflict.detected} — ${pageTypeConflict.message}`,
        retryable: false,
      })
      continue
    }
    let submission
    try {
      submission = lifecycle.submit({
        ...(submissionTrace(res) ? { trace: submissionTrace(res) } : {}),
        title: pageFetched.title || pageFetched.fileName,
        content: "",
        rawContent: pageFetched.buffer,
        fileName: pageFetched.fileName,
        mimeType: pageFetched.mimeType,
        parserOverride,
        knowledgeBaseId,
        // Ticket 11 (DOC-01A): the whole sitemap batch shares one catalog entry.
        ...(catalogMetadata.metadata ? { metadata: catalogMetadata.metadata } : {}),
        ...(versionIntent.intent ? { versionIntent: versionIntent.intent } : {}),
        sourceIdentity: trustedSourceIdentity(res, {
          kind: "web",
          uriOrExternalId: page.url.toString(),
          namespace: "web-sitemap",
        }),
      })
    } catch (error) {
      // Ticket 12 (DOC-01B): a page whose content changed is a per-page
      // conflict — reported in the batch like any other page failure.
      const conflict = sameNameConflict(error)
      if (conflict) {
        submissions.push({
          url: page.url.toString(),
          docId: "",
          status: "intent_required: versionIntent (new_version or new_document) is required when page content changed",
          retryable: false,
        })
        continue
      }
      throw error
    }
    submissions.push({
      url: page.url.toString(),
      docId: submission.docId,
      status: submission.status,
      retryable: false,
    })
  }
  return res.json({
    batchId,
    mode: "sitemap",
    // Ticket 04 (KB-02B): the batch reports the single knowledge base every
    // page was filed under, so a caller can verify ownership without probing.
    knowledgeBaseId,
    total: pages.length,
    submitted: submissions.filter((s) => s.docId).length,
    failed: submissions.filter((s) => !s.docId).length,
    items: submissions,
  })
})

router.get("/ingest/:docId/status", (req: Request, res: Response) => {
  const db = openDb()
  // Ticket 12 (DOC-01B): tenant-scoped — another tenant's doc id is 404.
  if (!ownedDocumentOrNotFound(res, db, String(req.params.docId))) return
  const lifecycle = createIngestionLifecycle(db)
  const status = lifecycle.getStatus(String(req.params.docId))

  if (!status) {
    return res.status(404).json({ error: "document not found" })
  }

  return res.json(status)
})

router.post("/ingest/:docId/cancel", (req: Request, res: Response) => {
  const db = openDb()
  if (!ownedDocumentOrNotFound(res, db, String(req.params.docId))) return
  const lifecycle = createIngestionLifecycle(db)
  const result = lifecycle.cancel(String(req.params.docId))

  if (!result) {
    return res.status(404).json({ error: "document not found" })
  }

  return res.json(result)
})

// Ticket 12 (DOC-01B): administrator document operations. Both reuse the
// existing lifecycle task machinery (TaskRepo.requeue → the worker pipeline's
// normal stages and activation gate) and answer the resolved durable status.
router.post("/ingest/:docId/retry", (req: Request, res: Response) => {
  if (!requireAdminScope(res)) return
  const db = openDb()
  if (!ownedDocumentOrNotFound(res, db, String(req.params.docId))) return
  const lifecycle = createIngestionLifecycle(db)
  const result = lifecycle.retry(String(req.params.docId))
  if (!result) {
    return res.status(404).json({ error: "document not found" })
  }
  if (!result.changed) {
    return res.status(409).json({ error: `document is not retryable in state "${result.status}"`, ...result })
  }
  return res.json(result)
})

router.post("/ingest/:docId/reprocess", (req: Request, res: Response) => {
  if (!requireAdminScope(res)) return
  const db = openDb()
  if (!ownedDocumentOrNotFound(res, db, String(req.params.docId))) return
  const lifecycle = createIngestionLifecycle(db)
  const result = lifecycle.reprocess(String(req.params.docId))
  if (!result) {
    return res.status(404).json({ error: "document not found" })
  }
  if (!result.changed) {
    return res.status(409).json({ error: `document is not reprocessable in state "${result.status}"`, ...result })
  }
  return res.json(result)
})

export default router
