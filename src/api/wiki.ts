import { Router, type Request, type Response } from "express"
import type OpenAI from "openai"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
import type { KnowledgeBaseService } from "../knowledge/knowledge_base_service"
import type { DB } from "../ingestion/tracking/db"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import { createIngestionLifecycle } from "../ingestion/pipeline"
import {
  WikiPageNotFoundError,
  WikiService,
  type WikiGenerationOutcome,
} from "../wiki/wiki_service"

/**
 * Ticket 38 (WIKI-01): the administrator Wiki surface.
 *
 *   GET  /knowledge-bases/:id/wiki/sources          — generation candidates
 *   GET  /knowledge-bases/:id/wiki/pages            — pages + history + staleness
 *   POST /knowledge-bases/:id/wiki/generate         — generate → validate → publish
 *   POST /knowledge-bases/:id/wiki/pages/:docId/restore — re-publish a revision
 *
 * Contract:
 * - Administrators only (the ticket names administrators as the actor); every
 *   route re-checks the KB's tenant ownership (unknown/cross-tenant = 404).
 * - generate is ONE command: a valid (non-empty, fully cited) draft publishes
 *   automatically through normal ingestion; an invalid draft is rejected with
 *   reasons and NOTHING is written, so the current page stays intact. A
 *   generation model failure is a 502 — also before any write.
 * - restore re-submits a historical revision verbatim under the same page
 *   identity — a normal new version, never a history rewrite.
 */

const MAX_TITLE_CHARS = 200

function accessContext(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

function isAdmin(context: AccessContext): boolean {
  return context.scopes.includes("admin")
}

export function createWikiRouter(options: {
  knowledgeBaseService: KnowledgeBaseService
  /** Per-request lifecycle source: the shared process db. */
  db: DB
  /**
   * The chat client for generation (production: the shared process runtime).
   * Absent (bare mounts) → generate answers 503; reads still work.
   */
  chatClient?: OpenAI
  model?: string
}): Router {
  const { knowledgeBaseService, db, chatClient, model } = options
  const router = Router()

  const requireAdminKb = (req: Request, res: Response): { context: AccessContext; service: WikiService } | null => {
    const context = accessContext(res)
    if (!isAdmin(context)) {
      res.status(403).json({ error: "administrator access required" })
      return null
    }
    const known = knowledgeBaseService
      .list(context.tenantId)
      .some((base) => base.id === req.params.id)
    if (!known) {
      res.status(404).json({ error: "knowledge base not found" })
      return null
    }
    const service = new WikiService({
      // Same per-request lifecycle pattern as the ingest routes: cheap over
      // the shared db handle; the worker processes the enqueued task.
      lifecycle: createIngestionLifecycle(db),
      documentRepo: new DocumentRepo(db),
      ...(chatClient ? { chatClient } : {}),
      ...(model ? { model } : {}),
    })
    return { context, service }
  }

  router.get("/knowledge-bases/:id/wiki/sources", (req: Request, res: Response) => {
    const guard = requireAdminKb(req, res)
    if (!guard) return
    res.json({ sources: guard.service.listSourceCandidates(guard.context, String(req.params.id)) })
  })

  router.get("/knowledge-bases/:id/wiki/pages", (req: Request, res: Response) => {
    const guard = requireAdminKb(req, res)
    if (!guard) return
    res.json({ pages: guard.service.listWikiPages(guard.context, String(req.params.id)) })
  })

  router.post("/knowledge-bases/:id/wiki/generate", async (req: Request, res: Response) => {
    const guard = requireAdminKb(req, res)
    if (!guard) return
    if (!chatClient || !model) {
      res.status(503).json({ error: "wiki generation is not wired in this deployment" })
      return
    }
    const body = req.body as { title?: unknown; documentIds?: unknown }
    const title = typeof body.title === "string" ? body.title.trim() : ""
    if (!title || title.length > MAX_TITLE_CHARS) {
      res.status(400).json({ error: `title is required (1-${MAX_TITLE_CHARS} characters)` })
      return
    }
    const documentIds = Array.isArray(body.documentIds)
      ? body.documentIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : []
    try {
      const outcome: WikiGenerationOutcome = await guard.service.generate({
        context: guard.context,
        knowledgeBaseId: String(req.params.id),
        title,
        documentIds,
      })
      if (outcome.status === "rejected") {
        // 422: the model output failed the deterministic publication gate.
        // Nothing was written — the current page is untouched.
        res.status(422).json({
          status: outcome.status,
          reasons: outcome.reasons,
          draft: outcome.draft.slice(0, 2000),
        })
        return
      }
      res.json({
        status: outcome.status,
        documentId: outcome.submission.docId,
        ingestion: outcome.submission.status,
        version: outcome.submission.version,
        title: outcome.title,
        sources: outcome.sources.map((source) => ({
          documentId: source.documentId,
          version: source.version,
          title: source.title,
        })),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof Error && error.name === "WikiGenerationModelError") {
        res.status(502).json({ error: message })
        return
      }
      res.status(400).json({ error: message })
    }
  })

  router.post("/knowledge-bases/:id/wiki/pages/:docId/restore", async (req: Request, res: Response) => {
    const guard = requireAdminKb(req, res)
    if (!guard) return
    try {
      const outcome = guard.service.restore({
        context: guard.context,
        knowledgeBaseId: String(req.params.id),
        documentId: String(req.params.docId),
      })
      res.json({
        status: outcome.status,
        title: outcome.title,
        documentId: outcome.submission.docId,
        version: outcome.submission.version,
        ingestion: outcome.submission.status,
      })
    } catch (error) {
      if (error instanceof WikiPageNotFoundError) {
        res.status(404).json({ error: "wiki page not found" })
        return
      }
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  return router
}
