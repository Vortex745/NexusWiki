import express, { Request, Response, Router } from "express"
import { randomUUID } from "node:crypto"
import { singleTenantAccessContext, type AccessContext } from "../access/context"
import { loadConfig } from "../config"
import { createIngestionLifecycle } from "../ingestion/pipeline"
import type { SourceIdentityInput } from "../ingestion/source_identity"
import { openDb } from "../ingestion/tracking"
import type { DB } from "../ingestion/tracking/db"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import {
  SameNameIntentRequiredError,
} from "../ingestion/lifecycle"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
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
  parserOverride?: "markitdown" | "marker" | "mineru"
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
export const rawIngestRouter = Router()

const RAW_FILE_LIMIT = "20mb"
const PARSER_TYPES = new Set(["markitdown", "marker", "mineru"])
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
  | { ok: false; status: number; body: { error: string } }

/**
 * Ticket 11 (DOC-01A): validate the optional catalog metadata an import may
 * carry. Tags: array of non-empty strings (≤ 20, each ≤ 64 chars). Folder: a
 * non-empty one-level name (≤ 200 chars, no separators — one level by
 * contract). Absent/empty fields contribute nothing to the document metadata.
 */
function parseCatalogMetadata(
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
  let cleanFolder: string | undefined
  if (folder !== undefined) {
    if (typeof folder !== "string") {
      return { ok: false, error: "folder must be a string" }
    }
    cleanFolder = folder.trim()
    if (cleanFolder.includes("/") || cleanFolder.includes("\\")) {
      return { ok: false, error: "folder must be a single level (no separators)" }
    }
    if (cleanFolder.length > 200) {
      return { ok: false, error: "folder must be at most 200 characters" }
    }
  }
  const metadata: Record<string, unknown> = {}
  if (cleanTags?.length) metadata.tags = cleanTags
  if (cleanFolder) metadata.folder = cleanFolder
  return Object.keys(metadata).length > 0 ? { ok: true, metadata } : { ok: true }
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
    const service = new KnowledgeBaseServiceImpl(
      new SqliteKnowledgeBaseRepo(db),
      knowledgeBaseEmbeddingProfile(cfg.embeddingModel, cfg.embeddingDimensions)
    )
    const { knowledgeBaseIds } = service.resolveScope(accessContext.tenantId, scope)
    const [knowledgeBaseId] = knowledgeBaseIds
    if (!knowledgeBaseId) {
      throw new InvalidKnowledgeBaseScopeError("a knowledge base is required")
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
  express.raw({ type: "application/octet-stream", limit: RAW_FILE_LIMIT }),
  (req: Request, res: Response) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "a non-empty application/octet-stream body is required" })
    }
    const fileName = req.get("x-file-name")?.trim()
    if (!fileName) {
      return res.status(400).json({ error: "x-file-name is required" })
    }
    const parserOverride = req.get("x-parser")?.trim().toLowerCase()
    if (parserOverride && !PARSER_TYPES.has(parserOverride)) {
      return res.status(400).json({
        error: "x-parser must be markitdown, marker, or mineru",
      })
    }
    // Ticket 11 (DOC-01A): optional catalog metadata via headers.
    const catalogMetadata = parseCatalogMetadata(
      req.get("x-document-tags")?.trim()
        ? req.get("x-document-tags")?.split(",").map((tag) => tag.trim())
        : undefined,
      req.get("x-document-folder")
    )
    if (!catalogMetadata.ok) {
      return res.status(400).json({ error: catalogMetadata.error })
    }
    // Ticket 12 (DOC-01B): same-name files require an explicit intent.
    const versionIntent = parseVersionIntent(req.get("x-document-intent")?.trim() || undefined)
    if (!versionIntent.ok) {
      return res.status(400).json({ error: versionIntent.error })
    }

    const sourceExternalId = req.get("x-source-id")?.trim() || fileName
    const db = openDb()
    const resolved = resolveRequestKnowledgeBaseId(res, db, req.get("x-knowledge-base-id"))
    if (!resolved.ok) {
      return res.status(resolved.status).json(resolved.body)
    }
    const lifecycle = createIngestionLifecycle(db)
    let submission
    try {
      submission = lifecycle.submit({
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
  const catalogMetadata = parseCatalogMetadata(body.tags, body.folder)
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
    return res.status(400).json({ error: "parserOverride must be markitdown, marker, or mineru" })
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
  const catalogMetadata = parseCatalogMetadata(body.tags, body.folder)
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
    let submission
    try {
      submission = lifecycle.submit({
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
    pages = await fetchSitemapUrls(parsedUrl, {
      timeoutMs: URL_FETCH_TIMEOUT_MS,
      maxPages,
    })
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
    let submission
    try {
      submission = lifecycle.submit({
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
