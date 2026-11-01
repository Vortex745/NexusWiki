/**
 * Per-workspace Answer entries.
 *
 * The demo/single-tenant composition keeps the process-wide shared entry.
 * A private workspace runs with its own chat / rerank / typesafe credentials
 * and its own physical vector index, so it gets a lazily composed entry cached
 * by (tenant, settings revision). Non-LLM infrastructure (ES, Neo4j, SQLite,
 * MCP tools) stays process-wide.
 */

import type OpenAI from "openai"
import type { AppConfig } from "../config"
import type { AnswerRuntime } from "../answer/runtime"
import type { AccessContext } from "../access/context"
import type { ReasoningCapability } from "../types"
import { createOpenAIClient, openaiClientOptions } from "../clients"
import { ActiveVersionRepository } from "../ingestion/tracking/active_version_repo"
import { PageIndexRepository } from "../ingestion/tracking/page_index_repo"
import type { WorkspaceModelProfileStore } from "../models/workspace_profiles"
import { createDedicatedReranker, type Reranker } from "../retrieval/search/dedicated_reranker"
import { RuntimeSearchOperations } from "../retrieval/search/searcher"
import {
  createSharedAnswerEntry,
  resolveReasoningCapability,
  type SharedAnswerEntry,
  type SharedAnswerEntryOptions,
  type SharedAnswerEventsSource,
} from "./shared_answer_entry"
import type { AnswerToolRuntime } from "./answer_route_stack"

type BaseEntryOptions = Omit<
  SharedAnswerEntryOptions,
  "config" | "answerRuntime" | "chatClient" | "toolRuntime" | "searchOperations" | "reranker"
>

export interface WorkspaceAnswerEntriesOptions {
  baseConfig: AppConfig
  answerRuntime: AnswerRuntime
  profiles: WorkspaceModelProfileStore
  sharedEntry: SharedAnswerEntry
  baseOptions: BaseEntryOptions
  toolRuntime?: AnswerToolRuntime
  /** Bound the cache; each entry owns only stateless clients. */
  maxEntries?: number
}

export class WorkspaceAnswerEntries {
  private readonly entries = new Map<string, Promise<SharedAnswerEntry>>()
  private readonly maxEntries: number

  constructor(private readonly options: WorkspaceAnswerEntriesOptions) {
    this.maxEntries = options.maxEntries ?? 32
  }

  private configFor(tenantId: string): AppConfig {
    const chat = this.options.profiles.credentials(tenantId, "chat")
    const embedding = this.options.profiles.credentials(tenantId, "embedding")
    const rerank = this.options.profiles.credentials(tenantId, "rerank")
    const typesafe = this.options.profiles.credentials(tenantId, "typesafe")
    const typesafeEnabled =
      this.options.profiles.list(tenantId).find((profile) => profile.id === "typesafe")?.enabled === true
    return {
      ...this.options.baseConfig,
      openaiApiKey: chat.apiKey,
      openaiBaseUrl: chat.baseUrl,
      openaiChatModel: chat.model,
      embeddingApiKey: embedding.apiKey,
      embeddingBaseUrl: embedding.baseUrl,
      embeddingModel: embedding.model,
      embeddingDimensions:
        embedding.dimensions ?? this.options.baseConfig.embeddingDimensions,
      rerankApiKey: rerank.apiKey,
      rerankBaseUrl: rerank.baseUrl,
      rerankModel: rerank.model,
      typesafeApiKey: typesafe.apiKey || undefined,
      typesafeBaseUrl: typesafe.baseUrl || undefined,
      typesafeModel: typesafe.model || undefined,
      decisionProvider:
        typesafeEnabled && typesafe.apiKey.length > 0 ? "typesafe" : "chat",
    }
  }

  private chatClient(config: AppConfig): OpenAI {
    return createOpenAIClient({
      apiKey: config.openaiApiKey,
      ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
      ...openaiClientOptions(config),
    })
  }

  private embeddingClient(config: AppConfig): OpenAI {
    return createOpenAIClient({
      apiKey: config.embeddingApiKey,
      ...(config.embeddingBaseUrl ? { baseURL: config.embeddingBaseUrl } : {}),
      ...openaiClientOptions(config),
    })
  }

  private rerankerFor(config: AppConfig): Reranker | undefined {
    return createDedicatedReranker({
      baseUrl: config.rerankBaseUrl,
      apiKey: config.rerankApiKey,
      model: config.rerankModel,
      timeoutMs: config.rerankTimeoutMs,
      maxDocumentChars: config.rerankMaxDocumentChars,
    })
  }

  private async entryFor(tenantId: string): Promise<SharedAnswerEntry> {
    const revision = this.options.profiles.revision(tenantId)
    const key = `${tenantId}\u0000${revision}`
    const cached = this.entries.get(key)
    if (cached) return cached

    const config = this.configFor(tenantId)
    const chatClient = this.chatClient(config)
    const embeddingClient = this.embeddingClient(config)
    const reranker = this.rerankerFor(config)
    const db = this.options.answerRuntime.processRuntime.db
    const searchOperations = new RuntimeSearchOperations({
      es: this.options.answerRuntime.processRuntime.elasticsearch,
      embeddingClient,
      embeddingModel: config.embeddingModel,
      indexName: this.options.profiles.chunkIndexName(tenantId),
      pageIndexRepo: new PageIndexRepository(db),
      activeVersionRepo: new ActiveVersionRepository(db),
      ...(reranker ? { reranker } : {}),
    })

    const promise = createSharedAnswerEntry({
      config,
      answerRuntime: this.options.answerRuntime,
      chatClient,
      searchOperations,
      ...(reranker ? { reranker } : {}),
      ...(this.options.toolRuntime ? { toolRuntime: this.options.toolRuntime } : {}),
      ...this.options.baseOptions,
    }).catch((error: unknown) => {
      this.entries.delete(key)
      throw error
    })

    this.entries.set(key, promise)
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (typeof oldest === "string") this.entries.delete(oldest)
    }
    return promise
  }

  /** The transport-level source every workspace run goes through. */
  readonly eventsSource: SharedAnswerEventsSource = (message, runOptions) => {
    const ctx = runOptions.accessContext
    if (!ctx || !this.options.profiles.isWorkspace(ctx.tenantId)) {
      return this.options.sharedEntry.eventsSource(message, runOptions)
    }
    const tenantId = ctx.tenantId
    const self = this
    return (async function* () {
      const entry = await self.entryFor(tenantId)
      yield* entry.eventsSource(message, runOptions)
    })()
  }

  capabilityFor(ctx: AccessContext): ReasoningCapability {
    if (!this.options.profiles.isWorkspace(ctx.tenantId)) {
      return this.options.sharedEntry.reasoningCapability
    }
    return resolveReasoningCapability(this.configFor(ctx.tenantId))
  }
}
