import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { join, relative } from "node:path"
import test from "node:test"
import type { Express } from "express"
import { createApp } from "./server"
import { openDb, type DB } from "../ingestion/tracking/db"
import { LogCounters, SilentLogger, type Logger } from "../logging/logger"
import { createPinoLogger } from "../logging/pino_logger"
import { BackpressureSink, type LogDestination } from "../logging/sink"
import type { AnswerEventsSource } from "./chat"
import type { AnswerRunEvent } from "../types"

/**
 * LO-03: the end-to-end slice. A REAL JSON business request (knowledge-base
 * create) runs through the REAL Express stack on an isolated SQLite database,
 * with the neutral logger injected at the composition root. Assertions are on
 * what the caller receives and what stdout would carry — never on Pino
 * internals.
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
}

const emptyEventsSource: AnswerEventsSource = async function* () {
  const terminal: AnswerRunEvent = {
    schemaVersion: 1,
    sessionId: "sess-unused",
    runId: "run-unused",
    createdAt: "2026-10-20T00:00:00.000Z",
    status: "completed",
    durationMs: 0,
    attempt: 1,
    round: 0,
    inputSummary: "",
    outputSummary: "",
    type: "done",
    stage: "done",
    eventId: "run-unused:1",
    sequence: 1,
    result: {
      runId: "run-unused",
      status: "completed",
      reply: "unused",
      references: [],
      degradation: { status: "none", unavailableChannels: [] },
    },
  }
  yield terminal
}

function buildLogger(): { logger: Logger; destination: CaptureDestination; counters: LogCounters } {
  const destination = new CaptureDestination()
  const counters = new LogCounters()
  const sink = new BackpressureSink(destination, counters)
  const logger = createPinoLogger({
    level: "info",
    sink,
    counters,
    bindings: { service: "kefu-rag" },
  })
  return { logger, destination, counters }
}

async function listen(app: Express) {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

function knowledgeBaseTables(db: DB): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%knowledge_base%'")
    .all() as Array<{ name: string }>
  return rows.map((row) => row.name)
}

function countRows(db: DB, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
  return row.count
}

test("LO-03-AC01/AC10: a real JSON request emits one structured line and keeps the business result", async () => {
  const db = openDb(":memory:")
  const { logger, destination } = buildLogger()
  const app = createApp({ db, logger, eventsSource: emptyEventsSource })
  const { server, port } = await listen(app)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/knowledge-bases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ops-log-slice", description: "created by the log slice test" }),
    })
    assert.equal(response.status, 201)
    const body = (await response.json()) as { knowledgeBase: { name: string } }
    assert.equal(body.knowledgeBase.name, "ops-log-slice")

    await logger.flush()
    const completed = destination.records().filter((record) => record.event === "http.request.completed")
    assert.equal(completed.length, 1, `expected exactly one terminal record, got ${JSON.stringify(destination.records())}`)
    const record = completed[0]
    assert.equal(record.operation, "knowledge_base.write")
    assert.equal(record.method, "POST")
    assert.equal(record.path, "/api/knowledge-bases")
    assert.equal(record.statusCode, 201)
    assert.equal(record.outcome, "success")
    assert.equal(typeof record.durationMs, "number")
    assert.match(String(record.requestId), /^[0-9a-f-]{36}$/)
    assert.equal(record.service, "kefu-rag")
  } finally {
    server.close()
    db.close()
  }
})

test("LO-03-AC07: authentication headers and request bodies never appear in the log", async () => {
  const db = openDb(":memory:")
  const { logger, destination } = buildLogger()
  const app = createApp({ db, logger, eventsSource: emptyEventsSource })
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
      body: JSON.stringify({ name: "secret-holder", password: secret }),
    })
    assert.equal(response.status, 201)
    await logger.flush()

    const text = destination.lines.join("")
    assert.ok(text.length > 0, "the slice must log something")
    assert.ok(!text.includes(secret), "no credential may appear in the line")
    assert.ok(!text.includes("secret-holder"), "the request body is not logged")
  } finally {
    server.close()
    db.close()
  }
})

test("LO-03-AC10: logging on or off produces the same product rows and response shape", async () => {
  const withLoggerDb = openDb(":memory:")
  const silentDb = openDb(":memory:")
  const { logger } = buildLogger()

  const withLoggerApp = createApp({ db: withLoggerDb, logger, eventsSource: emptyEventsSource })
  const silentApp = createApp({ db: silentDb, logger: new SilentLogger(), eventsSource: emptyEventsSource })
  const first = await listen(withLoggerApp)
  const second = await listen(silentApp)
  try {
    const create = (port: number) =>
      fetch(`http://127.0.0.1:${port}/api/knowledge-bases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "parity", description: "same on both sides" }),
      })

    const logged = await create(first.port)
    const silent = await create(second.port)
    assert.equal(logged.status, silent.status)

    const loggedBody = (await logged.json()) as { knowledgeBase: Record<string, unknown> }
    const silentBody = (await silent.json()) as { knowledgeBase: Record<string, unknown> }
    assert.equal(loggedBody.knowledgeBase.name, silentBody.knowledgeBase.name)
    assert.equal(loggedBody.knowledgeBase.description, silentBody.knowledgeBase.description)
    assert.deepEqual(Object.keys(loggedBody.knowledgeBase).sort(), Object.keys(silentBody.knowledgeBase).sort())

    const tables = knowledgeBaseTables(withLoggerDb)
    assert.ok(tables.length > 0, "the knowledge-base table must exist")
    for (const table of tables) {
      assert.equal(countRows(withLoggerDb, table), countRows(silentDb, table), `${table} row counts must match`)
    }
  } finally {
    first.server.close()
    second.server.close()
    withLoggerDb.close()
    silentDb.close()
  }
})

test("LO-03-AC01: read-only knowledge-base listing stays out of the write slice", async () => {
  const db = openDb(":memory:")
  const { logger, destination } = buildLogger()
  const app = createApp({ db, logger, eventsSource: emptyEventsSource })
  const { server, port } = await listen(app)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/knowledge-bases`)
    assert.equal(response.status, 200)
    await logger.flush()
    assert.equal(
      destination.records().filter((record) => record.event === "http.request.completed").length,
      0,
      "a plain list is not a business operation worth a root record",
    )
  } finally {
    server.close()
    db.close()
  }
})

test("LO-03-AC02: only the adapter imports the vendor — business code stays neutral", () => {
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
      const importsPino = /from\s+"pino"|require\("pino"\)/.test(source)
      if (importsPino && relativePath !== "src/logging/pino_logger.ts") {
        offenders.push(`${relativePath} imports pino`)
      }
    }
  }
  walk(root)
  assert.deepEqual(offenders, [], `vendor log types must stay in the adapter: ${offenders.join(", ")}`)
})

test("LO-03-AC10: an absent logger leaves the request path exactly as before", async () => {
  const db = openDb(":memory:")
  const app = createApp({ db, eventsSource: emptyEventsSource })
  const { server, port } = await listen(app)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/knowledge-bases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "no-logger" }),
    })
    assert.equal(response.status, 201)
  } finally {
    server.close()
    db.close()
  }
})
