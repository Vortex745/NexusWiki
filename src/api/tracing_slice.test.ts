import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import { ExportResultCode } from "@opentelemetry/core"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"
import type { Express } from "express"
import { createApp } from "./server"
import { openDb } from "../ingestion/tracking/db"
import { SilentLogger } from "../logging/logger"
import { createTracingRuntime } from "../tracing/composition"
import { NoopTracingRuntime } from "../tracing/contract"
import type { AnswerEventsSource } from "./chat"
import type { AnswerRunEvent } from "../types"

/**
 * LO-05 (AC02, AC05, AC11): one REAL business operation on the neutral
 * tracing contract, through the real Express stack and an isolated SQLite
 * database. The exporter is a fake; nothing else is stubbed.
 */

class FakeExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = []
  mode: "ok" | "fail" = "ok"

  export(spans: readonly ReadableSpan[], callback: (result: { code: ExportResultCode; error?: Error }) => void): void {
    if (this.mode === "fail") {
      callback({ code: ExportResultCode.FAILED, error: new Error("export down") })
      return
    }
    this.spans.push(...spans)
    callback({ code: ExportResultCode.SUCCESS })
  }

  async shutdown(): Promise<void> {
    // nothing to release in the fake
  }
}

const emptyEventsSource: AnswerEventsSource = async function* () {
  const terminal: AnswerRunEvent = {
    schemaVersion: 1,
    sessionId: "sess-unused",
    runId: "run-unused",
    createdAt: "2026-10-20T00:00:00.000Z",
    status: "completed",
    durationMs: 0,
    attempt: 1,
    round: 0,
    inputSummary: "",
    outputSummary: "",
    type: "done",
    stage: "done",
    eventId: "run-unused:1",
    sequence: 1,
    result: {
      runId: "run-unused",
      status: "completed",
      reply: "unused",
      references: [],
      degradation: { status: "none", unavailableChannels: [] },
    },
  }
  yield terminal
}

const ENABLED_ENV = {
  TRACING_ENABLED: "1",
  LANGFUSE_SAMPLE_RATE: "1",
  LANGFUSE_BASE_URL: "http://localhost:3000",
  LANGFUSE_PUBLIC_KEY: "pk-lf-test",
  LANGFUSE_SECRET_KEY: "sk-lf-test",
}

async function listen(app: Express) {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

function createKnowledgeBase(port: number, body: Record<string, unknown>) {
  return fetch(`http://127.0.0.1:${port}/api/knowledge-bases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

test("LO-05-AC02: a real knowledge-base write produces a root span and a correlation id", async () => {
  const db = openDb(":memory:")
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  const app = createApp({ db, logger: new SilentLogger(), tracing: runtime, eventsSource: emptyEventsSource })
  const { server, port } = await listen(app)
  try {
    const response = await createKnowledgeBase(port, { name: "traced-kb", description: "evidence" })
    assert.equal(response.status, 201)
    const body = (await response.json()) as { knowledgeBase: { id: string; name: string } }
    const traceId = response.headers.get("x-trace-id")
    assert.match(String(traceId), /^[0-9a-f]{32}$/)

    await runtime.flush(1_000)
    assert.equal(exporter.spans.length, 1)
    const span = exporter.spans[0]
    assert.equal(span.name, "knowledge_base.create")
    assert.equal(span.spanContext().traceId, traceId)
    assert.equal(span.status.code, 1, "the operation is marked OK")
    const attributes = span.attributes as Record<string, unknown>
    assert.equal(attributes["knowledge_base.name_length"], "traced-kb".length)
    assert.equal(attributes["knowledge_base.has_description"], true)
    assert.equal(attributes["knowledge_base.id"], body.knowledgeBase.id)
    await runtime.shutdown(500)
  } finally {
    server.close()
    db.close()
  }
})

test("LO-05-AC02: a rejected operation ends its span as an error with a short message", async () => {
  const db = openDb(":memory:")
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  const app = createApp({ db, logger: new SilentLogger(), tracing: runtime, eventsSource: emptyEventsSource })
  const { server, port } = await listen(app)
  try {
    const response = await createKnowledgeBase(port, { name: "   " })
    assert.equal(response.status, 400)
    await runtime.flush(1_000)

    assert.equal(exporter.spans.length, 1)
    const span = exporter.spans[0]
    assert.equal(span.status.code, 2, "ERROR status")
    assert.match(String(span.status.message), /non-empty string/)
    await runtime.shutdown(500)
  } finally {
    server.close()
    db.close()
  }
})

test("LO-05-AC11: with tracing off, the same request returns the same product result", async () => {
  const tracedDb = openDb(":memory:")
  const plainDb = openDb(":memory:")
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  const tracedApp = createApp({ db: tracedDb, logger: new SilentLogger(), tracing: runtime, eventsSource: emptyEventsSource })
  const plainApp = createApp({ db: plainDb, logger: new SilentLogger(), tracing: new NoopTracingRuntime(), eventsSource: emptyEventsSource })
  const traced = await listen(tracedApp)
  const plain = await listen(plainApp)
  try {
    const tracedResponse = await createKnowledgeBase(traced.port, { name: "parity-kb" })
    const plainResponse = await createKnowledgeBase(plain.port, { name: "parity-kb" })
    assert.equal(tracedResponse.status, plainResponse.status)
    const tracedBody = (await tracedResponse.json()) as { knowledgeBase: Record<string, unknown> }
    const plainBody = (await plainResponse.json()) as { knowledgeBase: Record<string, unknown> }
    assert.deepEqual(Object.keys(tracedBody.knowledgeBase).sort(), Object.keys(plainBody.knowledgeBase).sort())
    assert.equal(plainResponse.headers.get("x-trace-id"), null, "no correlation id when nothing was sampled")
    await runtime.shutdown(500)
  } finally {
    traced.server.close()
    plain.server.close()
    tracedDb.close()
    plainDb.close()
  }
})

test("LO-05-AC05/AC11: an unreachable trace backend cannot change the business result", async () => {
  const db = openDb(":memory:")
  const exporter = new FakeExporter()
  exporter.mode = "fail"
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  const app = createApp({ db, logger: new SilentLogger(), tracing: runtime, eventsSource: emptyEventsSource })
  const { server, port } = await listen(app)
  try {
    const response = await createKnowledgeBase(port, { name: "backend-down" })
    assert.equal(response.status, 201)
    assert.match(String(response.headers.get("x-trace-id")), /^[0-9a-f]{32}$/)
    await runtime.flush(500)
    const diagnostics = runtime.diagnostics()
    assert.ok(diagnostics.exportErrors >= 1, "the failure is visible locally")
    assert.equal(diagnostics.received, 1)
    await runtime.shutdown(500)
  } finally {
    server.close()
    db.close()
  }
})
