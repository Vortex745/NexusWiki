/**
 * Ticket DR-15 — multi-turn continuation through the REAL HTTP transport, the
 * REAL shared Answer entry and the REAL isolated SQLite conversation state.
 *
 * Frozen here (`.scratch/deepeval-agent-repair-tickets/issues/15-…`):
 *   AC01 the first turn locks the authorized scope; a later attempt to change
 *        it is refused (the run never widens), and every retrieval, answer and
 *        citation of every turn stays inside that scope;
 *   AC02 a genuinely ambiguous turn is continued by supplying the missing
 *        parameter, and correcting a key condition afterwards produces an
 *        answer that carries the NEW fact with its own evidence;
 *   AC03 every scenario opens a fresh owner/session, turns inside a scenario
 *        reuse the session, and the matrix covers normal, empty scope,
 *        out-of-scope reassignment and correction (the old conclusion is not
 *        reused in the corrected answer).
 *
 * The model is a controlled collaborator: it classifies from the instruction
 * it receives, rewrites a follow-up into a standalone query, and answers from
 * the evidence it is given. Online acceptance (real Jev/Rerank/latency) stays
 * pending — no external provider is called here.
 */

import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import type OpenAI from "openai"
import type { Client as ElasticsearchClient } from "@elastic/elasticsearch"
import type { Driver } from "neo4j-driver"
import type { RequestHandler } from "express"

import type { AccessContext } from "../access/context"
import { createAnswerRuntime } from "../answer/runtime"
import { SqliteConversationHistoryStore } from "../answer/conversation_history_store"
import { SqliteConversationStore } from "../answer/conversation_store"
import { AssistantService, type AssistantVersionConfig } from "../assistants/assistant_service"
import type { AppConfig } from "../config"
import { openDb, type DB } from "../ingestion/tracking/db"
import { KnowledgeBaseServiceImpl } from "../knowledge/knowledge_base_service"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { createSharedAnswerEntry } from "../mastra/shared_answer_entry"
import { createRetrievalScopeResolver } from "../retrieval/scope"
import type { SearchOperations } from "../retrieval/search/searcher"
import type { AnswerRunEvent, Chunk, RetrievalResult } from "../types"
import { createApp } from "./server"

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
  demoOidc: false,
  demoOidcPort: 3900,
  demoOidcAudience: "nexusrag-demo",
  demoOidcPassword: "",
  adminLoginId: "admin",
  adminLoginPassword: "",
  activationMode: "auto",
  conversationTtlDays: 30,
  conversationGcIntervalMs: 86_400_000,
  rerankApiKey: "",
  rerankBaseUrl: "https://api.edgefn.test/v1",
  rerankModel: "bge-reranker-v2-m3",
  rerankTimeoutMs: 30_000,
  rerankMaxDocumentChars: 4_000,
  mcpCapabilitiesEnabled: false,
}

const MISSING_PARAMETER = "它怎么设置？"
const SUPPLIED_PARAMETER = "退货窗口怎么设置"
const RETURN_QUESTION = "退货窗口是多少天？"
const CORRECTION = "不是退货，是换货窗口"

const RETURN_FACT = "客户在购买后 14 天内可以发起退货。"
const EXCHANGE_FACT = "换货窗口为 30 天，需保留原始包装。"

function chunk(id: string, content: string): Chunk {
  return { id, documentId: `doc-${id}`, content, childrenIds: [], metadata: {} }
}

function retrievalResult(id: string, content: string): RetrievalResult {
  const value = chunk(id, content)
  return { chunk: value, parentChunk: value, score: 1, wikilinks: [], source: "vector" }
}

const RETURN_EVIDENCE = retrievalResult("chunk-return", RETURN_FACT)
const EXCHANGE_EVIDENCE = retrievalResult("chunk-exchange", EXCHANGE_FACT)

const CHUNKS = new Map<string, Chunk>([
  [RETURN_EVIDENCE.chunk.id, RETURN_EVIDENCE.chunk],
  [EXCHANGE_EVIDENCE.chunk.id, EXCHANGE_EVIDENCE.chunk],
])

interface ScopeObservation {
  query: string
  scope: unknown
}

function scopeIds(scope: unknown): string[] {
  return (scope as { knowledgeBaseIds?: string[] } | undefined)?.knowledgeBaseIds ?? []
}

/**
 * The search boundary records the query and the scope it received, and
 * answers ONLY when that scope is non-empty. An empty authorized scope can
 * therefore never produce evidence — the same fail-closed rule production
 * retrieval follows.
 */
function recordingSearchOperations(): SearchOperations & { calls: ScopeObservation[] } {
  const calls: ScopeObservation[] = []
  const record = (query: { text: string }, scope: unknown): RetrievalResult[] => {
    calls.push({ query: query.text, scope })
    if (scopeIds(scope).length === 0) return []
    if (query.text.includes("换货")) return [EXCHANGE_EVIDENCE]
    if (query.text.includes("退货")) return [RETURN_EVIDENCE]
    return []
  }
  return {
    calls,
    vectorSearch: async (query: { text: string }, _topK: number, _hypothesis: unknown,
      _access: unknown, scope: unknown) => record(query, scope),
    bm25Search: async (query: { text: string }, _topK: number,
      _access: unknown, scope: unknown) => record(query, scope),
    graphSearch: async (query: { text: string }, _topK: number, _seeds: unknown,
      _access: unknown, scope: unknown) => record(query, scope),
    pageIndexSearch: async (query: { text: string }, _topK: number,
      _access: unknown, scope: unknown) => record(query, scope),
    rerank: async (_query: string, incoming: RetrievalResult[]) => incoming,
    loadParents: async (
      identities: Array<{ documentId: string; id: string }>,
      _access: unknown,
      scope: unknown
    ) => {
      if (scopeIds(scope).length === 0) return []
      return identities
        .map((identity) => CHUNKS.get(identity.id))
        .filter((value): value is Chunk => value !== undefined)
    },
  } as unknown as SearchOperations & { calls: ScopeObservation[] }
}

function assistantConfig(knowledgeBaseIds: string[], systemPrompt = ""): AssistantVersionConfig {
  return {
    systemPrompt,
    knowledgeBaseIds,
    chatModelProfileId: "chat",
    rerankModelProfileId: null,
    toolPolicy: "read_only_retrieval",
    memoryEnabled: false,
  }
}

function clientFactory(chat: OpenAI) {
  return {
    createChatClient: () => chat,
    createEmbeddingClient: () =>
      ({
        embeddings: {
          create: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
        },
      }) as unknown as OpenAI,
    createElasticsearchClient: () =>
      ({ close: async () => {} }) as unknown as ElasticsearchClient,
    createNeo4jDriver: () => ({ close: async () => {} }) as unknown as Driver,
  }
}

const DIRECT_REPLY = async function* directReply(): AsyncGenerator<string> {
  yield "您好"
}

function classify(text: string): string {
  if (text === MISSING_PARAMETER) return "ambiguous"
  if (text.includes("怎么设置") && !text.includes("退货")) return "ambiguous"
  return "simple"
}

function standaloneQuery(followUp: string): string {
  if (followUp.includes("换货")) return "换货窗口是多少天"
  if (followUp.includes("退货")) return "退货窗口是多少天"
  return followUp
}

function citedEvidenceId(text: string): string | undefined {
  return text.match(/\[cite:(ev_[a-f0-9]+)\]/)?.[1]
}

/**
 * Controlled model: classification, follow-up rewriting, evidence-bound draft
 * and an approving critic. Every branch derives from what it is given, so the
 * same reply can be replayed from the transcript. The system messages of every
 * knowledge draft are kept, so the locked assistant version is observable.
 */
function chatStub(): { client: OpenAI; draftSystemPrompts: string[] } {
  const draftSystemPrompts: string[] = []
  const create = async (params: {
    messages: Array<{ role: string; content: string }>
    stream?: boolean
  }) => {
    const systemText = params.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n")
    const lastUser = [...params.messages].reverse()
      .find((message) => message.role === "user")?.content ?? ""

    if (systemText.includes("Classify the query")) {
      return { choices: [{ message: { content: classify(lastUser) } }] }
    }
    if (systemText.includes("客服对话上下文改写器")) {
      const followUp = lastUser.split("当前追问：").pop() ?? lastUser
      return { choices: [{ message: { content: standaloneQuery(followUp) } }] }
    }
    if (systemText.includes("retrieval strategy selector")) {
      return { choices: [{ message: {} }] }
    }
    if (systemText.includes("You are a critic")) {
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              schemaVersion: 1,
              passed: true,
              hallucination: false,
              completeness: true,
              missingGap: null,
            }),
          },
        }],
      }
    }
    if (systemText.includes("你是智能客服助手")) {
      draftSystemPrompts.push(systemText)
      const cite = citedEvidenceId(lastUser)
      // The answer names the fact that is actually in the assembled context.
      const reply = lastUser.includes("换货窗口")
        ? `换货窗口为 30 天。[cite:${cite ?? ""}]`
        : `退货窗口为 14 天。[cite:${cite ?? ""}]`
      if (params.stream) {
        async function* tokens() {
          yield { choices: [{ delta: { content: reply } }] }
        }
        return tokens()
      }
      return { choices: [{ message: { content: reply } }] }
    }
    return { choices: [{ message: { content: "" } }] }
  }
  return {
    client: { chat: { completions: { create } } } as unknown as OpenAI,
    draftSystemPrompts,
  }
}

interface Harness {
  base: string
  db: DB
  knowledgeBases: KnowledgeBaseServiceImpl
  assistants: AssistantService
  history: SqliteConversationHistoryStore
  store: SqliteConversationStore
  searches: ScopeObservation[]
  draftSystemPrompts: string[]
  assistant(knowledgeBaseIds: string[], systemPrompt?: string): { id: string }
  chat(body: Record<string, unknown>): Promise<{
    status: number
    json: Record<string, unknown> | null
  }>
  close(): Promise<void>
}

async function harness(
  owner: { tenantId: string; subjectId: string }
): Promise<Harness> {
  const cfg: AppConfig = { ...config, sqlitePath: ":memory:" }
  const searches = recordingSearchOperations()
  const stub = chatStub()
  const runtime = createAnswerRuntime(cfg, clientFactory(stub.client))
  // ONE isolated in-memory database owned by this scenario: the shared Answer
  // entry, the knowledge/assistant services and the conversation history all
  // read and write the same real state.
  const sharedDb = runtime.processRuntime.db
  const knowledgeBases = new KnowledgeBaseServiceImpl(
    new SqliteKnowledgeBaseRepo(sharedDb),
    "test-embedding:3"
  )
  const assistants = new AssistantService(sharedDb, knowledgeBases)
  const history = new SqliteConversationHistoryStore(sharedDb)
  const store = new SqliteConversationStore(sharedDb)
  const entry = await createSharedAnswerEntry({
    config: cfg,
    answerRuntime: runtime,
    searchOperations: searches,
    conversationStore: store,
    traceObserver: { onEvent: () => {} },
    streamDirectReply: DIRECT_REPLY,
  })
  const identity: RequestHandler = (_req, res, next) => {
    res.locals.accessContext = {
      tenantId: owner.tenantId,
      subjectId: owner.subjectId,
      groups: [],
      scopes: ["admin", "chat"],
    } as AccessContext
    next()
  }
  const app = createApp({
    db: sharedDb,
    eventsSource: entry.eventsSource,
    accessMiddleware: identity,
    retrievalScopeResolver: createRetrievalScopeResolver(knowledgeBases),
    knowledgeBaseService: knowledgeBases,
    assistants,
    conversationHistory: history,
  })
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    base,
    db: sharedDb,
    knowledgeBases,
    assistants,
    history,
    store,
    searches: searches.calls,
    draftSystemPrompts: stub.draftSystemPrompts,
    assistant(knowledgeBaseIds, systemPrompt) {
      return assistants.create(owner.tenantId, owner.subjectId, {
        name: "政策助手",
        config: assistantConfig(knowledgeBaseIds, systemPrompt),
      })
    },
    async chat(body) {
      const response = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stream: false, ...body }),
      })
      return {
        status: response.status,
        json: (await response.json().catch(() => null)) as Record<string, unknown> | null,
      }
    },
    async close() {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await runtime.close()
    },
  }
}

function routeDecision(json: Record<string, unknown> | null): string | undefined {
  for (const event of (json?.events ?? []) as AnswerRunEvent[]) {
    if (event.type === "progress" && event.stage === "route" && event.data.decision) {
      return String(event.data.decision)
    }
  }
  return undefined
}

function references(json: Record<string, unknown> | null): Array<{ id: string; chunkId: string }> {
  return (json?.references ?? []) as Array<{ id: string; chunkId: string }>
}

function assertEverySearchInScope(searches: ScopeObservation[], expected: string[], label: string): void {
  assert.ok(searches.length > 0, `${label}: the run must actually retrieve`)
  for (const search of searches) {
    assert.deepEqual(
      scopeIds(search.scope),
      expected,
      `${label}: every retrieval/stage keeps the authorized scope (query: ${search.query})`
    )
  }
}

test("DR-15: a clarification is continued with the missing parameter inside the locked scope", async () => {
  const owner = { tenantId: "tenant-continuation", subjectId: "owner-continuation" }
  const built = await harness(owner)
  const sessionId = "sess-continuation"
  try {
    const policy = built.knowledgeBases.create(owner.tenantId, "政策库")
    const other = built.knowledgeBases.create(owner.tenantId, "另一个库")
    const assistant = built.assistant([policy.id], "第一版提示词")

    // Turn 1: the question is genuinely missing its referent → clarification,
    // and the session lock freezes assistant version + authorized subset.
    const first = await built.chat({
      sessionId,
      assistantId: assistant.id,
      knowledgeBaseIds: [policy.id],
      message: MISSING_PARAMETER,
    })
    assert.equal(first.status, 200)
    assert.equal(first.json?.status, "clarification_required")
    assert.equal(routeDecision(first.json), "ambiguous")
    assert.equal(built.searches.length, 0, "a clarification makes no retrieval call")
    assert.deepEqual(built.history.getSessionLock(sessionId, owner.tenantId, owner.subjectId), {
      assistantId: assistant.id,
      assistantVersion: 1,
      knowledgeBaseIds: [policy.id],
    })
    assert.equal(
      built.store.peekPendingClarification(sessionId, owner.tenantId),
      MISSING_PARAMETER,
      "the pending clarification is durably recorded for the next turn"
    )

    // Turn 2: the assistant is edited (version 2, new prompt, new binding) and
    // the user supplies the missing parameter while naming the new version and
    // another base. The parameter completes the original task; the scope move
    // is not honored — every search keeps the locked subset and the run uses
    // the locked version 1, never the request's version 2.
    built.assistants.edit(assistant.id, owner.tenantId, "admin", {
      config: assistantConfig([other.id], "第二版提示词"),
    })
    const before = built.searches.length
    const beforeDrafts = built.draftSystemPrompts.length
    const second = await built.chat({
      sessionId,
      assistantId: assistant.id,
      knowledgeBaseIds: [other.id],
      message: SUPPLIED_PARAMETER,
    })
    assert.equal(second.status, 200)
    assert.equal(second.json?.status, "completed")
    assert.equal(routeDecision(second.json), "simple")
    assert.match(String(second.json?.reply), /14 天/)
    const drafts = built.draftSystemPrompts.slice(beforeDrafts).join("\n")
    assert.match(drafts, /第一版提示词/, "the locked assistant version is what runs")
    assert.doesNotMatch(drafts, /第二版提示词/)
    const cited = citedEvidenceId(String(second.json?.reply))
    assert.ok(cited, "the completed continuation cites its evidence")
    assert.equal(references(second.json)[0]?.id, cited)
    assert.equal(references(second.json)[0]?.chunkId, "chunk-return")
    assert.equal(
      built.store.peekPendingClarification(sessionId, owner.tenantId),
      null,
      "the continuation consumes the pending clarification"
    )
    assert.deepEqual(built.history.getSessionLock(sessionId, owner.tenantId, owner.subjectId), {
      assistantId: assistant.id,
      assistantVersion: 1,
      knowledgeBaseIds: [policy.id],
    })
    assertEverySearchInScope(built.searches.slice(before), [policy.id], "continuation")

    // Turn 3: a later attempt to swap BOTH the assistant (bound to 另一个库) and
    // the selection is refused as a scope change: the run still reads 政策库
    // under the locked version and answers from it.
    const otherAssistant = built.assistant([other.id])
    const beforeThird = built.searches.length
    const third = await built.chat({
      sessionId,
      assistantId: otherAssistant.id,
      knowledgeBaseIds: [other.id],
      message: RETURN_QUESTION,
    })
    assert.equal(third.status, 200)
    assert.equal(third.json?.status, "completed")
    assert.doesNotMatch(String(third.json?.reply), /30 天/)
    assert.equal(references(third.json)[0]?.chunkId, "chunk-return")
    assert.deepEqual(built.history.getSessionLock(sessionId, owner.tenantId, owner.subjectId), {
      assistantId: assistant.id,
      assistantVersion: 1,
      knowledgeBaseIds: [policy.id],
    })
    assertEverySearchInScope(built.searches.slice(beforeThird), [policy.id], "scope-change attempt")

    // The conversation read view keeps the whole scenario: the clarification,
    // the supplemented continuation and the answer that carries the citation.
    const history = built.history.getTurns(sessionId, owner.tenantId, owner.subjectId)
    assert.deepEqual(
      history.map((turn) => `${turn.role}:${turn.terminalStatus ?? "-"}`),
      [
        "user:-",
        "assistant:clarification_required",
        "user:-",
        "assistant:completed",
        "user:-",
        "assistant:completed",
      ]
    )
    assert.match(history[2].content, new RegExp(SUPPLIED_PARAMETER))
    assert.match(history[3].content, /\[cite:ev_[a-f0-9]+\]/)
  } finally {
    await built.close()
  }
})

test("DR-15: correcting a key condition replaces the old conclusion with new evidence", async () => {
  const owner = { tenantId: "tenant-correction", subjectId: "owner-correction" }
  const built = await harness(owner)
  const sessionId = "sess-correction"
  try {
    const policy = built.knowledgeBases.create(owner.tenantId, "政策库")
    const assistant = built.assistant([policy.id])

    const first = await built.chat({
      sessionId,
      assistantId: assistant.id,
      message: RETURN_QUESTION,
    })
    assert.equal(first.status, 200)
    assert.equal(first.json?.status, "completed")
    assert.match(String(first.json?.reply), /14 天/)
    assert.equal(references(first.json)[0]?.chunkId, "chunk-return")
    const oldCitation = references(first.json)[0]?.id

    // The user corrects the key condition. The rewritten standalone query is
    // what retrieval sees, so the new evidence (换货 30 天) is what is cited.
    const before = built.searches.length
    const second = await built.chat({
      sessionId,
      assistantId: assistant.id,
      message: CORRECTION,
    })
    assert.equal(second.status, 200)
    assert.equal(second.json?.status, "completed")
    assert.match(String(second.json?.reply), /30 天/)
    assert.doesNotMatch(String(second.json?.reply), /14 天/, "the old conclusion is not reused")
    assert.equal(references(second.json)[0]?.chunkId, "chunk-exchange")
    assert.notEqual(references(second.json)[0]?.id, oldCitation)
    assert.match(String(built.searches.at(-1)?.query), /换货/, "the correction reaches retrieval")
    assertEverySearchInScope(built.searches.slice(before), [policy.id], "correction")

    // The correction is the validated user turn, not a stale concatenation.
    const turns = built.store.loadRecentTurns(sessionId, owner.tenantId, 10)
    assert.deepEqual(turns.map((turn) => turn.role), ["user", "assistant", "user", "assistant"])
    assert.equal(turns[2].content, CORRECTION)
    assert.match(turns[3].content, /30 天/)
    // The prior answer is still history, but the corrected answer did not
    // recycle it: the old conclusion is only in the earlier turn.
    assert.match(turns[1].content, /14 天/)
  } finally {
    await built.close()
  }
})

test("DR-15: an empty first-turn scope stays empty when a later turn selects a knowledge base", async () => {
  const owner = { tenantId: "tenant-empty-scope", subjectId: "owner-empty-scope" }
  const built = await harness(owner)
  const sessionId = "sess-empty-scope"
  try {
    const policy = built.knowledgeBases.create(owner.tenantId, "政策库")
    const assistant = built.assistant([])

    const first = await built.chat({
      sessionId,
      assistantId: assistant.id,
      knowledgeBaseIds: [],
      message: RETURN_QUESTION,
    })
    assert.equal(first.status, 200)
    assert.equal(first.json?.status, "insufficient_retrieval")
    assert.deepEqual(references(first.json), [])
    assert.deepEqual(built.history.getSessionLock(sessionId, owner.tenantId, owner.subjectId), {
      assistantId: assistant.id,
      assistantVersion: 1,
      knowledgeBaseIds: [],
    })

    const before = built.searches.length
    const second = await built.chat({
      sessionId,
      assistantId: assistant.id,
      knowledgeBaseIds: [policy.id],
      message: RETURN_QUESTION,
    })
    assert.equal(second.status, 200)
    assert.equal(second.json?.status, "insufficient_retrieval", "an empty lock fails closed, never widens")
    assert.deepEqual(references(second.json), [], "no citation may appear outside the authorized scope")
    assert.equal(
      built.searches.length,
      before,
      "an empty locked scope never even dispatches a retrieval channel"
    )
    assert.deepEqual(built.history.getSessionLock(sessionId, owner.tenantId, owner.subjectId), {
      assistantId: assistant.id,
      assistantVersion: 1,
      knowledgeBaseIds: [],
    })
  } finally {
    await built.close()
  }
})

test("DR-15: a cross-tenant scope change is refused and keeps the pending continuation alive", async () => {
  const owner = { tenantId: "tenant-refused-scope", subjectId: "owner-refused-scope" }
  const built = await harness(owner)
  const sessionId = "sess-refused-scope"
  try {
    const policy = built.knowledgeBases.create(owner.tenantId, "政策库")
    const foreign = built.knowledgeBases.create("tenant-somebody-else", "外部库")
    const assistant = built.assistant([policy.id])

    const first = await built.chat({
      sessionId,
      assistantId: assistant.id,
      knowledgeBaseIds: [policy.id],
      message: MISSING_PARAMETER,
    })
    assert.equal(first.json?.status, "clarification_required")
    assert.equal(built.store.peekPendingClarification(sessionId, owner.tenantId), MISSING_PARAMETER)

    // A turn that tries to move the session onto another tenant's knowledge is
    // refused BEFORE any run: no retrieval, no answer, no scope widening — and
    // the pending clarification survives so the user can still continue.
    const before = built.searches.length
    const refused = await built.chat({
      sessionId,
      assistantId: assistant.id,
      knowledgeBaseIds: [foreign.id],
      message: SUPPLIED_PARAMETER,
    })
    assert.equal(refused.status, 404)
    assert.equal(built.searches.length, before, "a refused scope never starts retrieval")
    assert.equal(
      JSON.stringify(refused.json).includes(foreign.id),
      false,
      "the refusal must not confirm another tenant's id"
    )
    assert.equal(
      built.store.peekPendingClarification(sessionId, owner.tenantId),
      MISSING_PARAMETER,
      "the refused scope change does not consume the pending clarification"
    )
    assert.deepEqual(built.history.getSessionLock(sessionId, owner.tenantId, owner.subjectId), {
      assistantId: assistant.id,
      assistantVersion: 1,
      knowledgeBaseIds: [policy.id],
    })

    // The same pending can still be continued inside the original scope.
    const continued = await built.chat({
      sessionId,
      assistantId: assistant.id,
      message: SUPPLIED_PARAMETER,
    })
    assert.equal(continued.status, 200)
    assert.equal(continued.json?.status, "completed")
    assert.equal(references(continued.json)[0]?.chunkId, "chunk-return")
    assertEverySearchInScope(built.searches.slice(before), [policy.id], "after refusal")
    assert.equal(built.store.peekPendingClarification(sessionId, owner.tenantId), null)
  } finally {
    await built.close()
  }
})

test("DR-15: a second owner's correction never reads the first owner's session state", async () => {
  const ownerA = { tenantId: "tenant-matrix-a", subjectId: "owner-matrix-a" }
  const ownerB = { tenantId: "tenant-matrix-b", subjectId: "owner-matrix-b" }
  const builtA = await harness(ownerA)
  const builtB = await harness(ownerB)
  try {
    const policyA = builtA.knowledgeBases.create(ownerA.tenantId, "A 政策库")
    const policyB = builtB.knowledgeBases.create(ownerB.tenantId, "B 政策库")
    const assistantA = builtA.assistant([policyA.id])
    const assistantB = builtB.assistant([policyB.id])

    await builtA.chat({ sessionId: "shared-name", assistantId: assistantA.id, message: RETURN_QUESTION })
    assert.match(String(builtA.searches.at(-1)?.query), /退货/)

    // Same session name, different owner/DB: nothing from owner A is visible.
    const answerB = await builtB.chat({
      sessionId: "shared-name",
      assistantId: assistantB.id,
      message: CORRECTION,
    })
    assert.equal(answerB.status, 200)
    assert.equal(routeDecision(answerB.json), "simple")
    assert.equal(builtB.store.peekPendingClarification("shared-name", ownerB.tenantId), null)
    // Owner B's memory contains only B's own turn — owner A's question and
    // answer never cross the owner boundary even under the same session name.
    const turnsB = builtB.store.loadRecentTurns("shared-name", ownerB.tenantId, 10)
    assert.deepEqual(turnsB.map((turn) => turn.role), ["user", "assistant"])
    assert.equal(turnsB[0].content, CORRECTION)
    assert.equal(
      turnsB.some((turn) => turn.content.includes(RETURN_QUESTION)),
      false,
      "owner A's question is not part of owner B's conversation"
    )
    assertEverySearchInScope(builtB.searches, [policyB.id], "second owner")
  } finally {
    await builtA.close()
    await builtB.close()
  }
})
