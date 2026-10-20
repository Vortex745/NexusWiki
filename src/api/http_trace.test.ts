import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import { ExportResultCode } from "@opentelemetry/core"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"
import type { Express } from "express"
import { createApp } from "./server"
import { openDb } from "../ingestion/tracking/db"
import { LogCounters, SilentLogger } from "../logging/logger"
import { createPinoLogger } from "../logging/pino_logger"
import { BackpressureSink, type LogDestination } from "../logging/sink"
import { createTracingRuntime } from "../tracing/composition"
import { NoopTracingRuntime } from "../tracing/contract"
import type { AnswerEventsSource } from "./chat"
import type { AnswerRunEvent } from "../types"

/**
 * LO-06: HTTP root spans by whitelist.
 *
 * Real Express stack, real chat transport, isolated SQLite, fake exporter.
 * Assertions cover: one root per whitelisted request, exclusion of reads,
 * request_id/trace_id/span_id independence and correlation, sampling
 * inheritance, exactly one scope end for success/abort/timeout, no trust in
 * inbound traceparent, and unchanged product behaviour when tracing is off or
 * broken.
 */

class FakeExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = []
  mode: "ok" | "fail" = "ok"

  export(spans: readonly ReadableSpan[], callback: (result: { code: ExportResultCode; error?: Error }) => void): void {
    if (this.mode === "fail") {
      callback({ code: ExportResultCode.FAILED, error: new Error("down") })
      return
    }
    this.spans.push(...spans)
    callback({ code: ExportResultCode.SUCCESS })
  }

  async shutdown(): Promise<void> {
    // nothing to release
  }
}

class CaptureDestination implements LogDestination {
  readonly lines: string[] = []
  write(chunk: string): boolean {
    this.lines.push(chunk)
    return true
  }
  terminals(): Array<Record<string, unknown>> {
    return this.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.event === "http.request.completed")
  }
}

const ENABLED_ENV = {
  TRACING_ENABLED: "1",
  LANGFUSE_SAMPLE_RATE: "1",
  LANGFUSE_BASE_URL: "http://localhost:3000",
  LANGFUSE_PUBLIC_KEY: "pk-lf-test",
  LANGFUSE_SECRET_KEY: "sk-lf-test",
}

const emptyEventsSource: AnswerEventsSource = async function* () {
  yield terminalEvent("run-unused")
}

function terminalEvent(runId: string): AnswerRunEvent {
  return {
    schemaVersion: 1,
    sessionId: "sess-http",
    runId,
    createdAt: "2026-10-20T00:00:00.000Z",
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
  }
}

function progressEvent(runId: string): AnswerRunEvent {
  return {
    schemaVersion: 1,
    sessionId: "sess-http",
    runId,
    createdAt: "2026-10-20T00:00:00.000Z",
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
  }
}

async function listen(app: Express) {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

function buildLogger() {
  const destination = new CaptureDestination()
  const counters = new LogCounters()
  const sink = new BackpressureSink(destination, counters)
  const logger = createPinoLogger({ level: "info", sink, counters, bindings: { service: "kefu-rag" } })
  return { logger, destination }
}

function createKnowledgeBase(port: number, name = "trace-target") {
  return fetch(`http://127.0.0.1:${port}/api/knowledge-bases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  })
}

function spansByName(exporter: FakeExporter, name: string): ReadableSpan[] {
  return exporter.spans.filter((span) => span.name === name)
}

test("LO-06-AC01/AC03: a whitelisted request opens one root span and a child that shares its trace", async () => {
  const db = openDb(":memory:")
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  const { logger, destination } = buildLogger()
  const app = createApp({ db, logger, tracing: runtime, eventsSource: emptyEventsSource })
  const { server, port } = await listen(app)
  try {
    const response = await createKnowledgeBase(port)
    assert.equal(response.status, 201)
    const requestId = response.headers.get("x-request-id")
    const traceId = response.headers.get("x-trace-id")
    assert.match(String(requestId), /^[0-9a-f-]{36}$/)
    assert.match(String(traceId), /^[0-9a-f]{32}$/)

    await runtime.flush(1_000)
    const roots = spansByName(exporter, "http.post")
    assert.equal(roots.length, 1, "exactly one HTTP root per request")
    const root = roots[0]
    assert.equal(root.spanContext().traceId, traceId)
    assert.equal(root.parentSpanContext, undefined, "the root has no remote parent")
    const attributes = root.attributes as Record<string, unknown>
    assert.equal(attributes["http.request.method"], "POST")
    assert.equal(attributes["http.route"], "/api/knowledge-bases")
    assert.equal(attributes["http.request_id"], requestId)
    assert.equal(attributes["http.status_code"], 201)
    assert.equal(attributes["http.outcome"], "success")

    const children = spansByName(exporter, "knowledge_base.create")
    assert.equal(children.length, 1)
    assert.equal(children[0].spanContext().traceId, traceId, "business step stays in the request trace")
    assert.equal(children[0].parentSpanContext?.spanId, root.spanContext().spanId)

    const terminal = destination.terminals()[0]
    assert.equal(terminal.requestId, requestId)
    assert.equal(terminal.traceId, traceId)
    assert.equal(terminal.spanId, root.spanContext().spanId, "log and trace correlate through neutral ids")
    assert.notEqual(terminal.spanId, terminal.traceId)
    await runtime.shutdown(500)
  } finally {
    server.close()
    db.close()
  }
})

test("LO-06-AC02: reads, polling and static assets never open an HTTP root", async () => {
  const db = openDb(":memory:")
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  const app = createApp({ db, logger: new SilentLogger(), tracing: runtime, eventsSource: emptyEventsSource })
  const { server, port } = await listen(app)
  try {
    const list = await fetch(`http://127.0.0.1:${port}/api/knowledge-bases`)
    assert.equal(list.status, 200)
    assert.equal(list.headers.get("x-trace-id"), null)
    const asset = await fetch(`http://127.0.0.1:${port}/api/assets/missing.png`)
    assert.ok(asset.status >= 400)
    assert.equal(asset.headers.get("x-trace-id"), null)

    await runtime.flush(500)
    assert.equal(exporter.spans.length, 0, "excluded surfaces produce no spans")
    await runtime.shutdown(500)
  } finally {
    server.close()
    db.close()
  }
})

test("LO-06-AC04/AC06: concurrent requests keep their own trace and sampling context", async () => {
  const db = openDb(":memory:")
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  const app = createApp({ db, logger: new SilentLogger(), tracing: runtime, eventsSource: emptyEventsSource })
  const { server, port } = await listen(app)
  try {
    const responses = await Promise.all([
      createKnowledgeBase(port, "concurrent-a"),
      createKnowledgeBase(port, "concurrent-b"),
      createKnowledgeBase(port, "concurrent-c"),
    ])
    const traceIds = responses.map((response) => response.headers.get("x-trace-id"))
    assert.equal(new Set(traceIds).size, 3, "each request owns its trace id")
    await runtime.flush(1_000)

    const roots = spansByName(exporter, "http.post")
    const children = spansByName(exporter, "knowledge_base.create")
    assert.equal(roots.length, 3)
    assert.equal(children.length, 3)
    for (const root of roots) {
      const traceId = root.spanContext().traceId
      const own = children.filter((child) => child.spanContext().traceId === traceId)
      assert.equal(own.length, 1, "each trace has exactly one business child")
      assert.equal(own[0].parentSpanContext?.spanId, root.spanContext().spanId)
    }
    await runtime.shutdown(500)
  } finally {
    server.close()
    db.close()
  }
})

test("LO-06-AC08: an inbound traceparent is never trusted", async () => {
  const db = openDb(":memory:")
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  const app = createApp({ db, logger: new SilentLogger(), tracing: runtime, eventsSource: emptyEventsSource })
  const { server, port } = await listen(app)
  const forgedTraceId = "11111111111111111111111111111111"
  const forgedSpanId = "2222222222222222"
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/knowledge-bases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        traceparent: `00-${forgedTraceId}-${forgedSpanId}-01`,
        tracestate: "vendor=evil",
      },
      body: JSON.stringify({ name: "forged-correlation" }),
    })
    assert.equal(response.status, 201)
    assert.notEqual(response.headers.get("x-trace-id"), forgedTraceId)
    await runtime.flush(1_000)

    const root = spansByName(exporter, "http.post")[0]
    assert.notEqual(root.spanContext().traceId, forgedTraceId)
    assert.equal(root.parentSpanContext, undefined, "no remote parent is adopted")
    assert.equal(root.spanContext().traceFlags & 0x1, 1)
    await runtime.shutdown(500)
  } finally {
    server.close()
    db.close()
  }
})

test("LO-06-AC07: an abandoned SSE stream ends its scope exactly once as client_closed", async () => {
  const db = openDb(":memory:")
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  const source: AnswerEventsSource = async function* (_message, options) {
    yield progressEvent(options.runId ?? "run-sse")
    await new Promise<void>((resolve) => {
      options.signal?.addEventListener("abort", () => resolve(), { once: true })
    })
    yield terminalEvent(options.runId ?? "run-sse")
  }
  const app = createApp({ db, logger: new SilentLogger(), tracing: runtime, eventsSource: source })
  const { server, port } = await listen(app)
  const controller = new AbortController()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi", stream: true, sessionId: "sess-trace-abort" }),
      signal: controller.signal,
    })
    assert.equal(response.status, 200)
    const reader = response.body?.getReader()
    assert.ok(reader)
    await reader.read()
    controller.abort()
    await reader.read().catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 120))
    await runtime.flush(1_000)

    const roots = spansByName(exporter, "http.post")
    assert.equal(roots.length, 1, "one scope for the whole SSE request")
    const attributes = roots[0].attributes as Record<string, unknown>
    assert.equal(attributes["http.outcome"], "client_closed")
    assert.equal(roots[0].status.code, 1, "OK, not ERROR: a client hang-up is not a server failure")
    await runtime.shutdown(500)
  } finally {
    server.close()
    db.close()
  }
})

test("LO-06-AC07: an idle request ends once with timeout and an error status", async () => {
  const db = openDb(":memory:")
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  const hanging: AnswerEventsSource = async function* () {
    await new Promise<void>(() => {
      // never resolves: only the request deadline can end it
    })
    yield terminalEvent("run-hang")
  }
  const app = createApp({
    db,
    logger: new SilentLogger(),
    tracing: runtime,
    eventsSource: hanging,
    httpLog: { idleTimeoutMs: 80 },
  })
  const { server, port } = await listen(app)
  try {
    await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hang", stream: true, sessionId: "sess-trace-timeout" }),
    }).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 150))
    await runtime.flush(1_000)

    const roots = spansByName(exporter, "http.post")
    assert.equal(roots.length, 1)
    const attributes = roots[0].attributes as Record<string, unknown>
    assert.equal(attributes["http.outcome"], "timeout")
    assert.equal(roots[0].status.code, 2, "timeout is a server-side error")
    await runtime.shutdown(500)
  } finally {
    server.close()
    db.close()
  }
})

test("LO-09-AC01/AC02: a real chat run emits stage and tool spans under its request root", async () => {
  const db = openDb(":memory:")
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  const source: AnswerEventsSource = async function* (_message, options) {
    const runId = options.runId ?? "run-l09"
    yield progressEvent(runId)
    yield {
      ...progressEvent(runId),
      stage: "retrieval",
      message: "retrieving",
      data: { complexLoop: true, iteration: 1, selectedTool: "semantic_lexical_hybrid", resultCount: 2 },
      eventId: `${runId}:2`,
      sequence: 2,
    } as AnswerRunEvent
    const terminal = terminalEvent(runId) as Extract<AnswerRunEvent, { type: "done" }>
    yield {
      ...terminal,
      result: { ...terminal.result, status: "insufficient_evidence" },
    } as AnswerRunEvent
  }
  const app = createApp({ db, logger: new SilentLogger(), tracing: runtime, eventsSource: source })
  const { server, port } = await listen(app)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi", stream: true, sessionId: "sess-l09" }),
    })
    assert.equal(response.status, 200)
    assert.ok((await response.text()).includes("event"))
    await new Promise((resolve) => setTimeout(resolve, 60))
    await runtime.flush(1_000)

    const root = spansByName(exporter, "http.post")[0]
    assert.ok(root)
    const route = spansByName(exporter, "stage.route")
    const retrieval = spansByName(exporter, "stage.retrieval")
    const tool = spansByName(exporter, "tool.semantic_lexical_hybrid")
    assert.equal(route.length, 1, "one real route stage")
    assert.equal(retrieval.length, 1, "one real retrieval stage")
    assert.equal(tool.length, 1, "one real tool call")
    for (const span of [...route, ...retrieval, ...tool]) {
      assert.equal(span.spanContext().traceId, root.spanContext().traceId)
    }
    assert.equal(retrieval[0].parentSpanContext?.spanId, root.spanContext().spanId)
    assert.equal(tool[0].parentSpanContext?.spanId, retrieval[0].spanContext().spanId)
    assert.equal((tool[0].attributes as Record<string, unknown>)["tool.result_count"], 2)
    assert.equal(root.status.code, 1, "a business refusal is not a tracing error")
    await runtime.shutdown(500)
  } finally {
    server.close()
    db.close()
  }
})

test("LO-09-AC05/AC06: tracing off leaves the SSE payload identical", async () => {
  const tracedDb = openDb(":memory:")
  const plainDb = openDb(":memory:")
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  const tracedApp = createApp({ db: tracedDb, logger: new SilentLogger(), tracing: runtime, eventsSource: emptyEventsSource })
  const plainApp = createApp({ db: plainDb, logger: new SilentLogger(), tracing: new NoopTracingRuntime(), eventsSource: emptyEventsSource })
  const traced = await listen(tracedApp)
  const plain = await listen(plainApp)
  const body = JSON.stringify({ message: "same", stream: false, sessionId: "sess-l09-parity" })
  try {
    const [withTrace, without] = await Promise.all([
      fetch(`http://127.0.0.1:${traced.port}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }),
      fetch(`http://127.0.0.1:${plain.port}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }),
    ])
    const tracedBody = (await withTrace.json()) as Record<string, unknown>
    const plainBody = (await without.json()) as Record<string, unknown>
    assert.deepEqual(Object.keys(tracedBody).sort(), Object.keys(plainBody).sort())
    assert.equal(tracedBody.reply, plainBody.reply)
    await runtime.shutdown(500)
  } finally {
    traced.server.close()
    plain.server.close()
    tracedDb.close()
    plainDb.close()
  }
})

test("LO-06-AC09: tracing off or a broken exporter leaves SSE/JSON and SQLite untouched", async () => {
  const silentDb = openDb(":memory:")
  const failedDb = openDb(":memory:")
  const exporter = new FakeExporter()
  exporter.mode = "fail"
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  const silentApp = createApp({ db: silentDb, logger: new SilentLogger(), tracing: new NoopTracingRuntime(), eventsSource: emptyEventsSource })
  const failedApp = createApp({ db: failedDb, logger: new SilentLogger(), tracing: runtime, eventsSource: emptyEventsSource })
  const silent = await listen(silentApp)
  const failed = await listen(failedApp)
  try {
    const silentResponse = await createKnowledgeBase(silent.port, "parity-off")
    const failedResponse = await createKnowledgeBase(failed.port, "parity-broken")
    assert.equal(silentResponse.status, 201)
    assert.equal(failedResponse.status, 201)
    assert.equal(silentResponse.headers.get("x-trace-id"), null)
    assert.match(String(failedResponse.headers.get("x-trace-id")), /^[0-9a-f]{32}$/)

    const silentBody = (await silentResponse.json()) as { knowledgeBase: Record<string, unknown> }
    const failedBody = (await failedResponse.json()) as { knowledgeBase: Record<string, unknown> }
    assert.deepEqual(Object.keys(silentBody.knowledgeBase).sort(), Object.keys(failedBody.knowledgeBase).sort())

    const silentRows = silentDb.prepare("SELECT COUNT(*) AS count FROM knowledge_bases").get() as { count: number }
    const failedRows = failedDb.prepare("SELECT COUNT(*) AS count FROM knowledge_bases").get() as { count: number }
    assert.equal(silentRows.count, failedRows.count, "SQLite contract unchanged")

    await runtime.flush(500)
    assert.ok(runtime.diagnostics().exportErrors >= 1, "failure stays local and visible")
    await runtime.shutdown(500)
  } finally {
    silent.server.close()
    failed.server.close()
    silentDb.close()
    failedDb.close()
  }
})
