import { Router, type Request, type Response } from "express"
import type { Client } from "@elastic/elasticsearch"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
import type { DocumentRepo, DocumentCatalogPage } from "../ingestion/tracking/doc_repo"
import type { ExtractionEvidenceRepository } from "../ingestion/tracking/extraction_evidence_repo"
import type { PageIndexRepository } from "../ingestion/tracking/page_index_repo"
import type { KnowledgeBaseService } from "../knowledge/knowledge_base_service"

/**
 * Ticket 11 (DOC-01A): the knowledge-base document catalog HTTP contract.
 *
 *   GET /knowledge-bases/:id/documents?page&pageSize&status&tag&folder
 *
 * Rules the acceptance criteria live in:
 *
 * 1. Paginated and knowledge-scoped: the tenant ALWAYS comes from the
 *    server-computed AccessContext; an unknown or cross-tenant knowledge base
 *    is the same 404 a missing row would be (ticket 03 semantics). The page
 *    carries documents WITHOUT content — catalog rows are metadata only.
 *
 * 2. Filters: processing state (`status`), a metadata `tag` and a one-level
 *    `folder`. Facets (distinct tags/folders over the visible rows) come back
 *    on every page so the UI can render filter options.
 *
 * 3. Reader authorization: a non-admin sees rows whose allowedGroups is empty
 *    (tenant-wide) or intersects its own groups — the ticket 10 import
 *    semantics; an admin sees all. The route is read-only: no administrator
 *    action exists to hide, and nothing mutates.
 *
 * Ticket 13 (DOC-02) adds the version view used by catalog and citation
 * paths (read-only, SQLite-first so historic citations survive retirement):
 *
 *   GET /documents/:docId                    — exact version + preview + sections
 *   GET /documents/:docId/chunks/:chunkId    — cited chunk + adjacent chunks
 */

const PROCESSING_STATES = new Set(["pending", "completed", "failed", "cancelled"])
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

function accessContext(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

const ADMIN_SCOPE = "admin"

function isAdmin(context: AccessContext): boolean {
  return context.scopes.includes(ADMIN_SCOPE)
}

// ---------------------------------------------------------------------------
// Ticket 13 (DOC-02): chunk reads against the chunk index. A tiny read-only
// seam so tests can stub it and the router never builds Elasticsearch clients.
// ---------------------------------------------------------------------------

export interface ChunkViewDoc {
  id: string
  documentId: string
  kind: string
  content: string
  parentId: string | null
  allowedGroups: string[]
  metadata: Record<string, unknown>
}

export interface ChunkReader {
  get(documentId: string, chunkId: string): Promise<ChunkViewDoc | null>
  listChildChunks(documentId: string, limit: number): Promise<ChunkViewDoc[]>
}

/** Production ChunkReader over the chunk index (raw Elasticsearch reads). */
export function createEsChunkReader(es: Client, indexName: string): ChunkReader {
  const hitToDoc = (hit: { _source?: Record<string, unknown> } | undefined): ChunkViewDoc | null => {
    if (!hit?._source) return null
    const source = hit._source
    return {
      id: String(source.id ?? ""),
      documentId: String(source.documentId ?? ""),
      kind: String(source.kind ?? "child"),
      content: String(source.content ?? ""),
      parentId: typeof source.parentId === "string" ? source.parentId : null,
      allowedGroups: Array.isArray(source.allowedGroups)
        ? source.allowedGroups.map(String)
        : [],
      metadata: (source.metadata && typeof source.metadata === "object"
        ? source.metadata : {}) as Record<string, unknown>,
    }
  }
  return {
    async get(documentId, chunkId) {
      const result = await es.get({ index: indexName, id: `${documentId}:${chunkId}` }, { ignore: [404] })
      return hitToDoc(result as { _source?: Record<string, unknown> } | undefined)
    },
    async listChildChunks(documentId, limit) {
      const result = await es.search({
        index: indexName,
        size: limit,
        query: { bool: { filter: [{ term: { documentId } }, { term: { kind: "child" } }] } },
        // Sorted server-side so a bounded page is the FIRST N chunks, not an
        // arbitrary subset.
        sort: [{ "metadata.index": { order: "asc", unmapped_type: "long" } }],
      })
      return (result.hits.hits as Array<{ _source?: Record<string, unknown> }>)
        .map(hitToDoc)
        .filter((doc): doc is ChunkViewDoc => doc !== null)
    },
  }
}

export function createDocumentsRouter(options: {
  documentRepo: DocumentRepo
  knowledgeBaseService: KnowledgeBaseService
  pageIndexRepo: PageIndexRepository
  /** Ticket 13 (DOC-02): chunk reads; absent (bare mounts) → chunk views 503. */
  chunkReader?: ChunkReader
  /**
   * Ticket UT-09: durable extraction evidence reads; absent (bare mounts) →
   * the extraction view answers 503 instead of pretending no evidence exists.
   */
  extractionEvidenceRepo?: ExtractionEvidenceRepository
}): Router {
  const { documentRepo, knowledgeBaseService, pageIndexRepo, chunkReader, extractionEvidenceRepo } = options
  const router = Router()

  router.get(
    "/knowledge-bases/:id/documents",
    (req: Request, res: Response) => {
      const context = accessContext(res)
      // Ticket 08 semantics: archived bases stop joining NEW retrieval but
      // stay inspectable — the catalog is inspection, so status is irrelevant
      // here; only tenant ownership is.
      const known = knowledgeBaseService
        .list(context.tenantId)
        .some((base) => base.id === req.params.id)
      if (!known) {
        res.status(404).json({ error: "knowledge base not found" })
        return
      }

      const page = Number.parseInt(String(req.query.page ?? "1"), 10)
      const pageSize = Number.parseInt(String(req.query.pageSize ?? String(DEFAULT_PAGE_SIZE)), 10)
      if (!Number.isFinite(page) || page < 1 || !Number.isFinite(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
        res.status(400).json({ error: `page must be >= 1 and pageSize between 1 and ${MAX_PAGE_SIZE}` })
        return
      }
      const status = req.query.status ? String(req.query.status) : undefined
      if (status && !PROCESSING_STATES.has(status)) {
        res.status(400).json({ error: "status must be one of pending, completed, failed, cancelled" })
        return
      }
      const tag = req.query.tag ? String(req.query.tag) : undefined
      const folder = req.query.folder ? String(req.query.folder) : undefined
      // The sidebar's content tree asks for the usable rows only; the
      // management view omits this and keeps every version visible.
      const activeRaw = req.query.active ? String(req.query.active) : undefined
      if (activeRaw !== undefined && activeRaw !== "true" && activeRaw !== "false") {
        res.status(400).json({ error: "active must be true or false" })
        return
      }
      const active = activeRaw === undefined ? undefined : activeRaw === "true"

      const catalog: DocumentCatalogPage = documentRepo.listCatalog({
        tenantId: context.tenantId,
        knowledgeBaseId: String(req.params.id),
        page,
        pageSize,
        ...(status ? { status } : {}),
        ...(tag ? { tag } : {}),
        ...(folder ? { folder } : {}),
        ...(active !== undefined ? { active } : {}),
        viewerGroups: [...context.groups],
        admin: isAdmin(context),
      })
      res.json(catalog)
    }
  )

  // ---------------------------------------------------------------------------
  // Ticket 13 (DOC-02): exact document versions from citations.
  // ---------------------------------------------------------------------------

  const groupVisible = (allowedGroups: string[], context: AccessContext): boolean =>
    isAdmin(context) ||
    context.groups.length === 0 ||
    allowedGroups.length === 0 ||
    allowedGroups.some((group) => context.groups.includes(group))

  router.get("/documents/:docId", (req: Request, res: Response) => {
    const context = accessContext(res)
    const docId = String(req.params.docId)
    const doc = documentRepo.get(docId)
    // Ticket 13 (DOC-02): the same doc-level group rule as the catalog — a
    // document invisible in the catalog is invisible here too.
    if (
      !doc ||
      (doc.tenantId ?? "default") !== context.tenantId ||
      !groupVisible(doc.allowedGroups ?? [], context)
    ) {
      res.status(404).json({ error: "document not found" })
      return
    }
    const version = documentRepo.getVersionInfo(docId)
    const operational = documentRepo.getOperationalState(docId)
    const retired = documentRepo.getSourceLifecycleState(doc.sourceId) === "retired"
    const sections = pageIndexRepo.getNodesByDocument(docId).map((node) => ({
      nodeId: node.nodeId,
      title: node.title,
      sectionPath: node.sectionPath,
      pageStart: node.pageStart,
      pageEnd: node.pageEnd,
    }))

    res.json({
      document: {
        docId,
        sourceId: doc.sourceId,
        title: doc.title,
        source: doc.source,
        fileName: doc.fileName ?? null,
        mimeType: doc.mimeType ?? "text/plain",
        status: operational?.status ?? "pending",
        candidateState: operational?.candidateState ?? "approved",
        version: doc.version,
        active: version?.active ?? false,
        retired,
        createdAt: doc.createdAt.toISOString(),
        updatedAt: operational?.updatedAt ?? doc.createdAt.toISOString(),
      },
      sections,
    })
  })

  // ---------------------------------------------------------------------------
  // Ticket UT-09: durable extraction evidence — the RAW extraction, its own
  // hash, the parser configuration fingerprint, per-page coverage and parser
  // warnings, readable after a restart. Authorization is exactly the doc-level
  // rule of GET /documents/:docId (tenant + group visibility; an invisible
  // document is an indistinguishable 404). The record echoes the honest parser
  // output — the read validates it and reports valid:false for tampered or
  // half-written rows instead of serving them as a verification cache.
  // ---------------------------------------------------------------------------
  router.get("/documents/:docId/extraction", (req: Request, res: Response) => {
    const context = accessContext(res)
    const docId = String(req.params.docId)
    const doc = documentRepo.get(docId)
    if (
      !doc ||
      (doc.tenantId ?? "default") !== context.tenantId ||
      !groupVisible(doc.allowedGroups ?? [], context)
    ) {
      res.status(404).json({ error: "document not found" })
      return
    }
    if (!extractionEvidenceRepo) {
      res.status(503).json({ error: "extraction evidence unavailable" })
      return
    }
    const result = extractionEvidenceRepo.get(docId)
    if (!result) {
      res.status(404).json({ error: "extraction evidence not found" })
      return
    }
    const { artifact, valid, invalidReason } = result
    res.json({
      docId,
      version: artifact.version,
      valid,
      ...(invalidReason ? { invalidReason } : {}),
      evidence: {
        schemaVersion: artifact.schemaVersion,
        parserType: artifact.parserType,
        parserConfigVersion: artifact.parserConfigVersion,
        rawExtractionSha256: artifact.rawExtractionSha256,
        rawExtraction: artifact.rawExtraction,
        warnings: artifact.warnings,
        pages: artifact.pages,
        pageCount: artifact.pageCount,
        completedAt: artifact.completedAt,
      },
    })
  })

  router.get("/documents/:docId/preview", async (req: Request, res: Response) => {
    const context = accessContext(res)
    const docId = String(req.params.docId)
    const doc = documentRepo.get(docId)
    if (
      !doc ||
      (doc.tenantId ?? "default") !== context.tenantId ||
      !groupVisible(doc.allowedGroups ?? [], context)
    ) {
      res.status(404).json({ error: "document not found" })
      return
    }
    const mimeType = doc.mimeType ?? "text/plain"
    const textLike = /^(text\/|application\/(json|xml|javascript|x-yaml))/.test(mimeType)
    let text = (doc.content ?? "").trim()
    let available = text.length > 0
    let reason: string | undefined
    if (!available && doc.rawContent && textLike) {
      const raw = doc.rawContent.toString("utf8")
      text = (mimeType === "text/html"
        ? raw.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ")
        : raw
      ).replace(/[ \t]+/g, " ").trim()
      available = text.length > 0
    }
    if (!available && chunkReader) {
      try {
        const children = await chunkReader.listChildChunks(docId, 60)
        text = children
          .sort((left, right) => Number(left.metadata.index ?? 0) - Number(right.metadata.index ?? 0))
          .map(({ content }) => content.trim())
          .filter(Boolean)
          .join("\n\n")
        available = text.length > 0
      } catch {
        available = false
      }
    }
    // Bounded preview — the full text belongs to the document service, not a
    // dialog pane.
    if (available && text.length > 20_000) {
      text = `${text.slice(0, 20_000)}\n\n…（预览仅显示前 20,000 字符）`
    }
    if (!available) {
      reason = doc.mimeType === "application/pdf"
        ? "无法预览：该 PDF 没有可提取的文本层（扫描件需要 mineru 等 OCR 解析能力）。"
        : "无法预览：该版本的文本内容不可用（可能已随删除清理，或解析未产出文本）。"
    }
    res.json({ available, ...(available ? { text } : { reason }) })
  })

  router.get("/documents/:docId/chunks/:chunkId", async (req: Request, res: Response) => {
    const context = accessContext(res)
    const docId = String(req.params.docId)
    const chunkId = String(req.params.chunkId)
    const doc = documentRepo.get(docId)
    if (!doc || (doc.tenantId ?? "default") !== context.tenantId) {
      res.status(404).json({ error: "document not found" })
      return
    }
    const version = documentRepo.getVersionInfo(docId)
    const retired = documentRepo.getSourceLifecycleState(doc.sourceId) === "retired"
    if (!chunkReader) {
      res.status(503).json({ error: "chunk index unavailable" })
      return
    }
    const chunk = await chunkReader.get(docId, chunkId).catch(() => null)
    if (!chunk || !groupVisible(chunk.allowedGroups, context)) {
      // The chunk text is gone (retired cleanup) or not authorized — the
      // citation stays traceable through the document version view.
      res.status(410).json({
        error: "chunk content unavailable (retired or not indexed)",
        document: { docId, title: doc.title, version: doc.version, retired },
      })
      return
    }
    const siblings = await chunkReader.listChildChunks(docId, 200)
      .then((chunks) => chunks.filter((entry) => groupVisible(entry.allowedGroups, context)))
      .then((chunks) => chunks.sort(
        (left, right) => Number(left.metadata.index ?? 0) - Number(right.metadata.index ?? 0)
      ))
    const position = siblings.findIndex((entry) => entry.id === chunkId)
    const neighbors = [
      position > 0 ? siblings[position - 1] : null,
      position >= 0 && position + 1 < siblings.length ? siblings[position + 1] : null,
    ].filter((entry): entry is ChunkViewDoc => entry !== null)
      .map((entry) => ({
        chunkId: entry.id,
        index: entry.metadata.index ?? null,
        excerpt: entry.content.slice(0, 200),
      }))
    res.json({
      chunk: {
        chunkId,
        kind: chunk.kind,
        index: chunk.metadata.index ?? null,
        sectionPath: Array.isArray(chunk.metadata.sectionPath)
          ? chunk.metadata.sectionPath
          : null,
        page: Number.isInteger(chunk.metadata.page) ? chunk.metadata.page : null,
        content: chunk.content,
      },
      document: {
        docId,
        title: doc.title,
        version: doc.version,
        active: version?.active ?? false,
        retired,
      },
      neighbors,
    })
  })

  return router
}
