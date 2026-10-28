import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { join, relative } from "node:path"
import test from "node:test"
import type { Express } from "express"
import { createApp } from "./server"
import { openDb } from "../ingestion/tracking/db"
import { LogCounters, SilentLogger, type Logger } from "../logging/logger"
import { createPinoLogger } from "../logging/pino_logger"
import { currentHttpLogContext } from "../logging/http_lifecycle"
import { BackpressureSink, type LogDestination } from "../logging/sink"
import type { AnswerEventsSource } from "./chat"
import type { AnswerRunEvent } from "../types"

/**
 * LO-04: HTTP correlation and exactly one terminal record.
 *
 * Everything runs through the real Express stack and the real chat transport
 * on an isolated SQLite database. The answer runner is a replayable stub
 * (models/external services are fixtures per the spec's test boundary), but
 * the HTTP layer, the SSE encoding, the abort path and the product rows are
 * the production ones.
 */

class CaptureDestination implements LogDestination {
  readonly lines: string[] = []
  write(chunk: string): boolean {
    this.lines.push(chunk)
    return true
  }
  records(): Array<Record<string, unknown>> {
    return this.lines.map((line) => JSON.parse(line) as Record<string, unknown>)
  }
  terminals(): Array<Record<string, unknown>> {
    return this.records().filter((record) => record.event === "http.request.completed")
  }
}

function buildLogger(level: "info" | "off" = "info") {
  const destination = new CaptureDestination()
  const counters = new LogCounters()
  const sink = new BackpressureSink(destination, counters)
  const logger: Logger =
    level === "off"
      ? new SilentLogger()
      : createPinoLogger({ level, sink, counters, bindings: { service: "kefu-rag" } })
  return { logger, destination, counters }
}

async function listen(app: Express) {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

function terminalEvent(runId: string, sessionId: string, reply: string): AnswerRunEvent {
  return {
    schemaVersion: 1,
    sessionId,
    runId,
    createdAt: "2026-10-20T00:00:00.000Z",
    status: "completed",
    durationMs: 5,
    attempt: 1,
    round: 0,
    inputSummary: "",
    outputSummary: "",
    type: "done",
    stage: "done",
    eventId: `${runId}:done`,
    sequence: 2,
    result: {
      runId,
      status: "completed",
      reply,
      references: [],
      degradation: { status: "none", unavailableChannels: [] },
    },
  }
}

function progressEvent(runId: string, sessionId: string): AnswerRunEvent {
  return {
    schemaVersion: 1,
    sessionId,
    runId,
    createdAt: "2026-10-20T00:00:00.000Z",
    status: "running",
    durationMs: null,
    attempt: 1,
    round: 0,
    inputSummary: "",
    outputSummary: "",
    type: "progress",
    stage: "route",
    message: "routing",
    data: {},
    eventId: `${runId}:1`,
    sequence: 1,
  }
}

/** A replayable runner that records the request context its business code sees. */
function recordingSource(seen: Array<string | undefined>): AnswerEventsSource {
  return async function* (message: string, options) {
    seen.push(currentHttpLogContext()?.requestId)
    // Yield one progress frame so the client receives bytes before the end.
    await Promise.resolve()
    seen.push(currentHttpLogContext()?.requestId)
    yield progressEvent(options.runId ?? "run-http", options.sessionId ?? "sess-http")
    yield terminalEvent(options.runId ?? "run-http", options.sessionId ?? "sess-http", `echo:${message}`)
  }
}

function hangingSource(): AnswerEventsSource {
  return async function* () {
    await new Promise<void>(() => {
      // Never resolves and ignores abort: only the request timeout can end it.
    })
    yield progressEvent("run-hang", "sess-hang")
  }
}

async function createKnowledgeBase(port: number) {
  return fetch(`http://127.0.0.1:${port}/api/knowledge-bases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "lifecycle" }),
  })
}

test("LO-04-AC01/AC02: a JSON success emits exactly one terminal record and echoes its request id", async () => {
  const db = openDb(":memory:")
  const { logger, destination } = buildLogger()
  const app = createApp({ db, logger, eventsSource: recordingSource([]) })
  const { server, port } = await listen(app)
  try {
    const response = await createKnowledgeBase(port)
    assert.equal(response.status, 201)
    const headerRequestId = response.headers.get("x-request-id")
    assert.ok(headerRequestId, "every request carries a correlation id")
    await logger.flush()

    const terminals = destination.terminals()
    assert.equal(terminals.length, 1, `exactly one terminal, got ${JSON.stringify(destination.records())}`)
    const record = terminals[0]
    assert.equal(record.requestId, headerRequestId)
    assert.equal(record.operation, "knowledge_base.manage")
    assert.equal(record.method, "POST")
    assert.equal(record.path, "/api/knowledge-bases")
    assert.equal(record.statusCode, 201)
    assert.equal(record.outcome, "success")
    assert.equal(record.terminalReason, "finish")
    assert.equal(typeof record.durationMs, "number")
  } finally {
    server.close()
    db.close()
  }
})

test("LO-04-AC02: a rejected request and a server failure are classified differently", async () => {
  const db = openDb(":memory:")
  const { logger, destination } = buildLogger()
  const app = createApp({ db, logger, eventsSource: recordingSource([]) })
  // A route that answers 5xx, mounted on top of the app's own stack: the
  // lifecycle middleware still records the terminal.
  app.get("/api/test-failure", (_req, res) => {
    res.status(500).json({ error: "forced failure" })
  })
  const { server, port } = await listen(app)
  try {
    const rejected = await fetch(`http://127.0.0.1:${port}/api/knowledge-bases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "no name" }),
    })
    assert.equal(rejected.status, 400)

    const failed = await fetch(`http://127.0.0.1:${port}/api/test-failure`)
    assert.ok(failed.status >= 500, `expected a server failure, got ${failed.status}`)

    await logger.flush()
    const terminals = destination.terminals()
    assert.equal(terminals.length, 2)
    const rejectedRecord = terminals.find((record) => record.path === "/api/knowledge-bases")
    const failedRecord = terminals.find((record) => record.path === "/api/test-failure")
    assert.equal(rejectedRecord?.outcome, "rejected")
    assert.equal(rejectedRecord?.level, "warn")
    assert.equal(failedRecord?.outcome, "error")
    assert.equal(failedRecord?.level, "error")
    assert.equal(failedRecord?.statusCode, failed.status)
  } finally {
    server.close()
    db.close()
  }
})

test("LO-04-AC02/AC03: an abandoned SSE stream yields one client_closed record, never a fake success", async () => {
  const db = openDb(":memory:")
  const { logger, destination } = buildLogger()
  const source: AnswerEventsSource = async function* (_message, options) {
    yield progressEvent(options.runId ?? "run-abort", options.sessionId ?? "sess-http")
    await new Promise<void>((resolve) => {
      options.signal?.addEventListener("abort", () => resolve(), { once: true })
    })
    yield terminalEvent(options.runId ?? "run-abort", options.sessionId ?? "sess-http", "never delivered")
  }
  const app = createApp({ db, logger, eventsSource: source })
  const { server, port } = await listen(app)
  const controller = new AbortController()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello", stream: true, sessionId: "sess-abort" }),
      signal: controller.signal,
    })
    assert.equal(response.status, 200)
    const reader = response.body?.getReader()
    assert.ok(reader)
    await reader.read()
    controller.abort()
    await reader.read().catch(() => undefined)

    await new Promise((resolve) => setTimeout(resolve, 100))
    await logger.flush()

    const terminals = destination.terminals()
    assert.equal(terminals.length, 1, `one terminal per request, got ${JSON.stringify(terminals)}`)
    assert.equal(terminals[0].outcome, "client_closed")
    assert.equal(terminals[0].terminalReason, "close")
    assert.equal(terminals[0].level, "warn")
    assert.equal(terminals[0].path, "/api/chat")
  } finally {
    server.close()
    db.close()
  }
})

test("LO-04-AC01: nested async business steps inherit the request correlation", async () => {
  const db = openDb(":memory:")
  const { logger, destination } = buildLogger()
  const seen: Array<string | undefined> = []
  const app = createApp({ db, logger, eventsSource: recordingSource(seen) })
  const { server, port } = await listen(app)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "correlate", stream: false, sessionId: "sess-ctx" }),
    })
    assert.equal(response.status, 200)
    await logger.flush()

    const terminals = destination.terminals()
    assert.equal(terminals.length, 1)
    assert.ok(seen.length >= 2, "the runner ran at least twice")
    assert.deepEqual([...new Set(seen)], [terminals[0].requestId], "every nested step saw the same request id")
  } finally {
    server.close()
    db.close()
  }
})

test("LO-04-AC04: concurrent requests never share a correlation id", async () => {
  const db = openDb(":memory:")
  const { logger, destination } = buildLogger()
  const app = createApp({ db, logger, eventsSource: recordingSource([]) })
  const { server, port } = await listen(app)
  try {
    await Promise.all([
      createKnowledgeBase(port),
      fetch(`http://127.0.0.1:${port}/api/knowledge-bases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "second" }),
      }),
      fetch(`http://127.0.0.1:${port}/api/knowledge-bases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "third" }),
      }),
    ])
    await logger.flush()

    const terminals = destination.terminals()
    assert.equal(terminals.length, 3)
    const ids = new Set(terminals.map((record) => record.requestId))
    assert.equal(ids.size, 3, "each request owns its id")
    const operations = terminals.map((record) => record.operation).sort()
    assert.deepEqual(operations, [
      "knowledge_base.manage",
      "knowledge_base.manage",
      "knowledge_base.manage",
    ])
  } finally {
    server.close()
    db.close()
  }
})

test("LO-04-AC05/AC06: request_id is not a trace id and inbound headers cannot set it", async () => {
  const db = openDb(":memory:")
  const { logger, destination } = buildLogger()
  const app = createApp({ db, logger, eventsSource: recordingSource([]) })
  const { server, port } = await listen(app)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/knowledge-bases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-request-id": "attacker-supplied-id",
        "x-tenant-id": "attacker-tenant",
        "x-knowledge-base-ids": "kb-attacker",
        Authorization: "Bearer attacker-token-123456",
      },
      body: JSON.stringify({ name: "header-safety" }),
    })
    assert.equal(response.status, 201)
    await logger.flush()

    const terminals = destination.terminals()
    const record = terminals[0]
    assert.notEqual(record.requestId, "attacker-supplied-id", "an inbound id must not be trusted")
    assert.equal(record.traceId, undefined, "no trace id is fabricated when tracing is off")
    assert.equal(record.spanId, undefined)
    assert.match(String(record.requestId), /^[0-9a-f]{8}-[0-9a-f]{4}-/, "a UUID, not a W3C trace id")
    assert.ok(!JSON.stringify(record).includes("attacker"), "no inbound identity leaks into the record")

    const tenant = db
      .prepare("SELECT tenant_id FROM knowledge_bases ORDER BY rowid DESC LIMIT 1")
      .get() as { tenant_id: string }
    assert.equal(tenant.tenant_id, "default", "the tenant still comes from the server-side context")
  } finally {
    server.close()
    db.close()
  }
})

test("LO-04-AC07: credentials and bodies stay out of the terminal record", async () => {
  const db = openDb(":memory:")
  const { logger, destination } = buildLogger()
  const app = createApp({ db, logger, eventsSource: recordingSource([]) })
  const { server, port } = await listen(app)
  const secret = "sk-live-zyxwvut987654321"
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/knowledge-bases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
        Cookie: `session=${secret}`,
      },
      body: JSON.stringify({ name: secret, password: secret }),
    })
    assert.equal(response.status, 201)
    await logger.flush()

    const text = destination.lines.join("")
    assert.ok(text.length > 0)
    assert.ok(!text.includes(secret), "no credential or body content in the log")
  } finally {
    server.close()
    db.close()
  }
})

test("LO-04-AC02: an idle request is classified as timeout exactly once", async () => {
  const db = openDb(":memory:")
  const { logger, destination } = buildLogger()
  const app = createApp({
    db,
    logger,
    eventsSource: hangingSource(),
    httpLog: { idleTimeoutMs: 80 },
  })
  const { server, port } = await listen(app)
  try {
    await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hang", stream: true, sessionId: "sess-timeout" }),
    }).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 150))
    await logger.flush()

    const terminals = destination.terminals()
    assert.equal(terminals.length, 1, `one terminal on timeout, got ${JSON.stringify(terminals)}`)
    assert.equal(terminals[0].outcome, "timeout")
    assert.equal(terminals[0].terminalReason, "timeout")
    assert.equal(terminals[0].level, "error")
  } finally {
    server.close()
    db.close()
  }
})

test("LO-04-AC09: with logging off, the same product result is produced and nothing is written", async () => {
  const silentDb = openDb(":memory:")
  const loggedDb = openDb(":memory:")
  const { logger, destination } = buildLogger()
  const silentApp = createApp({ db: silentDb, logger: new SilentLogger(), eventsSource: recordingSource([]) })
  const loggedApp = createApp({ db: loggedDb, logger, eventsSource: recordingSource([]) })
  const silent = await listen(silentApp)
  const logged = await listen(loggedApp)
  try {
    const silentResponse = await createKnowledgeBase(silent.port)
    const loggedResponse = await createKnowledgeBase(logged.port)
    assert.equal(silentResponse.status, loggedResponse.status)
    const silentBody = (await silentResponse.json()) as { knowledgeBase: Record<string, unknown> }
    const loggedBody = (await loggedResponse.json()) as { knowledgeBase: Record<string, unknown> }
    assert.deepEqual(Object.keys(silentBody.knowledgeBase).sort(), Object.keys(loggedBody.knowledgeBase).sort())
    assert.equal(silentBody.knowledgeBase.name, loggedBody.knowledgeBase.name)

    await logger.flush()
    assert.ok(destination.terminals().length >= 1)
    const silentRows = silentDb.prepare("SELECT COUNT(*) AS count FROM knowledge_bases").get() as { count: number }
    const loggedRows = loggedDb.prepare("SELECT COUNT(*) AS count FROM knowledge_bases").get() as { count: number }
    assert.equal(silentRows.count, loggedRows.count)
  } finally {
    silent.server.close()
    logged.server.close()
    silentDb.close()
    loggedDb.close()
  }
})

test("LO-04-AC01: excluded surfaces still get an id but no terminal record", async () => {
  const db = openDb(":memory:")
  const { logger, destination } = buildLogger()
  const app = createApp({ db, logger, eventsSource: recordingSource([]) })
  const { server, port } = await listen(app)
  try {
    const list = await fetch(`http://127.0.0.1:${port}/api/knowledge-bases`)
    assert.equal(list.status, 200)
    assert.ok(list.headers.get("x-request-id"), "a polling/read request is still correlatable")
    const status = await fetch(`http://127.0.0.1:${port}/api/status`).catch(() => undefined)
    assert.ok(status === undefined || status.status < 500)
    await logger.flush()
    assert.equal(destination.terminals().length, 0, "reads, polling and status produce no terminal record")
  } finally {
    server.close()
    db.close()
  }
})

test("LO-03-AC02: only the adapter imports the logging vendor", () => {
  const root = join(process.cwd(), "src")
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) {
        walk(path)
        continue
      }
      if (!path.endsWith(".ts")) continue
      const relativePath = relative(process.cwd(), path).replace(/\\/g, "/")
      const source = readFileSync(path, "utf8")
      if ((/from\s+"pino"|require\("pino"\)/.test(source)) && relativePath !== "src/logging/pino_logger.ts") {
        offenders.push(relativePath)
      }
    }
  }
  walk(root)
  assert.deepEqual(offenders, [])
})

