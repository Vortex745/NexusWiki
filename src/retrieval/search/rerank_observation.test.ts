import assert from "node:assert/strict"
import test from "node:test"
import { ExportResultCode } from "@opentelemetry/core"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"
import { DedicatedReranker } from "./dedicated_reranker"
import { createTracingRuntime } from "../../tracing/composition"
import type { RetrievalResult } from "../../types"

/**
 * LO-12: one real rerank provider call → one Generation, with bounded content
 * (full query, 8 previews of 160 chars, at most 50 scores) and provider-only
 * usage. Failure keeps the caller's error and closes the observation once.
 */

class FakeExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = []
  export(spans: readonly ReadableSpan[], callback: (result: { code: ExportResultCode }) => void): void {
    this.spans.push(...spans)
    callback({ code: ExportResultCode.SUCCESS })
  }
  async shutdown(): Promise<void> {
    // nothing to release
  }
}

const ENABLED_ENV = {
  TRACING_ENABLED: "1",
  LANGFUSE_SAMPLE_RATE: "1",
  LANGFUSE_BASE_URL: "http://localhost:3000",
  LANGFUSE_PUBLIC_KEY: "pk-lf-test",
  LANGFUSE_SECRET_KEY: "sk-lf-test",
}

function result(index: number, content: string): RetrievalResult {
  return {
    chunk: { id: `chunk-${index}`, documentId: `doc-${index}`, content, index },
    score: 0.5,
  } as unknown as RetrievalResult
}

function jpegResponse(): Response {
  return new Response(
    JSON.stringify({
      results: [
        { index: 0, relevance_score: 0.9 },
        { index: 1, relevance_score: 0.4 },
      ],
      meta: { tokens: { input_tokens: 42, output_tokens: 0 } },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

test("LO-12-AC02/AC03: rerank records bounded previews, scores and provider usage", async () => {
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  const longContent = "文".repeat(1_000)
  const results = [result(0, longContent), result(1, longContent), result(2, longContent)]
  const reranker = new DedicatedReranker({
    baseUrl: "http://rerank.local",
    apiKey: "sk-rerank-secret",
    model: "bge-reranker",
    fetchImpl: async () => jpegResponse(),
    tracing: runtime,
  })

  await reranker.rerank("查询全文", results)
  await runtime.flush(1_000)

  assert.equal(exporter.spans.length, 1)
  const span = exporter.spans[0]
  const attributes = span.attributes as Record<string, unknown>
  assert.equal(span.name, "rerank")
  assert.equal(attributes["langfuse.observation.type"], "generation")
  assert.equal(attributes["langfuse.observation.model.name"], "bge-reranker")
  const input = JSON.parse(String(attributes["langfuse.observation.input"])) as {
    query: string
    documents: string[]
    documentCount: number
  }
  assert.equal(input.query, "查询全文")
  assert.equal(input.documentCount, 3)
  assert.equal(input.documents.length, 3)
  for (const document of input.documents) assert.ok(document.length <= 160)
  assert.equal(
    attributes["langfuse.observation.usage_details"],
    JSON.stringify({ input: 42, output: 0, total: 42 }),
  )
  assert.ok(!JSON.stringify(attributes).includes("sk-rerank-secret"), "the key never reaches the observation")
  assert.equal(span.status.code, 1)
  await runtime.shutdown(500)
})

test("LO-12-AC03/AC05: a provider failure keeps the caller's error and ends the scope once", async () => {
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  const reranker = new DedicatedReranker({
    baseUrl: "http://rerank.local",
    apiKey: "sk-rerank-secret",
    fetchImpl: async () => new Response("InvalidRequestBody", { status: 400 }),
    tracing: runtime,
  })

  await assert.rejects(() => reranker.rerank("q", [result(0, "a")]), /HTTP 400/)
  await runtime.flush(1_000)
  assert.equal(exporter.spans.length, 1)
  assert.equal(exporter.spans[0].status.code, 2)
  await runtime.shutdown(500)
})

test("LO-12-AC03: an empty candidate set makes no provider call and no record", async () => {
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  let called = 0
  const reranker = new DedicatedReranker({
    baseUrl: "http://rerank.local",
    apiKey: "sk-rerank-secret",
    fetchImpl: async () => {
      called += 1
      return jpegResponse()
    },
    tracing: runtime,
  })

  const empty = await reranker.rerank("q", [])
  assert.equal(empty.length, 0)
  await runtime.flush(500)
  assert.equal(called, 0)
  assert.equal(exporter.spans.length, 0)
  await runtime.shutdown(500)
})
