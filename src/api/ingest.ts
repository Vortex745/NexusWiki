import express, { Request, Response, Router } from "express"
import { randomUUID } from "node:crypto"
import { singleTenantAccessContext, type AccessContext } from "../access/context"
import { loadConfig } from "../config"
import { createIngestionLifecycle } from "../ingestion/pipeline"
import type { SourceIdentityInput } from "../ingestion/source_identity"
import { openDb } from "../ingestion/tracking"
import type { DB } from "../ingestion/tracking/db"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import {
  InvalidKnowledgeBaseScopeError,
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
}

interface IngestUrlRequestBody {
  url?: string
  mode?: "single" | "sitemap"
  title?: string
  parserOverride?: "markitdown" | "marker" | "mineru"
  maxPages?: number
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
    allowedGroups: [...accessContext.groups],
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

    const sourceExternalId = req.get("x-source-id")?.trim() || fileName
    const db = openDb()
    const resolved = resolveRequestKnowledgeBaseId(res, db, req.get("x-knowledge-base-id"))
    if (!resolved.ok) {
      return res.status(resolved.status).json(resolved.body)
    }
    const lifecycle = createIngestionLifecycle(db)
    return res.json(lifecycle.submit({
      title: req.get("x-document-title")?.trim() || fileName,
      content: "",
      rawContent: req.body,
      fileName,
      mimeType: req.get("x-file-mime-type")?.trim() || "application/octet-stream",
      parserOverride,
      knowledgeBaseId: resolved.knowledgeBaseId,
      sourceIdentity: trustedSourceIdentity(res, {
        kind: req.get("x-source-kind")?.trim() || "file",
        uriOrExternalId: sourceExternalId,
        namespace: req.get("x-source-namespace")?.trim() || "upload",
      }),
    }))
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

  const lifecycle = createIngestionLifecycle(db)
  return res.json(
    lifecycle.submit({
      title: body.title,
      content: body.content,
      source: body.source,
      knowledgeBaseId: resolved.knowledgeBaseId,
      sourceIdentity: trustedSourceIdentity(res, requestSourceIdentity(body)),
    })
  )
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

  const lifecycle = createIngestionLifecycle(openDb())

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
    const submission = lifecycle.submit({
      title: body.title?.trim() || fetched.title || fetched.fileName,
      content: "",
      rawContent: fetched.buffer,
      fileName: fetched.fileName,
      mimeType: fetched.mimeType,
      parserOverride,
      sourceIdentity: trustedSourceIdentity(res, {
        kind: "web",
        uriOrExternalId: url,
        namespace: "web",
      }),
    })
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
    const submission = lifecycle.submit({
      title: pageFetched.title || pageFetched.fileName,
      content: "",
      rawContent: pageFetched.buffer,
      fileName: pageFetched.fileName,
      mimeType: pageFetched.mimeType,
      parserOverride,
      sourceIdentity: trustedSourceIdentity(res, {
        kind: "web",
        uriOrExternalId: page.url.toString(),
        namespace: "web-sitemap",
      }),
    })
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
    total: pages.length,
    submitted: submissions.filter((s) => s.docId).length,
    failed: submissions.filter((s) => !s.docId).length,
    items: submissions,
  })
})

router.get("/ingest/:docId/status", (req: Request, res: Response) => {
  const lifecycle = createIngestionLifecycle(openDb())
  const status = lifecycle.getStatus(String(req.params.docId))

  if (!status) {
    return res.status(404).json({ error: "document not found" })
  }

  return res.json(status)
})

router.post("/ingest/:docId/cancel", (req: Request, res: Response) => {
  const lifecycle = createIngestionLifecycle(openDb())
  const result = lifecycle.cancel(String(req.params.docId))

  if (!result) {
    return res.status(404).json({ error: "document not found" })
  }

  return res.json(result)
})

export default router
