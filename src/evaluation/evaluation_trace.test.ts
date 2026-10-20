import assert from "node:assert/strict"
import test from "node:test"
import { ExportResultCode } from "@opentelemetry/core"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"
import type { AppConfig } from "../config"
import { EvaluationService } from "./service"
import { OtelTracingRuntime } from "../tracing/otel_runtime"

/**
 * LO-17: an in-process evaluation task explicitly carries the submit's
 * handoff. The scope is created for the REAL task run; this test stubs only
 * the isolated resources (no providers), which is the same seam the existing
 * evaluation acceptance tests use.
 */

class FakeExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = []
  export(spans: readonly ReadableSpan[], done: (result: { code: ExportResultCode }) => void): void {
    this.spans.push(...spans)
    done({ code: ExportResultCode.SUCCESS })
  }
  async shutdown(): Promise<void> {}
}

const CONFIG: AppConfig = {
  esNode: "http://es.test",
  esApiKey: "",
  openaiApiKey: "chat-key",
  openaiBaseUrl: "http://chat.test",
  openaiChatModel: "test-chat-model",
  embeddingApiKey: "emb-key",
  embeddingBaseUrl: "http://emb.test",
  embeddingModel: "test-embedding-model",
  embeddingDimensions: 3,
  openaiRequestTimeoutMs: 1_000,
  openaiMaxRetries: 0,
  neo4jUri: "bolt://neo4j.test",
  neo4jUser: "neo4j",
  neo4jPassword: "password",
  sqlitePath: ":memory:",
  pollIntervalMs: 1,
  claimedTimeoutMs: 1,
  accessMode: "single_tenant",
  demoOidc: false,
  demoOidcPort: 3900,
  demoOidcAudience: "nexusrag-demo",
  demoOidcPassword: "",
  activationMode: "auto",
  conversationTtlDays: 30,
  conversationGcIntervalMs: 86_400_000,
  rerankApiKey: "rerank-key",
  rerankBaseUrl: "https://reranker.test/v1",
  rerankModel: "bge-reranker-v2-m3",
  rerankTimeoutMs: 5_000,
  rerankMaxDocumentChars: 4_000,
  mcpCapabilitiesEnabled: false,
}

const DATASET = {
  schemaVersion: 1,
  name: "trace sample",
  version: "1",
  corpus: [{ passageId: "p1", content: "退款三个工作日到账。" }],
  cases: [{
    caseId: "c1",
    question: "退款多久到账？",
    referenceAnswer: "三个工作日。",
    relevantPassageIds: ["p1"],
  }],
}

const OWNER = { tenantId: "tenant-a", subjectId: "subject-a" }
const TRACE_ID = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
const SPAN_ID = "ffffffffffffffff"

function buildService(runtime: OtelTracingRuntime): EvaluationService {
  return new EvaluationService({
    config: CONFIG,
    clients: {} as never,
    // The scope cannot be built without providers — the run fails, which is
    // exactly what proves the span is closed on the failure path too.
    createResources: () => {
      throw new Error("no isolated scope in this test")
    },
    tracing: runtime,
    taskTimeoutMs: 2_000,
    cleanupTimeoutMs: 200,
  })
}

test("LO-17-AC02/AC04: an evaluation task continues the submit trace and ends once", async () => {
  const exporter = new FakeExporter()
  const runtime = new OtelTracingRuntime({ sampleRate: 1, exporter })
  const service = buildService(runtime)
  try {
    const summary = service.createTask(
      { dataset: DATASET },
      OWNER,
      { traceId: TRACE_ID, spanId: SPAN_ID, sampled: true },
    )
    const detail = await service.waitForTerminal(summary.id, OWNER, 2_000)
    assert.equal(detail.stage, "failed", "business outcome is unchanged by tracing")
    await runtime.flush(1_000)

    const spans = exporter.spans.filter((span) => span.name === "evaluation.task")
    assert.equal(spans.length, 1, "one span per task run")
    assert.equal(spans[0].spanContext().traceId, TRACE_ID)
    assert.equal(spans[0].parentSpanContext?.spanId, SPAN_ID)
    assert.equal(spans[0].status.code, 2, "a failed task is an error span")
    assert.equal((spans[0].attributes as Record<string, unknown>)["evaluation.cases"], 1)
    await runtime.shutdown(300)
  } finally {
    await service.shutdown(500).catch(() => undefined)
  }
})

test("LO-17-AC03/AC05: a task without a handoff roots itself; unsampled stays silent", async () => {
  const exporter = new FakeExporter()
  const runtime = new OtelTracingRuntime({ sampleRate: 1, exporter })
  const service = buildService(runtime)
  try {
    const legacy = service.createTask({ dataset: DATASET }, OWNER)
    await service.waitForTerminal(legacy.id, OWNER, 2_000)
    const silent = service.createTask(
      { dataset: DATASET },
      OWNER,
      { traceId: "", spanId: "", sampled: false },
    )
    await service.waitForTerminal(silent.id, OWNER, 2_000)
    await runtime.flush(1_000)

    const spans = exporter.spans.filter((span) => span.name === "evaluation.task")
    assert.equal(spans.length, 1, "legacy roots, unsampled produces nothing")
    assert.equal(spans[0].parentSpanContext, undefined)
    await runtime.shutdown(300)
  } finally {
    await service.shutdown(500).catch(() => undefined)
  }
})
