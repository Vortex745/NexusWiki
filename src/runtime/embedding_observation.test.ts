import assert from "node:assert/strict"
import test from "node:test"
import type OpenAI from "openai"
import { ExportResultCode } from "@opentelemetry/core"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"
import { createRunBudgetedOpenAIClient } from "./openai_budget_client"
import { createTracingRuntime } from "../tracing/composition"

/**
 * LO-11: embedding observation through the shared client seam.
 *
 * Single input keeps its full text; a batch keeps count + five previews; a
 * token-id batch keeps only counts. Vectors are never recorded.
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

function harness(vectors: number) {
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  const fake = {
    chat: { completions: { create: async () => ({}) } },
    embeddings: {
      create: async () => ({
        data: Array.from({ length: vectors }, () => ({ embedding: [0.1, 0.2, 0.3] })),
        usage: { prompt_tokens: 7, total_tokens: 7 },
      }),
    },
  } as unknown as OpenAI
  return { client: createRunBudgetedOpenAIClient(fake, runtime), runtime, exporter }
}

function attributesOf(span: ReadableSpan): Record<string, unknown> {
  return span.attributes as Record<string, unknown>
}

test("LO-11-AC02: a single embedding keeps the full text and reports dimensions", async () => {
  const { client, runtime, exporter } = harness(1)
  const text = "汉".repeat(2_000)
  await client.embeddings.create({ model: "bge-m3", input: text })
  await runtime.flush(1_000)

  const attributes = attributesOf(exporter.spans[0])
  assert.equal(attributes["langfuse.observation.type"], "embedding")
  assert.equal(attributes["langfuse.observation.input"], text)
  assert.equal(attributes["langfuse.observation.output"], JSON.stringify({ count: 1, dimensions: 3 }))
  assert.equal(
    attributes["langfuse.observation.usage_details"],
    JSON.stringify({ input: 7, output: 0, total: 7 }),
  )
  await runtime.shutdown(500)
})

test("LO-11-AC02: a batch records count and five previews, never vectors", async () => {
  const { client, runtime, exporter } = harness(12)
  const inputs = Array.from({ length: 12 }, (_, index) => `文本-${index}`)
  await client.embeddings.create({ model: "bge-m3", input: inputs })
  await runtime.flush(1_000)

  const attributes = attributesOf(exporter.spans[0])
  const input = JSON.parse(String(attributes["langfuse.observation.input"])) as {
    count: number
    preview: string[]
  }
  assert.equal(input.count, 12)
  assert.equal(input.preview.length, 5)
  assert.ok(!JSON.stringify(attributes).includes("0.1"), "vectors are never recorded")
  await runtime.shutdown(500)
})

test("LO-11-AC03/AC05: token-id batches keep counts and failures end once without changing the error", async () => {
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  const failure = new Error("embedding provider down")
  let call = 0
  const fake = {
    chat: { completions: { create: async () => ({}) } },
    embeddings: {
      create: async () => {
        call += 1
        if (call === 2) throw failure
        return { data: [{ embedding: [0.1] }], usage: { prompt_tokens: 1, total_tokens: 1 } }
      },
    },
  } as unknown as OpenAI
  const client = createRunBudgetedOpenAIClient(fake, runtime)

  await client.embeddings.create({ model: "bge-m3", input: [[101, 102], [103]] })
  await assert.rejects(() => client.embeddings.create({ model: "bge-m3", input: "x" }), (error) => error === failure)
  await runtime.flush(1_000)

  const [tokens, failed] = exporter.spans
  assert.equal(JSON.parse(String(attributesOf(tokens)["langfuse.observation.input"])).count, 2)
  assert.equal(failed.status.code, 2)
  await runtime.shutdown(500)
})
