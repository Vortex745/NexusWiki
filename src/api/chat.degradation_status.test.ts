/**
 * DR-22 — degradation status contract at the real HTTP boundary.
 *
 * The real shared Answer entry, real route/runners and the real chat router are
 * mounted behind `app.listen(0)`; only the model client and retrieval
 * collaborators are controlled and replayable. No external model, provider or
 * service is called.
 *
 * Acceptance map (`deepeval-agent-repair-tickets/issues/22-degradation-status-contract.md`):
 *   AC01 a normal refusal, an empty scope, a missing rerank configuration and a
 *        provider failure keep distinct terminals and stage reasons
 *   AC02 a controlled successful Rerank-on publishes dedicated_rerank without
 *        `reranker_unavailable`; a controlled failure keeps the explicit
 *        fused/degraded source; a timeout/cancellation is never swallowed
 *   AC03 the terminal state and stage reasons are observable on the event stream
 */

import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"
import type OpenAI from "openai"
import type { AppConfig } from "../config"
import { createAnswerRuntime } from "../answer/runtime"
import { AnswerTraceRepository } from "../answer/trace_repository"
import { openDb } from "../ingestion/tracking/db"
import { KnowledgeBaseServiceImpl } from "../knowledge/knowledge_base_service"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { createRetrievalScopeResolver } from "../retrieval/scope"
import type { SearchOperations } from "../retrieval/search/searcher"
import {
  RerankerNotConfiguredError,
  type Reranker,
} from "../retrieval/search/interface"
import type { Chunk, RetrievalResult } from "../types"
import { createSharedAnswerEntry } from "../mastra/shared_answer_entry"
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
  const c = chunk(id, content)
  return { chunk: c, parentChunk: c, score: 1, wikilinks: [], source: "vector" }
}

const TWO_CANDIDATES = [
  retrievalResult("chunk-a", "离职需要提前三十天申请。"),
  retrievalResult("chunk-b", "离职交接由直属主管确认。"),
]

type RerankBehavior =
  | { kind: "success" }
  | { kind: "not_configured" }
  | { kind: "failure"; message: string }
  | { kind: "timeout"; waitMs: number }
  | { kind: "hang_until_abort" }

interface ControlledOperations extends SearchOperations {
  channelResults?: RetrievalResult[]
  channelError?: Error
}

function operations(
  options: {
    rerank?: RerankBehavior
    results?: RetrievalResult[]
    channelError?: Error
  } = {}
): ControlledOperations {
  const results = options.results ?? TWO_CANDIDATES
  const rerank = options.rerank ?? { kind: "success" }
  const state = {
    vectorSearch: async () => {
      if (options.channelError) throw options.channelError
      return results
    },
    bm25Search: async () => {
      if (options.channelError) throw options.channelError
      return []
    },
    graphSearch: async () => [],
    pageIndexSearch: async () => [],
    rerank: async (
      _query: string,
      candidates: RetrievalResult[],
      signal?: AbortSignal
    ) => {
      switch (rerank.kind) {
        case "success":
          return [...candidates].reverse()
        case "not_configured":
          throw new RerankerNotConfiguredError()
        case "failure":
          throw new Error(rerank.message)
        case "timeout":
          await new Promise((resolve) => setTimeout(resolve, rerank.waitMs))
          throw new Error("rerank provider timed out")
        case "hang_until_abort":
          await new Promise<void>((_resolve, reject) => {
            const abort = () => {
              const error = new Error("rerank cancelled")
              error.name = "AbortError"
              reject(error)
            }
            if (signal?.aborted) abort()
            signal?.addEventListener("abort", abort, { once: true })
          })
          return candidates
      }
    },
    loadParents: async () =>
      (options.results ?? TWO_CANDIDATES).map(
        (result) => result.parentChunk ?? result.chunk
      ),
  }
  return state as unknown as ControlledOperations
}

interface ScriptedChat {
  client: OpenAI
  draftCalls: number
}

/**
 * Scripted model: classification says "simple", the selector chooses the
 * default hybrid channels, the critic approves and the draft cites evidence.
 * `throwOnDraft` models a provider failure in the answer stage only.
 */
function scriptedChat(options: { throwOnDraft?: Error } = {}): ScriptedChat {
  const state = { draftCalls: 0 }
  const client = {
    chat: {
      completions: {
        create: async (params: {
          messages: Array<{ role: string; content: string }>
          stream?: boolean
        }) => {
          const system =
            params.messages.find((m) => m.role === "system")?.content ?? ""
          const lastUser =
            [...params.messages].reverse().find((m) => m.role === "user")
              ?.content ?? ""

          if (system.includes("Classify the query")) {
            return { choices: [{ message: { content: "simple" } }] }
          }
          if (system.includes("retrieval strategy selector")) {
            return {
              choices: [
                {
                  message: {
                    tool_calls: [
                      {
                        id: "selector-1",
                        type: "function",
                        function: {
                          name: "semantic_lexical_hybrid",
                          arguments: JSON.stringify({ query: lastUser }),
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
          if (system.includes("你是智能客服助手")) {
            state.draftCalls += 1
            if (options.throwOnDraft) throw options.throwOnDraft
            const cited = lastUser.match(/\[cite:(ev_[a-f0-9]+)\]/)?.[1]
            const base = "离职需要提前三十天申请。"
            const reply = cited ? `${base} [cite:${cited}]` : base
            if (params.stream) {
              async function* tokenStream() {
                yield { choices: [{ delta: { content: reply } }] }
              }
              return tokenStream()
            }
            return { choices: [{ message: { content: reply } }] }
          }
          return { choices: [{ message: { content: "echo" } }] }
        },
      },
    },
  }
  return { client: client as unknown as OpenAI, draftCalls: 0 }
}

interface Harness {
  app: express.Express
  close: () => Promise<void>
}

async function buildHarness(options: {
  operations?: ControlledOperations
  reranker?: Reranker
  budgetMs?: number
  throwOnDraft?: Error
} = {}): Promise<Harness> {
  const chat = scriptedChat(
    options.throwOnDraft ? { throwOnDraft: options.throwOnDraft } : {}
  )
  const answerRuntime = createAnswerRuntime(config, {
    createChatClient: () => chat.client,
    createEmbeddingClient: () =>
      ({
        embeddings: {
          create: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
        },
      }) as unknown as OpenAI,
    createElasticsearchClient: () => ({ close: async () => {} }) as never,
    createNeo4jDriver: () => ({ close: async () => {} }) as never,
  })
  const db = openDb(":memory:")
  const scopeDb = openDb(":memory:")
  const kbService = new KnowledgeBaseServiceImpl(
    new SqliteKnowledgeBaseRepo(scopeDb),
    "configured-embedding-model:3"
  )
  kbService.ensureDefault("demo")
  const resolver = createRetrievalScopeResolver(kbService)

  const entry = await createSharedAnswerEntry({
    config,
    answerRuntime,
    searchOperations: options.operations ?? operations(),
    ...(options.reranker ? { reranker: options.reranker } : {}),
    traceObserver: { onEvent: () => {} },
    ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
  })

  const app = express()
  app.use(express.json())
  app.use(
    "/api",
    createChatRouter(
      new AnswerTraceRepository(db),
      entry.eventsSource,
      undefined,
      resolver
    )
  )

  return {
    app,
    close: async () => {
      await answerRuntime.processRuntime.close()
      db.close()
      scopeDb.close()
    },
  }
}

async function listen(app: express.Express) {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

interface EventRecord {
  type: string
  stage?: string
  data?: Record<string, unknown>
  result?: {
    status: string
    reply: string
    degradation: {
      status: string
      unavailableChannels: string[]
      reason?: string
    }
  }
}

async function postChat(
  port: number,
  body: { message: string; sessionId: string; knowledgeBaseIds?: string[] }
): Promise<{ status: number; events: EventRecord[] }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, stream: false }),
  })
  const payload = (await response.json()) as { events: EventRecord[] }
  return { status: response.status, events: payload.events }
}

function terminal(events: EventRecord[]) {
  const done = events.filter((event) => event.type === "done")
  assert.equal(done.length, 1, "exactly one terminal event")
  return done[0].result!
}

function retrievalTrace(events: EventRecord[]) {
  const traced = events.filter(
    (event) => event.type === "progress" && event.stage === "retrieval" && event.data
  )
  return (traced.at(-1)?.data ?? {}) as Record<string, unknown>
}

async function withHarness<T>(
  options: Parameters<typeof buildHarness>[0],
  run: (port: number, harness: Harness) => Promise<T>
): Promise<T> {
  const harness = await buildHarness(options)
  const { server, port } = await listen(harness.app)
  try {
    return await run(port, harness)
  } finally {
    server.close()
    await harness.close()
  }
}

test("DR-22 AC01: refusal, empty scope, unconfigured rerank and provider failure stay distinct", async () => {
  // Normal refusal: retrieval runs, returns zero evidence.
  await withHarness(
    { operations: operations({ results: [] }) },
    async (port) => {
      const response = await postChat(port, {
        message: "有没有关于火星殖民的规定？",
        sessionId: "dr22-refusal",
      })
      assert.equal(response.status, 200)
      const result = terminal(response.events)
      assert.equal(result.status, "insufficient_evidence")
      assert.equal(result.degradation.status, "insufficient")
      assert.equal(result.degradation.reason, "no_results")
      assert.equal(
        (retrievalTrace(response.events).degradedReasons as string[] | undefined)?.includes(
          "no_knowledge_scope"
        ),
        false
      )
    }
  )

  // Empty scope: a legal request with no knowledge context.
  await withHarness({}, async (port) => {
    const response = await postChat(port, {
      message: "有什么规定？",
      sessionId: "dr22-empty-scope",
      knowledgeBaseIds: [],
    })
    assert.equal(response.status, 200)
    const result = terminal(response.events)
    assert.equal(result.status, "insufficient_retrieval")
    assert.equal(result.degradation.status, "insufficient")
    assert.deepEqual(result.degradation.unavailableChannels, [])
    assert.deepEqual(retrievalTrace(response.events).degradedReasons, [
      "no_knowledge_scope",
    ])
  })

  // Missing rerank configuration: capability absence, not a provider failure.
  await withHarness(
    { operations: operations({ rerank: { kind: "not_configured" } }) },
    async (port) => {
      const response = await postChat(port, {
        message: "离职需要提前多久申请？",
        sessionId: "dr22-unconfigured",
      })
      const result = terminal(response.events)
      const trace = retrievalTrace(response.events)
      assert.equal(result.status, "completed")
      assert.equal(result.degradation.status, "none")
      assert.deepEqual(trace.finalContextOrdering, {
        source: "fused",
        reason: "not_configured",
      })
      assert.deepEqual(trace.degradedReasons, ["reranker_not_configured"])
    }
  )

  // Provider failure: the same configuration, but the provider rejects.
  await withHarness(
    { operations: operations({ rerank: { kind: "failure", message: "HTTP 503" } }) },
    async (port) => {
      const response = await postChat(port, {
        message: "离职需要提前多久申请？",
        sessionId: "dr22-provider-failure",
      })
      const result = terminal(response.events)
      const trace = retrievalTrace(response.events)
      assert.equal(result.status, "completed")
      assert.equal(result.degradation.status, "partial")
      assert.deepEqual(trace.finalContextOrdering, {
        source: "fused",
        reason: "unavailable",
      })
      assert.deepEqual(trace.degradedReasons, ["reranker_unavailable"])
    }
  )
})

test("DR-22 AC02: a controlled Rerank-on answer publishes dedicated_rerank and no reranker_unavailable", async () => {
  const reranker: Reranker = {
    model: "controlled-reranker",
    async rerank(_query, results) {
      return [...results].reverse()
    },
  }
  await withHarness({ operations: operations(), reranker }, async (port) => {
    const response = await postChat(port, {
      message: "离职需要提前多久申请？",
      sessionId: "dr22-rerank-on",
    })
    const result = terminal(response.events)
    const trace = retrievalTrace(response.events)

    assert.equal(result.status, "completed")
    assert.equal(result.degradation.status, "none")
    assert.deepEqual(trace.finalContextOrdering, { source: "dedicated_rerank" })
    assert.equal(
      (trace.degradedReasons as string[] | undefined)?.includes("reranker_unavailable"),
      false
    )
    assert.equal(
      (trace.degradedReasons as string[] | undefined)?.includes("reranker_not_configured"),
      false
    )
  })
})

test("DR-22 AC02: a rejected, timed-out or cancelled rerank is never a silent success", async () => {
  // Rejected provider: explicit fused/unavailable plus a partial answer.
  await withHarness(
    { operations: operations({ rerank: { kind: "failure", message: "HTTP 503" } }) },
    async (port) => {
      const result = terminal(
        (
          await postChat(port, {
            message: "离职需要提前多久申请？",
            sessionId: "dr22-rejected",
          })
        ).events
      )
      assert.equal(result.status, "completed")
      assert.equal(result.degradation.status, "partial")
    }
  )

  // Timeout: still an explicit degradation, never a dedicated-rerank success.
  await withHarness(
    { operations: operations({ rerank: { kind: "timeout", waitMs: 20 } }) },
    async (port) => {
      const response = await postChat(port, {
        message: "离职需要提前多久申请？",
        sessionId: "dr22-timeout",
      })
      const result = terminal(response.events)
      const trace = retrievalTrace(response.events)
      assert.equal(result.status, "completed")
      assert.equal(result.degradation.status, "partial")
      assert.deepEqual(trace.finalContextOrdering, {
        source: "fused",
        reason: "unavailable",
      })
      assert.deepEqual(trace.degradedReasons, ["reranker_unavailable"])
    }
  )

  // Cancellation mid-rerank: one cancelled terminal, no success evidence.
  await withHarness(
    {
      operations: operations({ rerank: { kind: "hang_until_abort" } }),
      budgetMs: 30,
    },
    async (port) => {
      const response = await postChat(port, {
        message: "离职需要提前多久申请？",
        sessionId: "dr22-cancelled",
      })
      const result = terminal(response.events)
      assert.equal(result.status, "cancelled")
      const trace = retrievalTrace(response.events)
      assert.notDeepEqual(trace.finalContextOrdering, { source: "dedicated_rerank" })
    }
  )
})

test("DR-22 AC02: a provider failure in the answer stage is not labelled no_cited_claims", async () => {
  await withHarness(
    { throwOnDraft: new Error("chat provider HTTP 503"), operations: operations() },
    async (port) => {
      const response = await postChat(port, {
        message: "离职需要提前多久申请？",
        sessionId: "dr22-model-failure",
      })
      const result = terminal(response.events)
      assert.equal(result.status, "provider_error")
      assert.equal(result.degradation.status, "insufficient")
      assert.notEqual(result.degradation.reason, "no_cited_claims")
    }
  )
})
