/**
 * LO-03: credential redaction, cycle-safe field shaping and the per-record
 * byte ceiling. Neutral: no vendor types, usable by any Logger adapter.
 *
 * Two different jobs live here on purpose:
 *  - redaction is a policy every adapter must inherit (AC07);
 *  - the 8 KiB ceiling is a *runtime-log* rule (AC06) and must never be
 *    reused for trace/Generation content (spec D14).
 */

export const REDACTED = "[redacted]"

/** Per-record ceiling for runtime logs only (spec: 8 KiB final UTF-8 line). */
export const MAX_LOG_LINE_BYTES = 8 * 1024

/**
 * Keys whose value never leaves the process: auth headers, cookies, keys,
 * passwords and private-key configuration. Matched case-insensitively
 * against the whole key so `x-api-key`, `apiKey` and `API_KEY` all hit.
 */
const SENSITIVE_KEY =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|apikey|password|passwd|pwd|secret|client[-_]?secret|secret[-_]?key|private[-_]?key|privatekey|access[-_]?key|accesskey|secretkey|credential|credentials|bearer|token|auth[-_]?token|refresh[-_]?token)$/i

/**
 * Value patterns redacted inside free text (error messages, stack traces,
 * URLs, connection strings): bearer tokens, OpenAI/Langfuse-style keys and
 * `key=value` credential pairs.
 */
const SECRET_TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`],
  [/\b(sk|pk|rk)-(lf-)?[A-Za-z0-9_-]{8,}/gi, REDACTED],
  [/\b(AKIA|ASIA)[A-Z0-9]{12,}/g, REDACTED],
  [
    /\b(api[-_]?key|apikey|password|passwd|secret|token|access[-_]?key|secret[-_]?key|private[-_]?key)\b(\s*[:=]\s*)("[^"]{4,}"|'[^']{4,}'|[^\s,;&"'}]{4,})/gi,
    `$1$2${REDACTED}`,
  ],
]

const MAX_DEPTH = 6
const MAX_ARRAY_ITEMS = 100

export interface SanitizeStats {
  redacted: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Replace credential-looking substrings inside a free-text value. */
export function redactText(text: string): { text: string; redactions: number } {
  let result = text
  let redactions = 0
  for (const [pattern, replacement] of SECRET_TEXT_PATTERNS) {
    // Reset lastIndex for global regexes reused across calls.
    pattern.lastIndex = 0
    result = result.replace(pattern, (...args: unknown[]) => {
      redactions += 1
      if (typeof replacement === "string" && replacement.includes("$1")) {
        return replacement.replace("$1", String(args[1] ?? "")).replace("$2", String(args[2] ?? ""))
      }
      return replacement
    })
  }
  return { text: result, redactions }
}

function describeError(error: Error): Record<string, unknown> {
  const described: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  }
  if (typeof error.stack === "string") described.stack = error.stack
  const cause = (error as { cause?: unknown }).cause
  if (cause !== undefined) described.cause = cause
  const code = (error as { code?: unknown }).code
  if (typeof code === "string" || typeof code === "number") described.code = code
  return described
}

function sanitizeValue(
  value: unknown,
  depth: number,
  stats: SanitizeStats,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "string") {
    const { text, redactions } = redactText(value)
    stats.redacted += redactions
    return text
  }
  if (typeof value !== "object") return value
  if (depth >= MAX_DEPTH) return "[max-depth]"
  const asObject = value as object
  if (seen.has(asObject)) return "[circular]"
  seen.add(asObject)
  try {
    if (value instanceof Error) {
      return sanitizeValue(describeError(value), depth + 1, stats, seen)
    }
    if (value instanceof Date) return value.toISOString()
    if (Buffer.isBuffer(value)) return `[buffer ${value.byteLength}B]`
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) =>
        sanitizeValue(item, depth + 1, stats, seen),
      )
      if (value.length > MAX_ARRAY_ITEMS) items.push(`[${value.length - MAX_ARRAY_ITEMS} more]`)
      return items
    }
    if (isPlainObject(value)) {
      const result: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) {
        if (SENSITIVE_KEY.test(key)) {
          stats.redacted += 1
          result[key] = REDACTED
          continue
        }
        result[key] = sanitizeValue(item, depth + 1, stats, seen)
      }
      return result
    }
    const tag = Object.prototype.toString.call(value)
    return `[${tag.slice(8, -1)}]`
  } finally {
    seen.delete(asObject)
  }
}

/**
 * Deep-shape fields for logging: credentials replaced, cycles marked,
 * errors described, depth/size bounded. Never throws.
 */
export function sanitizeFields(
  fields: Record<string, unknown> | undefined,
  stats: SanitizeStats,
): Record<string, unknown> {
  if (!fields) return {}
  try {
    const sanitized = sanitizeValue(fields, 0, stats, new WeakSet<object>())
    return sanitized !== null && typeof sanitized === "object" && !Array.isArray(sanitized)
      ? (sanitized as Record<string, unknown>)
      : {}
  } catch (error) {
    // A hostile value (throwing getter, revoked proxy) must not cost the
    // record or the caller: fall back to the reason only.
    const reason = error instanceof Error ? error.message : String(error)
    return { sanitizeFailure: reason }
  }
}

/** Keys that carry correlation and must survive truncation. */
const PRESERVED_KEYS = new Set([
  "level",
  "time",
  "event",
  "requestId",
  "request_id",
  "traceId",
  "trace_id",
  "spanId",
  "span_id",
  "operation",
  "status",
  "statusCode",
  "method",
  "path",
  "durationMs",
  "truncated",
  "originalByteLength",
])

const TRUNCATED_VALUE_LIMIT = 256

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

function shrinkValue(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value === "string" && byteLength(value) > TRUNCATED_VALUE_LIMIT) {
    return { value: `[truncated ${byteLength(value)}B]`, changed: true }
  }
  if (Array.isArray(value) && value.length > 8) {
    return {
      value: [...value.slice(0, 8).map((item) => shrinkValue(item).value), `[${value.length - 8} more]`],
      changed: true,
    }
  }
  return { value, changed: false }
}

export interface TruncationResult {
  line: string
  truncated: boolean
  originalByteLength: number
}

/**
 * Enforce the runtime-log byte ceiling on an already-serialized JSON line.
 *
 * Strategy, in order: mark the record and replace oversized string values;
 * then drop the largest non-correlation fields. The output always stays a
 * single valid JSON line and keeps level/time/event plus correlation ids, so
 * a truncated record is still greppable and joinable.
 */
export function enforceMaxLineBytes(line: string, maxBytes = MAX_LOG_LINE_BYTES): TruncationResult {
  const originalByteLength = byteLength(line)
  if (originalByteLength <= maxBytes) {
    return { line, truncated: false, originalByteLength }
  }
  const payload = line.endsWith("\n") ? line.slice(0, -1) : line
  let record: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(payload)
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      record = { event: "log.serialize_failed", level: "warn" }
    } else {
      record = { ...(parsed as Record<string, unknown>) }
    }
  } catch {
    record = { event: "log.serialize_failed", level: "warn" }
  }

  record.truncated = true
  record.originalByteLength = originalByteLength

  const encode = (): string => `${JSON.stringify(record)}\n`
  let current = encode()
  if (byteLength(current) <= maxBytes) {
    return { line: current, truncated: true, originalByteLength }
  }

  // Pass 1: replace oversized values, keep every key.
  for (const [key, value] of Object.entries(record)) {
    if (PRESERVED_KEYS.has(key)) continue
    const shrunk = shrinkValue(value)
    if (shrunk.changed) record[key] = shrunk.value
  }
  current = encode()
  if (byteLength(current) <= maxBytes) {
    return { line: current, truncated: true, originalByteLength }
  }

  // Pass 2: drop the largest non-correlation fields until the line fits.
  const droppable = Object.keys(record)
    .filter((key) => !PRESERVED_KEYS.has(key))
    .sort((a, b) => byteLength(JSON.stringify(record[b] ?? null)) - byteLength(JSON.stringify(record[a] ?? null)))
  for (const key of droppable) {
    record[key] = "[dropped]"
    current = encode()
    if (byteLength(current) <= maxBytes) {
      return { line: current, truncated: true, originalByteLength }
    }
  }

  // Last resort: keep only the correlation skeleton.
  const skeleton: Record<string, unknown> = { level: record.level ?? "warn", event: record.event ?? "log.truncated" }
  for (const key of ["time", "requestId", "request_id", "traceId", "trace_id", "spanId", "span_id", "operation", "status", "method", "path"]) {
    if (record[key] !== undefined) skeleton[key] = record[key]
  }
  skeleton.truncated = true
  skeleton.originalByteLength = originalByteLength
  return { line: `${JSON.stringify(skeleton)}\n`, truncated: true, originalByteLength }
}
