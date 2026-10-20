import assert from "node:assert/strict"
import test from "node:test"
import { LogCounters } from "./logger"
import { createPinoLogger } from "./pino_logger"
import { REDACTED } from "./sanitize"
import { BackpressureSink, type LogDestination } from "./sink"

class CaptureDestination implements LogDestination {
  readonly lines: string[] = []
  write(chunk: string): boolean {
    this.lines.push(chunk)
    return true
  }
}

function harness(level: "debug" | "info" | "warn" | "error" | "off" = "info") {
  const destination = new CaptureDestination()
  const counters = new LogCounters()
  const sink = new BackpressureSink(destination, counters)
  const logger = createPinoLogger({ level, sink, counters, bindings: { service: "kefu-rag" } })
  return { destination, counters, sink, logger }
}

function records(destination: CaptureDestination): Array<Record<string, unknown>> {
  return destination.lines.map((line) => JSON.parse(line) as Record<string, unknown>)
}

test("LO-03-AC01: one parseable JSON line with level, time, event and correlation fields", async () => {
  const { destination, logger, counters } = harness()
  await logger.info("http.request.completed", {
    requestId: "req-1",
    operation: "knowledge_base.write",
    statusCode: 201,
    durationMs: 12.5,
  })
  await logger.flush()

  assert.equal(destination.lines.length, 1)
  const line = destination.lines[0]
  assert.ok(line.endsWith("\n"), "one record per line")
  const record = JSON.parse(line) as Record<string, unknown>
  assert.equal(record.level, "info")
  assert.equal(record.event, "http.request.completed")
  assert.equal(record.requestId, "req-1")
  assert.equal(record.service, "kefu-rag")
  assert.equal(record.statusCode, 201)
  assert.equal(record.durationMs, 12.5)
  assert.equal(typeof record.time, "string")
  assert.ok(!Number.isNaN(Date.parse(String(record.time))), "time must be an ISO timestamp")
  assert.equal(record.pid, undefined, "no ambient pid noise on every record")
  assert.equal(counters.written, 1)
})

test("LO-03-AC01: child bindings carry correlation without repeating call sites", async () => {
  const { destination, logger } = harness()
  const requestLogger = logger.child({ requestId: "req-2", operation: "knowledge_base.write" })
  await requestLogger.info("operation.started")
  await requestLogger.warn("operation.slow", { durationMs: 900 })
  await logger.flush()

  const parsed = records(destination)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].requestId, "req-2")
  assert.equal(parsed[1].operation, "knowledge_base.write")
  assert.equal(parsed[1].level, "warn")
})

test("LO-03-AC07: credentials never reach the serialized line", async () => {
  const { destination, logger } = harness()
  const secret = "sk-live-abcdefgh12345678"
  await logger.info("request.rejected", {
    headers: { authorization: `Bearer ${secret}`, cookie: "sid=abcdef" },
    config: { password: "hunter2" },
    note: `rejected ${secret}`,
  })
  await logger.flush()

  const line = destination.lines.join("")
  assert.ok(!line.includes(secret))
  assert.ok(!line.includes("hunter2"))
  assert.ok(!line.includes("sid=abcdef"))
  assert.ok(line.includes(REDACTED))
  assert.equal(JSON.parse(destination.lines[0]).event, "request.rejected")
})

test("LO-03-AC06: oversized records are capped with a visible marker and keep correlation", async () => {
  const { destination, logger, counters } = harness()
  await logger.info("retrieval.preview", {
    requestId: "req-big",
    matches: "汉".repeat(5000),
  })
  await logger.flush()

  const line = destination.lines[0]
  assert.ok(Buffer.byteLength(line, "utf8") <= 8 * 1024, `line is ${Buffer.byteLength(line, "utf8")} bytes`)
  const record = JSON.parse(line) as Record<string, unknown>
  assert.equal(record.truncated, true)
  assert.equal(record.requestId, "req-big")
  assert.equal(counters.truncated, 1)
})

test("LO-03-AC08: the configured level filters, and off emits nothing", async () => {
  const warnOnly = harness("warn")
  await warnOnly.logger.info("ignored")
  await warnOnly.logger.warn("kept")
  await warnOnly.logger.flush()
  assert.deepEqual(records(warnOnly.destination).map((record) => record.event), ["kept"])

  const off = harness("off")
  await off.logger.info("nothing")
  await off.logger.flush()
  assert.equal(off.destination.lines.length, 0)
})

test("LO-03-AC09: close is idempotent and later records are counted, not written", async () => {
  const { destination, logger, counters } = harness()
  await logger.info("before-close")
  const first = logger.close()
  const second = logger.close()
  assert.equal(first, second)
  await first
  await logger.info("after-close")

  assert.equal(counters.skippedAfterClose, 1)
  assert.deepEqual(records(destination).map((record) => record.event), ["before-close"])
  assert.equal(logger.diagnostics().closed, true)
})
