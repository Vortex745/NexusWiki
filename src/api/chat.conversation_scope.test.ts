/**
 * Ticket 21 (CONV-01B) — session scope lock and branch-correct replacement.
 *
 * The transport seam is the proof: a captured AnswerRunOptions shows which
 * assistant VERSION and which knowledge subset a run actually received, and
 * the store shows what a branch truncation left behind. Covered here:
 *
 * - the first message locks assistant version + authorized knowledge subset,
 *   and later requests (even naming a newer version) cannot move it;
 * - a locked subset that can no longer be resolved fails CLOSED (no knowledge)
 *   instead of falling back to the request's selection;
 * - an overlapping run for the same session is refused before any work;
 * - a terminal event that belongs to another run is never recorded;
 * - edit/regenerate (truncateFromRunId) drops the replaced run and later
 *   memory, including the rolling summary derived from it.
 */

import assert from "node:assert/strict"
import test from "node:test"
import type { AddressInfo } from "node:net"
import type { RequestHandler } from "express"

import { openDb } from "../ingestion/tracking/db"
import { createApp } from "../api/server"
import type { AnswerRunOptions } from "../answer/generation"
import type { AnswerRunEvent } from "../types"
import { KnowledgeBaseServiceImpl } from "../knowledge/knowledge_base_service"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { createRetrievalScopeResolver } from "../retrieval/scope"
import { AssistantService, type AssistantVersionConfig } from "../assistants/assistant_service"
import { SqliteConversationHistoryStore } from "../answer/conversation_history_store"
import { SqliteConversationStore } from "../answer/conversation_store"
import type { AccessContext } from "../access/context"

function identity(): RequestHandler {
  return (_req, res, next) => {
    res.locals.accessContext = {
      tenantId: "t1",
      subjectId: "u1",
      groups: [],
      scopes: ["admin", "chat"],
    } as AccessContext
    next()
  }
}

async function listen(app: import("express").Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function doneEvent(sessionId: string, runId: string, status: string, reply: string): AnswerRunEvent {
  return {
    schemaVersion: 1,
    sessionId,
    runId,
    eventId: "e-done",
    sequence: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    stage: "done",
    status: "completed",
    durationMs: null,
    attempt: 1,
    round: 1,
    inputSummary: "",
    outputSummary: "",
    type: "done",
    result: {
      runId,
      status,
      reply,
      references: [],
      degradation: { status: "none" },
    },
  } as unknown as AnswerRunEvent
}

function config(overrides: Partial<AssistantVersionConfig> = {}): AssistantVersionConfig {
  return {
    systemPrompt: "",
    knowledgeBaseIds: [],
    chatModelProfileId: "chat",
    rerankModelProfileId: null,
    toolPolicy: "read_only_retrieval",
    memoryEnabled: false,
    ...overrides,
  }
}

function buildHarness(
  source?: (message: string, options: AnswerRunOptions) => AsyncIterable<AnswerRunEvent>
) {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  const db = openDb(":memory:")
  const knowledgeBases = new KnowledgeBaseServiceImpl(new SqliteKnowledgeBaseRepo(db), "test-embedding:3")
  const assistants = new AssistantService(db, knowledgeBases)
  const history = new SqliteConversationHistoryStore(db)
  const memory = new SqliteConversationStore(db)
  const captured: AnswerRunOptions[] = []

  const eventsSource = async function* (
    message: string,
    options: AnswerRunOptions
  ): AsyncIterable<AnswerRunEvent> {
    captured.push(options)
    if (source) {
      yield* source(message, options)
      return
    }
    yield doneEvent(options.sessionId ?? "s", options.runId ?? "r", "completed", "ok")
  }

  const app = createApp({
    db,
    eventsSource,
    accessMiddleware: identity(),
    retrievalScopeResolver: createRetrievalScopeResolver(knowledgeBases),
    knowledgeBaseService: knowledgeBases,
    assistants,
    conversationHistory: history,
  })

  return { db, knowledgeBases, assistants, history, memory, captured, app }
}

/**
 * Sends one chat request and DRAINS the body. Reading to the end guarantees
 * the server-side run finished (and released its session slot) before the
 * next request in the same session is sent.
 */
async function chat(base: string, body: Record<string, unknown>) {
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "问题", ...body }),
  })
  return { status: response.status, text: await response.text() }
}

test("the first message locks the assistant version and knowledge subset against later requests", async () => {
  const harness = buildHarness()
  const { base, close } = await listen(harness.app)
  try {
    const kbA = harness.knowledgeBases.create("t1", "库A")
    const kbB = harness.knowledgeBases.create("t1", "库B")
    const assistant = harness.assistants.create("t1", "admin", {
      name: "政策助手",
      config: config({ systemPrompt: "第一版", knowledgeBaseIds: [kbB.id] }),
    })

    const first = await chat(base, { sessionId: "sess-lock", assistantId: assistant.id })
    assert.equal(first.status, 200)
    assert.equal(harness.captured.at(-1)?.assistant?.version, 1)
    assert.deepEqual(harness.captured.at(-1)?.retrievalScope?.knowledgeBaseIds, [kbB.id])
    assert.deepEqual(harness.history.getSessionLock("sess-lock", "t1", "u1"), {
      assistantId: assistant.id,
      assistantVersion: 1,
      knowledgeBaseIds: [kbB.id],
    })

    // The assistant is edited (version 2, different prompt and binding).
    harness.assistants.edit(assistant.id, "t1", "admin", {
      config: config({ systemPrompt: "第二版", knowledgeBaseIds: [kbA.id] }),
    })

    // The saved conversation keeps version 1 and the locked 库B, even though
    // this request names nothing and the workspace now offers version 2.
    const second = await chat(base, { sessionId: "sess-lock", assistantId: assistant.id })
    assert.equal(second.status, 200)
    const captured = harness.captured.at(-1)
    assert.equal(captured?.assistant?.version, 1, "the locked version stays authoritative")
    assert.equal(captured?.assistant?.systemPrompt, "第一版")
    assert.deepEqual(captured?.retrievalScope?.knowledgeBaseIds, [kbB.id])
    assert.deepEqual(harness.history.getSessionLock("sess-lock", "t1", "u1"), {
      assistantId: assistant.id,
      assistantVersion: 1,
      knowledgeBaseIds: [kbB.id],
    })
  } finally {
    await close()
  }
})

test("a locked knowledge subset that cannot be resolved fails closed instead of widening", async () => {
  const harness = buildHarness()
  const { base, close } = await listen(harness.app)
  try {
    const kbA = harness.knowledgeBases.create("t1", "库A")
    const kbB = harness.knowledgeBases.create("t1", "库B")

    await chat(base, { sessionId: "sess-failclosed", knowledgeBaseIds: [kbB.id] })
    assert.deepEqual(harness.captured.at(-1)?.retrievalScope?.knowledgeBaseIds, [kbB.id])

    // The locked base is archived: the session may not fall back to whatever
    // this request selects (库A) — it runs with no knowledge context.
    harness.knowledgeBases.archive(kbB.id, "t1")
    const response = await chat(base, { sessionId: "sess-failclosed", knowledgeBaseIds: [kbA.id] })
    assert.equal(response.status, 200)
    assert.deepEqual(harness.captured.at(-1)?.retrievalScope?.knowledgeBaseIds, [])
  } finally {
    await close()
  }
})

test("an overlapping run for the same session is refused before any answer work", async () => {
  let releaseRun: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    releaseRun = resolve
  })
  const harness = buildHarness(async function* (_message, options) {
    await gate
    yield doneEvent(options.sessionId ?? "s", options.runId ?? "r", "completed", "ok")
  })
  const { base, close } = await listen(harness.app)
  try {
    // NOT drained yet: it stays parked on the gate, holding the session slot.
    const inFlight = chat(base, { sessionId: "sess-overlap", runId: "run-first" })
    // Wait until the first run reached the source (it is parked on the gate).
    for (let wait = 0; harness.captured.length === 0 && wait < 50; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(harness.captured.length, 1)

    const overlapping = await chat(base, { sessionId: "sess-overlap", runId: "run-second" })
    assert.equal(overlapping.status, 409)
    assert.match(String((JSON.parse(overlapping.text) as { error?: string }).error), /already active/)
    assert.equal(harness.captured.length, 1, "the refused run never reached the source")

    releaseRun()
    const first = await inFlight
    assert.equal(first.status, 200)

    // The guard is released with the response: the next run is accepted.
    const next = await chat(base, { sessionId: "sess-overlap", runId: "run-third" })
    assert.equal(next.status, 200)
    assert.equal(harness.captured.length, 2)
  } finally {
    await close()
  }
})

test("a terminal event carrying another run's id is not recorded", async () => {
  const harness = buildHarness(async function* (_message, options) {
    yield doneEvent(options.sessionId ?? "s", "run-somebody-else", "cancelled", "半截回答")
  })
  const { base, close } = await listen(harness.app)
  try {
    const response = await chat(base, { sessionId: "sess-foreign", runId: "run-own" })
    assert.equal(response.status, 200)
    assert.deepEqual(harness.history.getTurns("sess-foreign", "t1", "u1"), [])
  } finally {
    await close()
  }
})

test("edit and regenerate drop the replaced run, later memory and the derived summary", async () => {
  const harness = buildHarness()
  const { base, close } = await listen(harness.app)
  try {
    const writePair = (runId: string, user: string, assistant: string, at: string) => {
      harness.memory.saveValidatedTurn({
        sessionId: "sess-branch", tenantId: "t1", role: "user", content: user, runId, createdAt: at,
      })
      harness.memory.saveValidatedTurn({
        sessionId: "sess-branch", tenantId: "t1", role: "assistant", content: assistant, runId,
        createdAt: new Date(Date.parse(at) + 5).toISOString(),
      })
    }
    writePair("run-1", "第一问", "第一答", "2026-01-01T00:00:01.000Z")
    writePair("run-2", "第二问", "第二答", "2026-01-01T00:00:02.000Z")
    writePair("run-3", "第三问", "第三答", "2026-01-01T00:00:03.000Z")
    harness.memory.saveRollingSummary("sess-branch", "t1", "覆盖 run-2/run-3 的摘要", 6, 1)
    assert.ok(harness.memory.getRollingSummary("sess-branch", "t1"))

    // Re-questioning the run-2 branch: run-2 and everything after it go.
    const response = await chat(base, {
      sessionId: "sess-branch",
      runId: "run-2-again",
      truncateFromRunId: "run-2",
    })
    assert.equal(response.status, 200)
    assert.deepEqual(
      harness.memory.loadRecentTurns("sess-branch", "t1", 20).map((turn) => turn.content),
      ["第一问", "第一答"]
    )
    assert.equal(
      harness.memory.getRollingSummary("sess-branch", "t1"),
      null,
      "a summary covering dropped turns cannot survive the truncation"
    )

    // A malformed anchor is refused before any run.
    const malformed = await chat(base, { sessionId: "sess-branch", truncateFromRunId: "not a run id!" })
    assert.equal(malformed.status, 400)
  } finally {
    await close()
  }
})

test("a legacy request locks the default assistant without scanning the workspace", async () => {
  const harness = buildHarness()
  let listCalls = 0
  const originalList = harness.knowledgeBases.list.bind(harness.knowledgeBases)
  harness.knowledgeBases.list = (tenantId: string) => {
    listCalls += 1
    return originalList(tenantId)
  }

  const { base, close } = await listen(harness.app)
  try {
    const response = await chat(base, { sessionId: "sess-default" })
    assert.equal(response.status, 200)
    const captured = harness.captured.at(-1)
    // The default assistant IS the legacy path: no overlay is applied...
    assert.equal(captured?.assistant, undefined)
    assert.ok(captured?.retrievalScope?.knowledgeBaseIds.length, "the default base is used")
    // ...but the session still records which assistant and version it ran on.
    assert.deepEqual(harness.history.getSessionLock("sess-default", "t1", "u1"), {
      assistantId: "assistant-default-t1",
      assistantVersion: 1,
      knowledgeBaseIds: captured?.retrievalScope?.knowledgeBaseIds ?? [],
    })
    assert.equal(listCalls, 0, "the workspace is never scanned to find the default")
  } finally {
    await close()
  }
})
