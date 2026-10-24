/**
 * Ticket 09 (KB-05A) — integration acceptance: storage and retrieval
 * isolation across two knowledge bases.
 *
 * Two knowledge bases of the SAME tenant hold same-name, contradicting
 * documents (both titled 退货政策; one says 7 days, the other 30 days), and a
 * graph entity shared by both carries one relation supported only by each
 * side. The acceptance runs the REAL retrieval stack — RuntimeSearchOperations
 * (all four channels), SearcherImpl (fusion, parent expansion), the real
 * PageIndexRepository over SQLite, the real KnowledgeBaseServiceImpl over
 * SQLite and the real citation layer (buildEvidence + referencesForReply) —
 * against an in-memory Elasticsearch substitute and a scripted Neo4j session.
 * The substitutes implement exactly the query shapes the production code
 * emits (term/terms/match/multi_match/bool/exists, knn with filter) and fail
 * loudly on anything else, so every filter clause is built and evaluated by
 * the code under test, not by the fake.
 *
 * Criteria → tests:
 *   1. Same-name contradictory documents return only their own results and
 *      citations in every retrieval channel          → "every retrieval channel…"
 *   2. Shared graph entities never expose relations
 *      supported only by another knowledge base      → "shared graph entity…"
 *   3. Parent chunks, corrective retrieval, caches and
 *      citation lookup retain the same scope         → "parents, corrective…"
 *   4. Archived, unknown and unauthorized knowledge
 *      bases cannot join new retrieval               → "archived, unknown…"
 *
 * Caches have no separate scenario because the application layer holds no
 * knowledge-content cache (only the identity JWKS cache exists — greppable),
 * and the ES request cache is keyed by the full request body, whose scope
 * clause makes cross-scope hits impossible. Test 4's restored-base round trip
 * doubles as the behavioral proof: the same searcher instance serves both
 * scopes correctly, so no cross-scope memoization can hide between runs.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import type { Client } from "@elastic/elasticsearch"
import type OpenAI from "openai"
import type { Driver } from "neo4j-driver"
import { openDb, type DB } from "../ingestion/tracking/db"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import {
  KnowledgeBaseArchivedError,
  KnowledgeBaseNotFoundError,
  KnowledgeBaseServiceImpl,
} from "../knowledge/knowledge_base_service"
import { ActiveVersionRepository } from "../ingestion/tracking/active_version_repo"
import {
  PageIndexRepository,
  type PageIndexNodeEligibility,
} from "../ingestion/tracking/page_index_repo"
import type { AccessContext } from "../access/context"
import type { Chunk, Query, RetrievalResult } from "../types"
import type { RetrievalScope } from "../types/retrieval_scope"
import { RuntimeSearchOperations, SearcherImpl } from "./search/searcher"
import type {
  RetrievalChannel,
  SearchOptions,
  SearchOutcome,
  Searcher,
} from "./search/interface"
import { runComplexLoop } from "./complex_loop"
import type {
  ComplexLoopAssembler,
  ComplexLoopController,
  ComplexLoopDecision,
} from "./complex_loop"
import { buildEvidence, referencesForReply } from "../answer/evidence"
import { ToolInvocationService, ToolRegistry } from "../tools/invocation"
import { registerBuiltinTools } from "../tools/knowledge_tools"

// ---------------------------------------------------------------------------
// In-memory Elasticsearch substitute: seeded documents + a clause evaluator
// for the exact query shapes RuntimeSearchOperations emits.
// ---------------------------------------------------------------------------

type EsDoc = Record<string, unknown>

function embedText(text: string): number[] {
  const digest = createHash("sha256").update(text, "utf8").digest()
  return [digest[0] / 255, digest[1] / 255, digest[2] / 255]
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1)
}

function evalClause(doc: EsDoc, clause: unknown): boolean {
  if (!clause || typeof clause !== "object") {
    throw new Error("acceptance fake: missing or malformed ES clause")
  }
  const node = clause as Record<string, unknown>
  if ("term" in node) {
    const [field, value] = Object.entries(node.term as EsDoc)[0]
    return doc[field] === value
  }
  if ("terms" in node) {
    const [field, values] = Object.entries(node.terms as EsDoc)[0] as [string, unknown[]]
    const actual = doc[field]
    if (Array.isArray(actual)) return values.some((value) => actual.includes(value))
    return values.includes(actual)
  }
  if ("match" in node) {
    const [field, text] = Object.entries(node.match as EsDoc)[0] as [string, string]
    const content = String(doc[field] ?? "").toLowerCase()
    return String(text)
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .some((token) => content.includes(token))
  }
  if ("multi_match" in node) {
    const mm = node.multi_match as { query: string; fields: string[] }
    const tokens = mm.query.toLowerCase().split(/\s+/).filter(Boolean)
    return mm.fields.some((rawField) => {
      const field = rawField.replace(/\^.*$/, "")
      const content = String(doc[field] ?? "").toLowerCase()
      return tokens.some((token) => content.includes(token))
    })
  }
  if ("exists" in node) {
    const field = (node.exists as { field: string }).field
    const value = doc[field]
    return value !== undefined && value !== null
  }
  if ("bool" in node) {
    const bool = node.bool as {
      must?: unknown[]
      should?: unknown[]
      filter?: unknown[]
      must_not?: unknown[]
      minimum_should_match?: number
    }
    if (bool.must && !bool.must.every((inner) => evalClause(doc, inner))) return false
    if (bool.filter && !bool.filter.every((inner) => evalClause(doc, inner))) return false
    if (bool.must_not && bool.must_not.some((inner) => evalClause(doc, inner))) {
      return false
    }
    if (bool.should) {
      // ES semantics: `should` is optional when must/filter clauses are
      // present, required otherwise. Production code sets
      // minimum_should_match explicitly whenever it combines them; the
      // default here mirrors the server instead of being stricter.
      const needed =
        bool.minimum_should_match ?? (bool.must || bool.filter ? 0 : 1)
      if (needed === 0) return true
      const matched = bool.should.filter((inner) => evalClause(doc, inner)).length
      if (matched < needed) return false
    }
    return true
  }
  throw new Error(
    `acceptance fake: unsupported ES clause ${JSON.stringify(node).slice(0, 160)}`
  )
}

class InMemoryEs {
  private readonly docs: EsDoc[] = []

  seed(...docs: EsDoc[]): void {
    this.docs.push(...docs)
  }

  client(): Client {
    const cluster = this
    return {
      async search(request: {
        knn?: { query_vector: number[]; k: number; filter?: unknown }
        query?: unknown
        size?: number
      }) {
        let selected: Array<{ doc: EsDoc; score: number }>
        if (request.knn) {
          const candidates = cluster.docs.filter((doc) =>
            request.knn!.filter ? evalClause(doc, request.knn!.filter) : true
          )
          selected = candidates
            .map((doc) => ({
              doc,
              score: cosine(
                request.knn!.query_vector,
                (doc.embedding as number[]) ?? [0, 0, 0]
              ),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, request.knn.k)
        } else {
          if (!request.query) {
            throw new Error("acceptance fake: search without knn must carry a query")
          }
          selected = cluster.docs
            .filter((doc) => evalClause(doc, request.query))
            .map((doc) => ({ doc, score: 1 }))
        }
        const size = request.size ?? 10
        return {
          hits: {
            hits: selected.slice(0, size).map(({ doc, score }) => ({
              _id: String(doc.id ?? ""),
              _score: score,
              _source: doc,
            })),
          },
        }
      },
    } as unknown as Client
  }
}

/**
 * Scripted Neo4j session: the entity-matching Cypher is the server's job, so
 * the fake always answers with the shared entity's names and its relation
 * groups. Each relation carries its own 6-element provenance tuples
 * ([documentId, chunkId, tenantId, allowedGroups, weight, knowledgeBaseId] —
 * the exact shape src/ingestion/storage/store.ts writes), so the production
 * provenance parser and its knowledge-scope filter are what is under test.
 */
function fakeGraphDriver(
  names: string[],
  relationGroups: Array<{ values: string[]; weight: number; provenance: string[] }>
): Driver {
  const makeSession = () => ({
    run: async () => ({
      records: [
        {
          get: (key: string) =>
            key === "names"
              ? [...names]
              : relationGroups.map((group) => ({
                  values: [...group.values],
                  weight: group.weight,
                  provenance: [...group.provenance],
                })),
        },
      ],
    }),
    close: async () => {},
  })
  return { session: makeSession } as unknown as Driver
}

function fakeEmbeddingClient(): OpenAI {
  return {
    embeddings: {
      create: async ({ input }: { input: string | string[] }) => {
        const inputs = Array.isArray(input) ? input : [input]
        return { data: inputs.map((text) => ({ embedding: embedText(text) })) }
      },
    },
  } as unknown as OpenAI
}

// ---------------------------------------------------------------------------
// The two-knowledge-base fixture: same-name contradictory documents, a shared
// graph entity, PageIndex nodes and a chunk-id collision across the KBs.
// ---------------------------------------------------------------------------

const TENANT = "demo"
const EMBEDDING_PROFILE = "text-embedding-3-small:1536"
const DOC_A = "doc-technical-refund"
const DOC_B = "doc-policy-refund"
const DOC_A2 = "doc-technical-detail"
const CHUNK_A = "chunk-refund-a"
const CHUNK_B = "chunk-refund-b"
const CHUNK_A2 = "chunk-detail-a2"
/** Deliberate chunk-id collision: both KBs use the same parent chunk id. */
const PARENT_ID = "parent-refund"
const SHARED_ENTITY = "Acme"

interface Stack {
  db: DB
  kbService: KnowledgeBaseServiceImpl
  kbA: { id: string }
  kbB: { id: string }
  operations: RuntimeSearchOperations
  searcher: SearcherImpl
}

function chunkDoc(params: {
  id: string
  documentId: string
  kind: "child" | "parent"
  content: string
  knowledgeBaseId: string
  allowedGroups?: string[]
  parentId?: string
}): EsDoc {
  return {
    id: params.id,
    documentId: params.documentId,
    kind: params.kind,
    content: params.content,
    knowledgeBaseId: params.knowledgeBaseId,
    tenantId: TENANT,
    ...(params.allowedGroups ? { allowedGroups: params.allowedGroups } : {}),
    ...(params.parentId ? { parentId: params.parentId } : {}),
    childrenIds: [],
    metadata: { title: "退货政策", source: "import", kind: params.kind },
    embedding: embedText(params.content),
  }
}

function setup(): Stack {
  const db = openDb(":memory:")
  const kbService = new KnowledgeBaseServiceImpl(
    new SqliteKnowledgeBaseRepo(db),
    EMBEDDING_PROFILE
  )
  kbService.ensureDefault(TENANT)
  const kbA = kbService.create(TENANT, "Technical KB")
  const kbB = kbService.create(TENANT, "Policy KB")

  const es = new InMemoryEs()
  es.seed(
    // KB-A: the 7-day contradiction, tenant-wide inside the KB.
    chunkDoc({
      id: CHUNK_A,
      documentId: DOC_A,
      kind: "child",
      content: "退货政策：Acme 产品在购买后 7 天内可全额退货。",
      knowledgeBaseId: kbA.id,
      parentId: PARENT_ID,
    }),
    chunkDoc({
      id: PARENT_ID,
      documentId: DOC_A,
      kind: "parent",
      content: "完整技术口径：7 天退货窗口，来自技术知识库。",
      knowledgeBaseId: kbA.id,
    }),
    // KB-B: the contradicting 30-day document, SAME title, SAME parent id.
    chunkDoc({
      id: CHUNK_B,
      documentId: DOC_B,
      kind: "child",
      content: "退货政策：Acme 产品在购买后 30 天内才可退货。",
      knowledgeBaseId: kbB.id,
      parentId: PARENT_ID,
    }),
    chunkDoc({
      id: PARENT_ID,
      documentId: DOC_B,
      kind: "parent",
      content: "完整政策口径：30 天退货窗口，来自政策知识库。",
      knowledgeBaseId: kbB.id,
    }),
    // KB-A second document, restricted to the technical group.
    chunkDoc({
      id: CHUNK_A2,
      documentId: DOC_A2,
      kind: "child",
      content: "退货政策技术细则：退货必须提供订单号。",
      knowledgeBaseId: kbA.id,
      allowedGroups: ["technical"],
    })
  )

  // PageIndex rows exactly as ingestion stamps them (owner + access metadata).
  const pageIndex = new PageIndexRepository(db)
  pageIndex.replaceNodes(
    DOC_A,
    [
      {
        documentId: DOC_A,
        nodeId: "node-a",
        title: "退货政策",
        sectionPath: [],
        pageStart: null,
        pageEnd: null,
        summary: "7 天退货窗口",
        parentId: null,
        childIds: [],
        linkedChunkIds: [CHUNK_A],
      },
    ],
    { tenantId: TENANT, allowedGroups: [], knowledgeBaseId: kbA.id }
  )
  pageIndex.replaceNodes(
    DOC_B,
    [
      {
        documentId: DOC_B,
        nodeId: "node-b",
        title: "退货政策",
        sectionPath: [],
        pageStart: null,
        pageEnd: null,
        summary: "30 天退货窗口",
        parentId: null,
        childIds: [],
        linkedChunkIds: [CHUNK_B],
      },
    ],
    { tenantId: TENANT, allowedGroups: [], knowledgeBaseId: kbB.id }
  )
  pageIndex.replaceNodes(
    DOC_A2,
    [
      {
        documentId: DOC_A2,
        nodeId: "node-a2",
        title: "退货政策技术细则",
        sectionPath: [],
        pageStart: null,
        pageEnd: null,
        summary: "退货必须提供订单号",
        parentId: null,
        childIds: [],
        linkedChunkIds: [CHUNK_A2],
      },
    ],
    { tenantId: TENANT, allowedGroups: ["technical"], knowledgeBaseId: kbA.id }
  )

  // One graph entity shared by BOTH KBs; each KB supports exactly one relation.
  const graphDriver = fakeGraphDriver([SHARED_ENTITY], [
    {
      values: ["acme-refund->customer-service:SEVEN_DAY_WINDOW"],
      weight: 0.9,
      provenance: [
        JSON.stringify([DOC_A, CHUNK_A, TENANT, [], 0.9, kbA.id]),
      ],
    },
    {
      values: ["acme-refund->customer-service:THIRTY_DAY_WINDOW"],
      weight: 0.7,
      provenance: [
        JSON.stringify([DOC_B, CHUNK_B, TENANT, [], 0.7, kbB.id]),
      ],
    },
  ])

  const operations = new RuntimeSearchOperations({
    es: es.client(),
    embeddingClient: fakeEmbeddingClient(),
    embeddingModel: "embedding-test",
    graphDriver,
    pageIndexRepo: pageIndex,
  })
  return {
    db,
    kbService,
    kbA,
    kbB,
    operations,
    searcher: new SearcherImpl(operations),
  }
}

function accessContext(groups: string[]): AccessContext {
  return {
    tenantId: TENANT,
    subjectId: `user-${groups.join("-") || "wide"}`,
    groups,
    scopes: ["chat"],
  }
}

function knowledgeBaseIdOf(chunk: Chunk): string {
  return (chunk as unknown as { knowledgeBaseId?: string }).knowledgeBaseId ?? ""
}

async function search(
  stack: Stack,
  text: string,
  kbIds: readonly string[],
  groups: string[] = [],
  channels?: RetrievalChannel[]
): Promise<SearchOutcome> {
  const options: SearchOptions = {
    accessContext: accessContext(groups),
    retrievalScope: { knowledgeBaseIds: kbIds },
    ...(channels ? { channels } : {}),
  }
  return stack.searcher.search({ text }, options)
}

function documentIds(outcome: SearchOutcome): string[] {
  return [...new Set(outcome.results.map(({ chunk }) => chunk.documentId))]
}

// ---------------------------------------------------------------------------
// Criterion 1 — every retrieval channel returns only its own KB's results.
// ---------------------------------------------------------------------------

test("every retrieval channel returns only the selected KB's same-name document", async () => {
  const stack = setup()
  try {
    for (const channel of ["vector", "bm25", "graph", "pageIndex"] as const) {
      const own = await search(stack, "退货政策", [stack.kbA.id], [], [channel])
      assert.ok(own.results.length > 0, `scope A must find its document via ${channel}`)
      for (const result of own.results) {
        assert.equal(knowledgeBaseIdOf(result.chunk), stack.kbA.id, channel)
        assert.ok(
          [DOC_A, DOC_A2].includes(result.chunk.documentId),
          `${channel} leaked a foreign document: ${result.chunk.documentId}`
        )
        assert.equal(result.chunk.metadata.title, "退货政策")
      }
      const ownText = own.results.map(({ chunk }) => chunk.content).join("\n")
      assert.ok(ownText.includes("7 天"), channel)
      assert.ok(!ownText.includes("30 天"), `${channel} leaked the other KB's answer`)
      // Citations derive from this channel's evidence set — KB-local too.
      const ownCitations = buildEvidence(own.results)
      assert.ok(ownCitations.length > 0, channel)
      for (const evidence of ownCitations) {
        assert.ok(
          [DOC_A, DOC_A2].includes(evidence.documentId),
          `${channel} citation leaked ${evidence.documentId}`
        )
      }

      const foreign = await search(stack, "退货政策", [stack.kbB.id], [], [channel])
      assert.ok(foreign.results.length > 0, `scope B must find its document via ${channel}`)
      for (const result of foreign.results) {
        assert.equal(knowledgeBaseIdOf(result.chunk), stack.kbB.id, channel)
        assert.deepEqual(documentIds(foreign), [DOC_B])
      }
      const foreignText = foreign.results.map(({ chunk }) => chunk.content).join("\n")
      assert.ok(foreignText.includes("30 天"), channel)
      assert.ok(!foreignText.includes("7 天"), `${channel} leaked the other KB's answer`)
    }

    // Citations are built from the same retrieval results and are KB-local:
    // the same-name documents are independent identities across KBs, so a
    // citation resolved under one scope can never be the other KB's evidence.
    const runA = await search(stack, "退货政策", [stack.kbA.id])
    const runB = await search(stack, "退货政策", [stack.kbB.id])
    const evidenceA = buildEvidence(runA.results)
    const evidenceB = buildEvidence(runB.results)
    const idA = evidenceA[0].id
    const idB = evidenceB[0].id
    assert.notEqual(idA, idB)
    for (const evidence of evidenceA) {
      assert.ok(
        [DOC_A, DOC_A2].includes(evidence.documentId),
        `evidence A leaked ${evidence.documentId}`
      )
    }
    const references = referencesForReply(`技术口径为 7 天 [cite:${idA}]`, evidenceA)
    assert.equal(references[0].documentId, DOC_A)
  } finally {
    stack.db.close()
  }
})

// ---------------------------------------------------------------------------
// Criterion 2 — the shared graph entity never exposes the other KB's relations.
// ---------------------------------------------------------------------------

test("shared graph entity exposes only the selected KB's relations and provenance", async () => {
  const stack = setup()
  try {
    const own = await search(stack, "Acme 退货政策", [stack.kbA.id], [], ["graph"])
    assert.ok(own.results.length > 0)
    const ownLinks = own.results.flatMap(({ wikilinks }) => wikilinks)
    assert.ok(ownLinks.length > 0)
    for (const link of ownLinks) {
      assert.equal(link.relation, "SEVEN_DAY_WINDOW")
      assert.ok(
        (link.provenance ?? []).every(
          ({ documentId }) => documentId === DOC_A
        ),
        "scope A saw a relation supported only by KB-B"
      )
    }
    assert.ok(
      !own.results.some(({ chunk }) => chunk.documentId === DOC_B),
      "scope A hydrated a KB-B chunk through the shared entity"
    )

    const foreign = await search(stack, "Acme 退货政策", [stack.kbB.id], [], ["graph"])
    assert.ok(foreign.results.length > 0)
    const foreignLinks = foreign.results.flatMap(({ wikilinks }) => wikilinks)
    assert.ok(foreignLinks.length > 0)
    for (const link of foreignLinks) {
      assert.equal(link.relation, "THIRTY_DAY_WINDOW")
      assert.ok(
        (link.provenance ?? []).every(
          ({ documentId }) => documentId === DOC_B
        ),
        "scope B saw a relation supported only by KB-A"
      )
    }
    assert.deepEqual(documentIds(foreign), [DOC_B])
  } finally {
    stack.db.close()
  }
})

// ---------------------------------------------------------------------------
// Group boundaries inside one knowledge scope (same tenant, KB-A).
// ---------------------------------------------------------------------------

test("group boundaries hold inside a knowledge scope for ES and PageIndex reads", async () => {
  const stack = setup()
  try {
    // The policy caller is group-restricted and must never see KB-A's
    // technical-only document — not through ES channels nor PageIndex rows.
    const policyVector = await search(
      stack,
      "退货政策",
      [stack.kbA.id],
      ["policy"],
      ["vector"]
    )
    assert.deepEqual(documentIds(policyVector), [DOC_A])

    const policyIndex = await search(
      stack,
      "退货政策",
      [stack.kbA.id],
      ["policy"],
      ["pageIndex"]
    )
    assert.deepEqual(documentIds(policyIndex), [DOC_A])

    // The technical caller sees both KB-A documents through the same scope.
    const technicalVector = await search(
      stack,
      "退货政策",
      [stack.kbA.id],
      ["technical"],
      ["vector"]
    )
    assert.deepEqual(
      [...documentIds(technicalVector)].sort(),
      [DOC_A, DOC_A2].sort()
    )
    const technicalIndex = await search(
      stack,
      "退货政策",
      [stack.kbA.id],
      ["technical"],
      ["pageIndex"]
    )
    assert.deepEqual(
      [...documentIds(technicalIndex)].sort(),
      [DOC_A, DOC_A2].sort()
    )
  } finally {
    stack.db.close()
  }
})

// ---------------------------------------------------------------------------
// Criterion 3 — parents, corrective retrieval and citation lookup keep scope.
// ---------------------------------------------------------------------------

test("parent loading rechecks the scope and never returns another KB's parent", async () => {
  const stack = setup()
  try {
    // Both KBs' parents are named by identity (same chunk id, colliding) —
    // only the in-scope row may come back.
    const own = await stack.operations.loadParents(
      [
        { documentId: DOC_A, id: PARENT_ID },
        { documentId: DOC_B, id: PARENT_ID },
      ],
      accessContext([]),
      { knowledgeBaseIds: [stack.kbA.id] }
    )
    assert.deepEqual(
      own.map(({ documentId }) => documentId),
      [DOC_A]
    )
    const foreign = await stack.operations.loadParents(
      [
        { documentId: DOC_A, id: PARENT_ID },
        { documentId: DOC_B, id: PARENT_ID },
      ],
      accessContext([]),
      { knowledgeBaseIds: [stack.kbB.id] }
    )
    assert.deepEqual(
      foreign.map(({ documentId }) => documentId),
      [DOC_B]
    )

    // Through the full search: the attached parent is the selected KB's copy
    // of the same-name document, never the other KB's contradicting one.
    const ownRun = await search(stack, "退货政策", [stack.kbA.id])
    for (const result of ownRun.results) {
      if (result.parentChunk) {
        assert.equal(result.parentChunk.documentId, DOC_A)
        assert.ok(result.parentChunk.content.includes("7 天"))
        assert.ok(!result.parentChunk.content.includes("30 天"))
      }
    }
  } finally {
    stack.db.close()
  }
})

test("corrective retrieval reuses the locked scope reference for every gap query", async () => {
  const stack = setup()
  try {
    const searches: Array<{ text: string; scope?: RetrievalScope }> = []
    const recording: Searcher = {
      async search(query: Query, options?: SearchOptions) {
        searches.push({ text: query.text, scope: options?.retrievalScope })
        return stack.searcher.search(query, options)
      },
    }
    const scope: RetrievalScope = { knowledgeBaseIds: [stack.kbA.id] }
    const decisions: ComplexLoopDecision[] = [
      {
        sufficient: false,
        tool: "semantic_lexical_hybrid",
        args: { query: "退货窗口 具体天数" },
      },
      { sufficient: true },
    ]
    const controller: ComplexLoopController = {
      decide: async () => decisions.shift() as ComplexLoopDecision,
    }
    const assembler: ComplexLoopAssembler = { assemble: async () => "观察上下文" }

    const result = await runComplexLoop(
      { controller, searcher: recording, assembler },
      { query: "退货政策", accessContext: accessContext([]), retrievalScope: scope }
    )

    assert.equal(result.stopReason, "evidence-sufficient")
    assert.equal(searches.length, 1, "the corrective gap query must run exactly once")
    assert.equal(searches[0].text, "退货窗口 具体天数")
    // The corrective round must reuse the SAME scope object — not a recomputed
    // or widened copy (ticket 07 pinned this with reference identity).
    assert.ok(searches[0].scope, "the gap query must carry the retrieval scope")
    assert.equal(searches[0].scope, scope)
    assert.deepEqual([...searches[0].scope!.knowledgeBaseIds], [stack.kbA.id])
    assert.ok(result.results.length > 0)
    for (const { chunk } of result.results) {
      assert.ok(
        [DOC_A, DOC_A2].includes(chunk.documentId),
        `corrective retrieval leaked ${chunk.documentId}`
      )
    }
  } finally {
    stack.db.close()
  }
})

test("citation lookup fails closed for another KB's evidence id", async () => {
  const stack = setup()
  try {
    const runA = await search(stack, "退货政策", [stack.kbA.id])
    const runB = await search(stack, "退货政策", [stack.kbB.id])
    const evidenceA = buildEvidence(runA.results)
    const evidenceB = buildEvidence(runB.results)
    assert.ok(evidenceA.length > 0)
    assert.ok(evidenceB.length > 0)
    // The positive path holds for both scopes: each KB resolves its own
    // same-name document's citation to its own evidence.
    const ownA = referencesForReply(`技术口径 [cite:${evidenceA[0].id}]`, evidenceA)
    assert.equal(ownA[0].documentId, DOC_A)
    const ownB = referencesForReply(`政策口径 [cite:${evidenceB[0].id}]`, evidenceB)
    assert.equal(ownB[0].documentId, DOC_B)
    for (const evidence of evidenceB) {
      assert.throws(
        () =>
          referencesForReply(
            `政策口径为 30 天 [cite:${evidence.id}]`,
            evidenceA
          ),
        /unknown citation/,
        "an out-of-scope citation id must throw, never resolve"
      )
    }
  } finally {
    stack.db.close()
  }
})

// ---------------------------------------------------------------------------
// Criterion 4 — archived, unknown and unauthorized knowledge bases cannot
// join new retrieval.
// ---------------------------------------------------------------------------

test("archived, unknown and unauthorized knowledge bases never join new retrieval", async () => {
  const stack = setup()
  try {
    // Archived: selection fails loudly (409) instead of silently narrowing.
    assert.equal(stack.kbService.archive(stack.kbB.id, TENANT)?.status, "archived")
    assert.throws(
      () => stack.kbService.resolveScope(TENANT, [stack.kbB.id]),
      KnowledgeBaseArchivedError
    )

    // Restore makes the base selectable again — and the same searcher
    // instance (no cross-scope cache) serves its content correctly.
    assert.equal(stack.kbService.activate(stack.kbB.id, TENANT)?.status, "active")
    const restoredScope = stack.kbService.resolveScope(TENANT, [stack.kbB.id])
    const restored = await search(
      stack,
      "退货政策",
      restoredScope.knowledgeBaseIds
    )
    assert.deepEqual(documentIds(restored), [DOC_B])

    // Unknown id → 404-shaped error, never a silent widening.
    assert.throws(
      () => stack.kbService.resolveScope(TENANT, ["kb-does-not-exist"]),
      KnowledgeBaseNotFoundError
    )

    // Cross-tenant id: the same indistinguishable 404 — one tenant can never
    // probe or select another tenant's knowledge base.
    stack.kbService.ensureDefault("tenant-2")
    assert.throws(
      () => stack.kbService.resolveScope("tenant-2", [stack.kbA.id]),
      KnowledgeBaseNotFoundError
    )

    // And a scope the server DID resolve stays exact: KB-A never returns
    // KB-B's same-name document through any of this.
    const scoped = await search(stack, "退货政策", [stack.kbA.id])
    assert.ok(!documentIds(scoped).includes(DOC_B))
  } finally {
    stack.db.close()
  }
})

// ---------------------------------------------------------------------------
// Ticket PT-10 (audit finding F1) — the PageIndex node quota is spent on
// ELIGIBLE nodes only.
//
// `.scratch/pipeline-structure-audit-2026-10-08/reproduce.cjs` case
// `F1_pageindex_scope_after_limit` used the defect as its own evidence: one
// stored target hit, then five higher-sorted foreign nodes, then zero hits for
// the run. These tests reuse that fixture shape — real SQLite, real
// PageIndexRepository, real RuntimeSearchOperations, and the in-memory
// Elasticsearch substitute that evaluates every emitted clause — and invert the
// assertion: the target keeps its hit, the ceiling stays five, and a passage is
// still only ever Evidence after hydration re-authorizes it.
// ---------------------------------------------------------------------------

const PT10_TENANT = "pt10-tenant"
const PT10_OTHER_TENANT = "pt10-other-tenant"
const PT10_QUERY = "退款规则"
const PT10_TARGET_DOC = "z-target-refund"
const PT10_TARGET_CHUNK = `chunk-${PT10_TARGET_DOC}`

interface Pt10NodeSpec {
  documentId: string
  knowledgeBaseId: string
  tenantId?: string
  allowedGroups?: string[]
  /** Stamp a source whose active pointer is this document. */
  active?: boolean
  /** Write the row with no knowledge-base tag at all (the pre-KB-02A shape). */
  untagged?: boolean
  /** Index the linked chunk in Elasticsearch too (default: yes). */
  indexed?: boolean
}

interface Pt10Stack {
  db: DB
  targetKb: { id: string }
  foreignKb: { id: string }
  /** The chunk index the hydration re-check reads. */
  es: InMemoryEs
  pageIndex: PageIndexRepository
  operations: RuntimeSearchOperations
  searcher: SearcherImpl
  /** Every bounded node read, with the eligibility the channel asked for. */
  nodeCalls: Array<{ query: string; limit: number; eligibility?: PageIndexNodeEligibility }>
  /** Every Elasticsearch request the channel issued. */
  esRequests: Array<Record<string, unknown>>
}

function pt10Stack(
  options: {
    activeVersionRepository?: boolean
    /**
     * PT-10 AC06: retire every active version at the moment the hydration
     * filter reads the active set — i.e. AFTER the bounded node selection has
     * already run. That is the race the hydration re-check exists to close.
     */
    retireActiveVersionsOnHydrationRead?: boolean
  } = {}
): Pt10Stack {
  const db = openDb(":memory:")
  const kbService = new KnowledgeBaseServiceImpl(
    new SqliteKnowledgeBaseRepo(db),
    EMBEDDING_PROFILE
  )
  kbService.ensureDefault(PT10_TENANT)
  const targetKb = kbService.create(PT10_TENANT, "目标库")
  const foreignKb = kbService.create(PT10_TENANT, "他库")

  const es = new InMemoryEs()
  const esClient = es.client()
  const esRequests: Array<Record<string, unknown>> = []
  const countedEs = {
    async search(request: Record<string, unknown>) {
      esRequests.push(request)
      return esClient.search(request as never)
    },
  } as unknown as Client

  const pageIndex = new PageIndexRepository(db)
  const nodeCalls: Pt10Stack["nodeCalls"] = []
  const recordedPageIndex = {
    searchNodes: (query: string, limit: number, eligibility?: PageIndexNodeEligibility) => {
      nodeCalls.push({ query, limit, eligibility })
      return pageIndex.searchNodes(query, limit, eligibility)
    },
  } as unknown as PageIndexRepository

  let activeVersionRepo: ActiveVersionRepository | undefined
  if (options.activeVersionRepository) {
    const real = new ActiveVersionRepository(db)
    activeVersionRepo = options.retireActiveVersionsOnHydrationRead
      ? ({
          getActiveDocIds: () => {
            // A concurrent retirement landing between selection and hydration.
            db.prepare("UPDATE sources SET active_doc_id = NULL").run()
            return real.getActiveDocIds()
          },
        } as unknown as ActiveVersionRepository)
      : real
  }

  const operations = new RuntimeSearchOperations({
    es: countedEs,
    embeddingClient: fakeEmbeddingClient(),
    embeddingModel: "embedding-test",
    pageIndexRepo: recordedPageIndex,
    ...(activeVersionRepo ? { activeVersionRepo } : {}),
  })
  return {
    db,
    targetKb,
    foreignKb,
    es,
    pageIndex,
    operations,
    searcher: new SearcherImpl(operations),
    nodeCalls,
    esRequests,
  }
}

/** Seed one document's PageIndex node, its indexed chunk, and — when asked —
 *  the source row that makes it the active version. */
function pt10Seed(stack: Pt10Stack, spec: Pt10NodeSpec): void {
  const chunkId = `chunk-${spec.documentId}`
  const tenantId = spec.tenantId ?? PT10_TENANT
  stack.pageIndex.replaceNodes(
    spec.documentId,
    [
      {
        documentId: spec.documentId,
        nodeId: "node-1",
        title: `${PT10_QUERY}（${spec.documentId}）`,
        sectionPath: [PT10_QUERY],
        pageStart: 1,
        pageEnd: 1,
        summary: "退款条件与例外",
        parentId: null,
        childIds: [],
        linkedChunkIds: [chunkId],
      },
    ],
    {
      tenantId,
      allowedGroups: spec.allowedGroups ?? [],
      knowledgeBaseId: spec.knowledgeBaseId,
    }
  )
  if (spec.untagged) {
    // replaceNodes never writes an empty owner, so the legacy untagged row is
    // stamped the way a pre-KB-02A database holds it.
    stack.db
      .prepare("UPDATE page_index_nodes SET knowledge_base_id = '' WHERE document_id = ?")
      .run(spec.documentId)
  }
  if (spec.active) {
    const now = new Date().toISOString()
    stack.db
      .prepare(
        `INSERT INTO sources (
           source_id, source_key, source_kind, source_uri, namespace,
           active_doc_id, created_at, updated_at, tenant_id, knowledge_base_id
         ) VALUES (?, ?, 'file', ?, 'pt10', ?, ?, ?, ?, ?)`
      )
      .run(
        `src-${spec.documentId}`,
        `key-${spec.documentId}`,
        `file://${spec.documentId}`,
        spec.documentId,
        now,
        now,
        tenantId,
        spec.knowledgeBaseId
      )
  }
  if (spec.indexed === false) return
  stack.es.seed({
    id: chunkId,
    documentId: spec.documentId,
    kind: "child",
    content: `${PT10_QUERY}：${spec.documentId} 允许退款`,
    ...(spec.untagged ? {} : { knowledgeBaseId: spec.knowledgeBaseId }),
    tenantId,
    childrenIds: [],
    metadata: { title: PT10_QUERY, source: "pt10", kind: "child" },
    embedding: embedText(spec.documentId),
  })
}

/** The audit fixture's five documents — every one sorts ahead of the target. */
function pt10ForeignSpecs(
  stack: Pt10Stack,
  overrides: Partial<Pt10NodeSpec> = {}
): Pt10NodeSpec[] {
  return [0, 1, 2, 3, 4].map((index) => ({
    documentId: `a-foreign-${index}`,
    knowledgeBaseId: stack.foreignKb.id,
    ...overrides,
  }))
}

function pt10Context(
  groups: string[] = [],
  scopes: AccessContext["scopes"] = ["chat"]
): AccessContext {
  return {
    tenantId: PT10_TENANT,
    subjectId: groups.length > 0 ? `pt10-user-${groups[0]}` : "pt10-user",
    groups,
    scopes,
  }
}

function pt10TargetScope(stack: Pt10Stack): RetrievalScope {
  return { knowledgeBaseIds: [stack.targetKb.id] }
}

function pt10Ids(results: RetrievalResult[]): string[] {
  return results.map(({ chunk }) => chunk.id).sort()
}

function pt10ForeignChunkIds(): string[] {
  return [0, 1, 2, 3, 4].map((index) => `chunk-a-foreign-${index}`).sort()
}

test("PT-10 AC01: the audit F1 fixture inverted — five foreign-KB nodes leave the target's one valid hit intact", async () => {
  const stack = pt10Stack()
  try {
    pt10Seed(stack, { documentId: PT10_TARGET_DOC, knowledgeBaseId: stack.targetKb.id })

    const baseline = await stack.operations.pageIndexSearch(
      { text: PT10_QUERY },
      5,
      pt10Context(),
      pt10TargetScope(stack)
    )
    assert.deepEqual(baseline.map(({ chunk }) => chunk.id), [PT10_TARGET_CHUNK])

    for (const spec of pt10ForeignSpecs(stack)) pt10Seed(stack, spec)

    const after = await stack.operations.pageIndexSearch(
      { text: PT10_QUERY },
      5,
      pt10Context(),
      pt10TargetScope(stack)
    )
    assert.equal(
      after.length,
      1,
      "reproduce.cjs F1 asserted 0 here; the eligible target must keep its hit"
    )
    assert.equal(after[0].chunk.id, PT10_TARGET_CHUNK)
    assert.equal(after[0].source, "pageIndex")
    assert.equal(stack.nodeCalls.at(-1)!.limit, 5, "the ceiling stays five nodes")
    assert.deepEqual(stack.nodeCalls.at(-1)!.eligibility?.knowledgeBaseIds, [stack.targetKb.id])
    assert.deepEqual(stack.nodeCalls.at(-1)!.eligibility?.tenantId, PT10_TENANT)

    // Proof that the fixture really starves an unscoped quota: five eligible
    // rows ahead of the target fill all five slots (the legacy caller contract,
    // untouched by PT-10).
    const unscoped = await stack.operations.pageIndexSearch({ text: PT10_QUERY }, 5)
    assert.deepEqual(pt10Ids(unscoped), pt10ForeignChunkIds())
    assert.ok(!pt10Ids(unscoped).includes(PT10_TARGET_CHUNK))
  } finally {
    stack.db.close()
  }
})

test("PT-10 AC02: cross-tenant matches sorting ahead of the target never consume its slot", async () => {
  const stack = pt10Stack()
  try {
    pt10Seed(stack, { documentId: PT10_TARGET_DOC, knowledgeBaseId: stack.targetKb.id })
    for (const spec of pt10ForeignSpecs(stack, {
      knowledgeBaseId: stack.targetKb.id,
      tenantId: PT10_OTHER_TENANT,
    })) {
      pt10Seed(stack, spec)
    }

    const results = await stack.operations.pageIndexSearch(
      { text: PT10_QUERY },
      5,
      pt10Context(),
      pt10TargetScope(stack)
    )
    assert.deepEqual(results.map(({ chunk }) => chunk.id), [PT10_TARGET_CHUNK])
    const hydration = JSON.stringify(stack.esRequests.at(-1))
    assert.ok(!hydration.includes("a-foreign-"), `foreign tenant leaked: ${hydration}`)
    assert.ok(hydration.includes(`"tenantId":"${PT10_TENANT}"`))
  } finally {
    stack.db.close()
  }
})

test("PT-10 AC02: an invisible group's nodes never consume a group-restricted caller's slot", async () => {
  const stack = pt10Stack()
  try {
    pt10Seed(stack, { documentId: PT10_TARGET_DOC, knowledgeBaseId: stack.targetKb.id })
    for (const spec of pt10ForeignSpecs(stack, {
      knowledgeBaseId: stack.targetKb.id,
      allowedGroups: ["secret-team"],
    })) {
      pt10Seed(stack, spec)
    }

    const restricted = await stack.operations.pageIndexSearch(
      { text: PT10_QUERY },
      5,
      pt10Context(["ops"]),
      pt10TargetScope(stack)
    )
    assert.deepEqual(restricted.map(({ chunk }) => chunk.id), [PT10_TARGET_CHUNK])
    assert.deepEqual(stack.nodeCalls.at(-1)!.eligibility?.callerGroups, ["ops"])

    // The same five rows ARE eligible for a tenant-wide reader, so the axis is
    // caller-derived and the five-slot ceiling is unchanged (not raised).
    const tenantWide = await stack.operations.pageIndexSearch(
      { text: PT10_QUERY },
      5,
      pt10Context(),
      pt10TargetScope(stack)
    )
    assert.deepEqual(tenantWide.map(({ chunk }) => chunk.id).sort(), pt10ForeignChunkIds())
  } finally {
    stack.db.close()
  }
})

test("PT-10 AC02: a non-active document version never consumes the active caller's slot", async () => {
  const stack = pt10Stack({ activeVersionRepository: true })
  try {
    pt10Seed(stack, {
      documentId: PT10_TARGET_DOC,
      knowledgeBaseId: stack.targetKb.id,
      active: true,
    })
    for (const spec of pt10ForeignSpecs(stack, { knowledgeBaseId: stack.targetKb.id })) {
      // Indexed and tenant-visible, but its source has no active pointer: the
      // node is a non-active version.
      pt10Seed(stack, spec)
    }

    const results = await stack.operations.pageIndexSearch(
      { text: PT10_QUERY },
      5,
      pt10Context(),
      pt10TargetScope(stack)
    )
    assert.deepEqual(
      results.map(({ chunk }) => chunk.id),
      [PT10_TARGET_CHUNK],
      "only the active version may occupy a PageIndex slot"
    )
    assert.equal(stack.nodeCalls.at(-1)!.eligibility?.restrictToActiveDocumentVersions, true)
    const hydration = JSON.stringify(stack.esRequests.at(-1))
    assert.ok(hydration.includes(`"documentId":["${PT10_TARGET_DOC}"]`), hydration)
    assert.ok(!hydration.includes("a-foreign-"), hydration)
  } finally {
    stack.db.close()
  }
})

test("PT-10 AC03: a configured-empty active set yields no eligible node, an unconfigured repository keeps the default read", async () => {
  const dataSeed = (stack: Pt10Stack) => {
    pt10Seed(stack, { documentId: PT10_TARGET_DOC, knowledgeBaseId: stack.targetKb.id })
    for (const spec of pt10ForeignSpecs(stack, { knowledgeBaseId: stack.foreignKb.id })) {
      pt10Seed(stack, spec)
    }
  }

  // Configured, and its active set is EMPTY (no source row carries a pointer).
  const gated = pt10Stack({ activeVersionRepository: true })
  try {
    dataSeed(gated)
    const results = await gated.operations.pageIndexSearch({ text: PT10_QUERY }, 5)
    assert.deepEqual(results, [], "a configured-empty active set hides everything")
    assert.equal(gated.nodeCalls.at(-1)!.eligibility?.restrictToActiveDocumentVersions, true)
    assert.equal(gated.esRequests.length, 0, "no eligible node must not reach hydration")
  } finally {
    gated.db.close()
  }

  // NOT configured — the pre-existing default read over the same data.
  const unconfigured = pt10Stack()
  try {
    dataSeed(unconfigured)
    const results = await unconfigured.operations.pageIndexSearch({ text: PT10_QUERY }, 5)
    assert.deepEqual(
      pt10Ids(results),
      pt10ForeignChunkIds(),
      "an unconfigured active-version repository must keep reading its corpus"
    )
    assert.equal(unconfigured.nodeCalls.at(-1)!.eligibility?.restrictToActiveDocumentVersions, undefined)
    assert.notDeepEqual(
      unconfigured.nodeCalls.at(-1)!.eligibility,
      gated.nodeCalls.at(-1)!.eligibility,
      "the two states are distinguishable at the query seam"
    )
  } finally {
    unconfigured.db.close()
  }
})

test("PT-10 AC04: an explicit empty knowledge scope queries neither PageIndex nor Elasticsearch", async () => {
  const stack = pt10Stack({ activeVersionRepository: true })
  try {
    pt10Seed(stack, { documentId: PT10_TARGET_DOC, knowledgeBaseId: stack.targetKb.id, active: true })

    const results = await stack.operations.pageIndexSearch(
      { text: PT10_QUERY },
      5,
      pt10Context(),
      { knowledgeBaseIds: [] }
    )
    assert.deepEqual(results, [])
    assert.equal(stack.nodeCalls.length, 0, "an empty scope must not read the node table")
    assert.equal(stack.esRequests.length, 0, "an empty scope must not reach Elasticsearch")

    // The refusal holds at the full-channel entry too.
    const outcome = await stack.searcher.search({ text: PT10_QUERY }, {
      accessContext: pt10Context(),
      retrievalScope: { knowledgeBaseIds: [] },
      channels: ["pageIndex"],
    })
    assert.deepEqual(outcome.results, [])
    assert.equal(stack.nodeCalls.length, 0)
  } finally {
    stack.db.close()
  }
})

test("PT-10 AC04: an untagged legacy row is refused under an explicit scope and stays readable without one", async () => {
  const stack = pt10Stack()
  try {
    pt10Seed(stack, { documentId: PT10_TARGET_DOC, knowledgeBaseId: stack.targetKb.id })
    pt10Seed(stack, {
      documentId: "a-untagged",
      knowledgeBaseId: stack.targetKb.id,
      untagged: true,
    })

    const scoped = await stack.operations.pageIndexSearch(
      { text: PT10_QUERY },
      5,
      pt10Context(),
      pt10TargetScope(stack)
    )
    assert.deepEqual(scoped.map(({ chunk }) => chunk.id), [PT10_TARGET_CHUNK])
    const scopedHydration = JSON.stringify(stack.esRequests.at(-1))
    assert.ok(!scopedHydration.includes("a-untagged"), "an untagged row cannot be authorized")

    const legacy = await stack.operations.pageIndexSearch({ text: PT10_QUERY }, 5, pt10Context())
    assert.deepEqual(pt10Ids(legacy), ["chunk-a-untagged", PT10_TARGET_CHUNK])
  } finally {
    stack.db.close()
  }
})

test("PT-10 AC04: an admin caller gains no cross-tenant or cross-knowledge-base reach from the node quota", async () => {
  const stack = pt10Stack()
  try {
    pt10Seed(stack, { documentId: PT10_TARGET_DOC, knowledgeBaseId: stack.targetKb.id })
    for (const spec of pt10ForeignSpecs(stack)) pt10Seed(stack, spec)
    for (const spec of pt10ForeignSpecs(stack, { tenantId: PT10_OTHER_TENANT }).map((foreign) => ({
      ...foreign,
      documentId: `b-other-tenant-${foreign.documentId}`,
    }))) {
      pt10Seed(stack, spec)
    }

    const admin = await stack.operations.pageIndexSearch(
      { text: PT10_QUERY },
      5,
      pt10Context([], ["chat", "admin"]),
      pt10TargetScope(stack)
    )
    assert.deepEqual(admin.map(({ chunk }) => chunk.id), [PT10_TARGET_CHUNK])
    const adminEligibility = stack.nodeCalls.at(-1)!.eligibility

    const reader = await stack.operations.pageIndexSearch(
      { text: PT10_QUERY },
      5,
      pt10Context(),
      pt10TargetScope(stack)
    )
    assert.deepEqual(
      stack.nodeCalls.at(-1)!.eligibility,
      adminEligibility,
      "the node axes come from the caller's tenant and scope — never from an admin scope"
    )
    assert.deepEqual(reader.map(({ chunk }) => chunk.id), [PT10_TARGET_CHUNK])
    const hydration = JSON.stringify(stack.esRequests.at(-1))
    assert.ok(!hydration.includes("a-foreign-"), hydration)
    assert.ok(!hydration.includes("b-other-tenant"), hydration)
  } finally {
    stack.db.close()
  }
})

test("PT-10 AC05: eight eligible nodes still return the first five, deduped by linked chunk and cut to topK", async () => {
  const stack = pt10Stack()
  try {
    for (const documentId of ["e0", "e1", "e2", "e3", "e4", "e5"]) {
      pt10Seed(stack, { documentId, knowledgeBaseId: stack.targetKb.id })
    }
    // A second node in e2 links the SAME chunk: the documentId+chunkId dedup must
    // collapse it inside the five selected nodes.
    stack.db
      .prepare(
        `INSERT INTO page_index_nodes (
           document_id, node_id, title, section_path, page_start, page_end, summary,
           parent_id, child_ids, linked_chunk_ids, tenant_id, allowed_groups, knowledge_base_id
         ) VALUES ('e2', 'node-2', ?, '[]', 1, 1, ?, NULL, '[]', '["chunk-e2"]', ?, '[]', ?)`
      )
      .run(`${PT10_QUERY}（e2/node-2）`, "退款条件与例外", PT10_TENANT, stack.targetKb.id)

    const results = await stack.operations.pageIndexSearch(
      { text: PT10_QUERY },
      2,
      pt10Context(),
      pt10TargetScope(stack)
    )
    assert.equal(stack.nodeCalls.at(-1)!.limit, 5, "the node ceiling is unchanged by topK")
    assert.deepEqual(
      results.map(({ chunk }) => chunk.id).sort(),
      ["chunk-e0", "chunk-e1"],
      "the five eligible nodes are read in (document_id, node_id) order, deduped, then cut to topK"
    )
    const hydration = stack.esRequests.at(-1)!.query as {
      bool: { should: Array<Record<string, unknown>> }
    }
    assert.equal(hydration.bool.should.length, 2, "duplicate linked chunks collapse to one identity")
    assert.ok(!JSON.stringify(hydration).includes("chunk-e2"))

    const wider = await stack.operations.pageIndexSearch(
      { text: PT10_QUERY },
      4,
      pt10Context(),
      pt10TargetScope(stack)
    )
    assert.deepEqual(
      wider.map(({ chunk }) => chunk.id).sort(),
      ["chunk-e0", "chunk-e1", "chunk-e2", "chunk-e3"]
    )
    assert.equal(stack.nodeCalls.at(-1)!.limit, 5)
  } finally {
    stack.db.close()
  }
})

test("PT-10 AC06: material that lost active eligibility between selection and hydration is refused", async () => {
  const stack = pt10Stack({
    activeVersionRepository: true,
    retireActiveVersionsOnHydrationRead: true,
  })
  try {
    pt10Seed(stack, {
      documentId: PT10_TARGET_DOC,
      knowledgeBaseId: stack.targetKb.id,
      active: true,
    })

    const results = await stack.operations.pageIndexSearch(
      { text: PT10_QUERY },
      5,
      pt10Context(),
      pt10TargetScope(stack)
    )
    // The node WAS selected (it was active when the bounded read ran)…
    assert.equal(stack.nodeCalls.length, 1)
    assert.deepEqual(stack.nodeCalls[0].eligibility?.knowledgeBaseIds, [stack.targetKb.id])
    // …and hydration re-checked, found the version retired, and refused it.
    assert.deepEqual(results, [], "a retired version must never become Evidence")
    assert.equal(stack.esRequests.length, 1)
    const hydration = JSON.stringify(stack.esRequests[0])
    assert.ok(
      hydration.includes("__no_active_document__"),
      `the fail-closed active filter must be emitted: ${hydration}`
    )
    assert.ok(!hydration.includes("允许退款"), "no content leaked past the re-check")
  } finally {
    stack.db.close()
  }
})

test("PT-10 AC09: the shared-entry PageIndex tool reaches the target evidence with foreign nodes present", async () => {
  const stack = pt10Stack()
  try {
    pt10Seed(stack, { documentId: PT10_TARGET_DOC, knowledgeBaseId: stack.targetKb.id })
    for (const spec of pt10ForeignSpecs(stack)) pt10Seed(stack, spec)

    const service = new ToolInvocationService({
      registry: registerBuiltinTools(new ToolRegistry()),
      allowedTools: ["knowledge_search"],
    })
    const invocation = await service.invoke(
      "knowledge_search",
      { query: PT10_QUERY, mode: "pageindex_hierarchy" },
      {
        searcher: stack.searcher,
        accessContext: pt10Context(),
        retrievalScope: pt10TargetScope(stack),
      }
    )
    assert.equal(invocation.trace.outcome, "ok", invocation.trace.error ?? "")
    const result = invocation.result as {
      results: RetrievalResult[]
      resultCount: number
      unavailableChannels: string[]
    }
    assert.deepEqual(result.unavailableChannels, [])
    assert.equal(
      result.resultCount,
      1,
      "the tool's PageIndex lookup still reaches the target after five foreign nodes arrive"
    )
    assert.deepEqual(result.results.map(({ chunk }) => chunk.id), [PT10_TARGET_CHUNK])

    const evidence = buildEvidence(result.results)
    assert.equal(evidence[0].documentId, PT10_TARGET_DOC)
    const references = referencesForReply(`退款规则 [cite:${evidence[0].id}]`, evidence)
    assert.equal(references[0].documentId, PT10_TARGET_DOC)
    assert.equal(stack.nodeCalls.at(-1)!.limit, 5)
  } finally {
    stack.db.close()
  }
})
