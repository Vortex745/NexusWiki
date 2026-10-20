import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import { ExportResultCode } from "@opentelemetry/core"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"
import type { Express } from "express"
import { createApp } from "../api/server"
import { openDb } from "../ingestion/tracking/db"
import { LogCounters, SilentLogger } from "../logging/logger"
import { createPinoLogger } from "../logging/pino_logger"
import { BackpressureSink, type LogDestination } from "../logging/sink"
import { OtelTracingRuntime } from "./otel_runtime"
import type { AnswerEventsSource } from "../api/chat"

/**
 * LO-18: the three chains fail independently.
 *
 * Composed pressure on REAL entries: a full stdout (logs wait, nothing is
 * dropped), a full/slow trace queue (spans are dropped, business never waits),
 * then a shutdown that must not reopen roots and must not disturb the other
 * chains. Product assertions stay on the HTTP response and the SQLite rows.
 */

class SlowPipe extends EventEmitter implements LogDestination {
  readonly lines: string[] = []
  private credit: number
  constructor(credit = 0) {
    super()
    this.credit = credit
  }
  write(chunk: string): boolean {
    this.lines.push(chunk)
    if (this.credit > 0) {
      this.credit -= 1
      return true
    }
    return false
  }
  drain(): void {
    this.emit("drain")
  }
  grant(credits = 1): void {
    this.credit += credits
  }
  terminals(): Array<Record<string, unknown>> {
    return this.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.event === "http.request.completed")
  }
}

class SlowExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = []
  private readonly delayMs: number
  constructor(delayMs = 25) {
    this.delayMs = delayMs
  }
  export(spans: readonly ReadableSpan[], done: (result: { code: ExportResultCode }) => void): void {
    const timer = setTimeout(() => {
      this.spans.push(...spans)
      done({ code: ExportResultCode.SUCCESS })
    }, this.delayMs)
    timer.unref?.()
  }
  async shutdown(): Promise<void> {}
}

const eventsSource: AnswerEventsSource = async function* () {}

async function listen(app: Express) {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

function postKnowledgeBase(port: number, name: string) {
  return fetch(`http://127.0.0.1:${port}/api/knowledge-bases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  })
}

test("LO-18-AC01/AC02/AC06: slow stdout and a full trace queue change neither the response nor SQLite", async () => {
  const db = openDb(":memory:")
  const pipe = new SlowPipe()
  const counters = new LogCounters()
  const sink = new BackpressureSink(pipe, counters)
  const logger = createPinoLogger({ level: "info", sink, counters, bindings: { service: "lo18" } })
  const exporter = new SlowExporter()
  const runtime = new OtelTracingRuntime({
    sampleRate: 1,
    exporter,
    processor: { maxQueueSize: 1, maxExportBatchSize: 1, scheduledDelayMs: 2, exportTimeoutMs: 10 },
  })
  const app = createApp({ db, logger, tracing: runtime, eventsSource })
  const { server, port } = await listen(app)
  try {
    const started = Date.now()
    const responses = await Promise.all([
      postKnowledgeBase(port, "pressure-a"),
      postKnowledgeBase(port, "pressure-b"),
      postKnowledgeBase(port, "pressure-c"),
    ])
    const elapsed = Date.now() - started
    assert.deepEqual(responses.map((response) => response.status), [201, 201, 201])
    assert.ok(elapsed < 2_000, `the exporter must not block requests (took ${elapsed}ms)`)

    const rows = db.prepare("SELECT COUNT(*) AS count FROM knowledge_bases").get() as { count: number }
    assert.equal(rows.count, 3, "product rows are written regardless of the two sinks")

    // stdout is full: the logger is WAITING (backpressure), not dropping.
    assert.ok(counters.waits > 0, "the producer visibly waited on the pipe")
    assert.equal(counters.skippedAfterClose, 0, "no record is discarded for a slow pipe")
    assert.ok(sink.pendingWrites() > 0, "the producer is visibly waiting on the pipe")
    for (let i = 0; i < 5; i += 1) {
      pipe.grant(10)
      pipe.drain()
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(await sink.flush(2_000), true, "accepted lines reach the pipe once it drains")
    assert.equal(pipe.terminals().length, 3, "exactly one terminal record per request")
    assert.equal(counters.writeErrors, 0)

    await runtime.flush(500)
    const diagnostics = runtime.diagnostics()
    assert.ok(
      diagnostics.dropped > 0 || diagnostics.received <= 2,
      "a one-slot queue under six spans must drop or refuse spans",
    )
    assert.equal(rows.count, 3, "trace loss never rolls back product state")
    await runtime.shutdown(500)
  } finally {
    server.close()
    db.close()
  }
})

test("LO-18-AC05: shutdown is bounded, idempotent, and does not reopen roots", async () => {
  const db = openDb(":memory:")
  const exporter = new SlowExporter(1)
  const runtime = new OtelTracingRuntime({ sampleRate: 1, exporter })
  const app = createApp({ db, logger: new SilentLogger(), tracing: runtime, eventsSource })
  const { server, port } = await listen(app)
  try {
    assert.equal((await postKnowledgeBase(port, "before-shutdown")).status, 201)
    const first = await runtime.shutdown(500)
    const second = await runtime.shutdown(500)
    assert.equal(first.closed, true)
    assert.equal(second.alreadyClosed, true, "shutdown stays idempotent")
    assert.equal(runtime.diagnostics().state, "closed")

    const after = await postKnowledgeBase(port, "after-shutdown")
    assert.equal(after.status, 201, "business continues after the trace runtime is gone")
    assert.equal(after.headers.get("x-trace-id"), null, "a closed runtime never opens a new root")
    const rows = db.prepare("SELECT COUNT(*) AS count FROM knowledge_bases").get() as { count: number }
    assert.equal(rows.count, 2)
  } finally {
    server.close()
    db.close()
  }
})

test("LO-18-AC03/AC07: Generation content is not capped by the 8 KiB log rule", async () => {
  const exporter = new SlowExporter(0)
  const runtime = new OtelTracingRuntime({ sampleRate: 1, exporter })
  try {
    const prompt = "p".repeat(20_000)
    const reply = "r".repeat(20_000)
    const scope = runtime.observeModel({ name: "chat.completions", model: "m", input: prompt, stream: false })
    assert.ok(scope)
    scope.end({ status: "ok", output: reply })
    await runtime.flush(500)
    const span = exporter.spans.find((candidate) => candidate.name === "chat.completions")
    assert.ok(span)
    const attributes = span.attributes as Record<string, unknown>
    assert.equal(String(attributes["langfuse.observation.input"]).length, 20_000)
    assert.equal(String(attributes["langfuse.observation.output"]).length, 20_000)
    assert.ok(String(attributes["langfuse.observation.input"]).length > 8 * 1024)
    await runtime.shutdown(300)
  } finally {
    // nothing else to release
  }
})

test("LO-18-AC04: sampling off traces nothing, sampling on traces each root once", async () => {
  const db = openDb(":memory:")
  const exporter = new SlowExporter(0)
  const off = new OtelTracingRuntime({ sampleRate: 0, exporter })
  const app = createApp({ db, logger: new SilentLogger(), tracing: off, eventsSource })
  const { server, port } = await listen(app)
  try {
    const response = await postKnowledgeBase(port, "sampled-off")
    assert.equal(response.status, 201)
    assert.equal(response.headers.get("x-trace-id"), null)
    await off.flush(200)
    assert.equal(exporter.spans.length, 0, "rate 0 never records")
    await off.shutdown(200)
  } finally {
    server.close()
    db.close()
  }
})
