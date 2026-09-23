/**
 * Ticket 33 (MEM-01B) — the memory extraction suggestion review API.
 *
 *   GET  /api/memory-suggestions               the caller's pending suggestions
 *   POST /api/memory-suggestions/:id/accept    publish a suggestion as a memory
 *   POST /api/memory-suggestions/:id/dismiss   discard a suggestion
 *
 * The queue only ever holds PENDING rows (extraction never publishes). Both
 * settle actions apply to pending rows only — a settled suggestion is never
 * re-settled. Identity comes from the access middleware; another user's
 * suggestion is the same 404 as an unknown one.
 */

import { Router, type Request, type Response } from "express"
import { singleTenantAccessContext, type AccessContext } from "../access/context"
import type { MemorySuggestionStore, MemorySuggestionStatus } from "../memory/memory_suggestion_store"
import { MemoryQuotaError, type LongTermMemoryStore } from "../memory/long_term_memory_store"

function resolveContext(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

export function createMemorySuggestionsRouter(deps: {
  suggestions: MemorySuggestionStore
  memories: LongTermMemoryStore
}): Router {
  const router = Router()

  router.get("/memory-suggestions", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    const requested = String(req.query.status ?? "pending")
    const status: MemorySuggestionStatus =
      requested === "accepted" || requested === "dismissed"
        ? requested
        : "pending"
    res.json({ suggestions: deps.suggestions.list(ctx.tenantId, ctx.subjectId, status) })
  })

  router.post("/memory-suggestions/:id/accept", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    const suggestion = deps.suggestions.get(ctx.tenantId, ctx.subjectId, String(req.params.id))
    if (!suggestion || suggestion.status !== "pending") {
      // Unknown, foreign, or already settled — same 404/409 shape.
      res.status(suggestion ? 409 : 404).json({
        error: suggestion ? "suggestion already settled" : "memory suggestion not found",
      })
      return
    }
    try {
      // Publish: the accepted suggestion becomes a plain user-owned memory.
      const memory = deps.memories.create({
        tenantId: ctx.tenantId,
        subjectId: ctx.subjectId,
        ...(suggestion.assistantId ? { assistantId: suggestion.assistantId } : {}),
        content: suggestion.content,
      })
      deps.suggestions.markAccepted(ctx.tenantId, ctx.subjectId, suggestion.id)
      res.json({ memory, suggestion: deps.suggestions.get(ctx.tenantId, ctx.subjectId, suggestion.id) })
    } catch (error) {
      if (error instanceof MemoryQuotaError) {
        res.status(409).json({ error: error.message })
        return
      }
      throw error
    }
  })

  router.post("/memory-suggestions/:id/dismiss", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    const dismissed = deps.suggestions.dismiss(ctx.tenantId, ctx.subjectId, String(req.params.id))
    if (!dismissed) {
      res.status(404).json({ error: "memory suggestion not found" })
      return
    }
    res.json({ suggestion: dismissed })
  })

  return router
}
