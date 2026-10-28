import assert from "node:assert/strict"
import { Socket } from "node:net"
import test, { type TestContext } from "node:test"
import type { Client, estypes } from "@elastic/elasticsearch"
import type OpenAI from "openai"
import type { AccessContext } from "../../access/context"
import type { Chunk } from "../../types"
import { RecursiveChunker } from "../../ingestion/chunker/chunker"
import { buildPageIndex } from "../../ingestion/page_index_builder"
import { IngestionLifecycle, type SubmitIngestionInput } from "../../ingestion/lifecycle"
import { PipelineStageRunner } from "../../ingestion/pipeline"
import type { ChunkAccessMetadata, IngestionStoreImpl } from "../../ingestion/storage"
import { openDb } from "../../ingestion/tracking/db"
import { DocumentRepo } from "../../ingestion/tracking/doc_repo"
import { ActiveVersionRepository } from "../../ingestion/tracking/active_version_repo"
import { PageIndexRepository } from "../../ingestion/tracking/page_index_repo"
import { TaskRepo } from "../../ingestion/tracking/task_repo"
import { SqliteSourceLifecycleStore } from "../../knowledge/source_lifecycle_store"
import { RetirementServiceImpl } from "../../knowledge/retirement"
import { RuntimeSearchOperations, SearcherImpl } from "./searcher"

type IndexedChunk = Chunk & ChunkAccessMetadata & { kind: unknown }
type Clause = NonNullable<estypes.QueryDslQueryContainer>

function clauses(value: estypes.QueryDslQueryContainer | estypes.QueryDslQueryContainer[]): Clause[] {
  const queries = value === undefined ? [] : Array.isArray(value) ? value : [value]
  return queries.map((query) => {
    assert.ok(query, "an index query must not contain undefined clauses")
    return query
  })
}

// The external index retains every written version. Evaluate the submitted ES
// predicates, including nested ACL/identity clauses; never pre-hide retired data.
function matches(chunk: IndexedChunk, query: Clause): boolean {
  const fields = chunk as unknown as Record<string, unknown>
  if (query.term) return Object.entries(query.term).every(([field, value]) => fields[field] === value)
  if (query.terms) return Object.entries(query.terms).every(([field, values]) => {
    assert.ok(Array.isArray(values), "fixture only accepts literal terms")
    const actual = fields[field]
    return Array.isArray(actual) ? actual.some((value) => values.includes(value)) : values.some((value) => value === actual)
  })
  if (query.exists) {
    const value = fields[query.exists.field]
    return value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0)
  }
  if (query.match) return Object.entries(query.match).every(([field, value]) => {
    const text = typeof value === "object" ? value.query : value
    return String(fields[field]).includes(String(text))
  })
  if (query.bool) {
    const { must, filter, must_not, should, minimum_should_match } = query.bool
    return [...clauses(must), ...clauses(filter)].every((clause) => matches(chunk, clause)) &&
      clauses(must_not).every((clause) => !matches(chunk, clause)) &&
      clauses(should).filter((clause) => matches(chunk, clause)).length >= Number(minimum_should_match ?? 0)
  }
  throw new Error(`Unsupported controlled-index predicate: ${JSON.stringify(query)}`)
}

function fixture(t: TestContext) {
  const db = openDb(":memory:")
  t.after(() => db.close())
  let networkAttempts = 0
  let cleanupCalls = 0
  t.mock.method(Socket.prototype, "connect", () => {
    networkAttempts++
    throw new Error("BF-01 forbids network")
  })
  t.mock.method(globalThis, "fetch", async () => {
    networkAttempts++
    throw new Error("BF-01 forbids fetch")
  })
  const indexed = new Map<string, IndexedChunk>()
  const requests: estypes.SearchRequest[] = []
  const store = {
    chunkIndexName: "bf01-controlled-chunks",
    async deleteDocumentChunks(documentId: string) {
      for (const [key, chunk] of indexed) if (chunk.documentId === documentId) indexed.delete(key)
    },
    async storeChunks(chunks: Chunk[], access: ChunkAccessMetadata) {
      for (const chunk of chunks) indexed.set(`${chunk.documentId}\0${chunk.id}`, {
        ...chunk, ...access, kind: chunk.metadata.kind, embedding: [1, 0],
      })
    },
    async storeEntities() { throw new Error("unexpected graph write") },
    async storeWikilinks() { throw new Error("unexpected graph write") },
    async close() {},
  }
  const lifecycle = new IngestionLifecycle(
    db, new PipelineStageRunner(db, undefined, store as unknown as IngestionStoreImpl),
    () => new Date(), "auto", {
      async run() {
        cleanupCalls++
        throw new Error("controlled cleanup failure: index unavailable")
      },
    },
  )
  const documents = new DocumentRepo(db)
  const tasks = new TaskRepo(db)
  const pageIndex = new PageIndexRepository(db)
  const active = new ActiveVersionRepository(db)
  const retirement = new RetirementServiceImpl(db, new SqliteSourceLifecycleStore(db), tasks)
  const operations = new RuntimeSearchOperations({
    es: {
      async search(request: estypes.SearchRequest) {
        requests.push(request)
        assert.ok(!Array.isArray(request.knn))
        const predicate = request.knn?.filter ?? request.query
        assert.ok(predicate, "every read has an actual index predicate")
        const hits = [...indexed.values()].filter((chunk) => clauses(predicate).every((q) => matches(chunk, q)))
        return { hits: { hits: hits.slice(0, request.knn?.k ?? request.size).map((chunk) => ({
          _source: chunk, _score: 1,
        })) } }
      },
    } as unknown as Client,
    embeddingClient: { embeddings: { async create() {
      return { data: [{ embedding: [1, 0] }] }
    } } } as unknown as OpenAI,
    embeddingModel: "offline-equal-vectors",
    indexName: store.chunkIndexName,
    activeVersionRepo: active,
    pageIndexRepo: pageIndex,
    reranker: { model: "offline-identity-rerank", async rerank(_query, results) { return results } },
  })
  const searcher = new SearcherImpl(operations)
  const access: AccessContext = { tenantId: "default", subjectId: "reader", groups: ["ops"], scopes: ["chat"] }
  const scope = { knowledgeBaseIds: ["kb-default-default"] }
  const query = { text: "RETIREMENT_POLICY" }
  async function ingest(name: string, overrides: Partial<SubmitIngestionInput> = {}) {
    const submission = lifecycle.submit({
      title: `RETIREMENT_POLICY ${name}`,
      content: `RETIREMENT_POLICY ${name}: retained evidence for the retirement visibility regression.`,
      source: `https://example.invalid/${name}`,
      ...overrides,
    })
    assert.equal(submission.status, "pending")
    const run = await lifecycle.runNext()
    assert.equal(run?.success, true, run?.error)
    const document = documents.get(submission.docId)!
    assert.equal(documents.getActive(document.sourceId)?.id, document.id)
    return document
  }
  function retire(sourceId: string) {
    const result = retirement.retire(sourceId, "default", "BF-01 regression", "reader")
    assert.equal(result?.lifecycleState, "retired")
    assert.equal(result?.enqueuedCleanupTasks, 4)
  }
  return { db, indexed, store, lifecycle, documents, tasks, pageIndex, active, operations, searcher,
    access, scope, query, ingest, retire, requests,
    get cleanupCalls() { return cleanupCalls },
    get networkAttempts() { return networkAttempts },
  }
}

test("BF-01: BM25 and assembled parents exclude a retired source before cleanup", async (t) => {
  const f = fixture(t)
  const removed = await f.ingest("removed")
  const kept = await f.ingest("kept")
  const options = { channels: ["bm25"] as const, accessContext: f.access, retrievalScope: f.scope }
  const before = await f.searcher.search(f.query, { ...options, channels: [...options.channels] })
  assert.deepEqual(new Set(before.results.map(({ chunk }) => chunk.documentId)), new Set([removed.id, kept.id]))
  assert.ok(before.results.every(({ parentChunk }) => parentChunk?.content.includes("RETIREMENT_POLICY")))
  const retainedChunks = f.indexed.size

  f.retire(removed.sourceId)
  assert.equal(f.documents.getActive(removed.sourceId)?.id, removed.id, "retirement keeps its historical pointer")
  assert.equal(f.tasks.getByDocId(removed.id)?.status, "pending")
  const after = await f.searcher.search(f.query, { ...options, channels: [...options.channels] })
  assert.equal(after.status, "ok")
  assert.deepEqual(after.results.map(({ chunk }) => chunk.documentId), [kept.id])
  assert.equal(after.results[0].parentChunk?.documentId, kept.id)
  assert.match(after.results[0].parentChunk!.content, /kept/)
  assert.doesNotMatch(JSON.stringify(after.results), /removed/)
  assert.equal(f.indexed.size, retainedChunks, "old child and parent data remain physically indexed")
  assert.equal(f.cleanupCalls, 0)
  assert.equal(f.networkAttempts, 0)
})

test("BF-01: PageIndex navigation and hydrated context exclude retirement while nodes remain stored", async (t) => {
  const f = fixture(t)
  const removed = await f.ingest("removed")
  const kept = await f.ingest("kept")
  const eligibility = {
    tenantId: f.access.tenantId, callerGroups: f.access.groups,
    knowledgeBaseIds: f.scope.knowledgeBaseIds, restrictToActiveDocumentVersions: true,
  }
  assert.deepEqual(new Set(f.pageIndex.searchNodes(f.query.text, 5, eligibility).map((node) => node.documentId)),
    new Set([removed.id, kept.id]))
  f.retire(removed.sourceId)
  assert.equal(f.pageIndex.getNodesByDocument(removed.id).length, 1, "cleanup has not removed the stored node")
  assert.deepEqual(f.pageIndex.searchNodes(f.query.text, 5, eligibility).map((node) => node.documentId), [kept.id])
  const after = await f.searcher.search(f.query, {
    channels: ["pageIndex"], accessContext: f.access, retrievalScope: f.scope,
  })
  assert.equal(after.status, "ok")
  assert.deepEqual(after.results.map(({ chunk }) => chunk.documentId), [kept.id])
  assert.equal(after.results[0].parentChunk?.documentId, kept.id)
  assert.doesNotMatch(JSON.stringify(after.results), /removed/)
  assert.equal(f.cleanupCalls, 0)
  assert.equal(f.networkAttempts, 0)
})

test("BF-01: vector results and parents stay hidden with an empty active set", async (t) => {
  const f = fixture(t)
  const removed = await f.ingest("removed")
  const options = { channels: ["vector"] as const, accessContext: f.access, retrievalScope: f.scope }
  const before = await f.searcher.search(f.query, { ...options, channels: [...options.channels] })
  assert.deepEqual(before.results.map(({ chunk }) => chunk.documentId), [removed.id])
  assert.equal(before.results[0].parentChunk?.documentId, removed.id)
  f.retire(removed.sourceId)
  const after = await f.searcher.search(f.query, { ...options, channels: [...options.channels] })
  assert.deepEqual(after.results, [])
  assert.deepEqual(f.active.getActiveDocIds(), [])
  assert.deepEqual(f.pageIndex.searchNodes(f.query.text, 5, { restrictToActiveDocumentVersions: true }), [])
  assert.equal(f.indexed.size, 2, "both the child and parent are still indexed")
  assert.ok(f.requests.some((request) => request.knn), "the real vector channel queried the controlled index")
  assert.equal(f.cleanupCalls, 0)
  assert.equal(f.networkAttempts, 0)
})

test("BF-01: delayed and failed cleanup cannot restore BM25, vector or PageIndex visibility", async (t) => {
  const f = fixture(t)
  const removed = await f.ingest("removed")
  const kept = await f.ingest("kept")
  const retainedChunks = f.indexed.size
  f.retire(removed.sourceId)
  // The first pass leaves all cleanup pending. Each subsequent pass runs one
  // real cleanup task, which fails at the external index boundary and retries.
  for (let attempt = 0; attempt <= 4; attempt++) {
    if (attempt > 0) {
      const cleanup = await f.lifecycle.runNext()
      assert.equal(cleanup?.success, false)
      assert.match(cleanup!.error!, /controlled cleanup failure/)
    }
    for (const channel of ["bm25", "vector", "pageIndex"] as const) {
      const result = await f.searcher.search(f.query, {
        channels: [channel], accessContext: f.access, retrievalScope: f.scope,
      })
      assert.equal(result.status, "ok", `${channel}, cleanup attempt ${attempt}`)
      assert.deepEqual(result.results.map(({ chunk }) => chunk.documentId), [kept.id])
      assert.equal(result.results[0].parentChunk?.documentId, kept.id)
      assert.doesNotMatch(JSON.stringify(result.results), /removed/)
    }
    assert.deepEqual(f.pageIndex.searchNodes(f.query.text, 5, {
      restrictToActiveDocumentVersions: true,
    }).map((node) => node.documentId), [kept.id])
    assert.equal(f.indexed.size, retainedChunks)
    assert.equal(f.pageIndex.getNodesByDocument(removed.id).length, 1)
  }
  assert.equal(f.cleanupCalls, 4)
  assert.equal(f.tasks.getByDocId(removed.id)?.failCount, 1)
  assert.equal(f.tasks.getByDocId(removed.id)?.status, "pending")
  assert.equal(f.networkAttempts, 0)
})

test("BF-01: lifecycle filtering preserves version, tenant, group and knowledge-base exclusions", async (t) => {
  const f = fixture(t)
  const old = await f.ingest("versioned")
  const kept = await f.ingest("versioned", {
    content: "RETIREMENT_POLICY latest: only the current policy should be used.", versionIntent: "new_version",
  })
  assert.equal(old.sourceId, kept.sourceId)
  const removed = await f.ingest("removed")
  const otherTenant = await f.ingest("other-tenant", {
    sourceIdentity: { kind: "url", uriOrExternalId: "https://example.invalid/other-tenant", tenantId: "other" },
    knowledgeBaseId: f.scope.knowledgeBaseIds[0],
  })
  const otherGroup = await f.ingest("other-group", {
    sourceIdentity: { kind: "url", uriOrExternalId: "https://example.invalid/other-group", allowedGroups: ["finance"] },
  })
  const otherBase = await f.ingest("other-base", { knowledgeBaseId: "kb-other" })
  const quarantined = await f.ingest("quarantined")
  new SqliteSourceLifecycleStore(f.db).transition(quarantined.sourceId, "default", "quarantined")
  // Partial candidate artifacts can already exist in the index before activation.
  // Build them through the same public chunker/PageIndex builder as ingestion.
  const candidate = f.lifecycle.submit({
    title: "RETIREMENT_POLICY candidate", source: "https://example.invalid/candidate",
    content: "RETIREMENT_POLICY candidate: incomplete import must stay hidden.",
  })
  const candidateDoc = f.documents.get(candidate.docId)!
  const chunks = await new RecursiveChunker().chunk(candidateDoc)
  const metadata: ChunkAccessMetadata = {
    tenantId: "default", allowedGroups: [], knowledgeBaseId: f.scope.knowledgeBaseIds[0],
  }
  await f.store.storeChunks(chunks, metadata)
  f.pageIndex.replaceNodes(candidate.docId, buildPageIndex(candidateDoc, chunks), metadata)
  f.retire(removed.sourceId)

  for (const document of [old, removed, otherTenant, otherGroup, otherBase, quarantined, candidateDoc]) {
    assert.ok([...f.indexed.values()].some((chunk) => chunk.documentId === document.id), "excluded data is physically present")
  }
  for (const channel of ["bm25", "vector", "pageIndex"] as const) {
    const result = await f.searcher.search(f.query, {
      channels: [channel], accessContext: f.access, retrievalScope: f.scope,
    })
    assert.equal(result.status, "ok")
    assert.deepEqual(result.results.map(({ chunk }) => chunk.documentId), [kept.id])
    assert.equal(result.results[0].parentChunk?.documentId, kept.id)
    assert.match(result.results[0].parentChunk!.content, /latest/)
  }
  assert.deepEqual(f.pageIndex.searchNodes(f.query.text, 5, {
    tenantId: f.access.tenantId, callerGroups: f.access.groups, knowledgeBaseIds: f.scope.knowledgeBaseIds,
    restrictToActiveDocumentVersions: true,
  }).map((node) => node.documentId), [kept.id])
  assert.deepEqual(new Set(f.active.getActiveDocIds()), new Set([kept.id, otherTenant.id, otherGroup.id, otherBase.id]))
  assert.equal(f.cleanupCalls, 0)
  assert.equal(f.networkAttempts, 0)
})
