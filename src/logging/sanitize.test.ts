import assert from "node:assert/strict"
import test from "node:test"
import {
  MAX_LOG_LINE_BYTES,
  REDACTED,
  enforceMaxLineBytes,
  redactText,
  sanitizeFields,
  type SanitizeStats,
} from "./sanitize"

function stats(): SanitizeStats {
  return { redacted: 0 }
}

function parse(line: string): Record<string, unknown> {
  return JSON.parse(line.endsWith("\n") ? line.slice(0, -1) : line) as Record<string, unknown>
}

test("LO-03-AC07: nested credential keys and free text are redacted", () => {
  const counter = stats()
  const secret = "sk-live-abcdefgh12345678"
  const sanitized = sanitizeFields(
    {
      headers: { authorization: `Bearer ${secret}`, cookie: "sid=abc", "x-api-key": "k-123456789" },
      config: {
        apiKey: "api-key-value",
        password: "hunter2",
        privateKey: "-----BEGIN PRIVATE KEY-----",
        accessKey: "AKIAABCDEFGHIJKLMNOP",
        database: { user: "ops", password: "db-pass" },
      },
      note: `upstream rejected ${secret}`,
    },
    counter,
  )

  const text = JSON.stringify(sanitized)
  for (const leaked of [secret, "sid=abc", "k-123456789", "api-key-value", "hunter2", "db-pass", "AKIAABCDEFGHIJKLMNOP"]) {
    assert.ok(!text.includes(leaked), `credential must not appear in log fields: ${leaked}`)
  }
  assert.equal((sanitized.headers as Record<string, unknown>).authorization, REDACTED)
  assert.equal(((sanitized.config as Record<string, unknown>).database as Record<string, unknown>).password, REDACTED)
  assert.equal((sanitized.headers as Record<string, unknown>).cookie, REDACTED)
  assert.ok(counter.redacted >= 6, `expected at least 6 redactions, got ${counter.redacted}`)
})

test("LO-03-AC07: errors keep their shape but not their credentials", () => {
  const counter = stats()
  const cause = new Error("openai call failed with Authorization: Bearer abcdefgh12345678")
  const error = new Error("api_key=supersecretvalue rejected", { cause })
  const sanitized = sanitizeFields({ error }, counter)
  const described = sanitized.error as Record<string, unknown>
  assert.equal(described.name, "Error")
  assert.match(String(described.message), /rejected/)
  assert.ok(!String(described.message).includes("supersecretvalue"))
  assert.ok(typeof described.stack === "string")
  const describedCause = described.cause as Record<string, unknown>
  assert.ok(!String(describedCause.message).includes("abcdefgh12345678"))
})

test("LO-03-AC07: redactText covers bearer tokens and key=value pairs", () => {
  const { text, redactions } = redactText("GET https://api.example.com?api_key=abc12345 Bearer tok_9876543210")
  assert.ok(!text.includes("abc12345"))
  assert.ok(!text.includes("tok_9876543210"))
  assert.ok(redactions >= 2)
})

test("LO-03-AC05: circular and over-deep values cannot recurse forever", () => {
  const counter = stats()
  const cycle: Record<string, unknown> = { name: "root" }
  cycle.self = cycle
  const deep: Record<string, unknown> = { level: 0 }
  let cursor = deep
  for (let depth = 1; depth < 12; depth += 1) {
    const child: Record<string, unknown> = { level: depth }
    cursor.next = child
    cursor = child
  }
  const sanitized = sanitizeFields({ cycle, deep }, counter)
  assert.equal((sanitized.cycle as Record<string, unknown>).self, "[circular]")
  assert.match(JSON.stringify(sanitized.deep), /\[max-depth\]/)
})

test("LO-03-AC05: a throwing getter degrades to a named failure instead of throwing", () => {
  const hostile: Record<string, unknown> = {}
  Object.defineProperty(hostile, "boom", {
    enumerable: true,
    get() {
      throw new Error("getter exploded")
    },
  })
  const sanitized = sanitizeFields({ hostile }, stats())
  assert.equal(sanitized.sanitizeFailure, "getter exploded")
})

test("LO-03-AC06: multi-byte oversized records stay valid JSON under 8 KiB with correlation intact", () => {
  const requestId = "req-0123456789abcdef"
  const line = `${JSON.stringify({
    level: "info",
    time: new Date("2026-10-20T10:00:00.000Z").toISOString(),
    event: "http.request.completed",
    requestId,
    operation: "knowledge_base.write",
    statusCode: 201,
    payload: "汉".repeat(6000),
  })}\n`

  const result = enforceMaxLineBytes(line)
  assert.equal(result.truncated, true)
  assert.ok(result.originalByteLength > MAX_LOG_LINE_BYTES)
  assert.ok(Buffer.byteLength(result.line, "utf8") <= MAX_LOG_LINE_BYTES)
  const record = parse(result.line)
  assert.equal(record.requestId, requestId)
  assert.equal(record.event, "http.request.completed")
  assert.equal(record.truncated, true)
  assert.equal(record.originalByteLength, result.originalByteLength)
})

test("LO-03-AC06: truncation keeps the record greppable for arrays and nested objects", () => {
  const line = `${JSON.stringify({
    level: "warn",
    event: "retrieval.preview",
    requestId: "req-array",
    items: Array.from({ length: 40 }, (_, index) => ({ id: `item-${index}`, body: "x".repeat(400) })),
  })}\n`
  const result = enforceMaxLineBytes(line)
  assert.equal(result.truncated, true)
  assert.ok(Buffer.byteLength(result.line, "utf8") <= MAX_LOG_LINE_BYTES)
  const record = parse(result.line)
  assert.equal(record.requestId, "req-array")
  assert.equal(record.level, "warn")
})

test("LO-03-AC06: a record under the ceiling is passed through untouched", () => {
  const line = `${JSON.stringify({ level: "info", event: "ok", requestId: "r1" })}\n`
  const result = enforceMaxLineBytes(line)
  assert.equal(result.truncated, false)
  assert.equal(result.line, line)
})

test("LO-03-AC05: an unparsable oversized payload still yields one valid JSON line", () => {
  const result = enforceMaxLineBytes(`not-json ${"x".repeat(9000)}`)
  assert.equal(result.truncated, true)
  assert.ok(Buffer.byteLength(result.line, "utf8") <= MAX_LOG_LINE_BYTES)
  const record = parse(result.line)
  assert.equal(record.event, "log.serialize_failed")
  assert.equal(record.truncated, true)
})
