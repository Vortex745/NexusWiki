import assert from "node:assert/strict"
import test from "node:test"
import type { Client } from "@elastic/elasticsearch"
import type OpenAI from "openai"
import type { Chunk } from "../../types"
import { ESStore, Neo4jStore } from "./store"

test("stores parents without embedding them and preserves composite chunk identity", async () => {
  const embeddingInputs: string[][] = []
  let bulkBody: unknown[] = []
  const store = Object.create(ESStore.prototype) as ESStore
  Object.assign(store, {
    embeddingModel: "embedding-model",
    // Ticket 02: index name is now an instance field (dedicated-index seam)
    indexName: "kefu-rag-chunks",
    embeddingClient: {
      embeddings: {
        create: async ({ input }: { input: string[] }) => {
          embeddingInputs.push(input)
          return { data: input.map(() => ({ embedding: [0.1, 0.2] })) }
        },
      },
    } as unknown as OpenAI,
    client: {
      bulk: async ({ body }: { body: unknown[] }) => {
        bulkBody = body
        return { errors: false, items: [] }
      },
    } as unknown as Client,
  })
  const chunks: Chunk[] = [
    {
      id: "child-shared",
      documentId: "doc-v1",
      parentId: "parent-shared",
      content: "child evidence",
      childrenIds: [],
      metadata: { kind: "child" },
    },
    {
      id: "parent-shared",
      documentId: "doc-v1",
      content: "full parent context",
      childrenIds: ["child-shared"],
      metadata: { kind: "parent" },
    },
  ]

  await store.storeChunks(chunks, {
    tenantId: "tenant-a",
    allowedGroups: ["support", "billing"],
    knowledgeBaseId: "kb-a",
  })

  assert.deepEqual(embeddingInputs, [["child evidence"]])
  assert.deepEqual(bulkBody[0], {
    index: { _index: "kefu-rag-chunks", _id: "doc-v1:child-shared" },
  })
  assert.deepEqual(bulkBody[1], {
    id: "child-shared",
    documentId: "doc-v1",
    tenantId: "tenant-a",
    allowedGroups: ["support", "billing"],
    knowledgeBaseId: "kb-a",
    kind: "child",
    content: "child evidence",
    embedding: [0.1, 0.2],
    parentId: "parent-shared",
    childrenIds: [],
    metadata: { kind: "child" },
  })
  assert.deepEqual(bulkBody[2], {
    index: { _index: "kefu-rag-chunks", _id: "doc-v1:parent-shared" },
  })
  assert.deepEqual(bulkBody[3], {
    id: "parent-shared",
    documentId: "doc-v1",
    tenantId: "tenant-a",
    allowedGroups: ["support", "billing"],
    knowledgeBaseId: "kb-a",
    kind: "parent",
    content: "full parent context",
    parentId: undefined,
    childrenIds: ["child-shared"],
    metadata: { kind: "parent" },
  })

  await store.storeChunks([chunks[0]], {
    tenantId: "default",
    allowedGroups: [],
    knowledgeBaseId: "kb-default-default",
  })
  assert.deepEqual(bulkBody[1], {
    id: "child-shared",
    documentId: "doc-v1",
    tenantId: "default",
    allowedGroups: [],
    knowledgeBaseId: "kb-default-default",
    kind: "child",
    content: "child evidence",
    embedding: [0.1, 0.2],
    parentId: "parent-shared",
    childrenIds: [],
    metadata: { kind: "child" },
  })
  await assert.rejects(
    store.storeChunks([chunks[0]], undefined as never),
    /access metadata is required/
  )
})

test("creates a new chunk index with access metadata mappings", async () => {
  let properties: Record<string, unknown> | undefined
  const store = Object.create(ESStore.prototype) as ESStore
  Object.assign(store, {
    embeddingDimensions: 2,
    indexName: "kefu-rag-chunks",
    client: {
      indices: {
        exists: async () => false,
        create: async (request: {
          mappings: { properties: Record<string, unknown> }
        }) => {
          properties = request.mappings.properties
          return { acknowledged: true }
        },
      },
    } as unknown as Client,
  })

  await store.ensureIndex()

  assert.deepEqual(properties?.tenantId, { type: "keyword" })
  assert.deepEqual(properties?.allowedGroups, { type: "keyword" })
  assert.deepEqual(properties?.knowledgeBaseId, { type: "keyword" })
})

test("adds access metadata mappings to an existing chunk index", async () => {
  let properties: Record<string, unknown> | undefined
  const store = Object.create(ESStore.prototype) as ESStore
  Object.assign(store, {
    embeddingDimensions: 2,
    indexName: "kefu-rag-chunks",
    client: {
      indices: {
        exists: async () => true,
        getMapping: async () => ({
          "kefu-rag-chunks": {
            mappings: {
              properties: {
                embedding: { dims: 2 },
                kind: { type: "keyword" },
              },
            },
          },
        }),
        putMapping: async (request: { properties: Record<string, unknown> }) => {
          properties = request.properties
          return { acknowledged: true }
        },
      },
    } as unknown as Client,
  })

  await store.ensureIndex()

  assert.deepEqual(properties, {
    kind: { type: "keyword" },
    parentId: { type: "keyword" },
    childrenIds: { type: "keyword" },
    tenantId: { type: "keyword" },
    allowedGroups: { type: "keyword" },
    knowledgeBaseId: { type: "keyword" },
  })
})

test("Ticket 02: an injected index name owns both the chunk index and its writes", async () => {
  const bulkBody: unknown[] = []
  const client = {
    bulk: async ({ body }: { body: unknown[] }) => {
      bulkBody.push(...body)
      return { errors: false, items: [] }
    },
  } as unknown as Client
  const embeddingClient = {
    embeddings: {
      create: async ({ input }: { input: string[] }) => ({
        data: input.map(() => ({ embedding: [0.1, 0.2] })),
      }),
    },
  } as unknown as OpenAI

  const scoped = new ESStore({
    client,
    embeddingClient,
    embeddingModel: "embedding-model",
    embeddingDimensions: 2,
    indexName: "kefu-rag-chunks-eval-scopealpha0001",
  })
  assert.equal(scoped.chunkIndexName, "kefu-rag-chunks-eval-scopealpha0001")

  // Omitted index name → the business index (production behavior unchanged).
  const business = new ESStore({
    client,
    embeddingClient,
    embeddingModel: "embedding-model",
    embeddingDimensions: 2,
  })
  assert.equal(business.chunkIndexName, "kefu-rag-chunks")

  await scoped.storeChunks([
    {
      id: "chunk-1",
      documentId: "doc-1",
      content: "scoped evidence",
      childrenIds: [],
      metadata: { kind: "child" },
    },
  ], {
    tenantId: "eval-scopealpha0001",
    allowedGroups: [],
    knowledgeBaseId: "kb-eval-scopealpha0001",
  })
  assert.deepEqual(bulkBody[0], {
    index: {
      _index: "kefu-rag-chunks-eval-scopealpha0001",
      _id: "doc-1:chunk-1",
    },
  })
})

test("stores directional Wikilink wording and source chunk provenance", async () => {
  const calls: Array<Record<string, unknown>> = []
  const queries: string[] = []
  const driver = {
    session() {
      return {
        async run(query: string, params: Record<string, unknown>) {
          queries.push(query)
          calls.push(params)
        },
        async close() {},
      }
    },
  }
  const store = new Neo4jStore(driver as never)

  const wikilinks = [{
    sourceEntityId: "refund",
    targetEntityId: "customer",
    relation: "APPLIES_TO",
    weight: 0.8,
    provenance: [
      { documentId: "doc-v1", chunkId: "chunk-1" },
      { documentId: "doc-v1", chunkId: "chunk-2" },
    ],
  }]
  await store.storeWikilinks(wikilinks, {
    tenantId: "tenant-a",
    allowedGroups: ["support", "billing"],
    knowledgeBaseId: "kb-a",
  })

  assert.deepEqual(calls, [{
    sourceId: "customer",
    targetId: "refund",
    relation: "refund->customer:APPLIES_TO",
    weight: 0.8,
    provenance: [
      JSON.stringify(["doc-v1", "chunk-1", "tenant-a", ["support", "billing"], 0.8, "kb-a"]),
      JSON.stringify(["doc-v1", "chunk-2", "tenant-a", ["support", "billing"], 0.8, "kb-a"]),
    ],
  }])
  assert.match(queries[0], /MERGE \(a\)-\[r:WIKILINK \{fact: \$relation\}\]->\(b\)/)
  // Ticket 02: the provenance entries are the relation's only ownership
  // record (JSON [documentId, chunkId, tenantId, allowedGroups, weight]);
  // Ticket 03 (KB-02A) appends knowledgeBaseId as the 6th element. The
  // eval-scope graph cleanup matches the tenant element exactly on them and
  // uses the trailing weight to restore a shared relation's weight when it
  // releases its share.
  await assert.rejects(
    store.storeWikilinks(wikilinks, undefined as never),
    /access metadata is required/
  )
})

test("stores separate facts for different relationships between the same entities", async () => {
  const calls: Array<Record<string, unknown>> = []
  const driver = {
    session() {
      return {
        async run(_query: string, params: Record<string, unknown>) {
          calls.push(params)
        },
        async close() {},
      }
    },
  }
  const store = new Neo4jStore(driver as never)

  await store.storeWikilinks([
    {
      sourceEntityId: "refund",
      targetEntityId: "customer",
      relation: "APPLIES_TO",
      weight: 0.8,
      provenance: [{ documentId: "doc-v1", chunkId: "chunk-1" }],
    },
    {
      sourceEntityId: "refund",
      targetEntityId: "customer",
      relation: "EXCLUDES",
      weight: 0.4,
      provenance: [{ documentId: "doc-v1", chunkId: "chunk-2" }],
    },
  ], {
    tenantId: "default",
    allowedGroups: [],
    knowledgeBaseId: "kb-default-default",
  })

  assert.deepEqual(calls.map(({ relation, weight, provenance }) => ({
    relation,
    weight,
    provenance,
  })), [
    {
      relation: "refund->customer:APPLIES_TO",
      weight: 0.8,
      provenance: [
        JSON.stringify(["doc-v1", "chunk-1", "default", [], 0.8, "kb-default-default"]),
      ],
    },
    {
      relation: "refund->customer:EXCLUDES",
      weight: 0.4,
      provenance: [
        JSON.stringify(["doc-v1", "chunk-2", "default", [], 0.4, "kb-default-default"]),
      ],
    },
  ])
})
