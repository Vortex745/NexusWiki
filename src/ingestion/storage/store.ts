import { type Client } from "@elastic/elasticsearch"
import { type OpenAI } from "openai"
import type { Driver } from "neo4j-driver"
import type { Chunk, Entity, Wikilink } from "../../types"
import { loadConfig } from "../../config"
import {
  createElasticsearchClient,
  createOpenAIClient,
  openaiClientOptions,
} from "../../clients"
import { getDriver } from "../../graph"

const INDEX_NAME = "kefu-rag-chunks"
const CHUNK_KEYWORD_PROPERTIES = {
  kind: { type: "keyword" as const },
  parentId: { type: "keyword" as const },
  childrenIds: { type: "keyword" as const },
  tenantId: { type: "keyword" as const },
  allowedGroups: { type: "keyword" as const },
  knowledgeBaseId: { type: "keyword" as const },
}

/**
 * T21 Knowledge persistence deep module dependencies.
 *
 * Injecting these allows the pipeline to share clients across runs and tests
 * to mock at the deep module seam. When omitted, the module falls back to
 * config-based clients (backward compat).
 */
export interface KnowledgePersistenceDependencies {
  esClient: Client
  embeddingClient: OpenAI
  embeddingModel: string
  embeddingDimensions: number
  graphDriver?: Driver
  /** Eval refactor Ticket 02: chunk index written by this store. Omitted →
   * the business index (legacy default). */
  indexName?: string
}

export interface KnowledgeAccessMetadata {
  tenantId: string
  allowedGroups: string[]
  /**
   * Ticket 03 (KB-02A): the knowledge base that owns the persisted artifact.
   * Required — persistence fails loudly rather than writing an unowned chunk
   * or provenance record (criterion 4).
   */
  knowledgeBaseId: string
}

export type ChunkAccessMetadata = KnowledgeAccessMetadata

export class ESStore {
  private client: Client
  private embeddingClient: OpenAI
  private embeddingModel: string
  private embeddingDimensions: number
  private indexName: string

  constructor(clients?: {
    client?: Client
    embeddingClient?: OpenAI
    embeddingModel?: string
    embeddingDimensions?: number
    indexName?: string
  }) {
    if (clients?.client && clients.embeddingClient && clients.embeddingModel && clients.embeddingDimensions) {
      this.client = clients.client
      this.embeddingClient = clients.embeddingClient
      this.embeddingModel = clients.embeddingModel
      this.embeddingDimensions = clients.embeddingDimensions
    } else {
      const cfg = loadConfig()
      this.client = clients?.client ?? createElasticsearchClient({
        node: cfg.esNode,
        apiKey: cfg.esApiKey || undefined,
      })
      this.embeddingClient = clients?.embeddingClient ?? createOpenAIClient({
        apiKey: cfg.embeddingApiKey,
        baseURL: cfg.embeddingBaseUrl || undefined,
        ...openaiClientOptions(cfg),
      })
      this.embeddingModel = clients?.embeddingModel ?? cfg.embeddingModel
      this.embeddingDimensions = clients?.embeddingDimensions ?? cfg.embeddingDimensions
    }
    this.indexName = clients?.indexName ?? INDEX_NAME
  }

  /** Eval refactor Ticket 02: the chunk index this store reads/writes. */
  get chunkIndexName(): string {
    return this.indexName
  }

  async ensureIndex(): Promise<void> {
    const exists = await this.client.indices.exists({ index: this.indexName })
    if (exists) {
      const mapping = await this.client.indices.getMapping({ index: this.indexName })
      const embedding = mapping[this.indexName]?.mappings.properties?.embedding as
        | { dims?: number }
        | undefined
      if (embedding?.dims !== this.embeddingDimensions) {
        throw new Error(
          `Elasticsearch index ${this.indexName} has ${embedding?.dims ?? "unknown"} embedding dimensions; expected ${this.embeddingDimensions}`
        )
      }
      const properties = mapping[this.indexName]?.mappings.properties ?? {}
      if (Object.keys(CHUNK_KEYWORD_PROPERTIES).some((name) => !(name in properties))) {
        await this.client.indices.putMapping({
          index: this.indexName,
          properties: CHUNK_KEYWORD_PROPERTIES,
        })
      }
      return
    }

    await this.client.indices.create({
      index: this.indexName,
      settings: { number_of_shards: 1, number_of_replicas: 0 },
      mappings: {
        properties: {
          id: { type: "keyword" },
          documentId: { type: "keyword" },
          ...CHUNK_KEYWORD_PROPERTIES,
          content: { type: "text" },
          embedding: {
            type: "dense_vector",
            dims: this.embeddingDimensions,
            index: true,
            similarity: "cosine",
          },
          metadata: { type: "object" },
        },
      },
    })
  }

  async storeChunks(
    chunks: Chunk[],
    accessMetadata: KnowledgeAccessMetadata
  ): Promise<void> {
    if (chunks.length === 0) return
    if (
      !accessMetadata?.tenantId ||
      !Array.isArray(accessMetadata.allowedGroups) ||
      !accessMetadata.knowledgeBaseId
    ) {
      throw new Error("Chunk access metadata is required")
    }

    const { tenantId, allowedGroups, knowledgeBaseId } = accessMetadata
    const passages = chunks.filter((chunk) => chunk.metadata.kind !== "parent")
    const embeddings = new Map<string, number[]>()
    if (passages.length > 0) {
      const embRes = await this.embeddingClient.embeddings.create({
        model: this.embeddingModel,
        input: passages.map(({ content }) => content),
      })
      for (let index = 0; index < passages.length; index += 1) {
        const passage = passages[index]
        embeddings.set(`${passage.documentId}\0${passage.id}`, embRes.data[index].embedding)
      }
    }

    const body = chunks.flatMap((c) => [
      { index: { _index: this.indexName, _id: `${c.documentId}:${c.id}` } },
      {
        id: c.id,
        documentId: c.documentId,
        tenantId,
        allowedGroups,
        knowledgeBaseId,
        kind: c.metadata.kind,
        content: c.content,
        ...(embeddings.has(`${c.documentId}\0${c.id}`)
          ? { embedding: embeddings.get(`${c.documentId}\0${c.id}`) }
          : {}),
        parentId: c.parentId,
        childrenIds: c.childrenIds,
        metadata: c.metadata,
      },
    ])
    const result = await this.client.bulk({ body, refresh: "wait_for" })
    if (result.errors) {
      const failure = result.items.find((item) => item.index?.error)?.index?.error
      throw new Error(`Elasticsearch bulk indexing failed: ${failure?.reason ?? "unknown error"}`)
    }
  }

  async close(): Promise<void> {
    await this.client.close()
  }
}

export class Neo4jStore {
  constructor(private driver?: Driver) {}

  async storeEntities(entities: Entity[]): Promise<void> {
    const driver = this.driver ?? getDriver()
    const session = driver.session()
    try {
      for (const e of entities) {
        await session.run(
          `MERGE (e:Entity {id: $id})
           SET e.name = $name, e.type = $type, e.aliases = $aliases`,
          { id: e.id, name: e.name, type: e.type, aliases: e.aliases }
        )
      }
    } finally {
      await session.close()
    }
  }

  async storeWikilinks(
    wikilinks: Wikilink[],
    accessMetadata: KnowledgeAccessMetadata
  ): Promise<void> {
    if (wikilinks.length === 0) return
    if (
      !accessMetadata?.tenantId ||
      !Array.isArray(accessMetadata.allowedGroups) ||
      !accessMetadata.knowledgeBaseId
    ) {
      throw new Error("Graph provenance access metadata is required")
    }

    const { tenantId, allowedGroups, knowledgeBaseId } = accessMetadata
    const driver = this.driver ?? getDriver()
    const session = driver.session()
    try {
      for (const w of wikilinks) {
        const [sourceId, targetId] = [w.sourceEntityId, w.targetEntityId].sort()
        const relation = `${w.sourceEntityId}->${w.targetEntityId}:${w.relation}`
        await session.run(
          `MATCH (a:Entity {id: $sourceId})
           MATCH (b:Entity {id: $targetId})
           MERGE (a)-[r:WIKILINK {fact: $relation}]->(b)
           SET r.weight = CASE WHEN r.weight IS NULL OR $weight > r.weight THEN $weight ELSE r.weight END,
           r.provenance = reduce(
             acc = coalesce(r.provenance, []),
             item IN $provenance |
             CASE WHEN item IN acc THEN acc ELSE acc + item END
           )`,
          {
            sourceId,
            targetId,
            relation,
            weight: w.weight,
            // Each entry is [documentId, chunkId, tenantId, allowedGroups,
            // weight, knowledgeBaseId] — the contributor's own weight travels
            // with its provenance so a scope that releases its share (eval
            // refactor ticket 02) can recompute the relation weight from the
            // remaining contributors instead of leaving `r.weight` raised.
            // Ticket 03 (KB-02A) appends knowledgeBaseId as the 6th element;
            // the leading five keep their positions for existing readers.
            provenance: (w.provenance ?? []).map(({ documentId, chunkId }) =>
              JSON.stringify([
                documentId,
                chunkId,
                tenantId,
                allowedGroups,
                w.weight,
                knowledgeBaseId,
              ])
            ),
          }
        )
      }
    } finally {
      await session.close()
    }
  }
}

export class IngestionStoreImpl {
  private es: ESStore
  private neo4j: Neo4jStore

  constructor(deps?: KnowledgePersistenceDependencies) {
    if (deps) {
      this.es = new ESStore({
        client: deps.esClient,
        embeddingClient: deps.embeddingClient,
        embeddingModel: deps.embeddingModel,
        embeddingDimensions: deps.embeddingDimensions,
        ...(deps.indexName ? { indexName: deps.indexName } : {}),
      })
      this.neo4j = new Neo4jStore(deps.graphDriver)
    } else {
      this.es = new ESStore()
      this.neo4j = new Neo4jStore()
    }
  }

  async storeChunks(
    chunks: Chunk[],
    accessMetadata: KnowledgeAccessMetadata
  ): Promise<void> {
    await this.es.ensureIndex()
    await this.es.storeChunks(chunks, accessMetadata)
  }

  async storeEntities(entities: Entity[]): Promise<void> {
    await this.neo4j.storeEntities(entities)
  }

  async storeWikilinks(
    wikilinks: Wikilink[],
    accessMetadata: KnowledgeAccessMetadata
  ): Promise<void> {
    await this.neo4j.storeWikilinks(wikilinks, accessMetadata)
  }

  async close(): Promise<void> {
    await this.es.close()
  }

  /** Eval refactor Ticket 02: the chunk index this store writes to. */
  get chunkIndexName(): string {
    return this.es.chunkIndexName
  }
}
