/**
 * DR-12 — PageIndex applicability at the HTTP boundary.
 *
 * The real shared Answer entry, real route runners and the real chat router are
 * mounted behind `app.listen(0)`; only the model client and the retrieval
 * operations are controlled collaborators. The operations count every channel
 * execution, so the trace can prove whether an inapplicable PageIndex attempt
 * was replaced BEFORE any executor call.
 *
 * Acceptance map (`deepeval-agent-repair-tickets/issues/12-pageindex-applicability.md`):
 *   AC01 case-10 conceptual query never calls the PageIndex channel
 *   AC02 definition / concept / general-procedure queries follow the rule
 *   AC03 page / section / table-of-contents navigation still executes PageIndex
 *   AC04 the word "文档" alone is not hierarchical navigation
 *   AC05 the replacement is recorded with its reason on the trace
 *   AC06 a qualified PageIndex zero-result falls back to default exactly once
 *   AC07 the check adds no model request and keeps the original query
 *   AC08 cancellation is not swallowed by applicability and adds no call
 *   AC09 access context and locked scope reach both paths unchanged
 */

import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"
import type OpenAI from "openai"
import type { AppConfig } from "../config"
import { AnswerRuntime, createAnswerRuntime } from "../answer/runtime"
import { AnswerTraceRepository } from "../answer/trace_repository"
import { openDb, type DB } from "../ingestion/tracking/db"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
import { KnowledgeBaseServiceImpl } from "../knowledge/knowledge_base_service"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { createRetrievalScopeResolver } from "../retrieval/scope"
import type {
  SearchOperations,
} from "../retrieval/search/searcher"
import type { Chunk, RetrievalResult } from "../types"
import { defaultKnowledgeBaseId } from "../types/knowledge_base"
import { createSharedAnswerEntry } from "../mastra/shared_answer_entry"
import { createChatRouter } from "./chat"

const CASE_10_QUERY = "四路结果融合之后还有什么处理？"

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

interface ScriptedChat {
  client: OpenAI
  /** Every `chat.completions.create` invocation, by system-prompt marker. */
  calls: string[]
  selectorQueries: string[]
}

/**
 * Scripted model: classification says "simple", the selector always proposes
 * PageIndex (the misselection under test), the critic approves, and the draft
 * echoes a citable evidence id from the assembled context.
 */
function scriptedChat(options: { selectorDelayMs?: number } = {}): ScriptedChat {
  const calls: string[] = []
  const selectorQueries: string[] = []
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
          const marker = system.slice(0, 40)
          calls.push(marker)

          if (system.includes("Classify the query")) {
            return { choices: [{ message: { content: "simple" } }] }
          }
          if (system.includes("retrieval strategy selector")) {
            const query = lastUser
            selectorQueries.push(query)
            if (options.selectorDelayMs) {
              await new Promise((resolve) =>
                setTimeout(resolve, options.selectorDelayMs)
              )
            }
            return {
              choices: [
                {
                  message: {
                    tool_calls: [
                      {
                        id: "selector-1",
                        type: "function",
                        function: {
                          name: "pageindex_hierarchy",
                          arguments: JSON.stringify({ query }),
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
            const cited = lastUser.match(/\[cite:(ev_[a-f0-9]+)\]/)?.[1]
            const base = "融合之后会做重排。"
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
  return {
    client: client as unknown as OpenAI,
    calls,
    selectorQueries,
  }
}

interface CountingOperations extends SearchOperations {
  pageIndexCalls: number
  vectorCalls: number
  bm25Calls: number
  /** Arguments each channel actually received (AC09). */
  pageIndexArgs: Array<{
    accessContext?: AccessContext
    retrievalScope?: { knowledgeBaseIds: string[] }
  }>
  defaultArgs: Array<{
    accessContext?: AccessContext
    retrievalScope?: { knowledgeBaseIds: string[] }
  }>
}

function countingOperations(options: {
  pageIndexResults?: RetrievalResult[]
  vectorResults?: RetrievalResult[]
} = {}): CountingOperations {
  const vectorResults =
    options.vectorResults ?? [retrievalResult("chunk-1", "融合之后会做重排。")]
  const pageIndexResults = options.pageIndexResults ?? []
  const state = {
    pageIndexCalls: 0,
    vectorCalls: 0,
    bm25Calls: 0,
    pageIndexArgs: [] as CountingOperations["pageIndexArgs"],
    defaultArgs: [] as CountingOperations["defaultArgs"],
    vectorSearch: async (
      _query: unknown,
      _topK: number,
      _hypothesis?: string,
      accessContext?: AccessContext,
      retrievalScope?: { knowledgeBaseIds: string[] }
    ) => {
      state.vectorCalls += 1
      state.defaultArgs.push({ accessContext, retrievalScope })
      return vectorResults
    },
    bm25Search: async (
      _query: unknown,
      _topK: number,
      accessContext?: AccessContext,
      retrievalScope?: { knowledgeBaseIds: string[] }
    ) => {
      state.bm25Calls += 1
      state.defaultArgs.push({ accessContext, retrievalScope })
      return []
    },
    graphSearch: async () => [],
    pageIndexSearch: async (
      _query: unknown,
      _topK: number,
      accessContext?: AccessContext,
      retrievalScope?: { knowledgeBaseIds: string[] }
    ) => {
      state.pageIndexCalls += 1
      state.pageIndexArgs.push({ accessContext, retrievalScope })
      return pageIndexResults
    },
    rerank: async (_query: string, results: RetrievalResult[]) => results,
    loadParents: async () => {
      const all = [...vectorResults, ...pageIndexResults]
      return all.map((result) => result.parentChunk ?? result.chunk)
    },
  }
  return state as unknown as CountingOperations
}

interface Harness {
  app: express.Express
  answerRuntime: AnswerRuntime
  db: DB
  scopeDb: DB
  operations: CountingOperations
  chat: ScriptedChat
  close: () => Promise<void>
}

async function buildHarness(options: {
  operations?: CountingOperations
  selectorDelayMs?: number
  budgetMs?: number
  access?: "default" | "tenant"
} = {}): Promise<Harness> {
  const chat = scriptedChat(
    options.selectorDelayMs ? { selectorDelayMs: options.selectorDelayMs } : {}
  )
  const operations = options.operations ?? countingOperations()
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

  // A real knowledge-base service makes the chat router resolve a real,
  // server-computed scope for every request (AC09).
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
    searchOperations: operations,
    traceObserver: { onEvent: () => {} },
    ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
  })

  const app = express()
  app.use(express.json())
  if (options.access === "tenant") {
    app.use((_req, res, next) => {
      res.locals.accessContext = {
        ...singleTenantAccessContext(),
        tenantId: "demo",
      } satisfies AccessContext
      next()
    })
  }
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
    answerRuntime,
    db,
    scopeDb,
    operations,
    chat,
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

interface TerminalResult {
  status: string
  reply: string
  references?: Array<{ id: string }>
}

interface EventRecord {
  type: string
  stage?: string
  data?: Record<string, unknown>
  result?: TerminalResult
}

interface StageTrace {
  selectedTool?: string
  toolFallbackReason?: string
  decision?: string
}

async function postChat(
  port: number,
  message: string,
  sessionId: string
): Promise<{ status: number; events: EventRecord[] }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, stream: false, sessionId }),
  })
  const body = (await response.json()) as {
    events: EventRecord[]
  }
  return { status: response.status, events: body.events }
}

function terminal(events: EventRecord[]) {
  const done = events.filter((event) => event.type === "done")
  assert.equal(done.length, 1, "exactly one terminal event")
  return done[0].result!
}

/** The last published trace for a stage: the runner's aggregated trace. */
function stageTrace(events: EventRecord[], stage: string): StageTrace {
  const traced = events.filter(
    (event) => event.type === "progress" && event.stage === stage && event.data
  )
  return (traced.at(-1)?.data ?? {}) as StageTrace
}

test("DR-12 AC01/AC05: case-10 conceptual query replaces PageIndex before the executor", async () => {
  const harness = await buildHarness()
  const { server, port } = await listen(harness.app)
  try {
    const response = await postChat(port, CASE_10_QUERY, "dr12-case-10")
    assert.equal(response.status, 200)
    const result = terminal(response.events)

    assert.equal(result.status, "completed")
    assert.equal(
      harness.operations.pageIndexCalls,
      0,
      "the inapplicable PageIndex channel must never execute"
    )
    assert.ok(
      harness.operations.vectorCalls >= 1,
      "the default hybrid path executed instead"
    )
    const route = stageTrace(response.events, "route")
    const retrieval = stageTrace(response.events, "retrieval")
    assert.equal(route.selectedTool, "semantic_lexical_hybrid")
    assert.equal(retrieval.selectedTool, "semantic_lexical_hybrid")
    assert.match(
      retrieval.toolFallbackReason ?? "",
      /inapplicable_tool: pageindex_hierarchy/,
      "the trace records why the proposal was replaced"
    )
    assert.ok((result.references?.length ?? 0) >= 1)
  } finally {
    server.close()
    await harness.close()
  }
})

test("DR-12 AC02/AC04: concepts, definitions, general steps and a bare 文档 mention stay on hybrid", async () => {
  const queries = [
    "什么是检索增强生成？",
    "系统的定义是什么？",
    "部署的一般步骤有哪些？",
    "这份文档主要讲了什么？",
  ]
  for (const [index, message] of queries.entries()) {
    const harness = await buildHarness()
    const { server, port } = await listen(harness.app)
    try {
      const response = await postChat(port, message, `dr12-generic-${index}`)
      const result = terminal(response.events)
      assert.equal(result.status, "completed", message)
      assert.equal(
        harness.operations.pageIndexCalls,
        0,
        `PageIndex must not run for: ${message}`
      )
      const route = stageTrace(response.events, "route")
      assert.equal(route.selectedTool, "semantic_lexical_hybrid")
      assert.match(route.toolFallbackReason ?? "", /inapplicable_tool/)
    } finally {
      server.close()
      await harness.close()
    }
  }
})

test("DR-12 AC03: explicit page, section and table-of-contents navigation still executes PageIndex", async () => {
  const queries = ["第3页讲了什么？", "第二章的主要内容是什么？", "目录里有哪些章节？"]
  for (const [index, message] of queries.entries()) {
    const harness = await buildHarness({
      operations: countingOperations({
        pageIndexResults: [retrievalResult("page-1", "第3页说明融合后的重排。")],
      }),
    })
    const { server, port } = await listen(harness.app)
    try {
      const response = await postChat(port, message, `dr12-hierarchy-${index}`)
      const result = terminal(response.events)
      assert.equal(result.status, "completed", message)
      assert.equal(
        harness.operations.pageIndexCalls,
        1,
        `PageIndex must execute for: ${message}`
      )
      const route = stageTrace(response.events, "route")
      assert.equal(route.selectedTool, "pageindex_hierarchy")
      assert.equal(route.toolFallbackReason, undefined)
    } finally {
      server.close()
      await harness.close()
    }
  }
})

test("DR-12 AC06: a qualified PageIndex zero-result falls back to default exactly once", async () => {
  const harness = await buildHarness({
    access: "tenant",
    operations: countingOperations({ pageIndexResults: [] }),
  })
  const { server, port } = await listen(harness.app)
  try {
    const response = await postChat(port, "第9页的退货流程是什么？", "dr12-zero")
    const result = terminal(response.events)

    assert.equal(result.status, "completed")
    assert.equal(harness.operations.pageIndexCalls, 1, "PageIndex ran once")
    assert.equal(
      harness.operations.vectorCalls,
      1,
      "the default fallback ran exactly once"
    )
    assert.equal(harness.operations.bm25Calls, 1, "one default hybrid search only")
    const route = stageTrace(response.events, "route")
    assert.equal(route.selectedTool, "pageindex_hierarchy")
    assert.match(
      route.toolFallbackReason ?? "",
      /pageindex_hierarchy returned 0 results; retried with default hybrid retrieval/
    )
    // AC09: both the direct PageIndex path and the default-hybrid fallback keep
    // the same server-computed identity and locked scope.
    const pageIndexScope = harness.operations.pageIndexArgs[0]
    const fallbackScope = harness.operations.defaultArgs[0]
    assert.equal(pageIndexScope.accessContext?.tenantId, "demo")
    assert.equal(fallbackScope.accessContext?.tenantId, "demo")
    assert.deepEqual(pageIndexScope.retrievalScope?.knowledgeBaseIds, [
      defaultKnowledgeBaseId("demo"),
    ])
    assert.deepEqual(fallbackScope.retrievalScope?.knowledgeBaseIds, [
      defaultKnowledgeBaseId("demo"),
    ])
  } finally {
    server.close()
    await harness.close()
  }
})

test("DR-12 AC07/AC09: the replacement adds no model request and keeps identity, scope and query", async () => {
  const harness = await buildHarness({ access: "tenant" })
  const { server, port } = await listen(harness.app)
  try {
    const response = await postChat(port, CASE_10_QUERY, "dr12-identity")
    terminal(response.events)

    assert.equal(
      harness.chat.selectorQueries.length,
      1,
      "exactly one selector model call; the check adds no request"
    )
    assert.equal(harness.chat.selectorQueries[0], CASE_10_QUERY)
    assert.ok(harness.chat.calls.filter((c) => c.includes("retrieval strategy selector")).length === 1)

    const seen = harness.operations.defaultArgs[0]
    assert.ok(seen, "the default path executed")
    assert.equal(seen.accessContext?.tenantId, "demo")
    assert.deepEqual(seen.retrievalScope?.knowledgeBaseIds, [
      defaultKnowledgeBaseId("demo"),
    ])
  } finally {
    server.close()
    await harness.close()
  }
})

test("DR-12 AC08: a cancelled run is not converted into an applicability fallback", async () => {
  const harness = await buildHarness({ selectorDelayMs: 150, budgetMs: 5 })
  const { server, port } = await listen(harness.app)
  try {
    const response = await postChat(port, CASE_10_QUERY, "dr12-cancel")
    const result = terminal(response.events)

    assert.equal(result.status, "cancelled")
    assert.equal(
      harness.operations.pageIndexCalls,
      0,
      "no PageIndex call after cancellation"
    )
    assert.equal(
      harness.operations.vectorCalls,
      0,
      "no default call after cancellation either"
    )
  } finally {
    server.close()
    await harness.close()
  }
})
