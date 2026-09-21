/**
 * Eval refactor Ticket 01 — Shared Answer run entry tests.
 *
 * Verifies the acceptance criteria from
 * `.scratch/eval-refactor-tickets/issues/01-shared-answer-runtime.md`:
 *   #2 the shared entry composes the production topology (real chat event
 *      adapter + workflow wrapper + route dispatch + route runners) —
 *      asserted by running a full direct-route Answer end to end
 *   #3 injected repositories and observers are honored (conversation store,
 *      handoff store, trace observer, extra observers, direct reply stream)
 *      with no HTTP handler or evaluation dependency
 *   #4 observation data correlates run + case (caseId stamped on every
 *      event; ordered final-context candidates are covered at the runner
 *      seam in simple/complex knowledge runner tests)
 *
 * Boundary: owned by src/mastra/* and MUST NOT import src/api/* or
 * src/index (T02 #5 dependency direction).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import type OpenAI from "openai"
import type { Client as ElasticsearchClient } from "@elastic/elasticsearch"
import type { Driver } from "neo4j-driver"
import type { AppConfig } from "../config"
import type { AnswerRunEvent } from "../types"
import type { AnswerRunObserver } from "../answer/generation"
import { createAnswerRuntime } from "../answer/runtime"
import type {
  ConversationStore,
  ConversationTurn,
} from "../answer/conversation_store"
import type { HandoffStore } from "../answer/handoff_store"
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
  activationMode: "auto",
  conversationTtlDays: 30,
  conversationGcIntervalMs: 86_400_000,
  rerankApiKey: "",
  rerankBaseUrl: "https://api.edgefn.net/v1",
  rerankModel: "bge-reranker-v2-m3",
  rerankTimeoutMs: 30_000,
  rerankMaxDocumentChars: 4_000,
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Fake OpenAI chat client that routes by system prompt:
 *   - RouterImpl ("Classify the query") → the scripted route decision
 *   - ContextualizerImpl ("改写器") → echoes the follow-up verbatim
 */
function makeFakeChatClient(routeDecision: string): OpenAI {
  const create = async (params: {
    messages: Array<{ role: string; content: string }>
  }) => {
    const system =
      params.messages.find((m) => m.role === "system")?.content ?? ""
    if (system.includes("Classify the query")) {
      return { choices: [{ message: { content: routeDecision } }] }
    }
    const lastUser =
      [...params.messages].reverse().find((m) => m.role === "user")
        ?.content ?? ""
    const followUp = lastUser.split("当前追问：").pop() ?? lastUser
    return { choices: [{ message: { content: followUp } }] }
  }
  return { chat: { completions: { create } } } as unknown as OpenAI
}

function factory(chat: OpenAI) {
  return {
    createChatClient: () => chat,
    createEmbeddingClient: () => ({}) as OpenAI,
    createElasticsearchClient: () =>
      ({ close: async () => {} }) as unknown as ElasticsearchClient,
    createNeo4jDriver: () =>
      ({ close: async () => {} }) as unknown as Driver,
  }
}

function makeFakeConversationStore(): ConversationStore & {
  validatedTurns: ConversationTurn[]
} {
  const validatedTurns: ConversationTurn[] = []
  return {
    validatedTurns,
    saveValidatedTurn(turn: ConversationTurn): void {
      validatedTurns.push(turn)
    },
    savePendingClarification(): void { /* no-op */ },
    loadConversationMemory(): unknown {
      return {
        totalValidatedTurnCount: 0,
        oldestRecentTurnId: null,
        summary: null,
        summarizedThroughTurnId: null,
        recentTurns: [],
      }
    },
    loadOlderTurnsForSummarization(): ConversationTurn[] { return [] },
    saveRollingSummary(): void { /* no-op */ },
    consumePendingClarification(): string | null { return null },
  } as unknown as ConversationStore & { validatedTurns: ConversationTurn[] }
}

function makeFakeHandoffStore(): HandoffStore {
  return {
    create: () => null,
    getById: () => null,
    getByRunId: () => null,
    listByTenant: () => [],
  } as unknown as HandoffStore
}

// ---------------------------------------------------------------------------
// Ticket 01 #2 + #3 + #4 — direct route through the full shared entry with
// every injection seam exercised.
// ---------------------------------------------------------------------------

test("Ticket 01: shared entry runs the production direct route with injected repositories and observers", async () => {
  const answerRuntime = createAnswerRuntime(
    config,
    factory(makeFakeChatClient("direct"))
  )
  try {
    const conversationStore = makeFakeConversationStore()
    const handoffStore = makeFakeHandoffStore()
    const traceEvents: AnswerRunEvent[] = []
    const traceObserver: AnswerRunObserver = {
      onEvent: (e) => traceEvents.push(e),
    }
    const observed: AnswerRunEvent[] = []
    const observers: AnswerRunObserver[] = [
      { onEvent: (e) => observed.push(e) },
    ]

    const entry = await createSharedAnswerEntry({
      config,
      answerRuntime,
      conversationStore,
      handoffStore,
      traceObserver,
      observers,
      streamDirectReply: async function* scriptedDirectReply() {
        yield "您好"
        yield "，很高兴为您服务"
      },
    })

    const events: AnswerRunEvent[] = []
    for await (const event of entry.eventsSource("你好", {
      runId: "run-entry-1",
      sessionId: "sess-entry-1",
      caseId: "case-entry-1",
    })) {
      events.push(event)
    }

    // Single terminal done event with completed status (production topology
    // executed end to end through the shared entry).
    const done = events.filter((e) => e.type === "done")
    assert.equal(done.length, 1)
    assert.equal(done[0].status, "completed")

    // Ticket 01 #4: every event correlates the injected caseId.
    for (const e of events) {
      assert.equal(e.caseId, "case-entry-1")
    }

    // Ticket 01 #3: the injected trace observer and soft observers each saw
    // the full stream in consumer order.
    assert.equal(traceEvents.length, events.length)
    assert.deepEqual(
      traceEvents.map((e) => e.eventId),
      events.map((e) => e.eventId)
    )
    assert.deepEqual(
      observed.map((e) => e.eventId),
      events.map((e) => e.eventId)
    )

    // Ticket 01 #3: the injected conversation store captured the validated
    // direct turn (the default SQLite store was NOT used).
    assert.ok(conversationStore.validatedTurns.length >= 1)
  } finally {
    await answerRuntime.processRuntime.close()
  }
})

// ---------------------------------------------------------------------------
// Ticket 01 #5 — normal chat (no caseId) leaves the event payload unchanged.
// ---------------------------------------------------------------------------

test("Ticket 01: normal chat without caseId leaves events free of the field", async () => {
  const answerRuntime = createAnswerRuntime(
    config,
    factory(makeFakeChatClient("direct"))
  )
  try {
    const entry = await createSharedAnswerEntry({
      config,
      answerRuntime,
      conversationStore: makeFakeConversationStore(),
      handoffStore: makeFakeHandoffStore(),
      traceObserver: { onEvent: () => {} },
      streamDirectReply: async function* () {
        yield "你好"
      },
    })
    const events: AnswerRunEvent[] = []
    for await (const event of entry.eventsSource("hi", {
      runId: "run-entry-2",
      sessionId: "sess-entry-2",
    })) {
      events.push(event)
    }
    assert.ok(events.length >= 2)
    for (const e of events) {
      assert.equal("caseId" in e, false)
    }
  } finally {
    await answerRuntime.processRuntime.close()
  }
})

// ---------------------------------------------------------------------------
// Ticket 01 #3 — the budgetMs injection seam reaches the adapter (deadline
// expiry converges to one cancelled terminal — acceptance criterion #5's
// budget behavior is preserved behind the seam).
// ---------------------------------------------------------------------------

test("Ticket 01: injected budgetMs bounds the run (deadline expiry → cancelled terminal)", async () => {
  const answerRuntime = createAnswerRuntime(
    config,
    factory(makeFakeChatClient("direct"))
  )
  try {
    const entry = await createSharedAnswerEntry({
      config,
      answerRuntime,
      conversationStore: makeFakeConversationStore(),
      handoffStore: makeFakeHandoffStore(),
      traceObserver: { onEvent: () => {} },
      budgetMs: 5,
      streamDirectReply: async function* slowDirectReply(_message, signal) {
        await new Promise((resolve) => setTimeout(resolve, 80))
        assert.equal(signal.aborted, true, "budget deadline must abort the stream signal")
        yield "late token"
      },
    })
    const events: AnswerRunEvent[] = []
    for await (const event of entry.eventsSource("你好", {
      runId: "run-entry-3",
      sessionId: "sess-entry-3",
      caseId: "case-entry-3",
    })) {
      events.push(event)
    }
    const done = events.filter((e) => e.type === "done")
    assert.equal(done.length, 1, "exactly one terminal event")
    assert.equal(done[0].status, "cancelled", "deadline expiry → cancelled")
    assert.equal(done[0].caseId, "case-entry-3", "cancelled terminal still correlates the case")
  } finally {
    await answerRuntime.processRuntime.close()
  }
})

// ---------------------------------------------------------------------------
// Ticket 01 #3 — dependency boundary (T02 #5): the shared entry must not
// depend on HTTP handlers or evaluation modules.
// ---------------------------------------------------------------------------

test("Ticket 01: shared entry has no HTTP or evaluation dependency (T02 #5)", () => {
  const source = readFileSync(
    path.resolve(process.cwd(), "src/mastra/shared_answer_entry.ts"),
    "utf8"
  )
  assert.equal(/from\s+["']\.\.\/api\//.test(source), false)
  assert.equal(/from\s+["']\.\.\/evaluation\//.test(source), false)
  assert.equal(/from\s+["']\.\.\/index["']/.test(source), false)
})
