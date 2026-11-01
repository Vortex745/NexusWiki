/**
 * Resolve the ingestion store of a document's knowledge base.
 *
 * Private workspaces own a physical vector index and an embedding profile.
 * The worker reuses one pipeline runner for many tasks, so the store cannot be
 * cached on the runner — it is cached here by (workspace, profile, index) and
 * built from the shared ES / Neo4j clients owned by ProcessRuntime.
 */

import type { Client } from "@elastic/elasticsearch"
import type { Driver } from "neo4j-driver"

import type { AppConfig } from "../../config"
import { SqliteKnowledgeBaseRepo } from "../../knowledge/knowledge_base_repo"
import type { WorkspaceModelProfileStore } from "../../models/workspace_profiles"
import type { DB } from "../tracking/db"
import {
  createDefaultIngestionStore,
  createIngestionEmbeddingClient,
} from "./index"
import type { IngestionStoreImpl } from "./store"

export interface WorkspaceIngestionStoreDeps {
  db: DB
  config: AppConfig
  profiles: WorkspaceModelProfileStore
  elasticsearch: Client
  graphDriver: Driver
}

export type IngestionStoreForKnowledgeBase = (
  knowledgeBaseId?: string
) => IngestionStoreImpl

export function createWorkspaceIngestionStoreResolver(
  deps: WorkspaceIngestionStoreDeps
): IngestionStoreForKnowledgeBase {
  const repo = new SqliteKnowledgeBaseRepo(deps.db)
  const stores = new Map<string, IngestionStoreImpl>()

  const serverDefault = (): IngestionStoreImpl => {
    const cached = stores.get("server")
    if (cached) return cached
    const store = createDefaultIngestionStore({
      esClient: deps.elasticsearch,
      graphDriver: deps.graphDriver,
    })
    stores.set("server", store)
    return store
  }

  return (knowledgeBaseId?: string) => {
    if (!knowledgeBaseId) return serverDefault()
    const knowledgeBase = repo.getAcrossTenants(knowledgeBaseId)
    if (!knowledgeBase) {
      throw new Error(`knowledge base not found: ${knowledgeBaseId}`)
    }
    const tenantId = knowledgeBase.tenantId
    const profile = deps.profiles.embeddingProfile(tenantId)
    if (knowledgeBase.embeddingProfile !== profile) {
      throw new Error(
        `knowledge base embedding profile mismatch: ${knowledgeBase.embeddingProfile} != ${profile}`
      )
    }
    const credentials = deps.profiles.credentials(tenantId, "embedding")
    if (credentials.dimensions === null) {
      throw new Error("embedding dimensions are not configured for this workspace")
    }
    const indexName = deps.profiles.chunkIndexName(tenantId)
    const key = `${tenantId}\u0000${profile}\u0000${indexName}`
    const cached = stores.get(key)
    if (cached) return cached
    const store = createDefaultIngestionStore({
      esClient: deps.elasticsearch,
      graphDriver: deps.graphDriver,
      embeddingClient: createIngestionEmbeddingClient(
        credentials.apiKey,
        credentials.baseUrl
      ),
      embeddingModel: credentials.model,
      embeddingDimensions: credentials.dimensions,
      indexName,
    })
    stores.set(key, store)
    return store
  }
}
