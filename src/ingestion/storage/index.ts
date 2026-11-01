import { type Client } from "@elastic/elasticsearch"
import type { TracingRuntime } from "../../tracing/contract"
import { type OpenAI } from "openai"
import type { Chunk, Entity, Wikilink } from "../../types"
import { loadConfig, resolveChunkIndexName } from "../../config"
import {
  createElasticsearchClient,
  createOpenAIClient,
  openaiClientOptions,
} from "../../clients"
import { createDriver } from "../../graph"
import { createRunBudgetedOpenAIClient } from "../../runtime/openai_budget_client"
import {
  IngestionStoreImpl,
  type ChunkAccessMetadata,
  type ChunkStoreMetrics,
  type KnowledgeAccessMetadata,
  type KnowledgePersistenceDependencies,
} from "./store"

export type {
  ChunkAccessMetadata,
  ChunkStoreMetrics,
  KnowledgeAccessMetadata,
  KnowledgePersistenceDependencies,
} from "./store"
export { ESStore, Neo4jStore, IngestionStoreImpl } from "./store"

export interface IngestionStore {
  storeChunks(chunks: Chunk[], accessMetadata: ChunkAccessMetadata, signal?: AbortSignal): Promise<ChunkStoreMetrics>
  storeEntities(entities: Entity[]): Promise<void>
  storeWikilinks(
    wikilinks: Wikilink[],
    accessMetadata: KnowledgeAccessMetadata
  ): Promise<void>
}

/**
 * T21 factory: create a Knowledge persistence deep module with clients
 * built once from config. Callers should call this ONCE and share the result
 * across pipeline runs so that ES / OpenAI / Neo4j clients are not recreated
 * per document ingestion.
 *
 * For tests, construct `IngestionStoreImpl` directly with `KnowledgePersistenceDependencies`.
 */
let ingestionTracing: TracingRuntime | undefined

/**
 * Production composition hook: resolve the ingestion store of the document's
 * knowledge base (private workspaces use their own embedding profile and
 * physical index). Unconfigured callers keep the server-default store.
 */
export type IngestionStoreResolver = (knowledgeBaseId?: string) => IngestionStoreImpl
let configuredStoreResolver: IngestionStoreResolver | undefined

export function configureIngestionStoreResolver(
  resolver: IngestionStoreResolver | undefined
): void {
  configuredStoreResolver = resolver
}

function tracedEmbeddingClient(apiKey: string, baseURL?: string): OpenAI {
  return createRunBudgetedOpenAIClient(
    createOpenAIClient({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      ...openaiClientOptions(loadConfig()),
    }),
    ingestionTracing
  )
}

export interface IngestionStoreOverrides {
  embeddingClient?: OpenAI
  embeddingModel?: string
  embeddingDimensions?: number
  indexName?: string
  esClient?: import("@elastic/elasticsearch").Client
  graphDriver?: import("neo4j-driver").Driver
}

/**
 * LO-11: composition hook. The ingestion store builds its own embedding client
 * (it must not depend on the Answer runtime), so the composition root hands it
 * the process-wide tracing runtime once. Business code never reads a global.
 */
export function configureIngestionTracing(runtime: TracingRuntime | undefined): void {
  ingestionTracing = runtime
}

export function createIngestionStore(knowledgeBaseId?: string): IngestionStoreImpl {
  if (configuredStoreResolver) return configuredStoreResolver(knowledgeBaseId)
  return createDefaultIngestionStore()
}

/** The server-default store used by the demo/single-tenant path and tests. */
export function createDefaultIngestionStore(
  overrides: IngestionStoreOverrides = {}
): IngestionStoreImpl {
  const cfg = loadConfig()
  const deps: KnowledgePersistenceDependencies = {
    esClient:
      overrides.esClient ??
      createElasticsearchClient({
        node: cfg.esNode,
        apiKey: cfg.esApiKey || undefined,
      }),
    // LO-11: the ingestion store owns its embedding client, so it is wrapped
    // here with the runtime the composition root configured.
    embeddingClient:
      overrides.embeddingClient ??
      tracedEmbeddingClient(cfg.embeddingApiKey, cfg.embeddingBaseUrl || undefined),
    embeddingModel: overrides.embeddingModel ?? cfg.embeddingModel,
    embeddingDimensions: overrides.embeddingDimensions ?? cfg.embeddingDimensions,
    indexName: overrides.indexName ?? resolveChunkIndexName(undefined, cfg),
    graphDriver: overrides.graphDriver ?? createDriver(),
  }
  return new IngestionStoreImpl(deps)
}

/** Re-exported so the workspace resolver builds the same traced embedding client. */
export function createIngestionEmbeddingClient(apiKey: string, baseURL: string): OpenAI {
  return tracedEmbeddingClient(apiKey, baseURL)
}
