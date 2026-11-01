import { randomUUID } from "node:crypto"
import type { DB } from "../ingestion/tracking/db"
import { readTaskTrace, type TaskTraceContext } from "../tracing/contract"

export type WikiPageStatus = "draft" | "published" | "archived"
export type WikiEditSource = "pipeline" | "user" | "agent" | "revert"

export interface WikiPage {
  id: string
  tenantId: string
  knowledgeBaseId: string
  slug: string
  title: string
  pageType: string
  status: WikiPageStatus
  content: string
  summary: string
  aliases: string[]
  folderId: string
  sourceRefs: string[]
  chunkRefs: string[]
  inLinks: string[]
  outLinks: string[]
  version: number
  lastEditSource: WikiEditSource
  createdAt: string
  updatedAt: string
}

export interface WikiContribution {
  pageId: string
  documentId: string
  sourceId: string
  content: string
  chunkRefs: string[]
  updatedAt: string
}

export interface WikiRevision {
  pageId: string
  version: number
  title: string
  content: string
  summary: string
  status: WikiPageStatus
  sourceRefs: string[]
  chunkRefs: string[]
  editSource: WikiEditSource
  createdAt: string
}

export interface WikiFolder {
  id: string
  tenantId: string
  knowledgeBaseId: string
  parentId: string
  name: string
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface WikiIssue {
  id: string
  tenantId: string
  knowledgeBaseId: string
  pageId: string
  kind: string
  message: string
  status: string
  createdAt: string
  updatedAt: string
}

export interface WikiJob {
  id: number
  tenantId: string
  knowledgeBaseId: string
  documentId: string
  sourceId: string
  op: "ingest" | "retract"
  status: "pending" | "running" | "completed" | "failed"
  attempts: number
  error: string | null
  /** LO-16: present only on a claimed job (never on list responses). */
  trace?: TaskTraceContext
  createdAt: string
  updatedAt: string
}

export interface WikiProposal {
  pageId: string
  baseVersion: number
  title: string
  content: string
  summary: string
  sourceRefs: string[]
  chunkRefs: string[]
  createdAt: string
}

type PageRow = {
  id: string; tenant_id: string; knowledge_base_id: string; slug: string
  title: string; page_type: string; status: WikiPageStatus; content: string
  summary: string; aliases: string; folder_id: string; source_refs: string
  chunk_refs: string; in_links: string; out_links: string; version: number
  last_edit_source: WikiEditSource; created_at: string; updated_at: string
}

const parseList = (value: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

function pageFromRow(row: PageRow): WikiPage {
  return {
    id: row.id, tenantId: row.tenant_id, knowledgeBaseId: row.knowledge_base_id,
    slug: row.slug, title: row.title, pageType: row.page_type, status: row.status,
    content: row.content, summary: row.summary, aliases: parseList(row.aliases),
    folderId: row.folder_id, sourceRefs: parseList(row.source_refs),
    chunkRefs: parseList(row.chunk_refs), inLinks: parseList(row.in_links),
    outLinks: parseList(row.out_links), version: row.version,
    lastEditSource: row.last_edit_source, createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class WikiStore {
  constructor(private readonly db: DB, private readonly now: () => Date = () => new Date()) {}

  enabled(tenantId: string, knowledgeBaseId: string): boolean {
    const row = this.db.prepare(
      "SELECT enabled FROM wiki_settings WHERE tenant_id = ? AND knowledge_base_id = ?"
    ).get(tenantId, knowledgeBaseId) as { enabled: number } | undefined
    return row?.enabled === 1
  }

  setEnabled(tenantId: string, knowledgeBaseId: string, enabled: boolean): void {
    this.db.prepare(`INSERT INTO wiki_settings (knowledge_base_id, tenant_id, enabled, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(knowledge_base_id) DO UPDATE SET
      enabled = excluded.enabled, updated_at = excluded.updated_at
      WHERE wiki_settings.tenant_id = excluded.tenant_id`).run(
      knowledgeBaseId, tenantId, enabled ? 1 : 0, this.now().toISOString()
    )
  }

  get(tenantId: string, knowledgeBaseId: string, slug: string): WikiPage | null {
    const row = this.db.prepare(`SELECT * FROM wiki_pages
      WHERE tenant_id = ? AND knowledge_base_id = ? AND slug = ?`).get(
      tenantId, knowledgeBaseId, slug
    ) as PageRow | undefined
    return row ? pageFromRow(row) : null
  }

  getById(tenantId: string, knowledgeBaseId: string, id: string): WikiPage | null {
    const row = this.db.prepare(`SELECT * FROM wiki_pages
      WHERE tenant_id = ? AND knowledge_base_id = ? AND id = ?`).get(
      tenantId, knowledgeBaseId, id
    ) as PageRow | undefined
    return row ? pageFromRow(row) : null
  }

  list(tenantId: string, knowledgeBaseId: string, options: {
    includeArchived?: boolean; query?: string; limit?: number; offset?: number
  } = {}): WikiPage[] {
    const query = options.query?.trim() ?? ""
    const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`
    const rows = this.db.prepare(`SELECT * FROM wiki_pages
      WHERE tenant_id = ? AND knowledge_base_id = ?
        AND (? = 1 OR status = 'published')
        AND (? = '' OR title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\'
          OR content LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\' OR aliases LIKE ? ESCAPE '\\')
      ORDER BY page_type, title, slug LIMIT ? OFFSET ?`).all(
      tenantId, knowledgeBaseId, options.includeArchived ? 1 : 0,
      query, pattern, pattern, pattern, pattern, pattern,
      Math.min(Math.max(options.limit ?? 100, 1), 500), Math.max(options.offset ?? 0, 0)
    ) as PageRow[]
    return rows.map(pageFromRow)
  }

  save(input: Omit<WikiPage, "id" | "version" | "createdAt" | "updatedAt"> & {
    id?: string; expectedVersion?: number
  }): WikiPage {
    const existing = input.id
      ? this.getById(input.tenantId, input.knowledgeBaseId, input.id)
      : this.get(input.tenantId, input.knowledgeBaseId, input.slug)
    const slugOwner = this.get(input.tenantId, input.knowledgeBaseId, input.slug)
    if (slugOwner && existing && slugOwner.id !== existing.id) {
      throw new Error("wiki page slug already exists")
    }
    const now = this.now().toISOString()
    if (existing && input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
      throw new Error("wiki page version conflict")
    }
    const next: WikiPage = {
      ...input, id: existing?.id ?? input.id ?? randomUUID(),
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? now, updatedAt: now,
    }
    const tx = this.db.transaction(() => {
      if (existing) this.snapshot(existing)
      if (existing && existing.slug !== input.slug) {
        const changed = this.db.prepare(`UPDATE wiki_pages SET slug = ?, title = ?,
          page_type = ?, status = ?, content = ?, summary = ?, aliases = ?,
          folder_id = ?, source_refs = ?, chunk_refs = ?, in_links = ?,
          out_links = ?, version = ?, last_edit_source = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND knowledge_base_id = ? AND version = ?`).run(
          next.slug, next.title, next.pageType, next.status, next.content,
          next.summary, JSON.stringify(next.aliases), next.folderId,
          JSON.stringify(next.sourceRefs), JSON.stringify(next.chunkRefs),
          JSON.stringify(next.inLinks), JSON.stringify(next.outLinks),
          next.version, next.lastEditSource, next.updatedAt, next.id,
          next.tenantId, next.knowledgeBaseId, existing.version
        )
        if (changed.changes !== 1) throw new Error("wiki page version conflict")
        return
      }
      this.db.prepare(`INSERT INTO wiki_pages (
        id, tenant_id, knowledge_base_id, slug, title, page_type, status,
        content, summary, aliases, folder_id, source_refs, chunk_refs,
        in_links, out_links, version, last_edit_source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(knowledge_base_id, slug) DO UPDATE SET
        title=excluded.title, page_type=excluded.page_type, status=excluded.status,
        content=excluded.content, summary=excluded.summary, aliases=excluded.aliases,
        folder_id=excluded.folder_id, source_refs=excluded.source_refs,
        chunk_refs=excluded.chunk_refs, in_links=excluded.in_links,
        out_links=excluded.out_links, version=excluded.version,
        last_edit_source=excluded.last_edit_source, updated_at=excluded.updated_at`).run(
        next.id, next.tenantId, next.knowledgeBaseId, next.slug, next.title,
        next.pageType, next.status, next.content, next.summary,
        JSON.stringify(next.aliases), next.folderId, JSON.stringify(next.sourceRefs),
        JSON.stringify(next.chunkRefs), JSON.stringify(next.inLinks),
        JSON.stringify(next.outLinks), next.version, next.lastEditSource,
        next.createdAt, next.updatedAt
      )
    })
    tx()
    return next
  }

  rename(page: WikiPage, slug: string, title: string, editSource: WikiEditSource): WikiPage {
    return this.db.transaction(() => {
      const renamed = this.save({ ...page, slug, title, lastEditSource: editSource,
        expectedVersion: page.version })
      this.rewriteIncomingLinks(page, slug, editSource)
      this.rebuildLinks(page.tenantId, page.knowledgeBaseId)
      return renamed
    })()
  }

  archive(page: WikiPage, editSource: WikiEditSource): WikiPage {
    return this.db.transaction(() => {
      const archived = this.save({ ...page, status: "archived", lastEditSource: editSource,
        expectedVersion: page.version })
      this.rewriteIncomingLinks(page, null, editSource)
      this.rebuildLinks(page.tenantId, page.knowledgeBaseId)
      return archived
    })()
  }

  rewriteIncomingLinks(target: WikiPage, replacement: string | null,
    editSource: WikiEditSource): void {
    for (let offset = 0; ; offset += 500) {
      const pages = this.list(target.tenantId, target.knowledgeBaseId,
        { includeArchived: true, offset, limit: 500 })
      for (const page of pages) {
        const content = page.content.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
          (original: string, slug: string, label?: string) => slug.trim() !== target.slug
            ? original : replacement ? `[[${replacement}|${label ?? target.title}]]`
              : label ?? target.title)
        if (content !== page.content) this.save({ ...page, content,
          lastEditSource: editSource, expectedVersion: page.version })
      }
      if (pages.length < 500) return
    }
  }

  rebuildLinks(tenantId: string, knowledgeBaseId: string): void {
    const pages: WikiPage[] = []
    for (let offset = 0; ; offset += 500) {
      const batch = this.list(tenantId, knowledgeBaseId,
        { includeArchived: true, offset, limit: 500 })
      pages.push(...batch)
      if (batch.length < 500) break
    }
    const outgoing = new Map<string, string[]>()
    const incoming = new Map<string, string[]>()
    for (const page of pages.filter((item) => item.status === "published")) {
      const slugs = [...new Set([...page.content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)]
        .map((match) => match[1].trim()).filter(Boolean))]
      outgoing.set(page.slug, slugs)
      for (const slug of slugs) incoming.set(slug, [...(incoming.get(slug) ?? []), page.slug])
    }
    const update = this.db.prepare(`UPDATE wiki_pages SET in_links = ?, out_links = ?
      WHERE id = ? AND tenant_id = ? AND knowledge_base_id = ?`)
    this.db.transaction(() => {
      for (const page of pages) update.run(JSON.stringify(incoming.get(page.slug) ?? []),
        JSON.stringify(outgoing.get(page.slug) ?? []), page.id, tenantId, knowledgeBaseId)
    })()
  }

  private snapshot(page: WikiPage): void {
    this.db.prepare(`INSERT OR IGNORE INTO wiki_revisions
      (page_id, version, title, content, summary, status, source_refs, chunk_refs, edit_source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      page.id, page.version, page.title, page.content, page.summary,
      page.status, JSON.stringify(page.sourceRefs), JSON.stringify(page.chunkRefs),
      page.lastEditSource, page.updatedAt
    )
  }

  revisions(pageId: string): WikiRevision[] {
    const rows = this.db.prepare(`SELECT * FROM wiki_revisions WHERE page_id = ?
      ORDER BY version DESC`).all(pageId) as Array<{
      page_id: string; version: number; title: string; content: string;
      summary: string; status: WikiPageStatus; source_refs: string;
      chunk_refs: string; edit_source: WikiEditSource; created_at: string
    }>
    const history = rows.map((row) => ({
      pageId: row.page_id, version: row.version, title: row.title,
      content: row.content, summary: row.summary, status: row.status,
      sourceRefs: parseList(row.source_refs), chunkRefs: parseList(row.chunk_refs),
      editSource: row.edit_source, createdAt: row.created_at,
    }))
    const current = this.db.prepare("SELECT * FROM wiki_pages WHERE id = ?")
      .get(pageId) as PageRow | undefined
    if (!current) return history
    const page = pageFromRow(current)
    return [{ pageId, version: page.version, title: page.title,
      content: page.content, summary: page.summary, status: page.status,
      sourceRefs: page.sourceRefs, chunkRefs: page.chunkRefs,
      editSource: page.lastEditSource, createdAt: page.updatedAt }, ...history]
  }

  proposal(pageId: string): WikiProposal | null {
    const row = this.db.prepare("SELECT * FROM wiki_proposals WHERE page_id = ?")
      .get(pageId) as {
        page_id: string; base_version: number; title: string; content: string
        summary: string; source_refs: string; chunk_refs: string; created_at: string
      } | undefined
    return row ? {
      pageId: row.page_id, baseVersion: row.base_version, title: row.title,
      content: row.content, summary: row.summary,
      sourceRefs: parseList(row.source_refs), chunkRefs: parseList(row.chunk_refs),
      createdAt: row.created_at,
    } : null
  }

  saveProposal(page: WikiPage, content: string, summary: string,
    sourceRefs: string[], chunkRefs: string[]): void {
    this.db.prepare(`INSERT INTO wiki_proposals
      (page_id, base_version, title, content, summary, source_refs, chunk_refs, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(page_id) DO UPDATE SET
      base_version=excluded.base_version, title=excluded.title,
      content=excluded.content, summary=excluded.summary,
      source_refs=excluded.source_refs, chunk_refs=excluded.chunk_refs,
      created_at=excluded.created_at`).run(
      page.id, page.version, page.title, content, summary,
      JSON.stringify(sourceRefs), JSON.stringify(chunkRefs), this.now().toISOString()
    )
  }

  clearProposal(pageId: string): void {
    this.db.prepare("DELETE FROM wiki_proposals WHERE page_id = ?").run(pageId)
  }

  upsertContribution(input: Omit<WikiContribution, "updatedAt">): void {
    this.db.prepare(`INSERT INTO wiki_contributions
      (page_id, document_id, source_id, content, chunk_refs, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(page_id, document_id) DO UPDATE SET
      content=excluded.content, chunk_refs=excluded.chunk_refs,
      updated_at=excluded.updated_at`).run(
      input.pageId, input.documentId, input.sourceId, input.content,
      JSON.stringify(input.chunkRefs), this.now().toISOString()
    )
  }

  contributions(pageId: string): WikiContribution[] {
    const rows = this.db.prepare(`SELECT * FROM wiki_contributions WHERE page_id = ?
      ORDER BY document_id`).all(pageId) as Array<{
      page_id: string; document_id: string; source_id: string;
      content: string; chunk_refs: string; updated_at: string
    }>
    return rows.map((row) => ({
      pageId: row.page_id, documentId: row.document_id,
      sourceId: row.source_id, content: row.content,
      chunkRefs: parseList(row.chunk_refs), updatedAt: row.updated_at,
    }))
  }

  pagesBySource(sourceId: string): WikiPage[] {
    const rows = this.db.prepare(`SELECT DISTINCT p.* FROM wiki_pages p
      JOIN wiki_contributions c ON c.page_id = p.id WHERE c.source_id = ?`).all(
      sourceId
    ) as PageRow[]
    return rows.map(pageFromRow)
  }

  hasQueuedRetraction(sourceId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM wiki_jobs WHERE source_id = ?
      AND op = 'retract' AND status IN ('pending', 'running', 'completed') LIMIT 1`)
      .get(sourceId)
  }

  removeContributions(sourceId: string): WikiPage[] {
    const pages = this.pagesBySource(sourceId)
    this.db.prepare("DELETE FROM wiki_contributions WHERE source_id = ?").run(sourceId)
    return pages
  }

  replaceSourceContributions(sourceId: string, contributions: Array<
    Omit<WikiContribution, "updatedAt">
  >): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM wiki_contributions WHERE source_id = ?").run(sourceId)
      for (const contribution of contributions) this.upsertContribution(contribution)
    })
    tx()
  }

  enqueue(tenantId: string, knowledgeBaseId: string, documentId: string,
    sourceId: string, op: WikiJob["op"], trace?: TaskTraceContext): number {
    const now = this.now().toISOString()
    const row = this.db.prepare(`INSERT INTO wiki_jobs
      (tenant_id, knowledge_base_id, document_id, source_id, op, status,
       trace_id, trace_span_id, trace_sampled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`).run(
      tenantId, knowledgeBaseId, documentId, sourceId, op,
      trace ? trace.traceId : null,
      trace ? trace.spanId : null,
      trace ? (trace.sampled ? 1 : 0) : null,
      now, now
    )
    return Number(row.lastInsertRowid)
  }

  claimJob(): WikiJob | null {
    const row = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM wiki_jobs WHERE status = 'pending'
        ORDER BY id LIMIT 1`).get() as Record<string, unknown> | undefined
      if (!row) return null
      this.db.prepare(`UPDATE wiki_jobs SET status = 'running', attempts = attempts + 1,
        updated_at = ? WHERE id = ?`).run(this.now().toISOString(), row.id)
      return this.db.prepare("SELECT * FROM wiki_jobs WHERE id = ?").get(row.id)
    })()
    if (!row) return null
    const record = row as Record<string, unknown>
    const job = this.jobFromRow(record)
    const trace = record.trace_sampled === null || record.trace_sampled === undefined
      ? undefined
      : readTaskTrace({
          traceId: String(record.trace_id ?? ""),
          spanId: String(record.trace_span_id ?? ""),
          sampled: Number(record.trace_sampled) === 1,
        })
    return trace ? { ...job, trace } : job
  }

  recoverRunningJobs(): number {
    return this.db.prepare(`UPDATE wiki_jobs SET status = 'pending',
      updated_at = ? WHERE status = 'running'`).run(this.now().toISOString()).changes
  }

  finishJob(id: number, error?: string): void {
    this.db.prepare(`UPDATE wiki_jobs SET status = ?, error = ?, updated_at = ?
      WHERE id = ? AND status = 'running'`).run(
      error ? "failed" : "completed", error ?? null, this.now().toISOString(), id
    )
  }

  retryJob(id: number, tenantId: string, knowledgeBaseId: string): boolean {
    return this.db.prepare(`UPDATE wiki_jobs SET status = 'pending', error = NULL,
      updated_at = ? WHERE id = ? AND tenant_id = ? AND knowledge_base_id = ?
      AND status = 'failed'`).run(this.now().toISOString(), id, tenantId, knowledgeBaseId).changes === 1
  }

  jobs(tenantId: string, knowledgeBaseId: string): WikiJob[] {
    const rows = this.db.prepare(`SELECT * FROM wiki_jobs WHERE tenant_id = ?
      AND knowledge_base_id = ? ORDER BY id DESC LIMIT 100`).all(
      tenantId, knowledgeBaseId
    ) as Record<string, unknown>[]
    return rows.map((row) => this.jobFromRow(row))
  }

  private jobFromRow(row: Record<string, unknown>): WikiJob {
    return {
      id: Number(row.id), tenantId: String(row.tenant_id),
      knowledgeBaseId: String(row.knowledge_base_id), documentId: String(row.document_id),
      sourceId: String(row.source_id), op: row.op as WikiJob["op"],
      status: row.status as WikiJob["status"], attempts: Number(row.attempts),
      error: row.error === null ? null : String(row.error),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }
  }

  listFolders(tenantId: string, knowledgeBaseId: string): WikiFolder[] {
    const rows = this.db.prepare(`SELECT * FROM wiki_folders WHERE tenant_id = ?
      AND knowledge_base_id = ? ORDER BY parent_id, sort_order, name`).all(
      tenantId, knowledgeBaseId
    ) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.id), tenantId: String(row.tenant_id),
      knowledgeBaseId: String(row.knowledge_base_id), parentId: String(row.parent_id),
      name: String(row.name), sortOrder: Number(row.sort_order),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }))
  }

  createFolder(tenantId: string, knowledgeBaseId: string, name: string,
    parentId = ""): WikiFolder {
    const id = randomUUID()
    const now = this.now().toISOString()
    this.db.prepare(`INSERT INTO wiki_folders
      (id, tenant_id, knowledge_base_id, parent_id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      id, tenantId, knowledgeBaseId, parentId, name, now, now
    )
    return { id, tenantId, knowledgeBaseId, parentId, name, sortOrder: 0,
      createdAt: now, updatedAt: now }
  }

  movePage(tenantId: string, knowledgeBaseId: string, slug: string, folderId: string): boolean {
    return this.db.prepare(`UPDATE wiki_pages SET folder_id = ?, updated_at = ?
      WHERE tenant_id = ? AND knowledge_base_id = ? AND slug = ?`).run(
      folderId, this.now().toISOString(), tenantId, knowledgeBaseId, slug
    ).changes === 1
  }

  updateFolder(tenantId: string, knowledgeBaseId: string, id: string,
    name: string, parentId: string): boolean {
    if (id === parentId) return false
    const folders = this.listFolders(tenantId, knowledgeBaseId)
    const target = folders.find((item) => item.id === id)
    if (!target || (parentId && !folders.some((item) => item.id === parentId))) return false
    let cursor = parentId
    while (cursor) {
      if (cursor === id) return false
      cursor = folders.find((item) => item.id === cursor)?.parentId ?? ""
    }
    return this.db.prepare(`UPDATE wiki_folders SET name = ?, parent_id = ?,
      updated_at = ? WHERE id = ? AND tenant_id = ? AND knowledge_base_id = ?`).run(
      name, parentId, this.now().toISOString(), id, tenantId, knowledgeBaseId
    ).changes === 1
  }

  deleteFolder(tenantId: string, knowledgeBaseId: string, id: string): boolean {
    const folder = this.listFolders(tenantId, knowledgeBaseId).find((item) => item.id === id)
    if (!folder) return false
    this.db.transaction(() => {
      this.db.prepare(`UPDATE wiki_folders SET parent_id = ? WHERE parent_id = ?
        AND tenant_id = ? AND knowledge_base_id = ?`).run(
        folder.parentId, id, tenantId, knowledgeBaseId
      )
      this.db.prepare(`UPDATE wiki_pages SET folder_id = ? WHERE folder_id = ?
        AND tenant_id = ? AND knowledge_base_id = ?`).run(
        folder.parentId, id, tenantId, knowledgeBaseId
      )
      this.db.prepare(`DELETE FROM wiki_folders WHERE id = ? AND tenant_id = ?
        AND knowledge_base_id = ?`).run(id, tenantId, knowledgeBaseId)
    })()
    return true
  }

  issues(tenantId: string, knowledgeBaseId: string): WikiIssue[] {
    const rows = this.db.prepare(`SELECT * FROM wiki_issues WHERE tenant_id = ?
      AND knowledge_base_id = ? ORDER BY created_at DESC`).all(
      tenantId, knowledgeBaseId
    ) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.id), tenantId: String(row.tenant_id),
      knowledgeBaseId: String(row.knowledge_base_id), pageId: String(row.page_id),
      kind: String(row.kind), message: String(row.message), status: String(row.status),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }))
  }

  createIssue(tenantId: string, knowledgeBaseId: string, pageId: string,
    kind: string, message: string): WikiIssue {
    const id = randomUUID()
    const now = this.now().toISOString()
    this.db.prepare(`INSERT INTO wiki_issues
      (id, tenant_id, knowledge_base_id, page_id, kind, message, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, tenantId, knowledgeBaseId, pageId, kind, message, now, now
    )
    return { id, tenantId, knowledgeBaseId, pageId, kind, message,
      status: "open", createdAt: now, updatedAt: now }
  }

  updateIssue(tenantId: string, knowledgeBaseId: string, id: string,
    status: string): boolean {
    return this.db.prepare(`UPDATE wiki_issues SET status = ?, updated_at = ?
      WHERE tenant_id = ? AND knowledge_base_id = ? AND id = ?`).run(
      status, this.now().toISOString(), tenantId, knowledgeBaseId, id
    ).changes === 1
  }
}
