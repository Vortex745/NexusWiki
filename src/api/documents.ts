import { Router, type Request, type Response } from "express"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
import type { DocumentRepo, DocumentCatalogPage } from "../ingestion/tracking/doc_repo"
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

export function createDocumentsRouter(options: {
  documentRepo: DocumentRepo
  knowledgeBaseService: KnowledgeBaseService
}): Router {
  const { documentRepo, knowledgeBaseService } = options
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

      const catalog: DocumentCatalogPage = documentRepo.listCatalog({
        tenantId: context.tenantId,
        knowledgeBaseId: String(req.params.id),
        page,
        pageSize,
        ...(status ? { status } : {}),
        ...(tag ? { tag } : {}),
        ...(folder ? { folder } : {}),
        viewerGroups: [...context.groups],
        admin: isAdmin(context),
      })
      res.json(catalog)
    }
  )

  return router
}
