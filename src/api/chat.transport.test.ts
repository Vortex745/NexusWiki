import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"
import { createChatRouter, type AnswerEventsSource } from "./chat"
import { AnswerTraceRepository } from "../answer/trace_repository"
import { SqliteConversationHistoryStore } from "../answer/conversation_history_store"
import type { AnswerRunEvent, AnswerRunResult } from "../types"
import { openDb } from "../ingestion/tracking/db"
import { createMastraChatEventAdapter } from "../mastra/chat_event_adapter"
import type { MastraRunner } from "../mastra/chat_event_adapter"
import { createFaqExactMatchRunner } from "../mastra/faq_exact_runner"
import { FaqEntryServiceImpl } from "../faq/faq_entry_service"
import { SqliteFaqEntryRepo } from "../faq/faq_entry_repo"
import { SqliteConversationStore } from "../answer/conversation_store"
import { ConversationImpl } from "../frontend/conversation"

/**
 * T51: Transport parity tests. These tests inject a stub `eventsSource` so they
 * verify only SSE/JSON encoding shape — they do NOT depend on Answer behavior
 * or live providers. Answer behavior is covered by generation.t51.test.ts.
 */

const FIXED_RUN_ID = "run-fixed-0001"
const FIXED_SESSION_ID = "sess-fixed-0001"

function makeTerminalResult(status: AnswerRunResult["status"], runId: string): AnswerRunResult {
  return {
    runId,
    status,
    reply: "hello world",
    references: [],
    degradation: { status: "none", unavailableChannels: [] },
  }
}

/**
 * Build a fixed sequence of events that honor the runId/sessionId passed in
 * via options — this lets transport tests assert encoding parity without
 * depending on Answer behavior.
 */
function makeEvents(runId: string, sessionId: string): AnswerRunEvent[] {
  const createdAt = "2026-07-16T00:00:00.000Z"
  const base = {
    schemaVersion: 1 as const,
    sessionId,
    runId,
    createdAt,
    status: "running" as const,
    durationMs: null,
    attempt: 1,
    round: 0,
    inputSummary: "",
    outputSummary: "",
  }
  return [
    {
      ...base,
      type: "progress",
      stage: "route",
      message: "",
      data: {},
      eventId: `${runId}:1`,
      sequence: 1,
    },
    {
      ...base,
      type: "answer_delta",
      stage: "answer",
      token: "hello",
      eventId: `${runId}:2`,
      sequence: 2,
    },
    {
      ...base,
      type: "answer_delta",
      stage: "answer",
      token: " world",
      eventId: `${runId}:3`,
      sequence: 3,
    },
    {
      ...base,
      type: "done",
      stage: "done",
      result: makeTerminalResult("completed", runId),
      eventId: `${runId}:4`,
      sequence: 4,
      status: "completed",
      durationMs: 100,
    },
  ]
}

function stubEventsSource(): AnswerEventsSource {
  return async function* (message, options) {
    const runId = options.runId || FIXED_RUN_ID
    const sessionId = options.sessionId || FIXED_SESSION_ID
    for (const event of makeEvents(runId, sessionId)) yield event
  }
}

function buildApp() {
  const app = express()
  const db = openDb(":memory:")
  const traceRepository = new AnswerTraceRepository(db)
  const conversationHistory = new SqliteConversationHistoryStore(db)
  app.use(express.json())
  app.use("/api", createChatRouter(traceRepository, stubEventsSource(), undefined, undefined, undefined, conversationHistory))
  return { app, db, traceRepository, conversationHistory }
}

async function listen(app: express.Express) {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

test("POST /api/chat with empty message returns 400", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "   ", stream: false }),
    })
    assert.equal(response.status, 400)
    const body = await response.json() as { error: string }
    assert.equal(body.error, "message is required")
  } finally {
    server.close()
    db.close()
  }
})

test("SSE transport encodes every event as `data: <json>\\n\\n` with correct fields", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "hi",
        stream: true,
        runId: FIXED_RUN_ID,
        sessionId: FIXED_SESSION_ID,
      }),
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-type"), "text/event-stream")

    const raw = await response.text()
    const lines = raw.split(/\r?\n/)
    const dataLines = lines.filter((line) => line.startsWith("data: "))
    // Each event is followed by a blank line — `data: ...\n\n`
    assert.ok(dataLines.length === 4, `expected 4 data lines, got ${dataLines.length}`)

    const payloads = dataLines.map((line) =>
      JSON.parse(line.slice(6)) as {
        sessionId: string
        runId: string
        event: { type: string; sequence: number; eventId: string; runId: string }
        token?: string
        done?: boolean
        status?: string
        references?: unknown[]
        degradation?: { status: string; unavailableChannels: string[] }
      }
    )

    // Every payload carries transport envelope fields.
    assert.equal(payloads.every((p) => p.sessionId === FIXED_SESSION_ID), true)
    assert.equal(payloads.every((p) => p.runId === FIXED_RUN_ID), true)
    assert.equal(
      payloads.every((p) => p.event.eventId === `${FIXED_RUN_ID}:${p.event.sequence}`),
      true
    )

    // Progress event: no token, no done.
    const progress = payloads[0]
    assert.equal(progress.event.type, "progress")
    assert.equal("token" in progress, false)
    assert.equal("done" in progress, false)

    // answer_delta events: token present, no done.
    const deltas = payloads.filter((p) => p.event.type === "answer_delta")
    assert.equal(deltas.length, 2)
    assert.equal(deltas[0].token, "hello")
    assert.equal(deltas[1].token, " world")
    assert.equal(deltas.every((p) => !("done" in p)), true)

    // done event: done=true, status/references/degradation present, no token.
    const done = payloads.at(-1)!
    assert.equal(done.event.type, "done")
    assert.equal(done.done, true)
    assert.equal(done.status, "completed")
    assert.deepEqual(done.references, [])
    assert.deepEqual(done.degradation, { status: "none", unavailableChannels: [] })
    assert.equal("token" in done, false)
  } finally {
    server.close()
    db.close()
  }
})

test("JSON transport encodes terminal fields and echoes full event stream", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "hi",
        stream: false,
        runId: FIXED_RUN_ID,
        sessionId: FIXED_SESSION_ID,
      }),
    })
    assert.equal(response.status, 200)
    const body = await response.json() as {
      reply: string
      sessionId: string
      runId: string
      status: string
      references: unknown[]
      degradation: { status: string; unavailableChannels: string[] }
      events: Array<{ type: string; sequence: number; eventId: string }>
    }
    // Terminal fields come from the done event's result.
    assert.equal(body.reply, "hello world")
    assert.equal(body.sessionId, FIXED_SESSION_ID)
    assert.equal(body.runId, FIXED_RUN_ID)
    assert.equal(body.status, "completed")
    assert.deepEqual(body.references, [])
    assert.deepEqual(body.degradation, { status: "none", unavailableChannels: [] })
    // Full event stream is echoed in order.
    assert.equal(body.events.length, 4)
    assert.deepEqual(
      body.events.map((e) => e.type),
      ["progress", "answer_delta", "answer_delta", "done"]
    )
    assert.deepEqual(
      body.events.map((e) => e.sequence),
      [1, 2, 3, 4]
    )
    assert.deepEqual(
      body.events.map((e) => e.eventId),
      [`${FIXED_RUN_ID}:1`, `${FIXED_RUN_ID}:2`, `${FIXED_RUN_ID}:3`, `${FIXED_RUN_ID}:4`]
    )
  } finally {
    server.close()
    db.close()
  }
})

test("GET /api/chat/runs/:runId returns 404 when run not in trace repository", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/chat/runs/nonexistent`)
    assert.equal(response.status, 404)
    const body = await response.json() as { error: string }
    assert.equal(body.error, "Answer run not found")
  } finally {
    server.close()
    db.close()
  }
})

test("GET /api/chat/runs/:runId returns trace when events were persisted directly", async () => {
  const { app, db, traceRepository, conversationHistory } = buildApp()
  const { server, port } = await listen(app)
  try {
    // Transport test: persist events directly (no observer side-effect from runAnswer).
    conversationHistory.ensureDirectory(FIXED_SESSION_ID, "default", "local", "Synthetic question")
    for (const event of makeEvents(FIXED_RUN_ID, FIXED_SESSION_ID)) traceRepository.append(event)

    const historyResponse = await fetch(`http://127.0.0.1:${port}/api/chat/runs/${FIXED_RUN_ID}`)
    assert.equal(historyResponse.status, 200)
    const history = await historyResponse.json() as {
      sessionId: string
      events: Array<{ type: string; sequence: number; eventId: string }>
    }
    assert.equal(history.sessionId, FIXED_SESSION_ID)
    assert.equal(history.events.length, 4)
    assert.deepEqual(
      history.events.map((e) => e.type),
      ["progress", "answer_delta", "answer_delta", "done"]
    )
    assert.deepEqual(
      history.events.map((e) => e.eventId),
      [`${FIXED_RUN_ID}:1`, `${FIXED_RUN_ID}:2`, `${FIXED_RUN_ID}:3`, `${FIXED_RUN_ID}:4`]
    )
  } finally {
    server.close()
    db.close()
  }
})

test("approved answer basis survives real adapter, SSE, JSON, SQLite history and conversation consumption", async () => {
  const db = openDb(":memory:")
  const repository = new AnswerTraceRepository(db)
  const basis = { text: "回答依据所引用的操作手册整理。", referenceIds: ["manual-1"] }
  const source = createMastraChatEventAdapter({
    traceObserver: repository,
    runner: async (input) => ({
      reply: "按手册顺序操作 [cite:manual-1]。",
      status: "completed",
      references: [{
        id: "manual-1", title: "合成操作手册", source: "sample",
        documentId: "sample-manual", documentVersionId: "sample-version", documentVersion: 1,
        chunkId: "sample-chunk", excerpt: "按手册顺序操作。", channels: ["vector"], score: 1, wikilinks: [],
      }],
      degradation: { status: "none", unavailableChannels: [] },
      tokens: ["按手册顺序操作 [cite:manual-1]。"],
      routeTrace: { decision: "simple" },
      retrievalTrace: { resultCount: 1 },
      contextTrace: { evidenceCount: 1, phase: "draft" },
      validationTrace: { round: 1, passed: true, answerBasis: basis },
    }),
  })
  const app = express()
  app.use(express.json())
  app.use("/api", createChatRouter(repository, source, undefined, undefined, undefined, new SqliteConversationHistoryStore(db)))
  const { server, port } = await listen(app)
  const readBasis = (events: AnswerRunEvent[]) => events
    .filter((event) => event.type === "progress" && event.stage === "validation")
    .map((event) => event.type === "progress" && event.stage === "validation"
      ? event.data.answerBasis : undefined)
    .filter(Boolean)
  try {
    for (const stream of [true, false]) {
      const runId = `basis-${stream ? "sse" : "json"}`
      const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "如何操作？", stream, runId, sessionId: runId }),
      })
      assert.equal(response.status, 200)
      const events: AnswerRunEvent[] = stream
        ? (await response.text()).split(/\r?\n/)
            .filter((line) => line.startsWith("data: "))
            .map((line) => JSON.parse(line.slice(6)).event as AnswerRunEvent)
        : ((await response.json()) as { events: AnswerRunEvent[] }).events
      assert.deepEqual(readBasis(events), [basis])
      const historyResponse = await fetch(`http://127.0.0.1:${port}/api/chat/runs/${runId}`)
      const history = await historyResponse.json() as { events: AnswerRunEvent[] }
      assert.equal(historyResponse.status, 200)
      assert.deepEqual(history.events, events)
      const conversation = new ConversationImpl()
      const message = conversation.startAssistantRun(conversation.getActiveThread()!.id, { runId })
      for (const event of events) {
        const traceData: Record<string, unknown> | undefined = event.type === "progress" ? { ...event.data } : undefined
        conversation.processSseEvent(message, {
          event: {
            ...event, durationMs: event.durationMs ?? undefined,
            data: traceData,
            result: event.type === "done" ? { ...event.result, references: event.result.references.map(reference => ({ ...reference })) } : undefined,
          },
          ...(event.type === "answer_delta" ? { token: event.token } : {}),
          done: event.type === "done",
        })
      }
      conversation.finalizeStreamRun(message)
      assert.equal(message.traceStatus, "completed")
      assert.equal(message.content, "按手册顺序操作 [cite:manual-1]。")
      assert.deepEqual(message.references.map(({ id }) => id), ["manual-1"])
      assert.deepEqual(message.traceEvents.find((event) => event.stage === "validation")?.data?.answerBasis, basis)
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
  }
})

const HARD04_ANSWER =
  "标准商品自签收之日起 30 个自然日内可申请退货（演示标准答案，引用虚构政策文档）。"

test("DR-10: a unique exact FAQ hit carries one parseable citation through JSON, SSE, history and memory", async () => {
  const db = openDb(":memory:")
  let generated = 0
  const faq = new FaqEntryServiceImpl({
    repo: new SqliteFaqEntryRepo(db),
    now: () => new Date("2026-10-22T00:00:00.000Z"),
    generateId: () => `faq-hard-04-${++generated}`,
  })
  const entry = faq.create("tenant-a", "kb-1", {
    question: "退货期限是多久？",
    answer: HARD04_ANSWER,
    variants: ["退货多久能退"],
  }, "admin")
  // A second in-scope standard answer for the same normalized question stays
  // ambiguous and must fall through to the normal path.
  faq.create("tenant-a", "kb-2", {
    question: "退货期限是多久？",
    answer: "7 个自然日。",
  }, "admin")
  const memory = new SqliteConversationStore(db)
  let innerCalls = 0
  const inner: MastraRunner = async () => {
    innerCalls += 1
    return {
      reply: "normal-path answer",
      status: "completed",
      references: [],
      degradation: { status: "none", unavailableChannels: [] },
      tokens: ["normal-path answer"],
      routeTrace: {},
      retrievalTrace: {},
      contextTrace: {},
      validationTrace: {},
    }
  }
  const runner = createFaqExactMatchRunner(
    {
      faq,
      conversationStore: memory,
      resolveTenantId: (context) => context.tenantId,
    },
    inner
  )
  const repository = new AnswerTraceRepository(db)
  const source = createMastraChatEventAdapter({
    runner,
    traceObserver: repository,
    // Any provider call would reject the run: a direct FAQ answer is model-free.
    resourceBudget: { limits: { maxModelCalls: 0 } },
  })
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => {
    res.locals.accessContext = {
      tenantId: String(req.headers["x-tenant"] ?? "tenant-a"),
      subjectId: "user-1",
      groups: [],
      scopes: ["chat"],
    }
    next()
  })
  app.use("/api", createChatRouter(repository, source, undefined, (_context, requested) => ({
    knowledgeBaseIds: Array.isArray(requested) ? requested.map(String) : [],
  })))
  const { server, port } = await listen(app)
  const base = `http://127.0.0.1:${port}`
  const sent = async (body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
    assert.equal(response.status, 200)
    return response
  }
  try {
    const answers: Array<{ reply: string; referenceIds: string[] }> = []
    for (const stream of [false, true]) {
      const runId = `dr10-${stream ? "sse" : "json"}`
      const sessionId = `dr10-session-${stream ? "sse" : "json"}`
      const response = await sent({
        message: "退货期限是多久？", stream, runId, sessionId, knowledgeBaseIds: ["kb-1"],
      })
      let events: AnswerRunEvent[]
      let jsonReply: string | undefined
      let jsonReferences: AnswerRunResult["references"] | undefined
      if (stream) {
        events = (await response.text()).split(/\r?\n/)
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)).event as AnswerRunEvent)
      } else {
        const body = await response.json() as {
          reply: string
          references: AnswerRunResult["references"]
          events: AnswerRunEvent[]
        }
        events = body.events
        jsonReply = body.reply
        jsonReferences = body.references
      }
      const done = events.filter((event): event is Extract<AnswerRunEvent, { type: "done" }> =>
        event.type === "done"
      )
      assert.equal(done.length, 1)
      const result = done[0].result
      if (jsonReply !== undefined) {
        assert.equal(jsonReply, result.reply)
        assert.deepEqual(jsonReferences, result.references)
      }
      const streamed = events.filter((event) => event.type === "answer_delta")
        .map((event) => event.type === "answer_delta" ? event.token : "").join("")
      assert.equal(streamed, result.reply)
      assert.equal(result.reply.startsWith(HARD04_ANSWER), true)
      const markers = [...result.reply.matchAll(/\[cite:([^\]]+)\]/g)]
      assert.equal(markers.length, 1)
      assert.deepEqual(result.references.map(({ id }) => id), [markers[0][1]])
      assert.equal(result.references[0].origin, "faq")
      assert.equal(result.references[0].faqEntryId, entry.id)
      assert.equal(result.references[0].faqVersion, 1)
      const history = await fetch(`${base}/api/chat/runs/${runId}`)
      assert.deepEqual((await history.json() as { events: AnswerRunEvent[] }).events, events)
      const turns = memory.loadRecentTurns(sessionId, "tenant-a", 10)
      assert.equal(turns.length, 2)
      assert.equal(turns[1].content, result.reply)
      answers.push({ reply: result.reply, referenceIds: result.references.map(({ id }) => id) })
    }
    assert.deepEqual(answers[0], answers[1])
    assert.equal(innerCalls, 0, "an exact FAQ hit must not run routing, generation or validation")

    // A variant hit keeps the same entry/version citation.
    const variant = await sent({
      message: "退货多久能退", stream: false, runId: "dr10-variant", sessionId: "dr10-variant",
      knowledgeBaseIds: ["kb-1"],
    })
    const variantBody = await variant.json() as {
      reply: string
      references: AnswerRunResult["references"]
    }
    assert.equal(variantBody.reply, answers[0].reply)
    assert.deepEqual(variantBody.references.map(({ id }) => id), answers[0].referenceIds)
    assert.equal(innerCalls, 0)

    // Cross-knowledge ambiguity and cross-tenant scope fall through untouched.
    for (const [headers, knowledgeBaseIds] of [
      [{}, ["kb-1", "kb-2"]],
      [{ "x-tenant": "tenant-b" }, ["kb-1"]],
    ] as Array<[Record<string, string>, string[]]>) {
      const response = await sent({
        message: "退货期限是多久？", stream: false,
        runId: `dr10-fallthrough-${innerCalls}`, sessionId: `dr10-fallthrough-${innerCalls}`,
        knowledgeBaseIds,
      }, headers)
      const body = await response.json() as {
        reply: string
        references: AnswerRunResult["references"]
      }
      assert.equal(body.reply, "normal-path answer")
      assert.deepEqual(body.references, [])
      assert.equal(innerCalls, headers["x-tenant"] ? 2 : 1)
    }
    // The stored standard answer is never decorated or rewritten.
    assert.equal(faq.listActive("tenant-a", ["kb-1"])[0].answer, HARD04_ANSWER)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
  }
})
