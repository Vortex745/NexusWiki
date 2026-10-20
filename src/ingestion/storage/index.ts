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
 * LO-11: composition hook. The ingestion store builds its own embedding client
 * (it must not depend on the Answer runtime), so the composition root hands it
 * the process-wide tracing runtime once. Business code never reads a global.
 */
export function configureIngestionTracing(runtime: TracingRuntime | undefined): void {
  ingestionTracing = runtime
}

export function createIngestionStore(): IngestionStoreImpl {
  const cfg = loadConfig()
  const deps: KnowledgePersistenceDependencies = {
    esClient: createElasticsearchClient({
      node: cfg.esNode,
      apiKey: cfg.esApiKey || undefined,
    }),
    // LO-11: the ingestion store owns its embedding client, so it is wrapped
    // here with the runtime the composition root configured.
    embeddingClient: createRunBudgetedOpenAIClient(
      createOpenAIClient({
        apiKey: cfg.embeddingApiKey,
        baseURL: cfg.embeddingBaseUrl || undefined,
        ...openaiClientOptions(cfg),
      }),
      ingestionTracing,
    ),
    embeddingModel: cfg.embeddingModel,
    embeddingDimensions: cfg.embeddingDimensions,
    indexName: resolveChunkIndexName(undefined, cfg),
    graphDriver: createDriver(),
  }
  return new IngestionStoreImpl(deps)
}
