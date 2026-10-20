import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ExportResultCode } from "@opentelemetry/core"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"
import { createApp } from "./server"
import { IngestionLifecycle, type IngestionStageRunner, type StageExecution } from "../ingestion/lifecycle"
import { closeDb, openDb } from "../ingestion/tracking"
import { OtelTracingRuntime } from "../tracing/otel_runtime"
import { SilentLogger } from "../logging/logger"
import type { AnswerEventsSource } from "./chat"

/**
 * LO-13-AC01: a REAL upload request hands its trace to the persisted task.
 *
 * The assertion is on the isolated SQLite row the request itself wrote — not
 * on a returned header — so the evidence covers capture + persistence in one
 * step. Execution is covered by `src/ingestion/task_trace.test.ts`.
 */

class FakeExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = []
  export(spans: readonly ReadableSpan[], done: (result: { code: ExportResultCode }) => void): void {
    this.spans.push(...spans)
    done({ code: ExportResultCode.SUCCESS })
  }
  async shutdown(): Promise<void> {}
}

const eventsSource: AnswerEventsSource = async function* () {}

const completingRunner: IngestionStageRunner = {
  close: async () => {},
  async run(_document, execution: StageExecution): Promise<void> {
    for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
      await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
    }
  },
}

test("LO-13-AC01/AC02: POST /api/ingest persists the request trace on the task row", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-lo13-"))
  const previousPath = process.env.SQLITE_PATH
  const previousKey = process.env.OPENAI_API_KEY
  process.env.SQLITE_PATH = join(directory, "ingestion.db")
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  const exporter = new FakeExporter()
  const runtime = new OtelTracingRuntime({ sampleRate: 1, exporter })
  const server = createApp({ eventsSource, tracing: runtime, logger: new SilentLogger() }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address() as { port: number }
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "handoff", content: "body text", source: "lo13 http" }),
    })
    assert.equal(response.status, 200)
    const submission = (await response.json()) as { docId: string; taskId: number }
    const requestTraceId = response.headers.get("x-trace-id")
    assert.match(String(requestTraceId), /^[0-9a-f]{32}$/)

    const db = openDb()
    const row = db
      .prepare("SELECT payload FROM task_pending_ops WHERE doc_id = ?")
      .get(submission.docId) as { payload: string }
    const payload = JSON.parse(row.payload) as { trace?: Record<string, unknown> }
    assert.ok(payload.trace, "the task carries the handoff")
    assert.equal(payload.trace?.traceId, requestTraceId, "the same trace as the HTTP root")
    assert.match(String(payload.trace?.spanId), /^[0-9a-f]{16}$/)
    assert.equal(payload.trace?.sampled, true)
    assert.equal(typeof payload.trace?.traceId, "string", "primitives only — no SDK object")

    await runtime.flush(500)
    const root = exporter.spans.find((span) => span.name === "http.post")
    assert.equal(root?.spanContext().traceId, requestTraceId)
    assert.equal(payload.trace?.spanId, root?.spanContext().spanId, "the task points at the submit span")
    await runtime.shutdown(300)
  } finally {
    server.close()
    closeDb()
    if (previousPath === undefined) delete process.env.SQLITE_PATH
    else process.env.SQLITE_PATH = previousPath
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
    rmSync(directory, { recursive: true, force: true })
  }
})

test("LO-14-AC01/AC02/AC04: maintenance commands link the task to the operator's trace", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-lo14-"))
  const previousPath = process.env.SQLITE_PATH
  const previousKey = process.env.OPENAI_API_KEY
  process.env.SQLITE_PATH = join(directory, "ingestion.db")
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  const exporter = new FakeExporter()
  const runtime = new OtelTracingRuntime({ sampleRate: 1, exporter })
  const server = createApp({ eventsSource, tracing: runtime, logger: new SilentLogger() }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address() as { port: number }
    const base = `http://127.0.0.1:${address.port}`
    const submitted = await fetch(`${base}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "maintain", content: "body text", source: "lo14 http" }),
    })
    assert.equal(submitted.status, 200)
    const { docId } = (await submitted.json()) as { docId: string }
    const uploadTrace = submitted.headers.get("x-trace-id")

    const db = openDb()
    const lifecycle = new IngestionLifecycle(db, completingRunner)
    const run = await lifecycle.runNext()
    assert.equal(run?.success, true)

    const reprocessed = await fetch(`${base}/api/ingest/${docId}/reprocess`, { method: "POST" })
    assert.equal(reprocessed.status, 200)
    const reprocessTrace = reprocessed.headers.get("x-trace-id")
    assert.match(String(reprocessTrace), /^[0-9a-f]{32}$/)
    assert.notEqual(reprocessTrace, uploadTrace, "the operator action owns a new trace")

    const row = db
      .prepare("SELECT payload FROM task_pending_ops WHERE doc_id = ?")
      .get(docId) as { payload: string }
    const payload = JSON.parse(row.payload) as {
      title?: string
      trace?: { traceId?: string; sampled?: boolean }
    }
    assert.equal(payload.title, "maintain", "the original task fields survive the requeue untouched")
    assert.equal(payload.trace?.traceId, reprocessTrace, "execution will continue the operator trace")
    assert.equal(payload.trace?.sampled, true)

    const tasksBefore = (db.prepare("SELECT COUNT(*) AS count FROM task_pending_ops").get() as { count: number }).count
    const cancelled = await fetch(`${base}/api/ingest/${docId}/cancel`, { method: "POST" })
    assert.equal(cancelled.status, 200)
    const tasksAfter = (db.prepare("SELECT COUNT(*) AS count FROM task_pending_ops").get() as { count: number }).count
    assert.equal(tasksAfter, tasksBefore, "a synchronous command creates no task")

    await runtime.flush(1_000)
    const reprocessSpan = exporter.spans.find((span) => span.name === "document.reprocess")
    const cancelSpan = exporter.spans.find((span) => span.name === "document.cancel")
    assert.ok(reprocessSpan, "the maintenance step is a real span")
    assert.ok(cancelSpan)
    assert.equal(reprocessSpan.spanContext().traceId, reprocessTrace)
    assert.equal(cancelSpan.spanContext().traceId, cancelled.headers.get("x-trace-id"))
    const root = exporter.spans.find(
      (span) => span.name === "http.post" && span.spanContext().traceId === reprocessTrace,
    )
    assert.equal(reprocessSpan.parentSpanContext?.spanId, root?.spanContext().spanId)
    await runtime.shutdown(300)
  } finally {
    server.close()
    closeDb()
    if (previousPath === undefined) delete process.env.SQLITE_PATH
    else process.env.SQLITE_PATH = previousPath
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
    rmSync(directory, { recursive: true, force: true })
  }
})
