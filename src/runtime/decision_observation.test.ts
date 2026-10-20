import assert from "node:assert/strict"
import test from "node:test"
import { ExportResultCode } from "@opentelemetry/core"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"
import { configureDecisionTracing, executeDecisionCall } from "./decision_call"
import { createTracingRuntime } from "../tracing/composition"

/**
 * LO-10: the CLEF decision provider is a real model call. It gets one
 * observation per call (no fabricated chat prompt), provider usage when
 * reported, and a single terminal status on success or failure.
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

function attributesOf(span: ReadableSpan): Record<string, unknown> {
  return span.attributes as Record<string, unknown>
}

test("LO-10-AC01/AC05: one decision call produces one observation with provider usage", async () => {
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  configureDecisionTracing(runtime)
  try {
    const result = await executeDecisionCall(
      "@cf/cloudflare/clef",
      async () => ({
        payload: { decision: "simple" },
        usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
      }),
      { timeoutMs: 1_000 },
    )
    assert.equal((result as unknown as { payload: { decision: string } }).payload.decision, "simple")
    await runtime.flush(1_000)

    assert.equal(exporter.spans.length, 1)
    const span = exporter.spans[0]
    const attributes = attributesOf(span)
    assert.equal(span.name, "decision.clef")
    assert.equal(attributes["langfuse.observation.model.name"], "@cf/cloudflare/clef")
    assert.equal(
      attributes["langfuse.observation.usage_details"],
      JSON.stringify({ input: 3, output: 1, total: 4 }),
    )
    assert.equal(span.status.code, 1)
  } finally {
    configureDecisionTracing(undefined)
    await runtime.shutdown(500)
  }
})

test("LO-10-AC05: a provider failure keeps the tagged error and closes the scope once", async () => {
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  configureDecisionTracing(runtime)
  try {
    await assert.rejects(
      () => executeDecisionCall("@cf/cloudflare/clef", async () => {
        throw new Error("boom")
      }, { timeoutMs: 1_000 }),
    )
    await runtime.flush(1_000)
    assert.equal(exporter.spans.length, 1)
    assert.equal(exporter.spans[0].status.code, 2)
  } finally {
    configureDecisionTracing(undefined)
    await runtime.shutdown(500)
  }
})
