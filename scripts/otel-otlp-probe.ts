/**
 * LO-01 probe (OTel chain): send a synthetic root span, a child span and one
 * model-shaped Generation through the REAL OpenTelemetry SDK and the real
 * OTLP/protobuf exporter into the deployed Langfuse backend, then read the
 * trace back over the public REST API.
 *
 * This is the probe the compatibility gate depends on: it proves the protocol
 * mapping (span → trace/observation), parent/child linkage, status, and that
 * long multi-byte prompt/reply content survives byte-for-byte. It does NOT
 * apply the 8 KiB runtime-log ceiling — Generation content is not a log line.
 *
 * Synthetic data only; credentials come from the environment.
 *
 * Usage:
 *   LANGFUSE_BASE_URL=http://localhost:3000 \
 *   LANGFUSE_PUBLIC_KEY=pk-lf-... LANGFUSE_SECRET_KEY=sk-lf-... \
 *   node --import tsx scripts/otel-otlp-probe.ts
 *
 * Env:
 *   LANGFUSE_BASE_URL / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY
 *   PROBE_CHARS  characters per long field (default 4000 ≈ 12 KiB UTF-8)
 */

import { SpanStatusCode, context, trace } from "@opentelemetry/api"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"

const BASE_URL = (process.env.LANGFUSE_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "")
const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY ?? ""
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY ?? ""
const PROBE_CHARS = Number(process.env.PROBE_CHARS ?? 4000)
const READBACK_TIMEOUT_MS = 45_000

const json = (value: unknown): string => JSON.stringify(value)

function authHeader(): string {
  return `Basic ${Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64")}`
}

async function readback(traceId: string): Promise<{ status: number; body?: Record<string, unknown> }> {
  const deadline = Date.now() + READBACK_TIMEOUT_MS
  let status = 0
  while (Date.now() < deadline) {
    const response = await fetch(`${BASE_URL}/api/public/traces/${traceId}`, {
      headers: { Authorization: authHeader() },
    })
    status = response.status
    if (response.ok) {
      return { status, body: (await response.json()) as Record<string, unknown> }
    }
    if (status !== 404) {
      return { status }
    }
    await new Promise((resolve) => setTimeout(resolve, 750))
  }
  return { status }
}

function bytesOf(value: unknown): number {
  if (value === null || value === undefined) return 0
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8")
}

async function main(): Promise<void> {
  if (!PUBLIC_KEY || !SECRET_KEY) {
    process.stderr.write("LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are required; nothing was sent.\n")
    process.exitCode = 1
    return
  }

  const exporter = new OTLPTraceExporter({
    url: `${BASE_URL}/api/public/otel/v1/traces`,
    headers: {
      Authorization: authHeader(),
      // v3 ingestion version header: without it OTel data can lag up to 10 min.
      "x-langfuse-ingestion-version": "4",
    },
  })
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": "kefu-rag",
      "service.version": "lo01-probe",
      "deployment.environment": "local",
    }),
    spanProcessors: [new BatchSpanProcessor(exporter, { maxQueueSize: 256, maxExportBatchSize: 64 })],
  })
  provider.register()
  const tracer = trace.getTracer("lo01-probe", "0.0.1")

  const prompt = "用户长提示：".concat("汉".repeat(PROBE_CHARS))
  const reply = "助手长回复：".concat("字".repeat(PROBE_CHARS))
  const runId = `lo01-otel-${Date.now()}`

  const root = tracer.startSpan("answer.run", {
    attributes: {
      "langfuse.trace.name": "lo01-otel-root",
      "langfuse.observation.type": "span",
      "langfuse.observation.input": json({ question: "合成问题：OTel 链能否写入并读回？" }),
      "langfuse.session.id": "lo01-session",
      "langfuse.user.id": "probe-user",
      "langfuse.trace.metadata.probe": "LO-01-otel",
      "kefu.run.id": runId,
    },
  })

  const rootContext = trace.setSpan(context.active(), root)
  const retrieval = tracer.startSpan(
    "stage.retrieval",
    {
      attributes: {
        "langfuse.observation.type": "span",
        "langfuse.observation.input": json({ query: "合成检索", topK: 2 }),
      },
    },
    rootContext,
  )
  const channel = tracer.startSpan(
    "stage.retrieval.channel",
    {
      attributes: {
        "langfuse.observation.type": "span",
        "langfuse.observation.input": json({ channel: "lexical" }),
      },
    },
    trace.setSpan(rootContext, retrieval),
  )
  channel.setAttribute("langfuse.observation.output", json({ ids: ["synthetic-1", "synthetic-2"] }))
  channel.end()
  retrieval.setAttribute("langfuse.observation.output", json({ candidates: 2 }))
  retrieval.end()

  const generation = tracer.startSpan(
    "answer.generation",
    {
      attributes: {
        "langfuse.observation.type": "generation",
        "langfuse.observation.model.name": "probe-chat-model",
        "langfuse.observation.input": json([{ role: "user", content: prompt }]),
        "langfuse.observation.model.parameters": json({ temperature: 0.2, max_tokens: 512 }),
        "langfuse.observation.usage_details": json({ input: 11, output: 22, total: 33 }),
        "gen_ai.system": "openai",
        "gen_ai.request.model": "probe-chat-model",
      },
    },
    rootContext,
  )
  generation.setAttribute("langfuse.observation.output", json(reply))
  generation.end()

  root.setAttribute("langfuse.observation.output", json({ reply: "合成回答" }))
  root.setStatus({ code: SpanStatusCode.OK })
  root.end()

  const traceId = root.spanContext().traceId
  await provider.forceFlush()
  await provider.shutdown()

  const result = await readback(traceId)
  const observations =
    result.body && Array.isArray(result.body["observations"])
      ? (result.body["observations"] as Array<Record<string, unknown>>).map((observation) => ({
          type: observation["type"],
          name: observation["name"],
          model: observation["model"],
          level: observation["level"],
          parentObservationId: observation["parentObservationId"],
          inputBytes: bytesOf(observation["input"]),
          outputBytes: bytesOf(observation["output"]),
          usage: observation["usage"],
        }))
      : []

  const generationObservation = observations.find((observation) => observation.type === "GENERATION")

  process.stdout.write(
    `${JSON.stringify(
      {
        traceId,
        readbackStatus: result.status,
        found: result.body !== undefined,
        trace: result.body
          ? {
              name: result.body["name"],
              sessionId: result.body["sessionId"],
              userId: result.body["userId"],
              metadata: result.body["metadata"],
            }
          : null,
        observations,
        nestedParentLinkPreserved: observations.filter((observation) => observation.parentObservationId).length,
        sent: {
          promptBytes: Buffer.byteLength(prompt, "utf8"),
          replyBytes: Buffer.byteLength(reply, "utf8"),
        },
        received: {
          promptBytes: generationObservation?.inputBytes ?? 0,
          replyBytes: generationObservation?.outputBytes ?? 0,
        },
        contentPreserved:
          generationObservation !== undefined
            && (generationObservation.inputBytes ?? 0) >= Buffer.byteLength(prompt, "utf8")
            && (generationObservation.outputBytes ?? 0) >= Buffer.byteLength(reply, "utf8"),
      },
      null,
      2,
    )}\n`,
  )
}

void main()
