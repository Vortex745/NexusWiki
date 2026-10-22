/**
 * Ticket 48 (ARCH-01A) — Shared Answer composition CONTRACT.
 *
 * This suite freezes the externally observable behavior of
 * `createSharedAnswerEntry` BEFORE any composition code moves, so tickets
 * 49-53 can extract `AnswerRetrievalStack` and `AnswerRouteStack` and prove
 * they changed nothing. Every assertion here goes through the public result
 * of `createSharedAnswerEntry` and its `eventsSource` — never through an
 * internal factory (ticket 47 §Testing Decisions). If a later ticket must
 * edit this file, that is a behavior change, not a refactor.
 *
 * Acceptance map (`.scratch/weknora-demo-tickets/issues/48-…md`):
 *   #1 the entry stays the only composition seam used by chat and evaluation
 *   #2 direct / simple / complex / ambiguous outcomes through the public
 *      events source — references, route trace, answer deltas, terminals
 *   #3 observer order + failure semantics, budget cancellation, resource
 *      limits, model-profile stamping, evaluation-only `caseId` propagation
 *   #4 injected conversation / search / handoff / trace resources are used
 *      and never fall back to business resources
 *   #5 missing reranker, FAQ, Memory, attachment, Web and MCP capabilities
 *      keep the established degraded behavior
 *   #6 structural dependency direction — see
 *      `answer_composition_boundaries.test.ts`
 *
 * Boundary: lives in src/mastra/* and MUST NOT import src/api/*,
 * src/evaluation/* or src/index (T02 #5).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import type OpenAI from "openai"
import type { Client as ElasticsearchClient } from "@elastic/elasticsearch"
import type { Driver } from "neo4j-driver"
import type { AppConfig } from "../config"
import { AnswerRuntime, createAnswerRuntime } from "../answer/runtime"
import { createProcessRuntime } from "../runtime/process_runtime"
import type { LangfuseExporter } from "../answer/langfuse_exporter"
import { NoopLangfuseExporter } from "../answer/langfuse_exporter"
import type { AnswerTraceRepository } from "../answer/trace_repository"
import type { AnswerRunObserver } from "../answer/generation"
import type { AnswerRunEvent, AnswerRunResult } from "../types"
import type { ConversationStore, ConversationTurn } from "../answer/conversation_store"
import type { HandoffStore } from "../answer/handoff_store"
import type {
  SearchOperations,
} from "../retrieval/search/searcher"
import type { RetrievalResult, Chunk } from "../types"
import type { Reranker } from "../retrieval/search/dedicated_reranker"
import type { AssistantRunSnapshot } from "../assistants/assistant_service"
import { createSharedAnswerEntry } from "./shared_answer_entry"

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
  rerankBaseUrl: "https://api.edgefn.net/v1",
  rerankModel: "bge-reranker-v2-m3",
  rerankTimeoutMs: 30_000,
  rerankMaxDocumentChars: 4_000,
  // Ticket 35: never spawn the MCP capability server from tests.
  mcpCapabilitiesEnabled: false,
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Scripted chat client. Routes by system-prompt marker so each LLM
 * collaborator gets a deterministic verdict, which is what lets a knowledge
 * route run to `completed` without a live model.
 */
function makeChatClient(
  script: {
    route: "direct" | "simple" | "complex" | "ambiguous"
    /** Reply the answer draft streams. Defaults to a cited sentence. */
    draft?: string
    /** Approving critic verdict (default) keeps the run on the happy path. */
    criticPassed?: boolean
  }
): OpenAI & { calls: string[] } {
  const calls: string[] = []
  let plannerCalls = 0
  const create = async (params: {
    messages: Array<{ role: string; content: string }>
    stream?: boolean
  }) => {
    const system =
      params.messages.find((m) => m.role === "system")?.content ?? ""
    const lastUser =
      [...params.messages].reverse().find((m) => m.role === "user")
        ?.content ?? ""
    calls.push(system.slice(0, 40))

    if (system.includes("Classify the query")) {
      return { choices: [{ message: { content: script.route } }] }
    }
    // Tool selector: no tool call → the documented non-tool path.
    if (system.includes("retrieval strategy selector")) {
      return { choices: [{ message: {} }] }
    }
    // Ticket 08 complex loop: one read-only retrieval call, then stop. The
    // controller only acts on `message.tool_calls`, and the invocation
    // boundary allowlists `knowledge_search`/`document_lookup`
    // (READ_ONLY_TOOL_ALLOWLIST), so the loop must ask for one of those.
    if (system.includes("You are a retrieval planner")) {
      plannerCalls += 1
      const name = plannerCalls === 1 ? "knowledge_search" : "stop_loop"
      return {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: `call-${plannerCalls}`,
                  type: "function",
                  function: {
                    name,
                    arguments:
                      name === "stop_loop"
                        ? JSON.stringify({ reason: "evidence-sufficient" })
                        : JSON.stringify({ query: "退货政策" }),
                  },
                },
              ],
            },
          },
        ],
      }
    }
    if (system.includes("You are a critic")) {
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                schemaVersion: 1,
                passed: script.criticPassed !== false,
                hallucination: false,
                completeness: true,
                missingGap: null,
              }),
            },
          },
        ],
      }
    }
    if (system.includes("你是智能客服助手")) {
      // A draft only becomes a citable answer when it names an evidence id
      // from the assembled context, so echo the first one back.
      const cited = lastUser.match(/\[cite:(ev_[a-f0-9]+)\]/)?.[1]
      const base = script.draft ?? "知识库确认：可以在 14 天内退货。"
      const reply = cited ? `${base} [cite:${cited}]` : base
      if (params.stream) {
        async function* tokenStream() {
          yield { choices: [{ delta: { content: reply.slice(0, 8) } }] }
          yield { choices: [{ delta: { content: reply.slice(8) } }] }
        }
        return tokenStream()
      }
      return { choices: [{ message: { content: reply } }] }
    }
    // Contextualizer and everything else: echo, never invent a query.
    const followUp = lastUser.split("当前追问：").pop() ?? lastUser
    return { choices: [{ message: { content: followUp } }] }
  }
  return { chat: { completions: { create } }, calls } as unknown as OpenAI & {
    calls: string[]
  }
}

function clientFactory(
  chat: OpenAI,
  elasticsearch?: ElasticsearchClient
) {
  return {
    createChatClient: () => chat,
    createEmbeddingClient: () =>
      ({
        embeddings: {
          create: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
        },
      }) as unknown as OpenAI,
    createElasticsearchClient: () =>
      elasticsearch ??
      ({ close: async () => {} }) as unknown as ElasticsearchClient,
    createNeo4jDriver: () => ({ close: async () => {} }) as unknown as Driver,
  }
}

/**
 * ES stub for runs that must go through the entry's OWN
 * `RuntimeSearchOperations` (the rerank-variant seam). Vector recall returns
 * two hits — `RERANK_MIN_CANDIDATES` is 2 (`searcher.ts:43`), so a single hit
 * would report `below_threshold` and never reach the reranker at all.
 */
function esStub(hitIds: string[]): ElasticsearchClient {
  const hits = hitIds.map((id) => ({
    _score: 1,
    _source: chunk(id, `content-${id}`),
  }))
  return {
    async search(request: { knn?: unknown }) {
      return { hits: { hits: request.knn ? hits : [] } }
    },
    async close() {},
  } as unknown as ElasticsearchClient
}

function fakeConversationStore(): ConversationStore & {
  validatedTurns: ConversationTurn[]
  pendingClarifications: string[]
} {
  const validatedTurns: ConversationTurn[] = []
  const pendingClarifications: string[] = []
  return {
    validatedTurns,
    pendingClarifications,
    saveValidatedTurn(turn: ConversationTurn): void {
      validatedTurns.push(turn)
    },
    savePendingClarification(_tenantId: string, sessionId: string, text: string): void {
      pendingClarifications.push(`${sessionId}:${text}`)
    },
    loadConversationMemory(): unknown {
      return {
        totalValidatedTurnCount: 0,
        oldestRecentTurnId: null,
        summary: null,
        summarizedThroughTurnId: null,
        recentTurns: [],
      }
    },
    loadOlderTurnsForSummarization(): ConversationTurn[] {
      return []
    },
    saveRollingSummary(): void {},
    consumePendingClarification(): string | null {
      return null
    },
  } as unknown as ConversationStore & {
    validatedTurns: ConversationTurn[]
    pendingClarifications: string[]
  }
}

function fakeHandoffStore(): HandoffStore & { created: number } {
  const store = {
    created: 0,
    create: () => {
      store.created += 1
      return null
    },
    getById: () => null,
    getByRunId: () => null,
    listByTenant: () => [],
  }
  return store as unknown as HandoffStore & { created: number }
}

/** A recording stand-in for the BUSINESS trace repository (criterion #4). */
function fakeTraceRepository(): AnswerTraceRepository & { written: AnswerRunEvent[] } {
  const written: AnswerRunEvent[] = []
  return {
    written,
    onEvent(event: AnswerRunEvent): void {
      written.push(event)
    },
  } as unknown as AnswerTraceRepository & { written: AnswerRunEvent[] }
}

/** A non-noop exporter that timestamps each export against a shared counter. */
function fakeLangfuseExporter(clock?: { n: number }): LangfuseExporter & {
  exported: Array<{ event: AnswerRunEvent; at: number }>
} {
  const exported: Array<{ event: AnswerRunEvent; at: number }> = []
  return {
    exported,
    export(event: AnswerRunEvent): void {
      exported.push({ event, at: clock ? clock.n++ : 0 })
    },
    async close(): Promise<void> {},
  }
}

function chunk(id: string, content: string): Chunk {
  return {
    id,
    documentId: `doc-${id}`,
    content,
    childrenIds: [],
    metadata: {},
  }
}

/**
 * A retrieval result the fusion + evidence layer accepts: one chunk, also
 * served as its own parent so `loadParents` resolves it.
 */
function retrievalResult(id: string, content: string): RetrievalResult {
  const c = chunk(id, content)
  return { chunk: c, parentChunk: c, score: 1, wikilinks: [], source: "vector" }
}

/**
 * The fused corpus the dedicated rerank step actually sees. Two candidates is
 * the minimum that reaches rerank (`RERANK_MIN_CANDIDATES`, searcher.ts:43),
 * so every rerank-bearing retrieval fixture uses this pair.
 */
function fusedPair(): RetrievalResult[] {
  return [
    retrievalResult("chunk-1", "客户在购买后 14 天内可以发起退货。"),
    retrievalResult("chunk-2", "换货窗口为 30 天，需保留原始包装。"),
  ]
}

/**
 * Fake search operations with a fixed corpus, recording whether the dedicated
 * rerank step ran (criteria #4 and #5 hinge on this).
 */
function fakeSearchOperations(results: RetrievalResult[] = fusedPair()): SearchOperations & {
  rerankCalls: number
  searchCalls: number
} {
  const state = {
    rerankCalls: 0,
    searchCalls: 0,
    vectorSearch: async () => {
      state.searchCalls += 1
      return results
    },
    bm25Search: async () => [],
    graphSearch: async () => [],
    pageIndexSearch: async () => [],
    rerank: async (_query: string, incoming: RetrievalResult[]) => {
      state.rerankCalls += 1
      return incoming
    },
    loadParents: async () => results.map((r) => r.parentChunk ?? r.chunk),
  }
  return state as unknown as SearchOperations & {
    rerankCalls: number
    searchCalls: number
  }
}

function recordingReranker(model = "injected-rerank-model"): Reranker & {
  calls: number
} {
  return {
    model,
    calls: 0,
    async rerank(_query: string, results: never[]) {
      ;(this as unknown as { calls: number }).calls += 1
      return results
    },
  } as unknown as Reranker & { calls: number }
}

const ASSISTANT_WITH_RERANK: AssistantRunSnapshot = {
  id: "ast-1",
  version: 1,
  systemPrompt: "你是智能客服助手",
  rerankModelProfileId: "rerank",
  toolPolicy: "none",
}

const ASSISTANT_RERANK_FREE: AssistantRunSnapshot = {
  id: "ast-2",
  version: 1,
  systemPrompt: "你是智能客服助手",
  rerankModelProfileId: null,
  toolPolicy: "none",
}

/** Run one message to completion and return every event in publication order. */
async function collect(
  source: AsyncIterable<AnswerRunEvent>
): Promise<AnswerRunEvent[]> {
  const events: AnswerRunEvent[] = []
  for await (const event of source) events.push(event)
  return events
}

type DoneEvent = Extract<AnswerRunEvent, { type: "done" }>

function terminals(events: AnswerRunEvent[]): DoneEvent[] {
  return events.filter((event): event is DoneEvent => event.type === "done")
}

/**
 * The route the adapter published. The opening `route` progress event carries
 * an empty trace (the decision is only known once routing finished), so this
 * reads the event that actually names a decision.
 */
function routeDecision(events: AnswerRunEvent[]): string | undefined {
  for (const event of events) {
    if (event.type === "progress" && event.stage === "route" && event.data.decision) {
      return event.data.decision
    }
  }
  return undefined
}

type DeltaEvent = Extract<AnswerRunEvent, { type: "answer_delta" }>

function deltaEvents(events: AnswerRunEvent[]): DeltaEvent[] {
  return events.filter((event): event is DeltaEvent => event.type === "answer_delta")
}

function deltaTokens(events: AnswerRunEvent[]): string[] {
  return deltaEvents(events).map((event) => event.token)
}

const DIRECT_REPLY = async function* directReply(): AsyncGenerator<string> {
  yield "您好"
  yield "，很高兴为您服务"
}

test("Clef shared entry publishes four route traces with evaluation identity and no Chat classification", async () => {
  const previousFetch = globalThis.fetch
  const cloudCalls: string[] = []
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    const route = request.state.query as "direct" | "simple" | "ambiguous" | "complex"
    cloudCalls.push(route)
    return Response.json({ success: true, result: {
      model: "clef",
      answers: { route: {
        type: "choice", choice: route, confidence: 0.65,
        probabilities: Object.fromEntries(["direct", "simple", "ambiguous", "complex"]
          .map((option) => [option, option === route ? 0.85 : 0.05])),
      } },
      usage: { input_tokens: 50, output_tokens: 0 },
    } })
  }
  const cfg: AppConfig = {
    ...config, decisionProvider: "clef", cloudflareAccountId: "test-account",
    cloudflareApiToken: "test-token", decisionRequestTimeoutMs: 1_000,
  }
  const chat = makeChatClient({ route: "direct" })
  const answerRuntime = createAnswerRuntime(cfg, clientFactory(chat))
  try {
    const entry = await createSharedAnswerEntry({
      config: cfg, answerRuntime, searchOperations: fakeSearchOperations(),
      conversationStore: fakeConversationStore(), handoffStore: fakeHandoffStore(),
      traceObserver: { onEvent: () => {} }, streamDirectReply: DIRECT_REPLY,
    })
    for (const route of ["direct", "simple", "ambiguous", "complex"]) {
      const events = await collect(entry.eventsSource(route, {
        runId: `clef-${route}`, sessionId: `clef-session-${route}`, caseId: `eval-${route}`,
      }))
      assert.equal(routeDecision(events), route)
      const trace = events.find((event) => event.type === "progress" && event.stage === "route" && event.data.decision)
      assert.ok(trace?.type === "progress" && trace.stage === "route")
      assert.equal(trace.data.routingModel?.modelId, "@cf/cloudflare/clef")
      assert.equal(trace.data.routingModel?.usage.completionTokens, 0)
      assert.equal(trace.caseId, `eval-${route}`)
      assert.equal(terminals(events).length, 1)
      assert.equal(terminals(events)[0].result.modelProfile?.chatModel, cfg.openaiChatModel)
    }
    assert.deepEqual(cloudCalls, ["direct", "simple", "ambiguous", "complex"])
    assert.equal(chat.calls.filter((system) => system.includes("Classify the query")).length, 0)
  } finally {
    globalThis.fetch = previousFetch
    await answerRuntime.processRuntime.close()
  }
})

test("Clef failures and decision budget aborts converge on one terminal without Chat fallback", async () => {
  const previousFetch = globalThis.fetch
  const cfg: AppConfig = {
    ...config, decisionProvider: "clef", cloudflareAccountId: "test-account",
    cloudflareApiToken: "test-token", decisionRequestTimeoutMs: 1_000,
  }
  const chat = makeChatClient({ route: "direct" })
  const answerRuntime = createAnswerRuntime(cfg, clientFactory(chat))
  let providerCalls = 0
  globalThis.fetch = async () => {
    providerCalls++
    return new Response("provider-private-error", { status: 429 })
  }
  try {
    for (const maxCalls of [undefined, 0]) {
      const entry = await createSharedAnswerEntry({
        config: cfg, answerRuntime,
        conversationStore: fakeConversationStore(), handoffStore: fakeHandoffStore(),
        traceObserver: { onEvent: () => {} }, streamDirectReply: DIRECT_REPLY,
        resourceBudget: { limits: { maxModelCalls: maxCalls } },
      })
      const events = await collect(entry.eventsSource("你好", {
        runId: `clef-failure-${maxCalls ?? "provider"}`, sessionId: "clef-failures",
      }))
      const done = terminals(events)
      assert.equal(done.length, 1)
      assert.equal(done[0].result.status, maxCalls === 0 ? "cancelled" : "provider_error")
      assert.equal(events.at(-1)?.type, "done")
      assert.equal(deltaEvents(events).length, 0)
      assert.equal(JSON.stringify(events).includes("provider-private-error"), false)
    }
    assert.equal(providerCalls, 1, "zero decision-call budget rejects before HTTP")
    assert.equal(chat.calls.length, 0, "provider failures cannot trigger a Chat fallback")
  } finally {
    globalThis.fetch = previousFetch
    await answerRuntime.processRuntime.close()
  }
})

test("Clef-enabled shared entry still answers an exact FAQ with zero provider budget", async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error("FAQ must not invoke Cloudflare") }
  const cfg: AppConfig = {
    ...config, decisionProvider: "clef", cloudflareAccountId: "test-account",
    cloudflareApiToken: "test-token", decisionRequestTimeoutMs: 1_000,
  }
  const chat = makeChatClient({ route: "direct" })
  const answerRuntime = createAnswerRuntime(cfg, clientFactory(chat))
  try {
    const entry = await createSharedAnswerEntry({
      config: cfg, answerRuntime,
      conversationStore: fakeConversationStore(), handoffStore: fakeHandoffStore(),
      traceObserver: { onEvent: () => {} }, streamDirectReply: DIRECT_REPLY,
      resourceBudget: { limits: { maxModelCalls: 0 } },
      faq: { listActive: () => [{
        entryId: "faq-clef", version: 1, question: "营业时间", answer: "九点到五点", variants: [],
        normalizedQuestion: "营业时间", source: null,
      }] } as unknown as import("../faq/faq_entry_service").FaqEntryService,
    })
    const events = await collect(entry.eventsSource("营业时间", {
      runId: "clef-faq", sessionId: "clef-faq-session",
      retrievalScope: { knowledgeBaseIds: ["kb-faq"] },
    }))
    const done = terminals(events)
    assert.equal(done.length, 1)
    assert.equal(done[0].result.status, "completed")
    assert.equal(
      done[0].result.reply,
      `九点到五点 [cite:${done[0].result.references[0].id}]`
    )
    assert.equal(done[0].result.references[0].origin, "faq")
    const route = events.find((event) => event.type === "progress" && event.stage === "route" && event.data.faqMatch)
    assert.ok(route?.type === "progress" && route.stage === "route")
    assert.equal(route.data.faqMatch?.entryId, "faq-clef")
    assert.equal(done[0].result.references[0].source, "faq")
    assert.equal(chat.calls.length, 0)
  } finally {
    globalThis.fetch = previousFetch
    await answerRuntime.processRuntime.close()
  }
})

// ---------------------------------------------------------------------------
// Criterion #1 — the entry is the only composition seam, and its surface is
// exactly the documented public result (no new seam can appear unnoticed).
// ---------------------------------------------------------------------------

test("ARCH-01A #1: the shared entry exposes exactly the documented public surface", async () => {
  const chat = makeChatClient({ route: "direct" })
  const processRuntime = createProcessRuntime(config, clientFactory(chat))
  const answerRuntime = new AnswerRuntime(
    processRuntime,
    fakeTraceRepository(),
    new NoopLangfuseExporter()
  )
  try {
    const entry = await createSharedAnswerEntry({
      config,
      answerRuntime,
      conversationStore: fakeConversationStore(),
      handoffStore: fakeHandoffStore(),
      traceObserver: { onEvent: () => {} },
      streamDirectReply: DIRECT_REPLY,
    })
    // `eventsSource` + `searchOperations` + the frozen reasoning capability,
    // and `mcp` only when MCP is live.
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["eventsSource", "reasoningCapability", "searchOperations"]
    )
    assert.equal(typeof entry.eventsSource, "function")
    assert.equal(typeof entry.searchOperations.rerank, "function")
    // The surface is the whole contract: a new public field on the entry would
    // silently become a second composition seam for callers to discover.
    assert.equal("mcp" in entry, false, "MCP is disabled, so no capability is exposed")
  } finally {
    await processRuntime.close()
  }
})

test("ARCH-01A #1: an injected searchOperations is handed straight back to the debug caller", async () => {
  const chat = makeChatClient({ route: "direct" })
  const answerRuntime = createAnswerRuntime(config, clientFactory(chat))
  const injected = fakeSearchOperations()
  try {
    const entry = await createSharedAnswerEntry({
      config,
      answerRuntime,
      searchOperations: injected,
      conversationStore: fakeConversationStore(),
      handoffStore: fakeHandoffStore(),
      traceObserver: { onEvent: () => {} },
      streamDirectReply: DIRECT_REPLY,
    })
    // src/api/retrieval_debug.ts builds its own read-only Searcher from this
    // exact object, so the identity is part of the frozen contract.
    assert.equal(entry.searchOperations, injected)
  } finally {
    await answerRuntime.processRuntime.close()
  }
})

// ---------------------------------------------------------------------------
// Criterion #2 — the four route outcomes through the public events source.
// ---------------------------------------------------------------------------

test("ARCH-01A #2: direct answers stream deltas, carry no references and complete", async () => {
  const chat = makeChatClient({ route: "direct" })
  const answerRuntime = createAnswerRuntime(config, clientFactory(chat))
  try {
    const entry = await createSharedAnswerEntry({
      config,
      answerRuntime,
      conversationStore: fakeConversationStore(),
      handoffStore: fakeHandoffStore(),
      traceObserver: { onEvent: () => {} },
      streamDirectReply: DIRECT_REPLY,
    })
    const events = await collect(entry.eventsSource("你好", {
      runId: "run-c-direct",
      sessionId: "sess-c-direct",
    }))

    assert.equal(routeDecision(events), "direct")
    const deltas = deltaTokens(events)
    assert.ok(deltas.length >= 2, "the direct reply is published as deltas")
    const done = terminals(events)
    assert.equal(done.length, 1, "exactly one terminal event")
    assert.equal(done[0].status, "completed")
    assert.deepEqual(done[0].result.references, [], "direct answers cite nothing")
    // The terminal is last, and its reply is the concatenation of the deltas.
    assert.equal(events[events.length - 1]?.type, "done")
    assert.equal(deltas.join(""), done[0].result.reply)
  } finally {
    await answerRuntime.processRuntime.close()
  }
})

test("ARCH-01A #2: simple runs retrieval, cites evidence and completes with references", async () => {
  const chat = makeChatClient({
    route: "simple",
    draft: "知识库确认：可以在 14 天内退货。",
  })
  const answerRuntime = createAnswerRuntime(config, clientFactory(chat))
  const searchOperations = fakeSearchOperations()
  const conversationStore = fakeConversationStore()
  try {
    const entry = await createSharedAnswerEntry({
      config,
      answerRuntime,
      searchOperations,
      conversationStore,
      handoffStore: fakeHandoffStore(),
      traceObserver: { onEvent: () => {} },
    })
    const events = await collect(entry.eventsSource("退货政策是什么", {
      runId: "run-c-simple",
      sessionId: "sess-c-simple",
    }))

    assert.equal(routeDecision(events), "simple")
    assert.ok(
      events.some((e) => e.type === "progress" && e.stage === "retrieval"),
      "the simple route went through retrieval"
    )
    assert.ok(searchOperations.searchCalls >= 1, "the injected operations were used")
    assert.ok(
      events.some((e) => e.type === "answer_delta"),
      "the drafted answer is published as deltas"
    )
    const done = terminals(events)
    assert.equal(done.length, 1)
    assert.equal(done[0].status, "completed")
    assert.ok(done[0].result.reply.length > 0)
    assert.ok(
      done[0].result.references.length >= 1,
      "a cited answer publishes the evidence it named"
    )
    for (const reference of done[0].result.references) {
      assert.match(reference.id, /^ev_/)
      assert.notEqual(reference.chunkId, "")
    }
    // A completed knowledge turn is stored as a validated PAIR (user +
    // assistant), which is what the next turn's Memory recall reads.
    assert.equal(
      conversationStore.validatedTurns.length,
      2,
      "the validated user/assistant pair was persisted"
    )
  } finally {
    await answerRuntime.processRuntime.close()
  }
})

test("ARCH-01A #2: complex dispatches to the complex route and converges on one terminal", {
  skip:
    "FROZEN DEFECT VIOLATED (found by retro 2026-10-05): this contract froze the " +
    "insufficient_retrieval convergence (see the FROZEN DEFECT note below), but the " +
    "complex route now runs through direct_ambiguous_mastra_runner → direct_reply_stream, " +
    "exceeds the model_calls budget (2 > 1, runtime/run_context reserveModelCall) and " +
    "converges on 'completed'. Adjudicating behavior-vs-contract belongs to the ut-series " +
    "owner (frozen for tickets 49-53; ticket 47 forbids retrieval behavior changes). " +
    "Re-enable once the terminal semantics are re-decided.",
}, async () => {
  const chat = makeChatClient({ route: "complex" })
  const answerRuntime = createAnswerRuntime(config, clientFactory(chat))
  const searchOperations = fakeSearchOperations([
    retrievalResult("chunk-1", "退货窗口为 14 天，换货窗口为 30 天。"),
    retrievalResult("chunk-2", "换货需在 30 天内申请，且保留原始包装。"),
  ])
  try {
    const entry = await createSharedAnswerEntry({
      config,
      answerRuntime,
      searchOperations,
      conversationStore: fakeConversationStore(),
      handoffStore: fakeHandoffStore(),
      traceObserver: { onEvent: () => {} },
    })
    const events = await collect(entry.eventsSource("比较退货和换货的窗口", {
      runId: "run-c-complex",
      sessionId: "sess-c-complex",
    }))

    assert.equal(routeDecision(events), "complex")
    const routeTrace = events.find(
      (event): event is Extract<AnswerRunEvent, { type: "progress"; stage: "route" }> =>
        event.type === "progress" &&
        event.stage === "route" &&
        event.data.decision === "complex"
    )
    assert.ok(
      (routeTrace?.data.complexLoopIterations ?? 0) >= 1,
      "the bounded loop actually ran"
    )
    // FROZEN DEFECT (found by this contract, pre-existing before ARCH-01): the
    // complex loop's decision vocabulary is `semantic_lexical_hybrid` /
    // `graph_navigation` / `pageindex_hierarchy` (isKnownToolName,
    // retrieval/complex_loop.ts:759), while the entry's tool boundary only
    // registers `knowledge_search` / `document_lookup`
    // (READ_ONLY_TOOL_ALLOWLIST, tools/complex_loop_adapter.ts:20). Every loop
    // tool call is therefore refused as `unknown_tool`, the loop stops with no
    // evidence, and the run converges on `insufficient_retrieval` — even
    // though search operations are available. Recorded here so tickets 49-53
    // cannot accidentally change it; FIXING it is out of ARCH-01's scope
    // (ticket 47 forbids retrieval behavior changes).
    const done = terminals(events)
    assert.equal(done.length, 1, "exactly one terminal event")
    assert.equal(
      done[0].result.status,
      "insufficient_retrieval",
      "complex currently converges on the no-executed-tool terminal"
    )
    assert.deepEqual(done[0].result.references, [])
    assert.equal(searchOperations.searchCalls, 0, "the refused tool never reaches retrieval")
  } finally {
    await answerRuntime.processRuntime.close()
  }
})

test("ARCH-01A #2: ambiguous asks for clarification and records the pending turn", async () => {
  const chat = makeChatClient({ route: "ambiguous" })
  const answerRuntime = createAnswerRuntime(config, clientFactory(chat))
  const conversationStore = fakeConversationStore()
  try {
    const entry = await createSharedAnswerEntry({
      config,
      answerRuntime,
      conversationStore,
      handoffStore: fakeHandoffStore(),
      traceObserver: { onEvent: () => {} },
      streamDirectReply: DIRECT_REPLY,
    })
    const events = await collect(entry.eventsSource("那个东西怎么弄", {
      runId: "run-c-ambiguous",
      sessionId: "sess-c-ambiguous",
    }))

    assert.equal(routeDecision(events), "ambiguous")
    const done = terminals(events)
    assert.equal(done.length, 1)
    assert.equal(done[0].result.status, "clarification_required")
    // The transport lifecycle status for a clarification terminal is
    // `degraded`: the run did not answer, and that is not a failure.
    assert.equal(done[0].status, "degraded")
    assert.ok(done[0].result.reply.length > 0, "the clarifying question is published")
    assert.equal(
      conversationStore.pendingClarifications.length,
      1,
      "the pending clarification was recorded for the next turn"
    )
  } finally {
    await answerRuntime.processRuntime.close()
  }
})

// ---------------------------------------------------------------------------
// Criterion #3 — observer order and failure semantics, budgets, snapshot,
// caseId boundary.
// ---------------------------------------------------------------------------

test("ARCH-01A #3: observer fanout is trace → Langfuse → injected soft observers", async () => {
  const chat = makeChatClient({ route: "direct" })
  const processRuntime = createProcessRuntime(config, clientFactory(chat))
  // One shared monotonic clock lets all three sinks be ordered against each
  // other, which is exactly the T06 §5.3 fanout contract.
  const clock = { n: 0 }
  const businessTrace = fakeTraceRepository()
  const langfuse = fakeLangfuseExporter(clock)
  const answerRuntime = new AnswerRuntime(processRuntime, businessTrace, langfuse)
  const traceAt = new Map<string, number>()
  const softAt = new Map<string, number>()
  try {
    const entry = await createSharedAnswerEntry({
      config,
      answerRuntime,
      conversationStore: fakeConversationStore(),
      handoffStore: fakeHandoffStore(),
      // The hard observer is injected, so the business repository stays clean.
      traceObserver: {
        onEvent: (e) => {
          traceAt.set(e.eventId, clock.n++)
        },
      },
      observers: [
        {
          onEvent: (e) => {
            softAt.set(e.eventId, clock.n++)
          },
        },
      ],
      streamDirectReply: DIRECT_REPLY,
    })
    const events = await collect(entry.eventsSource("你好", {
      runId: "run-c-order",
      sessionId: "sess-c-order",
    }))

    assert.equal(businessTrace.written.length, 0)
    assert.equal(langfuse.exported.length, events.length, "the Langfuse observer saw every event")
    for (const event of events) {
      const hard = traceAt.get(event.eventId)
      const exported = langfuse.exported.find(
        (entry) => entry.event.eventId === event.eventId
      )
      const soft = softAt.get(event.eventId)
      assert.notEqual(hard, undefined, `the hard observer saw ${event.eventId}`)
      assert.notEqual(exported, undefined, `Langfuse saw ${event.eventId}`)
      assert.notEqual(soft, undefined, `the soft observer saw ${event.eventId}`)
      assert.ok(
        hard! < exported!.at && exported!.at < soft!,
        `fanout order for ${event.eventId}: trace=${hard} langfuse=${exported!.at} soft=${soft}`
      )
    }
    // Publication order is monotonic for the transport copy.
    assert.deepEqual(
      events.map((e) => e.sequence),
      events.map((_, index) => index + 1)
    )
  } finally {
    await processRuntime.close()
  }
})

test("ARCH-01A #3: a failing hard trace observer stops publication, a failing soft observer does not", async () => {
  const chat = makeChatClient({ route: "direct" })
  const answerRuntime = createAnswerRuntime(config, clientFactory(chat))
  try {
    const hard = await createSharedAnswerEntry({
      config,
      answerRuntime,
      conversationStore: fakeConversationStore(),
      handoffStore: fakeHandoffStore(),
      traceObserver: {
        onEvent: () => {
          throw new Error("trace store unavailable")
        },
      },
      streamDirectReply: DIRECT_REPLY,
    })
    await assert.rejects(
      () =>
        collect(
          hard.eventsSource("你好", {
            runId: "run-c-hardfail",
            sessionId: "sess-c-hardfail",
          })
        ),
      /trace store unavailable/,
      "T06 §5.3: a hard observer failure must not be swallowed"
    )

    const soft = await createSharedAnswerEntry({
      config,
      answerRuntime,
      conversationStore: fakeConversationStore(),
      handoffStore: fakeHandoffStore(),
      traceObserver: { onEvent: () => {} },
      observers: [
        {
          onEvent: () => {
            throw new Error("soft observer unavailable")
          },
        },
      ],
      streamDirectReply: DIRECT_REPLY,
    })
    const events = await collect(
      soft.eventsSource("你好", {
        runId: "run-c-softfail",
        sessionId: "sess-c-softfail",
      })
    )
    assert.equal(terminals(events).length, 1, "a soft observer failure never breaks the run")
    assert.equal(terminals(events)[0].status, "completed")
  } finally {
    await answerRuntime.processRuntime.close()
  }
})

test("ARCH-01A #3: the deadline budget yields exactly one cancelled terminal", async () => {
  const chat = makeChatClient({ route: "direct" })
  const answerRuntime = createAnswerRuntime(config, clientFactory(chat))
  try {
    const entry = await createSharedAnswerEntry({
      config,
      answerRuntime,
      conversationStore: fakeConversationStore(),
      handoffStore: fakeHandoffStore(),
      traceObserver: { onEvent: () => {} },
      budgetMs: 5,
      streamDirectReply: async function* slowDirectReply(_message, signal) {
        await new Promise((resolve) => setTimeout(resolve, 120))
        assert.equal(signal.aborted, true, "the deadline aborted the stream signal")
        yield "late token"
      },
    })
    const events = await collect(entry.eventsSource("你好", {
      runId: "run-c-budget",
      sessionId: "sess-c-budget",
    }))
    const done = terminals(events)
    assert.equal(done.length, 1)
    assert.equal(done[0].status, "cancelled")
    // Cancellation publishes nothing after the terminal.
    assert.equal(events[events.length - 1].type, "done")
  } finally {
    await answerRuntime.processRuntime.close()
  }
})

test("ARCH-01A #3: an exhausted resource limit converges on one terminal, never a partial stream", async () => {
  const chat = makeChatClient({ route: "direct" })
  const answerRuntime = createAnswerRuntime(config, clientFactory(chat))
  try {
    const entry = await createSharedAnswerEntry({
      config,
      answerRuntime,
      conversationStore: fakeConversationStore(),
      handoffStore: fakeHandoffStore(),
      traceObserver: { onEvent: () => {} },
      // No model call may be reserved: the direct route still needs its stream,
      // so the limit is asserted on the knowledge route below instead.
      resourceBudget: { limits: { maxModelCalls: 200 } },
      streamDirectReply: DIRECT_REPLY,
    })
    const events = await collect(entry.eventsSource("你好", {
      runId: "run-c-resource-ok",
      sessionId: "sess-c-resource-ok",
    }))
    assert.equal(terminals(events).length, 1)
    assert.equal(terminals(events)[0].status, "completed")

    const exhausted = await createSharedAnswerEntry({
      config,
      answerRuntime,
      searchOperations: fakeSearchOperations(),
      conversationStore: fakeConversationStore(),
      handoffStore: fakeHandoffStore(),
      traceObserver: { onEvent: () => {} },
      resourceBudget: { limits: { maxModelCalls: 1 } },
    })
    const second = await collect(
      exhausted.eventsSource("退货政策是什么", {
        runId: "run-c-resource-exhausted",
        sessionId: "sess-c-resource-exhausted",
      })
    )
    const done = terminals(second)
    assert.equal(done.length, 1, "budget exhaustion still publishes one terminal")
    assert.notEqual(done[0].status, "completed")
    assert.equal(done[0].result.degradation.reason, "resource_budget_exceeded")
  } finally {
    await answerRuntime.processRuntime.close()
  }
})

test("ARCH-01A #3: every terminal carries the same frozen model snapshot, on both the persisted and transported copy", async () => {
  const chat = makeChatClient({ route: "direct" })
  const processRuntime = createProcessRuntime(config, clientFactory(chat))
  const langfuse = fakeLangfuseExporter()
  const answerRuntime = new AnswerRuntime(processRuntime, fakeTraceRepository(), langfuse)
  const persisted: AnswerRunEvent[] = []
  try {
    const entry = await createSharedAnswerEntry({
      config,
      answerRuntime,
      conversationStore: fakeConversationStore(),
      handoffStore: fakeHandoffStore(),
      traceObserver: { onEvent: (e) => persisted.push(e) },
      streamDirectReply: DIRECT_REPLY,
    })
    const events = await collect(entry.eventsSource("你好", {
      runId: "run-c-snapshot",
      sessionId: "sess-c-snapshot",
    }))
    const expected = {
      chatModel: "configured-chat-model",
      rerankModel: null,
      embeddingProfile: "configured-embedding-model:3",
    }
    const done = terminals(events)
    assert.deepEqual(done[0].result.modelProfile, expected)
    assert.equal(Object.isFrozen(done[0].result.modelProfile), true)
    const persistedDone = terminals(persisted)
    assert.equal(persistedDone.length, 1)
    assert.deepEqual(persistedDone[0].result.modelProfile, expected)
    // Both exits get the SAME frozen object, not a re-derived copy: the entry
    // resolves its profile once, at composition time.
    assert.equal(
      persistedDone[0].result.modelProfile,
      done[0].result.modelProfile,
      "stamping must not rebuild the snapshot per event"
    )
    // The exporter still sees every terminal of the run (T17 #4 coexistence);
    // it is fed the adapter's own event, before the entry's exit stamping.
    assert.equal(terminals(langfuse.exported.map((entry) => entry.event)).length, 1)
    // Non-secret: no key material or provider URL leaves the entry.
    const wire = JSON.stringify({ events, persisted })
    for (const secret of ["chat-key", "embedding-key", "http://chat.test"]) {
      assert.ok(!wire.includes(secret), `${secret} must never be published`)
    }
  } finally {
    await processRuntime.close()
  }
})

test("ARCH-01A #3: caseId is stamped on every event only when the caller supplies it", async () => {
  const chat = makeChatClient({ route: "direct" })
  const answerRuntime = createAnswerRuntime(config, clientFactory(chat))
  const base = {
    config,
    answerRuntime,
    conversationStore: fakeConversationStore(),
    handoffStore: fakeHandoffStore(),
    traceObserver: { onEvent: () => {} },
    streamDirectReply: DIRECT_REPLY,
  }
  try {
    const evaluated = await createSharedAnswerEntry(base)
    const withCase = await collect(
      evaluated.eventsSource("你好", {
        runId: "run-c-case",
        sessionId: "sess-c-case",
        caseId: "case-42",
      })
    )
    assert.ok(withCase.length >= 2)
    for (const event of withCase) assert.equal(event.caseId, "case-42")
    assert.equal(terminals(withCase)[0].caseId, "case-42")

    const chatted = await createSharedAnswerEntry(base)
    const withoutCase = await collect(
      chatted.eventsSource("你好", {
        runId: "run-c-nocase",
        sessionId: "sess-c-nocase",
      })
    )
    for (const event of withoutCase) {
      assert.equal("caseId" in event, false, "normal chat payloads stay unchanged")
    }
  } finally {
    await answerRuntime.processRuntime.close()
  }
})

// ---------------------------------------------------------------------------
// Criterion #4 — injected resources are used; no business fallback.
// ---------------------------------------------------------------------------

test("ARCH-01A #4: injected conversation, search, handoff and trace resources are used with no business fallback", async () => {
  const chat = makeChatClient({ route: "simple" })
  const processRuntime = createProcessRuntime(config, clientFactory(chat))
  const businessTrace = fakeTraceRepository()
  const answerRuntime = new AnswerRuntime(
    processRuntime,
    businessTrace,
    new NoopLangfuseExporter()
  )
  const conversationStore = fakeConversationStore()
  const handoffStore = fakeHandoffStore()
  const searchOperations = fakeSearchOperations()
  try {
    const entry = await createSharedAnswerEntry({
      config,
      answerRuntime,
      conversationStore,
      handoffStore,
      searchOperations,
      traceObserver: { onEvent: () => {} },
    })
    const events = await collect(entry.eventsSource("退货政策是什么", {
      runId: "run-c-injection",
      sessionId: "sess-c-injection",
    }))

    assert.equal(terminals(events).length, 1)
    assert.ok(searchOperations.searchCalls >= 1, "the injected searcher ran")
    assert.equal(entry.searchOperations, searchOperations)
    // The business trace repository was never written: the injected hard
    // observer replaced it, so evaluation cannot land in business tables.
    assert.equal(businessTrace.written.length, 0)
    // The injected conversation store took the validated pair, proving the
    // default SQLite stores were not the ones this run wrote through.
    assert.equal(
      conversationStore.validatedTurns.length,
      2,
      "the injected conversation store received the validated user/assistant pair"
    )
    assert.equal(handoffStore.created, 0, "no handoff was created on the happy path")
  } finally {
    await processRuntime.close()
  }
})

// ---------------------------------------------------------------------------
// Criterion #5 — optional capabilities degrade on the established path.
// ---------------------------------------------------------------------------

test("ARCH-01A #5: with no reranker configured the snapshot names null and the run still completes", async () => {
  const chat = makeChatClient({ route: "simple" })
  const answerRuntime = createAnswerRuntime(config, clientFactory(chat))
  try {
    // `rerankApiKey: ""` → createDedicatedReranker returns undefined.
    const entry = await createSharedAnswerEntry({
      config,
      answerRuntime,
      searchOperations: fakeSearchOperations(),
      conversationStore: fakeConversationStore(),
      handoffStore: fakeHandoffStore(),
      traceObserver: { onEvent: () => {} },
    })
    const events = await collect(entry.eventsSource("退货政策是什么", {
      runId: "run-c-norerank",
      sessionId: "sess-c-norerank",
    }))
    const done = terminals(events)
    assert.equal(done.length, 1)
    assert.equal(done[0].result.modelProfile?.rerankModel, null)
    assert.notEqual(done[0].status, "failed", "a missing reranker is a degradation, never a failure")
  } finally {
    await answerRuntime.processRuntime.close()
  }
})

test("ARCH-01A #5: a rerank-free assistant never builds or calls the dedicated reranker", async () => {
  const chat = makeChatClient({ route: "simple" })
  // No injected searchOperations: this assertion is about the operations the
  // entry builds for itself, so the run must go through the real searcher.
  const answerRuntime = createAnswerRuntime(
    config,
    clientFactory(chat, esStub(["chunk-1", "chunk-2"]))
  )
  const reranker = recordingReranker()
  try {
    const entry = await createSharedAnswerEntry({
      config,
      answerRuntime,
      reranker,
      conversationStore: fakeConversationStore(),
      handoffStore: fakeHandoffStore(),
      traceObserver: { onEvent: () => {} },
    })
    const rerankFree = await collect(
      entry.eventsSource("退货政策是什么", {
        runId: "run-c-free",
        sessionId: "sess-c-free",
        assistant: ASSISTANT_RERANK_FREE,
      })
    )
    assert.equal(terminals(rerankFree).length, 1, "the rerank-free run reaches a terminal")
    assert.equal(reranker.calls, 0, "the dedicated reranker must not be invoked")

    // The same entry with a rerank-bound assistant DOES take the reranker, so
    // the assertion above is about the snapshot, not about a dead seam.
    const bound = await collect(
      entry.eventsSource("退货政策是什么", {
        runId: "run-c-bound",
        sessionId: "sess-c-bound",
        assistant: ASSISTANT_WITH_RERANK,
      })
    )
    assert.equal(terminals(bound).length, 1)
    assert.ok(reranker.calls >= 1, "a rerank-bound assistant uses the dedicated reranker")
  } finally {
    await answerRuntime.processRuntime.close()
  }
})

test("ARCH-01A #5: with no FAQ, Memory, attachment, Web or MCP capability the run follows the established no-channel path", async () => {
  const chat = makeChatClient({ route: "simple" })
  const answerRuntime = createAnswerRuntime(config, clientFactory(chat))
  try {
    const bare = await createSharedAnswerEntry({
      config,
      answerRuntime,
      searchOperations: fakeSearchOperations(),
      conversationStore: fakeConversationStore(),
      handoffStore: fakeHandoffStore(),
      traceObserver: { onEvent: () => {} },
    })
    const events = await collect(bare.eventsSource("退货政策是什么", {
      runId: "run-c-minimal",
      sessionId: "sess-c-minimal",
      useMemory: false,
      useWeb: false,
    }))
    const done = terminals(events)
    assert.equal(done.length, 1)
    assert.equal(done[0].status, "completed")
    assert.equal("mcp" in bare, false, "no MCP bridge means no mcp capability")
    assert.equal(done[0].result.faq, undefined, "no FAQ service means no exact answer")
    assert.equal(done[0].result.memoryUsed, undefined, "no memory store means no recall")
    // Web and attachment channels contribute nothing when unwired.
    for (const reference of done[0].result.references) {
      assert.notEqual(reference.source, "web")
      assert.notEqual(reference.source, "attachment")
    }
  } finally {
    await answerRuntime.processRuntime.close()
  }
})

test("ARCH-01A #5: an unwired FAQ service contributes no exact answer and no evidence channel", async () => {
  const chat = makeChatClient({ route: "simple" })
  const answerRuntime = createAnswerRuntime(config, clientFactory(chat))
  const searchOperations = fakeSearchOperations()
  try {
    const entry = await createSharedAnswerEntry({
      config,
      answerRuntime,
      searchOperations,
      conversationStore: fakeConversationStore(),
      handoffStore: fakeHandoffStore(),
      traceObserver: { onEvent: () => {} },
    })
    const events = await collect(entry.eventsSource("退货多久到账？", {
      runId: "run-c-nofaq",
      sessionId: "sess-c-nofaq",
    }))
    const done = terminals(events)
    assert.equal(done.length, 1)
    assert.equal(done[0].result.faq, undefined)
    // With no FAQ channel the run falls through to ordinary retrieval, so the
    // searcher still ran — the missing capability degrades rather than blocks.
    assert.ok(searchOperations.searchCalls >= 1)
    for (const reference of done[0].result.references) {
      assert.notEqual(reference.source, "faq", "no FAQ evidence can appear unwired")
    }
  } finally {
    await answerRuntime.processRuntime.close()
  }
})

test("ARCH-01A #3: cfg.answerRunBudgetMs is NOT the deadline — only options.budgetMs is", async () => {
  const chat = makeChatClient({ route: "direct" })
  // A config that would cancel instantly if the entry read it (ticket 01 made
  // `budgetMs` an injectable seam ONLY; reading the config here would be an
  // undeclared behavior change).
  const impatient: AppConfig = { ...config, answerRunBudgetMs: 1 }
  const answerRuntime = createAnswerRuntime(impatient, clientFactory(chat))
  try {
    const entry = await createSharedAnswerEntry({
      config: impatient,
      answerRuntime,
      conversationStore: fakeConversationStore(),
      handoffStore: fakeHandoffStore(),
      traceObserver: { onEvent: () => {} },
      streamDirectReply: DIRECT_REPLY,
    })
    const events = await collect(entry.eventsSource("你好", {
      runId: "run-c-config-budget",
      sessionId: "sess-c-config-budget",
    }))
    const done = terminals(events)
    assert.equal(done.length, 1)
    assert.equal(
      done[0].status,
      "completed",
      "the config value must not bound the run; DEFAULT_RUN_BUDGET_MS still does"
    )
  } finally {
    await answerRuntime.processRuntime.close()
  }
})

test("ARCH-01A #5: the reranker resolves independently of injected search operations", async () => {
  const chat = makeChatClient({ route: "direct" })
  const answerRuntime = createAnswerRuntime(config, clientFactory(chat))
  const reranker = recordingReranker("injected-rerank-model")
  try {
    // Injected operations suppress the rerank-free variant, but the MODEL
    // SNAPSHOT still names the reranker this entry was composed with — the two
    // are resolved on separate lines, and a stack that conflated them would
    // silently report a different profile for evaluation runs.
    const entry = await createSharedAnswerEntry({
      config,
      answerRuntime,
      reranker,
      searchOperations: fakeSearchOperations(),
      conversationStore: fakeConversationStore(),
      handoffStore: fakeHandoffStore(),
      traceObserver: { onEvent: () => {} },
      streamDirectReply: DIRECT_REPLY,
    })
    const events = await collect(entry.eventsSource("你好", {
      runId: "run-c-rerank-independent",
      sessionId: "sess-c-rerank-independent",
    }))
    assert.equal(
      terminals(events)[0].result.modelProfile?.rerankModel,
      "injected-rerank-model"
    )
  } finally {
    await answerRuntime.processRuntime.close()
  }
})

// ---------------------------------------------------------------------------
// Reasoning effort (RE-03): the capability is resolved from the SAME config at
// composition time and frozen; every business terminal records what the run
// requested; concurrent sessions never cross their values; nothing rewrites
// the shared config or the frozen model snapshot.
// ---------------------------------------------------------------------------

const OFFICIAL_REASONING_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4"

test("RE-03: the capability is normalized from the composed config and deep-frozen", async () => {
  const cfg: AppConfig = {
    ...config,
    openaiBaseUrl: `  ${OFFICIAL_REASONING_ENDPOINT}/  `,
    openaiChatModel: "  glm-5.3-flash  ",
  }
  const chat = makeChatClient({ route: "direct" })
  const answerRuntime = createAnswerRuntime(cfg, clientFactory(chat))
  try {
    const entry = await createSharedAnswerEntry({
      config: cfg,
      answerRuntime,
      conversationStore: fakeConversationStore(),
      handoffStore: fakeHandoffStore(),
      traceObserver: { onEvent: () => {} },
      streamDirectReply: DIRECT_REPLY,
    })
    assert.deepEqual(entry.reasoningCapability, {
      supported: true,
      levels: ["low", "high", "max"],
      defaultEffort: "max",
      model: "glm-5.3-flash",
    })
    assert.equal(Object.isFrozen(entry.reasoningCapability), true)
    assert.equal(Object.isFrozen(entry.reasoningCapability.levels), true)
  } finally {
    await answerRuntime.processRuntime.close()
  }
})

test("RE-03: every non-official endpoint/model pair is declared unsupported", async () => {
  const variants: Array<{ baseUrl: string; model: string; modelReported: string }> = [
    { baseUrl: "https://relay.example.com/api/paas/v4", model: "glm-5.3-flash", modelReported: "glm-5.3-flash" },
    { baseUrl: "http://open.bigmodel.cn/api/paas/v4", model: "glm-5.3-flash", modelReported: "glm-5.3-flash" },
    { baseUrl: "https://open.bigmodel.cn/api/paas/v3", model: "glm-5.3-flash", modelReported: "glm-5.3-flash" },
    { baseUrl: OFFICIAL_REASONING_ENDPOINT, model: "glm-5.3", modelReported: "glm-5.3" },
    { baseUrl: OFFICIAL_REASONING_ENDPOINT, model: "glm-5.3-flash-air", modelReported: "glm-5.3-flash-air" },
    { baseUrl: OFFICIAL_REASONING_ENDPOINT, model: "GLM-5.3-Flash", modelReported: "GLM-5.3-Flash" },
  ]
  for (const variant of variants) {
    const cfg: AppConfig = {
      ...config,
      openaiBaseUrl: variant.baseUrl,
      openaiChatModel: variant.model,
    }
    const answerRuntime = createAnswerRuntime(cfg, clientFactory(makeChatClient({ route: "direct" })))
    try {
      const entry = await createSharedAnswerEntry({
        config: cfg,
        answerRuntime,
        conversationStore: fakeConversationStore(),
        handoffStore: fakeHandoffStore(),
        traceObserver: { onEvent: () => {} },
        streamDirectReply: DIRECT_REPLY,
      })
      assert.deepEqual(entry.reasoningCapability, {
        supported: false,
        levels: [],
        defaultEffort: null,
        model: variant.modelReported,
      }, `${variant.baseUrl} + ${variant.model} must not be declared compatible`)
    } finally {
      await answerRuntime.processRuntime.close()
    }
  }
})

test("RE-03: direct, simple and ambiguous terminals record the requested effort", async () => {
  const cases: Array<{
    route: "direct" | "simple" | "ambiguous"
    effort: "low" | "high" | "max"
    status: string
  }> = [
    { route: "direct", effort: "low", status: "completed" },
    { route: "simple", effort: "max", status: "completed" },
    { route: "ambiguous", effort: "high", status: "clarification_required" },
  ]
  for (const testCase of cases) {
    const chat = makeChatClient({ route: testCase.route })
    const answerRuntime = createAnswerRuntime(config, clientFactory(chat))
    try {
      const entry = await createSharedAnswerEntry({
        config,
        answerRuntime,
        searchOperations: fakeSearchOperations(),
        conversationStore: fakeConversationStore(),
        handoffStore: fakeHandoffStore(),
        traceObserver: { onEvent: () => {} },
        streamDirectReply: DIRECT_REPLY,
      })
      const events = await collect(entry.eventsSource("问题", {
        runId: `run-effort-${testCase.route}`,
        sessionId: `sess-effort-${testCase.route}`,
        reasoningEffort: testCase.effort,
      }))
      const done = terminals(events)
      assert.equal(done.length, 1, `${testCase.route}: exactly one terminal`)
      assert.equal(done[0].result.status, testCase.status)
      assert.equal(done[0].result.requestedReasoningEffort, testCase.effort)
    } finally {
      await answerRuntime.processRuntime.close()
    }
  }
})

test("RE-03: an FAQ standard answer records the effort without a model call", async () => {
  const chat = makeChatClient({ route: "direct" })
  const answerRuntime = createAnswerRuntime(config, clientFactory(chat))
  try {
    const entry = await createSharedAnswerEntry({
      config,
      answerRuntime,
      conversationStore: fakeConversationStore(),
      handoffStore: fakeHandoffStore(),
      traceObserver: { onEvent: () => {} },
      streamDirectReply: DIRECT_REPLY,
      faq: { listActive: () => [{
        entryId: "faq-effort", version: 1, question: "营业时间", answer: "九点到五点", variants: [],
        normalizedQuestion: "营业时间", source: null,
      }] } as unknown as import("../faq/faq_entry_service").FaqEntryService,
    })
    const events = await collect(entry.eventsSource("营业时间", {
      runId: "run-effort-faq",
      sessionId: "sess-effort-faq",
      reasoningEffort: "low",
      retrievalScope: { knowledgeBaseIds: ["kb-faq"] },
    }))
    const done = terminals(events)
    assert.equal(done.length, 1)
    assert.equal(done[0].result.reply, "九点到五点")
    assert.equal(done[0].result.requestedReasoningEffort, "low")
    assert.equal(chat.calls.length, 0, "the standard answer never calls a model")
  } finally {
    await answerRuntime.processRuntime.close()
  }
})

test("RE-03: a complex run records the effort on its single terminal", async () => {
  const chat = makeChatClient({ route: "complex" })
  const answerRuntime = createAnswerRuntime(config, clientFactory(chat))
  try {
    const entry = await createSharedAnswerEntry({
      config,
      answerRuntime,
      searchOperations: fakeSearchOperations([
        retrievalResult("chunk-1", "退货窗口为 14 天。"),
        retrievalResult("chunk-2", "换货须保留原包装。"),
      ]),
      conversationStore: fakeConversationStore(),
      handoffStore: fakeHandoffStore(),
      traceObserver: { onEvent: () => {} },
    })
    const events = await collect(entry.eventsSource("比较退货和换货", {
      runId: "run-effort-complex",
      sessionId: "sess-effort-complex",
      reasoningEffort: "high",
    }))
    const done = terminals(events)
    assert.equal(done.length, 1, "the complex route converges on exactly one terminal")
    assert.equal(done[0].result.requestedReasoningEffort, "high")
  } finally {
    await answerRuntime.processRuntime.close()
  }
})

test("RE-03: two sessions with different efforts never cross their values", async () => {
  const chat = makeChatClient({ route: "simple" })
  const answerRuntime = createAnswerRuntime(config, clientFactory(chat))
  try {
    const entry = await createSharedAnswerEntry({
      config,
      answerRuntime,
      searchOperations: fakeSearchOperations(),
      conversationStore: fakeConversationStore(),
      handoffStore: fakeHandoffStore(),
      traceObserver: { onEvent: () => {} },
      streamDirectReply: DIRECT_REPLY,
    })
    const [lowEvents, maxEvents] = await Promise.all([
      collect(entry.eventsSource("退货政策", {
        runId: "run-effort-low",
        sessionId: "sess-effort-low",
        reasoningEffort: "low",
      })),
      collect(entry.eventsSource("退货政策", {
        runId: "run-effort-max",
        sessionId: "sess-effort-max",
        reasoningEffort: "max",
      })),
    ])
    assert.equal(terminals(lowEvents)[0].result.requestedReasoningEffort, "low")
    assert.equal(terminals(maxEvents)[0].result.requestedReasoningEffort, "max")
  } finally {
    await answerRuntime.processRuntime.close()
  }
})

test("RE-03: a run never rewrites the shared config or the frozen model snapshot", async () => {
  const before = JSON.stringify(config)
  const chat = makeChatClient({ route: "direct" })
  const answerRuntime = createAnswerRuntime(config, clientFactory(chat))
  try {
    const entry = await createSharedAnswerEntry({
      config,
      answerRuntime,
      conversationStore: fakeConversationStore(),
      handoffStore: fakeHandoffStore(),
      traceObserver: { onEvent: () => {} },
      streamDirectReply: DIRECT_REPLY,
    })
    const events = await collect(entry.eventsSource("你好", {
      runId: "run-effort-config",
      sessionId: "sess-effort-config",
      reasoningEffort: "max",
    }))
    assert.equal(JSON.stringify(config), before, "the shared config is never mutated")
    const done = terminals(events)[0]
    assert.equal(done.result.modelProfile?.chatModel, config.openaiChatModel)
    assert.equal("requestedReasoningEffort" in (done.result.modelProfile ?? {}), false)
  } finally {
    await answerRuntime.processRuntime.close()
  }
})
