import type { Client } from "@elastic/elasticsearch"
import type OpenAI from "openai"
import type { Driver } from "neo4j-driver"
import { int as neo4jInt } from "neo4j-driver"
import { createDriver } from "../../graph"
import type { PageIndexRepository } from "../../ingestion/tracking/page_index_repo"
import type { ActiveVersionRepository } from "../../ingestion/tracking/active_version_repo"
import type { AccessContext } from "../../access/context"
import type { Query, RetrievalResult, Chunk } from "../../types"
import type { RetrievalScope } from "../../types/retrieval_scope"
import type {
  DebugCandidate,
  Reranker,
  RetrievalChannel,
  RetrievalDebugTrace,
  RetrievalOrdering,
  SearchOptions,
  SearchOutcome,
  Searcher,
} from "./interface"
import {
  ALL_RETRIEVAL_CHANNELS,
  RerankerNotConfiguredError,
  validateChannelSelection,
} from "./interface"
import { rrf } from "./rrf"

const INDEX_NAME = "kefu-rag-chunks"
const CHANNEL_TOP_K = 5
const RESULT_TOP_K = 10
/**
 * Eval refactor Ticket 03 — explicit small-candidate policy: a single
 * candidate has no ordering to decide, so the fused order is published with
 * an honest `below_threshold` label. Two or more candidates are always sent
 * to the configured dedicated reranker (there is no Chat-scoring path).
 */
const RERANK_MIN_CANDIDATES = 2
const GRAPH_CANDIDATE_MULTIPLIER = 4
const GRAPH_HOPS = 1
const PAGE_INDEX_NODE_LIMIT = 5

function abortError(message: string): Error {
  const err = new Error(message)
  err.name = "AbortError"
  return err
}

/**
 * Race a promise against an optional AbortSignal so a hung call (e.g. a
 * Neo4j `session.run` that has no native signal support) cannot hold the
 * retrieval stage open past the run deadline. The underlying promise is
 * NOT cancelled — callers must still release resources (session.close in
 * a finally block) — but the awaiting stage rejects promptly, converging
 * cancellation to the single AbortError terminal.
 */
function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  message: string
): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError(message))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(message))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

function childFilter() {
  return {
    bool: {
      minimum_should_match: 1,
      should: [
        { term: { kind: "child" } },
        { term: { kind: "image" } },
        { bool: { must_not: [{ exists: { field: "kind" } }] } },
      ],
    },
  }
}

/**
 * Ticket 07 P2: Build the Elasticsearch filter clauses that enforce Access
 * Context on a chunk index. Returns an empty array when no AccessContext is
 * supplied (legacy/single-tenant callers) so existing behavior is unchanged.
 *
 * Semantics (spec §6):
 * - tenantId is a hard filter — chunks from other tenants are never visible.
 * - allowedGroups=[] on the caller means "tenant-wide user" (e.g. the
 *   single-tenant default): no group filter is added, so the caller sees
 *   every same-tenant chunk.
 * - allowedGroups non-empty on the caller means "group-restricted user":
 *   a chunk is visible when its own allowedGroups is empty (tenant-wide
 *   chunk) OR intersects the caller's groups. ES `exists` returns false
 *   for an empty-array keyword field, so `must_not: exists` matches
 *   tenant-wide chunks reliably.
 */
function accessContextFilter(ac?: AccessContext): Array<Record<string, unknown>> {
  if (!ac) return []
  const filters: Array<Record<string, unknown>> = [
    { term: { tenantId: ac.tenantId } },
  ]
  if (ac.groups.length > 0) {
    filters.push({
      bool: {
        minimum_should_match: 1,
        should: [
          { bool: { must_not: [{ exists: { field: "allowedGroups" } }] } },
          { terms: { allowedGroups: ac.groups } },
        ],
      },
    })
  }
  return filters
}

/**
 * Ticket 05 (KB-03A): the knowledge-base dimension of a chunk filter.
 *
 * - No scope → no clause. A caller that carries no knowledge scope (legacy
 *   release probes, isolated evaluation runs) keeps its previous behavior.
 * - Scope with ids → one `terms` clause on the `knowledgeBaseId` keyword that
 *   ingestion stamps on every chunk (spec §8.1 L239).
 * - Scope with zero ids → also no clause HERE, because
 *   {@link hasNoKnowledgeContext} already made the channel return no evidence
 *   before any query was built. An empty scope must never degrade into an
 *   unfiltered read.
 */
function knowledgeBaseFilter(scope?: RetrievalScope): Array<Record<string, unknown>> {
  if (!scope || scope.knowledgeBaseIds.length === 0) return []
  return [{ terms: { knowledgeBaseId: [...scope.knowledgeBaseIds] } }]
}

/**
 * Ticket 05 (KB-03A, spec §8.1 L242): an explicit empty scope is "no knowledge
 * context" — a legal answer that means "search nothing", never "search
 * everything". Channels that enforce scope return zero evidence immediately,
 * before any embedding or search call is issued.
 */
function hasNoKnowledgeContext(scope?: RetrievalScope): boolean {
  return scope !== undefined && scope.knowledgeBaseIds.length === 0
}

/**
 * Ticket 06 (KB-03B): the knowledge-base dimension of an application-layer
 * filter over KB-tagged records — graph relation provenance and PageIndex
 * nodes. Graph entities are shared across knowledge bases, so the relation
 * records beneath them are what carries ownership; each one must be
 * authorized on its own or a shared entity would leak another knowledge
 * base's relations and supporting documents.
 *
 * - No scope → no filtering. A caller that carries no knowledge scope
 *   (legacy release probes, isolated evaluation runs) keeps its previous
 *   behavior.
 * - Scope present → a record survives only when it is tagged with a
 *   knowledgeBaseId inside the scope. An untagged record cannot be
 *   authorized, so it is dropped (fail-closed) — mirroring the ES `terms`
 *   clause, which can never match a document whose knowledgeBaseId field is
 *   missing.
 */
function filterByKnowledgeBase<T extends { knowledgeBaseId?: string }>(
  items: T[],
  scope?: RetrievalScope
): T[] {
  if (!scope) return items
  const allowed = new Set(scope.knowledgeBaseIds)
  return items.filter((item) =>
    item.knowledgeBaseId !== undefined && allowed.has(item.knowledgeBaseId)
  )
}

/**
 * Ticket 07 P3: Filter PageIndex nodes (or any node-shaped object) by Access
 * Context in the application layer, before linked Chunk IDs are extracted.
 * This enforces spec §6 "PageIndex lookup filters before linked Chunk IDs
 * are returned" without modifying the PageIndexRepository surface.
 *
 * Semantics mirror accessContextFilter:
 * - No AccessContext → no filtering (legacy/single-tenant callers).
 * - tenantId must match exactly.
 * - Caller groups empty (tenant-wide user) → all same-tenant nodes visible.
 * - Caller groups non-empty → node visible when its own allowedGroups is
 *   empty (tenant-wide node) OR intersects the caller's groups.
 */
function filterNodesByAccessContext<N extends { tenantId?: string; allowedGroups?: string[] }>(
  nodes: N[],
  ac?: AccessContext
): N[] {
  if (!ac) return nodes
  return nodes.filter((node) => {
    if (node.tenantId !== ac.tenantId) return false
    if (ac.groups.length === 0) return true
    const nodeGroups = node.allowedGroups ?? []
    if (nodeGroups.length === 0) return true
    return nodeGroups.some((g) => ac.groups.includes(g))
  })
}

/**
 * Ticket 07 P4: Filter graph provenance records by Access Context before
 * building the chunk-identity set used for ES recheck. Enforces spec §6:
 * "a result becomes Evidence only after its provenance resolves to an active
 * authorized Chunk."
 *
 * Semantics:
 * - No AccessContext → no filtering (legacy/single-tenant callers).
 * - Legacy 2-element provenance (no tenantId) passes through unchanged —
 *   the ES recheck is the authoritative gate for those records, since we
 *   cannot authorize them at the app layer without a tenant tag.
 * - 4-element provenance (with tenantId) is authorized at the app layer:
 *   tenantId must match exactly, and group semantics mirror
 *   filterNodesByAccessContext (empty caller groups = tenant-wide;
 *   empty provenance groups = tenant-wide chunk; otherwise intersect).
 */
function filterProvenanceByAccessContext<P extends { tenantId?: string; allowedGroups?: string[] }>(
  provenance: P[],
  ac?: AccessContext
): P[] {
  if (!ac) return provenance
  return provenance.filter((p) => {
    if (p.tenantId === undefined) return true
    if (p.tenantId !== ac.tenantId) return false
    if (ac.groups.length === 0) return true
    const pGroups = p.allowedGroups ?? []
    if (pGroups.length === 0) return true
    return pGroups.some((g) => ac.groups.includes(g))
  })
}

export interface SearchOperations {
  vectorSearch(query: Query, topK: number, hypothesis?: string, accessContext?: AccessContext, retrievalScope?: RetrievalScope, signal?: AbortSignal): Promise<RetrievalResult[]>
  bm25Search(query: Query, topK: number, accessContext?: AccessContext, retrievalScope?: RetrievalScope, signal?: AbortSignal): Promise<RetrievalResult[]>
  graphSearch(query: Query, topK: number, seeds?: string[], accessContext?: AccessContext, retrievalScope?: RetrievalScope, signal?: AbortSignal): Promise<RetrievalResult[]>
  pageIndexSearch(query: Query, topK: number, accessContext?: AccessContext, retrievalScope?: RetrievalScope, signal?: AbortSignal): Promise<RetrievalResult[]>
  rerank(query: string, results: RetrievalResult[], signal?: AbortSignal): Promise<RetrievalResult[]>
  loadParents(identities: Array<{ documentId: string; id: string }>, accessContext?: AccessContext, retrievalScope?: RetrievalScope, signal?: AbortSignal): Promise<Chunk[]>
}

export interface RuntimeSearchDependencies {
  es: Client
  /**
   * @deprecated Eval refactor Ticket 03: the Chat-per-fragment rerank was the
   * only consumer of this client and has been removed. Accepted (and ignored)
   * so existing construction sites keep compiling; do not add new readers.
   */
  chatClient?: OpenAI
  embeddingClient: OpenAI
  /**
   * @deprecated See {@link RuntimeSearchDependencies.chatClient}.
   */
  chatModel?: string
  embeddingModel: string
  graphDriver?: Driver
  pageIndexRepo?: PageIndexRepository
  activeVersionRepo?: ActiveVersionRepository
  /** Eval refactor Ticket 02: chunk index searched. Omitted → the business
   * index (legacy default). */
  indexName?: string
  /** Eval refactor Ticket 03: dedicated reranker. Omitted → retrieval
   * publishes the fused order and reports `rerank reason: not_configured`
   * (degraded status) instead of falling back to any other scorer. */
  reranker?: Reranker
}

export class RuntimeSearchOperations implements SearchOperations {
  constructor(private dependencies: RuntimeSearchDependencies) {}

  private get indexName(): string {
    return this.dependencies.indexName ?? INDEX_NAME
  }

  private activeTermsFilter(): Array<Record<string, unknown>> {
    const repo = this.dependencies.activeVersionRepo
    if (!repo) return []
    const docIds = repo.getActiveDocIds()
    return docIds.length > 0 ? [{ terms: { documentId: docIds } }] : []
  }

  async vectorSearch(query: Query, topK: number, hypothesis?: string, accessContext?: AccessContext, retrievalScope?: RetrievalScope, signal?: AbortSignal): Promise<RetrievalResult[]> {
    // Ticket 05 (KB-03A): an explicit empty scope means "no knowledge
    // context" — answer with no evidence, and do not even spend an embedding
    // call on it.
    if (hasNoKnowledgeContext(retrievalScope)) return []
    const embedInput = hypothesis && hypothesis.trim() ? hypothesis : query.text
    const emb = await this.dependencies.embeddingClient.embeddings.create(
      {
        model: this.dependencies.embeddingModel,
        input: embedInput,
      },
      { signal }
    )
    const filters = [
      childFilter(),
      ...this.activeTermsFilter(),
      ...accessContextFilter(accessContext),
      ...knowledgeBaseFilter(retrievalScope),
    ]
    const res = await this.dependencies.es.search({
      index: this.indexName,
      knn: {
        field: "embedding",
        query_vector: emb.data[0].embedding,
        k: topK,
        num_candidates: topK * 10,
        filter: filters.length > 1
          ? { bool: { must: filters } }
          : filters[0],
      },
      _source: true,
    }, { signal })
    return res.hits.hits.map((hit) => ({
      chunk: hit._source as unknown as Chunk,
      score: hit._score ?? 0,
      source: "vector" as const,
      wikilinks: [],
    }))
  }

  async bm25Search(query: Query, topK: number, accessContext?: AccessContext, retrievalScope?: RetrievalScope, signal?: AbortSignal): Promise<RetrievalResult[]> {
    // Ticket 05 (KB-03A): empty scope = no knowledge context, no query.
    if (hasNoKnowledgeContext(retrievalScope)) return []
    const res = await this.dependencies.es.search({
      index: this.indexName,
      query: {
        bool: {
          must: [{ match: { content: query.text } }],
          filter: [
            childFilter(),
            ...this.activeTermsFilter(),
            ...accessContextFilter(accessContext),
            ...knowledgeBaseFilter(retrievalScope),
          ],
        },
      },
      size: topK,
      _source: true,
    }, { signal })
    return res.hits.hits.map((hit) => ({
      chunk: hit._source as unknown as Chunk,
      score: hit._score ?? 0,
      source: "bm25" as const,
      wikilinks: [],
    }))
  }

  async graphSearch(query: Query, topK: number, seeds?: string[], accessContext?: AccessContext, retrievalScope?: RetrievalScope, signal?: AbortSignal): Promise<RetrievalResult[]> {
    // Ticket 06 (KB-03B): an explicit empty scope means "no knowledge
    // context" — no Neo4j session, no ES query, no evidence.
    if (hasNoKnowledgeContext(retrievalScope)) return []
    // createDriver() lazily initializes the singleton (idempotent) so a fresh
    // server process can serve graph queries without a prior ingestion run.
    const driver = this.dependencies.graphDriver ?? createDriver()
    const session = driver.session()
    const candidateLimit = topK * GRAPH_CANDIDATE_MULTIPLIER
    const graphQuery = query.text.normalize("NFKC").trim().toLowerCase().slice(0, 512)
    const queryTerms = [...new Set(graphQuery.match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 16)
    const seedList = Array.isArray(seeds)
      ? seeds.map((s) => String(s)).filter((s) => s.length > 0).slice(0, 16)
      : []
    try {
      const res = await raceAbort(
        session.run(
          `MATCH (e:Entity)
           WHERE toLower($query) CONTAINS toLower(e.name)
              OR any(a IN e.aliases WHERE toLower($query) CONTAINS toLower(a))
              OR any(term IN $queryTerms WHERE
                toLower(e.name) CONTAINS term OR
                any(a IN e.aliases WHERE toLower(a) CONTAINS term)
              )
              OR any(s IN $seeds WHERE toLower(e.name) = toLower(s))
           WITH e
           ORDER BY e.id
           LIMIT $entityLimit
           OPTIONAL MATCH (e)-[r]-(related:Entity)
           WITH e, r, related
           ORDER BY e.id, coalesce(r.fact, ''), related.id
           LIMIT $relationshipLimit
           WITH collect(DISTINCT e.name) + collect(DISTINCT related.name) AS names,
                collect(DISTINCT {
                  values: CASE
                    WHEN r.fact IS NOT NULL THEN [r.fact]
                    ELSE coalesce(r.relations, [])
                  END,
                  weight: coalesce(r.weight, 0.5),
                  provenance: coalesce(r.provenance, [])
                }) AS relationGroups
           RETURN names,
                  relationGroups`,
        {
          query: graphQuery,
          queryTerms,
          seeds: seedList,
          // Neo4j LIMIT parameters must be driver Integers — a plain JS number
          // serializes as Float (e.g. 20.0) and the server rejects it.
          entityLimit: neo4jInt(candidateLimit),
          relationshipLimit: neo4jInt(candidateLimit),
        }
        ),
        signal,
        "Answer run cancelled during graph query"
      )
      const names = [...new Set(
        res.records.flatMap((record) => record.get("names") as string[])
      )]
      const relations = res.records.flatMap((record) =>
        (record.get("relationGroups") as unknown[]).flatMap((group) => {
          if (!group || typeof group !== "object" || Array.isArray(group)) return []
          const values = (group as { values?: unknown }).values
          const rawWeight = (group as { weight?: unknown }).weight
          const rawProvenance = (group as { provenance?: unknown }).provenance
          if (!Array.isArray(values)) return []
          const weight = typeof rawWeight === "number" && Number.isFinite(rawWeight)
            ? Math.max(0, Math.min(1, rawWeight))
            : 0.5
          const provenance = filterByKnowledgeBase(
            filterProvenanceByAccessContext(
              parseGraphProvenance(rawProvenance),
              accessContext
            ),
            retrievalScope
          )
          return values.flatMap((value) => {
            if (typeof value !== "string") return []
            const separator = value.indexOf(":")
            const direction = value.slice(0, separator).split("->")
            if (separator < 0 || direction.length !== 2) return []
            return [{
              sourceEntityId: direction[0],
              targetEntityId: direction[1],
              relation: value.slice(separator + 1),
              weight,
              provenance,
            }]
          })
        })
      )
      const provenance = [...new Map(relations.flatMap(({ provenance = [] }) =>
        provenance.map(({ documentId, chunkId }) => [
          `${documentId}\0${chunkId}`,
          { documentId, id: chunkId },
        ] as const)
      )).values()].slice(0, candidateLimit)
      if (names.length === 0 && provenance.length === 0) return []
      const selected = new Set(provenance.map(({ documentId, id }) =>
        `${documentId}\0${id}`
      ))
      const boundedRelations = relations.flatMap((relation) => {
        const bounded = (relation.provenance ?? []).filter(({ documentId, chunkId }) =>
          selected.has(`${documentId}\0${chunkId}`)
        )
        return bounded.length > 0 ? [{ ...relation, provenance: bounded }] : []
      })

      const esRes = await this.dependencies.es.search({
        index: this.indexName,
        query: provenance.length > 0
          ? {
              bool: {
                minimum_should_match: 1,
          should: provenance.map(({ documentId, id }) => ({
            bool: {
              must: [
                { term: { documentId } },
                { term: { id } },
              ],
            },
          })),
          // Ticket 06 (KB-03B): hydration re-checks the knowledge scope so a
          // candidate is Evidence only after it resolves to a chunk the scope
          // still owns.
          filter: [childFilter(), ...this.activeTermsFilter(), ...accessContextFilter(accessContext), ...knowledgeBaseFilter(retrievalScope)],
              },
            }
          : {
              bool: {
                must: [{ multi_match: { query: names.join(" "), fields: ["content"] } }],
                // P2.2: fallback path mirrors primary path ACL + active-version
                // filters (closes GRAPH_RETRIEVAL_FALLBACK_BYPASS).
                // Ticket 06 (KB-03B): fallback hydration carries the knowledge
                // scope too.
                filter: [childFilter(), ...this.activeTermsFilter(), ...accessContextFilter(accessContext), ...knowledgeBaseFilter(retrievalScope)],
              },
            },
        size: topK,
        _source: true,
      }, { signal })
      return esRes.hits.hits.map((hit) => {
        const chunk = hit._source as unknown as Chunk
        const identity = `${chunk.documentId}\0${chunk.id}`
        const wikilinks = boundedRelations.filter(({ provenance = [] }) =>
          provenance.some(({ documentId, chunkId }) =>
            `${documentId}\0${chunkId}` === identity
          )
        )
        const graphPath = wikilinks.flatMap(({ sourceEntityId, relation, targetEntityId }) =>
          [sourceEntityId, relation, targetEntityId]
        ).slice(0, 32)
        return {
          chunk: {
            ...chunk,
            metadata: {
              ...chunk.metadata,
              ...(graphPath.length > 0 ? { graphPath } : {}),
            },
          },
          score: hit._score ?? 0,
          source: "graph" as const,
          wikilinks,
        }
      })
    } finally {
      await session.close()
    }
  }

  async pageIndexSearch(query: Query, topK: number, accessContext?: AccessContext, retrievalScope?: RetrievalScope, signal?: AbortSignal): Promise<RetrievalResult[]> {
    // Ticket 06 (KB-03B): an explicit empty scope means "no knowledge
    // context" — no node lookup, no ES query.
    if (hasNoKnowledgeContext(retrievalScope)) return []
    const repo = this.dependencies.pageIndexRepo
    if (!repo) throw new Error("pageIndex repository unavailable")
    const allNodes = repo.searchNodes(query.text, PAGE_INDEX_NODE_LIMIT)
    const nodes = filterByKnowledgeBase(
      filterNodesByAccessContext(allNodes, accessContext),
      retrievalScope
    )
    if (nodes.length === 0) return []
    const seen = new Set<string>()
    const unique = nodes.flatMap((node) =>
      node.linkedChunkIds.map((chunkId) => ({ documentId: node.documentId, chunkId }))
    ).filter(({ documentId, chunkId }) => {
      const key = `${documentId}\0${chunkId}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, topK)
    if (unique.length === 0) return []
    const esRes = await this.dependencies.es.search({
      index: this.indexName,
      query: {
        bool: {
          minimum_should_match: 1,
          should: unique.map(({ documentId, chunkId }) => ({
            bool: {
              must: [
                { term: { documentId } },
                { term: { id: chunkId } },
              ],
            },
          })),
          filter: [
            childFilter(),
            ...this.activeTermsFilter(),
            ...accessContextFilter(accessContext),
            // Ticket 06 (KB-03B): chunk hydration re-checks the knowledge scope.
            ...knowledgeBaseFilter(retrievalScope),
          ],
        },
      },
      size: topK,
      _source: true,
    }, { signal })
    return esRes.hits.hits.map((hit) => ({
      chunk: hit._source as unknown as Chunk,
      score: hit._score ?? 0,
      source: "pageIndex" as const,
      wikilinks: [],
    }))
  }

  async rerank(query: string, results: RetrievalResult[], signal?: AbortSignal): Promise<RetrievalResult[]> {
    const reranker = this.dependencies.reranker
    if (!reranker) {
      // No dedicated reranker configured. Treated exactly like a provider
      // failure so the caller degrades visibly — never silently.
      throw new RerankerNotConfiguredError()
    }
    return reranker.rerank(query, results, signal)
  }

  async loadParents(
    identities: Array<{ documentId: string; id: string }>,
    accessContext?: AccessContext,
    retrievalScope?: RetrievalScope,
    signal?: AbortSignal
  ): Promise<Chunk[]> {
    if (identities.length === 0) return []
    // Ticket 07 (KB-03C): an explicit empty scope means "no knowledge
    // context" — parent expansion returns nothing even on a direct call
    // (the dispatch layer already short-circuits before reaching here).
    if (hasNoKnowledgeContext(retrievalScope)) return []
    // Ticket 07 (KB-03C): parent expansion identities derive from already
    // scope-filtered children, but the ES query re-checks the knowledge scope
    // (like it re-checks the AccessContext) so a stale or collided identity
    // can never reintroduce content filtered from primary retrieval.
    const aclFilters = [
      ...accessContextFilter(accessContext),
      ...knowledgeBaseFilter(retrievalScope),
    ]
    const res = await this.dependencies.es.search({
      index: this.indexName,
      query: {
        bool: {
          minimum_should_match: 1,
          should: identities.map(({ documentId, id }) => ({
            bool: {
              must: [
                { term: { documentId } },
                { term: { id } },
                { term: { kind: "parent" } },
              ],
            },
          })),
          ...(aclFilters.length > 0 ? { filter: aclFilters } : {}),
        },
      },
      size: identities.length,
      _source: true,
    }, { signal })
    return res.hits.hits.map((hit) => hit._source as unknown as Chunk)
  }
}

function parseGraphProvenance(values: unknown): NonNullable<
  RetrievalResult["wikilinks"][number]["provenance"]
> {
  if (!Array.isArray(values)) return []
  const provenance = new Map<string, NonNullable<
    RetrievalResult["wikilinks"][number]["provenance"]
  >[number]>()
  for (const value of values) {
    if (typeof value !== "string") continue
    try {
      const parsed = JSON.parse(value)
      if (!Array.isArray(parsed)) continue
      const item = parsed.length === 2 && parsed.every((part) => typeof part === "string")
        ? { documentId: parsed[0], chunkId: parsed[1] }
        : parsed.length === 4 &&
            parsed.slice(0, 3).every((part) => typeof part === "string") &&
            Array.isArray(parsed[3]) &&
            parsed[3].every((part) => typeof part === "string")
          ? {
              documentId: parsed[0],
              chunkId: parsed[1],
              tenantId: parsed[2],
              allowedGroups: parsed[3],
            }
          // Ticket 03 (KB-02A): current writers append knowledgeBaseId as the
          // 6th element (index 5); the leading five keep their meaning. The
          // 2/4-element legacy branches above are untouched.
          : parsed.length === 6 &&
              parsed.slice(0, 3).every((part) => typeof part === "string") &&
              Array.isArray(parsed[3]) &&
              parsed[3].every((part) => typeof part === "string") &&
              typeof parsed[5] === "string"
            ? {
                documentId: parsed[0],
                chunkId: parsed[1],
                tenantId: parsed[2],
                allowedGroups: parsed[3],
                knowledgeBaseId: parsed[5],
              }
            : null
      if (!item) continue
      const key = `${item.documentId}\0${item.chunkId}`
      const existing = provenance.get(key)
      // Ticket 06 (KB-03B): the same chunk can appear once untagged and once
      // tagged when a re-ingestion appends to the same relation (store.ts
      // MERGE dedups by the JSON string only). The most-tagged record must
      // win — a 4-element entry outranking a 6-element one would make an
      // in-scope chunk unselectable under an explicit knowledge scope.
      const tagRank = (entry: { tenantId?: string; knowledgeBaseId?: string }) =>
        (entry.tenantId !== undefined ? 1 : 0) +
        (entry.knowledgeBaseId !== undefined ? 1 : 0)
      if (!existing || tagRank(item) > tagRank(existing)) {
        provenance.set(key, item)
      }
    } catch {
      continue
    }
  }
  return [...provenance.values()]
}

export class SearcherImpl implements Searcher {
  constructor(private operations: SearchOperations) {}

  async search(query: Query, options?: SearchOptions): Promise<SearchOutcome> {
    const hypothesis = options?.hypothesis
    const graphSeeds = options?.graphSeeds
    const accessContext = options?.accessContext
    // Ticket 05 (KB-03A): the server-computed knowledge scope. Vector and BM25
    // enforce it here; graph and PageIndex follow in Ticket 06.
    const retrievalScope = options?.retrievalScope
    // P7.2: honor cancellation at retrieval stage boundaries. When the
    // signal is already aborted at entry, reject immediately — no ES/Neo4j
    // queries are issued. Mid-run aborts are checked after allSettled and
    // after rerank so downstream work stops at the next boundary.
    const signal = options?.signal
    if (signal?.aborted) {
      const err = new Error("Answer run cancelled at GATE 1 (retrieval entry)")
      err.name = "AbortError"
      throw err
    }
    // Ticket 06: Resolve the caller's channel selection. undefined → all four
    // (backward compat); non-empty subset → only the requested channels.
    const selectedChannels = validateChannelSelection(options?.channels)
    const selectedSet = new Set<RetrievalChannel>(selectedChannels)
    const unselectedChannels = ALL_RETRIEVAL_CHANNELS.filter(
      (ch) => !selectedSet.has(ch)
    )
    // Ticket 14 (RET-01): the debug trace — the same implementation runs, only
    // instrumented. Ranks are 1-based stage positions.
    const debug = options?.debug === true
    const searchStarted = performance.now()
    const channelStages: RetrievalDebugTrace["channels"] = []
    const debugCandidate = (result: RetrievalResult, rank: number, score: number | null): DebugCandidate => ({
      rank,
      chunkId: result.chunk.id,
      documentId: result.chunk.documentId,
      title: typeof result.chunk.metadata.title === "string"
        ? (result.chunk.metadata.title as string).slice(0, 200)
        : "",
      excerpt: result.chunk.content.slice(0, 300),
      score,
    })
    // Ticket 05 (KB-03A): an explicit empty scope means "no knowledge context",
    // and that promise belongs to the whole search, not to two of its four
    // channels. Graph and PageIndex receive their own knowledge filter in
    // Ticket 06, so dispatching them here would answer from knowledge the
    // caller explicitly excluded. Nothing is queried at all; the outcome is the
    // same honest "insufficient" a caller gets when every channel fails, and
    // the existing Answer path turns it into an honest refusal. This guard is
    // what makes the empty-scope contract fail-closed rather than best-effort.
    if (hasNoKnowledgeContext(retrievalScope)) {
      return {
        status: "insufficient",
        results: [],
        // No channel failed — none ran. Reporting them as unavailable would
        // blame the channels for a scope decision the caller made.
        unavailableChannels: [],
        ...(unselectedChannels.length > 0 ? { unselectedChannels } : {}),
        ...(debug ? { debug: { channels: [], fused: { elapsedMs: 0, rawCandidateCount: 0, distinctCount: 0, candidates: [] }, totalMs: performance.now() - searchStarted } } : {}),
      }
    }
    const allChannelRunners: Array<{
      name: RetrievalChannel
      run: () => Promise<RetrievalResult[]>
    }> = [
      {
        name: "vector",
        run: () => this.operations.vectorSearch(query, CHANNEL_TOP_K, hypothesis, accessContext, retrievalScope, signal),
      },
      {
        name: "bm25",
        run: () => this.operations.bm25Search(query, CHANNEL_TOP_K, accessContext, retrievalScope, signal),
      },
      {
        name: "graph",
        run: () => this.operations.graphSearch(query, CHANNEL_TOP_K, graphSeeds, accessContext, retrievalScope, signal),
      },
      {
        name: "pageIndex",
        run: () => this.operations.pageIndexSearch(query, CHANNEL_TOP_K, accessContext, retrievalScope, signal),
      },
    ]
    const channelRunners = allChannelRunners
      .filter(({ name }) => selectedSet.has(name))
      .map(({ name, run }) => ({
        name,
        run: async (): Promise<RetrievalResult[]> => {
          if (!debug) return run()
          // Ticket 14 (RET-01): time the channel and record its raw ranks.
          const started = performance.now()
          try {
            const value = await run()
            channelStages.push({
              channel: name,
              ok: true,
              elapsedMs: performance.now() - started,
              candidates: value
                .filter(({ chunk }) => chunk.metadata.kind !== "parent")
                .map((result, index) => debugCandidate(result, index + 1, result.score)),
            })
            return value
          } catch (error) {
            channelStages.push({
              channel: name,
              ok: false,
              // Ticket 14 (RET-01): bounded — driver messages can embed
              // endpoints; the trace is bounded like every other field.
              error: (error instanceof Error ? error.message : String(error)).slice(0, 200),
              elapsedMs: performance.now() - started,
              candidates: [],
            })
            throw error
          }
        },
      }))
    const settled = await Promise.allSettled(channelRunners.map(({ run }) => run()))
    // P7.2: if the signal aborted while channel fetches were in flight,
    // stop downstream work (rerank/parent-load) at this boundary.
    if (signal?.aborted) {
      const err = new Error("Answer run cancelled at GATE 1 (after retrieval)")
      err.name = "AbortError"
      throw err
    }
    const unavailableChannels: RetrievalChannel[] = []
    const resultSets: RetrievalResult[][] = []

    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index]
      if (result.status === "fulfilled") {
        resultSets.push(result.value.filter(({ chunk }) =>
          chunk.metadata.kind !== "parent"
        ))
        continue
      }

      const channel = channelRunners[index].name
      unavailableChannels.push(channel)
      const message = result.reason instanceof Error
        ? result.reason.message
        : String(result.reason)
      console.warn(`[search] ${channel} channel unavailable:`, message)
    }

    if (unavailableChannels.length === channelRunners.length) {
      return {
        status: "insufficient",
        results: [],
        unavailableChannels,
        ...(unselectedChannels.length > 0
          ? { unselectedChannels }
          : {}),
        ...(debug
          ? {
              debug: {
                channels: orderedStages(channelStages),
                fused: { elapsedMs: 0, rawCandidateCount: 0, distinctCount: 0, candidates: [] },
                totalMs: performance.now() - searchStarted,
              },
            }
          : {}),
      }
    }

    const fusionStarted = performance.now()
    const fused = rrf(resultSets)
    const fusionElapsed = performance.now() - fusionStarted
    // Ticket 03: the published ordering carries its own score source. A fused
    // fallback is never presented as a dedicated-rerank result.
    let reranked = fused
    let rerankerFailed = false
    let ordering: RetrievalOrdering
    let rerankStage: RetrievalDebugTrace["rerank"]
    if (fused.length < RERANK_MIN_CANDIDATES) {
      ordering = { source: "fused", reason: "below_threshold" }
      rerankStage = debug
        ? { applied: false, reason: "below_threshold", elapsedMs: 0 }
        : undefined
    } else {
      const rerankStarted = performance.now()
      try {
        reranked = await this.operations.rerank(query.text, fused, signal)
        ordering = { source: "dedicated_rerank" }
        rerankStage = debug
          ? {
              applied: true,
              elapsedMs: performance.now() - rerankStarted,
              candidates: reranked.map((result, index) => debugCandidate(result, index + 1, result.score)),
            }
          : undefined
      } catch (error) {
        // P7.2: a cancellation that fires mid-rerank must terminate the run,
        // not degrade to "reranker unavailable" — aborts are rethrown so the
        // run converges to the single AbortError terminal.
        if (signal?.aborted) throw error
        rerankerFailed = true
        const reason = error instanceof RerankerNotConfiguredError ? "not_configured" : "unavailable"
        ordering = { source: "fused", reason }
        rerankStage = debug
          ? { applied: false, reason, elapsedMs: performance.now() - rerankStarted }
          : undefined
        const message = error instanceof Error ? error.message : String(error)
        console.warn("[search] reranker unavailable:", message)
      }
    }
    const results = reranked.slice(0, RESULT_TOP_K)
    const identities = [...new Map(
      results.flatMap(({ chunk }) => chunk.parentId
        ? [[`${chunk.documentId}\0${chunk.parentId}`, {
            documentId: chunk.documentId,
            id: chunk.parentId,
          }] as const]
        : [])
    ).values()]
    let parentExpansionFailed = false
    let parents: Chunk[] = []
    try {
      parents = await this.operations.loadParents(identities, accessContext, retrievalScope, signal)
    } catch (error) {
      // P7.2: same boundary as rerank — a mid-parent-load cancellation
      // terminates the run instead of degrading to
      // "parent expansion unavailable".
      if (signal?.aborted) throw error
      parentExpansionFailed = true
      const message = error instanceof Error ? error.message : String(error)
      console.warn("[search] parent expansion unavailable:", message)
    }
    const parentsById = new Map(parents.map((parent) => [
      `${parent.documentId}\0${parent.id}`,
      parent,
    ]))
    if (identities.some(({ documentId, id }) =>
      !parentsById.has(`${documentId}\0${id}`)
    )) {
      parentExpansionFailed = true
    }
    for (const result of results) {
      if (result.chunk.parentId) {
        result.parentChunk = parentsById.get(
          `${result.chunk.documentId}\0${result.chunk.parentId}`
        )
      }
    }
    const graphBudget = selectedSet.has("graph")
      ? {
          seeds: Array.isArray(graphSeeds)
            ? graphSeeds.map((s) => String(s)).filter((s) => s.length > 0).slice(0, 16)
            : [],
          hops: GRAPH_HOPS,
          candidates: CHANNEL_TOP_K * GRAPH_CANDIDATE_MULTIPLIER,
        }
      : undefined
    const degradationReasons: string[] = []
    if (parentExpansionFailed) degradationReasons.push("parent_expansion_unavailable")
    if (rerankerFailed) degradationReasons.push("reranker_unavailable")
    return {
      status: unavailableChannels.length === 0 && !parentExpansionFailed && !rerankerFailed
        ? "ok"
        : "degraded",
      results,
      unavailableChannels,
      ordering,
      ...(graphBudget ? { graphBudget } : {}),
      ...(degradationReasons.length > 0
        ? { degradationReasons }
        : {}),
      ...(unselectedChannels.length > 0
        ? { unselectedChannels }
        : {}),
      ...(debug
        ? {
            debug: {
              channels: orderedStages(channelStages),
              fused: {
                elapsedMs: fusionElapsed,
                rawCandidateCount: resultSets.reduce((sum, set) => sum + set.length, 0),
                distinctCount: fused.length,
                candidates: fused.map((result, index) => debugCandidate(result, index + 1, null)),
              },
              ...(rerankStage ? { rerank: rerankStage } : {}),
              totalMs: performance.now() - searchStarted,
            },
          }
        : {}),
    }
  }
}

/**
 * Ticket 14 (RET-01): channels run concurrently, so the trace is assembled in
 * the declared channel order, not completion order.
 */
function orderedStages(stages: RetrievalDebugTrace["channels"]): RetrievalDebugTrace["channels"] {
  const order = new Map(ALL_RETRIEVAL_CHANNELS.map((channel, index) => [channel, index]))
  return [...stages].sort(
    (left, right) => (order.get(left.channel) ?? 0) - (order.get(right.channel) ?? 0)
  )
}
