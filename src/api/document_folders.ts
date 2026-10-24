import { Router, type Request, type Response } from "express"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
import {
  DocumentFolderNotFoundError,
  InvalidDocumentFolderCommandError,
  type DocumentFolderService,
} from "../knowledge/document_folder_service"
import {
  InvalidKnowledgeBaseCommandError,
  KnowledgeBaseNotFoundError,
} from "../knowledge/knowledge_base_service"
import { validateReason } from "./source_governance"
import { taskTraceFromScope } from "../tracing/contract"
import { requestScope } from "../tracing/express"

/**
 * The document-folder HTTP contract.
 *
 *   GET    /knowledge-bases/:id/document-folders        browse (with counts)
 *   POST   /knowledge-bases/:id/document-folders        create   (admin)
 *   PATCH  /document-folders/:id                        rename   (admin)
 *   DELETE /document-folders/:id                        delete   (admin) → retires its documents
 *
 * The list and create routes sit under `/knowledge-bases/:id` because a
 * document folder belongs to exactly one knowledge base; rename and delete
 * address a folder by id, so they live under their own prefix.
 *
 * Same rules as the rest of the workspace: the tenant always comes from the
 * server-computed AccessContext (never the body), and an unknown or cross-tenant
 * id is the same 404 a missing row would be.
 *
 * DELETE is the destructive one and it says so: unlike a knowledge-base folder —
 * which only releases its members — a document folder holds documents, and
 * removing the directory retires what is inside it through the same per-source
 * retirement the document catalog's delete button uses. The caller is expected
 * to have put a confirmation dialog in front of it, and the cleanup it enqueues
 * is asynchronous: a 200 means "retired and queued", not "erased".
 */

const ADMIN_SCOPE = "admin"

function accessContext(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

function requireAdmin(context: AccessContext, res: Response): boolean {
  if (context.scopes.includes(ADMIN_SCOPE)) return true
  res.status(403).json({ error: "admin scope required" })
  return false
}

/** Map the service's typed failures onto the workspace's status codes. */
function respondWithError(res: Response, error: unknown): boolean {
  if (
    error instanceof InvalidDocumentFolderCommandError ||
    error instanceof InvalidKnowledgeBaseCommandError
  ) {
    res.status(400).json({ error: error.message })
    return true
  }
  if (
    error instanceof DocumentFolderNotFoundError ||
    error instanceof KnowledgeBaseNotFoundError
  ) {
    // An id the caller cannot see, whether it never existed or lives in another
    // tenant — the two stay indistinguishable.
    res.status(404).json({ error: error.message })
    return true
  }
  return false
}

export function createDocumentFolderRouter(options: {
  service: DocumentFolderService
}): Router {
  const { service } = options
  const router = Router()

  router.get("/knowledge-bases/:id/document-folders", (req: Request, res: Response) => {
    const context = accessContext(res)
    try {
      const entries = service.list(context.tenantId, String(req.params.id))
      res.json({
        folders: entries.map((entry) => ({ ...entry.folder, documents: entry.documents })),
      })
    } catch (error) {
      if (respondWithError(res, error)) return
      throw error
    }
  })

  router.post("/knowledge-bases/:id/document-folders", (req: Request, res: Response) => {
    const context = accessContext(res)
    if (!requireAdmin(context, res)) return
    const body = req.body as { name?: unknown } | undefined
    const name = typeof body?.name === "string" ? body.name : ""
    try {
      const folder = service.create(context.tenantId, String(req.params.id), name)
      res.status(201).json({ folder })
    } catch (error) {
      if (respondWithError(res, error)) return
      throw error
    }
  })

  router.patch("/document-folders/:id", (req: Request, res: Response) => {
    const context = accessContext(res)
    if (!requireAdmin(context, res)) return
    const body = req.body as { name?: unknown } | undefined
    const name = typeof body?.name === "string" ? body.name : ""
    try {
      const folder = service.rename(String(req.params.id), context.tenantId, name)
      if (!folder) {
        res.status(404).json({ error: "document folder not found" })
        return
      }
      res.json({ folder })
    } catch (error) {
      if (respondWithError(res, error)) return
      throw error
    }
  })

  router.delete("/document-folders/:id", (req: Request, res: Response) => {
    const context = accessContext(res)
    if (!requireAdmin(context, res)) return
    const body = req.body as { reason?: unknown } | undefined
    if (!validateReason(body?.reason, res)) return
    const result = service.remove(
      String(req.params.id),
      context.tenantId,
      body.reason,
      context.subjectId,
      taskTraceFromScope(requestScope(res))
    )
    if (!result) {
      res.status(404).json({ error: "document folder not found" })
      return
    }
    res.json({ ok: true, ...result })
  })

  return router
}
