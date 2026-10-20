/**
 * LO-20-AC01: every mounted route, one minimal request, one expectation.
 *
 * The inventory frozen by LO-02 lists 113 handlers and says which of them are
 * in the tracing whitelist. This driver replays that list against a REAL
 * Express app: whitelisted operations must answer with `x-trace-id`, excluded
 * surfaces (health, polling, plain reads, auth, config) must not.
 *
 * It asserts the TRANSPORT decision only. A 4xx body is fine — the root is
 * opened before the handler runs, so business validation cannot mask it.
 *
 * Run: node --import tsx scripts/lo20-route-matrix.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { ExportResultCode } from "@opentelemetry/core"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"
import { createApp } from "../src/api/server"
import { openDb } from "../src/ingestion/tracking/db"
import { OtelTracingRuntime } from "../src/tracing/otel_runtime"
import { SilentLogger } from "../src/logging/logger"
import type { AnswerEventsSource } from "../src/api/chat"
import type { AnswerRunEvent } from "../src/types"

interface RouteRow {
  n: number
  method: string
  path: string
  expectRoot: boolean
  ticket: string
}

class NullExporter implements SpanExporter {
  export(_spans: readonly ReadableSpan[], done: (result: { code: ExportResultCode }) => void): void {
    done({ code: ExportResultCode.SUCCESS })
  }
  async shutdown(): Promise<void> {}
}

const terminal = (runId: string): AnswerRunEvent => ({
  schemaVersion: 1,
  sessionId: "route-matrix",
  runId,
  createdAt: new Date(0).toISOString(),
  status: "completed",
  durationMs: 1,
  attempt: 1,
  round: 0,
  inputSummary: "",
  outputSummary: "",
  type: "done",
  stage: "done",
  eventId: `${runId}:1`,
  sequence: 1,
  result: {
    runId,
    status: "completed",
    reply: "probe",
    references: [],
    degradation: { status: "none", unavailableChannels: [] },
  },
})

const eventsSource: AnswerEventsSource = async function* (_message, options) {
  yield terminal(options.runId ?? "route-matrix-run")
}

interface Outcome {
  n: number
  method: string
  path: string
  expectRoot: boolean
  status: number | null
  hasTrace: boolean | null
  ms: number
  note?: string
}

function bodyFor(route: RouteRow): { body?: BodyInit; contentType?: string } {
  if (route.method === "GET" || route.method === "DELETE") return {}
  if (route.path === "/api/ingest/file") {
    return { body: Buffer.from(""), contentType: "application/octet-stream" }
  }
  if (route.path === "/api/chat") {
    return { body: JSON.stringify({ message: "route matrix probe", stream: false }), contentType: "application/json" }
  }
  return { body: JSON.stringify({}), contentType: "application/json" }
}

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync("scripts/route-matrix.json", "utf8")) as { routes: RouteRow[] }
  const routes = manifest.routes

  // A dead provider endpoint keeps every probe local and instant: no route may
  // wait on a real model just to prove a span header exists.
  const temp = mkdtempSync(join(tmpdir(), "lo20-route-matrix-"))
  process.env.SQLITE_PATH = join(temp, "ingestion.db")
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:9/v1"
  process.env.EMBEDDING_BASE_URL = "http://127.0.0.1:9/v1"
  process.env.RERANK_BASE_URL = "http://127.0.0.1:9/v1"

  const db = openDb()
  const runtime = new OtelTracingRuntime({ sampleRate: 1, exporter: new NullExporter() })
  const app = createApp({ db, logger: new SilentLogger(), tracing: runtime, eventsSource })
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const port = (server.address() as AddressInfo).port

  const outcomes: Outcome[] = []
  try {
    for (const route of routes) {
      const path = route.path.replace(/:[A-Za-z0-9_]+/g, "probe-id")
      const url = `http://127.0.0.1:${port}${path}`
      const prepared = bodyFor(route)
      const started = Date.now()
      try {
        const response = await fetch(url, {
          method: route.method,
          headers: prepared.contentType ? { "Content-Type": prepared.contentType } : undefined,
          body: prepared.body,
          signal: AbortSignal.timeout(8_000),
        })
        outcomes.push({
          n: route.n,
          method: route.method,
          path: route.path,
          expectRoot: route.expectRoot,
          status: response.status,
          hasTrace: response.headers.get("x-trace-id") !== null,
          ms: Date.now() - started,
        })
      } catch (error) {
        outcomes.push({
          n: route.n,
          method: route.method,
          path: route.path,
          expectRoot: route.expectRoot,
          status: null,
          hasTrace: null,
          ms: Date.now() - started,
          note: error instanceof Error ? error.message.slice(0, 80) : String(error),
        })
      }
    }
  } finally {
    server.close()
    db.close()
    await runtime.shutdown(500)
  }

  const mismatches = outcomes.filter(
    (outcome) => outcome.hasTrace !== null && outcome.hasTrace !== outcome.expectRoot,
  )
  const unknown = outcomes.filter((outcome) => outcome.hasTrace === null)
  const report = {
    generatedAt: new Date().toISOString(),
    total: outcomes.length,
    whitelisted: outcomes.filter((outcome) => outcome.expectRoot).length,
    excluded: outcomes.filter((outcome) => !outcome.expectRoot).length,
    mismatches: mismatches.length,
    unknown: unknown.length,
    outcomes,
  }
  mkdirSync(join(process.cwd(), ".scratch"), { recursive: true })
  writeFileSync(join(process.cwd(), ".scratch", "lo20-route-matrix.json"), JSON.stringify(report, null, 2), "utf8")

  for (const outcome of outcomes) {
    const mark = outcome.hasTrace === null ? "??" : outcome.hasTrace === outcome.expectRoot ? "ok" : "FAIL"
    if (mark !== "ok") {
      console.log(
        `${mark}  #${outcome.n} ${outcome.method} ${outcome.path} -> ${outcome.status ?? "error"} ` +
          `trace=${String(outcome.hasTrace)} expected=${outcome.expectRoot} ${outcome.note ?? ""}`,
      )
    }
  }
  console.log(
    `routes=${report.total} whitelisted=${report.whitelisted} excluded=${report.excluded} ` +
      `mismatches=${report.mismatches} unknown=${report.unknown}`,
  )
  if (mismatches.length > 0 || unknown.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error("route matrix failed:", error)
  process.exitCode = 1
})
