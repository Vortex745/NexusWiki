/**
 * Ticket 20 (CONV-01A) — conversation history HTTP API (user-owned).
 *
 *   GET  /api/conversations            the caller's directory list
 *   GET  /api/conversations/:id        the caller's full message history
 *   GET  /api/conversations/:id/context the caller's context-meter reading
 *   POST /api/conversations/import     one-time browser-thread import
 *
 * Everything is scoped to the caller's (tenant, subject) — another user's
 * directory is the same 404 as an unknown one. The import is idempotent by
 * thread id and never mutates or deletes browser-local data.
 */

import { Router, type Request, type Response } from "express"
import { singleTenantAccessContext, type AccessContext } from "../access/context"
import type { ContextCompactionService } from "../answer/context_compaction"
import {
  ConversationHistoryError,
  type SqliteConversationHistoryStore,
} from "../answer/conversation_history_store"

function resolveContext(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

export function createConversationsRouter(deps: {
  history: SqliteConversationHistoryStore
  /** 2026-10-31: the conversation-context meter. Absent → the route 503s. */
  contextCompaction?: ContextCompactionService
}): Router {
  const router = Router()

  router.get("/conversations", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    res.json({ directories: deps.history.listDirectories(ctx.tenantId, ctx.subjectId) })
  })

  router.get("/conversations/:id/context", (req: Request, res: Response) => {
    if (!deps.contextCompaction) {
      res.status(503).json({ error: "context usage is not available" })
      return
    }
    const ctx = resolveContext(res)
    try {
      res.json(deps.contextCompaction.usage(ctx, String(req.params.id)))
    } catch (error) {
      if (error instanceof ConversationHistoryError) {
        // Unknown and another user's thread are the same 404.
        res.status(404).json({ error: "conversation not found" })
        return
      }
      throw error
    }
  })

  router.get("/conversations/:id", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    try {
      const turns = deps.history.getTurns(String(req.params.id), ctx.tenantId, ctx.subjectId)
      res.json({ turns })
    } catch (error) {
      if (error instanceof ConversationHistoryError) {
        // Unknown and another user's thread are the same 404.
        res.status(404).json({ error: "conversation not found" })
        return
      }
      throw error
    }
  })

  router.post("/conversations/import", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    const body = (req.body ?? {}) as { threads?: unknown }
    if (!Array.isArray(body.threads)) {
      res.status(400).json({ error: "body must be { threads: [...] }" })
      return
    }
    try {
      const result = deps.history.importThreads(ctx.tenantId, ctx.subjectId, body.threads as never)
      res.json(result)
    } catch (error) {
      if (error instanceof ConversationHistoryError) {
        res.status(400).json({ error: error.message })
        return
      }
      throw error
    }
  })

  return router
}
