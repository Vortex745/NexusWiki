import assert from "node:assert/strict"
import test from "node:test"
import { ExportResultCode } from "@opentelemetry/core"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"
import { IngestionLifecycle, type IngestionStageRunner, type StageExecution } from "./lifecycle"
import { OcrApiError } from "./error_classification"
import type { DB } from "./tracking/db"
import { openDb } from "./tracking/db"
import { OtelTracingRuntime } from "../tracing/otel_runtime"
import { readTaskTrace, taskTraceFromScope, type TaskTraceContext } from "../tracing/contract"

/**
 * LO-13: submit → persist → claim → execute keeps ONE correlation.
 *
 * Real isolated SQLite, the real lifecycle, a real OTel runtime with a fake
 * exporter. The only stand-in is the stage runner (no providers in a unit
 * test), which is the same boundary the existing acceptance tests use.
 */

class FakeExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = []
  export(spans: readonly ReadableSpan[], done: (result: { code: ExportResultCode; error?: Error }) => void): void {
    this.spans.push(...spans)
    done({ code: ExportResultCode.SUCCESS })
  }
  async shutdown(): Promise<void> {}
}

const TRACE_ID = "0123456789abcdef0123456789abcdef"
const SPAN_ID = "0123456789abcdef"

function completingRunner(onRun?: () => void): IngestionStageRunner {
  return {
    close: async () => {},
    async run(_document, execution: StageExecution): Promise<void> {
      onRun?.()
      for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
        await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
      }
    },
  }
}

function failingOnceRunner(): IngestionStageRunner {
  let failed = false
  return {
    close: async () => {},
    async run(_document, execution: StageExecution): Promise<void> {
      if (!failed) {
        failed = true
        // A transient provider fault: the only category that consumes retries.
        throw new OcrApiError("provider reset the connection", "transient")
      }
      for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
        await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
      }
    },
  }
}

function payloadOf(db: DB, docId: string): Record<string, unknown> {
  const row = db
    .prepare("SELECT payload FROM task_pending_ops WHERE doc_id = ? ORDER BY id DESC LIMIT 1")
    .get(docId) as { payload: string } | undefined
  assert.ok(row, "the task row exists")
  return JSON.parse(row.payload) as Record<string, unknown>
}

function ingestionSpans(exporter: FakeExporter): ReadableSpan[] {
  return exporter.spans.filter((span) => span.name === "ingestion.task")
}

test("LO-13-AC01/AC02: submit persists neutral ids and execution continues the same trace", async () => {
  const db = openDb(":memory:")
  const exporter = new FakeExporter()
  const runtime = new OtelTracingRuntime({ sampleRate: 1, exporter })
  try {
    const lifecycle = new IngestionLifecycle(db, completingRunner(), () => new Date(), "auto", undefined, runtime)
    const trace: TaskTraceContext = { traceId: TRACE_ID, spanId: SPAN_ID, sampled: true }
    const submitted = lifecycle.submit({ title: "handoff", content: "body", source: "lo13", trace })

    const payload = payloadOf(db, submitted.docId)
    assert.deepEqual(payload.trace, trace, "the payload carries primitives only, no SDK object")

    const result = await lifecycle.runNext()
    assert.equal(result?.success, true)
    await runtime.flush(1_000)

    const spans = ingestionSpans(exporter)
    assert.equal(spans.length, 1)
    assert.equal(spans[0].spanContext().traceId, TRACE_ID, "the worker continued the submitter's trace")
    assert.equal(spans[0].parentSpanContext?.spanId, SPAN_ID, "the execution is a child of the submit span")
    const attributes = spans[0].attributes as Record<string, unknown>
    assert.equal(attributes["task.doc_id"], submitted.docId)
    assert.equal(attributes["task.op"], "ingest")
    assert.match(String(attributes["task.execution_id"]), /^[0-9a-f-]{36}$/)
    await runtime.shutdown(500)
  } finally {
    db.close()
  }
})

test("LO-13-AC05: every retry opens a new execution span and keeps the source", async () => {
  const db = openDb(":memory:")
  const exporter = new FakeExporter()
  const runtime = new OtelTracingRuntime({ sampleRate: 1, exporter })
  let now = Date.parse("2026-10-20T12:00:00.000Z")
  const clock = () => new Date(now)
  try {
    const lifecycle = new IngestionLifecycle(db, failingOnceRunner(), clock, "auto", undefined, runtime)
    const submitted = lifecycle.submit({
      title: "retry",
      content: "body",
      source: "lo13-retry",
      trace: { traceId: TRACE_ID, spanId: SPAN_ID, sampled: true },
    })

    const first = await lifecycle.runNext()
    assert.equal(first?.success, false)
    now += 3_000
    const second = await lifecycle.runNext()
    assert.equal(second?.success, true)
    await runtime.flush(1_000)

    const spans = ingestionSpans(exporter)
    assert.equal(spans.length, 2, "one span per real attempt, not one per task")
    const [failed, retried] = spans
    assert.equal(failed.spanContext().traceId, TRACE_ID)
    assert.equal(retried.spanContext().traceId, TRACE_ID)
    assert.equal(failed.parentSpanContext?.spanId, SPAN_ID)
    assert.equal(retried.parentSpanContext?.spanId, SPAN_ID)
    assert.notEqual(
      failed.attributes["task.execution_id"],
      retried.attributes["task.execution_id"],
      "a retry mints a new execution identity",
    )
    assert.equal(failed.status.code, 2, "the failed attempt is an error span")
    assert.equal(retried.status.code, 1)
    assert.equal(dbp(db, submitted.docId), "completed")
    await runtime.shutdown(500)
  } finally {
    db.close()
  }
})

function dbp(db: DB, docId: string): string {
  const row = db.prepare("SELECT status FROM documents WHERE doc_id = ?").get(docId) as { status: string }
  return row.status
}

test("LO-13-AC06: an unsampled handoff stays unsampled instead of re-rolling", async () => {
  const db = openDb(":memory:")
  const exporter = new FakeExporter()
  const runtime = new OtelTracingRuntime({ sampleRate: 1, exporter })
  try {
    const lifecycle = new IngestionLifecycle(db, completingRunner(), () => new Date(), "auto", undefined, runtime)
    const submitted = lifecycle.submit({
      title: "unsampled",
      content: "body",
      source: "lo13-unsampled",
      trace: { traceId: "", spanId: "", sampled: false },
    })
    const result = await lifecycle.runNext()
    assert.equal(result?.success, true, "business result is unchanged")
    await runtime.flush(500)
    assert.equal(ingestionSpans(exporter).length, 0, "no span is manufactured for an unsampled decision")
    await runtime.shutdown(500)
  } finally {
    db.close()
  }
})

test("LO-13-AC04/AC08: legacy and malformed payloads fall back to the root policy", async () => {
  const db = openDb(":memory:")
  const exporter = new FakeExporter()
  const runtime = new OtelTracingRuntime({ sampleRate: 1, exporter })
  try {
    const legacy = new IngestionLifecycle(db, completingRunner(), () => new Date(), "auto", undefined, runtime)
    const first = legacy.submit({ title: "legacy", content: "body", source: "lo13-legacy" })
    assert.equal("trace" in payloadOf(db, first.docId), false, "no field is invented for old callers")
    await legacy.runNext()

    const tampered = legacy.submit({ title: "tampered", content: "body", source: "lo13-tampered" })
    db.prepare("UPDATE task_pending_ops SET payload = ? WHERE doc_id = ?").run(
      JSON.stringify({ trace: { traceId: "not-hex", spanId: "1", sampled: "yes" } }),
      tampered.docId,
    )
    await legacy.runNext()
    await runtime.flush(1_000)

    const spans = ingestionSpans(exporter)
    assert.equal(spans.length, 2)
    for (const span of spans) {
      assert.equal(span.parentSpanContext, undefined, "no trustworthy source → root policy")
    }
    await runtime.shutdown(500)
  } finally {
    db.close()
  }
})

test("LO-13: the handoff codec rejects junk and never invents a decision", () => {
  assert.equal(readTaskTrace(undefined), undefined)
  assert.equal(readTaskTrace(null), undefined)
  assert.equal(readTaskTrace({ trace: {} }), undefined)
  assert.equal(readTaskTrace({ sampled: true }), undefined)
  assert.equal(readTaskTrace({ sampled: true, traceId: TRACE_ID }), undefined)
  assert.equal(readTaskTrace({ sampled: true, traceId: "zz", spanId: SPAN_ID }), undefined)
  assert.deepEqual(readTaskTrace({ sampled: false, traceId: "", spanId: "" }), {
    traceId: "",
    spanId: "",
    sampled: false,
  })
  assert.deepEqual(readTaskTrace({ sampled: true, traceId: TRACE_ID, spanId: SPAN_ID }), {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    sampled: true,
  })

  assert.equal(taskTraceFromScope(undefined), undefined)
  assert.deepEqual(
    taskTraceFromScope({
      traceId: undefined,
      spanId: undefined,
      sampled: false,
      setAttributes: () => undefined,
      startChild: () => {
        throw new Error("unused")
      },
      runInContext: (fn) => fn(),
      end: () => undefined,
    }),
    { traceId: "", spanId: "", sampled: false },
  )
})
