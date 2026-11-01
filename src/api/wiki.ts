import { Router, type Request, type Response } from "express"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
import type { KnowledgeBaseService } from "../knowledge/knowledge_base_service"
import type { DB } from "../ingestion/tracking/db"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import { WikiStore, type WikiPage } from "../wiki/store"
import { canReadWikiPage, visibleWikiPages } from "../wiki/access"
import type { WikiAgent } from "../wiki/agent"
import { taskTraceFromScope } from "../tracing/contract"
import { requestScope } from "../tracing/express"

const MAX_TEXT = 100_000
const MAX_TITLE = 512

function context(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

function admin(ctx: AccessContext): boolean {
  return ctx.scopes.includes("admin")
}

function text(value: unknown, max = MAX_TEXT): string | null {
  return typeof value === "string" && value.trim() && value.length <= max
    ? value.trim() : null
}

function list(value: unknown): string[] | null {
  return Array.isArray(value) && value.length <= 100 &&
    value.every((item) => typeof item === "string" && item.length <= 200)
    ? value as string[] : null
}

export function createWikiRouter(options: {
  knowledgeBaseService: KnowledgeBaseService
  db: DB
  agent?: WikiAgent
}): Router {
  const router = Router()
  const store = new WikiStore(options.db)
  const documents = new DocumentRepo(options.db)

  const scope = (req: Request, res: Response, needsAdmin = false): {
    ctx: AccessContext; kbId: string
  } | null => {
    const ctx = context(res)
    const kbId = String(req.params.id)
    if (needsAdmin && !admin(ctx)) {
      res.status(403).json({ error: "administrator access required" })
      return null
    }
    const kb = options.knowledgeBaseService.getById(kbId, ctx.tenantId)
    if (!kb) {
      res.status(404).json({ error: "knowledge base not found" })
      return null
    }
    if (needsAdmin && kb.status !== "active") {
      res.status(409).json({ error: "knowledge base is archived" })
      return null
    }
    return { ctx, kbId }
  }

  const readable = (page: WikiPage, ctx: AccessContext): boolean =>
    canReadWikiPage(page, ctx, documents)

  const pageFor = (req: Request, res: Response, needsAdmin = false): {
    ctx: AccessContext; kbId: string; page: WikiPage
  } | null => {
    const guard = scope(req, res, needsAdmin)
    if (!guard) return null
    const page = store.get(guard.ctx.tenantId, guard.kbId, String(req.params.slug))
    if (!page || (!needsAdmin && !readable(page, guard.ctx))) {
      res.status(404).json({ error: "wiki page not found" })
      return null
    }
    return { ...guard, page }
  }

  const allPages = (tenantId: string, kbId: string, includeArchived = false): WikiPage[] => {
    const pages: WikiPage[] = []
    for (let offset = 0; ; offset += 500) {
      const batch = store.list(tenantId, kbId, { includeArchived, limit: 500, offset })
      pages.push(...batch)
      if (batch.length < 500) return pages
    }
  }

  const refreshLinks = (tenantId: string, kbId: string): void => {
    const pages = allPages(tenantId, kbId, true)
    const incoming = new Map<string, string[]>()
    const outgoing = new Map<string, string[]>()
    for (const page of pages.filter((item) => item.status === "published")) {
      const out = [...new Set([...page.content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)]
        .map((match) => match[1].trim()))]
      outgoing.set(page.slug, out)
      for (const slug of out) incoming.set(slug,
        [...(incoming.get(slug) ?? []), page.slug])
    }
    const update = options.db.prepare(`UPDATE wiki_pages SET in_links = ?, out_links = ?
      WHERE id = ? AND tenant_id = ? AND knowledge_base_id = ?`)
    options.db.transaction(() => {
      for (const page of pages) update.run(
        JSON.stringify(incoming.get(page.slug) ?? []),
        JSON.stringify(outgoing.get(page.slug) ?? []), page.id, tenantId, kbId
      )
    })()
  }

  router.get("/knowledge-bases/:id/wiki/settings", (req, res) => {
    const guard = scope(req, res)
    if (guard) res.json({ enabled: store.enabled(guard.ctx.tenantId, guard.kbId) })
  })
  router.post("/knowledge-bases/:id/wiki/agent", async (req, res) => {
    const guard = scope(req, res, true)
    if (!guard) return
    if (!options.agent) { res.status(503).json({ error: "Wiki agent unavailable" }); return }
    if (!store.enabled(guard.ctx.tenantId, guard.kbId)) {
      res.status(409).json({ error: "wiki is disabled" }); return
    }
    const message = text(req.body?.message, 8000)
    if (!message) { res.status(400).json({ error: "message required" }); return }
    const controller = new AbortController()
    const onClose = () => { if (!res.writableEnded) controller.abort() }
    res.on("close", onClose)
    try {
      res.json(await options.agent.run(message, guard.ctx, guard.kbId, controller.signal))
    } catch (error) {
      if (!controller.signal.aborted) res.status(502).json({ error:
        error instanceof Error ? error.message : "Wiki agent failed" })
    } finally { res.off("close", onClose) }
  })
  router.put("/knowledge-bases/:id/wiki/settings", (req, res) => {
    const guard = scope(req, res, true)
    if (!guard) return
    if (typeof req.body?.enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be boolean" }); return
    }
    store.setEnabled(guard.ctx.tenantId, guard.kbId, req.body.enabled)
    res.json({ enabled: req.body.enabled })
  })

  router.post("/knowledge-bases/:id/wiki/rebuild", (req, res) => {
    const guard = scope(req, res, true)
    if (!guard) return
    if (!store.enabled(guard.ctx.tenantId, guard.kbId)) {
      res.status(409).json({ error: "wiki is disabled" }); return
    }
    const rows = options.db.prepare(`SELECT d.doc_id, d.source_id FROM documents d
      JOIN sources s ON s.active_doc_id = d.doc_id
      WHERE d.tenant_id = ? AND d.knowledge_base_id = ?
        AND s.lifecycle_state = 'active' AND d.status = 'completed'
        AND s.source_kind <> 'wiki'`).all(
      guard.ctx.tenantId, guard.kbId
    ) as Array<{ doc_id: string; source_id: string }>
    // LO-16: the rebuild is one operator action — every job it enqueues
    // continues THIS request's trace.
    const trace = taskTraceFromScope(requestScope(res))
    for (const row of rows) store.enqueue(guard.ctx.tenantId, guard.kbId,
      row.doc_id, row.source_id, "ingest", trace)
    res.status(202).json({ enqueued: rows.length })
  })

  router.get("/knowledge-bases/:id/wiki/pages", (req, res) => {
    const guard = scope(req, res)
    if (!guard) return
    const query = typeof req.query.q === "string" ? req.query.q.slice(0, 200) : ""
    const includeArchived = admin(guard.ctx) && req.query.includeArchived === "true"
    const limit = Math.min(500, Math.max(1, Math.trunc(Number(req.query.limit)) || 100))
    const offset = Math.max(0, Math.trunc(Number(req.query.offset)) || 0)
    const pages = visibleWikiPages(store, documents, guard.ctx, guard.kbId,
      { query, includeArchived })
    res.json({ pages: pages.slice(offset, offset + limit), total: pages.length, limit, offset })
  })

  router.get("/knowledge-bases/:id/wiki/pages/:slug", (req, res) => {
    const guard = pageFor(req, res)
    if (!guard) return
    res.json({ page: guard.page,
      sources: guard.page.sourceRefs.flatMap((id) => {
        const doc = documents.get(id)
        return doc && doc.tenantId === guard.ctx.tenantId ? [{ id: doc.id, title: doc.title }] : []
      }),
      proposal: admin(guard.ctx) ? store.proposal(guard.page.id) : null })
  })

  router.post("/knowledge-bases/:id/wiki/pages", (req, res) => {
    const guard = scope(req, res, true)
    if (!guard) return
    const slug = text(req.body?.slug, 255)
    const title = text(req.body?.title, MAX_TITLE)
    const content = text(req.body?.content)
    if (!slug || !title || !content || store.get(guard.ctx.tenantId, guard.kbId, slug)) {
      res.status(400).json({ error: "valid, unique slug, title and content required" }); return
    }
    const page = store.save({
      tenantId: guard.ctx.tenantId, knowledgeBaseId: guard.kbId, slug, title,
      pageType: text(req.body?.pageType, 32) ?? "concept", status: "published",
      content, summary: typeof req.body?.summary === "string" ? req.body.summary.slice(0, 2000) : "",
      aliases: list(req.body?.aliases) ?? [], folderId: "", sourceRefs: [],
      chunkRefs: [], inLinks: [], outLinks: [], lastEditSource: "user",
    })
    refreshLinks(guard.ctx.tenantId, guard.kbId)
    res.status(201).json({ page })
  })

  router.patch("/knowledge-bases/:id/wiki/pages/:slug", (req, res) => {
    const guard = pageFor(req, res, true)
    if (!guard) return
    const title = req.body?.title === undefined ? guard.page.title : text(req.body.title, MAX_TITLE)
    const content = req.body?.content === undefined ? guard.page.content : text(req.body.content)
    const summary = req.body?.summary === undefined ? guard.page.summary
      : typeof req.body.summary === "string" && req.body.summary.length <= 2000
        ? req.body.summary.trim() : null
    const version = Number(req.body?.expectedVersion)
    if (!title || !content || summary === null || version !== guard.page.version) {
      res.status(version !== guard.page.version ? 409 : 400)
        .json({ error: "invalid fields or version conflict" }); return
    }
    const slug = req.body?.slug === undefined ? guard.page.slug : text(req.body.slug, 255)
    if (!slug) { res.status(400).json({ error: "invalid slug" }); return }
    const owner = store.get(guard.ctx.tenantId, guard.kbId, slug)
    if (owner && owner.id !== guard.page.id) {
      res.status(409).json({ error: "wiki page slug already exists" }); return
    }
    const updated = options.db.transaction(() => {
      const saved = store.save({
        ...guard.page, slug, title, content, summary,
        aliases: req.body?.aliases === undefined ? guard.page.aliases
          : list(req.body.aliases) ?? guard.page.aliases,
        lastEditSource: "user", expectedVersion: guard.page.version,
      })
      if (slug !== guard.page.slug) {
        // Reuse the rename path to rewrite incoming links without a second page revision.
        store.rewriteIncomingLinks(guard.page, slug, "user")
      }
      return saved
    })()
    refreshLinks(guard.ctx.tenantId, guard.kbId)
    res.json({ page: updated })
  })

  router.delete("/knowledge-bases/:id/wiki/pages/:slug", (req, res) => {
    const guard = pageFor(req, res, true)
    if (!guard) return
    const page = store.archive(guard.page, "user")
    refreshLinks(guard.ctx.tenantId, guard.kbId)
    res.json({ page })
  })

  router.get("/knowledge-bases/:id/wiki/pages/:slug/revisions", (req, res) => {
    const guard = pageFor(req, res, true)
    if (guard) res.json({ revisions: store.revisions(guard.page.id) })
  })
  router.post("/knowledge-bases/:id/wiki/pages/:slug/revert", (req, res) => {
    const guard = pageFor(req, res, true)
    if (!guard) return
    const revision = store.revisions(guard.page.id).find(
      (item) => item.version === Number(req.body?.version))
    if (!revision) { res.status(404).json({ error: "revision not found" }); return }
    const page = store.save({ ...guard.page, title: revision.title,
      content: revision.content, summary: revision.summary, status: revision.status,
      sourceRefs: revision.sourceRefs, chunkRefs: revision.chunkRefs,
      lastEditSource: "revert", expectedVersion: guard.page.version })
    refreshLinks(guard.ctx.tenantId, guard.kbId)
    res.json({ page })
  })
  router.post("/knowledge-bases/:id/wiki/pages/:slug/accept-proposal", (req, res) => {
    const guard = pageFor(req, res, true)
    if (!guard) return
    const proposal = store.proposal(guard.page.id)
    if (!proposal) { res.status(404).json({ error: "proposal not found" }); return }
    if (proposal.baseVersion !== guard.page.version) {
      res.status(409).json({ error: "page changed since proposal" }); return
    }
    const page = store.save({ ...guard.page, content: proposal.content,
      summary: proposal.summary, sourceRefs: proposal.sourceRefs,
      chunkRefs: proposal.chunkRefs, status: "published",
      lastEditSource: "user", expectedVersion: guard.page.version })
    store.clearProposal(page.id)
    refreshLinks(guard.ctx.tenantId, guard.kbId)
    res.json({ page })
  })

  router.get("/knowledge-bases/:id/wiki/folders", (req, res) => {
    const guard = scope(req, res)
    if (guard) res.json({ folders: store.listFolders(guard.ctx.tenantId, guard.kbId) })
  })
  router.post("/knowledge-bases/:id/wiki/folders", (req, res) => {
    const guard = scope(req, res, true)
    if (!guard) return
    const name = text(req.body?.name, 200)
    const parentId = typeof req.body?.parentId === "string" ? req.body.parentId : ""
    if (!name || (parentId && !store.listFolders(guard.ctx.tenantId, guard.kbId)
      .some((folder) => folder.id === parentId))) {
      res.status(400).json({ error: "invalid folder name or parent" }); return
    }
    res.status(201).json({ folder: store.createFolder(guard.ctx.tenantId,
      guard.kbId, name, parentId) })
  })
  router.patch("/knowledge-bases/:id/wiki/folders/:folderId", (req, res) => {
    const guard = scope(req, res, true)
    if (!guard) return
    const name = text(req.body?.name, 200)
    const parentId = typeof req.body?.parentId === "string" ? req.body.parentId : ""
    if (!name || !store.updateFolder(guard.ctx.tenantId, guard.kbId,
      String(req.params.folderId), name, parentId)) {
      res.status(400).json({ error: "invalid folder change" }); return
    }
    res.json({ status: "updated" })
  })
  router.delete("/knowledge-bases/:id/wiki/folders/:folderId", (req, res) => {
    const guard = scope(req, res, true)
    if (!guard) return
    if (!store.deleteFolder(guard.ctx.tenantId, guard.kbId,
      String(req.params.folderId))) {
      res.status(404).json({ error: "folder not found" }); return
    }
    res.json({ status: "deleted" })
  })
  router.post("/knowledge-bases/:id/wiki/pages/:slug/move", (req, res) => {
    const guard = pageFor(req, res, true)
    if (!guard) return
    const folderId = typeof req.body?.folderId === "string" ? req.body.folderId : ""
    if (folderId && !store.listFolders(guard.ctx.tenantId, guard.kbId)
      .some((folder) => folder.id === folderId)) {
      res.status(400).json({ error: "folder not found" }); return
    }
    store.movePage(guard.ctx.tenantId, guard.kbId, guard.page.slug, folderId)
    res.json({ status: "moved" })
  })

  router.get("/knowledge-bases/:id/wiki/graph", (req, res) => {
    const guard = scope(req, res)
    if (!guard) return
    const pages = allPages(guard.ctx.tenantId, guard.kbId)
      .filter((page) => readable(page, guard.ctx))
    const slugs = new Set(pages.map((page) => page.slug))
    res.json({ nodes: pages.map(({ slug, title, pageType }) => ({ slug, title, pageType })),
      edges: pages.flatMap((page) => page.outLinks.filter((slug) => slugs.has(slug))
        .map((slug) => ({ source: page.slug, target: slug }))) })
  })
  router.get("/knowledge-bases/:id/wiki/stats", (req, res) => {
    const guard = scope(req, res)
    if (!guard) return
    const pages = allPages(guard.ctx.tenantId, guard.kbId)
      .filter((page) => readable(page, guard.ctx))
    res.json({ pages: pages.length,
      byType: Object.fromEntries([...new Set(pages.map((page) => page.pageType))]
        .map((type) => [type, pages.filter((page) => page.pageType === type).length])),
      links: pages.reduce((sum, page) => sum + page.outLinks.length, 0) })
  })
  router.get("/knowledge-bases/:id/wiki/index", (req, res) => {
    const guard = scope(req, res)
    if (!guard) return
    const pages = allPages(guard.ctx.tenantId, guard.kbId)
      .filter((page) => readable(page, guard.ctx))
    const groups = new Map<string, Array<{
      slug: string; title: string; summary: string; folderId: string
    }>>()
    for (const page of pages) {
      groups.set(page.pageType, [...(groups.get(page.pageType) ?? []), {
        slug: page.slug, title: page.title, summary: page.summary,
        folderId: page.folderId,
      }])
    }
    res.json({ groups: [...groups].map(([type, entries]) => ({ type, pages: entries })) })
  })
  router.get("/knowledge-bases/:id/wiki/lint", (req, res) => {
    const guard = scope(req, res, true)
    if (!guard) return
    const pages = allPages(guard.ctx.tenantId, guard.kbId)
    const slugs = new Set(pages.map((page) => page.slug))
    res.json({ findings: pages.flatMap((page) => [
      ...page.outLinks.filter((slug) => !slugs.has(slug)).map((slug) => ({
        slug: page.slug, kind: "broken_link", target: slug })),
      ...(page.sourceRefs.length === 0 && page.lastEditSource === "pipeline"
        ? [{ slug: page.slug, kind: "missing_source" }] : []),
    ]) })
  })
  router.post("/knowledge-bases/:id/wiki/rebuild-links", (req, res) => {
    const guard = scope(req, res, true)
    if (!guard) return
    refreshLinks(guard.ctx.tenantId, guard.kbId)
    res.json({ status: "rebuilt" })
  })
  router.get("/knowledge-bases/:id/wiki/issues", (req, res) => {
    const guard = scope(req, res, true)
    if (guard) res.json({ issues: store.issues(guard.ctx.tenantId, guard.kbId) })
  })
  router.post("/knowledge-bases/:id/wiki/pages/:slug/issues", (req, res) => {
    const guard = pageFor(req, res, true)
    if (!guard) return
    const message = text(req.body?.message, 2000)
    if (!message) { res.status(400).json({ error: "message required" }); return }
    res.status(201).json({ issue: store.createIssue(guard.ctx.tenantId,
      guard.kbId, guard.page.id, text(req.body?.kind, 64) ?? "content", message) })
  })
  router.patch("/knowledge-bases/:id/wiki/issues/:issueId", (req, res) => {
    const guard = scope(req, res, true)
    if (!guard) return
    const status = req.body?.status
    if (!["open", "resolved", "dismissed"].includes(status) ||
      !store.updateIssue(guard.ctx.tenantId, guard.kbId,
        String(req.params.issueId), status)) {
      res.status(400).json({ error: "invalid issue update" }); return
    }
    res.json({ status })
  })
  router.get("/knowledge-bases/:id/wiki/jobs", (req, res) => {
    const guard = scope(req, res, true)
    if (guard) res.json({ jobs: store.jobs(guard.ctx.tenantId, guard.kbId) })
  })
  router.post("/knowledge-bases/:id/wiki/jobs/:jobId/retry", (req, res) => {
    const guard = scope(req, res, true)
    if (!guard) return
    if (!store.retryJob(Number(req.params.jobId), guard.ctx.tenantId, guard.kbId)) {
      res.status(404).json({ error: "failed job not found" }); return
    }
    res.status(202).json({ status: "pending" })
  })
  return router
}
