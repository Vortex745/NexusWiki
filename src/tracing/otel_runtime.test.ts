import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import test from "node:test"
import { ExportResultCode } from "@opentelemetry/core"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"
import { createTracingRuntime, resolveTracingConfig } from "./composition"
import { DEFAULT_MAX_ATTRIBUTE_BYTES } from "./otel_runtime"

/**
 * LO-05: bounded tracing runtime.
 *
 * Every assertion here is about the runtime's own guarantees — sampling once,
 * bounded queue, isolated failure, bounded flush/shutdown — driven through a
 * fake exporter. No network, no backend, no business wiring.
 */

class FakeExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = []
  mode: "ok" | "hang" | "fail" = "ok"
  shutdownCalls = 0

  export(spans: readonly ReadableSpan[], callback: (result: { code: ExportResultCode; error?: Error }) => void): void {
    if (this.mode === "hang") return
    if (this.mode === "fail") {
      callback({ code: ExportResultCode.FAILED, error: new Error("backend unreachable") })
      return
    }
    this.spans.push(...spans)
    callback({ code: ExportResultCode.SUCCESS })
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1
  }
}

const ENABLED_ENV = {
  TRACING_ENABLED: "1",
  LANGFUSE_SAMPLE_RATE: "1",
  LANGFUSE_BASE_URL: "http://localhost:3000",
  LANGFUSE_PUBLIC_KEY: "pk-lf-test",
  LANGFUSE_SECRET_KEY: "sk-lf-test",
}

test("LO-05-AC03/AC04: tracing is off by default and the noop runtime is independent", async () => {
  const { runtime, config } = createTracingRuntime({ env: {} })
  assert.equal(config.enabled, false)
  assert.equal(config.reason, "disabled_by_env")
  assert.equal(runtime.enabled, false)

  const scope = runtime.startOperation("should.not.exist", { "a.b": "c" })
  assert.equal(scope.sampled, false)
  assert.equal(scope.traceId, undefined)
  const child = scope.startChild("child")
  assert.equal(child.sampled, false)
  scope.end({ outcome: "ok" })

  assert.equal(await runtime.flush(10), true)
  const shutdown = await runtime.shutdown(10)
  assert.equal(shutdown.closed, true)
  assert.equal(runtime.diagnostics().received, 0)
})

test("LO-05-AC03: rate 0 and illegal rates keep tracing off instead of guessing", () => {
  assert.equal(resolveTracingConfig({ ...ENABLED_ENV, LANGFUSE_SAMPLE_RATE: "0" }).reason, "sample_rate_zero")
  for (const bad of ["abc", "1.5", "-0.5", "NaN"]) {
    const config = resolveTracingConfig({ ...ENABLED_ENV, LANGFUSE_SAMPLE_RATE: bad })
    assert.equal(config.enabled, false, `rate "${bad}" must not enable tracing`)
    assert.equal(config.reason, "invalid_sample_rate")
    assert.equal(config.warnings.length, 1)
  }
  assert.equal(resolveTracingConfig({ TRACING_ENABLED: "1" }).reason, "missing_credentials")
  assert.equal(
    resolveTracingConfig({ ...ENABLED_ENV, LANGFUSE_BASE_URL: "not-a-url" }).reason,
    "invalid_endpoint",
  )
})

test("LO-05-AC02/AC03: a root is sampled once and children inherit — no second sampling", async () => {
  const exporter = new FakeExporter()
  const { runtime, config } = createTracingRuntime({ env: ENABLED_ENV, exporter })
  assert.equal(config.sampleRate, 1)

  await runtime.runOperation("answer.run", { "run.id": "r-1" }, async (scope) => {
    assert.equal(scope.sampled, true)
    assert.match(String(scope.traceId), /^[0-9a-f]{32}$/)
    const child = scope.startChild("stage.route", { "stage": "route" })
    assert.equal(child.sampled, true)
    assert.equal(child.traceId, scope.traceId, "a child never opens a new trace")
    child.end({ outcome: "ok" })
    return "done"
  })
  await runtime.flush(1_000)

  const spans = exporter.spans
  assert.deepEqual(spans.map((span) => span.name).sort(), ["answer.run", "stage.route"])
  assert.equal(new Set(spans.map((span) => span.spanContext().traceId)).size, 1, "one trace id")
  const root = spans.find((span) => span.name === "answer.run")
  const child = spans.find((span) => span.name === "stage.route")
  assert.equal(child?.parentSpanContext?.spanId, root?.spanContext().spanId)
  const diagnostics = runtime.diagnostics()
  assert.equal(diagnostics.received, 2)
  assert.equal(diagnostics.exported, 2)
  assert.equal(diagnostics.dropped, 0)
  assert.equal(runtime.enabled, true)
})

test("LO-05-AC03/AC04: a middle rate samples some roots and every child follows its own parent", async () => {
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: { ...ENABLED_ENV, LANGFUSE_SAMPLE_RATE: "0.5" }, exporter })

  const decisions: Array<{ rootSampled: boolean; childSampled: boolean; sameTrace: boolean }> = []
  for (let index = 0; index < 40; index += 1) {
    const root = runtime.startOperation(`root.${index}`)
    const child = root.startChild(`child.${index}`)
    decisions.push({
      rootSampled: root.sampled,
      childSampled: child.sampled,
      sameTrace: child.traceId === root.traceId,
    })
    child.end()
    root.end()
  }
  await runtime.flush(1_000)

  const sampled = decisions.filter((decision) => decision.rootSampled).length
  assert.ok(sampled > 0 && sampled < 40, `0.5 should sample some roots, sampled ${sampled}`)
  for (const decision of decisions) {
    assert.equal(decision.childSampled, decision.rootSampled, "child inherits the root decision")
    assert.ok(decision.sameTrace, "child stays in the parent trace")
  }
  assert.equal(exporter.spans.length, sampled * 2, "unsampled roots produce no spans at all")
})

test("LO-05-AC05: a full queue drops the newest observation and never blocks the caller", async () => {
  const exporter = new FakeExporter()
  exporter.mode = "hang"
  const { runtime } = createTracingRuntime({
    env: ENABLED_ENV,
    exporter,
  })
  // A hanging exporter keeps the queue saturated; the runtime is built with
  // default bounds, so overflowing it requires more spans than the queue.
  const startedAt = Date.now()
  for (let index = 0; index < 1_500; index += 1) {
    const scope = runtime.startOperation(`flood.${index}`)
    scope.end()
  }
  const elapsed = Date.now() - startedAt
  const diagnostics = runtime.diagnostics()
  assert.ok(elapsed < 3_000, `enqueueing must not block, took ${elapsed}ms`)
  assert.ok(diagnostics.dropped > 0, "queue overflow must be counted, not silent")
  assert.equal(diagnostics.received, 1_500)
  await runtime.shutdown(20)
})

test("LO-05-AC05: an unreachable or throwing exporter changes no business result", async () => {
  const exporter = new FakeExporter()
  exporter.mode = "fail"
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })

  const value = await runtime.runOperation("answer.run", undefined, async () => "business-value")
  assert.equal(value, "business-value")
  await runtime.flush(500)

  const diagnostics = runtime.diagnostics()
  assert.ok(diagnostics.exportErrors >= 1)
  assert.equal(diagnostics.lastError, "backend unreachable")
  assert.equal(diagnostics.state, "open")
})

test("LO-05-AC06: attribute and content ceilings are enforced before buffering", async () => {
  const exporter = new FakeExporter()
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })

  const longAttribute = "x".repeat(5_000)
  const content = "汉".repeat(300_000) // ~900 KiB, under the 1 MiB content ceiling
  const oversizedContent = "汉".repeat(500_000) // ~1.5 MiB, over the ceiling
  const scope = runtime.startOperation("limits", { note: longAttribute })
  scope.setAttributes({
    "langfuse.observation.input": content,
    "langfuse.observation.output": oversizedContent,
  })
  scope.end()
  await runtime.flush(1_000)

  const span = exporter.spans[0]
  const attributes = span.attributes as Record<string, unknown>
  const note = String(attributes["note"])
  assert.ok(Buffer.byteLength(note, "utf8") <= DEFAULT_MAX_ATTRIBUTE_BYTES, "ordinary attribute is capped")
  assert.ok(note.endsWith("…[truncated]"), "truncation is visible, not silent")
  assert.equal(attributes["langfuse.observation.input"], content, "content ceiling does not cut 900 KiB")
  const output = String(attributes["langfuse.observation.output"])
  assert.ok(Buffer.byteLength(output, "utf8") <= 1_048_576, "content ceiling is enforced")
  assert.ok(runtime.diagnostics().warnings.some((warning) => warning.startsWith("truncated_attributes")))
})

test("LO-05-AC08: flush and shutdown are bounded, idempotent and refuse new roots", async () => {
  const exporter = new FakeExporter()
  exporter.mode = "hang"
  const { runtime } = createTracingRuntime({ env: ENABLED_ENV, exporter })

  runtime.startOperation("pending").end()
  const flushed = await runtime.flush(40)
  assert.equal(flushed, false, "a stuck exporter must not hang the caller")

  const first = await runtime.shutdown(40)
  assert.equal(first.timedOut, true)
  assert.equal(first.droppedPending, 1)
  assert.equal(first.alreadyClosed, false)
  const second = await runtime.shutdown(40)
  assert.equal(second.alreadyClosed, true, "shutdown is idempotent")

  const afterShutdown = runtime.startOperation("after.shutdown")
  assert.equal(afterShutdown.sampled, false, "no new root after shutdown")
  afterShutdown.end()
  assert.equal(runtime.diagnostics().state, "closed")
  assert.equal(exporter.shutdownCalls, 1)
})

test("LO-05-AC09/AC10: only the adapter touches the vendor; the contract stays neutral", () => {
  const root = join(process.cwd(), "src")
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) {
        walk(path)
        continue
      }
      if (!path.endsWith(".ts") || path.endsWith(".test.ts")) continue
      const relativePath = relative(process.cwd(), path).replace(/\\/g, "/")
      const source = readFileSync(path, "utf8")
      const vendorImport = /from\s+"@opentelemetry\//.test(source)
      const allowed = ["src/tracing/otel_runtime.ts", "src/tracing/bounded_processor.ts", "src/tracing/composition.ts"]
      if (vendorImport && !allowed.includes(relativePath)) offenders.push(relativePath)
      if (/@opentelemetry\/sdk-logs|@opentelemetry\/sdk-metrics/.test(source)) {
        offenders.push(`${relativePath} (logs/metrics)`)
      }
    }
  }
  walk(root)
  assert.deepEqual(offenders, [], "business code must not import the tracing vendor")

  const contract = readFileSync(join(root, "tracing", "contract.ts"), "utf8")
  assert.ok(!/from\s+"@opentelemetry\//.test(contract), "the neutral contract has no vendor import")
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    dependencies: Record<string, string>
  }
  const otelDeps = Object.keys(packageJson.dependencies).filter((name) => name.startsWith("@opentelemetry/"))
  assert.deepEqual(otelDeps.sort(), [
    "@opentelemetry/exporter-trace-otlp-proto",
    "@opentelemetry/resources",
    "@opentelemetry/sdk-trace-base",
    "@opentelemetry/sdk-trace-node",
  ])
})
