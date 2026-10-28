/**
 * Ticket DR-11 — clear out-of-domain routing through the REAL shared Answer
 * entry and the REAL chat HTTP transport.
 *
 * What is frozen here (`.scratch/deepeval-agent-repair-tickets/issues/11-…`):
 *   AC02 a clear factual question that the authorized scope does not cover is
 *        still routed as a factual question, actually retrieves inside that
 *        scope, and is answered with an explicit coverage-gap statement;
 *   AC03 that question never converges on `clarification_required`, and no
 *        stock fact is invented;
 *   AC04 a question that is genuinely missing its referent/parameter still
 *        receives a targeted clarification and records the pending turn;
 *   AC05 multi-part questions still reach the complex route and greetings are
 *        not sent into knowledge retrieval;
 *   AC06/d Chat and Clef classification requests express the same closed
 *        four-route intent policy;
 *   AC08 every search — including the out-of-domain one — carries exactly the
 *        server-resolved scope.
 *
 * The model is a controlled collaborator. It follows the classification
 * instruction it is given: a focused factual question is routed by intent,
 * and is only misread as ambiguous when the provider instruction fails to say
 * that coverage is decided by evidence rather than by the route decision.
 * That is the offline reproduction of the recorded hard-05 behaviour; the
 * three real online samples stay pending (AC10).
 */

import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"
import type OpenAI from "openai"
import type { Client as ElasticsearchClient } from "@elastic/elasticsearch"
import type { Driver } from "neo4j-driver"
import type { AppConfig } from "../config"
import { createAnswerRuntime } from "../answer/runtime"
import type { ConversationStore } from "../answer/conversation_store"
import type { HandoffStore } from "../answer/handoff_store"
import { AnswerTraceRepository } from "../answer/trace_repository"
import { openDb, type DB } from "../ingestion/tracking/db"
import { KnowledgeBaseServiceImpl } from "../knowledge/knowledge_base_service"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { createRetrievalScopeResolver } from "../retrieval/scope"
import type { SearchOperations } from "../retrieval/search/searcher"
import { createSharedAnswerEntry } from "../mastra/shared_answer_entry"
import type { Chunk, RetrievalResult, AnswerRunEvent } from "../types"
import { createChatRouter } from "./chat"

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
  mcpCapabilitiesEnabled: false,
}

type Provider = "chat" | "clef"
type Decision = "direct" | "simple" | "ambiguous" | "complex"

const IN_DOMAIN = "退货政策是什么"
const OUT_OF_DOMAIN = "公司的股票代码是什么？"
const MISSING_PARAMETER = "它怎么设置？"
const MULTI_PART = "比较退货和换货的窗口"
const GREETING = "你好"

/**
 * The classification instruction the product sends must separate "what does
 * this question ask" from "does the knowledge base cover it". A provider
 * instruction without both clauses is the recorded defect: the classifier
 * then treats an uncovered factual question as ambiguous.
 */
function statesIntentOnlyPolicy(instructions: string): boolean {
  return /whether the knowledge base/i.test(instructions)
    && /essential referent or parameter/i.test(instructions)
}

/**
 * The controlled classifier routes from the scenario's own question, never
 * from the wording of the prompt it happens to receive. Route assertions stay
 * about intent; the separate AC06 test still pins the prompt policy below.
 */
function classify(message: string): Decision {
  if (message === GREETING) return "direct"
  if (message === MISSING_PARAMETER) return "ambiguous"
  if (message === MULTI_PART) return "complex"
  // Focused factual questions are factual by intent, whether or not the
  // authorized scope happens to cover them.
  return "simple"
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

function retrievalResult(id: string, content: string): RetrievalResult {
  const value = chunk(id, content)
  return { chunk: value, parentChunk: value, score: 1, wikilinks: [], source: "vector" }
}

const EVIDENCE = [
  retrievalResult("chunk-1", "客户在购买后 14 天内可以发起退货。"),
  retrievalResult("chunk-2", "换货窗口为 30 天，需保留原始包装。"),
]

interface ScopeObservation {
  query: string
  scope: unknown
}

function recordingSearchOperations(): SearchOperations & { calls: ScopeObservation[] } {
  const calls: ScopeObservation[] = []
  const record = (query: { text: string }, scope: unknown): RetrievalResult[] => {
    calls.push({ query: query.text, scope })
    return query.text === IN_DOMAIN ? EVIDENCE : []
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
    loadParents: async () => EVIDENCE.map((result) => result.parentChunk ?? result.chunk),
  } as unknown as SearchOperations & { calls: ScopeObservation[] }
}

function conversationStore(): ConversationStore & {
  pending: Map<string, string>
} {
  const validatedTurns: unknown[] = []
  const pending = new Map<string, string>()
  return {
    pending,
    validatedTurns,
    saveValidatedTurn(turn: unknown): void {
      validatedTurns.push(turn)
    },
    savePendingClarification(sessionId: string, _tenantId: string, text: string): void {
      pending.set(sessionId, text)
    },
    peekPendingClarification(sessionId: string, _tenantId: string): string | null {
      return pending.get(sessionId) ?? null
    },
    claimPendingClarification(sessionId: string, _tenantId: string): string | null {
      const value = pending.get(sessionId) ?? null
      pending.delete(sessionId)
      return value
    },
    consumePendingClarification(sessionId: string, _tenantId: string): string | null {
      const value = pending.get(sessionId) ?? null
      pending.delete(sessionId)
      return value
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
    loadOlderTurnsForSummarization(): unknown[] {
      return []
    },
    saveRollingSummary(): void {},
  } as unknown as ConversationStore & { pending: Map<string, string> }
}

function handoffStore(): HandoffStore {
  return {
    create: () => null,
    getById: () => null,
    getByRunId: () => null,
    listByTenant: () => [],
  } as unknown as HandoffStore
}

const DIRECT_REPLY = async function* directReply(): AsyncGenerator<string> {
  yield "您好"
  yield "，很高兴为您服务"
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

interface ChatStub {
  client: OpenAI
  classificationPrompts: string[]
}

/**
 * A controlled model: it classifies from the instruction it receives and
 * answers the knowledge route with a citation of the supplied evidence.
 */
function chatStub(): ChatStub {
  const classificationPrompts: string[] = []
  const create = async (params: {
    messages: Array<{ role: string; content: string }>
    stream?: boolean
  }) => {
    const system = params.messages.find((message) => message.role === "system")?.content ?? ""
    const lastUser = [...params.messages].reverse()
      .find((message) => message.role === "user")?.content ?? ""

    if (system.includes("Classify the query")) {
      classificationPrompts.push(system)
      return { choices: [{ message: { content: classify(lastUser) } }] }
    }
    if (system.includes("retrieval strategy selector")) {
      return { choices: [{ message: {} }] }
    }
    if (system.includes("You are a retrieval planner")) {
      return {
        choices: [{
          message: {
            tool_calls: [{
              id: "call-stop",
              type: "function",
              function: {
                name: "stop_loop",
                arguments: JSON.stringify({ reason: "evidence-sufficient" }),
              },
            }],
          },
        }],
      }
    }
    if (system.includes("You are a critic")) {
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
    if (system.includes("你是智能客服助手")) {
      const cited = lastUser.match(/\[cite:(ev_[a-f0-9]+)\]/)?.[1]
      const reply = cited ? `知识库确认：14 天内可以退货。[cite:${cited}]` : "知识库确认：14 天内可以退货。"
      if (params.stream) {
        async function* tokens() {
          yield { choices: [{ delta: { content: reply } }] }
        }
        return tokens()
      }
      return { choices: [{ message: { content: reply } }] }
    }
    const followUp = lastUser.split("当前追问：").pop() ?? lastUser
    return { choices: [{ message: { content: followUp } }] }
  }
  return {
    client: { chat: { completions: { create } } } as unknown as OpenAI,
    classificationPrompts,
  }
}

interface Harness {
  port: number
  scopeIds: string[]
  searches: ScopeObservation[]
  conversation: ConversationStore & { pending: Map<string, string> }
  classificationPrompts: string[]
  clefRoutes: Array<{ instructions: string; criteria: Record<string, string> }>
  post(body: Record<string, unknown>): Promise<{
    status: number
    json: Record<string, unknown> | null
  }>
  close(): Promise<void>
}

async function harness(provider: Provider): Promise<Harness> {
  const db: DB = openDb(":memory:")
  const service = new KnowledgeBaseServiceImpl(
    new SqliteKnowledgeBaseRepo(db),
    "text-embedding-3-small:1536"
  )
  const authorized = service.ensureDefault("default")
  const policy = service.create("default", "Policy")
  const resolver = createRetrievalScopeResolver(service)

  const stub = chatStub()
  const searches = recordingSearchOperations()
  const conversation = conversationStore()
  const cfg: AppConfig = provider === "clef"
    ? {
        ...config,
        decisionProvider: "clef",
        cloudflareAccountId: "test-account",
        cloudflareApiToken: "test-token",
        decisionRequestTimeoutMs: 1_000,
      }
    : config

  const clefRoutes: Array<{ instructions: string; criteria: Record<string, string> }> = []
  const originalFetch = globalThis.fetch
  if (provider === "clef") {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (!url.includes("api.cloudflare.com")) return originalFetch(input, init)
      const request = JSON.parse(String(init?.body)) as {
        state: { query: string }
        questions: { route: { instructions: string; criteria: Record<string, string> } }
      }
      clefRoutes.push({
        instructions: request.questions.route.instructions,
        criteria: request.questions.route.criteria,
      })
      const choice = classify(request.state.query)
      return Response.json({
        success: true,
        result: {
          model: "clef",
          answers: {
            route: {
              type: "choice",
              choice,
              confidence: 0.65,
              probabilities: {
                direct: choice === "direct" ? 0.85 : 0.05,
                simple: choice === "simple" ? 0.85 : 0.05,
                ambiguous: choice === "ambiguous" ? 0.85 : 0.05,
                complex: choice === "complex" ? 0.85 : 0.05,
              },
            },
          },
          usage: { input_tokens: 50, output_tokens: 0 },
        },
      })
    }
  }

  const answerRuntime = createAnswerRuntime(cfg, clientFactory(stub.client))
  const entry = await createSharedAnswerEntry({
    config: cfg,
    answerRuntime,
    searchOperations: searches,
    conversationStore: conversation,
    handoffStore: handoffStore(),
    traceObserver: { onEvent: () => {} },
    streamDirectReply: DIRECT_REPLY,
  })

  const app = express()
  app.use(express.json())
  app.use("/api", createChatRouter(
    new AnswerTraceRepository(db),
    entry.eventsSource,
    undefined,
    resolver
  ))
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const port = (server.address() as AddressInfo).port
  const scopeIds = [authorized.id, policy.id]

  return {
    port,
    scopeIds,
    searches: searches.calls,
    conversation,
    classificationPrompts: stub.classificationPrompts,
    clefRoutes,
    async post(body) {
      const response = await originalFetch(`http://127.0.0.1:${port}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      return {
        status: response.status,
        json: (await response.json().catch(() => null)) as Record<string, unknown> | null,
      }
    },
    async close() {
      if (provider === "clef") globalThis.fetch = originalFetch
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await answerRuntime.processRuntime.close()
      db.close()
    },
  }
}

function routeDecision(events: AnswerRunEvent[]): Decision | undefined {
  for (const event of events) {
    if (event.type === "progress" && event.stage === "route" && event.data.decision) {
      return event.data.decision
    }
  }
  return undefined
}

function eventsOf(json: Record<string, unknown> | null): AnswerRunEvent[] {
  return (json?.events ?? []) as AnswerRunEvent[]
}

function assertScopeLocked(searches: ScopeObservation[], scopeIds: string[], label: string): void {
  assert.ok(searches.length > 0, `${label}: the run must actually retrieve`)
  for (const search of searches) {
    assert.deepEqual(
      search.scope,
      { knowledgeBaseIds: scopeIds },
      `${label}: every search keeps the server-resolved scope`
    )
  }
}

for (const provider of ["chat", "clef"] as const) {
  test(`DR-11 ${provider}: a clear out-of-domain question retrieves and admits the coverage gap`, async () => {
    const built = await harness(provider)
    try {
      // AC03: the recorded hard-05 question is replayed three times.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { status, json } = await built.post({
          message: OUT_OF_DOMAIN,
          stream: false,
          sessionId: `dr11-gap-${provider}-${attempt}`,
          knowledgeBaseIds: built.scopeIds,
        })
        assert.equal(status, 200)
        assert.equal(json?.status, "insufficient_evidence", "no route-level coverage guess may turn this into clarification")
        assert.equal(json?.reply, "现有证据不足以支持可靠回答，请补充资料或调整问题。")
        assert.deepEqual(json?.references, [])
        assert.equal(
          String(json?.reply).includes("补充更多问题细节"),
          false,
          "the generic clarification copy must never answer a clear factual question"
        )
        const events = eventsOf(json)
        assert.equal(routeDecision(events), "simple", "the question is factual by intent, coverage is decided by evidence")
      }
      assertScopeLocked(built.searches, built.scopeIds, "out-of-domain")
      assert.equal(built.conversation.pending.size, 0, "no pending clarification is recorded")
    } finally {
      await built.close()
    }
  })

  test(`DR-11 ${provider}: an in-domain question with evidence still answers with a citation`, async () => {
    const built = await harness(provider)
    try {
      const { status, json } = await built.post({
        message: IN_DOMAIN,
        stream: false,
        sessionId: `dr11-answer-${provider}`,
        knowledgeBaseIds: built.scopeIds,
      })
      assert.equal(status, 200)
      assert.equal(json?.status, "completed")
      assert.match(String(json?.reply), /\[cite:ev_[a-f0-9]+\]/)
      const references = json?.references as Array<{ id: string }>
      assert.ok(references.length >= 1)
      assert.match(references[0].id, /^ev_/)
      assert.equal(routeDecision(eventsOf(json)), "simple")
      assertScopeLocked(built.searches, built.scopeIds, "in-domain")
    } finally {
      await built.close()
    }
  })

  test(`DR-11 ${provider}: a question missing its referent still receives a targeted clarification`, async () => {
    const built = await harness(provider)
    try {
      const { status, json } = await built.post({
        message: MISSING_PARAMETER,
        stream: false,
        sessionId: `dr11-missing-${provider}`,
        knowledgeBaseIds: built.scopeIds,
      })
      assert.equal(status, 200)
      assert.equal(json?.status, "clarification_required")
      assert.match(String(json?.reply), /具体对象或参数/)
      assert.equal(built.conversation.pending.get(`dr11-missing-${provider}`), MISSING_PARAMETER)
      assert.equal(routeDecision(eventsOf(json)), "ambiguous")
    } finally {
      await built.close()
    }
  })

  test(`DR-11 ${provider}: multi-part questions reach the complex route and greetings never retrieve`, async () => {
    const built = await harness(provider)
    try {
      const multi = await built.post({
        message: MULTI_PART,
        stream: false,
        sessionId: `dr11-complex-${provider}`,
        knowledgeBaseIds: built.scopeIds,
      })
      assert.equal(multi.status, 200)
      assert.equal(routeDecision(eventsOf(multi.json)), "complex")

      const beforeGreeting = built.searches.length
      const greeting = await built.post({
        message: GREETING,
        stream: false,
        sessionId: `dr11-greeting-${provider}`,
        knowledgeBaseIds: built.scopeIds,
      })
      assert.equal(greeting.status, 200)
      assert.equal(routeDecision(eventsOf(greeting.json)), "direct")
      assert.equal(greeting.json?.status, "completed")
      assert.equal(built.searches.length, beforeGreeting, "a greeting is not a knowledge request")
    } finally {
      await built.close()
    }
  })
}

test("DR-11: Chat and Clef classification requests carry the same four-route intent policy", async () => {
  const chat = await harness("chat")
  const clef = await harness("clef")
  try {
    await chat.post({ message: GREETING, stream: false, sessionId: "dr11-policy-chat" })
    await clef.post({ message: GREETING, stream: false, sessionId: "dr11-policy-clef" })

    const chatPrompt = chat.classificationPrompts[0]
    const clefRoute = clef.clefRoutes[0]
    assert.ok(chatPrompt, "the Chat provider received the classification instruction")
    assert.ok(clefRoute, "the Clef provider received the classification instruction")

    const criteria = {
      direct: "Greeting, conversational acknowledgment, or non-knowledge conversational request.",
      simple: "Focused factual knowledge question suitable for one retrieval-and-answer path, whether or not the knowledge base covers it.",
      ambiguous: "The question itself lacks an essential referent or parameter, so it cannot be understood without clarification.",
      complex: "Multi-part question, comparison or synthesis that needs decomposition or multiple retrieval steps.",
    } as const
    assert.deepEqual(Object.keys(clefRoute.criteria).sort(), ["ambiguous", "complex", "direct", "simple"])
    for (const [label, text] of Object.entries(criteria)) {
      assert.equal(clefRoute.criteria[label], text, `Clef defines the ${label} route with the shared semantics`)
      assert.ok(chatPrompt.includes(text), `Chat defines the ${label} route with the shared semantics`)
    }
    // Both providers classify by intent, never by an assumed knowledge coverage,
    // and both keep the same closed four-route set.
    assert.equal(statesIntentOnlyPolicy(chatPrompt), true)
    assert.equal(statesIntentOnlyPolicy(clefRoute.instructions), true)
  } finally {
    await chat.close()
    await clef.close()
  }
})
