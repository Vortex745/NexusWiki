import { z } from "zod"
import type { DB } from "../ingestion/tracking/db"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import type { Searcher } from "../retrieval/search/interface"
import { ToolRegistry, type ToolEnvironment } from "../tools/invocation"
import { WikiStore, type WikiPage } from "./store"
import { canReadWikiPage, visibleWikiPages } from "./access"

export const WIKI_READ_TOOLS = ["wiki_search", "wiki_read_page", "wiki_read_source_doc"] as const
export const WIKI_AGENT_TOOLS = [...WIKI_READ_TOOLS, "wiki_write_page", "wiki_replace_text",
  "wiki_rename_page", "wiki_delete_page", "wiki_flag_issue", "wiki_read_issue", "wiki_update_issue"] as const

export function registerWikiTools(registry: ToolRegistry, db: DB): ToolRegistry {
  const store = new WikiStore(db)
  const documents = new DocumentRepo(db)
  const slugs = z.string().trim().min(1).max(255)
  const versions = z.number().int().positive()
  const scoped = (env: ToolEnvironment): string[] => {
    if (!env.accessContext || !env.retrievalScope) return []
    return env.retrievalScope.knowledgeBaseIds.filter((id) =>
      store.enabled(env.accessContext!.tenantId, id) && !!db.prepare(`SELECT id
        FROM knowledge_bases WHERE id = ? AND tenant_id = ? AND status = 'active'`)
        .get(id, env.accessContext!.tenantId))
  }
  const find = (slug: string, env: ToolEnvironment, write = false): WikiPage => {
    env.signal?.throwIfAborted()
    if (write && !env.accessContext?.scopes.includes("admin")) throw new Error("administrator access required")
    const matches = scoped(env).flatMap((kb) => {
      const page = store.get(env.accessContext!.tenantId, kb, slug)
      return page && canReadWikiPage(page, env.accessContext!, documents) ? [page] : []
    })
    if (matches.length !== 1) throw new Error(matches.length ? "ambiguous wiki slug" : "wiki page not found")
    return matches[0]
  }
  const evidence = async (pages: WikiPage[], query: string, env: ToolEnvironment) => {
    if (!env.searcher || !pages.length) return []
    const ids = new Set(pages.flatMap((page) => page.sourceRefs))
    const result = await (env.searcher as Searcher).search({ text: query }, {
      channels: ["bm25"], accessContext: env.accessContext,
      retrievalScope: env.retrievalScope, signal: env.signal,
    })
    return result.results.filter((item) => ids.has(item.chunk.documentId))
  }
  registry.register({ name: "wiki_search", description: "Search Wiki pages in the current knowledge scope.",
    schema: z.strictObject({ query: z.string().trim().min(1).max(2000) }),
    summarize: (args) => args.query.slice(0, 80), execute: async (args, env) => {
      const pages = scoped(env).flatMap((kb) => visibleWikiPages(store, documents,
        env.accessContext!, kb, { query: args.query })).slice(0, 20)
      return { pages: pages.map(({ slug, title, summary }) => ({ slug, title, summary })),
        results: await evidence(pages, args.query, env), unavailableChannels: [] }
    } })
  registry.register({ name: "wiki_read_page", description: "Read one Wiki page. query is its exact slug.",
    schema: z.strictObject({ query: slugs }), summarize: (args) => args.query,
    execute: async (args, env) => {
      const page = find(args.query, env)
      return { page: { ...page, content: page.content.slice(0, 24000) },
        truncated: page.content.length > 24000, results: await evidence([page], page.title, env),
        unavailableChannels: [] }
    } })
  registry.register({ name: "wiki_read_source_doc", description: "Read the active original document behind a Wiki page.",
    schema: z.strictObject({ documentId: z.string().trim().min(1).max(200),
      query: z.string().trim().max(2000).optional() }), summarize: (args) => args.documentId,
    execute: async (args, env) => {
      const doc = documents.get(args.documentId)
      const ctx = env.accessContext
      if (!doc || !ctx || doc.tenantId !== ctx.tenantId ||
        !scoped(env).includes(doc.knowledgeBaseId ?? "") ||
        documents.getActive(doc.sourceId)?.id !== doc.id ||
        documents.getSourceLifecycleState(doc.sourceId) === "retired" ||
        (!ctx.scopes.includes("admin") && (doc.allowedGroups ?? []).length > 0 &&
          !doc.allowedGroups?.some((group) => ctx.groups.includes(group)))) throw new Error("source document not found")
      const start = args.query ? Math.max(0, doc.content.indexOf(args.query) - 500) : 0
      return { document: { id: doc.id, title: doc.title, content: doc.content.slice(start, start + 24000) },
        truncated: doc.content.length > start + 24000 }
    } })
  registry.register({ name: "wiki_write_page", description: "Create or overwrite a Wiki page; read existing pages first.",
    schema: z.strictObject({ slug: slugs, title: z.string().trim().min(1).max(512),
      content: z.string().trim().min(1).max(100000), summary: z.string().max(2000).default(""),
      expectedVersion: versions.optional() }), summarize: (args) => args.slug,
    execute: async (args, env) => {
      env.signal?.throwIfAborted()
      if (!env.accessContext?.scopes.includes("admin")) throw new Error("administrator access required")
      const kbs = scoped(env)
      if (kbs.length !== 1) throw new Error("writing requires one active Wiki knowledge base")
      const existing = store.get(env.accessContext.tenantId, kbs[0], args.slug)
      if (existing && args.expectedVersion === undefined) throw new Error("expectedVersion required for existing page")
      const page = store.save({ ...(existing ?? {}), tenantId: env.accessContext.tenantId,
        knowledgeBaseId: kbs[0], slug: args.slug, title: args.title, content: args.content,
        summary: args.summary, pageType: existing?.pageType ?? "concept", status: "published",
        aliases: existing?.aliases ?? [], folderId: existing?.folderId ?? "",
        sourceRefs: existing?.sourceRefs ?? [], chunkRefs: existing?.chunkRefs ?? [],
        inLinks: existing?.inLinks ?? [], outLinks: existing?.outLinks ?? [],
        lastEditSource: "agent", expectedVersion: args.expectedVersion })
      store.rebuildLinks(page.tenantId, page.knowledgeBaseId)
      return { page }
    } })
  registry.register({ name: "wiki_replace_text", description: "Replace an exact, unique passage in a Wiki page.",
    schema: z.strictObject({ slug: slugs, oldText: z.string().min(1).max(100000),
      newText: z.string().max(100000), expectedVersion: versions }), summarize: (args) => args.slug,
    execute: async (args, env) => {
      const page = find(args.slug, env, true)
      if (page.content.split(args.oldText).length !== 2) throw new Error("oldText must match exactly once")
      const content = page.content.replace(args.oldText, args.newText)
      if (!content.trim() || content.length > 100000) throw new Error("invalid replacement content")
      const saved = store.save({ ...page, content, expectedVersion: args.expectedVersion, lastEditSource: "agent" })
      store.rebuildLinks(page.tenantId, page.knowledgeBaseId)
      return { page: saved }
    } })
  registry.register({ name: "wiki_rename_page", description: "Rename a Wiki page and update incoming links.",
    schema: z.strictObject({ slug: slugs, newSlug: slugs, title: z.string().trim().min(1).max(512),
      expectedVersion: versions }), summarize: (args) => args.slug,
    execute: async (args, env) => {
      const page = find(args.slug, env, true)
      if (page.version !== args.expectedVersion) throw new Error("wiki page version conflict")
      return { page: store.rename(page, args.newSlug, args.title, "agent") }
    } })
  registry.register({ name: "wiki_delete_page", description: "Archive a Wiki page and remove incoming dead links.",
    schema: z.strictObject({ slug: slugs, expectedVersion: versions }), summarize: (args) => args.slug,
    execute: async (args, env) => {
      const page = find(args.slug, env, true)
      if (page.version !== args.expectedVersion) throw new Error("wiki page version conflict")
      return { page: store.archive(page, "agent") }
    } })
  registry.register({ name: "wiki_flag_issue", description: "Flag a factual error or merge conflict on a Wiki page.",
    schema: z.strictObject({ slug: slugs, message: z.string().trim().min(1).max(2000),
      kind: z.string().trim().min(1).max(64).default("content") }), summarize: (args) => args.slug,
    execute: async (args, env) => {
      const page = find(args.slug, env, true)
      return { issue: store.createIssue(page.tenantId, page.knowledgeBaseId, page.id, args.kind, args.message) }
    } })
  registry.register({ name: "wiki_read_issue", description: "Read a Wiki issue in the current knowledge scope.",
    schema: z.strictObject({ issueId: z.string().trim().min(1).max(200) }), summarize: (args) => args.issueId,
    execute: async (args, env) => {
      if (!env.accessContext?.scopes.includes("admin")) throw new Error("administrator access required")
      const issue = scoped(env).flatMap((kb) => store.issues(env.accessContext!.tenantId, kb))
        .find((item) => item.id === args.issueId)
      if (!issue) throw new Error("wiki issue not found")
      return { issue }
    } })
  registry.register({ name: "wiki_update_issue", description: "Resolve, dismiss or reopen a Wiki issue.",
    schema: z.strictObject({ issueId: z.string().trim().min(1).max(200),
      status: z.enum(["open", "resolved", "dismissed"]) }), summarize: (args) => args.issueId,
    execute: async (args, env) => {
      env.signal?.throwIfAborted()
      if (!env.accessContext?.scopes.includes("admin")) throw new Error("administrator access required")
      for (const kb of scoped(env)) if (store.updateIssue(env.accessContext.tenantId, kb, args.issueId, args.status)) {
        return { status: args.status }
      }
      throw new Error("wiki issue not found")
    } })
  return registry
}
