import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import { AnswerTraceRepository } from "../answer/trace_repository"
import type { AnswerReference, AnswerRunEvent } from "../types"
import { openDb } from "../ingestion/tracking/db"
import { createApp } from "./server"
import type { AnswerEventsSource } from "./chat"

const reference: AnswerReference = {
  id: "ref-1",
  documentId: "doc-json",
  documentVersionId: "doc-json",
  documentVersion: 2,
  chunkId: "chunk-json",
  title: "退款政策",
  source: "policy.pdf",
  page: 4,
  sectionPath: ["售后", "退款"],
  image: {
    assetId: `sha256:${"a".repeat(64)}`,
    assetPath: `${"a".repeat(64)}.jpg`,
    sourceReference: "images/refund.jpg",
    captions: ["退款流程图"],
  },
  excerpt: "退款申请应在三十日内提交。",
  channels: ["bm25"],
  score: 0.9,
  wikilinks: [],
}

function events(runId: string, sessionId: string): AnswerRunEvent[] {
  const base = {
    schemaVersion: 1 as const,
    sessionId,
    runId,
    createdAt: "2026-07-20T00:00:00.000Z",
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
      eventId: `${runId}:1`,
      sequence: 1,
      message: "",
      data: {},
    },
    {
      ...base,
      type: "answer_delta",
      stage: "answer",
      eventId: `${runId}:2`,
      sequence: 2,
      token: "三十日内",
    },
    {
      ...base,
      type: "done",
      stage: "done",
      eventId: `${runId}:3`,
      sequence: 3,
      status: "completed",
      durationMs: 5,
      result: {
        runId,
        status: "completed",
        reply: "三十日内",
        references: [reference],
        degradation: { status: "none", unavailableChannels: [] },
      },
    },
  ]
}

test("complete chat JSON and SSE preserve the Answer event contract", async (t) => {
  const db = openDb(":memory:")
  const traceRepository = new AnswerTraceRepository(db)
  const eventsSource: AnswerEventsSource = async function* (_message, options) {
    const runId = options.runId || "run"
    const sessionId = options.sessionId || "session"
    for (const event of events(runId, sessionId)) {
      traceRepository.onEvent(event)
      yield event
    }
  }
  const server = createApp({ db, eventsSource }).listen(0)
  t.after(() => server.close())
  t.after(() => db.close())
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const { port } = server.address() as AddressInfo

  const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "退款期限？", stream: false }),
  })
  const body = await response.json() as Record<string, unknown>
  assert.equal(response.status, 200)
  assert.equal(body.reply, "三十日内")
  assert.equal(body.status, "completed")
  assert.deepEqual(body.references, [reference])

  const streamResponse = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "退款期限？", stream: true }),
  })
  const payloads = (await streamResponse.text())
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as {
      token?: string
      sessionId: string
      done?: boolean
      event: { type: string; runId: string; eventId: string; sequence: number }
    })
  assert.equal(payloads.some(({ token }) => token === "三十日内"), true)
  assert.equal(payloads.at(-1)?.done, true)
  assert.equal("token" in payloads.at(-1)!, false)

  const runId = payloads[0].event.runId
  const historyResponse = await fetch(`http://127.0.0.1:${port}/api/chat/runs/${runId}`)
  const history = await historyResponse.json() as {
    events: Array<{ eventId: string; sequence: number }>
  }
  assert.equal(historyResponse.status, 200)
  assert.deepEqual(
    history.events.map(({ eventId }) => eventId),
    payloads.map(({ event }) => event.eventId)
  )
})

// ---------------------------------------------------------------------------
// Reasoning effort: capability GET, one-shot POST validation before any side
// effect, and consistent JSON / SSE / trace records.
// ---------------------------------------------------------------------------

const SUPPORTED_CAPABILITY = Object.freeze({
  supported: true,
  levels: Object.freeze(["low", "high", "max"] as const),
  defaultEffort: "max" as const,
  model: "glm-5.3-flash",
})

function reasoningEvents(
  runId: string,
  sessionId: string,
  effort?: "low" | "high" | "max"
): AnswerRunEvent[] {
  const baseEvents = events(runId, sessionId)
  const done = baseEvents.find((event) => event.type === "done")
  if (!done || done.type !== "done") throw new Error("fixture missing done")
  const result = {
    ...done.result,
    ...(effort ? { requestedReasoningEffort: effort } : {}),
  }
  return baseEvents.map((event) =>
    event.type === "done" ? ({ ...event, result } as AnswerRunEvent) : event
  )
}

interface ChatHarness {
  base: string
  calls: {
    eventsSource: Array<{ message: string; effort?: string }>
    binder: number
    ensureDirectory: number
    lockSession: number
    truncate: number
  }
  close: () => Promise<void>
}

async function startChatHarness(options: {
  capability?: typeof SUPPORTED_CAPABILITY
  effortEcho?: "low" | "high" | "max" | "fromRequest"
} = {}): Promise<ChatHarness> {
  const db = openDb(":memory:")
  const traceRepository = new AnswerTraceRepository(db)
  const calls: ChatHarness["calls"] = {
    eventsSource: [],
    binder: 0,
    ensureDirectory: 0,
    lockSession: 0,
    truncate: 0,
  }
  const eventsSource: AnswerEventsSource = async function* (message, runOptions) {
    calls.eventsSource.push({
      message,
      ...(runOptions.reasoningEffort ? { effort: runOptions.reasoningEffort } : {}),
    })
    const runId = runOptions.runId || "run"
    const sessionId = runOptions.sessionId || "session"
    const effort = options.effortEcho === "fromRequest"
      ? runOptions.reasoningEffort
      : options.effortEcho
    for (const event of reasoningEvents(runId, sessionId, effort)) {
      traceRepository.onEvent(event)
      yield event
    }
  }
  const sessionBinder = {
    bindOrCheck: () => {
      calls.binder += 1
      return { ok: true as const }
    },
  }
  const conversationHistory = {
    ensureDirectory: () => {
      calls.ensureDirectory += 1
    },
    lockSession: () => {
      calls.lockSession += 1
      return { assistantId: null, assistantVersion: null, knowledgeBaseIds: [] }
    },
    truncateFromRun: () => {
      calls.truncate += 1
    },
    recordUnvalidatedRun: () => {},
  }
  const server = createApp({
    db,
    eventsSource,
    sessionBinder: sessionBinder as never,
    conversationHistory: conversationHistory as never,
    ...(options.capability ? { reasoningCapability: options.capability } : {}),
  }).listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      db.close()
    },
  }
}

function postChat(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

test("GET /api/chat/reasoning publishes the injected frozen capability with no store caching", async (t) => {
  const harness = await startChatHarness({ capability: SUPPORTED_CAPABILITY })
  t.after(() => harness.close())
  const response = await fetch(`${harness.base}/api/chat/reasoning`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("cache-control"), "no-store")
  assert.deepEqual(await response.json(), {
    supported: true,
    levels: ["low", "high", "max"],
    defaultEffort: "max",
    model: "glm-5.3-flash",
  })
  assert.equal(harness.calls.eventsSource.length, 0, "the capability read never starts a run")
})

test("GET /api/chat/reasoning reports unsupported on a bare router", async (t) => {
  const harness = await startChatHarness()
  t.after(() => harness.close())
  const response = await fetch(`${harness.base}/api/chat/reasoning`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    supported: false,
    levels: [],
    defaultEffort: null,
    model: null,
  })
})

test("every invalid reasoning effort is a 400 with zero side effects", async (t) => {
  const harness = await startChatHarness({ capability: SUPPORTED_CAPABILITY })
  t.after(() => harness.close())
  for (const value of [null, true, 1, [], {}, "", " ", "LOW", "Medium", "medium", "none", "urgent"]) {
    const response = await postChat(harness.base, { message: "你好", reasoningEffort: value })
    assert.equal(response.status, 400, `value ${JSON.stringify(value)} must be refused`)
    const body = await response.json() as { error?: string }
    assert.equal(body.error, "reasoningEffort must be one of: low, high, max")
  }
  assert.equal(harness.calls.binder, 0)
  assert.equal(harness.calls.ensureDirectory, 0)
  assert.equal(harness.calls.lockSession, 0)
  assert.equal(harness.calls.truncate, 0)
  assert.equal(harness.calls.eventsSource.length, 0)

  // A rejected request must not wedge the transport: the next valid one works.
  const valid = await postChat(harness.base, { message: "你好", stream: false })
  assert.equal(valid.status, 200)
  assert.equal(harness.calls.eventsSource.length, 1)
})

test("a valid enum on an unsupported endpoint is refused before any side effect", async (t) => {
  const harness = await startChatHarness()
  t.after(() => harness.close())
  const response = await postChat(harness.base, { message: "你好", reasoningEffort: "low" })
  assert.equal(response.status, 400)
  assert.equal(
    (await response.json() as { error?: string }).error,
    "reasoningEffort is not supported by the running model"
  )
  assert.equal(harness.calls.binder, 0)
  assert.equal(harness.calls.eventsSource.length, 0)
  // The same old request without the field still works on that bare router.
  const legacy = await postChat(harness.base, { message: "你好", stream: false })
  assert.equal(legacy.status, 200)
})

test("JSON, SSE and the persisted trace agree on the requested effort", async (t) => {
  const harness = await startChatHarness({
    capability: SUPPORTED_CAPABILITY,
    effortEcho: "fromRequest",
  })
  t.after(() => harness.close())

  const json = await postChat(harness.base, {
    message: "退款期限？", stream: false, reasoningEffort: "low",
  })
  assert.equal(json.status, 200)
  const jsonBody = await json.json() as Record<string, unknown>
  assert.equal(jsonBody.requestedReasoningEffort, "low")
  assert.equal(harness.calls.eventsSource[0].effort, "low")

  const sse = await postChat(harness.base, {
    message: "退款期限？", stream: true, reasoningEffort: "high",
  })
  assert.equal(sse.status, 200)
  const payloads = (await sse.text())
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as {
      done?: boolean
      requestedReasoningEffort?: string
      event: { type: string; runId: string; result?: { requestedReasoningEffort?: string } }
    })
  const terminal = payloads.at(-1)!
  assert.equal(terminal.done, true)
  assert.equal(terminal.requestedReasoningEffort, "high")
  assert.equal(terminal.event.result?.requestedReasoningEffort, "high")
  assert.equal(harness.calls.eventsSource[1].effort, "high")

  const runId = terminal.event.runId
  const trace = await fetch(`${harness.base}/api/chat/runs/${runId}`)
  assert.equal(trace.status, 200)
  const history = await trace.json() as {
    events: Array<{ type: string; result?: { requestedReasoningEffort?: string } }>
  }
  const traceDone = history.events.find((event) => event.type === "done")
  assert.equal(traceDone?.result?.requestedReasoningEffort, "high")
})

test("an omitted request keeps the field out of JSON, SSE and the trace", async (t) => {
  const harness = await startChatHarness({ capability: SUPPORTED_CAPABILITY })
  t.after(() => harness.close())

  const json = await postChat(harness.base, { message: "你好", stream: false })
  const jsonBody = await json.json() as Record<string, unknown>
  assert.equal("requestedReasoningEffort" in jsonBody, false)

  const sse = await postChat(harness.base, { message: "你好", stream: true })
  const payloads = (await sse.text())
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as { done?: boolean })
  const terminal = payloads.at(-1)!
  assert.equal(terminal.done, true)
  assert.equal("requestedReasoningEffort" in terminal, false)
  assert.equal(harness.calls.eventsSource.every((call) => call.effort === undefined), true)
})
