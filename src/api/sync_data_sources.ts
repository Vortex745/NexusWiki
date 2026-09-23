import { Router, type Request, type Response } from "express"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
import type { KnowledgeBaseService } from "../knowledge/knowledge_base_service"
import type { DB } from "../ingestion/tracking/db"
import { createIngestionLifecycle } from "../ingestion/pipeline"
import type { FetchOptions } from "../ingestion/url_fetcher"
import {
  InvalidSyncSourceError,
  SyncDataSourceService,
  SyncPageNotFoundError,
  SyncPageRetirementConflictError,
  SyncSourceNotFoundError,
  type SyncDataSource,
} from "../sync/data_source_service"
import { SyncRunConflictError, SyncRunService } from "../sync/sync_run_service"

/**
 * Ticket 39 (SYNC-01A): the URL/sitemap data-source HTTP contract.
 *
 *   GET    /knowledge-bases/:id/sync-data-sources
 *   POST   /knowledge-bases/:id/sync-data-sources        { kind, uri, interval?, title? }
 *   PATCH  /sync-data-sources/:id                        { interval?, state? }
 *   POST   /sync-data-sources/:id/run                    — one safe manual sync
 *   DELETE /sync-data-sources/:id
 *
 * Ticket 41 (SYNC-02): operate runs and confirm safe retirement.
 *
 *   GET    /sync-data-sources/:id/runs/:runId            — run detail + run-log pages
 *   GET    /sync-data-sources/:id/pages                  — per-page presence ledger
 *   POST   /sync-data-sources/:id/pages/retire { uri }   — explicit retirement confirmation
 *
 * Administrators only (the ticket names administrators as the actor); every
 * route resolves the tenant from the AccessContext and the KB ownership
 * check mirrors the catalog (unknown/cross-tenant base = the same 404).
 * The run endpoint reuses the module-owned service — safe fetching plus the
 * NORMAL ingestion lifecycle — and returns a per-page report where identical
 * content is "unchanged" and failures name the resource without ever
 * touching the previous active version.
 */

function accessContext(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

function isAdmin(context: AccessContext): boolean {
  return context.scopes.includes("admin")
}

function sourcePayload(source: SyncDataSource) {
  return {
    id: source.id,
    knowledgeBaseId: source.knowledgeBaseId,
    kind: source.kind,
    uri: source.uri,
    interval: source.interval,
    state: source.state,
    title: source.title,
    lastSyncAt: source.lastSyncAt,
    lastSyncStatus: source.lastSyncStatus,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  }
}

function errorStatus(error: unknown): number {
  if (error instanceof SyncSourceNotFoundError) return 404
  if (error instanceof SyncPageNotFoundError) return 404
  if (error instanceof SyncPageRetirementConflictError) return 409
  if (error instanceof InvalidSyncSourceError) return 400
  return 500
}

export function createSyncDataSourcesRouter(options: {
  knowledgeBaseService: KnowledgeBaseService
  db: DB
  /** Safe-fetch overrides (tests inject synthetic resolvers/fetches). */
  fetchOptions?: FetchOptions
}): Router {
  const { knowledgeBaseService, db, fetchOptions } = options
  const router = Router()

  const serviceFor = (): SyncDataSourceService =>
    new SyncDataSourceService({
      db,
      // Same per-request lifecycle pattern as the ingest routes.
      lifecycle: createIngestionLifecycle(db),
      ...(fetchOptions ? { fetchOptions } : {}),
    })

  const requireAdmin = (req: Request, res: Response): AccessContext | null => {
    const context = accessContext(res)
    if (!isAdmin(context)) {
      res.status(403).json({ error: "administrator access required" })
      return null
    }
    return context
  }

  const requireAdminKb = (
    req: Request,
    res: Response
  ): { context: AccessContext; service: SyncDataSourceService } | null => {
    const context = requireAdmin(req, res)
    if (!context) return null
    const known = knowledgeBaseService
      .list(context.tenantId)
      .some((base) => base.id === req.params.id)
    if (!known) {
      res.status(404).json({ error: "knowledge base not found" })
      return null
    }
    return { context, service: serviceFor() }
  }

  const requireSource = (
    req: Request,
    res: Response
  ): { context: AccessContext; service: SyncDataSourceService } | null => {
    const context = requireAdmin(req, res)
    if (!context) return null
    return { context, service: serviceFor() }
  }

  router.get("/knowledge-bases/:id/sync-data-sources", (req: Request, res: Response) => {
    const guard = requireAdminKb(req, res)
    if (!guard) return
    res.json({
      sources: guard.service.list(guard.context.tenantId, String(req.params.id)).map(sourcePayload),
    })
  })

  router.post("/knowledge-bases/:id/sync-data-sources", (req: Request, res: Response) => {
    const guard = requireAdminKb(req, res)
    if (!guard) return
    const body = req.body as { kind?: unknown; uri?: unknown; interval?: unknown; title?: unknown }
    try {
      const source = guard.service.create({
        tenantId: guard.context.tenantId,
        knowledgeBaseId: String(req.params.id),
        kind: body.kind as never,
        uri: typeof body.uri === "string" ? body.uri : "",
        ...(typeof body.interval === "string" ? { interval: body.interval as never } : {}),
        ...(typeof body.title === "string" && body.title.trim()
          ? { title: body.title.trim() }
          : {}),
      })
      res.status(201).json({ source: sourcePayload(source) })
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.patch("/sync-data-sources/:id", (req: Request, res: Response) => {
    const guard = requireSource(req, res)
    if (!guard) return
    const body = req.body as { interval?: unknown; state?: unknown }
    try {
      const source = guard.service.update(guard.context.tenantId, String(req.params.id), {
        ...(typeof body.interval === "string" ? { interval: body.interval as never } : {}),
        ...(typeof body.state === "string" ? { state: body.state as never } : {}),
      })
      res.json({ source: sourcePayload(source) })
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.delete("/sync-data-sources/:id", (req: Request, res: Response) => {
    const guard = requireSource(req, res)
    if (!guard) return
    try {
      // Existence is checked (and 404 semantics kept) by the service.
      guard.service.get(guard.context.tenantId, String(req.params.id))
      guard.service.delete(guard.context.tenantId, String(req.params.id))
      res.json({ deleted: true })
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.post("/sync-data-sources/:id/run", async (req: Request, res: Response) => {
    const guard = requireSource(req, res)
    if (!guard) return
    // Ticket 40 (SYNC-01B): the trigger is a DURABLE run — enqueue, claim and
    // execute through the run service. A concurrent trigger for the same
    // source loses the single-active-run claim with an explicit 409.
    const runService = new SyncRunService({
      db,
      lifecycle: createIngestionLifecycle(db),
    })
    try {
      const run = await runService.runNow(guard.context.tenantId, String(req.params.id))
      res.json({ run })
    } catch (error) {
      if (error instanceof SyncRunConflictError) {
        res.status(409).json({ error: error.message, activeRunId: error.activeRunId })
        return
      }
      res.status(errorStatus(error)).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.get("/sync-data-sources/:id/runs", (req: Request, res: Response) => {
    const guard = requireSource(req, res)
    if (!guard) return
    try {
      // 404 semantics for an unknown source come from the data-source service.
      guard.service.get(guard.context.tenantId, String(req.params.id))
      const runService = new SyncRunService({
        db,
        lifecycle: createIngestionLifecycle(db),
      })
      res.json({ runs: runService.listRuns(guard.context.tenantId, String(req.params.id)) })
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  // Ticket 41 (SYNC-02): the run detail — one run plus its durable per-page
  // run-log, where success/unchanged/timeout/rate-limit/invalid-url are
  // distinguishable (status + failure_kind per page).
  router.get("/sync-data-sources/:id/runs/:runId", (req: Request, res: Response) => {
    const guard = requireSource(req, res)
    if (!guard) return
    try {
      guard.service.get(guard.context.tenantId, String(req.params.id))
      const runService = new SyncRunService({
        db,
        lifecycle: createIngestionLifecycle(db),
      })
      const run = runService.getRun(
        guard.context.tenantId,
        String(req.params.id),
        String(req.params.runId)
      )
      if (!run) {
        res.status(404).json({ error: "sync run not found" })
        return
      }
      res.json({ run, pages: runService.listRunPages(run.id) })
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  // Ticket 41 (SYNC-02): the per-page presence ledger — miss counts and
  // retirement states an operator inspects before confirming retirement.
  router.get("/sync-data-sources/:id/pages", (req: Request, res: Response) => {
    const guard = requireSource(req, res)
    if (!guard) return
    try {
      res.json({ pages: guard.service.listPages(guard.context.tenantId, String(req.params.id)) })
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  // Ticket 41 (SYNC-02): explicit administrator confirmation. Only a page
  // marked 'pending_retirement' (TWO consecutive missing-page observations)
  // can be retired — anything else is a 400, never a silent success.
  router.post("/sync-data-sources/:id/pages/retire", (req: Request, res: Response) => {
    const guard = requireSource(req, res)
    if (!guard) return
    const body = req.body as { uri?: unknown }
    if (typeof body.uri !== "string" || body.uri.trim() === "") {
      res.status(400).json({ error: "uri is required" })
      return
    }
    try {
      const result = guard.service.confirmPageRetirement(
        guard.context.tenantId,
        String(req.params.id),
        body.uri,
        guard.context.subjectId
      )
      res.json(result)
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  return router
}
