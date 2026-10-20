import assert from "node:assert/strict"
import test from "node:test"
import { ExportResultCode } from "@opentelemetry/core"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"
import { openDb, type DB } from "../ingestion/tracking/db"
import type { IngestionStageRunner, StageExecution } from "../ingestion/lifecycle"
import { createIngestionLifecycle } from "../ingestion/pipeline"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { KnowledgeBaseServiceImpl } from "../knowledge/knowledge_base_service"
import { SyncDataSourceService } from "./data_source_service"
import { SyncRunService } from "./sync_run_service"
import { OtelTracingRuntime } from "../tracing/otel_runtime"

/**
 * LO-15: manual sync continues the trigger's trace; a scheduled sweep opens
 * its own root; derived ingestion inherits the run's handoff.
 */

class FakeExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = []
  export(spans: readonly ReadableSpan[], done: (result: { code: ExportResultCode }) => void): void {
    this.spans.push(...spans)
    done({ code: ExportResultCode.SUCCESS })
  }
  async shutdown(): Promise<void> {}
}

const STAGE_RUNNER: IngestionStageRunner = {
  close: async () => {},
  async run(_document, execution: StageExecution): Promise<void> {
    for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
      await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
    }
  },
}

function activatingRunner(db: DB): IngestionStageRunner {
  return {
    close: () => STAGE_RUNNER.close(),
    async run(document, execution) {
      const result = await STAGE_RUNNER.run(document, execution)
      new DocumentRepo(db).activate(document.id)
      return result
    },
  }
}

function staticFetch(body: string): typeof fetch {
  return (() =>
    Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/plain" } }))) as typeof fetch
}

const TRACE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const SPAN_ID = "bbbbbbbbbbbbbbbb"

function build(db: DB, runtime: OtelTracingRuntime) {
  const lifecycle = createIngestionLifecycle(db, {
    stageRunner: activatingRunner(db),
    activationMode: "auto",
    tracing: runtime,
  })
  const fetchOptions = {
    resolver: async () => ({ addresses: ["93.184.216.34"] }),
    fetchImpl: staticFetch("同步内容"),
  }
  const sources = new SyncDataSourceService({ db, lifecycle, fetchOptions })
  const runs = new SyncRunService({ db, lifecycle, fetchOptions, tracing: runtime })
  const kb = new KnowledgeBaseServiceImpl(new SqliteKnowledgeBaseRepo(db), "text-embedding-3-small:1536").create("demo", "KB")
  const source = sources.create({
    tenantId: "demo",
    knowledgeBaseId: kb.id,
    kind: "url",
    uri: "https://public.test/docs",
  })
  return { lifecycle, runs, sources, source, kb }
}

test("LO-15-AC01/AC02/AC04: a manual run and its derived ingestion join the trigger trace", async () => {
  const db = openDb(":memory:")
  const exporter = new FakeExporter()
  const runtime = new OtelTracingRuntime({ sampleRate: 1, exporter })
  try {
    const { runs, source } = build(db, runtime)
    const settled = await runs.runNow("demo", source.id, {
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      sampled: true,
    })
    assert.equal(settled.status, "completed", "business result unchanged")
    await runtime.flush(1_000)

    const runSpan = exporter.spans.find((span) => span.name === "sync.run")
    assert.ok(runSpan)
    assert.equal(runSpan.spanContext().traceId, TRACE_ID)
    assert.equal(runSpan.parentSpanContext?.spanId, SPAN_ID)

    const ingestionSpan = exporter.spans.find((span) => span.name === "ingestion.task")
    assert.ok(ingestionSpan, "derived ingestion is a real task execution")
    assert.equal(ingestionSpan.spanContext().traceId, TRACE_ID, "same trace, no second root")
    assert.equal(
      ingestionSpan.parentSpanContext?.spanId,
      runSpan.spanContext().spanId,
      "the task hangs from the sync run that produced it",
    )

    const row = db
      .prepare("SELECT trace_id, trace_span_id, trace_sampled FROM sync_runs WHERE id = ?")
      .get(settled.id) as { trace_id: string; trace_span_id: string; trace_sampled: number }
    assert.deepEqual(
      { trace_id: row.trace_id, trace_span_id: row.trace_span_id, trace_sampled: row.trace_sampled },
      { trace_id: TRACE_ID, trace_span_id: SPAN_ID, trace_sampled: 1 },
      "the durable row carries the handoff",
    )
    await runtime.shutdown(500)
  } finally {
    db.close()
  }
})

test("LO-15-AC01/AC05: a scheduled run has no source and opens exactly one root", async () => {
  const db = openDb(":memory:")
  const exporter = new FakeExporter()
  const runtime = new OtelTracingRuntime({ sampleRate: 1, exporter })
  try {
    const { runs, source } = build(db, runtime)
    // Make the source due, then let the worker-path sweep claim it.
    db.prepare("UPDATE sync_data_sources SET interval = '1h', next_run_at = ? WHERE id = ?").run(
      new Date(Date.now() - 60_000).toISOString(),
      source.id,
    )
    await runs.sweep()
    await runtime.flush(1_000)

    const runSpans = exporter.spans.filter((span) => span.name === "sync.run")
    assert.equal(runSpans.length, 1)
    assert.equal(runSpans[0].parentSpanContext, undefined, "scheduled work roots itself")
    assert.equal((runSpans[0].attributes as Record<string, unknown>)["sync.trigger"], "schedule")
    await runtime.shutdown(500)
  } finally {
    db.close()
  }
})

test("LO-15-AC03/AC05: legacy rows root themselves; unsampled rows stay silent", async () => {
  const db = openDb(":memory:")
  const exporter = new FakeExporter()
  const runtime = new OtelTracingRuntime({ sampleRate: 1, exporter })
  try {
    const { runs, source } = build(db, runtime)

    // A row written before the handoff columns existed (NULL, not "false").
    runs.enqueue("demo", source.id, "manual")
    const legacyClaim = runs.claimNext()
    assert.ok(legacyClaim)
    await runs.executeClaimed(legacyClaim)

    // A known-unsampled handoff: the decision must not be rolled again.
    runs.enqueue("demo", source.id, "manual", { traceId: "", spanId: "", sampled: false })
    const unsampledClaim = runs.claimNext()
    assert.ok(unsampledClaim)
    await runs.executeClaimed(unsampledClaim)
    await runtime.flush(1_000)

    const spans = exporter.spans.filter((span) => span.name === "sync.run")
    assert.equal(spans.length, 1, "only the legacy run is traced")
    assert.equal(spans[0].parentSpanContext, undefined, "legacy has no trustworthy upstream")
    assert.equal(spans[0].spanContext().traceFlags & 0x1, 1)
    await runtime.shutdown(500)
  } finally {
    db.close()
  }
})
