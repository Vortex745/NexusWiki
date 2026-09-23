/**
 * Ticket 38 (WIKI-01) — generate, validate and publish recoverable Wiki pages.
 *
 * One service owns the whole Wiki lifecycle:
 *
 *  1. GENERATE — an administrator picks original documents; the LLM authors a
 *     markdown page citing them with [S#] markers. One bounded model call
 *     (AbortSignal timeout), no retries: a failure surfaces as an error and
 *     the current page (if any) is never touched.
 *  2. VALIDATE — deterministically, before anything is stored: the draft must
 *     be non-empty, every [S#] must map to a selected source, and every
 *     selected source must be cited. Invalid output is REJECTED with reasons;
 *     nothing is written, so the current page stays intact.
 *  3. PUBLISH — the validated page enters NORMAL ingestion through the shared
 *     lifecycle (same chunk → index → activate path as every document), as a
 *     new version of a stable wiki source identity. Original-document
 *     provenance is preserved twice: inline in the page (来源 section) and
 *     machine-readably in the document metadata (metadata.wiki.sources).
 *     Identical content is an "unchanged" no-op (no duplicate version).
 *  4. RESTORE — a prior published revision is re-submitted verbatim under the
 *     same page identity (a normal new version), so history is never rewritten.
 *
 * Wiki pages carry the catalog tag "wiki", and candidate SOURCE listing
 * excludes wiki documents by default — wiki output never recursively feeds
 * the next generation.
 */

import type OpenAI from "openai"
import type {
  IngestionLifecycle,
  IngestionSubmission,
} from "../ingestion/lifecycle"
import { SameNameIntentRequiredError } from "../ingestion/lifecycle"
import type { AccessContext } from "../access/context"
import type { DocumentRepo } from "../ingestion/tracking/doc_repo"

const WIKI_TAG = "wiki"
const WIKI_NAMESPACE = "wiki"
/** Bounded context per source document and overall. */
const MAX_SOURCE_CHARS = 12_000
const MAX_TOTAL_SOURCE_CHARS = 40_000
const MAX_SOURCES = 5
const GENERATION_TIMEOUT_MS = 90_000
const MIN_DRAFT_CHARS = 40
const WIKI_PAGE_CHARS = 20_000

export interface WikiSourceRef {
  /** The original document this citation maps back to. */
  documentId: string
  /** The version that was read at generation time (the staleness anchor). */
  version: number
  title: string
  contentHash: string
}

export interface WikiMetadata {
  pageKey: string
  generatedAt: string
  generator: string
  sources: WikiSourceRef[]
}

export type SourceStaleness = "missing" | "updated" | "retired"

export interface WikiPageView {
  documentId: string
  title: string
  version: number
  active: boolean
  updatedAt: string
  page: WikiMetadata | null
  /** Per-source staleness of the recorded citations. */
  sources: Array<
    WikiSourceRef & {
      stale: SourceStaleness | null
      currentVersion?: number
    }
  >
  versions: Array<{ documentId: string; version: number; createdAt: string; active: boolean }>
}

export type WikiGenerationOutcome =
  | {
      status: "published"
      draft: string
      title: string
      sources: WikiSourceRef[]
      submission: IngestionSubmission
    }
  | {
      status: "rejected"
      draft: string
      reasons: string[]
    }

export class WikiGenerationModelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WikiGenerationModelError"
  }
}

export class WikiPageNotFoundError extends Error {
  constructor() {
    super("wiki page not found")
    this.name = "WikiPageNotFoundError"
  }
}

function isWikiDoc(doc: { metadata: Record<string, unknown> } | null): boolean {
  return (
    !!doc &&
    Array.isArray(doc.metadata.tags) &&
    (doc.metadata.tags as unknown[]).includes(WIKI_TAG)
  )
}

/** Extract [S1]-style citation markers. */
function extractCitations(draft: string): number[] {
  const citations: number[] = []
  for (const match of draft.matchAll(/\[S(\d+)\]/g)) {
    const value = Number.parseInt(match[1], 10)
    if (Number.isFinite(value)) citations.push(value)
  }
  return citations
}

export class WikiService {
  constructor(
    private readonly options: {
      /**
       * The generation client + model. Optional so read surfaces (source
       * candidates, page history, restore) work in bare mounts; generate()
       * refuses to run without them.
       */
      chatClient?: OpenAI
      model?: string
      lifecycle: IngestionLifecycle
      documentRepo: DocumentRepo
      now?: () => Date
      timeoutMs?: number
    }
  ) {}

  /** The generation seam fails closed when the deployment wired no client. */
  private generationClient(): { chatClient: OpenAI; model: string } {
    if (!this.options.chatClient || !this.options.model) {
      throw new WikiGenerationModelError("wiki generation is not wired in this deployment")
    }
    return { chatClient: this.options.chatClient, model: this.options.model }
  }

  /**
   * Original documents eligible as generation sources: the KB's ACTIVE,
   * non-wiki documents. Wiki output never feeds the next generation by
   * default — wiki-origin documents are structurally absent from this list.
   */
  listSourceCandidates(
    context: AccessContext,
    knowledgeBaseId: string
  ): Array<{ documentId: string; title: string; version: number; updatedAt: string }> {
    const catalog = this.options.documentRepo.listCatalog({
      tenantId: context.tenantId,
      knowledgeBaseId,
      page: 1,
      pageSize: 100,
      viewerGroups: [...context.groups],
      admin: context.scopes.includes("admin"),
    })
    return catalog.documents
      .filter((entry) => entry.active && !entry.tags.includes(WIKI_TAG))
      .map((entry) => ({
        documentId: entry.docId,
        title: entry.title,
        version: entry.version,
        updatedAt: entry.updatedAt,
      }))
  }

  /**
   * The KB's wiki pages with their revision history and the staleness of
   * every recorded source citation — visible, never silently rewritten.
   */
  listWikiPages(context: AccessContext, knowledgeBaseId: string): WikiPageView[] {
    const repo = this.options.documentRepo
    const catalog = repo.listCatalog({
      tenantId: context.tenantId,
      knowledgeBaseId,
      page: 1,
      pageSize: 100,
      tag: WIKI_TAG,
      viewerGroups: [...context.groups],
      admin: context.scopes.includes("admin"),
    })
    const pages: WikiPageView[] = []
    // One page per SOURCE (the catalog may carry several versions of the
    // same page): the active version wins, the latest non-active otherwise.
    const bySource = new Map<string, typeof catalog.documents>()
    for (const entry of catalog.documents) {
      const existing = bySource.get(entry.sourceId) ?? []
      existing.push(entry)
      bySource.set(entry.sourceId, existing)
    }
    for (const versions of bySource.values()) {
      const current =
        versions.find((entry) => entry.active) ??
        versions.reduce((latest, entry) => (entry.version > latest.version ? entry : latest))
      const doc = repo.get(current.docId)
      if (!doc) continue
      const metadata = doc.metadata as { wiki?: WikiMetadata }
      const page = metadata?.wiki ?? null
      const history = repo.listVersionsBySource(current.sourceId)
      const sources = (page?.sources ?? []).map((source) => {
        const sourceDoc = repo.get(source.documentId)
        if (!sourceDoc) return { ...source, stale: "missing" as const }
        if (repo.getSourceLifecycleState(sourceDoc.sourceId) === "retired") {
          return { ...source, stale: "retired" as const }
        }
        const active = repo.getActive(sourceDoc.sourceId)
        if (active && active.version > source.version) {
          return {
            ...source,
            stale: "updated" as const,
            currentVersion: active.version,
          }
        }
        return { ...source, stale: null }
      })
      pages.push({
        documentId: doc.id,
        title: doc.title,
        version: doc.version,
        active: current.active,
        updatedAt: current.updatedAt,
        page,
        sources,
        versions: history.map((version) => ({
          documentId: version.docId,
          version: version.version,
          createdAt: version.createdAt.toISOString(),
          active: version.active,
        })),
      })
    }
    return pages
  }

  /** The generation prompt: bounded source excerpts with stable [S#] anchors. */
  private buildPrompt(sources: Array<{ title: string; content: string }>): {
    system: string
    user: string
  } {
    const system =
      "你是一名企业知识整理者。请根据给定的资料撰写一篇中文 Wiki 页面（Markdown）。" +
      "规则：1) 只使用资料中的信息，不要编造；2) 每个论断都用 [S编号] 标注来源（如 [S1]）；" +
      "3) 每一份资料至少被引用一次；4) 结构清晰（标题/要点），不超过 1500 字；5) 只输出页面正文，不要额外解释。"
    const excerpts = sources
      .map(
        (source, index) =>
          `[S${index + 1}] ${source.title}\n${source.content.slice(0, MAX_SOURCE_CHARS)}`
      )
      .join("\n\n---\n\n")
      .slice(0, MAX_TOTAL_SOURCE_CHARS)
    const user = `请基于以下 ${sources.length} 份资料撰写 Wiki 页面：\n\n${excerpts}`
    return { system, user }
  }

  /** Deterministic publication gate: non-empty + fully cited. */
  private validateDraft(
    draft: string,
    sourceCount: number
  ): { valid: true } | { valid: false; reasons: string[] } {
    const reasons: string[] = []
    if (draft.trim().length < MIN_DRAFT_CHARS) {
      reasons.push(`页面为空或过短（至少 ${MIN_DRAFT_CHARS} 字符）`)
    }
    const citations = extractCitations(draft)
    const outOfRange = [...new Set(citations.filter((value) => value < 1 || value > sourceCount))]
    if (outOfRange.length > 0) {
      reasons.push(`存在未知来源引用：${outOfRange.map((value) => `[S${value}]`).join("、")}`)
    }
    if (sourceCount > 0) {
      const cited = new Set(citations.filter((value) => value >= 1 && value <= sourceCount))
      const missing = Array.from({ length: sourceCount }, (_, i) => i + 1).filter(
        (index) => !cited.has(index)
      )
      if (missing.length > 0) {
        reasons.push(`来源未被引用：${missing.map((value) => `[S${value}]`).join("、")}`)
      }
    }
    return reasons.length > 0 ? { valid: false, reasons } : { valid: true }
  }

  /**
   * Generate + validate + publish in one command. A generation or validation
   * failure returns BEFORE any storage write — the current page stays intact.
   */
  async generate(input: {
    context: AccessContext
    knowledgeBaseId: string
    title: string
    documentIds: string[]
    signal?: AbortSignal
  }): Promise<WikiGenerationOutcome> {
    const { context, knowledgeBaseId, title, documentIds } = input
    const repo = this.options.documentRepo
    const { chatClient, model } = this.generationClient()
    if (documentIds.length === 0 || documentIds.length > MAX_SOURCES) {
      throw new Error(`请选择 1-${MAX_SOURCES} 份来源文档`)
    }
    // Authorize + read every selected source server-side.
    const sources: WikiSourceRef[] = []
    const excerpts: Array<{ title: string; content: string }> = []
    for (const documentId of documentIds) {
      const doc = repo.get(documentId)
      if (
        !doc ||
        doc.tenantId !== context.tenantId ||
        doc.knowledgeBaseId !== knowledgeBaseId
      ) {
        throw new Error(`来源文档不存在或不属于该知识库：${documentId}`)
      }
      const visible =
        context.scopes.includes("admin") ||
        (doc.allowedGroups ?? []).length === 0 ||
        (doc.allowedGroups ?? []).some((group) => context.groups.includes(group))
      if (!visible) {
        throw new Error(`来源文档不可见：${documentId}`)
      }
      sources.push({
        documentId: doc.id,
        version: doc.version,
        title: doc.title,
        contentHash: doc.contentHash,
      })
      excerpts.push({ title: doc.title, content: doc.content })
    }

    // One bounded model call — no retries, no fallback author.
    const { system, user } = this.buildPrompt(excerpts)
    let draft: string
    try {
      const response = await chatClient.chat.completions.create(
        {
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: 0,
        },
        {
          signal: AbortSignal.any([
            ...(input.signal ? [input.signal] : []),
            AbortSignal.timeout(this.options.timeoutMs ?? GENERATION_TIMEOUT_MS),
          ]),
        }
      )
      draft = (response.choices?.[0]?.message?.content ?? "").trim()
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new WikiGenerationModelError("生成超时——当前页面保持不变")
      }
      throw new WikiGenerationModelError(
        `生成失败：${(error instanceof Error ? error.message : String(error)).slice(0, 200)}——当前页面保持不变`
      )
    }

    // Deterministic gate BEFORE any write.
    const validation = this.validateDraft(draft, sources.length)
    if (!validation.valid) {
      return { status: "rejected", draft, reasons: validation.reasons }
    }

    // Inline provenance: the 来源 section travels inside the page itself.
    const sourcesSection =
      "\n\n## 来源\n\n" +
      sources
        .map(
          (source, index) =>
            `[S${index + 1}] ${source.title}（文档 ${source.documentId} v${source.version}）`
        )
        .join("\n")
    const content = `${draft}${sourcesSection}`.slice(0, WIKI_PAGE_CHARS)

    const submission = this.publish({
      tenantId: context.tenantId,
      knowledgeBaseId,
      title,
      content,
      sources,
    })
    return { status: "published", draft, title, sources, submission }
  }

  /**
   * Store a validated page as a new version of a stable wiki source identity,
   * through the NORMAL ingestion lifecycle. Identical content is an honest
   * "unchanged" no-op.
   */
  private publish(input: {
    tenantId: string
    knowledgeBaseId: string
    title: string
    content: string
    sources: WikiSourceRef[]
  }): IngestionSubmission {
    const pageKey = `wiki:${input.title}`
    const metadata: { tags: string[]; wiki: WikiMetadata } = {
      tags: [WIKI_TAG],
      wiki: {
        pageKey,
        generatedAt: (this.options.now ?? (() => new Date()))().toISOString(),
        generator: this.options.model ?? "unknown",
        sources: input.sources,
      },
    }
    try {
      return this.options.lifecycle.submit({
        title: input.title,
        content: input.content,
        mimeType: "text/markdown",
        knowledgeBaseId: input.knowledgeBaseId,
        versionIntent: "new_version",
        sourceIdentity: {
          kind: "wiki",
          uriOrExternalId: pageKey,
          namespace: WIKI_NAMESPACE,
          tenantId: input.tenantId,
        },
        metadata,
      })
    } catch (error) {
      if (error instanceof SameNameIntentRequiredError) {
        // Cannot happen (new_version is always given) — fail loud rather
        // than silently creating a detached document.
        throw new Error("wiki publish identity conflict")
      }
      throw error
    }
  }

  /**
   * Restore a prior published revision verbatim: the historical version's
   * content is re-submitted under the SAME page identity, so it becomes the
   * newest version through the normal pipeline. History is never rewritten,
   * and a failed restore leaves everything untouched.
   */
  restore(input: {
    context: AccessContext
    knowledgeBaseId: string
    documentId: string
  }): {
    status: IngestionSubmission["status"]
    submission: IngestionSubmission
    title: string
  } {
    const { context, knowledgeBaseId, documentId } = input
    const repo = this.options.documentRepo
    const doc = repo.get(documentId)
    if (
      !doc ||
      doc.tenantId !== context.tenantId ||
      doc.knowledgeBaseId !== knowledgeBaseId ||
      !isWikiDoc(doc)
    ) {
      throw new WikiPageNotFoundError()
    }
    const metadata = doc.metadata as { wiki?: WikiMetadata }
    const page = metadata?.wiki
    if (!page) throw new WikiPageNotFoundError()
    const sources: WikiSourceRef[] = page.sources ?? []
    const submission = this.publish({
      tenantId: context.tenantId,
      knowledgeBaseId,
      title: doc.title,
      content: doc.content,
      sources,
    })
    return {
      status: submission.status,
      submission,
      title: doc.title,
    }
  }
}
