import assert from "node:assert/strict"
import test from "node:test"
import { ExportResultCode } from "@opentelemetry/core"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"
import type { DB } from "../ingestion/tracking/db"
import { openDb } from "../ingestion/tracking/db"
import { WikiEngine, type WikiTopicGenerator } from "./engine"
import { WikiStore } from "./store"
import { OtelTracingRuntime } from "../tracing/otel_runtime"

/**
 * LO-16: a wiki job continues the trace of the operation that queued it.
 */

class FakeExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = []
  export(spans: readonly ReadableSpan[], done: (result: { code: ExportResultCode }) => void): void {
    this.spans.push(...spans)
    done({ code: ExportResultCode.SUCCESS })
  }
  async shutdown(): Promise<void> {}
}

function seed(db: DB, id: string): void {
  const now = "2026-09-27T00:00:00Z"
  db.prepare(`INSERT INTO sources (source_id, source_key, source_kind,
    source_uri, namespace, active_doc_id, created_at, updated_at,
    tenant_id, knowledge_base_id)
    VALUES (?, ?, 'file', ?, 'local', ?, ?, ?, 'tenant-a', 'kb-a')`)
    .run(id, `key-${id}`, `${id}.txt`, `doc-${id}`, now, now)
  db.prepare(`INSERT INTO documents (doc_id, source_id, content_hash,
    version, title, source, content, status, created_at, updated_at,
    tenant_id, knowledge_base_id)
    VALUES (?, ?, ?, 1, 'Shared topic', ?, 'body', 'completed', ?, ?,
      'tenant-a', 'kb-a')`)
    .run(`doc-${id}`, id, `hash-${id}`, `${id}.txt`, now, now)
}

const generator: WikiTopicGenerator = {
  async map(_title, chunks) {
    return [{
      title: "Shared topic",
      pageType: "concept",
      summary: "",
      content: `Contribution from ${chunks[0].content} with enough detail to publish.`,
      chunkIds: [chunks[0].id],
    }]
  },
  async reduce(_title, contributions) {
    return { summary: "", content: contributions.map((item) => item.content).join("\n\n") }
  },
}

const chunks = { async list(documentId: string) { return [{ id: `chunk-${documentId}`, content: documentId }] } }

const TRACE_ID = "cccccccccccccccccccccccccccccccc"
const SPAN_ID = "dddddddddddddddd"

test("LO-16-AC02/AC03: a queued job continues its source trace and ends once", async () => {
  const db = openDb(":memory:")
  const exporter = new FakeExporter()
  const runtime = new OtelTracingRuntime({ sampleRate: 1, exporter })
  try {
    seed(db, "one")
    const store = new WikiStore(db)
    store.setEnabled("tenant-a", "kb-a", true)
    const engine = new WikiEngine(db, store, chunks, generator, runtime)

    const jobId = store.enqueue("tenant-a", "kb-a", "doc-one", "one", "ingest", {
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      sampled: true,
    })
    const row = db
      .prepare("SELECT trace_id, trace_span_id, trace_sampled FROM wiki_jobs WHERE id = ?")
      .get(jobId) as { trace_id: string; trace_span_id: string; trace_sampled: number }
    assert.deepEqual(row, { trace_id: TRACE_ID, trace_span_id: SPAN_ID, trace_sampled: 1 })

    const job = await engine.runNext()
    assert.equal(job?.status, "running")
    assert.equal(store.jobs("tenant-a", "kb-a")[0].status, "completed")
    await runtime.flush(1_000)

    const spans = exporter.spans.filter((span) => span.name === "wiki.job")
    assert.equal(spans.length, 1, "one span per real execution")
    assert.equal(spans[0].spanContext().traceId, TRACE_ID)
    assert.equal(spans[0].parentSpanContext?.spanId, SPAN_ID)
    assert.equal((spans[0].attributes as Record<string, unknown>)["wiki.op"], "ingest")
    await runtime.shutdown(500)
  } finally {
    db.close()
  }
})

test("LO-16-AC03/AC04: legacy jobs root themselves, unsampled jobs stay silent, failures end once", async () => {
  const db = openDb(":memory:")
  const exporter = new FakeExporter()
  const runtime = new OtelTracingRuntime({ sampleRate: 1, exporter })
  try {
    seed(db, "one")
    const store = new WikiStore(db)
    store.setEnabled("tenant-a", "kb-a", true)
    const failing: WikiTopicGenerator = {
      async map() {
        throw new Error("generator down")
      },
      async reduce() {
        throw new Error("generator down")
      },
    }
    const engine = new WikiEngine(db, store, chunks, failing, runtime)

    store.enqueue("tenant-a", "kb-a", "doc-one", "one", "ingest")
    await engine.runNext()

    store.retryJob(store.jobs("tenant-a", "kb-a")[0].id, "tenant-a", "kb-a")
    const unsampledId = store.enqueue("tenant-a", "kb-a", "doc-one", "one", "ingest", {
      traceId: "",
      spanId: "",
      sampled: false,
    })
    // The first failed job is retried by the same runNext; run until drained.
    for (let i = 0; i < 3; i += 1) await engine.runNext()
    await runtime.flush(1_000)

    const spans = exporter.spans.filter((span) => span.name === "wiki.job")
    assert.equal(spans.length, 2, "legacy + retried legacy; the unsampled job adds nothing")
    assert.equal(spans[0].parentSpanContext, undefined)
    assert.equal(spans[0].status.code, 2, "a failed job is an error span, ended once")
    assert.equal(spans[1].parentSpanContext, undefined)
    const row = db.prepare("SELECT status FROM wiki_jobs WHERE id = ?").get(unsampledId) as { status: string }
    assert.equal(row.status, "failed", "business terminal unchanged")
    await runtime.shutdown(500)
  } finally {
    db.close()
  }
})
