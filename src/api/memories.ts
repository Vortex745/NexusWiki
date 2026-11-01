/**
 * Long-term memory (2026-10-30) — the account-level profile HTTP API.
 *
 *   GET    /api/memories             the caller's own three-section profile
 *   PUT    /api/memories             edit one or more sections
 *   DELETE /api/memories             reset the whole profile
 *   POST   /api/memories/summarize   summarize one of the caller's sessions
 *
 * Identity arrives via the access middleware; ownership is enforced per
 * (tenant, subject) inside the store and inside the session transcript read —
 * the request never names an owner. Another account's profile or session is
 * the same 404 as an unknown one.
 */

import { Router, type Request, type Response } from "express"
import { singleTenantAccessContext, type AccessContext } from "../access/context"
import { ConversationHistoryError } from "../answer/conversation_history_store"
import {
  MEMORY_SECTION_KEYS,
  MemoryProfileError,
  type MemoryProfileStore,
  type MemorySectionKey,
} from "../memory/memory_profile_store"
import {
  MemorySummaryError,
  MemorySummaryModelUnavailableError,
  type SessionMemorySummarizer,
} from "../memory/session_memory_summarizer"

function resolveContext(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

export function createMemoriesRouter(deps: {
  profiles: MemoryProfileStore
  summarizer?: SessionMemorySummarizer
}): Router {
  const router = Router()

  router.get("/memories", (_req: Request, res: Response) => {
    const ctx = resolveContext(res)
    res.json({ profile: deps.profiles.get(ctx.tenantId, ctx.subjectId) })
  })

  router.put("/memories", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    const body = (req.body ?? {}) as Record<string, unknown>
    const provided = MEMORY_SECTION_KEYS.some((key) => body[key] !== undefined)
    if (!provided) {
      res.status(400).json({ error: "at least one memory section is required" })
      return
    }
    try {
      const sections: Partial<Record<MemorySectionKey, unknown>> = {}
      for (const key of MEMORY_SECTION_KEYS) {
        if (body[key] !== undefined) sections[key] = body[key]
      }
      const profile = deps.profiles.save(ctx.tenantId, ctx.subjectId, sections)
      res.json({ profile })
    } catch (error) {
      if (error instanceof MemoryProfileError) {
        res.status(400).json({ error: error.message })
        return
      }
      throw error
    }
  })

  router.delete("/memories", (_req: Request, res: Response) => {
    const ctx = resolveContext(res)
    deps.profiles.reset(ctx.tenantId, ctx.subjectId)
    res.json({ reset: true })
  })

  router.post("/memories/summarize", async (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    const sessionId = (req.body as { sessionId?: unknown } | undefined)?.sessionId
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      res.status(400).json({ error: "sessionId is required" })
      return
    }
    if (!deps.summarizer) {
      res.status(503).json({ error: "long-term memory summarization is not available" })
      return
    }
    try {
      const profile = await deps.summarizer.summarize(ctx, sessionId.trim())
      res.json({ profile })
    } catch (error) {
      if (error instanceof ConversationHistoryError) {
        // Unknown, foreign, or never-persisted session — one indistinguishable 404.
        res.status(404).json({ error: "conversation not found" })
        return
      }
      if (error instanceof MemorySummaryModelUnavailableError) {
        res.status(409).json({ error: "尚未配置大模型API，请检查后重试" })
        return
      }
      if (error instanceof MemoryProfileError) {
        // The only writer here is the server-side summarizer, so an over-limit
        // or wrong-typed section is a provider-contract failure, not client input.
        res.status(502).json({ error: error.message })
        return
      }
      if (error instanceof MemorySummaryError) {
        res.status(502).json({ error: error.message })
        return
      }
      throw error
    }
  })

  return router
}
