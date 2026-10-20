/**
 * The logging system as one contract, tested end to end.
 *
 * Existing suites cover each link (sink, redaction, truncation, backpressure,
 * close). This one asks the question an operator actually asks: for a real
 * request through the full Express stack, is there exactly one complete
 * record, does it correlate, and does it stay quiet about payloads?
 *
 * Adversarial cases here: concurrency, CORS preflight, client abort, a
 * circular/oversized payload, and tracing-off parity.
 */
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import type { Express } from "express"
import { createApp } from "../api/server"
import { openDb } from "../ingestion/tracking/db"
import { LogCounters, type Logger } from "./logger"
import { createPinoLogger } from "./pino_logger"
import { BackpressureSink, type LogDestination } from "./sink"
import { NoopTracingRuntime, type TracingRuntime } from "../tracing/contract"
import type { AnswerEventsSource } from "../api/chat"
import type { AnswerRunEvent } from "../types"

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"

class CaptureDestination extends EventEmitter implements LogDestination {
  readonly lines: string[] = []
  write(chunk: string): boolean {
    this.lines.push(chunk)
    return true
  }
  records(): Array<Record<string, unknown>> {
    return this.lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })
  }
  terminals(): Array<Record<string, unknown>> {
    return this.records().filter((record) => record.event === "http.request.completed")
  }
}

const progressEvent = (runId: string): AnswerRunEvent => ({
  schemaVersion: 1,
  sessionId: "log-session",
  runId,
  createdAt: new Date(0).toISOString(),
  status: "running",
  durationMs: null,
  attempt: 1,
  round: 0,
  inputSummary: "",
  outputSummary: "",
  type: "progress",
  stage: "route",
  message: "routing",
  data: {},
  eventId: `${runId}:0`,
  sequence: 0,
})

const terminalEvent = (runId: string): AnswerRunEvent => ({
  schemaVersion: 1,
  sessionId: "log-session",
  runId,
  createdAt: new Date(0).toISOString(),
  status: "completed",
  durationMs: 1,
  attempt: 1,
  round: 0,
  inputSummary: "",
  outputSummary: "",
  type: "done",
  stage: "done",
  eventId: `${runId}:1`,
  sequence: 1,
  result: {
    runId,
    status: "completed",
    reply: "ok",
    references: [],
    degradation: { status: "none", unavailableChannels: [] },
  },
})

interface Harness {
  app: Express
  destination: CaptureDestination
  counts: LogCounters
  logger: Logger
  close(): void
}

function buildHarness(options: {
  eventsSource?: AnswerEventsSource
  tracing?: TracingRuntime
} = {}): Harness {
  const db = openDb(":memory:")
  const destination = new CaptureDestination()
  const counts = new LogCounters()
  const sink = new BackpressureSink(destination, counts)
  const logger = createPinoLogger({ level: "info", sink, counters: counts, bindings: { service: "log-acceptance" } })
  const app = createApp({
    db,
    logger,
    tracing: options.tracing ?? new NoopTracingRuntime(),
    eventsSource:
      options.eventsSource ??
      (async function* (_message, runOptions) {
        yield terminalEvent(runOptions.runId ?? "run-default")
      }),
  })
  return {
    app,
    destination,
    counts,
    logger,
    close: () => db.close(),
  }
}

async function listen(app: Express) {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

function createKnowledgeBase(port: number, name: string) {
  return fetch(`http://127.0.0.1:${port}/api/knowledge-bases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  })
}

const quiet = () => new Promise((resolve) => setTimeout(resolve, 80))

test("a real request produces exactly one complete terminal record", async () => {
  const harness = buildHarness()
  const { server, port } = await listen(harness.app)
  try {
    const response = await createKnowledgeBase(port, "log-contract")
    assert.equal(response.status, 201)
    const requestId = response.headers.get("x-request-id")
    assert.match(String(requestId), /^[0-9a-f-]{36}$/)
    await harness.logger.flush()

    const terminals = harness.destination.terminals()
    assert.equal(terminals.length, 1, "one terminal per request, not one per middleware")
    const record = terminals[0]
    assert.equal(record.requestId, requestId, "the record and the client share one id")
    assert.equal(record.method, "POST")
    assert.equal(record.path, "/api/knowledge-bases")
    assert.equal(record.statusCode, 201)
    assert.equal(record.outcome, "success")
    assert.equal(record.terminalReason, "finish")
    assert.equal(record.operation, "knowledge_base.manage")
    assert.equal(typeof record.durationMs, "number")
    assert.equal(typeof record.time, "string", "ISO timestamp, parseable by every log shipper")
    assert.equal(Number.isNaN(Date.parse(String(record.time))), false)
    assert.equal(record.level, "info")
  } finally {
    server.close()
    harness.close()
  }
})

test("concurrent requests never share a correlation id", async () => {
  const harness = buildHarness()
  const { server, port } = await listen(harness.app)
  try {
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) => createKnowledgeBase(port, `concurrent-${index}`)),
    )
    const headerIds = responses.map((response) => response.headers.get("x-request-id"))
    assert.equal(new Set(headerIds).size, 8, "each response carries its own id")
    await harness.logger.flush()

    const terminals = harness.destination.terminals()
    assert.equal(terminals.length, 8)
    const recordIds = terminals.map((record) => record.requestId)
    assert.equal(new Set(recordIds).size, 8, "no record reuses another request's id")
    assert.deepEqual(new Set(recordIds), new Set(headerIds), "every id is accounted for exactly once")
  } finally {
    server.close()
    harness.close()
  }
})

test("credentials and payloads never reach a log line", async () => {
  const harness = buildHarness()
  const { server, port } = await listen(harness.app)
  const secrets = ["Bearer sk-live-abcdef123456", "password: hunter2", "cookie-secret-value"]
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: secrets[0],
        Cookie: `session=${secrets[2]}`,
      },
      body: JSON.stringify({ message: `my api_key: ${secrets[1]}`, stream: false }),
    })
    assert.ok(response.status < 500)
    await harness.logger.flush()

    const joined = harness.destination.lines.join("\n")
    for (const secret of secrets) {
      assert.equal(joined.includes(secret), false, `log leaked ${secret.slice(0, 12)}…`)
    }
    assert.equal(joined.includes("hunter2"), false)
    const terminal = harness.destination.terminals()[0]
    assert.ok(terminal, "the request is still recorded")
  } finally {
    server.close()
    harness.close()
  }
})

test("a circular oversized payload is capped, parseable and still correlated", async () => {
  const harness = buildHarness()
  try {
    const circular: Record<string, unknown> = { name: "loop" }
    circular.self = circular
    await harness.logger.info("probe.record", {
      nested: circular,
      huge: "x".repeat(20_000),
      requestId: "probe-request",
    })
    await harness.logger.flush()

    const lines = harness.destination.lines
    assert.equal(lines.length, 1)
    assert.ok(Buffer.byteLength(lines[0], "utf8") <= 8 * 1024 + 128, "record stays within the 8 KiB ceiling")
    const record = JSON.parse(lines[0]) as Record<string, unknown>
    assert.equal(record.event, "probe.record")
    assert.equal(record.requestId, "probe-request")
    assert.ok(harness.counts.truncated >= 1, "the truncation is counted, not silent")
  } finally {
    harness.close()
  }
})

test("a CORS preflight is transport, not a logged business request", async () => {
  const harness = buildHarness()
  const { server, port } = await listen(harness.app)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    })
    assert.equal(response.status, 204)
    assert.equal(response.headers.get("x-request-id"), null, "preflight never enters the lifecycle")
    await quiet()
    assert.equal(harness.destination.terminals().length, 0, "no terminal record for a preflight")
  } finally {
    server.close()
    harness.close()
  }
})

test("an abandoned SSE stream logs exactly one client_closed terminal", async () => {
  const source: AnswerEventsSource = async function* (_message, runOptions) {
    yield progressEvent(runOptions.runId ?? "run-abort")
    await new Promise<void>((resolve) => {
      runOptions.signal?.addEventListener("abort", () => resolve(), { once: true })
    })
    yield terminalEvent(runOptions.runId ?? "run-abort")
  }
  const harness = buildHarness({ eventsSource: source })
  const { server, port } = await listen(harness.app)
  const controller = new AbortController()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "stream", stream: true, sessionId: "log-abort" }),
      signal: controller.signal,
    })
    const reader = response.body?.getReader()
    assert.ok(reader)
    await reader.read()
    controller.abort()
    await reader.read().catch(() => undefined)
    await quiet()
    await harness.logger.flush()

    const terminals = harness.destination.terminals()
    assert.equal(terminals.length, 1, "a client hang-up must not also log success")
    assert.equal(terminals[0].outcome, "client_closed")
    assert.equal(terminals[0].terminalReason, "close")
  } finally {
    server.close()
    harness.close()
  }
})

test("tracing off keeps the record complete and simply omits trace ids", async () => {
  const harness = buildHarness({ tracing: new NoopTracingRuntime() })
  const { server, port } = await listen(harness.app)
  try {
    const response = await createKnowledgeBase(port, "tracing-off")
    assert.equal(response.status, 201)
    assert.equal(response.headers.get("x-trace-id"), null)
    await harness.logger.flush()

    const terminal = harness.destination.terminals()[0]
    assert.ok(terminal)
    assert.match(String(terminal.requestId), /^[0-9a-f-]{36}$/)
    assert.equal(terminal.operation, "knowledge_base.manage")
    assert.equal("traceId" in terminal, false, "no empty trace id is invented")
    assert.equal("spanId" in terminal, false)
  } finally {
    server.close()
    harness.close()
  }
})
