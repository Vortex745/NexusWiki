/**
 * LO-19 acceptance: synthetic data through the REAL OTLP chain into the
 * locally deployed Langfuse, then read back through its public API.
 *
 * No provider is called: prompts/replies are synthetic strings. What is real
 * is the exporter, the protocol, the deployed backend and the readback.
 *
 * Run: node --import tsx scripts/lo19-readback.ts
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import type { AddressInfo } from "node:net"
import { OtelTracingRuntime } from "../src/tracing/otel_runtime"
import { createApp } from "../src/api/server"
import { openDb } from "../src/ingestion/tracking/db"
import { SilentLogger } from "../src/logging/logger"
import type { AnswerEventsSource } from "../src/api/chat"

const BASE_URL = (process.env.LANGFUSE_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "")
const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY ?? "pk-lf-lo01-probe"
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY ?? "sk-lf-lo01-probe"
const AUTH = `Basic ${Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64")}`

const evidenceDir = join(process.cwd(), ".scratch", "logging-observability-tickets", "evidence", "LO-19")
mkdirSync(evidenceDir, { recursive: true })

const LONG_PROMPT = `用户问题：退款多久到账？\n${"上下文段落。".repeat(1_500)}`
const LONG_REPLY = `退款在审核通过后三个工作日内到账。${"补充说明。".repeat(2_000)}`
const PREVIEW_25 = Array.from({ length: 25 }, (_, index) => `#${index + 1} ${"证".repeat(155)}`).join("\n")

interface Observation {
  id: string
  name: string | null
  type: string
  parentObservationId?: string | null
  model?: string | null
  input?: unknown
  output?: unknown
  usageDetails?: Record<string, number>
  statusMessage?: string | null
  level?: string
}

async function readTrace(traceId: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  let last: Record<string, unknown> = {}
  for (;;) {
    const response = await fetch(`${BASE_URL}/api/public/traces/${traceId}`, {
      headers: { Authorization: AUTH },
    })
    if (response.ok) {
      last = (await response.json()) as Record<string, unknown>
      const observations = (last.observations as Observation[] | undefined) ?? []
      if (observations.length >= 5) return last
    } else {
      last = { httpStatus: response.status, body: await response.text() }
    }
    if (Date.now() > deadline) return last
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
}

function asText(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  return JSON.stringify(value)
}

async function main(): Promise<void> {
  const exporter = new OTLPTraceExporter({
    url: `${BASE_URL}/api/public/otel/v1/traces`,
    headers: { Authorization: AUTH, "x-langfuse-ingestion-version": "4" },
    timeoutMillis: 15_000,
  })
  const runtime = new OtelTracingRuntime({ sampleRate: 1, exporter, serviceName: "lo19-readback" })
  const root = runtime.startOperation("lo19.synthetic.run", {
    "langfuse.trace.name": "lo19.synthetic.run",
    "langfuse.trace.input": "LO-19 synthetic acceptance",
  })
  const traceId = root.traceId
  if (!traceId) throw new Error("no trace id: is tracing enabled?")
  console.log(`trace=${traceId}`)

  await root.runInContext(async () => {
    const stage = root.startChild("stage.retrieval", { "stage.name": "retrieval" })
    const tool = stage.startChild("tool.knowledge_search", {
      "tool.name": "knowledge_search",
      "tool.result_count": 25,
    })
    // The real preview key the searcher uses: content policy, not the 2 KiB
    // generic-attribute ceiling.
    tool.setAttributes({ "langfuse.observation.output": JSON.stringify(PREVIEW_25) })
    tool.end({ outcome: "ok" })
    stage.end({ outcome: "ok" })

    const chat = runtime.observeModel({
      name: "chat.completions",
      model: "lo19-synthetic-chat",
      provider: "openai",
      input: LONG_PROMPT,
      stream: false,
    })
    chat?.end({
      status: "ok",
      output: LONG_REPLY,
      usage: { promptTokens: 3_210, completionTokens: 876, totalTokens: 4_086 },
    })

    const embedding = runtime.observeModel({
      name: "embeddings",
      model: "lo19-synthetic-embedding",
      provider: "openai",
      input: "单条 embedding 的完整输入文本，用于验证完整内容可读回。",
      stream: false,
      type: "embedding",
    })
    embedding?.end({ status: "ok", usage: { promptTokens: 24, totalTokens: 24 } })

    const cancelled = runtime.observeModel({
      name: "chat.completions.cancelled",
      model: "lo19-synthetic-chat",
      provider: "openai",
      input: "取消场景",
      stream: true,
    })
    cancelled?.end({ status: "cancelled", output: "部分输出", message: "client cancelled" })
  })
  root.end({ outcome: "ok", attributes: { "answer.terminal_status": "completed" } })

  // LO-19-AC01/AC02: one REAL HTTP request through the production stack, so
  // the readback also proves the request root and its business child.
  const db = openDb(":memory:")
  const app = createApp({
    db,
    logger: new SilentLogger(),
    tracing: runtime,
    eventsSource: (async function* () {}) as AnswerEventsSource,
  })
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const port = (server.address() as AddressInfo).port
  let httpTraceId: string | null = null
  let requestId: string | null = null
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/knowledge-bases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "lo19-readback" }),
    })
    httpTraceId = response.headers.get("x-trace-id")
    requestId = response.headers.get("x-request-id")
  } finally {
    server.close()
    db.close()
  }

  const flushed = await runtime.flush(30_000)
  console.log(`flushed=${flushed} diagnostics=${JSON.stringify(runtime.diagnostics())}`)
  const diagnostics = runtime.diagnostics()
  const trace = await readTrace(traceId, 120_000)
  const httpTrace = httpTraceId ? await readTrace(httpTraceId, 60_000) : {}
  const httpObservations = (httpTrace.observations as Observation[] | undefined) ?? []
  const httpRoot = httpObservations.find((observation) => observation.name === "http.post")
  const httpChild = httpObservations.find((observation) => observation.name === "knowledge_base.create")
  const observations = (trace.observations as Observation[] | undefined) ?? []
  const byName = new Map(observations.map((observation) => [observation.name ?? "", observation]))
  const chat = byName.get("chat.completions")
  const embedding = byName.get("embeddings")
  const tool = byName.get("tool.knowledge_search")
  const stage = byName.get("stage.retrieval")
  const cancelled = byName.get("chat.completions.cancelled")

  const checks: Array<{ id: string; pass: boolean; detail: string }> = [
    {
      id: "AC01/AC02 real HTTP root read back",
      pass:
        Boolean(httpRoot) &&
        (httpRoot?.parentObservationId ?? null) === null &&
        Boolean(httpChild) &&
        httpChild?.parentObservationId === httpRoot?.id,
      detail: `httpTrace=${httpTraceId} request_id=${requestId} observations=${httpObservations.map((o) => o.name).join(",")}`,
    },
    {
      id: "AC01 real trace read back",
      pass: observations.length >= 5,
      detail: `${observations.length} observations: ${observations.map((o) => o.name).join(", ")}`,
    },
    {
      id: "AC02 hierarchy",
      pass:
        Boolean(tool?.parentObservationId) &&
        tool?.parentObservationId === stage?.id &&
        stage?.parentObservationId === root.spanId,
      detail: `tool→stage→root: ${tool?.parentObservationId === stage?.id}/${stage?.parentObservationId === root.spanId}`,
    },
    {
      id: "AC03 long content not truncated",
      pass:
        asText(chat?.input).includes("上下文段落。") &&
        asText(chat.input).length === LONG_PROMPT.length &&
        asText(chat.output).length === LONG_REPLY.length,
      detail: `input=${asText(chat?.input).length}/${LONG_PROMPT.length} output=${asText(chat?.output).length}/${LONG_REPLY.length}`,
    },
    {
      id: "AC03 single embedding complete",
      pass: asText(embedding?.input).includes("单条 embedding 的完整输入文本"),
      detail: `embedding input=${asText(embedding?.input).length}`,
    },
    {
      id: "AC04 retrieval preview 25x160",
      pass:
        asText(tool?.output).includes("#25") &&
        // 25 lines of "160-char preview" (the prefix counts inside the 160).
        asText(tool.output).length >= 3_900,
      detail: `preview readback chars=${asText(tool?.output).length}/${PREVIEW_25.length}`,
    },
    {
      id: "AC06 provider usage + cancel",
      pass:
        Number(chat?.usageDetails?.input ?? 0) === 3_210 &&
        Number(chat?.usageDetails?.output ?? 0) === 876 &&
        (cancelled?.level === "WARNING" || cancelled?.level === "ERROR"),
      detail: `usage=${JSON.stringify(chat?.usageDetails)} cancelLevel=${cancelled?.level}`,
    },
  ]

  const report = {
    generatedAt: new Date().toISOString(),
    backend: { baseUrl: BASE_URL, version: (await (await fetch(`${BASE_URL}/api/public/health`)).json()) as unknown },
    traceId,
    flushed,
    diagnostics,
    observations: observations.map((observation) => ({
      id: observation.id,
      name: observation.name,
      type: observation.type,
      parentObservationId: observation.parentObservationId,
      model: observation.model,
      usageDetails: observation.usageDetails,
      level: observation.level,
      inputLength: asText(observation.input).length,
      outputLength: asText(observation.output).length,
    })),
    checks,
  }
  writeFileSync(join(evidenceDir, "readback.json"), JSON.stringify(report, null, 2), "utf8")
  await runtime.shutdown(5_000)

  for (const check of checks) {
    console.log(`${check.pass ? "PASS" : "FAIL"}  ${check.id} — ${check.detail}`)
  }
  if (checks.some((check) => !check.pass)) process.exitCode = 1
}

main().catch((error) => {
  console.error("LO-19 readback failed:", error)
  process.exitCode = 1
})
