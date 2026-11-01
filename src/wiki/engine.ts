import { createHash, randomUUID } from "node:crypto"
import type { Client } from "@elastic/elasticsearch"
import { resolveChunkIndexName } from "../config"
import type OpenAI from "openai"
import type { DB } from "../ingestion/tracking/db"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import { WikiStore, type WikiPage, type WikiContribution, type WikiJob } from "./store"
import type { TracingRuntime } from "../tracing/contract"

export interface WikiSourceChunk {
  id: string
  content: string
}

export interface WikiChunkReader {
  list(documentId: string): Promise<WikiSourceChunk[]>
}

export function esWikiChunkReader(client: Client, indexName?: string): WikiChunkReader {
  const index = resolveChunkIndexName(indexName)
  return {
    async list(documentId) {
      const chunks: WikiSourceChunk[] = []
      for (let offset = 0; offset < 10_000; offset += 500) {
        const result = await client.search({
          index, from: offset, size: 500,
          query: { bool: { filter: [
            { term: { documentId } }, { terms: { kind: ["child", "image"] } },
          ] } },
          sort: [{ "metadata.index": { order: "asc", unmapped_type: "long" } },
            { id: { order: "asc" } }],
          _source: ["id", "content"],
        })
        const hits = result.hits.hits
        for (const hit of hits) {
          const source = hit._source as { id?: string; content?: string } | undefined
          if (source?.id && source.content?.trim()) {
            chunks.push({ id: source.id, content: source.content })
          }
        }
        if (hits.length < 500) return chunks
      }
      throw new Error(`document ${documentId} exceeds the 10000-chunk wiki limit`)
    },
  }
}

type Topic = {
  existingSlug?: string
  title: string
  pageType: "entity" | "concept" | "synthesis" | "comparison"
  summary: string
  content: string
  chunkIds: string[]
}

export interface WikiTopicGenerator {
  map(title: string, chunks: WikiSourceChunk[], catalog?: WikiPage[]): Promise<Topic[]>
  reduce(title: string, contributions: WikiContribution[], catalog?: WikiPage[]): Promise<{ summary: string; content: string }>
}

export class ModelWikiTopicGenerator implements WikiTopicGenerator {
  constructor(private readonly client: OpenAI, private readonly model: string) {}

  async map(title: string, chunks: WikiSourceChunk[], catalog: WikiPage[] = []): Promise<Topic[]> {
    const batches: WikiSourceChunk[][] = []
    let current: WikiSourceChunk[] = []
    let length = 0
    for (const chunk of chunks) {
      if (current.length && length + chunk.content.length > 6500) {
        batches.push(current)
        current = []
        length = 0
      }
      current.push(chunk)
      length += chunk.content.length
    }
    if (current.length) batches.push(current)
    const topics: Topic[] = []
    for (const batch of batches) {
      const allowedIds = new Set(batch.map((chunk) => chunk.id))
      const context = batch.map((chunk) => `[chunk:${chunk.id}]\n${chunk.content}`).join("\n\n")
      const normalized = context.normalize("NFKC").toLowerCase()
      const candidates = catalog.filter((page) => [page.title, ...page.aliases]
        .some((name) => normalized.includes(name.normalize("NFKC").toLowerCase()))).slice(0, 100)
      const allowedSlugs = new Set(candidates.map((page) => page.slug))
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "从原文切片提取可复用的 Wiki 主题。只返回 JSON 对象 {\"topics\":[{\"title\":string,\"pageType\":\"entity\"|\"concept\"|\"synthesis\"|\"comparison\",\"summary\":string,\"content\":string,\"chunkIds\":string[],\"existingSlug\":string?}]}。内容只陈述切片可证实的信息，每个主题引用至少一个输入 chunk ID；仅引用实质讨论此主题的切片。若主题与候选页面指向完全相同的实体或概念，填写该 existingSlug；近似名称但不同对象禁止合并。可用 [[slug|名称]] 链接引用候选页面，禁止发明 slug 或自链接。不要输出原文中没有的事实。" },
          { role: "user", content: `文档：${title}\n候选页面：${JSON.stringify(candidates.map(({ slug, title, pageType, aliases }) => ({ slug, title, pageType, aliases })))}\n原文：\n${context}` },
        ],
      })
      const raw = JSON.parse(response.choices[0]?.message?.content || "{}") as { topics?: unknown }
      if (!Array.isArray(raw.topics)) throw new Error("wiki map response has no topics array")
      for (const item of raw.topics) {
        if (!item || typeof item !== "object") continue
        const candidate = item as Record<string, unknown>
        const ids = Array.isArray(candidate.chunkIds)
          ? candidate.chunkIds.filter((id): id is string => typeof id === "string" && allowedIds.has(id))
          : []
        if (!ids.length || typeof candidate.title !== "string" ||
          typeof candidate.content !== "string" || candidate.content.trim().length < 30) continue
        const pageType = ["entity", "concept", "synthesis", "comparison"]
          .includes(String(candidate.pageType))
          ? candidate.pageType as Topic["pageType"] : "concept"
        topics.push({
          existingSlug: typeof candidate.existingSlug === "string" && allowedSlugs.has(candidate.existingSlug)
            ? candidate.existingSlug : undefined,
          title: candidate.title.trim().slice(0, 200), pageType,
          summary: typeof candidate.summary === "string" ? candidate.summary.trim() : "",
          content: candidate.content.trim(), chunkIds: [...new Set(ids)],
        })
      }
    }
    return topics
  }

  async reduce(title: string, contributions: WikiContribution[], catalog: WikiPage[] = []): Promise<{
    summary: string; content: string
  }> {
    return this.reduceBounded(title, contributions, catalog, 0)
  }

  private async reduceBounded(title: string, contributions: WikiContribution[], catalog: WikiPage[],
    depth: number): Promise<{ summary: string; content: string }> {
    const length = contributions.reduce((sum, item) => sum + item.content.length, 0)
    if (length > 12000) {
      if (depth >= 6) throw new Error("Wiki reduction did not converge within its budget")
      const fragments: WikiContribution[] = []
      for (const item of contributions) {
        for (let offset = 0; offset < item.content.length; offset += 6000) {
          const merged = await this.reduceBounded(title,
            [{ ...item, content: item.content.slice(offset, offset + 6000) }], catalog, depth + 1)
          fragments.push({ ...item, content: merged.content })
        }
      }
      if (fragments.reduce((sum, item) => sum + item.content.length, 0) >= length) {
        throw new Error("Wiki reduction exceeded the content budget")
      }
      return this.reduceBounded(title, fragments, catalog, depth + 1)
    }
    const validLinks = catalog.filter((page) => page.title !== title).map((page) => ({ slug: page.slug, title: page.title }))
    const response = await this.client.chat.completions.create({
      model: this.model, temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "将文档对同一 Wiki 主题的贡献合并成一篇中文 Markdown 页面。页面只讨论此主题本身，保留一致事实，明确冲突，不编造。将重复内容压缩，页面不超过4000字。每项事实用 [chunk:ID] 标注给定来源切片，禁止发明 ID。可用 [[slug|名称]] 链接引用给定的相关 Wiki 页面，禁止自链接或发明 slug。只返回 JSON 对象 {\"summary\":string,\"content\":string}，summary 为简短的主题描述。" },
        { role: "user", content: `主题：${title}\n允许的相关页面：${JSON.stringify(validLinks.slice(0, 100))}\n${contributions.map((item, index) =>
          `[来源 ${index + 1}: ${item.documentId}，切片 ${item.chunkRefs.join(",")}]\n${item.content}`
        ).join("\n\n")}` },
      ],
    })
    const raw = JSON.parse(response.choices[0]?.message?.content || "{}") as Record<string, unknown>
    if (typeof raw.content !== "string" || raw.content.trim().length < 30) {
      throw new Error("wiki reduce returned empty content")
    }
    const allowedChunks = new Set(contributions.flatMap((item) => item.chunkRefs))
    const allowedLinks = new Set(validLinks.map((page) => page.slug))
    const content = raw.content.trim().replace(/\[chunk:([^\]]+)\]/g,
      (citation: string, id: string) => allowedChunks.has(id) ? citation : "")
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
        (link: string, slug: string, label?: string) => allowedLinks.has(slug) ? link : label ?? slug)
    return {
      summary: typeof raw.summary === "string" ? raw.summary.trim() : "",
      content,
    }
  }
}

function topicSlug(type: string, title: string): string {
  const normalized = title.normalize("NFKC").trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "")
  return `${type}/${normalized || createHash("sha256").update(title).digest("hex").slice(0, 16)}`
}

function links(content: string): string[] {
  return [...new Set([...content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)]
    .map((match) => match[1].trim()).filter(Boolean))]
}

export class WikiEngine {
  private readonly documents: DocumentRepo
  constructor(
    private readonly db: DB,
    private readonly store: WikiStore,
    private readonly chunks: WikiChunkReader,
    private readonly generator: WikiTopicGenerator,
    /** LO-16: the runtime; absent in unit callers that build the engine bare. */
    private readonly tracing?: TracingRuntime
  ) {
    this.documents = new DocumentRepo(db)
  }

  async runNext(): Promise<WikiJob | null> {
    const job = this.store.claimJob()
    if (!job) return null
    // LO-16: one span per real execution, continuing the job's durable
    // handoff. A legacy job has none and roots itself.
    const scope = this.tracing?.startOperation(
      "wiki.job",
      {
        "wiki.job_id": job.id,
        "wiki.op": job.op,
        "wiki.document_id": job.documentId,
        "wiki.attempt": job.attempts,
      },
      job.trace,
    )
    let failed = false
    try {
      const work = async (): Promise<void> => {
        if (job.op === "retract") await this.retract(job)
        else await this.ingest(job)
      }
      if (scope) await scope.runInContext(work)
      else await work()
      this.store.finishJob(job.id)
    } catch (error) {
      failed = true
      this.store.finishJob(job.id, error instanceof Error ? error.message : String(error))
    } finally {
      // Exactly one end, on success and failure alike (LG-06-AC07).
      scope?.end(
        failed
          ? { outcome: "error", message: "wiki job failed" }
          : { outcome: "ok" },
      )
    }
    return job
  }

  private async ingest(job: WikiJob): Promise<void> {
    if (!this.store.enabled(job.tenantId, job.knowledgeBaseId)) return
    const document = this.documents.get(job.documentId)
    if (!document || document.tenantId !== job.tenantId ||
      document.knowledgeBaseId !== job.knowledgeBaseId ||
      this.documents.getSourceLifecycleState(job.sourceId) === "retired") return
    if (this.documents.getActive(job.sourceId)?.id !== document.id) return
    const chunks = await this.chunks.list(document.id)
    if (!chunks.length) return
    const catalog: WikiPage[] = []
    for (let offset = 0; ; offset += 500) {
      const batch = this.store.list(job.tenantId, job.knowledgeBaseId, { limit: 500, offset })
      catalog.push(...batch)
      if (batch.length < 500) break
    }
    const topics = await this.generator.map(document.title, chunks, catalog)
    if (!this.store.enabled(job.tenantId, job.knowledgeBaseId) ||
      this.documents.getSourceLifecycleState(job.sourceId) === "retired" ||
      this.documents.getActive(job.sourceId)?.id !== document.id) return
    const summary: Topic = {
      title: document.title, pageType: "concept",
      summary: document.title, content: topics.length
        ? topics.map((topic) => `## ${topic.title}\n${topic.content}`).join("\n\n")
        : chunks.map((chunk) => `[chunk:${chunk.id}]\n${chunk.content}`).join("\n\n"),
      chunkIds: topics.length ? [...new Set(topics.flatMap((topic) => topic.chunkIds))]
        : chunks.map((chunk) => chunk.id),
    }
    const candidateGroups = new Map<string, Topic[]>()
    for (const topic of [...topics, summary]) {
      const slug = topic === summary
        ? `summary/${createHash("sha256").update(job.sourceId).digest("hex").slice(0, 24)}`
        : catalog.find((page) => page.slug === topic.existingSlug)?.slug ?? topicSlug(topic.pageType, topic.title)
      candidateGroups.set(slug, [...(candidateGroups.get(slug) ?? []), topic])
    }
    const affected = new Map<string, WikiPage>()
    for (const page of this.store.pagesBySource(job.sourceId)) affected.set(page.slug, page)
    const additions: Array<Omit<WikiContribution, "updatedAt">> = []
    for (const [slug, group] of candidateGroups) {
      const first = group[0]
      let page = this.store.get(job.tenantId, job.knowledgeBaseId, slug)
      if (!page) {
        page = {
          id: randomUUID(), version: 0,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          tenantId: job.tenantId, knowledgeBaseId: job.knowledgeBaseId,
          slug, title: first.title, pageType: slug.startsWith("summary/") ? "summary" : first.pageType,
          status: "draft", content: "", summary: "", aliases: [], folderId: "",
          sourceRefs: [], chunkRefs: [], inLinks: [], outLinks: [],
          lastEditSource: "pipeline",
        }
      }
      additions.push({
        pageId: page.id, documentId: document.id, sourceId: job.sourceId,
        content: group.map((item) => item.content).join("\n\n"),
        chunkRefs: [...new Set(group.flatMap((item) => item.chunkIds))],
      })
      affected.set(slug, page)
    }
    await this.applySourceChange(job, [...affected.values()], additions)
  }

  private async retract(job: WikiJob): Promise<void> {
    await this.applySourceChange(job, this.store.pagesBySource(job.sourceId), [])
  }

  private async applySourceChange(
    job: WikiJob,
    pages: WikiPage[],
    additions: Array<Omit<WikiContribution, "updatedAt">>
  ): Promise<void> {
    const catalog = new Map<string, WikiPage>()
    for (let offset = 0; ; offset += 500) {
      const batch = this.store.list(job.tenantId, job.knowledgeBaseId, { limit: 500, offset })
      for (const page of batch) catalog.set(page.slug, page)
      if (batch.length < 500) break
    }
    for (const page of pages) catalog.set(page.slug, page)
    const plans: Array<{
      page: WikiPage; merged: { summary: string; content: string } | null
      sourceRefs: string[]; chunkRefs: string[]
    }> = []
    for (const page of pages) {
      const contributions = this.store.contributions(page.id)
        .filter((item) => item.sourceId !== job.sourceId)
      const incoming = additions.filter((item) => item.pageId === page.id)
        .map((item) => ({ ...item, updatedAt: new Date().toISOString() }))
      const next = [...contributions, ...incoming]
      plans.push({
        page,
        merged: next.length ? await this.generator.reduce(page.title, next, [...catalog.values()]) : null,
        sourceRefs: [...new Set(next.map((item) => item.documentId))],
        chunkRefs: [...new Set(next.flatMap((item) => item.chunkRefs))],
      })
    }
    if (job.op === "ingest" && (!this.store.enabled(job.tenantId, job.knowledgeBaseId) ||
      this.documents.getSourceLifecycleState(job.sourceId) === "retired" ||
      this.documents.getActive(job.sourceId)?.id !== job.documentId)) return
    this.db.transaction(() => {
      for (const plan of plans) {
        if (plan.page.version === 0) {
          this.store.save({ ...plan.page, id: plan.page.id })
        }
      }
      this.store.replaceSourceContributions(job.sourceId, additions)
      for (const plan of plans) {
        const current = this.store.getById(
          plan.page.tenantId, plan.page.knowledgeBaseId, plan.page.id
        )!
        this.applyMaterialization(current, plan.merged,
          plan.sourceRefs, plan.chunkRefs)
      }
      this.rebuildLinks(job.tenantId, job.knowledgeBaseId)
    })()
  }

  private applyMaterialization(page: WikiPage,
    merged: { summary: string; content: string } | null,
    sourceRefs: string[], chunkRefs: string[]): void {
    if (!merged) {
      if (page.status !== "archived") this.store.save({
        ...page, status: "archived", sourceRefs: [], chunkRefs: [],
        lastEditSource: "pipeline", expectedVersion: page.version,
      })
      this.store.clearProposal(page.id)
      return
    }
    if (page.lastEditSource !== "pipeline" && page.status !== "draft") {
      this.store.saveProposal(page, merged.content, merged.summary, sourceRefs, chunkRefs)
      return
    }
    if (page.content === merged.content && page.status === "published" &&
      JSON.stringify(page.sourceRefs) === JSON.stringify(sourceRefs) &&
      JSON.stringify(page.chunkRefs) === JSON.stringify(chunkRefs)) return
    this.store.save({
      ...page, status: "published", content: merged.content,
      summary: merged.summary || page.summary,
      sourceRefs, chunkRefs, outLinks: links(merged.content),
      lastEditSource: "pipeline", expectedVersion: page.version,
    })
  }

  rebuildLinks(tenantId: string, knowledgeBaseId: string): void {
    const pages: WikiPage[] = []
    for (let offset = 0; ; offset += 500) {
      const batch = this.store.list(tenantId, knowledgeBaseId,
        { includeArchived: true, limit: 500, offset })
      pages.push(...batch)
      if (batch.length < 500) break
    }
    const incoming = new Map<string, string[]>()
    for (const page of pages.filter((item) => item.status === "published")) {
      for (const slug of links(page.content)) {
        incoming.set(slug, [...(incoming.get(slug) ?? []), page.slug])
      }
    }
    const update = this.db.prepare(`UPDATE wiki_pages SET in_links = ?, out_links = ?
      WHERE id = ? AND tenant_id = ? AND knowledge_base_id = ?`)
    for (const page of pages) {
      update.run(JSON.stringify(incoming.get(page.slug) ?? []),
        JSON.stringify(page.status === "published" ? links(page.content) : []),
        page.id, tenantId, knowledgeBaseId)
    }
  }
}
