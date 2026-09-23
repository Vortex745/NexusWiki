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
  SyncSourceNotFoundError,
  type SyncDataSource,
} from "../sync/data_source_service"

/**
 * Ticket 39 (SYNC-01A): the URL/sitemap data-source HTTP contract.
 *
 *   GET    /knowledge-bases/:id/sync-data-sources
 *   POST   /knowledge-bases/:id/sync-data-sources        { kind, uri, interval?, title? }
 *   PATCH  /sync-data-sources/:id                        { interval?, state? }
 *   POST   /sync-data-sources/:id/run                    — one safe manual sync
 *   DELETE /sync-data-sources/:id
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
    try {
      const report = await guard.service.runOnce(guard.context.tenantId, String(req.params.id))
      res.json({ report })
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  return router
}
