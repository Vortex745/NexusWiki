/**
 * Ticket 32 (MEM-01A) — the long-term memory HTTP API (user-owned).
 *
 *   GET    /api/memories        the caller's own records (global + assistant-pinned)
 *   POST   /api/memories        add one record { content, assistantId? }
 *   PATCH  /api/memories/:id    edit the content of one own record
 *   DELETE /api/memories/:id    forget one own record
 *   DELETE /api/memories        forget every own record (clear)
 *
 * Identity arrives via the access middleware like /api/conversations;
 * ownership is enforced per (tenant, subject) inside the store — the request
 * never names an owner. Another user's record is the same 404 as an unknown
 * id. An `assistantId` must resolve to an assistant the caller can see; a
 * reader may only pin to assistants visible to it.
 */

import { Router, type Request, type Response } from "express"
import { singleTenantAccessContext, type AccessContext } from "../access/context"
import {
  LongTermMemoryStore,
  MemoryContentError,
  MemoryQuotaError,
} from "../memory/long_term_memory_store"
import type { AssistantService } from "../assistants/assistant_service"

function resolveContext(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

export function createMemoriesRouter(deps: {
  memories: LongTermMemoryStore
  /** Present in the production server; absent in bare mounts (tests). */
  assistants?: AssistantService
}): Router {
  const router = Router()

  const resolveAssistantId = (raw: unknown, ctx: AccessContext): string | null | undefined => {
    // undefined → field absent (keeps current value on PATCH); null → explicit
    // global scope; string → must be a visible assistant of the caller.
    if (raw === undefined) return undefined
    if (raw === null) return null
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new MemoryContentError("assistantId must be a non-empty string or null")
    }
    const assistantId = raw.trim()
    if (!deps.assistants) {
      throw new MemoryContentError("assistants are not available in this deployment")
    }
    const assistant = deps.assistants.get(assistantId, ctx.tenantId)
    if (!assistant || !deps.assistants.visibleTo(assistant, ctx)) {
      // Unknown, cross-tenant and group-invisible are the same 404.
      throw new AssistantNotFoundError()
    }
    return assistantId
  }

  router.get("/memories", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    res.json({ memories: deps.memories.list(ctx.tenantId, ctx.subjectId) })
  })

  router.post("/memories", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    const body = (req.body ?? {}) as { content?: unknown; assistantId?: unknown }
    try {
      const assistantId = resolveAssistantId(body.assistantId, ctx)
      const memory = deps.memories.create({
        tenantId: ctx.tenantId,
        subjectId: ctx.subjectId,
        ...(assistantId !== undefined ? { assistantId } : {}),
        content: body.content,
      })
      res.status(201).json({ memory })
    } catch (error) {
      if (error instanceof AssistantNotFoundError) {
        res.status(404).json({ error: "assistant not found" })
        return
      }
      if (error instanceof MemoryContentError) {
        res.status(400).json({ error: error.message })
        return
      }
      if (error instanceof MemoryQuotaError) {
        res.status(409).json({ error: error.message })
        return
      }
      throw error
    }
  })

  router.patch("/memories/:id", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    const body = (req.body ?? {}) as { content?: unknown }
    try {
      const memory = deps.memories.edit(ctx.tenantId, ctx.subjectId, String(req.params.id), body.content)
      if (!memory) {
        // Unknown and another user's record are the same 404.
        res.status(404).json({ error: "memory not found" })
        return
      }
      res.json({ memory })
    } catch (error) {
      if (error instanceof MemoryContentError) {
        res.status(400).json({ error: error.message })
        return
      }
      throw error
    }
  })

  router.delete("/memories/:id", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    const forgotten = deps.memories.forget(ctx.tenantId, ctx.subjectId, String(req.params.id))
    if (!forgotten) {
      res.status(404).json({ error: "memory not found" })
      return
    }
    res.status(204).end()
  })

  router.delete("/memories", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    res.json({ forgotten: deps.memories.forgetAll(ctx.tenantId, ctx.subjectId) })
  })

  return router
}

class AssistantNotFoundError extends Error {
  constructor() {
    super("assistant not found")
    this.name = "AssistantNotFoundError"
  }
}
