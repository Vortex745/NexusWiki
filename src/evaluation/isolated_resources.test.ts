/**
 * Eval refactor Ticket 02 — Isolated evaluation resources tests.
 *
 * Verifies the acceptance criteria from
 * `.scratch/eval-refactor-tickets/issues/02-isolated-evaluation-resources.md`:
 *   #1 prepare/ready/run/dispose lifecycle — the FULL corpus (including
 *      distractors) is ingested; readiness waits for the dedicated index to
 *      become searchable (first count fails, retry succeeds)
 *   #2 single task ownership across ES chunks / graph provenance, plus
 *      chunk → passageId reverse lookup
 *   #3 memory-only side channel: conversations / traces never reach the
 *      business library or a persistent observation backend
 *   #4 one real Answer question through the shared entry: completed run,
 *      caseId correlation, final-context candidates resolve to corpus
 *      passages, no ground-truth injection, scope access context enforced
 *      even when the caller supplies a hostile one
 *   #5 bounded idempotent cleanup, including cleanup after a partially
 *      failed prepare (shared Entity nodes are never deleted)
 *   #6 business library + two eval scopes with identical content and
 *      identical entity names never cross-contaminate
 *
 * Test doubles replace only external system boundaries (Elasticsearch,
 * Neo4j, OpenAI chat/embedding) — the ingestion lifecycle, shared Answer
 * entry, retrieval stack, and SQLite stores all run for real against an
 * in-memory database.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import type OpenAI from "openai"
import type { Client } from "@elastic/elasticsearch"
import type { Driver } from "neo4j-driver"
import type { AppConfig } from "../config"
import type { Entity } from "../types"
import type { WikifierLike } from "../ingestion/pipeline"
import { Neo4jStore } from "../ingestion/storage/store"
import {
  createIsolatedEvalResources,
  EvalPrepareError,
  type IsolatedEvalResources,
} from "./isolated_resources"

const config: AppConfig = {
  esNode: "http://elasticsearch.test",
  esApiKey: "",
  openaiApiKey: "chat-key",
  openaiBaseUrl: "http://chat.test",
  openaiChatModel: "configured-chat-model",
  embeddingApiKey: "embedding-key",
  embeddingBaseUrl: "http://embedding.test",
  embeddingModel: "configured-embedding-model",
  embeddingDimensions: 3,
  openaiRequestTimeoutMs: 200_000,
  openaiMaxRetries: 1,
  neo4jUri: "bolt://neo4j.test",
  neo4jUser: "neo4j",
  neo4jPassword: "password",
  sqlitePath: ":memory:",
  pollIntervalMs: 1,
  claimedTimeoutMs: 1,
  accessMode: "single_tenant",
  activationMode: "auto",
  conversationTtlDays: 30,
  conversationGcIntervalMs: 86_400_000,
  rerankApiKey: "",
  rerankBaseUrl: "https://api.edgefn.net/v1",
  rerankModel: "bge-reranker-v2-m3",
  rerankTimeoutMs: 30_000,
  rerankMaxDocumentChars: 4_000,
}

const BUSINESS_INDEX = "kefu-rag-chunks"

const CORPUS = [
  {
    passageId: "p-relevant",
    title: "退货政策",
    content: "退货政策：客户在购买后14天内可以发起退货，退货时需保留购物发票。",
  },
  {
    passageId: "p-distractor-membership",
    title: "会员积分",
    content: "会员积分可在下单时抵扣现金，每一百积分可抵扣一元。",
  },
  {
    passageId: "p-distractor-shipping",
    title: "配送范围",
    content: "本店配送范围覆盖全国主要城市，偏远地区暂不发货。",
  },
]

const QUESTION = "退货需要在多少天内发起？"

// A ground-truth-shaped answer that exists ONLY inside this test file. It is
// never passed to any API — criterion #4 "no GT injection" means the run entry
// has no channel that could feed a canonical answer into the model prompt.
const GROUND_TRUTH_MARKER = "GROUND_TRUTH_ANSWER_MARKER_NEVER_PASSED_IN"

// ---------------------------------------------------------------------------
// Fake Elasticsearch cluster (index-isolated in-memory)
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  const ascii = text.match(/[a-zA-Z0-9]+/g) ?? []
  const cjk = [...text].filter((ch) => /[\u4e00-\u9fff]/.test(ch))
  return [...ascii, ...cjk]
}

function evalClause(
  doc: Record<string, unknown>,
  clause: Record<string, unknown>
): boolean {
  if (clause.term) {
    const [field, value] = Object.entries(
      clause.term as Record<string, unknown>
    )[0]
    return doc[field] === value
  }
  if (clause.terms) {
    const [field, values] = Object.entries(
      clause.terms as Record<string, unknown[]>
    )[0]
    return values.includes(doc[field])
  }
  if (clause.exists) {
    const field = (clause.exists as { field: string }).field
    const value = doc[field]
    if (value === undefined || value === null) return false
    if (Array.isArray(value) && value.length === 0) return false
    return true
  }
  if (clause.match) {
    const [field, query] = Object.entries(
      clause.match as Record<string, string>
    )[0]
    return tokenize(String(query)).some((token) =>
      String(doc[field] ?? "").includes(token)
    )
  }
  if (clause.multi_match) {
    const mm = clause.multi_match as { query: string; fields: string[] }
    return tokenize(mm.query).some((token) =>
      mm.fields.some((field) => String(doc[field] ?? "").includes(token))
    )
  }
  if (clause.bool) return evalBool(doc, clause.bool as Record<string, unknown>)
  return true
}

function evalBool(
  doc: Record<string, unknown>,
  bool: Record<string, unknown>
): boolean {
  if (Array.isArray(bool.must)) {
    if (!bool.must.every((c) => evalClause(doc, c as Record<string, unknown>))) {
      return false
    }
  }
  if (Array.isArray(bool.filter)) {
    if (
      !bool.filter.every((c) => evalClause(doc, c as Record<string, unknown>))
    ) {
      return false
    }
  }
  if (Array.isArray(bool.must_not)) {
    if (
      bool.must_not.some((c) => evalClause(doc, c as Record<string, unknown>))
    ) {
      return false
    }
  }
  if (Array.isArray(bool.should) && bool.minimum_should_match) {
    const required = Number(bool.minimum_should_match)
    const matched = bool.should.filter((c) =>
      evalClause(doc, c as Record<string, unknown>)
    ).length
    if (matched < required) return false
  }
  return true
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

class FakeEsCluster {
  private readonly indices = new Map<string, Map<string, Record<string, unknown>>>()
  readonly bulkTargets = new Set<string>()
  readonly deletedIndices: string[] = []
  readonly searchRequests: Array<{
    index: string
    request: Record<string, unknown>
  }> = []
  /** When > 0, the next N count calls fail (index propagation delay). */
  countFailuresRemaining = 0

  client(): Client {
    const cluster = this
    return {
      indices: {
        exists: async ({ index }: { index: string }) =>
          cluster.indices.has(index),
        create: async ({ index }: { index: string }) => {
          cluster.indices.set(index, new Map())
          return { acknowledged: true }
        },
        delete: async ({ index }: { index: string }) => {
          if (!cluster.indices.has(index)) {
            const error = new Error("index_not_found_exception")
            ;(error as { meta?: unknown }).meta = { statusCode: 404 }
            throw error
          }
          cluster.indices.delete(index)
          cluster.deletedIndices.push(index)
          return { acknowledged: true }
        },
        getMapping: async ({ index }: { index: string }) => ({
          [index]: {
            mappings: {
              properties: {
                embedding: { dims: 3 },
                kind: { type: "keyword" },
                parentId: { type: "keyword" },
                childrenIds: { type: "keyword" },
                tenantId: { type: "keyword" },
                allowedGroups: { type: "keyword" },
              },
            },
          },
        }),
        putMapping: async () => ({ acknowledged: true }),
      },
      bulk: async ({ body }: { body: unknown[] }) => {
        for (let i = 0; i < body.length; i += 2) {
          const action = body[i] as {
            index: { _index: string; _id: string }
          }
          const doc = body[i + 1] as Record<string, unknown>
          cluster.bulkTargets.add(action.index._index)
          let target = cluster.indices.get(action.index._index)
          if (!target) {
            target = new Map()
            cluster.indices.set(action.index._index, target)
          }
          target.set(action.index._id, { ...doc })
        }
        return { errors: false, items: [] }
      },
      count: async (request: { index: string; query?: unknown }) => {
        if (cluster.countFailuresRemaining > 0) {
          cluster.countFailuresRemaining -= 1
          throw new Error("index_not_found_exception")
        }
        const docs = [...(cluster.indices.get(request.index)?.values() ?? [])]
        const query = request.query as Record<string, unknown> | undefined
        const count = query
          ? docs.filter((doc) => evalClause(doc, query)).length
          : docs.length
        return { count }
      },
      search: async (request: {
        index: string | string[]
        knn?: {
          query_vector: number[]
          k: number
          filter?: unknown
        }
        query?: unknown
        size?: number
      }) => {
        const index = Array.isArray(request.index)
          ? request.index[0]
          : request.index
        cluster.searchRequests.push({
          index,
          request: request as unknown as Record<string, unknown>,
        })
        const docs = [...(cluster.indices.get(index)?.values() ?? [])]
        let selected: Array<{ doc: Record<string, unknown>; score: number }>
        if (request.knn) {
          const candidates = docs.filter((doc) =>
            request.knn!.filter
              ? evalClause(doc, request.knn!.filter as Record<string, unknown>)
              : true
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
            .slice(0, request.knn!.k)
        } else {
          const query = request.query as Record<string, unknown> | undefined
          const matched = query
            ? docs.filter((doc) => evalClause(doc, query))
            : docs
          selected = matched.map((doc) => ({ doc, score: 1 }))
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

  hasIndex(index: string): boolean {
    return this.indices.has(index)
  }

  docs(index: string): Array<Record<string, unknown>> {
    return [...(this.indices.get(index)?.values() ?? [])]
  }

  seed(index: string, docs: Array<Record<string, unknown>>): void {
    const target = this.indices.get(index) ?? new Map()
    for (const doc of docs) {
      target.set(String(doc.id), { ...doc })
    }
    this.indices.set(index, target)
  }
}

// ---------------------------------------------------------------------------
// Fake embedding client (deterministic 3-dim vectors)
// ---------------------------------------------------------------------------

function embedText(text: string): number[] {
  const digest = createHash("sha256").update(text, "utf8").digest()
  return [digest[0] / 255, digest[1] / 255, digest[2] / 255]
}

function makeEmbeddingClient(): OpenAI {
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
// Fake OpenAI chat client (simple-route scripted LLM boundary)
// ---------------------------------------------------------------------------

interface ChatCall {
  system: string
  user: string
}

function makeEvalChatClient(): { client: OpenAI; calls: ChatCall[] } {
  const calls: ChatCall[] = []
  const create = async (params: {
    messages: Array<{ role: string; content: string }>
    stream?: boolean
  }) => {
    const system =
      params.messages.find((m) => m.role === "system")?.content ?? ""
    const lastUser =
      [...params.messages].reverse().find((m) => m.role === "user")
        ?.content ?? ""
    calls.push({ system, user: lastUser })

    // Router — simple route for the knowledge question.
    if (system.includes("Classify the query")) {
      return { choices: [{ message: { content: "simple" } }] }
    }
    // Tool selector — no tool call → documented fallback selection.
    if (system.includes("retrieval strategy selector")) {
      return { choices: [{ message: {} }] }
    }
    // Critic — approving verdict in the v1 schema.
    if (system.includes("You are a critic")) {
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                schemaVersion: 1,
                passed: true,
                hallucination: false,
                completeness: true,
                missingGap: null,
              }),
            },
          },
        ],
      }
    }
    // Answer draft — echo the first citation found in the assembled context.
    if (system.includes("你是智能客服助手")) {
      const cite = lastUser.match(/\[cite:(ev_[a-f0-9]+)\]/)?.[1]
      const reply = cite
        ? `知识库确认：客户在购买后14天内可以发起退货 [cite:${cite}]`
        : `知识库确认：暂无引用`
      if (params.stream) {
        async function* tokenStream() {
          yield { choices: [{ delta: { content: reply.slice(0, 10) } }] }
          yield { choices: [{ delta: { content: reply.slice(10) } }] }
        }
        return tokenStream()
      }
      return { choices: [{ message: { content: reply } }] }
    }
    // Contextualizer — echo the follow-up verbatim (ticket 01 fake pattern).
    if (system.includes("改写器")) {
      const followUp = lastUser.split("当前追问：").pop() ?? lastUser
      return { choices: [{ message: { content: followUp } }] }
    }
    // Reranker — numeric score.
    return { choices: [{ message: { content: "5" } }] }
  }
  return {
    client: { chat: { completions: { create } } } as unknown as OpenAI,
    calls,
  }
}

// ---------------------------------------------------------------------------
// Fake Neo4j cluster (Entity vocabulary + WIKILINK provenance model)
// ---------------------------------------------------------------------------

interface FakeGraphLink {
  sourceId: string
  targetId: string
  fact: string
  weight: number
  /** JSON provenance entries — the only ownership record on a relation. */
  provenance: string[]
}

class FakeGraphCluster {
  readonly entities = new Map<
    string,
    { id: string; name: string; type: string; aliases: string[] }
  >()
  readonly links = new Map<string, FakeGraphLink>()
  readonly queries: string[] = []

  driver(): Driver {
    const cluster = this
    return {
      session() {
        return {
          async run(query: string, params: Record<string, unknown>) {
            cluster.queries.push(query)
            if (query.includes("RETURN elementId(r) AS rid")) {
              // GRAPH_SELECT_OWNED_RELATIONS — provenance is the only ownership
              // record; the scope decides what to strip by parsing each entry
              // ([docId, chunkId, tenantId, groups, weight]).
              const needle = String(params.needle)
              return {
                records: [...cluster.links.entries()]
                  .filter(([, link]) =>
                    link.provenance.some((p) => p.includes(needle))
                  )
                  .map(([key, link]) => ({
                    get(field: string) {
                      if (field === "rid") return key
                      if (field === "provenance") return [...link.provenance]
                      return undefined
                    },
                  })),
              }
            }
            if (query.includes("DELETE r")) {
              // GRAPH_DELETE_RELATION — nothing of the relation is left.
              cluster.links.delete(String(params.rid))
            } else if (query.includes("SET r.provenance = $remaining, r.weight")) {
              // GRAPH_UPDATE_RELATION_PROVENANCE_AND_WEIGHT — survivors keep
              // their provenance and the relation weight returns to their max.
              const link = cluster.links.get(String(params.rid))
              if (link) {
                link.provenance = [...(params.remaining as string[])]
                link.weight = Number(params.maxWeight)
              }
            } else if (query.includes("SET r.provenance = $remaining")) {
              // GRAPH_UPDATE_RELATION_PROVENANCE — legacy survivor without a
              // weight element: provenance only, weight stays as-is.
              const link = cluster.links.get(String(params.rid))
              if (link) {
                link.provenance = [...(params.remaining as string[])]
              }
            } else if (query.includes("MERGE (e:Entity")) {
              cluster.entities.set(String(params.id), {
                id: String(params.id),
                name: String(params.name),
                type: String(params.type),
                aliases: (params.aliases as string[]) ?? [],
              })
            } else if (query.includes("MERGE (a)-[r:WIKILINK")) {
              const key = `${params.sourceId}\0${params.targetId}\0${params.relation}`
              const link =
                cluster.links.get(key) ??
                ({
                  sourceId: String(params.sourceId),
                  targetId: String(params.targetId),
                  fact: String(params.relation),
                  weight: 0,
                  provenance: [],
                } as FakeGraphLink)
              link.weight = Math.max(link.weight, Number(params.weight))
              for (const entry of params.provenance as string[]) {
                if (!link.provenance.includes(entry)) link.provenance.push(entry)
              }
              cluster.links.set(key, link)
            }
            // Retrieval queries ("MATCH (e:Entity)" … "RETURN names") and
            // anything else resolve to empty records.
            return { records: [] }
          },
          async close() {},
        }
      },
      async close() {},
    } as unknown as Driver
  }

  /** Provenance entries whose tenant element is EXACTLY tenantId (JSON
   * delimiter needle — same semantics as the production cleanup). */
  tenantProvenance(tenantId: string): string[] {
    const needle = `","${tenantId}",[`
    return [...this.links.values()].flatMap((link) =>
      link.provenance.filter((p) => p.includes(needle))
    )
  }

  /** Weight of the single shared relation the isolation tests build. */
  sharedLinkWeight(): number {
    return [...this.links.values()][0]?.weight ?? 0
  }

  /** Seed a pre-existing relation using the key format the writer uses. */
  seedLink(link: FakeGraphLink): void {
    const [sourceId, targetId] = [link.sourceId, link.targetId].sort()
    this.links.set(`${sourceId}\0${targetId}\0${link.fact}`, link)
  }
}

// ---------------------------------------------------------------------------
// Fixed wikifier (deterministic entities shared across scopes)
// ---------------------------------------------------------------------------

const SHARED_ENTITIES: Entity[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "退款政策",
    type: "policy",
    aliases: [],
    metadata: {},
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "客服系统",
    type: "system",
    aliases: [],
    metadata: {},
  },
]

function makeFixedWikifier(): WikifierLike {
  return {
    async extractEntities() {
      return SHARED_ENTITIES.map((entity) => ({ ...entity }))
    },
    async buildWikilinks(entities, chunks) {
      return [
        {
          sourceEntityId: entities[0].id,
          targetEntityId: entities[1].id,
          relation: "related_to",
          weight: 0.9,
          provenance: chunks.map((chunk) => ({
            documentId: chunk.documentId,
            chunkId: chunk.id,
          })),
        },
      ]
    },
  }
}

/** Fails only for the shipping distractor — partial-failure prepare. */
function makePartiallyFailingWikifier(): WikifierLike {
  return {
    async extractEntities(chunks) {
      if (chunks.some((chunk) => chunk.content.includes("配送范围"))) {
        throw new Error("wikifier unavailable for shipping content")
      }
      return SHARED_ENTITIES.map((entity) => ({ ...entity }))
    },
    async buildWikilinks(entities, chunks) {
      return [
        {
          sourceEntityId: entities[0].id,
          targetEntityId: entities[1].id,
          relation: "related_to",
          weight: 0.9,
          provenance: chunks.map((chunk) => ({
            documentId: chunk.documentId,
            chunkId: chunk.id,
          })),
        },
      ]
    },
  }
}

// ---------------------------------------------------------------------------
// Scope harness
// ---------------------------------------------------------------------------

interface ScopeHarness {
  resources: IsolatedEvalResources
  es: FakeEsCluster
  graph: FakeGraphCluster
  chat: { client: OpenAI; calls: ChatCall[] }
}

function makeScope(
  taskId: string,
  options?: {
    countFailures?: number
    wikifier?: WikifierLike
    now?: () => Date
  }
): ScopeHarness {
  const es = new FakeEsCluster()
  es.countFailuresRemaining = options?.countFailures ?? 0
  const graph = new FakeGraphCluster()
  const chat = makeEvalChatClient()
  const resources = createIsolatedEvalResources({
    taskId,
    config,
    clients: {
      es: es.client(),
      chatClient: chat.client,
      embeddingClient: makeEmbeddingClient(),
      graphDriver: graph.driver(),
    },
    wikifier: options?.wikifier ?? makeFixedWikifier(),
    ...(options?.now ? { now: options.now } : {}),
    readinessIntervalMs: 1,
  })
  return { resources, es, graph, chat }
}

/** Consume one Answer run through the scoped entry and return its events. */
async function runOneQuestion(
  resources: IsolatedEvalResources,
  question: string,
  runOptions: { runId: string; sessionId: string; caseId?: string; accessContext?: unknown }
): Promise<Array<Record<string, unknown>>> {
  const entry = await resources.createAnswerEntry()
  const events: Array<Record<string, unknown>> = []
  for await (const event of entry.eventsSource(
    question,
    runOptions as never
  )) {
    events.push(event as unknown as Record<string, unknown>)
  }
  return events
}

// ---------------------------------------------------------------------------
// #1 Lifecycle: prepare → ready (with propagation-delay retry) → dispose,
//     distractors ingested, business index untouched
// ---------------------------------------------------------------------------

test("Ticket 02: prepare ingests the full corpus with distractors, waits for index readiness, and dispose removes the dedicated index", async () => {
  const { resources, es } = makeScope("scope-alpha-0001", {
    countFailures: 1,
  })
  assert.equal(resources.getState(), "created")
  assert.equal(resources.tenantId, "eval-scopealpha0001")
  assert.equal(resources.esIndex, "kefu-rag-chunks-eval-scopealpha0001")
  assert.equal(resources.namespace, resources.tenantId)

  await resources.prepare(CORPUS)
  assert.equal(resources.getState(), "prepared")

  // Every passage — including distractors — got a document in the scope.
  for (const passage of CORPUS) {
    assert.ok(resources.docIdForPassage(passage.passageId))
  }
  // Readiness was verified against the tenant-scoped count after the first
  // count failure (index propagation delay) was retried away.
  const scopeDocs = es.docs(resources.esIndex)
  assert.ok(scopeDocs.length >= CORPUS.length)
  for (const doc of scopeDocs) {
    assert.equal(doc.tenantId, resources.tenantId)
  }
  // The business index never received an eval write.
  assert.equal(es.hasIndex(BUSINESS_INDEX), false)
  assert.deepEqual([...es.bulkTargets], [resources.esIndex])

  const report = await resources.dispose()
  assert.deepEqual(report, {
    esIndex: "deleted",
    graphProvenance: "cleaned",
    dbClosed: true,
  })
  assert.equal(resources.getState(), "disposed")
  assert.equal(es.hasIndex(resources.esIndex), false)

  // Idempotent second dispose: the index is already gone.
  const again = await resources.dispose()
  assert.equal(again.esIndex, "not_found")
  assert.equal(again.dbClosed, true)
})

// ---------------------------------------------------------------------------
// #2 Single task ownership across layers + chunk ↔ passage reverse lookup
// ---------------------------------------------------------------------------

test("Ticket 02: every layer carries the same task ownership and chunks reverse-map to passageIds", async () => {
  const { resources, es, graph } = makeScope("scope-alpha-0001")
  await resources.prepare(CORPUS)
  const docIds = CORPUS.map(
    (passage) => resources.docIdForPassage(passage.passageId)!
  )

  // ES chunks: tenant-owned, documentId from this scope's submissions, and
  // every stored chunk reverse-maps to a corpus passage (roundtrip).
  const docs = es.docs(resources.esIndex)
  assert.ok(docs.length >= CORPUS.length)
  const seenPassages = new Set<string>()
  for (const doc of docs) {
    assert.equal(doc.tenantId, resources.tenantId)
    assert.ok(docIds.includes(doc.documentId as string))
    const passageId = resources.passageIdForChunk({
      documentId: doc.documentId as string,
    })
    assert.ok(passageId)
    assert.ok(CORPUS.some((p) => p.passageId === passageId))
    assert.equal(
      resources.docIdForPassage(passageId!),
      doc.documentId as string
    )
    seenPassages.add(passageId!)
  }
  assert.equal(seenPassages.size, CORPUS.length)

  // Graph provenance: 5-element entries
  // [docId, chunkId, tenantId, groups, weight] stamped with the same
  // ownership — the weight element is what lets a release restore a shared
  // relation's weight to its surviving contributors.
  const provenanceEntries = graph.tenantProvenance(resources.tenantId)
  assert.ok(provenanceEntries.length >= 1)
  for (const entry of provenanceEntries) {
    const parsed = JSON.parse(entry) as [string, string, string, string[], number]
    assert.equal(parsed[2], resources.tenantId)
    assert.ok(docIds.includes(parsed[0]))
    assert.equal(parsed[4], 0.9)
  }

  await resources.dispose()
})

// ---------------------------------------------------------------------------
// #3 Memory-only side channel: conversations/traces stay in the scope, the
//     business library and persistent observation backends are never touched
// ---------------------------------------------------------------------------

test("Ticket 02: eval runs persist conversations and traces only inside the scope, never the business library", async () => {
  const { resources, es, graph, chat } = makeScope("scope-alpha-0001")
  await resources.prepare(CORPUS)
  const entry = await resources.createAnswerEntry()
  assert.equal(entry.accessContext.tenantId, resources.tenantId)

  async function run(
    message: string,
    runOptions: { runId: string; sessionId: string; caseId: string }
  ): Promise<Array<Record<string, unknown>>> {
    const events: Array<Record<string, unknown>> = []
    for await (const event of entry.eventsSource(message, runOptions)) {
      events.push(event as unknown as Record<string, unknown>)
    }
    return events
  }

  // First turn: no conversation memory yet (contextualizer must be skipped).
  const first = await run(QUESTION, {
    runId: "run-mem-1",
    sessionId: "sess-mem-1",
    caseId: "case-mem-1",
  })
  assert.equal(
    chat.calls.some((call) => call.system.includes("改写器")),
    false,
    "no contextualization without prior turns"
  )

  // Second turn on the SAME session: the validated turn pair was persisted by
  // the scope's conversation store and memory loading now supplies recent
  // turns to the contextualizer.
  const second = await run("那发票呢？", {
    runId: "run-mem-2",
    sessionId: "sess-mem-1",
    caseId: "case-mem-2",
  })
  assert.equal(
    chat.calls.some((call) => call.system.includes("改写器")),
    true,
    "second turn loads persisted conversation memory"
  )
  assert.ok(first.length >= 2 && second.length >= 2)

  // The in-memory trace collector saw both runs' full event streams.
  assert.ok(entry.traceCollector.events.length >= first.length + second.length)
  assert.deepEqual(
    entry.traceCollector.eventsByCase("case-mem-2").map((e) => e.eventId),
    second.map((e) => e.eventId as string)
  )
  assert.equal(entry.traceCollector.eventsByCase("case-missing").length, 0)

  // Business library untouched across all eval activity.
  assert.equal(es.hasIndex(BUSINESS_INDEX), false)
  assert.equal(graph.tenantProvenance("default").length, 0)

  await resources.dispose()
})

// ---------------------------------------------------------------------------
// #4 One real Answer question through the shared entry
// ---------------------------------------------------------------------------

test("Ticket 02: one real question runs through the shared entry against the isolated corpus", async () => {
  const { resources, es, chat } = makeScope("scope-alpha-0001")
  await resources.prepare(CORPUS)
  const docIds = new Set(
    CORPUS.map((passage) => resources.docIdForPassage(passage.passageId)!)
  )

  const events = await runOneQuestion(resources, QUESTION, {
    runId: "run-real-1",
    sessionId: "sess-real-1",
    caseId: "case-real-1",
    // Hostile caller-supplied access context — the scope must override it.
    accessContext: {
      tenantId: "default",
      subjectId: "attacker",
      groups: [],
      scopes: [],
    },
  })

  // Single terminal done event, completed.
  const done = events.filter((e) => e.type === "done")
  assert.equal(done.length, 1)
  assert.equal(done[0].status, "completed")
  const result = done[0].result as {
    reply: string
    status: string
    references: unknown[]
  }
  assert.equal(result.status, "completed")
  assert.match(result.reply, /\[cite:ev_[a-f0-9]+\]/)
  assert.ok(result.references.length >= 1)

  // Every event correlates the case.
  for (const event of events) {
    assert.equal(event.caseId, "case-real-1")
  }

  // Final context candidates all resolve to corpus passages of THIS scope.
  const retrieval = events.find(
    (e) => e.type === "progress" && e.stage === "retrieval"
  ) as { data: { finalContextCandidates: Array<{ documentId: string }> } } | undefined
  assert.ok(retrieval, "retrieval progress event present")
  const candidates = retrieval.data.finalContextCandidates
  assert.ok(candidates && candidates.length >= 1)
  for (const candidate of candidates) {
    const passageId = resources.passageIdForChunk({
      documentId: candidate.documentId,
    })
    assert.ok(passageId, "candidate document maps back to a corpus passage")
    assert.ok(docIds.has(candidate.documentId))
  }

  // All search traffic hit the dedicated index only, and the scope tenant
  // filter rode along on every authorized query (knn or bool).
  assert.ok(es.searchRequests.length >= 1)
  for (const { index, request } of es.searchRequests) {
    assert.equal(index, resources.esIndex)
    const serialized = JSON.stringify(request)
    assert.ok(
      serialized.includes(`"tenantId":"${resources.tenantId}"`),
      "tenant filter enforced on every query"
    )
  }

  // No ground-truth injection: the answer draft prompt is exactly the
  // assembled retrieval context + the question — no canonical-answer
  // channel exists.
  const answerCalls = chat.calls.filter((call) =>
    call.system.includes("你是智能客服助手")
  )
  assert.ok(answerCalls.length >= 1)
  for (const call of answerCalls) {
    assert.ok(call.user.includes("以下是从知识库中找到的相关文档片段"))
    assert.ok(!call.user.includes(GROUND_TRUTH_MARKER))
    assert.ok(!call.system.includes(GROUND_TRUTH_MARKER))
  }

  await resources.dispose()
})

// ---------------------------------------------------------------------------
// #5 Bounded cleanup after a partially failed prepare
// ---------------------------------------------------------------------------

test("Ticket 02: a partially failed prepare cleans up everything it created and reports the evidence", async () => {
  // Advancing clock skips the lifecycle's 2/4/8s retry backoff.
  let clockMs = 0
  const now = () => new Date((clockMs += 15_000))
  const { resources, es, graph } = makeScope("scope-alpha-0001", {
    wikifier: makePartiallyFailingWikifier(),
    now,
  })

  await assert.rejects(
    resources.prepare(CORPUS),
    (error: unknown) => {
      assert.ok(error instanceof EvalPrepareError)
      assert.match(error.message, /prepare failed/)
      // The best-effort cleanup report is attached and complete.
      assert.deepEqual(error.cleanupReport, {
        esIndex: "deleted",
        graphProvenance: "cleaned",
        dbClosed: true,
      })
      return true
    }
  )

  // The scope is disposed after a failed prepare and cannot be reused.
  assert.equal(resources.getState(), "disposed")
  await assert.rejects(
    resources.prepare(CORPUS),
    /disposed/
  )

  // Everything the failed prepare created is gone: ES index deleted, the
  // tenant's graph provenance stripped, shared Entity nodes KEPT (never
  // deleted per spec), business tenant untouched.
  assert.equal(es.hasIndex(resources.esIndex), false)
  assert.equal(graph.tenantProvenance(resources.tenantId).length, 0)
  assert.equal(graph.entities.size, SHARED_ENTITIES.length)
  assert.equal(graph.tenantProvenance("default").length, 0)
})

// ---------------------------------------------------------------------------
// #6 Business library + two eval scopes never cross-contaminate
// ---------------------------------------------------------------------------

test("Ticket 02: business data and two eval scopes with identical content stay isolated", async () => {
  const es = new FakeEsCluster()
  const graph = new FakeGraphCluster()
  const graphDriver = graph.driver()

  // Seed the "business" layer: a business chunk index entry and a business
  // graph relation over the SAME entity names the eval corpus will use.
  es.seed(BUSINESS_INDEX, [
    {
      id: "biz-chunk-1",
      documentId: "biz-doc-1",
      tenantId: "default",
      allowedGroups: [],
      kind: "child",
      content: "业务知识：发票抬头修改流程说明。",
      embedding: embedText("业务知识：发票抬头修改流程说明。"),
      metadata: { kind: "child" },
    },
  ])
  const neo4jStore = new Neo4jStore(graphDriver)
  await neo4jStore.storeEntities(SHARED_ENTITIES)
  await neo4jStore.storeWikilinks(
    [
      {
        sourceEntityId: SHARED_ENTITIES[0].id,
        targetEntityId: SHARED_ENTITIES[1].id,
        relation: "related_to",
        weight: 0.5,
        provenance: [{ documentId: "biz-doc-1", chunkId: "biz-chunk-1" }],
      },
    ],
    { tenantId: "default", allowedGroups: [] }
  )
  const businessProvenanceBefore = graph.tenantProvenance("default")

  function makeSharedScope(taskId: string): ScopeHarness {
    const chat = makeEvalChatClient()
    const resources = createIsolatedEvalResources({
      taskId,
      config,
      clients: {
        es: es.client(),
        chatClient: chat.client,
        embeddingClient: makeEmbeddingClient(),
        graphDriver,
      },
      wikifier: makeFixedWikifier(),
      readinessIntervalMs: 1,
    })
    return { resources, es, graph, chat }
  }

  const scopeA = makeSharedScope("scope-alpha-0001")
  const scopeB = makeSharedScope("scope-beta-0002")
  assert.notEqual(scopeA.resources.esIndex, scopeB.resources.esIndex)
  assert.notEqual(scopeA.resources.tenantId, scopeB.resources.tenantId)

  await scopeA.resources.prepare(CORPUS)
  await scopeB.resources.prepare(CORPUS)

  // Shared entity vocabulary MERGEd, not duplicated.
  assert.equal(graph.entities.size, SHARED_ENTITIES.length)
  // Each scope owns its provenance; both coexist with the business entries.
  assert.ok(graph.tenantProvenance(scopeA.resources.tenantId).length >= 1)
  assert.ok(graph.tenantProvenance(scopeB.resources.tenantId).length >= 1)
  assert.equal(graph.tenantProvenance("default").length, businessProvenanceBefore.length)
  // Ingesting the eval copies max-merged their larger weight (0.9) onto the
  // shared business relation (0.5) — releasing them must undo exactly that.
  assert.equal(graph.sharedLinkWeight(), 0.9)
  // No eval write ever reached the business index.
  assert.equal(es.bulkTargets.has(BUSINESS_INDEX), false)

  // Scope A runs a question and only sees its own documents.
  const eventsA = await runOneQuestion(scopeA.resources, QUESTION, {
    runId: "run-a-1",
    sessionId: "sess-a-1",
    caseId: "case-a-1",
  })
  const doneA = eventsA.find((e) => e.type === "done") as {
    status: string
    result: { status: string }
  }
  assert.equal(doneA.status, "completed")
  const retrievalA = eventsA.find(
    (e) => e.type === "progress" && e.stage === "retrieval"
  ) as { data: { finalContextCandidates: Array<{ documentId: string }> } }
  const docIdsA = new Set(
    CORPUS.map((p) => scopeA.resources.docIdForPassage(p.passageId)!)
  )
  for (const candidate of retrievalA.data.finalContextCandidates) {
    assert.ok(docIdsA.has(candidate.documentId))
  }

  // Releasing scope A does not disturb scope B or the business layer.
  const reportA = await scopeA.resources.dispose()
  assert.equal(reportA.esIndex, "deleted")
  assert.equal(es.hasIndex(scopeA.resources.esIndex), false)
  assert.ok(es.hasIndex(scopeB.resources.esIndex))
  assert.equal(graph.tenantProvenance(scopeA.resources.tenantId).length, 0)
  assert.ok(graph.tenantProvenance(scopeB.resources.tenantId).length >= 1)
  assert.deepEqual(graph.tenantProvenance("default"), businessProvenanceBefore)
  assert.equal(graph.entities.size, SHARED_ENTITIES.length)
  // Scope B still owns its share of the shared relation, so the weight stays
  // at the max of the SURVIVING contributors (business 0.5, scope B 0.9).
  assert.equal(graph.sharedLinkWeight(), 0.9)

  // Scope B still runs against its own corpus after A's release.
  const eventsB = await runOneQuestion(scopeB.resources, QUESTION, {
    runId: "run-b-1",
    sessionId: "sess-b-1",
    caseId: "case-b-1",
  })
  const doneB = eventsB.find((e) => e.type === "done") as {
    status: string
    result: { status: string }
  }
  assert.equal(doneB.status, "completed")
  const retrievalB = eventsB.find(
    (e) => e.type === "progress" && e.stage === "retrieval"
  ) as { data: { finalContextCandidates: Array<{ documentId: string }> } }
  const docIdsB = new Set(
    CORPUS.map((p) => scopeB.resources.docIdForPassage(p.passageId)!)
  )
  for (const candidate of retrievalB.data.finalContextCandidates) {
    assert.ok(docIdsB.has(candidate.documentId))
  }

  // Releasing scope B leaves the business graph relation intact.
  await scopeB.resources.dispose()
  assert.deepEqual(graph.tenantProvenance("default"), businessProvenanceBefore)
  assert.equal(graph.entities.size, SHARED_ENTITIES.length)
  // Only the business contributor remains, so the relation weight returns to
  // the business value instead of keeping the eval-raised 0.9.
  assert.equal(graph.sharedLinkWeight(), 0.5)
})

// ---------------------------------------------------------------------------
// #5b Releasing a scope that never created resources deletes nothing: a
//      colliding taskId (same derived index/tenant) must not take down the
//      live scope that owns those resources.
// ---------------------------------------------------------------------------

test("Ticket 02: dispose on a scope whose prepare failed on an index collision leaves the live scope untouched", async () => {
  const es = new FakeEsCluster()
  const graph = new FakeGraphCluster()
  const graphDriver = graph.driver()

  function makeCollidingScope(): IsolatedEvalResources {
    return createIsolatedEvalResources({
      taskId: "collision-scope-0001",
      config,
      clients: {
        es: es.client(),
        chatClient: makeEvalChatClient().client,
        embeddingClient: makeEmbeddingClient(),
        graphDriver,
      },
      wikifier: makeFixedWikifier(),
      readinessIntervalMs: 1,
    })
  }

  const live = makeCollidingScope()
  await live.prepare(CORPUS)

  // Same taskId → same sanitized index/tenant → prepare fails fast and must
  // NOT burn the live scope.
  const collided = makeCollidingScope()
  await assert.rejects(collided.prepare(CORPUS), /already exists/)
  assert.equal(collided.getState(), "created")

  // Disposing the failed scope owns nothing, so it reports skipped and
  // leaves the live scope's index + graph provenance in place.
  const report = await collided.dispose()
  assert.deepEqual(report, {
    esIndex: "skipped",
    graphProvenance: "skipped",
    dbClosed: true,
  })
  assert.ok(es.hasIndex(live.esIndex))
  assert.ok(graph.tenantProvenance(live.tenantId).length >= 1)

  // The live scope still runs, and can still release its own resources.
  const events = await runOneQuestion(live, QUESTION, {
    runId: "run-live-1",
    sessionId: "sess-live-1",
  })
  const done = events.find((e) => e.type === "done") as { status: string }
  assert.equal(done.status, "completed")
  const liveReport = await live.dispose()
  assert.equal(liveReport.esIndex, "deleted")
  assert.equal(es.hasIndex(live.esIndex), false)
  assert.equal(graph.tenantProvenance(live.tenantId).length, 0)
})

// ---------------------------------------------------------------------------
// #5c Legacy provenance entries (no weight element) are never guessed
//      downward: provenance is stripped, the relation weight stays.
// ---------------------------------------------------------------------------

test("Ticket 02: releasing a scope keeps the relation weight when a legacy entry survives", async () => {
  const es = new FakeEsCluster()
  const graph = new FakeGraphCluster()
  const graphDriver = graph.driver()

  // A pre-ticket-02 business relation: 4-element provenance, no weight.
  await new Neo4jStore(graphDriver).storeEntities(SHARED_ENTITIES)
  const [factSource, factTarget] = [
    SHARED_ENTITIES[0].id,
    SHARED_ENTITIES[1].id,
  ]
  graph.seedLink({
    sourceId: factSource,
    targetId: factTarget,
    fact: `${factSource}->${factTarget}:related_to`,
    weight: 0.5,
    provenance: [
      JSON.stringify(["biz-doc-1", "biz-chunk-1", "default", []]),
    ],
  })

  const resources = createIsolatedEvalResources({
    taskId: "legacy-scope-0001",
    config,
    clients: {
      es: es.client(),
      chatClient: makeEvalChatClient().client,
      embeddingClient: makeEmbeddingClient(),
      graphDriver,
    },
    wikifier: makeFixedWikifier(),
    readinessIntervalMs: 1,
  })
  await resources.prepare(CORPUS)
  assert.equal(graph.sharedLinkWeight(), 0.9)

  await resources.dispose()

  // The legacy survivor cannot be scored, so the weight is left as-is
  // (never lowered on a guess) while the scope's own entries are gone.
  assert.equal(graph.tenantProvenance(resources.tenantId).length, 0)
  assert.equal(graph.sharedLinkWeight(), 0.9)
  assert.equal(graph.tenantProvenance("default").length, 1)
})

// ---------------------------------------------------------------------------
// #6b Prefix tenants: one scope's tenantId is a strict PREFIX of another's.
//      A substring-based cleanup would strip the longer scope's provenance
//      when the shorter one is disposed; the parsed-entry cleanup must not.
// ---------------------------------------------------------------------------

test("Ticket 02: disposing a scope never strips a prefix-tenant scope's graph ownership", async () => {
  const es = new FakeEsCluster()
  const graph = new FakeGraphCluster()
  const graphDriver = graph.driver()

  function makeSharedScope(taskId: string): ScopeHarness {
    const chat = makeEvalChatClient()
    const resources = createIsolatedEvalResources({
      taskId,
      config,
      clients: {
        es: es.client(),
        chatClient: chat.client,
        embeddingClient: makeEmbeddingClient(),
        graphDriver,
      },
      wikifier: makeFixedWikifier(),
      readinessIntervalMs: 1,
    })
    return { resources, es, graph, chat }
  }

  // "prefixtenant0001" is a strict prefix of "prefixtenant00011".
  const scopeA = makeSharedScope("prefix-tenant-0001")
  const scopeB = makeSharedScope("prefix-tenant-00011")
  assert.ok(scopeB.resources.tenantId.startsWith(scopeA.resources.tenantId))
  assert.notEqual(scopeA.resources.esIndex, scopeB.resources.esIndex)

  await scopeA.resources.prepare(CORPUS)
  await scopeB.resources.prepare(CORPUS)

  // Both scopes own the SAME relation (identical entities and fact) — their
  // exact ownership entries coexist on it.
  assert.ok(graph.tenantProvenance(scopeA.resources.tenantId).length >= 1)
  const bProvenanceBefore = graph.tenantProvenance(scopeB.resources.tenantId)
  assert.ok(bProvenanceBefore.length >= 1)

  // Disposing the SHORTER (prefix) tenant must not touch the longer one.
  await scopeA.resources.dispose()
  assert.equal(graph.tenantProvenance(scopeA.resources.tenantId).length, 0)
  assert.deepEqual(
    graph.tenantProvenance(scopeB.resources.tenantId),
    bProvenanceBefore
  )
  assert.equal(graph.entities.size, SHARED_ENTITIES.length)

  // Scope B still answers against its own corpus after A's release.
  const eventsB = await runOneQuestion(scopeB.resources, QUESTION, {
    runId: "run-pfx-b",
    sessionId: "sess-pfx-b",
    caseId: "case-pfx-b",
  })
  const doneB = eventsB.find((e) => e.type === "done") as {
    status: string
    result: { status: string }
  }
  assert.equal(doneB.status, "completed")

  // And B's own release then cleans exactly its layer.
  await scopeB.resources.dispose()
  assert.equal(graph.tenantProvenance(scopeB.resources.tenantId).length, 0)
  assert.equal(es.hasIndex(scopeB.resources.esIndex), false)
})

// ---------------------------------------------------------------------------
// Boundary: the module must not reach for production singletons or the
// process composition root (isolation is structural, not conventional)
// ---------------------------------------------------------------------------

test("Ticket 02: isolated resources module has no production singleton dependency", () => {
  const source = readFileSync(
    path.resolve(process.cwd(), "src/evaluation/isolated_resources.ts"),
    "utf8"
  )
  assert.equal(/from\s+["']\.\.\/index["']/.test(source), false)
  assert.equal(/getDriver|createDriver|createIngestionStore\(/.test(source), false)
  // The memory-only side channel is explicit in the wiring.
  assert.match(source, /openDb\(":memory:"\)/)
  assert.match(source, /NoopLangfuseExporter/)
})
