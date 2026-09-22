/**
 * Ticket 30 (FAQ-01A) — the FAQ management API.
 *
 *   GET    /knowledge-bases/:id/faqs                list (status filter)
 *   POST   /knowledge-bases/:id/faqs                create a versioned entry
 *   GET    /knowledge-bases/:id/faqs/:faqId         one entry + current version
 *   PATCH  /knowledge-bases/:id/faqs/:faqId         edit → new immutable version
 *   GET    /knowledge-bases/:id/faqs/:faqId/versions  history (never rewritten)
 *   POST   /knowledge-bases/:id/faqs/:faqId/activate  (conflict-checked)
 *   POST   /knowledge-bases/:id/faqs/:faqId/disable
 *   POST   /knowledge-bases/:id/faqs/import         {format: json|csv, content}
 *
 * Knowledge scoping goes through the SAME server-side resolver the chat path
 * uses: an unknown or cross-tenant knowledge base is a 404 and an archived one
 * a 409, before this router touches an entry. Management is an admin surface —
 * a reader account is refused (403) on every route.
 */

import { Router, type Request, type Response } from "express"
import { singleTenantAccessContext, type AccessContext } from "../access/context"
import type { RetrievalScopeResolver } from "../retrieval/scope"
import { resolveScopeOrRespond } from "./scope_http"
import {
  FaqConflictError,
  FaqEntryNotFoundError,
  InvalidFaqCommandError,
  type FaqEntryService,
} from "../faq/faq_entry_service"
import type { FaqEntryStatus } from "../types/faq"

function resolveContext(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

function requireAdmin(ctx: AccessContext, res: Response): boolean {
  if (!ctx.scopes.includes("admin")) {
    res.status(403).json({ error: "missing scope: admin" })
    return false
  }
  return true
}

const VALID_STATUSES: readonly FaqEntryStatus[] = ["active", "disabled"]

export interface FaqEntriesRouterDeps {
  faqEntries: FaqEntryService
  /** The production retrieval-scope resolver — one KB id, same 404/409/400. */
  scopeResolver: RetrievalScopeResolver
}

export function createFaqEntriesRouter(deps: FaqEntriesRouterDeps): Router {
  const router = Router()

  /** Resolve the knowledge base of this request, or answer and return null. */
  const knowledgeBaseId = (
    res: Response,
    ctx: AccessContext,
    params: Request["params"]
  ): string | null => {
    const scope = resolveScopeOrRespond(res, deps.scopeResolver, ctx, [String(params.id)])
    if (!scope) return null
    // resolveScopeOrRespond answers 404 for anything that does not resolve to
    // exactly one base, so the first id is the resolved one.
    return scope.knowledgeBaseIds[0] ?? null
  }

  const handle = <T>(
    res: Response,
    action: () => T | null,
    onNull: () => void
  ): void => {
    try {
      const result = action()
      if (result === null) {
        onNull()
        return
      }
      res.json(result)
    } catch (error) {
      if (error instanceof FaqEntryNotFoundError) {
        res.status(404).json({ error: "faq entry not found in this knowledge base" })
        return
      }
      if (error instanceof InvalidFaqCommandError) {
        res.status(400).json({ error: error.message, issues: error.issues })
        return
      }
      if (error instanceof FaqConflictError) {
        res.status(409).json({ error: error.message, conflict: error.detail })
        return
      }
      throw error
    }
  }

  router.get("/knowledge-bases/:id/faqs", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    const status = req.query.status
    if (status !== undefined && !VALID_STATUSES.includes(status as FaqEntryStatus)) {
      res.status(400).json({ error: "invalid status filter", status })
      return
    }
    const kbId = knowledgeBaseId(res, ctx, req.params)
    if (!kbId) return
    handle(
      res,
      () => ({
        entries: deps.faqEntries.list(ctx.tenantId, kbId, {
          ...(status !== undefined ? { status: status as FaqEntryStatus } : {}),
        }),
      }),
      () => res.status(404).json({ error: "knowledge base not found" })
    )
  })

  router.post("/knowledge-bases/:id/faqs", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    const kbId = knowledgeBaseId(res, ctx, req.params)
    if (!kbId) return
    const body = (req.body ?? {}) as Record<string, unknown>
    handle(
      res,
      () => ({
        entry: deps.faqEntries.create(
          ctx.tenantId,
          kbId,
          {
            question: body.question,
            answer: body.answer,
            ...("variants" in body ? { variants: body.variants } : {}),
            ...("source" in body ? { source: body.source } : {}),
          },
          ctx.subjectId
        ),
      }),
      () => res.status(404).json({ error: "knowledge base not found" })
    )
  })

  /**
   * Import must be registered before the :faqId routes so "import" is never
   * read as an entry id.
   */
  router.post("/knowledge-bases/:id/faqs/import", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    const kbId = knowledgeBaseId(res, ctx, req.params)
    if (!kbId) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const format = body.format
    if (format !== "json" && format !== "csv") {
      res.status(400).json({ error: 'format must be "json" or "csv"', issues: ["format"] })
      return
    }
    if (typeof body.content !== "string") {
      res.status(400).json({ error: "content must be the file text", issues: ["content"] })
      return
    }
    handle(
      res,
      () => ({
        result: deps.faqEntries.importEntries(
          ctx.tenantId,
          kbId,
          { format, content: body.content as string },
          ctx.subjectId
        ),
      }),
      () => res.status(404).json({ error: "knowledge base not found" })
    )
  })

  router.get("/knowledge-bases/:id/faqs/:faqId", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    const kbId = knowledgeBaseId(res, ctx, req.params)
    if (!kbId) return
    handle(
      res,
      () => {
        const entry = deps.faqEntries.get(ctx.tenantId, kbId, String(req.params.faqId))
        return entry ? { entry } : null
      },
      () => res.status(404).json({ error: "faq entry not found in this knowledge base" })
    )
  })

  router.patch("/knowledge-bases/:id/faqs/:faqId", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    const kbId = knowledgeBaseId(res, ctx, req.params)
    if (!kbId) return
    const body = (req.body ?? {}) as Record<string, unknown>
    handle(
      res,
      () => ({
        // Only the submitted fields travel: the service merges them with the
        // current version it reads itself, so this handler never rebuilds a
        // stale snapshot of the entry.
        entry: deps.faqEntries.edit(
          ctx.tenantId,
          kbId,
          String(req.params.faqId),
          {
            ...("question" in body ? { question: body.question } : {}),
            ...("answer" in body ? { answer: body.answer } : {}),
            ...("variants" in body ? { variants: body.variants } : {}),
            ...("source" in body ? { source: body.source } : {}),
          },
          ctx.subjectId
        ),
      }),
      () => res.status(404).json({ error: "faq entry not found in this knowledge base" })
    )
  })

  router.get(
    "/knowledge-bases/:id/faqs/:faqId/versions",
    (req: Request, res: Response) => {
      const ctx = resolveContext(res)
      if (!requireAdmin(ctx, res)) return
      const kbId = knowledgeBaseId(res, ctx, req.params)
      if (!kbId) return
      handle(
        res,
        () => ({
          versions: deps.faqEntries.listVersions(
            ctx.tenantId,
            kbId,
            String(req.params.faqId)
          ),
        }),
        () => res.status(404).json({ error: "faq entry not found in this knowledge base" })
      )
    }
  )

  const setStatus = (status: FaqEntryStatus) => (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    const kbId = knowledgeBaseId(res, ctx, req.params)
    if (!kbId) return
    const id = String(req.params.faqId)
    handle(
      res,
      () => ({
        entry:
          status === "active"
            ? deps.faqEntries.activate(ctx.tenantId, kbId, id)
            : deps.faqEntries.disable(ctx.tenantId, kbId, id),
      }),
      () => res.status(404).json({ error: "faq entry not found in this knowledge base" })
    )
  }

  router.post("/knowledge-bases/:id/faqs/:faqId/activate", setStatus("active"))
  router.post("/knowledge-bases/:id/faqs/:faqId/disable", setStatus("disabled"))

  return router
}
