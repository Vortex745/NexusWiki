import { Router, type Request, type Response } from "express"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
import type { KnowledgeBase } from "../types/knowledge_base"
import {
  InvalidKnowledgeBaseCommandError,
  type KnowledgeBaseService,
} from "../knowledge/knowledge_base_service"

/**
 * Ticket 08 (KB-04): the knowledge-base workspace HTTP contract.
 *
 *   GET    /knowledge-bases              browse (reader: active only; admin: all)
 *   POST   /knowledge-bases              create            (admin)
 *   PATCH  /knowledge-bases/:id          rename            (admin)
 *   POST   /knowledge-bases/:id/archive  archive           (admin)
 *   POST   /knowledge-bases/:id/restore  restore           (admin)
 *
 * Two rules from the acceptance criteria live here:
 *
 * 1. Validated public contracts and tenant ownership: the tenant ALWAYS comes
 *    from the server-computed AccessContext (never the body), every payload is
 *    validated by the service (→ 400), and an unknown or cross-tenant id is
 *    the same 404 a missing row would be — a caller can never probe another
 *    tenant's ids.
 *
 * 2. Archived knowledge bases stop joining NEW retrieval but stay inspectable:
 *    an admin's browse still lists them; selecting one into a retrieval scope
 *    is refused by the service with KnowledgeBaseArchivedError → 409.
 *
 * Mounting (server.ts): the access middleware (chat scope) runs before this
 * router so res.locals.accessContext carries the identity; the admin commands
 * additionally require the "admin" scope (→ 403) — the browser's own role
 * display comes from the same scopes, so the UI hides what the server would
 * refuse anyway.
 */

const ADMIN_SCOPE = "admin"

function accessContext(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

function isAdmin(context: AccessContext): boolean {
  return context.scopes.includes(ADMIN_SCOPE)
}

function serialize(knowledgeBase: KnowledgeBase): KnowledgeBase {
  // The domain object IS the public contract (validated field-for-field by the
  // service); returning it directly keeps one source of truth for the shape.
  return knowledgeBase
}

export function createKnowledgeBaseRouter(options: {
  service: KnowledgeBaseService
}): Router {
  const { service } = options
  const router = Router()

  router.get("/knowledge-bases", (req: Request, res: Response) => {
    const context = accessContext(res)
    const all = service.list(context.tenantId)
    const visible = isAdmin(context)
      ? all
      : all.filter((knowledgeBase) => knowledgeBase.status === "active")
    res.json({ knowledgeBases: visible.map(serialize) })
  })

  router.post("/knowledge-bases", (req: Request, res: Response) => {
    const context = accessContext(res)
    if (!isAdmin(context)) {
      res.status(403).json({ error: "admin scope required" })
      return
    }
    const body = req.body as { name?: unknown; description?: unknown } | undefined
    if (typeof body?.name !== "string") {
      res.status(400).json({ error: "name is required" })
      return
    }
    if (body.description !== undefined && typeof body.description !== "string") {
      res.status(400).json({ error: "description must be a string" })
      return
    }
    try {
      const knowledgeBase = service.create(
        context.tenantId,
        body.name,
        body.description as string | undefined
      )
      res.status(201).json({ knowledgeBase: serialize(knowledgeBase) })
    } catch (error) {
      if (error instanceof InvalidKnowledgeBaseCommandError) {
        res.status(400).json({ error: error.message })
        return
      }
      throw error
    }
  })

  router.patch("/knowledge-bases/:id", (req: Request, res: Response) => {
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
      const knowledgeBase = service.rename(
        String(req.params.id),
        context.tenantId,
        body.name
      )
      if (!knowledgeBase) {
        res.status(404).json({ error: "knowledge base not found" })
        return
      }
      res.json({ knowledgeBase: serialize(knowledgeBase) })
    } catch (error) {
      if (error instanceof InvalidKnowledgeBaseCommandError) {
        res.status(400).json({ error: error.message })
        return
      }
      throw error
    }
  })

  router.post("/knowledge-bases/:id/archive", (req: Request, res: Response) => {
    const context = accessContext(res)
    if (!isAdmin(context)) {
      res.status(403).json({ error: "admin scope required" })
      return
    }
    try {
      const knowledgeBase = service.archive(String(req.params.id), context.tenantId)
      if (!knowledgeBase) {
        res.status(404).json({ error: "knowledge base not found" })
        return
      }
      res.json({ knowledgeBase: serialize(knowledgeBase) })
    } catch (error) {
      if (error instanceof InvalidKnowledgeBaseCommandError) {
        res.status(400).json({ error: error.message })
        return
      }
      throw error
    }
  })

  router.post("/knowledge-bases/:id/restore", (req: Request, res: Response) => {
    const context = accessContext(res)
    if (!isAdmin(context)) {
      res.status(403).json({ error: "admin scope required" })
      return
    }
    const knowledgeBase = service.activate(String(req.params.id), context.tenantId)
    if (!knowledgeBase) {
      res.status(404).json({ error: "knowledge base not found" })
      return
    }
    res.json({ knowledgeBase: serialize(knowledgeBase) })
  })

  return router
}
