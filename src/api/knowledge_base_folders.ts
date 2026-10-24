import { Router, type Request, type Response } from "express"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
import type { KnowledgeBase, KnowledgeBaseFolder } from "../types/knowledge_base"
import {
  InvalidKnowledgeBaseCommandError,
  KnowledgeBaseNotFoundError,
} from "../knowledge/knowledge_base_service"
import {
  KnowledgeBaseFolderNotFoundError,
  type KnowledgeBaseFolderService,
} from "../knowledge/knowledge_base_folder_service"

/**
 * The knowledge-base folder HTTP contract.
 *
 *   GET    /knowledge-base-folders                  browse (every member)
 *   POST   /knowledge-base-folders                  create   (admin)
 *   PATCH  /knowledge-base-folders/:id              rename   (admin)
 *   DELETE /knowledge-base-folders/:id              delete   (admin) → ungroups
 *   PATCH  /knowledge-bases/:id/folder              move     (admin)
 *
 * The last route is registered HERE rather than in `knowledge_bases.ts` even
 * though its path sits under `/knowledge-bases`: the operation needs both
 * repositories (validate the target folder, write the base), so the folder
 * service owns it, and the knowledge-base router's contract stays exactly as
 * its tests describe it. Express matches the full path, so
 * `PATCH /knowledge-bases/:id` in the other router cannot swallow it.
 *
 * Same two rules as the knowledge-base workspace: the tenant ALWAYS comes from
 * the server-computed AccessContext (never the body), and an unknown or
 * cross-tenant id is the same 404 a missing row would be. A folder is a naming
 * aid — it is never part of a retrieval scope, and deleting one releases its
 * members instead of touching them.
 */

const ADMIN_SCOPE = "admin"

function accessContext(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

function isAdmin(context: AccessContext): boolean {
  return context.scopes.includes(ADMIN_SCOPE)
}

function serialize(folder: KnowledgeBaseFolder): KnowledgeBaseFolder {
  // The domain object IS the public contract, as in the knowledge-base router.
  return folder
}

/** Map the service's typed failures onto the workspace's status codes. */
function respondWithError(res: Response, error: unknown): boolean {
  if (error instanceof InvalidKnowledgeBaseCommandError) {
    res.status(400).json({ error: error.message })
    return true
  }
  if (
    error instanceof KnowledgeBaseFolderNotFoundError ||
    error instanceof KnowledgeBaseNotFoundError
  ) {
    // An id the caller cannot see, whether it never existed or lives in another
    // tenant — the two stay indistinguishable.
    res.status(404).json({ error: error.message })
    return true
  }
  return false
}

export function createKnowledgeBaseFolderRouter(options: {
  service: KnowledgeBaseFolderService
}): Router {
  const { service } = options
  const router = Router()

  router.get("/knowledge-base-folders", (_req: Request, res: Response) => {
    const context = accessContext(res)
    res.json({ folders: service.list(context.tenantId).map(serialize) })
  })

  router.post("/knowledge-base-folders", (req: Request, res: Response) => {
    const context = accessContext(res)
    if (!isAdmin(context)) {
      res.status(403).json({ error: "admin scope required" })
      return
    }
    const body = req.body as { name?: unknown } | undefined
    if (typeof body?.name !== "string") {
      res.status(400).json({ error: "name is required" })
      return
    }
    try {
      res.status(201).json({ folder: serialize(service.create(context.tenantId, body.name)) })
    } catch (error) {
      if (respondWithError(res, error)) return
      throw error
    }
  })

  router.patch("/knowledge-base-folders/:id", (req: Request, res: Response) => {
    const context = accessContext(res)
    if (!isAdmin(context)) {
      res.status(403).json({ error: "admin scope required" })
      return
    }
    const body = req.body as { name?: unknown } | undefined
    if (typeof body?.name !== "string") {
      res.status(400).json({ error: "name is required" })
      return
    }
    try {
      const folder = service.rename(String(req.params.id), context.tenantId, body.name)
      if (!folder) {
        res.status(404).json({ error: "knowledge base folder not found" })
        return
      }
      res.json({ folder: serialize(folder) })
    } catch (error) {
      if (respondWithError(res, error)) return
      throw error
    }
  })

  router.delete("/knowledge-base-folders/:id", (req: Request, res: Response) => {
    const context = accessContext(res)
    if (!isAdmin(context)) {
      res.status(403).json({ error: "admin scope required" })
      return
    }
    const removed = service.remove(String(req.params.id), context.tenantId)
    if (!removed) {
      res.status(404).json({ error: "knowledge base folder not found" })
      return
    }
    res.json({ ok: true, ungrouped: removed.ungrouped })
  })

  router.patch("/knowledge-bases/:id/folder", (req: Request, res: Response) => {
    const context = accessContext(res)
    if (!isAdmin(context)) {
      res.status(403).json({ error: "admin scope required" })
      return
    }
    const body = req.body as { folderId?: unknown } | undefined
    if (body === undefined || !("folderId" in body)) {
      res.status(400).json({ error: "folderId is required (null ungroups)" })
      return
    }
    const folderId = body.folderId
    if (folderId !== null && typeof folderId !== "string") {
      res.status(400).json({ error: "folderId must be a string or null" })
      return
    }
    let moved: KnowledgeBase
    try {
      moved = service.moveKnowledgeBase(
        String(req.params.id),
        context.tenantId,
        folderId === null || folderId.trim().length === 0 ? null : folderId
      )
    } catch (error) {
      if (respondWithError(res, error)) return
      throw error
    }
    res.json({ knowledgeBase: moved })
  })

  return router
}
