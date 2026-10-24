import assert from "node:assert/strict"
import test from "node:test"
import type { Client } from "@elastic/elasticsearch"
import type OpenAI from "openai"
import { int as neo4jInt } from "neo4j-driver"
import type { PageIndexNodeEligibility, PageIndexRepository } from "../../ingestion/tracking/page_index_repo"
import type { ActiveVersionRepository } from "../../ingestion/tracking/active_version_repo"
import type { AccessContext } from "../../access/context"
import type { Query, RetrievalResult } from "../../types"
import {
  RuntimeSearchOperations,
  SearcherImpl,
  type SearchOperations,
} from "./searcher"

function retrieval(
  id: string,
  source: RetrievalResult["source"],
  documentId = "doc-1"
): RetrievalResult {
  return {
    chunk: {
      id,
      documentId,
      content: `content-${id}`,
      childrenIds: [],
      metadata: { source: "test" },
    },
    score: 1,
    source,
    wikilinks: [],
  }
}

test("RRF preserves channel and graph provenance for shared evidence", async () => {
  const vector = retrieval("shared", "vector")
  const graph = retrieval("shared", "graph")
  vector.wikilinks = [{
    sourceEntityId: "refund",
    targetEntityId: "customer-service",
    relation: "POLICY_OF",
    weight: 0.2,
    provenance: [{ documentId: "doc-1", chunkId: "chunk-first" }],
  }]
  graph.chunk.metadata.graphPath = ["Refund", "POLICY_OF", "CustomerService"]
  graph.wikilinks = [{
    sourceEntityId: "refund",
    targetEntityId: "customer-service",
    relation: "POLICY_OF",
    weight: 0.8,
    provenance: [{ documentId: "doc-1", chunkId: "chunk-late" }],
  }]
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [vector],
    graphSearch: async () => [graph],
  }))

  const outcome = await searcher.search({ text: "query" })
  assert.equal(outcome.results.length, 1)
  assert.deepEqual(outcome.results[0].channels, ["vector", "graph"])
  assert.deepEqual(outcome.results[0].chunk.metadata.graphPath, graph.chunk.metadata.graphPath)
  assert.deepEqual(outcome.results[0].wikilinks, [{
    ...graph.wikilinks[0],
    provenance: [
      { documentId: "doc-1", chunkId: "chunk-first" },
      { documentId: "doc-1", chunkId: "chunk-late" },
    ],
  }])
})

test("RRF does not collapse equal chunk ids from different document versions", async () => {
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [retrieval("shared", "vector", "doc-v1")],
    bm25Search: async () => [retrieval("shared", "bm25", "doc-v2")],
  }))

  const outcome = await searcher.search({ text: "query" })
  assert.deepEqual(
    outcome.results.map(({ chunk }) => chunk.documentId),
    ["doc-v1", "doc-v2"]
  )
})

function operations(
  overrides: Partial<SearchOperations> = {}
): SearchOperations {
  return {
    vectorSearch: async () => [],
    bm25Search: async () => [],
    graphSearch: async () => [],
    pageIndexSearch: async () => [],
    rerank: async (_query, results) => results,
    loadParents: async () => [],
    ...overrides,
  }
}

test("runtime search recalls child, image, and legacy passages and loads parents by document", async () => {
  const requests: Array<Record<string, unknown>> = []
  const es = {
    async search(request: Record<string, unknown>) {
      requests.push(request)
      return { hits: { hits: [] } }
    },
  } as unknown as Client
  const embeddingClient = {
    embeddings: {
      create: async () => ({ data: [{ embedding: [0.1, 0.2] }] }),
    },
  } as unknown as OpenAI
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient,
    chatModel: "chat",
    embeddingModel: "embedding",
  })

  await runtime.vectorSearch({ text: "refund" }, 5)
  await runtime.bm25Search({ text: "refund" }, 5)
  await runtime.loadParents([
    { documentId: "doc-v1", id: "parent-shared" },
    { documentId: "doc-v2", id: "parent-shared" },
  ])

  const childFilter = {
    bool: {
      minimum_should_match: 1,
      should: [
        { term: { kind: "child" } },
        { term: { kind: "image" } },
        { bool: { must_not: [{ exists: { field: "kind" } }] } },
      ],
    },
  }
  assert.deepEqual(
    (requests[0].knn as { filter: unknown }).filter,
    childFilter
  )
  assert.deepEqual(
    ((requests[1].query as { bool: { filter: unknown[] } }).bool.filter),
    [childFilter]
  )
  assert.deepEqual(
    requests[2].query,
    {
      bool: {
        minimum_should_match: 1,
        should: [
          {
            bool: {
              must: [
                { term: { documentId: "doc-v1" } },
                { term: { id: "parent-shared" } },
                { term: { kind: "parent" } },
              ],
            },
          },
          {
            bool: {
              must: [
                { term: { documentId: "doc-v2" } },
                { term: { id: "parent-shared" } },
                { term: { kind: "parent" } },
              ],
            },
          },
        ],
      },
    }
  )
})

test("graph search follows provenance back to chunk evidence", async () => {
  let esRequest: Record<string, unknown> | undefined
  let graphQuery = ""
  let graphParams: Record<string, unknown> | undefined
  const evidence = retrieval("chunk-graph", "graph", "doc-v2").chunk
  const es = {
    async search(request: Record<string, unknown>) {
      esRequest = request
      return { hits: { hits: [{ _source: evidence, _score: 0.8 }] } }
    },
  } as unknown as Client
  const graphDriver = {
    session() {
      return {
        async run(query: string, params: Record<string, unknown>) {
          graphQuery = query
          graphParams = params
          return {
            records: [{
              get(key: string) {
                if (key === "names") return ["Refund Policy", "Customer"]
                if (key === "relationGroups") return [{
                  values: ["refund->customer:APPLIES_TO"],
                  weight: 0.8,
                  provenance: [
                    JSON.stringify(["doc-v2", "chunk-graph"]),
                    JSON.stringify([
                      "doc-v2",
                      "chunk-graph",
                      "tenant-a",
                      ["support"],
                    ]),
                  ],
                }]
                return []
              },
            }],
          }
        },
        async close() {},
      }
    },
  }
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })

  const results = await runtime.graphSearch({ text: "What is the Refund Policy?" }, 5)

  assert.match(graphQuery, /LIMIT \$entityLimit/)
  assert.match(graphQuery, /LIMIT \$relationshipLimit/)
  assert.match(graphQuery, /toLower\(\$query\) CONTAINS toLower\(e\.name\)/)
  assert.match(graphQuery, /term IN \$queryTerms/)
  assert.deepEqual(graphParams, {
    query: "what is the refund policy?",
    queryTerms: ["what", "is", "the", "refund", "policy"],
    seeds: [],
    // Neo4j LIMIT params must be driver Integers (plain numbers serialize as Float)
    entityLimit: neo4jInt(20),
    relationshipLimit: neo4jInt(20),
  })
  assert.deepEqual(
    ((esRequest?.query as { bool: { should: unknown[] } }).bool.should),
    [{
      bool: {
        must: [
          { term: { documentId: "doc-v2" } },
          { term: { id: "chunk-graph" } },
        ],
      },
    }]
  )
  assert.equal(results[0].chunk.id, "chunk-graph")
  assert.deepEqual(
    results[0].chunk.metadata.graphPath,
    ["refund", "APPLIES_TO", "customer"]
  )
  assert.deepEqual(results[0].wikilinks, [{
    sourceEntityId: "refund",
    targetEntityId: "customer",
    relation: "APPLIES_TO",
    weight: 0.8,
    provenance: [{
      documentId: "doc-v2",
      chunkId: "chunk-graph",
      tenantId: "tenant-a",
      allowedGroups: ["support"],
    }],
  }])
})

test("graph search bounds provenance lookup and keeps relationships on supporting chunks", async () => {
  let esRequest: Record<string, unknown> | undefined
  const es = {
    async search(request: Record<string, unknown>) {
      esRequest = request
      return {
        hits: {
          hits: [{
            _source: retrieval("chunk-0", "graph", "doc-v2").chunk,
            _score: 0.9,
          }],
        },
      }
    },
  } as unknown as Client
  const provenance = Array.from({ length: 25 }, (_, index) =>
    JSON.stringify(["doc-v2", `chunk-${index}`])
  )
  const graphDriver = {
    session() {
      return {
        async run() {
          return {
            records: [{
              get(key: string) {
                if (key === "names") return ["Refund Policy", "Customer", "Merchant"]
                if (key === "relationGroups") return [
                  {
                    values: ["refund->customer:APPLIES_TO"],
                    weight: 0.8,
                    provenance,
                  },
                  {
                    values: ["refund->merchant:EXCLUDES"],
                    weight: 0.6,
                    provenance: [JSON.stringify(["doc-v2", "chunk-24"])],
                  },
                ]
                return []
              },
            }],
          }
        },
        async close() {},
      }
    },
  }
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })

  const results = await runtime.graphSearch({ text: "refund" }, 5)

  const should = (esRequest?.query as { bool: { should: unknown[] } }).bool.should
  assert.equal(should.length, 20)
  assert.deepEqual(results[0].wikilinks, [{
    sourceEntityId: "refund",
    targetEntityId: "customer",
    relation: "APPLIES_TO",
    weight: 0.8,
    provenance: provenance.slice(0, 20).map((value) => {
      const [documentId, chunkId] = JSON.parse(value)
      return { documentId, chunkId }
    }),
  }])
})

test("hybrid search owns all channels, fusion, reranking, dedupe, and top-K", async () => {
  const calls: string[] = []
  const channelTopKs: number[] = []
  let rerankInput: string[] = []
  const searcher = new SearcherImpl(operations({
    vectorSearch: async (_query, topK) => {
      calls.push("vector")
      channelTopKs.push(topK)
      return ["a", "b", "c", "d", "e"].map((id) => retrieval(id, "vector"))
    },
    bm25Search: async (_query, topK) => {
      calls.push("bm25")
      channelTopKs.push(topK)
      return ["b", "f", "g", "h", "i"].map((id) => retrieval(id, "bm25"))
    },
    graphSearch: async (_query, topK) => {
      calls.push("graph")
      channelTopKs.push(topK)
      return ["i", "j", "k", "l", "m"].map((id) => retrieval(id, "graph"))
    },
    rerank: async (_query, results) => {
      calls.push("rerank")
      rerankInput = results.map(({ chunk }) => chunk.id)
      return [...results].reverse()
    },
  }))

  const outcome = await searcher.search({ text: "query" })

  assert.equal(outcome.status, "ok")
  assert.deepEqual(outcome.unavailableChannels, [])
  assert.deepEqual(calls.slice(0, 3).sort(), ["bm25", "graph", "vector"])
  assert.deepEqual(channelTopKs, [5, 5, 5])
  assert.equal(calls.at(-1), "rerank")
  assert.equal(new Set(rerankInput).size, rerankInput.length)
  assert.ok(rerankInput.includes("j"))
  assert.equal(rerankInput.length, 13)
  assert.equal(outcome.results.length, 10)
})

test("child recall expands a bounded parent without changing evidence identity", async () => {
  const child = retrieval("child-1", "vector")
  child.chunk.parentId = "parent-1"
  child.chunk.metadata.kind = "child"
  const parent = {
    id: "parent-1",
    documentId: child.chunk.documentId,
    content: "parent context",
    childrenIds: [child.chunk.id],
    metadata: { kind: "parent", source: "test" },
  }
  const parentHit = retrieval("parent-1", "bm25")
  parentHit.chunk = parent
  const loaded: Array<Array<{ documentId: string; id: string }>> = []
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [child],
    bm25Search: async () => [parentHit],
    loadParents: async (identities) => {
      loaded.push(identities)
      return [parent]
    },
  }))

  const outcome = await searcher.search({ text: "refund" })

  assert.deepEqual(loaded, [[{ documentId: "doc-1", id: "parent-1" }]])
  assert.equal(outcome.results.length, 1)
  assert.equal(outcome.results[0].chunk.id, "child-1")
  assert.equal(outcome.results[0].parentChunk?.id, "parent-1")
})

test("parent expansion failure degrades to the recalled child", async () => {
  const recalled = retrieval("child-1", "vector")
  recalled.chunk.parentId = "parent-1"
  recalled.chunk.metadata.kind = "child"
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [recalled],
    loadParents: async () => { throw new Error("parent lookup failed") },
  }))

  const outcome = await searcher.search({ text: "refund" })

  assert.equal(outcome.status, "degraded")
  assert.equal(outcome.results[0].chunk.id, "child-1")
  assert.equal(outcome.results[0].parentChunk, undefined)
  assert.deepEqual(outcome.degradationReasons, ["parent_expansion_unavailable"])
})

test("missing parent records degrade without dropping recalled children", async () => {
  const recalled = retrieval("child-missing-parent", "vector")
  recalled.chunk.parentId = "parent-missing"
  recalled.chunk.metadata.kind = "child"
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [recalled],
    loadParents: async () => [],
  }))

  const outcome = await searcher.search({ text: "refund" })

  assert.equal(outcome.status, "degraded")
  assert.equal(outcome.results[0].chunk.id, "child-missing-parent")
  assert.deepEqual(outcome.degradationReasons, ["parent_expansion_unavailable"])
})

test("reranker adapter reject degrades to fused results without escaping the seam", async () => {
  // Ticket 03: two candidates so the dedicated reranker is actually invoked
  // (a single candidate is never sent to the provider).
  const recalled = retrieval("rerank-failure-vector", "vector")
  const second = retrieval("rerank-failure-vector-2", "vector")
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [recalled, second],
    rerank: async () => { throw new Error("reranker model timeout") },
  }))

  const outcome = await searcher.search({ text: "query" })

  assert.equal(outcome.status, "degraded")
  assert.equal(outcome.results.length, 2)
  assert.equal(outcome.results[0].chunk.id, "rerank-failure-vector")
  assert.deepEqual(outcome.degradationReasons, ["reranker_unavailable"])
  assert.deepEqual(outcome.ordering, { source: "fused", reason: "unavailable" })
})

test("one unavailable channel returns degraded results from the others", async () => {
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [retrieval("a", "vector")],
    bm25Search: async () => [retrieval("b", "bm25")],
    graphSearch: async () => { throw new Error("neo4j unavailable") },
  }))

  const outcome = await searcher.search({ text: "query" })

  assert.equal(outcome.status, "degraded")
  assert.deepEqual(outcome.unavailableChannels, ["graph"])
  assert.deepEqual(
    outcome.results.map(({ chunk }) => chunk.id),
    ["a", "b"]
  )
})

test("all unavailable channels return an explicit insufficient outcome", async () => {
  let rerankCalled = false
  const unavailable = async (_query: Query): Promise<RetrievalResult[]> => {
    throw new Error("unavailable")
  }
  const searcher = new SearcherImpl(operations({
    vectorSearch: unavailable,
    bm25Search: unavailable,
    graphSearch: unavailable,
    pageIndexSearch: unavailable,
    rerank: async () => {
      rerankCalled = true
      return []
    },
  }))

  const outcome = await searcher.search({ text: "query" })

  assert.deepEqual(outcome, {
    status: "insufficient",
    results: [],
    unavailableChannels: ["vector", "bm25", "graph", "pageIndex"],
  })
  assert.equal(rerankCalled, false)
})

test("page index search recalls chunks linked to matching page index nodes", async () => {
  const pageIndexRepo = {
    searchNodes: () => [{
      documentId: "doc-1",
      nodeId: "node-1",
      title: "Refund Policy",
      sectionPath: ["Refund"],
      pageStart: 1,
      pageEnd: 5,
      summary: "refund policy summary",
      parentId: null,
      childIds: [],
      linkedChunkIds: ["chunk-1"],
    }],
    getNodesByDocument: () => [],
    replaceNodes: () => {},
  } as unknown as PageIndexRepository
  const es = {
    async search() {
      return {
        hits: {
          hits: [{
            _source: {
              id: "chunk-1",
              documentId: "doc-1",
              content: "refund content",
              childrenIds: [],
              metadata: { kind: "child" },
            },
            _score: 0.9,
          }],
        },
      }
    },
  } as unknown as Client
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    pageIndexRepo,
  })
  const results = await runtime.pageIndexSearch({ text: "refund" }, 5)
  assert.equal(results.length, 1)
  assert.equal(results[0].source, "pageIndex")
  assert.equal(results[0].chunk.id, "chunk-1")
})

test("pageIndex channel participates in fusion and degrades when unavailable", async () => {
  const unavailable = async (): Promise<RetrievalResult[]> => {
    throw new Error("unavailable")
  }
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [retrieval("shared", "vector")],
    pageIndexSearch: unavailable,
  }))
  const outcome = await searcher.search({ text: "query" })
  assert.equal(outcome.status, "degraded")
  assert.deepEqual(outcome.unavailableChannels, ["pageIndex"])
  assert.equal(outcome.results.length, 1)
  assert.deepEqual(outcome.results[0].channels, ["vector"])
})

test("active version filter excludes chunks from non-active document versions", async () => {
  const activeVersionRepo = {
    getActiveDocIds: () => ["doc-active"],
  } as unknown as ActiveVersionRepository
  const requests: Array<Record<string, unknown>> = []
  const es = {
    async search(request: Record<string, unknown>) {
      requests.push(request)
      return { hits: { hits: [] } }
    },
  } as unknown as Client
  const embeddingClient = {
    embeddings: {
      create: async () => ({ data: [{ embedding: [0.1] }] }),
    },
  } as unknown as OpenAI
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient,
    chatModel: "chat",
    embeddingModel: "embedding",
    activeVersionRepo,
  })
  await runtime.vectorSearch({ text: "query" }, 5)
  const knn = requests[0].knn as { filter: { bool: { must: Array<Record<string, unknown>> } } }
  const termsFilter = knn.filter.bool.must.find((f) => "terms" in f) as { terms: { documentId: string[] } }
  assert.deepEqual(termsFilter.terms.documentId, ["doc-active"])
})

test("no active version filter when repo is absent", async () => {
  const requests: Array<Record<string, unknown>> = []
  const es = {
    async search(request: Record<string, unknown>) {
      requests.push(request)
      return { hits: { hits: [] } }
    },
  } as unknown as Client
  const embeddingClient = {
    embeddings: {
      create: async () => ({ data: [{ embedding: [0.1] }] }),
    },
  } as unknown as OpenAI
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient,
    chatModel: "chat",
    embeddingModel: "embedding",
  })
  await runtime.vectorSearch({ text: "query" }, 5)
  const knn = requests[0].knn as { filter: { bool: { must?: unknown } } }
  assert.equal(knn.filter.bool.must, undefined)
})

test("Ticket 07 P1: Searcher.search passes accessContext to each channel", async () => {
  const calls: Array<{ channel: string; accessContext?: AccessContext }> = []
  const ops = operations({
    vectorSearch: async (_q, _k, _h, ac) => {
      calls.push({ channel: "vector", accessContext: ac })
      return []
    },
    bm25Search: async (_q, _k, ac) => {
      calls.push({ channel: "bm25", accessContext: ac })
      return []
    },
    graphSearch: async (_q, _k, _s, ac) => {
      calls.push({ channel: "graph", accessContext: ac })
      return []
    },
    pageIndexSearch: async (_q, _k, ac) => {
      calls.push({ channel: "pageIndex", accessContext: ac })
      return []
    },
  })
  const searcher = new SearcherImpl(ops)
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["team-x"],
    scopes: ["chat"],
  }
  await searcher.search({ text: "query" }, { accessContext: ac })
  assert.equal(calls.length, 4)
  for (const call of calls) {
    assert.equal(
      call.accessContext,
      ac,
      `${call.channel} channel should receive the same accessContext reference`
    )
  }
})

test("Ticket 07 P1: Searcher.search passes undefined accessContext when omitted (backward compat)", async () => {
  const calls: Array<{ channel: string; accessContext?: AccessContext }> = []
  const ops = operations({
    vectorSearch: async (_q, _k, _h, ac) => {
      calls.push({ channel: "vector", accessContext: ac })
      return []
    },
    bm25Search: async (_q, _k, ac) => {
      calls.push({ channel: "bm25", accessContext: ac })
      return []
    },
    graphSearch: async (_q, _k, _s, ac) => {
      calls.push({ channel: "graph", accessContext: ac })
      return []
    },
    pageIndexSearch: async (_q, _k, ac) => {
      calls.push({ channel: "pageIndex", accessContext: ac })
      return []
    },
  })
  const searcher = new SearcherImpl(ops)
  await searcher.search({ text: "query" })
  assert.equal(calls.length, 4)
  for (const call of calls) {
    assert.equal(
      call.accessContext,
      undefined,
      `${call.channel} channel should receive undefined when caller omits accessContext`
    )
  }
})

function makeRuntime(es: Client, embeddingClient: OpenAI, activeVersionRepo?: ActiveVersionRepository) {
  return new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient,
    chatModel: "chat",
    embeddingModel: "embedding",
    ...(activeVersionRepo ? { activeVersionRepo } : {}),
  })
}

function mockEs() {
  const requests: Array<Record<string, unknown>> = []
  const es = {
    async search(request: Record<string, unknown>) {
      requests.push(request)
      return { hits: { hits: [] } }
    },
  } as unknown as Client
  return { requests, es }
}

function mockEmbedding() {
  return {
    embeddings: {
      create: async () => ({ data: [{ embedding: [0.1] }] }),
    },
  } as unknown as OpenAI
}

test("Ticket 07 P2: vectorSearch includes tenant filter when accessContext is provided", async () => {
  const { requests, es } = mockEs()
  const runtime = makeRuntime(es, mockEmbedding())
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: [],
    scopes: ["chat"],
  }
  await runtime.vectorSearch({ text: "query" }, 5, undefined, ac)
  const filterStr = JSON.stringify(requests[0].knn)
  assert.ok(
    filterStr.includes('"tenantId":"tenant-a"'),
    `vector knn filter should contain tenantId term: ${filterStr}`
  )
})

test("Ticket 07 P2: vectorSearch includes group filter when accessContext.groups is non-empty", async () => {
  const { requests, es } = mockEs()
  const runtime = makeRuntime(es, mockEmbedding())
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["team-x", "team-y"],
    scopes: ["chat"],
  }
  await runtime.vectorSearch({ text: "query" }, 5, undefined, ac)
  const filterStr = JSON.stringify(requests[0].knn)
  assert.ok(
    filterStr.includes('"allowedGroups":["team-x","team-y"]'),
    `vector knn filter should contain allowedGroups terms query: ${filterStr}`
  )
  assert.ok(
    filterStr.includes('"must_not"'),
    `vector knn filter should contain must_not exists for tenant-wide chunks: ${filterStr}`
  )
})

test("Ticket 07 P2: vectorSearch without accessContext has no tenant or group filter (backward compat)", async () => {
  const { requests, es } = mockEs()
  const runtime = makeRuntime(es, mockEmbedding())
  await runtime.vectorSearch({ text: "query" }, 5)
  const filterStr = JSON.stringify(requests[0].knn)
  assert.ok(
    !filterStr.includes("tenantId"),
    `vector knn filter must not contain tenantId when accessContext omitted: ${filterStr}`
  )
  assert.ok(
    !filterStr.includes("allowedGroups"),
    `vector knn filter must not contain allowedGroups when accessContext omitted: ${filterStr}`
  )
})

test("Ticket 07 P2: bm25Search includes tenant and group filter when accessContext is provided", async () => {
  const { requests, es } = mockEs()
  const runtime = makeRuntime(es, mockEmbedding())
  const ac: AccessContext = {
    tenantId: "tenant-b",
    subjectId: "user-2",
    groups: ["team-z"],
    scopes: ["chat"],
  }
  await runtime.bm25Search({ text: "query" }, 5, ac)
  const filterStr = JSON.stringify(requests[0].query)
  assert.ok(
    filterStr.includes('"tenantId":"tenant-b"'),
    `bm25 query filter should contain tenantId term: ${filterStr}`
  )
  assert.ok(
    filterStr.includes('"allowedGroups":["team-z"]'),
    `bm25 query filter should contain allowedGroups terms query: ${filterStr}`
  )
})

test("Ticket 07 P2: bm25Search without accessContext has no tenant or group filter (backward compat)", async () => {
  const { requests, es } = mockEs()
  const runtime = makeRuntime(es, mockEmbedding())
  await runtime.bm25Search({ text: "query" }, 5)
  const filterStr = JSON.stringify(requests[0].query)
  assert.ok(
    !filterStr.includes("tenantId"),
    `bm25 query filter must not contain tenantId when accessContext omitted: ${filterStr}`
  )
  assert.ok(
    !filterStr.includes("allowedGroups"),
    `bm25 query filter must not contain allowedGroups when accessContext omitted: ${filterStr}`
  )
})

function makePageIndexRepo(nodes: Array<{
  documentId: string
  linkedChunkIds: string[]
  tenantId?: string
  allowedGroups?: string[]
  knowledgeBaseId?: string
}>) {
  return {
    searchNodes: () => nodes,
  } as unknown as PageIndexRepository
}

test("Ticket 07 P3: pageIndexSearch filters PageIndex nodes by tenantId before ES lookup", async () => {
  const { requests, es } = mockEs()
  const pageIndexRepo = makePageIndexRepo([
    { documentId: "doc-same-tenant", linkedChunkIds: ["chunk-a"], tenantId: "tenant-a", allowedGroups: [] },
    { documentId: "doc-cross-tenant", linkedChunkIds: ["chunk-b"], tenantId: "tenant-b", allowedGroups: [] },
  ])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: mockEmbedding(),
    chatModel: "chat",
    embeddingModel: "embedding",
    pageIndexRepo,
  })
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: [],
    scopes: ["chat"],
  }
  await runtime.pageIndexSearch({ text: "query" }, 5, ac)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"documentId":"doc-same-tenant"'),
    `pageIndex ES query should include same-tenant documentId: ${queryStr}`
  )
  assert.ok(
    !queryStr.includes('"documentId":"doc-cross-tenant"'),
    `pageIndex ES query must exclude cross-tenant documentId: ${queryStr}`
  )
})

test("Ticket 07 P3: pageIndexSearch filters PageIndex nodes by allowedGroups for group-restricted user", async () => {
  const { requests, es } = mockEs()
  const pageIndexRepo = makePageIndexRepo([
    { documentId: "doc-tenant-wide", linkedChunkIds: ["chunk-a"], tenantId: "tenant-a", allowedGroups: [] },
    { documentId: "doc-team-x", linkedChunkIds: ["chunk-b"], tenantId: "tenant-a", allowedGroups: ["team-x"] },
    { documentId: "doc-team-y", linkedChunkIds: ["chunk-c"], tenantId: "tenant-a", allowedGroups: ["team-y"] },
  ])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: mockEmbedding(),
    chatModel: "chat",
    embeddingModel: "embedding",
    pageIndexRepo,
  })
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["team-x"],
    scopes: ["chat"],
  }
  await runtime.pageIndexSearch({ text: "query" }, 5, ac)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"documentId":"doc-tenant-wide"'),
    `pageIndex ES query should include tenant-wide document (empty allowedGroups): ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"documentId":"doc-team-x"'),
    `pageIndex ES query should include group-matching document: ${queryStr}`
  )
  assert.ok(
    !queryStr.includes('"documentId":"doc-team-y"'),
    `pageIndex ES query must exclude non-matching group document: ${queryStr}`
  )
})

test("Ticket 07 P3: pageIndexSearch without accessContext does not filter nodes (backward compat)", async () => {
  const { requests, es } = mockEs()
  const pageIndexRepo = makePageIndexRepo([
    { documentId: "doc-1", linkedChunkIds: ["chunk-a"], tenantId: "tenant-a", allowedGroups: [] },
    { documentId: "doc-2", linkedChunkIds: ["chunk-b"], tenantId: "tenant-b", allowedGroups: [] },
  ])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: mockEmbedding(),
    chatModel: "chat",
    embeddingModel: "embedding",
    pageIndexRepo,
  })
  await runtime.pageIndexSearch({ text: "query" }, 5)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"documentId":"doc-1"'),
    `pageIndex ES query should include doc-1 when no accessContext: ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"documentId":"doc-2"'),
    `pageIndex ES query should include doc-2 when no accessContext: ${queryStr}`
  )
})

test("Ticket 07 P3: pageIndexSearch ES recheck includes ACL filter when accessContext provided", async () => {
  const { requests, es } = mockEs()
  const pageIndexRepo = makePageIndexRepo([
    { documentId: "doc-1", linkedChunkIds: ["chunk-a"], tenantId: "tenant-a", allowedGroups: [] },
  ])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: mockEmbedding(),
    chatModel: "chat",
    embeddingModel: "embedding",
    pageIndexRepo,
  })
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: [],
    scopes: ["chat"],
  }
  await runtime.pageIndexSearch({ text: "query" }, 5, ac)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"tenantId":"tenant-a"'),
    `pageIndex ES recheck filter should contain tenantId: ${queryStr}`
  )
})

/**
 * Ticket 07 P4: graph channel ACL filter.
 *
 * Spec §6: "Graph traversal may discover shared entity nodes internally, but
 * a result becomes Evidence only after its provenance resolves to an active
 * authorized Chunk." We enforce this by:
 *  1. Filtering provenance records (4-element format carrying tenantId +
 *     allowedGroups) by AccessContext before building the chunk-identity set.
 *  2. Adding accessContextFilter to the ES recheck query as defense-in-depth.
 *
 * Legacy 2-element provenance (no tenantId) passes through the app-layer
 * filter; the ES recheck is the authoritative gate for those records.
 */
function makeGraphDriver(relationGroups: Array<{
  values: string[]
  weight: number
  provenance: string[]
}>) {
  return {
    session() {
      return {
        async run() {
          return {
            records: [{
              get(key: string) {
                if (key === "names") return ["Refund Policy", "Customer"]
                if (key === "relationGroups") return relationGroups
                return []
              },
            }],
          }
        },
        async close() {},
      }
    },
  }
}

test("Ticket 07 P4: graphSearch filters provenance by tenantId before ES recheck", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [
      JSON.stringify(["doc-same", "chunk-a", "tenant-a", []]),
      JSON.stringify(["doc-cross", "chunk-b", "tenant-b", []]),
    ],
  }])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: [],
    scopes: ["chat"],
  }
  await runtime.graphSearch({ text: "refund" }, 5, undefined, ac)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"documentId":"doc-same"'),
    `graph ES recheck should include same-tenant provenance chunk: ${queryStr}`
  )
  assert.ok(
    !queryStr.includes('"documentId":"doc-cross"'),
    `graph ES recheck must exclude cross-tenant provenance chunk: ${queryStr}`
  )
})

test("Ticket 07 P4: graphSearch filters provenance by allowedGroups for group-restricted user", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [
      JSON.stringify(["doc-tenant-wide", "chunk-wide", "tenant-a", []]),
      JSON.stringify(["doc-support", "chunk-sup", "tenant-a", ["support"]]),
      JSON.stringify(["doc-finance", "chunk-fin", "tenant-a", ["finance"]]),
    ],
  }])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["support"],
    scopes: ["chat"],
  }
  await runtime.graphSearch({ text: "refund" }, 5, undefined, ac)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"documentId":"doc-tenant-wide"'),
    `graph ES recheck should include tenant-wide provenance chunk: ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"documentId":"doc-support"'),
    `graph ES recheck should include group-matching provenance chunk: ${queryStr}`
  )
  assert.ok(
    !queryStr.includes('"documentId":"doc-finance"'),
    `graph ES recheck must exclude non-matching group provenance chunk: ${queryStr}`
  )
})

test("Ticket 07 P4: graphSearch without accessContext does not filter provenance (backward compat)", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [
      JSON.stringify(["doc-a", "chunk-a", "tenant-a", []]),
      JSON.stringify(["doc-b", "chunk-b", "tenant-b", []]),
    ],
  }])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })
  await runtime.graphSearch({ text: "refund" }, 5)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"documentId":"doc-a"'),
    `graph ES recheck should include doc-a when no accessContext: ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"documentId":"doc-b"'),
    `graph ES recheck should include doc-b when no accessContext: ${queryStr}`
  )
  assert.ok(
    !queryStr.includes('"tenantId"'),
    `graph ES recheck must not contain tenantId filter when accessContext omitted: ${queryStr}`
  )
})

test("Ticket 07 P4: graphSearch ES recheck includes ACL filter when accessContext provided", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [
      JSON.stringify(["doc-a", "chunk-a", "tenant-a", []]),
    ],
  }])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: [],
    scopes: ["chat"],
  }
  await runtime.graphSearch({ text: "refund" }, 5, undefined, ac)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"tenantId":"tenant-a"'),
    `graph ES recheck filter should contain tenantId: ${queryStr}`
  )
})

test("Ticket 07 P4: graphSearch legacy 2-element provenance passes through app-layer filter to ES gate", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    // Legacy 2-element format: no tenantId/allowedGroups carried.
    provenance: [JSON.stringify(["doc-legacy", "chunk-legacy"])],
  }])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: [],
    scopes: ["chat"],
  }
  await runtime.graphSearch({ text: "refund" }, 5, undefined, ac)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"documentId":"doc-legacy"'),
    `graph ES recheck should include legacy 2-element provenance (ES is authoritative gate): ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"tenantId":"tenant-a"'),
    `graph ES recheck must still apply tenantId filter as authoritative gate: ${queryStr}`
  )
})

/**
 * P2.2 — Graph fallback path ACL enforcement (closes GRAPH_RETRIEVAL_FALLBACK_BYPASS).
 *
 * When graph provenance is empty but entity names are found, the fallback ES
 * recheck uses a `multi_match` query. P2.1 recorded that this fallback omitted
 * accessContextFilter and activeTermsFilter; P2.2 closes the bypass by mirroring
 * the primary path's filter array. These tests prove the fallback path is
 * exercised (multi_match shape, not primary bool.should) AND applies the ACL +
 * active-version filters that deny missing-tenant / cross-tenant / wrong-group /
 * inactive-version candidates. Backward compat: when accessContext is undefined
 * and no activeVersionRepo is wired, the fallback filter is just [childFilter()]
 * — identical to pre-P2.2 behavior (bare router mounts / single-tenant callers).
 */

test("P2.2 fallback path is exercised when provenance is empty (multi_match query shape, not primary bool.should)", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [], // empty provenance → fallback path
  }])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })
  await runtime.graphSearch({ text: "refund" }, 5)
  const query = requests[0].query as { bool: { must: unknown[] } }
  assert.ok(
    Array.isArray(query.bool.must) && query.bool.must.length === 1,
    "fallback path must use multi_match in bool.must"
  )
  const must = query.bool.must[0] as { multi_match?: unknown }
  assert.ok(
    must.multi_match !== undefined,
    "fallback path must use multi_match query (not primary bool.should with documentId/id terms)"
  )
})

test("P2.2 fallback deny: missing tenant tag → tenantId filter present (fail closed for untagged)", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [], // empty provenance → fallback path
  }])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: [],
    scopes: ["chat"],
  }
  await runtime.graphSearch({ text: "refund" }, 5, undefined, ac)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"multi_match"'),
    `fallback path must be exercised (multi_match shape): ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"tenantId":"tenant-a"'),
    `fallback ES query must contain tenantId filter — a chunk without tenantId field (legacy untagged) will not match ES term query → denied (fail closed): ${queryStr}`
  )
})

test("P2.2 fallback deny: cross-tenant → tenantId filter present (denies tenant-b chunk when caller is tenant-a)", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [],
  }])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: [],
    scopes: ["chat"],
  }
  await runtime.graphSearch({ text: "refund" }, 5, undefined, ac)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"multi_match"'),
    `fallback path must be exercised: ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"tenantId":"tenant-a"'),
    `fallback ES query must contain tenantId filter — a chunk with tenantId="tenant-b" will not match → cross-tenant denied: ${queryStr}`
  )
})

test("P2.2 fallback deny: wrong group → allowedGroups filter present (denies non-intersecting group)", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [],
  }])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["support"],
    scopes: ["chat"],
  }
  await runtime.graphSearch({ text: "refund" }, 5, undefined, ac)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"multi_match"'),
    `fallback path must be exercised: ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"allowedGroups":["support"]'),
    `fallback ES query must contain allowedGroups filter — a chunk with allowedGroups=["finance"] will not intersect → wrong-group denied: ${queryStr}`
  )
})

test("P2.2 fallback deny: inactive version → documentId terms filter present (denies non-active documents)", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [],
  }])
  const activeVersionRepo = {
    getActiveDocIds: () => ["doc-active"],
  } as unknown as ActiveVersionRepository
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
    activeVersionRepo,
  })
  await runtime.graphSearch({ text: "refund" }, 5)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"multi_match"'),
    `fallback path must be exercised: ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"documentId":["doc-active"]'),
    `fallback ES query must contain documentId terms filter — a chunk with documentId="doc-inactive" will not match → inactive-version denied: ${queryStr}`
  )
})

test("P2.2 fallback backward compat: no accessContext and no activeVersionRepo → fallback filter unchanged (just childFilter)", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [],
  }])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })
  // No accessContext, no activeVersionRepo — backward compat with bare router
  // mounts and legacy callers. accessContextFilter(undefined) returns [] and
  // activeTermsFilter() returns [] when no repo is wired, so the fallback
  // filter array stays as [childFilter()] — identical to pre-P2.2 behavior.
  await runtime.graphSearch({ text: "refund" }, 5)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"multi_match"'),
    `fallback path must be exercised: ${queryStr}`
  )
  assert.ok(
    !queryStr.includes('"tenantId"'),
    `fallback ES query must NOT contain tenantId when accessContext omitted (backward compat): ${queryStr}`
  )
  assert.ok(
    !queryStr.includes('"allowedGroups"'),
    `fallback ES query must NOT contain allowedGroups when accessContext omitted (backward compat): ${queryStr}`
  )
  assert.ok(
    !queryStr.includes('"terms"'),
    `fallback ES query must NOT contain terms filter when activeVersionRepo absent (backward compat): ${queryStr}`
  )
})

/**
 * P2.3 — Graph outage and provenance regression.
 *
 * Proves that graph driver outage degrades gracefully (no crash, no hang) and
 * that Evidence produced during outage — whether from other channels (hard
 * outage: driver throws) or from the graph fallback path (soft outage: graph
 * returns empty provenance) — still carries correct tenant/group/active-
 * version attribution. No unauthorized Evidence leaks under outage conditions.
 *
 * Backward compat: when accessContext is undefined, outage degradation
 * behavior is unchanged (no ACL filter added, identical to pre-P2.3).
 *
 * Situation A (test-only): graphSearch already has try/finally that propagates
 * session.run() errors; SearcherImpl.search uses Promise.allSettled that
 * captures rejections gracefully. The fallback path ACL enforcement is already
 * in place (P2.2). No searcher.ts modification needed — these tests verify the
 * existing outage handling and prove no leak path exists.
 */

// Helper: graph driver whose session.run() throws (Neo4j unreachable)
function makeThrowingGraphDriver(error: Error) {
  return {
    session() {
      return {
        async run() { throw error },
        async close() {},
      }
    },
  }
}

// Helper: graph driver whose session() throws (driver not connected)
function makeBrokenGraphDriver(error: Error) {
  return {
    session() { throw error },
  }
}

test("P2.3 outage: graph driver session.run throws → SearcherImpl degrades gracefully (graph unavailable, other channels produce results)", async () => {
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [retrieval("a", "vector")],
    bm25Search: async () => [retrieval("b", "bm25")],
    graphSearch: async () => { throw new Error("Neo4j: could not perform discovery") },
  }))
  const outcome = await searcher.search({ text: "query" })
  assert.equal(outcome.status, "degraded")
  assert.deepEqual(outcome.unavailableChannels, ["graph"])
  assert.deepEqual(
    outcome.results.map(({ chunk }) => chunk.id).sort(),
    ["a", "b"]
  )
})

test("P2.3 outage: accessContext propagated to all available channels during graph outage", async () => {
  const calls: Array<{ channel: string; accessContext?: AccessContext }> = []
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["support"],
    scopes: ["chat"],
  }
  const searcher = new SearcherImpl(operations({
    vectorSearch: async (_q, _k, _h, accessContext) => {
      calls.push({ channel: "vector", accessContext })
      return [retrieval("a", "vector")]
    },
    bm25Search: async (_q, _k, accessContext) => {
      calls.push({ channel: "bm25", accessContext })
      return [retrieval("b", "bm25")]
    },
    graphSearch: async () => { throw new Error("neo4j unavailable") },
    pageIndexSearch: async (_q, _k, accessContext) => {
      calls.push({ channel: "pageIndex", accessContext })
      return []
    },
  }))
  await searcher.search({ text: "query" }, { accessContext: ac })
  assert.equal(calls.length, 3, "graph threw; the other 3 channels should still be called")
  for (const call of calls) {
    assert.equal(
      call.accessContext,
      ac,
      `${call.channel} should receive accessContext during graph outage`
    )
  }
})

test("P2.3 outage: no unauthorized leak — ES queries from available channels contain all 3 ACL filters (tenant + group + active-version) during outage", async () => {
  const { requests, es } = mockEs()
  const activeVersionRepo = {
    getActiveDocIds: () => ["doc-active"],
  } as unknown as ActiveVersionRepository
  const graphDriver = makeThrowingGraphDriver(new Error("Neo4j unreachable"))
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: mockEmbedding(),
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
    activeVersionRepo,
  })
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["support"],
    scopes: ["chat"],
  }
  // graphSearch throws (outage); vector + bm25 succeed with ACL filters
  await runtime.graphSearch({ text: "query" }, 5, undefined, ac).catch(() => {})
  await runtime.vectorSearch({ text: "query" }, 5, undefined, ac)
  await runtime.bm25Search({ text: "query" }, 5, ac)
  for (const request of requests) {
    const queryStr = JSON.stringify(request)
    assert.ok(
      queryStr.includes('"tenantId":"tenant-a"'),
      `ES query during graph outage must contain tenantId filter (no cross-tenant leak): ${queryStr}`
    )
    assert.ok(
      queryStr.includes('"allowedGroups":["support"]'),
      `ES query during graph outage must contain allowedGroups filter (no wrong-group leak): ${queryStr}`
    )
    assert.ok(
      queryStr.includes('"documentId":["doc-active"]'),
      `ES query during graph outage must contain documentId terms filter (no inactive-version leak): ${queryStr}`
    )
  }
})

test("P2.3 outage: backward compat — accessContext undefined → degradation behavior unchanged (no ACL filter)", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeThrowingGraphDriver(new Error("Neo4j unreachable"))
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: mockEmbedding(),
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })
  // No accessContext, no activeVersionRepo — backward compat with bare mounts
  await runtime.graphSearch({ text: "query" }, 5).catch(() => {})
  await runtime.vectorSearch({ text: "query" }, 5)
  await runtime.bm25Search({ text: "query" }, 5)
  for (const request of requests) {
    const queryStr = JSON.stringify(request)
    assert.ok(
      !queryStr.includes('"tenantId"'),
      `ES query during graph outage must NOT contain tenantId when accessContext omitted (backward compat): ${queryStr}`
    )
    assert.ok(
      !queryStr.includes('"allowedGroups"'),
      `ES query during graph outage must NOT contain allowedGroups when accessContext omitted (backward compat): ${queryStr}`
    )
    assert.ok(
      !queryStr.includes('"terms"'),
      `ES query during graph outage must NOT contain terms filter when activeVersionRepo absent (backward compat): ${queryStr}`
    )
  }
})

test("P2.3 outage: graph driver session() throws (driver itself broken) → graphSearch throws before ES query", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeBrokenGraphDriver(new Error("driver not connected"))
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: mockEmbedding(),
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })
  // graphSearch should throw (session() throws before try block)
  await assert.rejects(
    runtime.graphSearch({ text: "query" }, 5),
    /driver not connected/,
    "graphSearch should propagate the session() error"
  )
  assert.equal(
    requests.length, 0,
    "no ES query should be issued when graph driver session() throws"
  )
})

test("P2.3 outage: no hang — search completes promptly during graph outage", async () => {
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [retrieval("a", "vector")],
    graphSearch: async () => { throw new Error("ServiceUnavailable: Neo4j bolt connection refused") },
  }))
  const start = Date.now()
  const outcome = await searcher.search({ text: "query" })
  const elapsed = Date.now() - start
  assert.equal(outcome.status, "degraded")
  assert.deepEqual(outcome.unavailableChannels, ["graph"])
  assert.ok(
    elapsed < 5000,
    `search should complete promptly during outage (elapsed: ${elapsed}ms)`
  )
  assert.equal(outcome.results.length, 1)
})

test("P2.3 provenance regression: fallback path (empty provenance) Evidence carries all 3 ACL attributions (tenant + group + active-version)", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [], // empty provenance → fallback path (soft outage / partial failure)
  }])
  const activeVersionRepo = {
    getActiveDocIds: () => ["doc-active"],
  } as unknown as ActiveVersionRepository
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
    activeVersionRepo,
  })
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["support"],
    scopes: ["chat"],
  }
  await runtime.graphSearch({ text: "refund" }, 5, undefined, ac)
  const queryStr = JSON.stringify(requests[0].query)
  // Regression: P2.2's fix must still be in place — fallback path carries all 3 filters
  assert.ok(
    queryStr.includes('"multi_match"'),
    `fallback path must be exercised (multi_match shape): ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"tenantId":"tenant-a"'),
    `fallback ES query must contain tenantId filter (P2.2 regression — no cross-tenant leak): ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"allowedGroups":["support"]'),
    `fallback ES query must contain allowedGroups filter (P2.2 regression — no wrong-group leak): ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"documentId":["doc-active"]'),
    `fallback ES query must contain documentId terms filter (P2.2 regression — no inactive-version leak): ${queryStr}`
  )
})

test("P2.3 outage: full SearcherImpl flow with RuntimeSearchOperations — graph throws, other channels produce ACL-filtered Evidence", async () => {
  const { requests, es } = mockEs()
  const pageIndexRepo = {
    searchNodes: () => [],
  } as unknown as PageIndexRepository
  const graphDriver = makeThrowingGraphDriver(new Error("Neo4j unreachable"))
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: mockEmbedding(),
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
    pageIndexRepo,
  })
  const searcher = new SearcherImpl(runtime)
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["support"],
    scopes: ["chat"],
  }
  const outcome = await searcher.search({ text: "query" }, { accessContext: ac })
  assert.equal(outcome.status, "degraded")
  assert.deepEqual(outcome.unavailableChannels, ["graph"])
  // All ES queries from available channels (vector, bm25) must contain ACL filters
  for (const request of requests) {
    const queryStr = JSON.stringify(request)
    assert.ok(
      queryStr.includes('"tenantId":"tenant-a"'),
      `ES query during outage should contain tenantId filter: ${queryStr}`
    )
    assert.ok(
      queryStr.includes('"allowedGroups":["support"]'),
      `ES query during outage should contain allowedGroups filter: ${queryStr}`
    )
  }
})

/**
 * Ticket 07 P5: loadParents ES ACL filter.
 *
 * Spec §6: "RRF, rerank, parent expansion, Context assembly and Citation
 * generation operate only on already-authorized results. No later stage may
 * broaden visibility." Parent expansion identities are derived from already-
 * authorized children, but defense-in-depth requires the ES query to also
 * enforce AccessContext so a cross-tenant parent (e.g. due to documentId
 * collision or data corruption) can never leak.
 *
 * Backward compat: when no accessContext is supplied, the query shape is
 * exactly the legacy shape (no `filter` key) so existing deepEqual assertions
 * and single-tenant callers are unaffected.
 */
test("Ticket 07 P5: loadParents includes tenant filter when accessContext provided", async () => {
  const { requests, es } = mockEs()
  const runtime = makeRuntime(es, mockEmbedding())
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: [],
    scopes: ["chat"],
  }
  await runtime.loadParents(
    [{ documentId: "doc-1", id: "parent-1" }],
    ac
  )
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"tenantId":"tenant-a"'),
    `loadParents ES query should contain tenantId filter: ${queryStr}`
  )
})

test("Ticket 07 P5: loadParents includes group filter when accessContext.groups is non-empty", async () => {
  const { requests, es } = mockEs()
  const runtime = makeRuntime(es, mockEmbedding())
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["support"],
    scopes: ["chat"],
  }
  await runtime.loadParents(
    [{ documentId: "doc-1", id: "parent-1" }],
    ac
  )
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"allowedGroups":["support"]'),
    `loadParents ES query should contain allowedGroups filter: ${queryStr}`
  )
})

test("Ticket 07 P5: loadParents without accessContext has no filter (backward compat)", async () => {
  const { requests, es } = mockEs()
  const runtime = makeRuntime(es, mockEmbedding())
  await runtime.loadParents([{ documentId: "doc-1", id: "parent-1" }])
  const query = requests[0].query as { bool: Record<string, unknown> }
  assert.ok(
    !("filter" in query.bool),
    `loadParents ES query must not have filter key when accessContext omitted: ${JSON.stringify(query)}`
  )
  assert.ok(
    !JSON.stringify(query).includes("tenantId"),
    `loadParents ES query must not contain tenantId when accessContext omitted: ${JSON.stringify(query)}`
  )
})

test("Ticket 07 P5: SearcherImpl.search passes accessContext to loadParents", async () => {
  const child = retrieval("child-1", "vector")
  child.chunk.parentId = "parent-1"
  child.chunk.metadata.kind = "child"
  const parent = {
    id: "parent-1",
    documentId: child.chunk.documentId,
    content: "parent context",
    childrenIds: [child.chunk.id],
    metadata: { kind: "parent", source: "test" },
  }
  const loadParentsCalls: Array<{ accessContext?: AccessContext }> = []
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [child],
    loadParents: async (identities, accessContext?) => {
      loadParentsCalls.push({ accessContext })
      return [parent]
    },
  }))
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["support"],
    scopes: ["chat"],
  }
  await searcher.search({ text: "query" }, { accessContext: ac })
  assert.equal(loadParentsCalls.length, 1, "loadParents should be called exactly once")
  assert.deepEqual(
    loadParentsCalls[0].accessContext,
    ac,
    "loadParents should receive the same accessContext as Searcher.search"
  )
})

// === Ticket 06 P2: Channel selection ===

test("Ticket 06 P2: default search (no channels option) executes all four channels and omits unselectedChannels", async () => {
  const calls: string[] = []
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => { calls.push("vector"); return [retrieval("a", "vector")] },
    bm25Search: async () => { calls.push("bm25"); return [retrieval("b", "bm25")] },
    graphSearch: async () => { calls.push("graph"); return [retrieval("c", "graph")] },
    pageIndexSearch: async () => { calls.push("pageIndex"); return [retrieval("d", "pageIndex")] },
  }))

  const outcome = await searcher.search({ text: "query" })

  assert.equal(outcome.status, "ok")
  assert.deepEqual(calls.sort(), ["bm25", "graph", "pageIndex", "vector"],
    "all four channels should execute when channels option is omitted (backward compat)")
  assert.equal(outcome.unselectedChannels, undefined,
    "unselectedChannels must be undefined when all four channels are executed")
})

test("Ticket 06 P2: single-channel subset (vector only) executes only vectorSearch and reports unselectedChannels", async () => {
  const calls: string[] = []
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => { calls.push("vector"); return [retrieval("a", "vector")] },
    bm25Search: async () => { calls.push("bm25"); return [] },
    graphSearch: async () => { calls.push("graph"); return [] },
    pageIndexSearch: async () => { calls.push("pageIndex"); return [] },
  }))

  const outcome = await searcher.search({ text: "query" }, { channels: ["vector"] })

  assert.equal(outcome.status, "ok")
  assert.deepEqual(calls, ["vector"],
    "only the vector channel should be called when channels: ['vector']")
  assert.deepEqual(outcome.unselectedChannels, ["bm25", "graph", "pageIndex"],
    "unselectedChannels should list all channels not in the caller's selection")
  assert.deepEqual(outcome.unavailableChannels, [])
  assert.equal(outcome.results.length, 1)
  assert.equal(outcome.results[0].chunk.id, "a")
})

test("Ticket 06 P2: multi-channel subset (vector + bm25) executes only requested channels", async () => {
  const calls: string[] = []
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => { calls.push("vector"); return [retrieval("a", "vector")] },
    bm25Search: async () => { calls.push("bm25"); return [retrieval("b", "bm25")] },
    graphSearch: async () => { calls.push("graph"); return [] },
    pageIndexSearch: async () => { calls.push("pageIndex"); return [] },
  }))

  const outcome = await searcher.search({ text: "query" }, { channels: ["vector", "bm25"] })

  assert.equal(outcome.status, "ok")
  assert.deepEqual(calls.sort(), ["bm25", "vector"],
    "only the requested channels should be called")
  assert.deepEqual(outcome.unselectedChannels, ["graph", "pageIndex"],
    "unselectedChannels should list channels not in the caller's selection")
  assert.deepEqual(outcome.unavailableChannels, [])
  assert.equal(outcome.results.length, 2)
  assert.deepEqual(
    outcome.results.map(({ chunk }) => chunk.id).sort(),
    ["a", "b"]
  )
})

test("Ticket 06 P2: degraded outcome with channel selection reports partial failure among selected channels only", async () => {
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [retrieval("a", "vector")],
    bm25Search: async () => { throw new Error("bm25 unavailable") },
  }))

  const outcome = await searcher.search({ text: "query" }, { channels: ["vector", "bm25"] })

  assert.equal(outcome.status, "degraded")
  assert.deepEqual(outcome.unavailableChannels, ["bm25"],
    "unavailableChannels should list only the selected channel that failed")
  assert.deepEqual(outcome.unselectedChannels, ["graph", "pageIndex"],
    "unselectedChannels should still list the channels not in the caller's selection")
  assert.equal(outcome.results.length, 1)
  assert.equal(outcome.results[0].chunk.id, "a")
})

test("Ticket 06 P2: insufficient outcome with channel selection reports all selected channels unavailable", async () => {
  let rerankCalled = false
  const unavailable = async (): Promise<RetrievalResult[]> => {
    throw new Error("unavailable")
  }
  const searcher = new SearcherImpl(operations({
    vectorSearch: unavailable,
    bm25Search: unavailable,
    graphSearch: unavailable,
    pageIndexSearch: unavailable,
    rerank: async () => { rerankCalled = true; return [] },
  }))

  const outcome = await searcher.search({ text: "query" }, { channels: ["vector", "bm25"] })

  assert.deepEqual(outcome, {
    status: "insufficient",
    results: [],
    unavailableChannels: ["vector", "bm25"],
    unselectedChannels: ["graph", "pageIndex"],
  })
  assert.equal(rerankCalled, false,
    "rerank must not be called when all selected channels fail")
})

test("Ticket 06 P2: ACL propagation with channel selection — accessContext passed to selected channels only", async () => {
  const calls: Array<{ channel: string; accessContext?: AccessContext }> = []
  const searcher = new SearcherImpl(operations({
    vectorSearch: async (_q, _k, _h, ac) => {
      calls.push({ channel: "vector", accessContext: ac })
      return [retrieval("a", "vector")]
    },
    bm25Search: async (_q, _k, ac) => {
      calls.push({ channel: "bm25", accessContext: ac })
      return []
    },
    graphSearch: async (_q, _k, _s, ac) => {
      calls.push({ channel: "graph", accessContext: ac })
      return [retrieval("c", "graph")]
    },
    pageIndexSearch: async (_q, _k, ac) => {
      calls.push({ channel: "pageIndex", accessContext: ac })
      return []
    },
  }))
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["team-x"],
    scopes: ["chat"],
  }

  const outcome = await searcher.search(
    { text: "query" },
    { channels: ["vector", "graph"], accessContext: ac }
  )

  assert.equal(calls.length, 2,
    "only the 2 selected channels should be called")
  assert.deepEqual(
    calls.map((c) => c.channel).sort(),
    ["graph", "vector"],
    "only vector and graph channels should be called"
  )
  for (const call of calls) {
    assert.equal(
      call.accessContext,
      ac,
      `${call.channel} channel should receive the same accessContext reference`
    )
  }
  assert.deepEqual(outcome.unselectedChannels, ["bm25", "pageIndex"],
    "unselectedChannels should list channels not in the caller's selection")
  assert.deepEqual(outcome.unavailableChannels, [])
})

test("Ticket 06 P2: graphBudget omitted when graph channel not selected, present when selected", async () => {
  // Part 1: graph NOT selected → graphBudget must be undefined
  const searcherWithoutGraph = new SearcherImpl(operations({
    vectorSearch: async () => [retrieval("a", "vector")],
    bm25Search: async () => [retrieval("b", "bm25")],
  }))

  const outcomeWithoutGraph = await searcherWithoutGraph.search(
    { text: "query" },
    { channels: ["vector", "bm25"], graphSeeds: ["seed-1", "seed-2"] }
  )

  assert.equal(outcomeWithoutGraph.status, "ok")
  assert.equal(outcomeWithoutGraph.graphBudget, undefined,
    "graphBudget must be undefined when graph channel is not in the selection")
  assert.deepEqual(outcomeWithoutGraph.unselectedChannels, ["graph", "pageIndex"])

  // Part 2: graph IS selected → graphBudget must be present with expected shape
  const searcherWithGraph = new SearcherImpl(operations({
    vectorSearch: async () => [retrieval("a", "vector")],
    graphSearch: async () => [retrieval("c", "graph")],
  }))

  const outcomeWithGraph = await searcherWithGraph.search(
    { text: "query" },
    { channels: ["vector", "graph"], graphSeeds: ["seed-1", "seed-2"] }
  )

  assert.equal(outcomeWithGraph.status, "ok")
  assert.deepEqual(outcomeWithGraph.graphBudget, {
    seeds: ["seed-1", "seed-2"],
    hops: 1,
    candidates: 20,
  })
  assert.deepEqual(outcomeWithGraph.unselectedChannels, ["bm25", "pageIndex"])
})

test("P7.2 regression: mid-rerank cancellation terminates the run instead of degrading to reranker_unavailable", async () => {
  const controller = new AbortController()
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [
      retrieval("a", "vector"),
      retrieval("b", "vector"),
      retrieval("c", "vector"),
    ],
    rerank: async () => {
      // Signal aborts WHILE rerank is in flight; the reranker surfaces the
      // abort as an AbortError. Before the fix, the catch swallowed this and
      // the run continued with degraded (unranked) results.
      controller.abort()
      const err = new Error("rerank aborted")
      err.name = "AbortError"
      throw err
    },
  }))

  await assert.rejects(
    searcher.search({ text: "query" }, { signal: controller.signal }),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
    "a cancellation firing mid-rerank must reject the search with AbortError"
  )
})

test("P7.2 regression: mid-parent-load cancellation terminates the run instead of degrading to parent_expansion_unavailable", async () => {
  const controller = new AbortController()
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [
      retrieval("a", "vector"),
      retrieval("b", "vector"),
    ],
    loadParents: async () => {
      controller.abort()
      const err = new Error("parent load aborted")
      err.name = "AbortError"
      throw err
    },
  }))

  await assert.rejects(
    searcher.search({ text: "query" }, { signal: controller.signal }),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
    "a cancellation firing mid-parent-load must reject the search with AbortError"
  )
})

test("P7.2 regression: hung Neo4j session.run rejects promptly on abort and closes the session", async () => {
  let sessionClosed = false
  const graphDriver = {
    session() {
      return {
        // Never settles — simulates a hung Cypher query with no native
        // signal support. Before the fix, this held the retrieval stage
        // open until the driver's own default timeout.
        run: () => new Promise(() => {}),
        async close() {
          sessionClosed = true
        },
      }
    },
  }
  const runtime = new RuntimeSearchOperations({
    es: {} as Client,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })

  const controller = new AbortController()
  setTimeout(() => controller.abort(), 20)
  const started = Date.now()

  await assert.rejects(
    runtime.graphSearch(
      { text: "refund policy" },
      5,
      undefined,
      undefined,
      undefined,
      controller.signal
    ),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
    "a hung graph query must reject with AbortError when the run is cancelled"
  )

  assert.ok(Date.now() - started < 2_000,
    "graphSearch must reject promptly after abort, not hang until driver default timeout")
  assert.ok(sessionClosed, "session.close() must still run (finally block) after abort")
})

/**
 * Ticket 05 (KB-03A) — vector and BM25 retrieval run inside a server-computed
 * knowledge scope.
 *
 * Acceptance criteria exercised here:
 *   1. Two knowledge bases holding contradictory documents never cross on
 *      either channel.
 *   2. A missing scope resolves to the authorized default, an explicit empty
 *      scope is "no knowledge context", an invalid scope fails loudly.
 *   3. The client cannot widen its scope with raw storage filters.
 *   4. Simple retrieval keeps using the existing Searcher.
 */

/** Finds the `knowledgeBaseId` terms clause anywhere in a request body. */
function scopedKnowledgeBaseIds(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = scopedKnowledgeBaseIds(item)
      if (found) return found
    }
    return undefined
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    const terms = record.terms as Record<string, unknown> | undefined
    if (terms && Array.isArray(terms.knowledgeBaseId)) {
      return terms.knowledgeBaseId as string[]
    }
    for (const nested of Object.values(record)) {
      const found = scopedKnowledgeBaseIds(nested)
      if (found) return found
    }
  }
  return undefined
}

/**
 * Elasticsearch stand-in that actually honours the emitted knowledge-base
 * clause, so a scoped query can only ever see its own knowledge base.
 */
function scopedEs(chunks: Array<{ id: string; knowledgeBaseId: string }>) {
  const requests: Array<Record<string, unknown>> = []
  const es = {
    async search(request: Record<string, unknown>) {
      requests.push(request)
      const ids =
        scopedKnowledgeBaseIds(request.knn) ?? scopedKnowledgeBaseIds(request.query)
      const visible = ids
        ? chunks.filter((chunk) => ids.includes(chunk.knowledgeBaseId))
        : chunks
      return {
        hits: {
          hits: visible.map((chunk) => ({
            _source: {
              id: chunk.id,
              documentId: `doc-${chunk.knowledgeBaseId}`,
              content: chunk.id,
              childrenIds: [],
              metadata: {
                source: "test",
                knowledgeBaseId: chunk.knowledgeBaseId,
              },
            },
            _score: 1,
          })),
        },
      }
    },
  } as unknown as Client
  return { requests, es }
}

test("Ticket 05: vectorSearch scopes to the knowledge-base ids", async () => {
  const { requests, es } = mockEs()
  const runtime = makeRuntime(es, mockEmbedding())

  await runtime.vectorSearch({ text: "query" }, 5, undefined, undefined, {
    knowledgeBaseIds: ["kb-a", "kb-b"],
  })

  assert.deepEqual(scopedKnowledgeBaseIds(requests[0].knn), ["kb-a", "kb-b"])
})

test("Ticket 05: bm25Search scopes to the knowledge-base ids", async () => {
  const { requests, es } = mockEs()
  const runtime = makeRuntime(es, mockEmbedding())

  await runtime.bm25Search({ text: "query" }, 5, undefined, {
    knowledgeBaseIds: ["kb-a"],
  })

  assert.deepEqual(scopedKnowledgeBaseIds(requests[0].query), ["kb-a"])
})

test("Ticket 05: an unscoped channel emits no knowledge-base clause (backward compat)", async () => {
  const { requests, es } = mockEs()
  const runtime = makeRuntime(es, mockEmbedding())

  await runtime.vectorSearch({ text: "query" }, 5)
  await runtime.bm25Search({ text: "query" }, 5)

  assert.equal(scopedKnowledgeBaseIds(requests[0].knn), undefined)
  assert.equal(scopedKnowledgeBaseIds(requests[1].query), undefined)
})

test("Ticket 05: an explicit empty scope returns no evidence without any query or embedding", async () => {
  const { requests, es } = mockEs()
  let embeddingCalls = 0
  const embeddingClient = {
    embeddings: {
      create: async () => {
        embeddingCalls += 1
        return { data: [{ embedding: [0.1] }] }
      },
    },
  } as unknown as OpenAI
  const runtime = makeRuntime(es, embeddingClient)

  const empty = { knowledgeBaseIds: [] }
  assert.deepEqual(await runtime.vectorSearch({ text: "query" }, 5, undefined, undefined, empty), [])
  assert.deepEqual(await runtime.bm25Search({ text: "query" }, 5, undefined, empty), [])

  assert.equal(requests.length, 0, "an empty scope must not reach Elasticsearch")
  assert.equal(embeddingCalls, 0, "an empty scope must not spend an embedding call")

  // The same guarantee holds through the Searcher entry point.
  const searcher = new SearcherImpl(runtime)
  const outcome = await searcher.search(
    { text: "query" },
    { retrievalScope: empty, channels: ["vector", "bm25"] }
  )
  assert.deepEqual(outcome.results, [])
  assert.equal(requests.length, 0)
  assert.equal(embeddingCalls, 0)
})

test("Ticket 05: an empty scope dispatches no channel at all, all four requested", async () => {
  const dispatched: string[] = []
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => { dispatched.push("vector"); return [] },
    bm25Search: async () => { dispatched.push("bm25"); return [] },
    graphSearch: async () => { dispatched.push("graph"); return [] },
    pageIndexSearch: async () => { dispatched.push("pageIndex"); return [] },
  }))

  const outcome = await searcher.search(
    { text: "query" },
    { retrievalScope: { knowledgeBaseIds: [] } }
  )

  assert.deepEqual(
    dispatched,
    [],
    "no channel may be dispatched on an explicit empty scope — graph and PageIndex only gain their own filter in Ticket 06"
  )
  assert.equal(outcome.status, "insufficient")
  assert.deepEqual(outcome.results, [])
  assert.deepEqual(
    outcome.unavailableChannels,
    [],
    "no channel failed — none was asked to run"
  )
})

test("Ticket 05: SearcherImpl.search forwards the retrieval scope to both channels", async () => {
  const seen: Array<{ channel: string; scope: unknown }> = []
  const searcher = new SearcherImpl(operations({
    vectorSearch: async (_query, _topK, _hypothesis, _accessContext, scope) => {
      seen.push({ channel: "vector", scope })
      return []
    },
    bm25Search: async (_query, _topK, _accessContext, scope) => {
      seen.push({ channel: "bm25", scope })
      return []
    },
  }))

  await searcher.search(
    { text: "query" },
    { retrievalScope: { knowledgeBaseIds: ["kb-a"] }, channels: ["vector", "bm25"] }
  )

  assert.deepEqual(seen, [
    { channel: "vector", scope: { knowledgeBaseIds: ["kb-a"] } },
    { channel: "bm25", scope: { knowledgeBaseIds: ["kb-a"] } },
  ])
})

test("Ticket 05: contradictory documents in two knowledge bases never cross", async () => {
  const { es } = scopedEs([
    { id: "kb-a-refund", knowledgeBaseId: "kb-a" },
    { id: "kb-b-refund", knowledgeBaseId: "kb-b" },
  ])
  const searcher = new SearcherImpl(makeRuntime(es, mockEmbedding()))

  const scopedToA = await searcher.search(
    { text: "退款期限" },
    { retrievalScope: { knowledgeBaseIds: ["kb-a"] }, channels: ["vector", "bm25"] }
  )
  const scopedToB = await searcher.search(
    { text: "退款期限" },
    { retrievalScope: { knowledgeBaseIds: ["kb-b"] }, channels: ["vector", "bm25"] }
  )

  assert.deepEqual(
    [...new Set(scopedToA.results.map(({ chunk }) => chunk.id))],
    ["kb-a-refund"]
  )
  assert.deepEqual(
    [...new Set(scopedToB.results.map(({ chunk }) => chunk.id))],
    ["kb-b-refund"]
  )

  // A caller that supplies no scope at all still reads the whole index: the
  // scope is what narrows a request, never what widens it.
  const unscoped = await searcher.search(
    { text: "退款期限" },
    { channels: ["vector", "bm25"] }
  )
  assert.deepEqual(
    [...new Set(unscoped.results.map(({ chunk }) => chunk.id))].sort(),
    ["kb-a-refund", "kb-b-refund"]
  )
})

/**
 * Ticket 06 (KB-03B) — graph and PageIndex retrieval honor the same
 * server-computed knowledge scope as vector/BM25.
 *
 * Acceptance criteria exercised here:
 *   1. Graph and PageIndex results contain only evidence owned by an
 *      authorized selected knowledge base.
 *   2. A shared entity cannot reveal another knowledge base's relations or
 *      supporting documents.
 *   3. Graph candidate hydration preserves scope when resolving evidence
 *      back to chunks.
 *   4. Existing retrieval ordering and fusion behavior remain unchanged
 *      apart from filtering (existing fusion tests stay green untouched).
 */

/** 6-element provenance writer format (see store.ts): doc, chunk, tenant, groups, weight, kb. */
function kbProvenance(
  documentId: string,
  chunkId: string,
  knowledgeBaseId: string,
  tenantId = "tenant-a"
): string {
  return JSON.stringify([documentId, chunkId, tenantId, [], 0.8, knowledgeBaseId])
}

test("Ticket 06: a shared entity does not reveal another knowledge base's relations or documents", async () => {
  // Two relations hang off the same entity match. One is supported by a
  // chunk owned by kb-a, the other ONLY by a chunk owned by kb-b.
  const graphDriver = makeGraphDriver([
    {
      values: ["refund->customer:APPLIES_TO"],
      weight: 0.8,
      provenance: [kbProvenance("doc-kb-a", "chunk-a", "kb-a")],
    },
    {
      values: ["refund->competitor:MENTIONS"],
      weight: 0.7,
      provenance: [kbProvenance("doc-kb-b", "chunk-b", "kb-b")],
    },
  ])
  const { requests, es } = scopedEs([
    { id: "chunk-a", knowledgeBaseId: "kb-a" },
    { id: "chunk-b", knowledgeBaseId: "kb-b" },
  ])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })

  const scoped = await runtime.graphSearch(
    { text: "refund" },
    5,
    undefined,
    undefined,
    { knowledgeBaseIds: ["kb-a"] }
  )

  const hydrated = JSON.stringify(requests)
  assert.ok(
    hydrated.includes("chunk-a"),
    "the in-scope provenance chunk must be hydrated"
  )
  assert.ok(
    !hydrated.includes("chunk-b") && !hydrated.includes("doc-kb-b"),
    `another knowledge base's supporting document must never be named: ${hydrated}`
  )
  assert.equal(scoped.length, 1, "exactly the in-scope chunk returns as evidence")
  assert.deepEqual(
    scoped.flatMap(({ wikilinks }) => wikilinks.map(({ relation }) => relation)),
    ["APPLIES_TO"],
    "the relation supported only by another knowledge base must not surface"
  )
})

test("Ticket 06: graphSearch scoped recheck carries the knowledge-base clause and drops unowned provenance", async () => {
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [
      kbProvenance("doc-in-scope", "chunk-in", "kb-a"),
      kbProvenance("doc-cross-kb", "chunk-cross", "kb-b"),
      // Legacy 4-element provenance has no knowledge-base tag: under a scope
      // it cannot be authorized, so it is dropped before the recheck.
      JSON.stringify(["doc-legacy", "chunk-legacy", "tenant-a", []]),
    ],
  }])
  const { requests, es } = mockEs()
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })

  await runtime.graphSearch({ text: "refund" }, 5, undefined, undefined, {
    knowledgeBaseIds: ["kb-a"],
  })

  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"documentId":"doc-in-scope"'),
    `in-scope provenance must be hydrated: ${queryStr}`
  )
  assert.ok(
    !queryStr.includes('"documentId":"doc-cross-kb"'),
    `cross-KB provenance must be dropped before the recheck: ${queryStr}`
  )
  assert.ok(
    !queryStr.includes('"documentId":"doc-legacy"'),
    `legacy untagged provenance must be dropped under an explicit scope: ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"terms":{"knowledgeBaseId":["kb-a"]}'),
    `the hydration query must carry the scope as defense in depth: ${queryStr}`
  )
})

test("Ticket 06: graphSearch name-fallback hydration carries the knowledge-base clause", async () => {
  // Entity names but no relation provenance → the multi_match fallback path.
  const graphDriver = makeGraphDriver([])
  const { requests, es } = mockEs()
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })

  await runtime.graphSearch({ text: "refund" }, 5, undefined, undefined, {
    knowledgeBaseIds: ["kb-a"],
  })

  const filter = (requests[0].query as { bool: { filter: unknown[] } }).bool.filter
  assert.deepEqual(
    filter.find((clause) => JSON.stringify(clause).includes("knowledgeBaseId")),
    { terms: { knowledgeBaseId: ["kb-a"] } },
    "the fallback path must filter candidate chunks by the same scope"
  )
})

test("Ticket 06: graphSearch without a scope keeps reading every knowledge base (backward compat)", async () => {
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [
      kbProvenance("doc-a", "chunk-a", "kb-a"),
      kbProvenance("doc-b", "chunk-b", "kb-b"),
    ],
  }])
  const { requests, es } = mockEs()
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })

  await runtime.graphSearch({ text: "refund" }, 5)

  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(queryStr.includes('"documentId":"doc-a"'))
  assert.ok(queryStr.includes('"documentId":"doc-b"'))
  assert.ok(
    !queryStr.includes("knowledgeBaseId"),
    "an unscoped legacy caller must emit no knowledge-base clause"
  )
})

test("Ticket 06: a re-ingested chunk's tagged provenance outranks its legacy entry", async () => {
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [
      // The same chunk appended by a pre-KB-02A writer and by the current
      // writer (store.ts MERGE dedups by the JSON string only).
      JSON.stringify(["doc-a", "chunk-a", "tenant-a", []]),
      kbProvenance("doc-a", "chunk-a", "kb-a"),
    ],
  }])
  const { requests, es } = mockEs()
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })

  await runtime.graphSearch({ text: "refund" }, 5, undefined, undefined, {
    knowledgeBaseIds: ["kb-a"],
  })

  assert.ok(
    JSON.stringify(requests[0].query).includes('"documentId":"doc-a"'),
    "the tagged entry must win the dedup so the in-scope chunk stays selectable"
  )
})

test("Ticket 06: graphSearch with an explicit empty scope queries nothing", async () => {
  let neo4jTouched = false
  const graphDriver = {
    session() {
      neo4jTouched = true
      throw new Error("graph must not be queried on an empty scope")
    },
  }
  const { requests, es } = mockEs()
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })

  const results = await runtime.graphSearch(
    { text: "refund" },
    5,
    undefined,
    undefined,
    { knowledgeBaseIds: [] }
  )

  assert.deepEqual(results, [])
  assert.equal(neo4jTouched, false, "no Neo4j session may be opened")
  assert.equal(requests.length, 0, "no Elasticsearch query may be issued")
})

test("Ticket 06: pageIndexSearch filters nodes by knowledge base and carries the clause into hydration", async () => {
  const pageIndexRepo = makePageIndexRepo([
    { documentId: "doc-in", linkedChunkIds: ["chunk-in"], knowledgeBaseId: "kb-a" },
    { documentId: "doc-out", linkedChunkIds: ["chunk-out"], knowledgeBaseId: "kb-b" },
    // A legacy node without a knowledge-base tag is not selectable under an
    // explicit scope (the writer tags every node since KB-02A).
    { documentId: "doc-legacy", linkedChunkIds: ["chunk-legacy"] },
  ])
  const { requests, es } = mockEs()
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: mockEmbedding(),
    chatModel: "chat",
    embeddingModel: "embedding",
    pageIndexRepo,
  })

  await runtime.pageIndexSearch({ text: "query" }, 5, undefined, {
    knowledgeBaseIds: ["kb-a"],
  })

  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"documentId":"doc-in"'),
    `in-scope node must be looked up: ${queryStr}`
  )
  assert.ok(
    !queryStr.includes('"documentId":"doc-out"'),
    `another knowledge base's node must be excluded: ${queryStr}`
  )
  assert.ok(
    !queryStr.includes('"documentId":"doc-legacy"'),
    `an untagged node must be excluded under an explicit scope: ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"terms":{"knowledgeBaseId":["kb-a"]}'),
    `the chunk hydration must re-check the scope: ${queryStr}`
  )
})

test("Ticket 06: pageIndexSearch without a scope keeps reading every knowledge base (backward compat)", async () => {
  const pageIndexRepo = makePageIndexRepo([
    { documentId: "doc-a", linkedChunkIds: ["chunk-a"], knowledgeBaseId: "kb-a" },
    { documentId: "doc-b", linkedChunkIds: ["chunk-b"], knowledgeBaseId: "kb-b" },
  ])
  const { requests, es } = mockEs()
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: mockEmbedding(),
    chatModel: "chat",
    embeddingModel: "embedding",
    pageIndexRepo,
  })

  await runtime.pageIndexSearch({ text: "query" }, 5)

  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(queryStr.includes('"documentId":"doc-a"'))
  assert.ok(queryStr.includes('"documentId":"doc-b"'))
  assert.ok(!queryStr.includes("knowledgeBaseId"))
})

test("Ticket 06: pageIndexSearch with an explicit empty scope queries nothing", async () => {
  const { requests, es } = mockEs()
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: mockEmbedding(),
    chatModel: "chat",
    embeddingModel: "embedding",
    pageIndexRepo: makePageIndexRepo([
      { documentId: "doc-a", linkedChunkIds: ["chunk-a"], knowledgeBaseId: "kb-a" },
    ]),
  })

  const results = await runtime.pageIndexSearch(
    { text: "query" },
    5,
    undefined,
    { knowledgeBaseIds: [] }
  )

  assert.deepEqual(results, [])
  assert.equal(requests.length, 0)
})

test("Ticket 06: SearcherImpl.search forwards the retrieval scope to graph and PageIndex channels", async () => {
  const seen: Array<{ channel: string; scope: unknown }> = []
  const searcher = new SearcherImpl(operations({
    graphSearch: async (_query, _topK, _seeds, _ac, scope) => {
      seen.push({ channel: "graph", scope })
      return []
    },
    pageIndexSearch: async (_query, _topK, _ac, scope) => {
      seen.push({ channel: "pageIndex", scope })
      return []
    },
  }))

  await searcher.search(
    { text: "query" },
    { retrievalScope: { knowledgeBaseIds: ["kb-a"] }, channels: ["graph", "pageIndex"] }
  )

  assert.deepEqual(seen, [
    { channel: "graph", scope: { knowledgeBaseIds: ["kb-a"] } },
    { channel: "pageIndex", scope: { knowledgeBaseIds: ["kb-a"] } },
  ])
})

/**
 * Ticket 07 (KB-03C) — parent expansion, corrective retrieval, citation
 * reads and cache identities preserve the run's RetrievalScope so no
 * secondary path can reintroduce content filtered from primary retrieval.
 */

test("Ticket 07: loadParents carries the knowledge-base clause when a scope is provided", async () => {
  const { requests, es } = mockEs()
  const runtime = makeRuntime(es, mockEmbedding())

  await runtime.loadParents(
    [{ documentId: "doc-1", id: "parent-1" }],
    undefined,
    { knowledgeBaseIds: ["kb-a"] }
  )

  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"terms":{"knowledgeBaseId":["kb-a"]}'),
    `parent hydration must re-check the knowledge scope: ${queryStr}`
  )
})

test("Ticket 07: loadParents never hydrates a parent outside the scope", async () => {
  // Defense in depth: even if a stale identity slips into the expansion set
  // (documentId collision, corrupted parent pointer), the ES query can only
  // return parents the scope still owns.
  const { es } = scopedEs([
    { id: "parent-in", knowledgeBaseId: "kb-a" },
    { id: "parent-out", knowledgeBaseId: "kb-b" },
  ])
  const runtime = makeRuntime(es, mockEmbedding())

  const parents = await runtime.loadParents(
    [
      { documentId: "doc-kb-a", id: "parent-in" },
      { documentId: "doc-kb-b", id: "parent-out" },
    ],
    undefined,
    { knowledgeBaseIds: ["kb-a"] }
  )

  assert.deepEqual(
    parents.map(({ id }) => id),
    ["parent-in"],
    "a parent owned by another knowledge base must not be hydrated"
  )
})

test("Ticket 07: loadParents without a scope keeps the legacy query shape", async () => {
  const { requests, es } = mockEs()
  const runtime = makeRuntime(es, mockEmbedding())

  await runtime.loadParents([{ documentId: "doc-1", id: "parent-1" }])

  assert.ok(
    !JSON.stringify(requests[0]).includes("knowledgeBaseId"),
    "an unscoped legacy caller must emit no knowledge-base clause"
  )
})

test("Ticket 07: loadParents with an explicit empty scope returns nothing without a query", async () => {
  const { requests, es } = mockEs()
  const runtime = makeRuntime(es, mockEmbedding())

  const parents = await runtime.loadParents(
    [{ documentId: "doc-1", id: "parent-1" }],
    undefined,
    { knowledgeBaseIds: [] }
  )

  assert.deepEqual(parents, [])
  assert.equal(requests.length, 0, "an empty scope must not reach Elasticsearch")
})

test("Ticket 07: SearcherImpl forwards the run's scope object identity into parent expansion", async () => {
  const retrievalScope = { knowledgeBaseIds: ["kb-a"] } as const
  const seen: unknown[] = []
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [{
      chunk: {
        id: "child-1",
        documentId: "doc-1",
        content: "child",
        childrenIds: [],
        parentId: "parent-1",
        metadata: {},
      },
      score: 1,
      source: "vector" as const,
      wikilinks: [],
    }],
    loadParents: async (_identities, _ac, scope) => {
      seen.push(scope)
      return []
    },
  }))

  await searcher.search(
    { text: "query" },
    { retrievalScope, channels: ["vector"] }
  )

  assert.equal(
    seen[0],
    retrievalScope,
    "parent expansion must reuse the same locked scope object, never a recomputed copy"
  )
})

/**
 * Ticket PT-10 (audit finding F1) — PageIndex eligibility is resolved BEFORE the
 * bounded selection.
 *
 * `.scratch/pipeline-structure-audit-2026-10-08/reproduce.cjs` case
 * `F1_pageindex_scope_after_limit` asserted the DEFECT as its evidence: one
 * eligible target hit, then five higher-sorted foreign nodes, then zero hits.
 * The fixtures below keep exactly that shape (five foreign documents sorting
 * ahead of `z-target`) and pin the corrected behavior: the target keeps its hit
 * while the ceiling (5), the stable order, the linked-chunk dedup and the topK
 * slice stay exactly as they were.
 */

const PT10_TENANT = "tenant-pt10"
const PT10_QUERY_TEXT = "退款规则"
const PT10_NODE_LIMIT = 5

interface Pt10NodeFixture {
  documentId: string
  nodeId: string
  linkedChunkIds: string[]
  tenantId?: string
  allowedGroups?: string[]
  knowledgeBaseId?: string
}

function pt10Node(input: {
  documentId: string
  nodeId?: string
  chunk?: string
  tenantId?: string
  allowedGroups?: string[]
  knowledgeBaseId?: string
}): Pt10NodeFixture {
  return {
    documentId: input.documentId,
    nodeId: input.nodeId ?? "node-1",
    linkedChunkIds: [input.chunk ?? `chunk-${input.documentId}`],
    ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
    ...(input.allowedGroups !== undefined ? { allowedGroups: input.allowedGroups } : {}),
    ...(input.knowledgeBaseId !== undefined ? { knowledgeBaseId: input.knowledgeBaseId } : {}),
  }
}

/** The audit fixture's five documents — every one sorts ahead of `z-target`. */
function pt10Foreign<T>(make: (documentId: string) => T): T[] {
  return [0, 1, 2, 3, 4].map((index) => make(`a-foreign-${index}`))
}

const pt10Target = (): Pt10NodeFixture =>
  pt10Node({ documentId: "z-target", tenantId: PT10_TENANT, knowledgeBaseId: "kb-a" })

/**
 * A PageIndex repository that honors the PT-10 contract the way SQLite does:
 * every eligibility axis is applied first, `ORDER BY document_id, node_id`
 * decides the sequence, and only then does `LIMIT` cut. The recorded calls make
 * the ceiling and the axes observable.
 */
function makeEligiblePageIndexRepo(
  nodes: Pt10NodeFixture[],
  options: { activeDocIds?: readonly string[] } = {}
) {
  const calls: Array<{
    query: string
    limit: number
    eligibility?: PageIndexNodeEligibility
  }> = []
  const repo = {
    searchNodes: (query: string, limit: number, eligibility?: PageIndexNodeEligibility) => {
      calls.push({ query, limit, eligibility })
      const order = (node: Pt10NodeFixture) => `${node.documentId}\0${node.nodeId}`
      let selected = [...nodes].sort((left, right) =>
        order(left) < order(right) ? -1 : order(left) > order(right) ? 1 : 0
      )
      if (eligibility?.tenantId !== undefined) {
        selected = selected.filter((node) => node.tenantId === eligibility.tenantId)
      }
      const callerGroups = eligibility?.callerGroups ?? []
      if (callerGroups.length > 0) {
        selected = selected.filter((node) => {
          const nodeGroups = node.allowedGroups ?? []
          return (
            nodeGroups.length === 0 ||
            nodeGroups.some((group) => callerGroups.includes(group))
          )
        })
      }
      if (eligibility?.knowledgeBaseIds !== undefined) {
        const allowed = new Set(eligibility.knowledgeBaseIds)
        selected = selected.filter(
          (node) => node.knowledgeBaseId !== undefined && allowed.has(node.knowledgeBaseId)
        )
      }
      if (eligibility?.restrictToActiveDocumentVersions) {
        const active = new Set(options.activeDocIds ?? [])
        selected = selected.filter((node) => active.has(node.documentId))
      }
      return selected.slice(0, limit)
    },
  } as unknown as PageIndexRepository
  return { repo, calls }
}

function pt10TermValue(clauses: Array<Record<string, unknown>>, field: string): unknown {
  for (const clause of clauses) {
    const term = clause.term as Record<string, unknown> | undefined
    if (term && field in term) return term[field]
  }
  return undefined
}

function pt10MatchesClause(doc: Record<string, unknown>, clause: unknown): boolean {
  if (!clause || typeof clause !== "object") {
    throw new Error("PT-10 fake: missing or malformed ES clause")
  }
  const node = clause as Record<string, unknown>
  if ("term" in node) {
    const [field, value] = Object.entries(node.term as Record<string, unknown>)[0]
    return doc[field] === value
  }
  if ("terms" in node) {
    const [field, values] = Object.entries(node.terms as Record<string, unknown>)[0] as [
      string,
      unknown[],
    ]
    const actual = doc[field]
    if (Array.isArray(actual)) return values.some((value) => actual.includes(value))
    return values.includes(actual)
  }
  if ("exists" in node) {
    const field = (node.exists as { field: string }).field
    return doc[field] !== undefined && doc[field] !== null
  }
  if ("bool" in node) {
    const bool = node.bool as {
      must?: unknown[]
      should?: unknown[]
      filter?: unknown[]
      must_not?: unknown[]
      minimum_should_match?: number
    }
    if (bool.must && !bool.must.every((inner) => pt10MatchesClause(doc, inner))) return false
    if (bool.filter && !bool.filter.every((inner) => pt10MatchesClause(doc, inner))) return false
    if (bool.must_not && bool.must_not.some((inner) => pt10MatchesClause(doc, inner))) return false
    if (bool.should) {
      const needed = bool.minimum_should_match ?? (bool.must || bool.filter ? 0 : 1)
      if (needed === 0) return true
      return bool.should.filter((inner) => pt10MatchesClause(doc, inner)).length >= needed
    }
    return true
  }
  throw new Error(
    `PT-10 fake: unsupported ES clause ${JSON.stringify(node).slice(0, 160)}`
  )
}

interface Pt10HydrationChunk {
  documentId: string
  id: string
  tenantId?: string
  knowledgeBaseId?: string
}

/**
 * A chunk index that answers the identity lookup only for passages that exist
 * AND still satisfy the emitted filter clauses — so the hydration re-check is
 * executed by the fake instead of being asserted away.
 */
function hydrationEs(chunks: Pt10HydrationChunk[]) {
  const requests: Array<{ request: Record<string, unknown>; options?: Record<string, unknown> }> = []
  const byIdentity = new Map(chunks.map((chunk) => [`${chunk.documentId}\0${chunk.id}`, chunk]))
  const es = {
    async search(request: Record<string, unknown>, options?: Record<string, unknown>) {
      requests.push({ request, options })
      const signal = options?.signal as AbortSignal | undefined
      if (signal?.aborted) {
        // The real client rejects an aborted request; the fake must too, so
        // cancellation propagation is behavior, not a source-code claim.
        const error = new Error("PT-10 fake: request aborted")
        error.name = "AbortError"
        throw error
      }
      const bool = (request.query as { bool?: { should?: unknown[]; filter?: unknown[] } }).bool
      const filters = bool?.filter ?? []
      const size = typeof request.size === "number" ? request.size : 10
      const hits: Array<{ _source: Record<string, unknown>; _score: number }> = []
      for (const clause of bool?.should ?? []) {
        const must =
          (clause as { bool?: { must?: Array<Record<string, unknown>> } }).bool?.must ?? []
        const documentId = pt10TermValue(must, "documentId")
        const id = pt10TermValue(must, "id")
        if (typeof documentId !== "string" || typeof id !== "string") {
          throw new Error("PT-10 fake: hydration clause lost its chunk identity")
        }
        const chunk = byIdentity.get(`${documentId}\0${id}`)
        if (!chunk) continue
        const doc: Record<string, unknown> = {
          id: chunk.id,
          documentId: chunk.documentId,
          kind: "child",
          content: `content-${chunk.id}`,
          childrenIds: [],
          metadata: { kind: "child", source: `pt10-${chunk.documentId}` },
          ...(chunk.tenantId !== undefined ? { tenantId: chunk.tenantId } : {}),
          ...(chunk.knowledgeBaseId !== undefined ? { knowledgeBaseId: chunk.knowledgeBaseId } : {}),
        }
        if (!filters.every((filter) => pt10MatchesClause(doc, filter))) continue
        hits.push({ _source: doc, _score: 1 })
        if (hits.length >= size) break
      }
      return { hits: { hits } }
    },
  } as unknown as Client
  return { requests, es }
}

function makePt10Runtime(
  es: Client,
  pageIndexRepo: PageIndexRepository,
  activeVersionRepo?: ActiveVersionRepository
) {
  return new RuntimeSearchOperations({
    es,
    embeddingClient: mockEmbedding(),
    embeddingModel: "embedding",
    pageIndexRepo,
    ...(activeVersionRepo ? { activeVersionRepo } : {}),
  })
}

const pt10Reader: AccessContext = {
  tenantId: PT10_TENANT,
  subjectId: "user-pt10",
  groups: [],
  scopes: ["chat"],
}

test("PT-10 AC01: five higher-sorted foreign-knowledge-base nodes no longer push the target out of the PageIndex quota", async () => {
  const nodes: Pt10NodeFixture[] = [pt10Target()]
  const { repo, calls } = makeEligiblePageIndexRepo(nodes)
  const { requests, es } = hydrationEs([
    { documentId: "z-target", id: "chunk-z-target", tenantId: PT10_TENANT, knowledgeBaseId: "kb-a" },
    ...pt10Foreign((documentId) => ({
      documentId,
      id: `chunk-${documentId}`,
      tenantId: PT10_TENANT,
      knowledgeBaseId: "kb-b",
    })),
  ])
  const runtime = makePt10Runtime(es, repo)
  const scope = { knowledgeBaseIds: ["kb-a"] }

  const baseline = await runtime.pageIndexSearch({ text: PT10_QUERY_TEXT }, 5, pt10Reader, scope)
  assert.deepEqual(baseline.map(({ chunk }) => chunk.id), ["chunk-z-target"])

  nodes.push(...pt10Foreign((documentId) => pt10Node({
    documentId,
    tenantId: PT10_TENANT,
    knowledgeBaseId: "kb-b",
  })))

  const after = await runtime.pageIndexSearch({ text: PT10_QUERY_TEXT }, 5, pt10Reader, scope)
  assert.deepEqual(
    after.map(({ chunk }) => chunk.id),
    ["chunk-z-target"],
    "audit F1 inverted: the target keeps its hit after five foreign nodes arrive"
  )
  assert.deepEqual(after.map(({ source }) => source), ["pageIndex"])
  assert.equal(calls.at(-1)!.limit, PT10_NODE_LIMIT, "the ceiling stays five — no extra fetching")
  assert.deepEqual(calls.at(-1)!.eligibility?.knowledgeBaseIds, ["kb-a"])
  assert.deepEqual(calls.at(-1)!.eligibility?.tenantId, PT10_TENANT)
  const lastQuery = JSON.stringify(requests.at(-1)!.request.query)
  assert.ok(
    !lastQuery.includes("a-foreign-"),
    `an ineligible document must never reach hydration: ${lastQuery}`
  )

  // The same fixture with NO identity and NO scope is the legacy unscoped read:
  // the five slots still go to whatever sorts first, which is what the audited
  // callers relied on and what PT-10 deliberately left alone.
  const unscoped = await runtime.pageIndexSearch({ text: PT10_QUERY_TEXT }, 5)
  const unscopedQuery = JSON.stringify(requests.at(-1)!.request.query)
  assert.equal(unscoped.length, 5, "the unscoped legacy read still fills all five slots")
  assert.ok(
    !unscopedQuery.includes('"documentId":"z-target"'),
    `the unscoped legacy shape is unchanged (five ahead-of-target rows fill it): ${unscopedQuery}`
  )
})

test("PT-10 AC02: cross-tenant matches sorting ahead of the target never consume its slot", async () => {
  const nodes: Pt10NodeFixture[] = [
    pt10Target(),
    ...pt10Foreign((documentId) => pt10Node({
      documentId,
      tenantId: "tenant-other",
      knowledgeBaseId: "kb-a",
    })),
  ]
  const { repo, calls } = makeEligiblePageIndexRepo(nodes)
  const { requests, es } = hydrationEs([
    { documentId: "z-target", id: "chunk-z-target", tenantId: PT10_TENANT, knowledgeBaseId: "kb-a" },
  ])
  const runtime = makePt10Runtime(es, repo)

  const results = await runtime.pageIndexSearch(
    { text: PT10_QUERY_TEXT },
    5,
    pt10Reader,
    { knowledgeBaseIds: ["kb-a"] }
  )
  assert.deepEqual(results.map(({ chunk }) => chunk.id), ["chunk-z-target"])
  assert.deepEqual(calls.at(-1)!.eligibility?.tenantId, PT10_TENANT)
  assert.equal(requests.length, 1)
  assert.ok(
    JSON.stringify(requests[0].request.query).includes('"tenantId":"tenant-pt10"'),
    "hydration still re-checks the tenant"
  )
})

test("PT-10 AC02: an invisible group's nodes never consume a group-restricted caller's slot", async () => {
  const nodes: Pt10NodeFixture[] = [
    pt10Target(),
    ...pt10Foreign((documentId) => pt10Node({
      documentId,
      tenantId: PT10_TENANT,
      knowledgeBaseId: "kb-a",
      allowedGroups: ["secret-team"],
    })),
  ]
  const { repo, calls } = makeEligiblePageIndexRepo(nodes)
  const { requests, es } = hydrationEs([
    { documentId: "z-target", id: "chunk-z-target", tenantId: PT10_TENANT, knowledgeBaseId: "kb-a" },
    ...pt10Foreign((documentId) => ({
      documentId,
      id: `chunk-${documentId}`,
      tenantId: PT10_TENANT,
      knowledgeBaseId: "kb-a",
    })),
  ])
  const runtime = makePt10Runtime(es, repo)
  const restricted: AccessContext = {
    tenantId: PT10_TENANT,
    subjectId: "user-ops",
    groups: ["ops"],
    scopes: ["chat"],
  }

  const results = await runtime.pageIndexSearch(
    { text: PT10_QUERY_TEXT },
    5,
    restricted,
    { knowledgeBaseIds: ["kb-a"] }
  )
  assert.deepEqual(results.map(({ chunk }) => chunk.id), ["chunk-z-target"])
  assert.deepEqual(calls.at(-1)!.eligibility?.callerGroups, ["ops"])
  assert.equal(requests.length, 1)

  // A tenant-wide (zero-group) reader keeps seeing those same rows — the axis is
  // caller-derived, never a blanket rule.
  const tenantWide = await runtime.pageIndexSearch(
    { text: PT10_QUERY_TEXT },
    5,
    pt10Reader,
    { knowledgeBaseIds: ["kb-a"] }
  )
  assert.deepEqual(
    tenantWide.map(({ chunk }) => chunk.id).sort(),
    ["chunk-a-foreign-0", "chunk-a-foreign-1", "chunk-a-foreign-2", "chunk-a-foreign-3", "chunk-a-foreign-4"],
    "the five-slot ceiling is unchanged for a caller entitled to all of them"
  )
  assert.deepEqual(calls.at(-1)!.eligibility?.callerGroups, [])
})

test("PT-10 AC02: a non-active document version never consumes the active caller's slot", async () => {
  const nodes: Pt10NodeFixture[] = [
    pt10Target(),
    ...pt10Foreign((documentId) => pt10Node({
      documentId,
      tenantId: PT10_TENANT,
      knowledgeBaseId: "kb-a",
    })),
  ]
  const activeVersionRepo = {
    getActiveDocIds: () => ["z-target"],
  } as unknown as ActiveVersionRepository
  const { repo, calls } = makeEligiblePageIndexRepo(nodes, { activeDocIds: ["z-target"] })
  const { requests, es } = hydrationEs([
    { documentId: "z-target", id: "chunk-z-target", tenantId: PT10_TENANT, knowledgeBaseId: "kb-a" },
    ...pt10Foreign((documentId) => ({
      documentId,
      id: `chunk-${documentId}`,
      tenantId: PT10_TENANT,
      knowledgeBaseId: "kb-a",
    })),
  ])
  const runtime = makePt10Runtime(es, repo, activeVersionRepo)

  const results = await runtime.pageIndexSearch(
    { text: PT10_QUERY_TEXT },
    5,
    pt10Reader,
    { knowledgeBaseIds: ["kb-a"] }
  )
  assert.deepEqual(
    results.map(({ chunk }) => chunk.id),
    ["chunk-z-target"],
    "only the active version may occupy a slot"
  )
  assert.equal(calls.at(-1)!.eligibility?.restrictToActiveDocumentVersions, true)
  const hydration = JSON.stringify(requests[0].request.query)
  assert.ok(hydration.includes('"documentId":["z-target"]'), `hydration keeps its active-version clause: ${hydration}`)
  assert.ok(!hydration.includes("a-foreign-"), `ineligible ids never reach hydration: ${hydration}`)
})

test("PT-10 AC03: a configured-but-empty active set hides everything while an unconfigured repository keeps the default read", async () => {
  const nodes: Pt10NodeFixture[] = [pt10Target()]
  const emptyActive = { getActiveDocIds: () => [] } as unknown as ActiveVersionRepository

  // Configured, active set EMPTY → nothing is eligible → no hydration at all.
  const gatedRepo = makeEligiblePageIndexRepo(nodes, { activeDocIds: [] })
  const gatedEs = hydrationEs([
    { documentId: "z-target", id: "chunk-z-target", tenantId: PT10_TENANT, knowledgeBaseId: "kb-a" },
  ])
  const gated = makePt10Runtime(gatedEs.es, gatedRepo.repo, emptyActive)
  const gatedResults = await gated.pageIndexSearch({ text: PT10_QUERY_TEXT }, 5)
  assert.deepEqual(gatedResults, [], "a configured-empty active set must hide everything")
  assert.equal(gatedRepo.calls.at(-1)!.eligibility?.restrictToActiveDocumentVersions, true)
  assert.equal(gatedEs.requests.length, 0, "nothing eligible must not reach hydration")

  // NOT configured → the pre-existing default read, on the same data.
  const openRepo = makeEligiblePageIndexRepo(nodes, { activeDocIds: [] })
  const openEs = hydrationEs([
    { documentId: "z-target", id: "chunk-z-target", tenantId: PT10_TENANT, knowledgeBaseId: "kb-a" },
  ])
  const open = makePt10Runtime(openEs.es, openRepo.repo)
  const openResults = await open.pageIndexSearch({ text: PT10_QUERY_TEXT }, 5)
  assert.deepEqual(
    openResults.map(({ chunk }) => chunk.id),
    ["chunk-z-target"],
    "an unconfigured active-version repository keeps the existing default behavior"
  )
  assert.equal(
    openRepo.calls.at(-1)!.eligibility?.restrictToActiveDocumentVersions,
    undefined,
    "the two states never collapse into the same axis"
  )

  // And the ES-side fail-closed sentinel is untouched where hydration does run.
  const starvedRepo = makeEligiblePageIndexRepo([pt10Target()], { activeDocIds: ["z-target"] })
  const starvedEs = hydrationEs([
    { documentId: "z-target", id: "chunk-z-target", tenantId: PT10_TENANT, knowledgeBaseId: "kb-a" },
  ])
  const starved = makePt10Runtime(starvedEs.es, starvedRepo.repo, {
    getActiveDocIds: () => ["some-other-document"],
  } as unknown as ActiveVersionRepository)
  const starvedResults = await starved.pageIndexSearch({ text: PT10_QUERY_TEXT }, 5)
  assert.deepEqual(starvedResults, [], "hydration refuses a node whose version is not active")
  assert.equal(starvedEs.requests.length, 1)
  assert.ok(
    JSON.stringify(starvedEs.requests[0].request.query).includes("some-other-document"),
    "the active terms clause is still emitted verbatim"
  )
})

test("PT-10 AC04: an explicit empty knowledge scope queries neither PageIndex nor Elasticsearch", async () => {
  const { repo, calls } = makeEligiblePageIndexRepo([pt10Target()])
  const { requests, es } = hydrationEs([
    { documentId: "z-target", id: "chunk-z-target", tenantId: PT10_TENANT, knowledgeBaseId: "kb-a" },
  ])
  const runtime = makePt10Runtime(es, repo)

  const results = await runtime.pageIndexSearch(
    { text: PT10_QUERY_TEXT },
    5,
    pt10Reader,
    { knowledgeBaseIds: [] }
  )

  assert.deepEqual(results, [])
  assert.equal(calls.length, 0, "an empty scope must not even read the node table")
  assert.equal(requests.length, 0, "an empty scope must not reach Elasticsearch")
})

test("PT-10 AC04: an admin caller gains no cross-tenant or cross-knowledge-base reach from the node quota", async () => {
  const nodes: Pt10NodeFixture[] = [
    pt10Target(),
    pt10Node({ documentId: "b-other-kb", tenantId: PT10_TENANT, knowledgeBaseId: "kb-b" }),
    pt10Node({ documentId: "c-other-tenant", tenantId: "tenant-other", knowledgeBaseId: "kb-a" }),
  ]
  const { repo, calls } = makeEligiblePageIndexRepo(nodes)
  const { requests, es } = hydrationEs([
    { documentId: "z-target", id: "chunk-z-target", tenantId: PT10_TENANT, knowledgeBaseId: "kb-a" },
    { documentId: "b-other-kb", id: "chunk-b-other-kb", tenantId: PT10_TENANT, knowledgeBaseId: "kb-b" },
    { documentId: "c-other-tenant", id: "chunk-c-other-tenant", tenantId: "tenant-other", knowledgeBaseId: "kb-a" },
  ])
  const runtime = makePt10Runtime(es, repo)
  const admin: AccessContext = {
    tenantId: PT10_TENANT,
    subjectId: "admin-1",
    groups: [],
    scopes: ["admin"],
  }

  const adminResults = await runtime.pageIndexSearch(
    { text: PT10_QUERY_TEXT },
    5,
    admin,
    { knowledgeBaseIds: ["kb-a"] }
  )
  assert.deepEqual(adminResults.map(({ chunk }) => chunk.id), ["chunk-z-target"])
  const adminEligibility = calls.at(-1)!.eligibility

  const readerResults = await runtime.pageIndexSearch(
    { text: PT10_QUERY_TEXT },
    5,
    pt10Reader,
    { knowledgeBaseIds: ["kb-a"] }
  )
  assert.deepEqual(
    calls.at(-1)!.eligibility,
    adminEligibility,
    "the node axes are the caller's tenant and scope — an admin scope widens neither"
  )
  assert.deepEqual(readerResults.map(({ chunk }) => chunk.id), ["chunk-z-target"])
  assert.equal(requests.length, 2)
  const adminHydration = JSON.stringify(requests[0].request.query)
  assert.ok(!adminHydration.includes("b-other-kb"), `another knowledge base leaked: ${adminHydration}`)
  assert.ok(!adminHydration.includes("c-other-tenant"), `another tenant leaked: ${adminHydration}`)
})

test("PT-10 AC05: eight eligible nodes yield the first five, deduped by linked chunk and cut to topK", async () => {
  const nodes: Pt10NodeFixture[] = [
    pt10Node({ documentId: "d0", chunk: "c0" }),
    pt10Node({ documentId: "d1", chunk: "c1" }),
    pt10Node({ documentId: "d2", chunk: "c2" }),
    pt10Node({ documentId: "d3", chunk: "shared" }),
    // d4 links the SAME chunk as d3 — the dedup below must collapse it.
    pt10Node({ documentId: "d4", chunk: "shared" }),
    pt10Node({ documentId: "d5", chunk: "c5" }),
    pt10Node({ documentId: "d6", chunk: "c6" }),
    pt10Node({ documentId: "d7", chunk: "c7" }),
  ].map((node) => ({ ...node, tenantId: PT10_TENANT, knowledgeBaseId: "kb-a" }))
  const { repo, calls } = makeEligiblePageIndexRepo(nodes)
  const { requests, es } = hydrationEs([
    { documentId: "d0", id: "c0", tenantId: PT10_TENANT, knowledgeBaseId: "kb-a" },
    { documentId: "d1", id: "c1", tenantId: PT10_TENANT, knowledgeBaseId: "kb-a" },
    { documentId: "d2", id: "c2", tenantId: PT10_TENANT, knowledgeBaseId: "kb-a" },
    { documentId: "d3", id: "shared", tenantId: PT10_TENANT, knowledgeBaseId: "kb-a" },
    { documentId: "d4", id: "shared", tenantId: PT10_TENANT, knowledgeBaseId: "kb-a" },
  ])
  const runtime = makePt10Runtime(es, repo)

  const identities = (index: number): Array<{ documentId: string; id: string }> => {
    const bool = (requests[index].request.query as { bool: { should: unknown[] } }).bool
    return bool.should.map((clause) => {
      const must =
        (clause as { bool: { must: Array<Record<string, unknown>> } }).bool.must
      return {
        documentId: pt10TermValue(must, "documentId") as string,
        id: pt10TermValue(must, "id") as string,
      }
    })
  }

  const results = await runtime.pageIndexSearch({ text: PT10_QUERY_TEXT }, 4, pt10Reader, {
    knowledgeBaseIds: ["kb-a"],
  })
  assert.equal(calls.at(-1)!.limit, PT10_NODE_LIMIT)
  assert.deepEqual(identities(0), [
    { documentId: "d0", id: "c0" },
    { documentId: "d1", id: "c1" },
    { documentId: "d2", id: "c2" },
    { documentId: "d3", id: "shared" },
  ], "the five eligible nodes are deduped on documentId+chunkId and cut to topK, in stable order")
  assert.deepEqual(results.map(({ chunk }) => chunk.id), ["c0", "c1", "c2", "shared"])

  // A smaller topK still cuts the same stable list — nothing is re-fetched.
  await runtime.pageIndexSearch({ text: PT10_QUERY_TEXT }, 2, pt10Reader, {
    knowledgeBaseIds: ["kb-a"],
  })
  assert.equal(calls.length, 2)
  assert.equal(calls.at(-1)!.limit, PT10_NODE_LIMIT, "topK never raises the node ceiling")
  assert.deepEqual(identities(1), [
    { documentId: "d0", id: "c0" },
    { documentId: "d1", id: "c1" },
  ])
})

test("PT-10 AC06: material that lost eligibility between selection and hydration is refused", async () => {
  const { repo } = makeEligiblePageIndexRepo([pt10Target()])
  const { requests, es } = hydrationEs([
    {
      documentId: "z-target",
      id: "chunk-z-target",
      tenantId: "tenant-revoked",
      knowledgeBaseId: "kb-a",
    },
  ])
  const runtime = makePt10Runtime(es, repo)

  // The node was selected as eligible; by hydration time its document belongs to
  // another tenant (and is no longer in the active set). Both re-checks fire.
  const results = await runtime.pageIndexSearch(
    { text: PT10_QUERY_TEXT },
    5,
    pt10Reader,
    { knowledgeBaseIds: ["kb-a"] }
  )
  assert.deepEqual(results, [], "a stale identity must not be hydrated")
  assert.equal(requests.length, 1, "hydration is where the change is caught, not skipped")
  const query = JSON.stringify(requests[0].request.query)
  assert.ok(query.includes('"tenantId":"tenant-pt10"'), `ACL re-check present: ${query}`)
  assert.ok(query.includes('"knowledgeBaseId":["kb-a"]'), `scope re-check present: ${query}`)
  assert.ok(!query.includes("tenant-revoked"), "no content from the revoked owner is returned")
})

test("PT-10 AC06: a repository that ignores the eligibility argument is still filtered before hydration", async () => {
  // A legacy/stub repository that hands back every match regardless of the
  // scope it was given: the application-layer filters stay, so an ineligible
  // node cannot occupy the hydration set.
  const legacyRepo = {
    searchNodes: () => [
      { ...pt10Target(), linkedChunkIds: ["chunk-target"] },
      pt10Node({ documentId: "a-foreign-0", chunk: "chunk-foreign", knowledgeBaseId: "kb-b" }),
      pt10Node({ documentId: "a-other-tenant", chunk: "chunk-other", tenantId: "tenant-x" }),
    ],
  } as unknown as PageIndexRepository
  const { requests, es } = hydrationEs([])
  const runtime = makePt10Runtime(es, legacyRepo)

  await runtime.pageIndexSearch({ text: PT10_QUERY_TEXT }, 5, pt10Reader, {
    knowledgeBaseIds: ["kb-a"],
  })
  const query = JSON.stringify(requests[0].request.query)
  assert.ok(query.includes('"documentId":"z-target"'))
  assert.ok(!query.includes("a-foreign-0"), "another knowledge base is dropped before hydration")
  assert.ok(!query.includes("a-other-tenant"), "another tenant is dropped before hydration")
})

test("PT-10 AC07: a failing repository stays an explainable channel outage and the abort signal still reaches hydration", async () => {
  const failing = {
    searchNodes: () => {
      throw new Error("page index table unavailable")
    },
  } as unknown as PageIndexRepository
  const { es } = hydrationEs([])
  const runtime = makePt10Runtime(es, failing)
  await assert.rejects(
    () => runtime.pageIndexSearch({ text: PT10_QUERY_TEXT }, 5, pt10Reader, { knowledgeBaseIds: ["kb-a"] }),
    /page index table unavailable/
  )

  const searcher = new SearcherImpl(runtime)
  const outcome = await searcher.search(
    { text: PT10_QUERY_TEXT },
    {
      accessContext: pt10Reader,
      retrievalScope: { knowledgeBaseIds: ["kb-a"] },
      channels: ["pageIndex"],
    }
  )
  assert.equal(outcome.status, "insufficient")
  assert.deepEqual(outcome.unavailableChannels, ["pageIndex"])

  // Zero hits stay an empty result, not an error.
  const emptyRepo = makeEligiblePageIndexRepo([])
  const emptyEs = hydrationEs([])
  const emptyRuntime = makePt10Runtime(emptyEs.es, emptyRepo.repo)
  assert.deepEqual(
    await emptyRuntime.pageIndexSearch({ text: PT10_QUERY_TEXT }, 5, pt10Reader, {
      knowledgeBaseIds: ["kb-a"],
    }),
    []
  )
  assert.equal(emptyEs.requests.length, 0, "zero eligible nodes need no hydration query")

  // Cancellation still converges on the run's signal at the hydration call.
  const controller = new AbortController()
  const signalRepo = makeEligiblePageIndexRepo([pt10Target()])
  const signalEs = hydrationEs([
    { documentId: "z-target", id: "chunk-z-target", tenantId: PT10_TENANT, knowledgeBaseId: "kb-a" },
  ])
  const signalRuntime = makePt10Runtime(signalEs.es, signalRepo.repo)
  const hydrated = await signalRuntime.pageIndexSearch(
    { text: PT10_QUERY_TEXT },
    5,
    pt10Reader,
    { knowledgeBaseIds: ["kb-a"] },
    controller.signal
  )
  assert.deepEqual(hydrated.map(({ chunk }) => chunk.id), ["chunk-z-target"])
  assert.equal(signalEs.requests[0].options?.signal, controller.signal)

  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(
    () =>
      signalRuntime.pageIndexSearch(
        { text: PT10_QUERY_TEXT },
        5,
        pt10Reader,
        { knowledgeBaseIds: ["kb-a"] },
        aborted.signal
      ),
    (error: Error) => error.name === "AbortError"
  )

  // A composition without a PageIndex repository keeps its own explainable error.
  const noRepo = new RuntimeSearchOperations({
    es,
    embeddingClient: mockEmbedding(),
    embeddingModel: "embedding",
  })
  await assert.rejects(
    () => noRepo.pageIndexSearch({ text: PT10_QUERY_TEXT }, 5),
    /pageIndex repository unavailable/
  )
})

