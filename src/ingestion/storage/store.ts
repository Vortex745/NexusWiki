import { type Client } from "@elastic/elasticsearch"
import { type OpenAI } from "openai"
import { setTimeout as delay } from "node:timers/promises"
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
const DEFAULT_CHUNK_BATCH_SIZE = 64
const DEFAULT_EMBEDDING_BATCH_MAX_BYTES = 150 * 1024
const EMBEDDING_REQUEST_TIMEOUT_MS = 60_000

export interface ChunkStoreMetrics {
  chunkCount: number
  passageCount: number
  batchCount: number
  embeddingBatchCount: number
  embeddingRequestCount: number
  embeddingRetryCount: number
  embeddingRateLimitCount: number
  embeddingDurationMs: number
  rateLimitWaitMs: number
  bulkRequestCount: number
  bulkDurationMs: number
}

function emptyChunkStoreMetrics(chunkCount = 0): ChunkStoreMetrics {
  return {
    chunkCount,
    passageCount: 0,
    batchCount: 0,
    embeddingBatchCount: 0,
    embeddingRequestCount: 0,
    embeddingRetryCount: 0,
    embeddingRateLimitCount: 0,
    embeddingDurationMs: 0,
    rateLimitWaitMs: 0,
    bulkRequestCount: 0,
    bulkDurationMs: 0,
  }
}

function isRateLimited(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 429
}

function retryAfterMs(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("headers" in error)) return null
  const headers = error.headers
  if (typeof headers !== "object" || headers === null || !("get" in headers) || typeof headers.get !== "function") return null
  const value = headers.get("retry-after")
  if (value === null) return null
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : null
}

function waitForPrevious<T>(previous: Promise<void>, signal?: AbortSignal): Promise<T> {
  if (!signal) return previous as Promise<T>
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(
      signal.reason ?? new DOMException("The operation was aborted", "AbortError")
    )
    signal.addEventListener("abort", onAbort, { once: true })
    previous.then(
      () => {
        signal.removeEventListener("abort", onAbort)
        resolve(undefined as T)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      }
    )
  })
}

/**
 * One embedding request at a time per store. The worker may ingest multiple
 * documents concurrently, but sending their provider calls together turns a
 * provider-side quota into a queue of retries. The queued slot remains
 * cancellable so stopping one document does not wait behind another request.
 */
class EmbeddingRequestGate {
  private tail = Promise.resolve()

  async run<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    let release!: () => void
    const previous = this.tail
    this.tail = new Promise<void>((resolve) => { release = resolve })
    try {
      await waitForPrevious(previous, signal)
      signal?.throwIfAborted()
      return await operation()
    } finally {
      release()
    }
  }
}
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
  private chunkBatchSize: number
  private embeddingBatchMaxBytes: number
  private ensureIndexPromise?: Promise<void>
  private embeddingGate?: EmbeddingRequestGate
  private embeddingCooldownUntil = 0

  constructor(clients?: {
    client?: Client
    embeddingClient?: OpenAI
    embeddingModel?: string
    embeddingDimensions?: number
    indexName?: string
    batchMaxChunks?: number
    batchMaxBytes?: number
  }) {
    if (clients?.client && clients.embeddingClient && clients.embeddingModel && clients.embeddingDimensions) {
      this.client = clients.client
      this.embeddingClient = clients.embeddingClient
      this.embeddingModel = clients.embeddingModel
      this.embeddingDimensions = clients.embeddingDimensions
      this.chunkBatchSize = clients.batchMaxChunks ?? DEFAULT_CHUNK_BATCH_SIZE
      this.embeddingBatchMaxBytes = clients.batchMaxBytes ?? DEFAULT_EMBEDDING_BATCH_MAX_BYTES
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
      // Production reads the config knobs so a provider that rejects large
      // batches is dialed back via env without a code change.
      this.chunkBatchSize = clients?.batchMaxChunks
        ?? cfg.embeddingBatchMaxChunks ?? DEFAULT_CHUNK_BATCH_SIZE
      this.embeddingBatchMaxBytes = clients?.batchMaxBytes
        ?? cfg.embeddingBatchMaxBytes ?? DEFAULT_EMBEDDING_BATCH_MAX_BYTES
    }
    this.indexName = clients?.indexName ?? INDEX_NAME
  }

  /** Eval refactor Ticket 02: the chunk index this store reads/writes. */
  get chunkIndexName(): string {
    return this.indexName
  }

  async ensureIndex(): Promise<void> {
    // Concurrent ingestion tasks share one ESStore; memoize the in-flight
    // verification so parallel storeChunks() calls don't race each other
    // into a double indices.create. Cleared on failure so retries re-verify.
    this.ensureIndexPromise ??= this.verifyOrCreateIndex().catch((error) => {
      this.ensureIndexPromise = undefined
      throw error
    })
    return this.ensureIndexPromise
  }

  private async verifyOrCreateIndex(): Promise<void> {
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
    accessMetadata: KnowledgeAccessMetadata,
    signal?: AbortSignal
  ): Promise<ChunkStoreMetrics> {
    const metrics = emptyChunkStoreMetrics(chunks.length)
    if (chunks.length === 0) return metrics
    if (
      !accessMetadata?.tenantId ||
      !Array.isArray(accessMetadata.allowedGroups) ||
      !accessMetadata.knowledgeBaseId
    ) {
      throw new Error("Chunk access metadata is required")
    }

    const { tenantId, allowedGroups, knowledgeBaseId } = accessMetadata
    this.embeddingGate ??= new EmbeddingRequestGate()
    this.embeddingCooldownUntil ??= 0
    for (let offset = 0; offset < chunks.length;) {
      signal?.throwIfAborted()
      let end = offset
      let embeddingBytes = 2 // JSON array brackets
      while (end < chunks.length && end - offset < this.chunkBatchSize) {
        const chunk = chunks[end]
        const nextBytes = chunk.metadata.kind === "parent"
          ? 0 : Buffer.byteLength(JSON.stringify(chunk.content)) + 1
        if (end > offset && embeddingBytes + nextBytes > this.embeddingBatchMaxBytes) break
        embeddingBytes += nextBytes
        end += 1
      }
      // Guard: a batch must always consume at least one chunk, otherwise the
      // outer for-loop never advances (e.g. a zero/undefined batch size from a
      // prototype-built instance) and spins the event loop forever.
      if (end === offset) end = offset + 1
      const batch = chunks.slice(offset, end)
      const passages = batch.filter((chunk) => chunk.metadata.kind !== "parent")
      metrics.batchCount += 1
      metrics.passageCount += passages.length
      const embeddings = new Map<string, number[]>()
      if (passages.length > 0) {
        metrics.embeddingBatchCount += 1
        const requestStarted = Date.now()
        let embRes: { data: Array<{ embedding: number[] }> }
        try {
          // Keep the complete retry sequence inside the gate. Releasing the
          // gate after a 429 but before publishing the cooldown lets another
          // document start a request in that window and recreate the burst.
          embRes = await this.embeddingGate.run(signal, async () => {
            for (let attempt = 0; ; attempt += 1) {
              const cooldown = Math.max(0, this.embeddingCooldownUntil - Date.now())
              if (cooldown > 0) {
                const waitStarted = Date.now()
                await delay(cooldown, undefined, { signal })
                metrics.rateLimitWaitMs += Date.now() - waitStarted
              }
              metrics.embeddingRequestCount += 1
              try {
                return await this.embeddingClient.embeddings.create({
                  model: this.embeddingModel,
                  input: passages.map(({ content }) => content),
                }, { signal, timeout: EMBEDDING_REQUEST_TIMEOUT_MS, maxRetries: 0 })
              } catch (error) {
                if (isRateLimited(error) && attempt < 3) {
                  metrics.embeddingRateLimitCount += 1
                  metrics.embeddingRetryCount += 1
                  const retryDelay = retryAfterMs(error) ?? Math.min(30_000, 1_000 * 2 ** attempt)
                  this.embeddingCooldownUntil = Math.max(
                    this.embeddingCooldownUntil,
                    Date.now() + retryDelay
                  )
                  continue
                }
                throw error
              }
            }
          })
          metrics.embeddingDurationMs += Date.now() - requestStarted
        } catch (error) {
          metrics.embeddingDurationMs += Date.now() - requestStarted
          if (signal?.aborted) throw error
          throw new Error(
            `Embedding batch at chunk ${offset} (${passages.length} passages, ${embeddingBytes} bytes) failed: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          )
        }
        for (let index = 0; index < passages.length; index += 1) {
          const passage = passages[index]
          embeddings.set(`${passage.documentId}\0${passage.id}`, embRes.data[index].embedding)
        }
      }

      const body = batch.flatMap((c) => [
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
      const refresh = end === chunks.length ? "wait_for" : false
      signal?.throwIfAborted()
      const bulkStarted = Date.now()
      const result = await this.client.bulk({ body, refresh }, { signal })
      metrics.bulkRequestCount += 1
      metrics.bulkDurationMs += Date.now() - bulkStarted
      if (result.errors) {
        const failure = result.items.find((item) => item.index?.error)?.index?.error
        throw new Error(`Elasticsearch bulk indexing failed: ${failure?.reason ?? "unknown error"}`)
      }
      offset = end
    }
    return metrics
  }

  /**
   * Ticket UT-16: read index entries back by logical identity so the pipeline
   * can verify what ACTUALLY landed in Elasticsearch against the expected
   * manifest — request success alone proves nothing. Only content and the
   * embedding vector are fetched.
   */
  async readIndexEntries(
    documentId: string,
    chunkIds: string[]
  ): Promise<Map<string, { content: string | null; embedding: number[] | null }>> {
    const entries = new Map<string, { content: string | null; embedding: number[] | null }>()
    if (chunkIds.length === 0) return entries
    const result = await this.client.mget(
      {
        index: this.indexName,
        ids: chunkIds.map((chunkId) => `${documentId}:${chunkId}`),
        _source: ["content", "embedding"],
      },
      { ignore: [404] }
    )
    const docs = (result as {
      docs?: Array<{
        _id?: string
        found?: boolean
        _source?: { content?: unknown; embedding?: unknown }
      }>
    }).docs ?? []
    const prefix = `${documentId}:`
    for (const doc of docs) {
      if (!doc.found || typeof doc._id !== "string" || !doc._id.startsWith(prefix)) continue
      const chunkId = doc._id.slice(prefix.length)
      const source = doc._source ?? {}
      entries.set(chunkId, {
        content: typeof source.content === "string" ? source.content : null,
        embedding: Array.isArray(source.embedding) ? (source.embedding as number[]) : null,
      })
    }
    return entries
  }

  /**
   * Ticket UT-17: 检索可见性探针——走实际检索边界（_search terms(_id)）
   * 统计期望条目中当前可被检索的数量。与 mget 回读不同，它证明条目在
   * 检索边界可见，而不只是按 id 可取。
   */
  async countVisibleIndexEntries(
    documentId: string,
    chunkIds: string[],
    options?: { tenantId?: string }
  ): Promise<number> {
    if (chunkIds.length === 0) return 0
    const result = await this.client.search({
      index: this.indexName,
      size: 0,
      track_total_hits: true,
      // Every _search on the chunk index is tenant-scoped (retrieval-boundary
      // invariant); the _id terms alone identify the document but the tenant
      // filter keeps the probe from ever counting another tenant's entries.
      query: {
        bool: {
          filter: [
            { terms: { _id: chunkIds.map((chunkId) => `${documentId}:${chunkId}`) } },
            ...(options?.tenantId ? [{ term: { tenantId: options.tenantId } }] : []),
          ],
        },
      },
    })
    const total = (result as { hits?: { total?: { value?: number } } }).hits?.total
    return typeof total?.value === "number" ? total.value : 0
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
    accessMetadata: KnowledgeAccessMetadata,
    signal?: AbortSignal
  ): Promise<ChunkStoreMetrics> {
    await this.es.ensureIndex()
    return this.es.storeChunks(chunks, accessMetadata, signal)
  }

  /** Ticket UT-16: read index entries back by logical identity (see ESStore). */
  readIndexEntries(
    documentId: string,
    chunkIds: string[]
  ): Promise<Map<string, { content: string | null; embedding: number[] | null }>> {
    return this.es.readIndexEntries(documentId, chunkIds)
  }

  /** Ticket UT-17: 检索可见性探针（see ESStore）。 */
  countVisibleIndexEntries(
    documentId: string,
    chunkIds: string[],
    options?: { tenantId?: string }
  ): Promise<number> {
    return this.es.countVisibleIndexEntries(documentId, chunkIds, options)
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
