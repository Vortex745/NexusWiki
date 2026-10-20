import { Router, type Request, type Response } from "express"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
import type { KnowledgeBase } from "../types/knowledge_base"
import {
  InvalidKnowledgeBaseCommandError,
  type KnowledgeBaseService,
} from "../knowledge/knowledge_base_service"
import type { RetirementService } from "../knowledge/retirement"
import { NoopTracingRuntime, type TracingRuntime } from "../tracing/contract"
import { validateReason } from "./source_governance"

/**
 * Ticket 08 (KB-04): the knowledge-base workspace HTTP contract.
 *
 *   GET    /knowledge-bases              browse (reader: active only; admin: all)
 *   POST   /knowledge-bases              create            (admin)
 *   PATCH  /knowledge-bases/:id          rename            (admin)
 *   POST   /knowledge-bases/:id/archive  archive           (admin)
 *   POST   /knowledge-bases/:id/restore  restore           (admin)
 *   POST   /knowledge-bases/:id/retire-contents  retire every source (admin)
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
  retirement: RetirementService
  /** LO-05: neutral tracing runtime; absent means tracing is off. */
  tracing?: TracingRuntime
}): Router {
  const { service, retirement } = options
  const tracing = options.tracing ?? new NoopTracingRuntime()
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
    // LO-05: the first real business operation on the neutral tracing contract.
    // Nothing here knows about a vendor: when tracing is off this is a no-op,
    // and the response is byte-identical (only the optional x-trace-id header
    // differs, and only when the root was actually sampled).
    const scope = tracing.startOperation("knowledge_base.create", {
      "knowledge_base.name_length": body.name.length,
      "knowledge_base.has_description": body.description !== undefined,
    })
    try {
      const knowledgeBase = service.create(
        context.tenantId,
        body.name,
        body.description as string | undefined
      )
      scope.setAttributes({ "knowledge_base.id": knowledgeBase.id })
      scope.end({ outcome: "ok" })
      if (scope.sampled && scope.traceId) {
        res.setHeader("x-trace-id", scope.traceId)
      }
      res.status(201).json({ knowledgeBase: serialize(knowledgeBase) })
    } catch (error) {
      if (error instanceof InvalidKnowledgeBaseCommandError) {
        scope.end({ outcome: "error", message: error.message.slice(0, 200) })
        res.status(400).json({ error: error.message })
        return
      }
      scope.end({ outcome: "error", message: "unexpected failure" })
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

  /**
   * 清空知识库内容: retire EVERY source of this knowledge base.
   *
   * Destructive and irreversible — which is why the reason is mandatory (the
   * same validated field as the per-source retire), the actor comes from the
   * session rather than the body, and the caller has already been put through a
   * confirmation dialog by the client. The knowledge base itself, its
   * `sources`/`documents` rows and their tombstones all survive: past citations
   * stay traceable. Cleanup runs asynchronously on the worker queue, so a 200
   * means "queued", not "erased".
   */
  router.post("/knowledge-bases/:id/retire-contents", (req: Request, res: Response) => {
    const context = accessContext(res)
    if (!isAdmin(context)) {
      res.status(403).json({ error: "admin scope required" })
      return
    }
    const body = req.body as { reason?: unknown } | undefined
    const reason = body?.reason
    if (!validateReason(reason, res)) return
    const knowledgeBase = service.getById(String(req.params.id), context.tenantId)
    if (!knowledgeBase) {
      res.status(404).json({ error: "knowledge base not found" })
      return
    }
    const result = retirement.retireKnowledgeBaseContents(
      knowledgeBase.id,
      context.tenantId,
      reason,
      context.subjectId
    )
    res.json({ knowledgeBaseId: knowledgeBase.id, ...result })
  })

  return router
}
