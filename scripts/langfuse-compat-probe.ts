/**
 * LO-01 compatibility probe: what can the CURRENTLY DEPLOYED Langfuse backend
 * actually accept and give back?
 *
 * It answers four questions with evidence instead of assumption:
 *   1. Is there a native OTLP/HTTP ingestion endpoint (i.e. can an
 *      OpenTelemetry exporter post spans straight into this deployment)?
 *   2. Does the installed `langfuse` SDK reach this backend at all, and does a
 *      synthetic trace/span/generation arrive with parent linkage intact?
 *   3. Does long multi-byte prompt/reply content survive byte-for-byte (the
 *      runtime-log 8 KiB ceiling must never be applied to Generation content)?
 *   4. What are the concrete versions involved (backend + installed SDK), so a
 *      verdict can be reproduced later?
 *
 * Synthetic data only: no business content, no credentials in the output.
 *
 * Usage:
 *   node --import tsx scripts/langfuse-compat-probe.ts
 *   LANGFUSE_BASE_URL=http://localhost:3000 LANGFUSE_PUBLIC_KEY=pk-... \
 *   LANGFUSE_SECRET_KEY=sk-... node --import tsx scripts/langfuse-compat-probe.ts
 *
 * Env:
 *   LANGFUSE_BASE_URL / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY
 *   PROBE_CHARS   characters per long field (default 4000 ≈ 12 KiB UTF-8)
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createRealLangfuseClient } from "../src/answer/langfuse_client"

const BASE_URL = (process.env.LANGFUSE_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "")
const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY ?? ""
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY ?? ""
const PROBE_CHARS = Number(process.env.PROBE_CHARS ?? 4000)

function installedVersion(packageName: string): string {
  try {
    const path = join(process.cwd(), "node_modules", packageName, "package.json")
    return (JSON.parse(readFileSync(path, "utf8")) as { version?: string }).version ?? "unknown"
  } catch {
    return "not-installed"
  }
}

function authHeader(): string {
  return `Basic ${Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64")}`
}

async function probeOtlpEndpoint(): Promise<{ status: number | string; body: string }> {
  try {
    const response = await fetch(`${BASE_URL}/api/public/otel/v1/traces`, {
      method: "POST",
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ resourceSpans: [] }),
    })
    const body = await response.text()
    return { status: response.status, body: body.slice(0, 300) }
  } catch (error) {
    return { status: "unreachable", body: String(error) }
  }
}

async function probeBackendVersion(): Promise<{ status: number | string; version: string }> {
  try {
    const response = await fetch(`${BASE_URL}/api/public/health`)
    if (!response.ok) return { status: response.status, version: "unknown" }
    const body = (await response.json()) as { version?: string }
    return { status: response.status, version: body.version ?? "unknown" }
  } catch {
    return { status: "unreachable", version: "unknown" }
  }
}

interface ObservationSummary {
  type: unknown
  name: unknown
  model: unknown
  parentObservationId: unknown
  inputBytes: number
  outputBytes: number
}

function bytesOf(value: unknown): number {
  if (value === null || value === undefined) return 0
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8")
}

async function probeWriteAndRead(): Promise<Record<string, unknown>> {
  const traceId = `lo01-compat-${Date.now()}`
  const prompt = "用户长提示：".concat("汉".repeat(PROBE_CHARS))
  const reply = "助手长回复：".concat("字".repeat(PROBE_CHARS))
  const client = createRealLangfuseClient({
    publicKey: PUBLIC_KEY,
    secretKey: SECRET_KEY,
    baseUrl: BASE_URL,
  })
  if (!client) return { error: "no client: keys are missing" }

  const trace = client.trace({
    name: "lo01-synthetic-root",
    id: traceId,
    metadata: { probe: "LO-01", synthetic: true },
    input: { question: "合成问题：父子与内容是否保留？" },
  })
  const stage = trace.span({ name: "stage.retrieval", input: { topK: 2 } })
  const child = stage.span({ name: "stage.retrieval.channel", input: { channel: "lexical" } })
  child.end({ output: { ids: ["synthetic-1", "synthetic-2"] } })
  stage.end({ output: { candidates: 2 } })
  const generation = stage.generation({
    name: "answer",
    model: "probe-chat-model",
    input: [{ role: "user", content: prompt }],
  })
  generation.end({ output: reply, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
  trace.update({ output: { reply: "合成回答" } })

  await client.flushAsync?.()
  await client.shutdownAsync?.()

  const deadline = Date.now() + 30_000
  let status = 0
  let body: Record<string, unknown> | undefined
  while (Date.now() < deadline) {
    const response = await fetch(`${BASE_URL}/api/public/traces/${traceId}`, {
      headers: { Authorization: authHeader() },
    })
    status = response.status
    if (response.ok) {
      body = (await response.json()) as Record<string, unknown>
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  const observations: ObservationSummary[] =
    body && Array.isArray(body["observations"])
      ? (body["observations"] as Array<Record<string, unknown>>).map((observation) => ({
          type: observation["type"],
          name: observation["name"],
          model: observation["model"],
          parentObservationId: observation["parentObservationId"],
          inputBytes: bytesOf(observation["input"]),
          outputBytes: bytesOf(observation["output"]),
        }))
      : []

  const generationObservation = observations.find((observation) => observation.type === "GENERATION")
  return {
    traceId,
    readbackStatus: status,
    found: body !== undefined,
    traceInputPresent: body?.["input"] !== null && body?.["input"] !== undefined,
    traceOutputPresent: body?.["output"] !== null && body?.["output"] !== undefined,
    observations,
    nestedParentLinkPreserved: observations.filter((observation) => observation.parentObservationId).length,
    sentPromptBytes: Buffer.byteLength(prompt, "utf8"),
    receivedPromptBytes: generationObservation?.inputBytes ?? 0,
    sentReplyBytes: Buffer.byteLength(reply, "utf8"),
    receivedReplyBytes: generationObservation?.outputBytes ?? 0,
  }
}

async function main(): Promise<void> {
  if (!PUBLIC_KEY || !SECRET_KEY) {
    process.stderr.write(
      "LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are required (see .env); nothing was sent.\n",
    )
    process.exitCode = 1
    return
  }
  const health = await probeBackendVersion()
  const otlp = await probeOtlpEndpoint()
  const writeRead = await probeWriteAndRead()
  process.stdout.write(
    `${JSON.stringify(
      {
        baseUrl: BASE_URL,
        backend: health,
        versions: {
          langfuseSdk: installedVersion("langfuse"),
          otelApi: installedVersion("@opentelemetry/api"),
          otelSdkTrace: installedVersion("@opentelemetry/sdk-trace-node"),
          otelExporter: installedVersion("@opentelemetry/exporter-trace-otlp-http"),
        },
        otlpIngestion: otlp,
        sdkWriteRead: writeRead,
      },
      null,
      2,
    )}\n`,
  )
}

void main()
