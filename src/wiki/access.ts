import type { AccessContext } from "../access/context"
import type { DocumentRepo } from "../ingestion/tracking/doc_repo"
import type { WikiPage, WikiStore } from "./store"

export function canReadWikiPage(page: WikiPage, ctx: AccessContext,
  documents: DocumentRepo): boolean {
  if (ctx.scopes.includes("admin")) return true
  if (page.status !== "published") return false
  return page.sourceRefs.every((id) => {
    const doc = documents.get(id)
    return !!doc && doc.tenantId === ctx.tenantId &&
      doc.knowledgeBaseId === page.knowledgeBaseId &&
      documents.getSourceLifecycleState(doc.sourceId) !== "retired" &&
      (doc.allowedGroups?.length === 0 ||
        doc.allowedGroups?.some((group) => ctx.groups.includes(group)))
  })
}

export function visibleWikiPages(store: WikiStore, documents: DocumentRepo,
  ctx: AccessContext, kbId: string, options: {
    query?: string; includeArchived?: boolean
  } = {}): WikiPage[] {
  const pages: WikiPage[] = []
  for (let offset = 0; ; offset += 500) {
    const batch = store.list(ctx.tenantId, kbId, {
      ...options, includeArchived: ctx.scopes.includes("admin") && options.includeArchived,
      limit: 500, offset,
    })
    pages.push(...batch.filter((page) => canReadWikiPage(page, ctx, documents)))
    if (batch.length < 500) return pages
  }
}
