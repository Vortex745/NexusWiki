/**
 * Ticket 52 (ARCH-01E) — the tool and MCP layer behind AnswerRouteStack.
 *
 * What moved: the built-in read-only tool registry, the MCP capability
 * discovery and the invocation seam the capabilities router publishes. They
 * are now composed by the route stack, so the risk this suite pins is that a
 * run WITHOUT any authorized capability still follows the no-tool path and
 * publishes no capability surface — the route stack must not hand out a
 * broader registry than the run was given.
 *
 * What is pinned here instead of behaviorally:
 *   - the single registration site, the caller-owned db handle, the MCP-only
 *     allowlist on the published seam and the status/seam asymmetry live in
 *     `answer_composition_boundaries.test.ts` (structural);
 *   - a LIVE discovery-and-call round trip was run by hand against this
 *     composition (`connected: true`, the five capability tools, an `ok`
 *     invocation carrying `{tool, argsSummary, outcome, durationMs}`, and a
 *     business tool refused as `policy_denied`). It is not automated because
 *     the composition keeps no handle to close the stdio child — the MCP SDK
 *     spawns it with a filtered environment, so no test can break it from the
 *     outside either. The bridge itself is covered live by
 *     `src/mcp/capability_server.test.ts`.
 *
 * Boundary: lives in src/mastra/* and MUST NOT import src/api/*,
 * src/evaluation/* or src/index (T02 #5).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import type OpenAI from "openai"
import type { AppConfig } from "../config"
import { openDb } from "../ingestion/tracking/db"
import type { ConversationStore } from "../answer/conversation_store"
import type { HandoffStore } from "../answer/handoff_store"
import { createAnswerRouteStack } from "./answer_route_stack"

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

/**
 * The route stack only calls its collaborators during a run, so unused seams
 * need no behavior here — the composition itself is the subject.
 */
function compose() {
  return createAnswerRouteStack({
    config,
    answerModelClient: {
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content: "direct" } }] }),
        },
      },
    } as unknown as OpenAI,
    db: openDb(":memory:"),
    createSearcher: (() => ({})) as never,
    conversationStore: {} as ConversationStore,
    handoffStore: {} as HandoffStore,
  })
}

test("ARCH-01E #5: a run with no MCP capability composes the route stack with no capability surface", async () => {
  const stack = await compose()
  assert.equal(typeof stack.runner, "function", "routing is composed unchanged")
  // No bridge → nothing to stamp and nothing to call. The established
  // degraded state is the ABSENCE of the surface, never an empty registry.
  assert.equal(stack.mcpStatus, undefined)
  assert.equal(stack.mcp, undefined)
})

test("ARCH-01E #6: the route stack publishes one runner and no tool internals", async () => {
  const stack = await compose()
  // A tool or MCP caller gets the SAME single runner the entry adapts — never
  // a second dispatch seam, and never the registry, the searcher factory or
  // the db handle the tools read through.
  assert.deepEqual(Object.keys(stack).sort(), ["runner"])
  assert.equal(typeof stack.runner, "function")
})

test("Clef route stack uses the configured provider once and preserves its trace", async () => {
  const previousFetch = globalThis.fetch
  const db = openDb(":memory:")
  let cloudflareCalls = 0
  let chatCalls = 0
  globalThis.fetch = async (input, init) => {
    cloudflareCalls++
    assert.match(String(input), /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\//)
    assert.ok(init?.signal, "real provider call must be cancellable")
    const request = JSON.parse(String(init?.body))
    assert.equal(request.state.query, "它怎么设置？")
    return Response.json({
      success: true,
      result: {
        model: "clef",
        answers: { route: {
          type: "choice", choice: "ambiguous", confidence: 0.65,
          probabilities: { direct: 0.05, simple: 0.1, ambiguous: 0.8, complex: 0.05 },
        } },
        usage: { input_tokens: 45, output_tokens: 0 },
      },
    })
  }
  try {
    const stack = await createAnswerRouteStack({
      config: {
        ...config, decisionProvider: "clef", cloudflareAccountId: "test-account",
        cloudflareApiToken: "test-token", decisionRequestTimeoutMs: 1_000,
      },
      answerModelClient: {
        chat: { completions: { create: async () => {
          chatCalls++
          return { choices: [{ message: { content: "direct" } }] }
        } } },
      } as unknown as OpenAI,
      db,
      createSearcher: (() => ({})) as never,
      conversationStore: {
        loadConversationMemory: () => ({ recentTurns: [], summary: null }),
        savePendingClarification: () => {},
        consumePendingClarification: () => null,
        saveValidatedTurn: () => {},
      } as unknown as ConversationStore,
      handoffStore: {} as HandoffStore,
      streamDirectReply: async function* () { yield "unused" },
    })
    const result = await stack.runner({
      message: "它怎么设置？", runId: "clef-route-stack", sessionId: "clef-stack-session",
      signal: new AbortController().signal,
      accessContext: { tenantId: "default", subjectId: "test", groups: [], scopes: ["chat"] },
    })
    assert.equal(result.status, "clarification_required")
    assert.equal(result.routeTrace.decision, "ambiguous")
    assert.equal(result.routeTrace.routingModel?.actualModel, "clef")
    assert.equal(result.routeTrace.routingModel?.usage.totalTokens, 45)
    assert.equal(result.routeTrace.routingModel?.confidence, 0.65)
    assert.equal(cloudflareCalls, 1)
    assert.equal(chatCalls, 0, "Clef replaces the Chat classifier")
  } finally {
    globalThis.fetch = previousFetch
    db.close()
  }
})

// ---------------------------------------------------------------------------
// Reasoning effort: BOTH knowledge draft closures must forward the run's
// frozen choice into the real generation call, and no other collaborator
// (router, tool selector, critic, planner, contextualizer) may grow the field.
// ---------------------------------------------------------------------------

interface ChatCall {
  stream: boolean
  reasoning: unknown
  system: string
}

function makeScriptedChat(route: "simple" | "complex"): {
  client: OpenAI
  calls: ChatCall[]
} {
  const calls: ChatCall[] = []
  let loopStep = 0
  const create = async (params: {
    messages: Array<{ role: string; content: string }>
    stream?: boolean
    reasoning_effort?: unknown
  }) => {
    const system =
      params.messages.find((message) => message.role === "system")?.content ?? ""
    const lastUser =
      [...params.messages].reverse().find((message) => message.role === "user")?.content ?? ""
    calls.push({
      stream: params.stream === true,
      reasoning: params.reasoning_effort,
      system: system.slice(0, 40),
    })
    if (system.includes("Classify the query")) {
      return { choices: [{ message: { content: route } }] }
    }
    if (system.includes("retrieval strategy selector")) {
      return { choices: [{ message: {} }] }
    }
    if (system.includes("You are a retrieval planner")) {
      loopStep += 1
      return {
        choices: [{
          message: {
            tool_calls: [{
              id: `call-${loopStep}`,
              type: "function",
              function: {
                name: loopStep === 1 ? "semantic_lexical_hybrid" : "stop_loop",
                arguments: JSON.stringify(
                  loopStep === 1 ? { query: "退货政策" } : { reason: "evidence-sufficient" }
                ),
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
            }),
          },
        }],
      }
    }
    if (system.includes("你是智能客服助手")) {
      const cited = lastUser.match(/\[cite:(ev_[a-f0-9]+)\]/)?.[1]
      const reply = cited
        ? `知识库确认：可以在 14 天内退货。[cite:${cited}]`
        : "知识库确认。"
      if (params.stream) {
        async function* tokenStream() {
          yield { choices: [{ delta: { content: reply.slice(0, 6) } }] }
          yield { choices: [{ delta: { content: reply.slice(6) } }] }
        }
        return tokenStream()
      }
      return { choices: [{ message: { content: reply } }] }
    }
    const followUp = lastUser.split("当前追问：").pop() ?? lastUser
    return { choices: [{ message: { content: followUp } }] }
  }
  return { client: { chat: { completions: { create } } } as unknown as OpenAI, calls }
}

function retrievalOutcome() {
  return {
    status: "ok" as const,
    results: [{
      chunk: {
        id: "chunk-1",
        documentId: "doc-1",
        content: "退货窗口为 14 天。",
        childrenIds: [],
        metadata: {},
      },
      score: 0.9,
      source: "vector" as const,
      wikilinks: [],
    }],
    unavailableChannels: [],
  }
}

function conversationStoreDouble(): ConversationStore {
  return {
    saveValidatedTurn: () => {},
    savePendingClarification: () => {},
    loadConversationMemory: () => ({
      totalValidatedTurnCount: 0,
      oldestRecentTurnId: null,
      summary: null,
      summarizedThroughTurnId: null,
      recentTurns: [],
    }),
    loadOlderTurnsForSummarization: () => [],
    saveRollingSummary: () => {},
    consumePendingClarification: () => null,
  } as unknown as ConversationStore
}

async function runKnowledgeRoute(route: "simple" | "complex", effort?: "high" | "max") {
  const chat = makeScriptedChat(route)
  const db = openDb(":memory:")
  try {
    const stack = await createAnswerRouteStack({
      config,
      answerModelClient: chat.client,
      db,
      createSearcher: (() => ({ search: async () => retrievalOutcome() })) as never,
      conversationStore: conversationStoreDouble(),
      handoffStore: {} as HandoffStore,
      streamDirectReply: async function* () {
        yield "unused"
      },
    })
    const output = await stack.runner({
      message: "退货政策是什么？",
      runId: `run-stack-${route}`,
      sessionId: `sess-stack-${route}`,
      signal: new AbortController().signal,
      accessContext: { tenantId: "default", subjectId: "test", groups: [], scopes: ["chat"] },
      ...(effort ? { reasoningEffort: effort } : {}),
    })
    return { output, calls: chat.calls }
  } finally {
    db.close()
  }
}

function draftCalls(calls: ChatCall[]): ChatCall[] {
  return calls.filter((call) => call.stream === true)
}

test("the simple draft closure forwards the run's reasoning effort and nothing else grows it", async () => {
  const withEffort = await runKnowledgeRoute("simple", "high")
  assert.equal(withEffort.output.status, "completed")
  const drafts = draftCalls(withEffort.calls)
  assert.equal(drafts.length, 1, "the simple route generated exactly one draft")
  assert.equal(drafts[0].reasoning, "high")
  const others = withEffort.calls.filter((call) => call.stream !== true)
  assert.ok(others.length >= 3, "router, tool selector and critic all ran")
  for (const call of others) {
    assert.equal("reasoning" in call && call.reasoning !== undefined, false,
      `a non-generation collaborator received reasoning_effort: ${call.system}`)
  }
})

test("the complex draft closure forwards the run's reasoning effort and nothing else grows it", async () => {
  const withEffort = await runKnowledgeRoute("complex", "max")
  assert.equal(withEffort.output.status, "completed", JSON.stringify(withEffort.output.degradation))
  const drafts = draftCalls(withEffort.calls)
  assert.equal(drafts.length, 1, "the complex route generated exactly one draft")
  assert.equal(drafts[0].reasoning, "max")
  const others = withEffort.calls.filter((call) => call.stream !== true)
  assert.ok(others.length >= 3, "router, loop controller and critic all ran")
  for (const call of others) {
    assert.equal("reasoning" in call && call.reasoning !== undefined, false,
      `a non-generation collaborator received reasoning_effort: ${call.system}`)
  }
})

test("an omitted reasoning effort reaches neither draft closure", async () => {
  const simple = await runKnowledgeRoute("simple")
  const complex = await runKnowledgeRoute("complex")
  assert.equal(simple.output.status, "completed")
  assert.equal(complex.output.status, "completed", JSON.stringify(complex.output.degradation))
  for (const call of [...simple.calls, ...complex.calls]) {
    assert.equal(call.reasoning, undefined, "no request may invent a reasoning effort")
  }
})
