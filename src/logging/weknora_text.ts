import type { LogFields, LogLevel } from "./logger"
import { MAX_LOG_LINE_BYTES, redactText } from "./sanitize"

/**
 * LF-01: the WeKnora text line format.
 *
 * One record is one physical line:
 *
 *   LEVEL[YYYY-MM-DD HH:mm:ss.SSS] [field area] caller | message
 *
 * Format rules that consumers depend on (see `.scratch/file-logging-tickets`):
 *  - level is padded to five columns, so `INFO [` has a trailing space while
 *    `WARNING[` does not;
 *  - `requestId` is reserved: it renders as the first bare token of the field
 *    area (value only, no key); every other key is snake_cased and sorted;
 *  - values are unquoted (`%v`), objects are JSON, `undefined` is omitted;
 *  - newlines/tabs become spaces and the remaining control characters are
 *    dropped, so no value can forge a second line;
 *  - the caller (`basename:line[func]`) is captured only on this path and is
 *    left-aligned to twenty columns;
 *  - the final UTF-8 line never exceeds the runtime-log ceiling; oversized
 *    records drop whole fields (and, as a last resort, the message) rather
 *    than cutting a value in half.
 */

export const CALLER_WIDTH = 20
export const CALLER_PLACEHOLDER = "unknown:0"

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
}

/** Internal frames that must never be reported as the caller. */
const INTERNAL_FRAME = /(?:^|[/\\])(?:weknora_text|pino_logger)(?:\.[cm]?[jt]s)?(?:\?|$)/

export interface WeKnoraLineInput {
  level: LogLevel
  /** Message: the neutral `Logger` event name. */
  event: string
  /** Already sanitized (redaction, cycles, depth) fields. */
  fields: LogFields
  caller: string
  now?: Date
  maxBytes?: number
}

export interface WeKnoraLine {
  line: string
  truncated: boolean
  originalByteLength: number
  /** Message redactions performed while formatting (fields are sanitized upstream). */
  redactions: number
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0")
}

/** Local wall-clock time, no timezone suffix (WeKnora default). */
export function formatLocalTimestamp(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${pad(date.getMilliseconds(), 3)}`
  )
}

/** `2026-10-21` in the local timezone. */
export function formatLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** camelCase / PascalCase / kebab-case → snake_case. */
export function toSnakeCase(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase()
}

/**
 * `\n`, `\r` and `\t` become spaces; the remaining ASCII control characters
 * (< 32) are dropped. Guarantees a value cannot start a new physical line.
 */
export function cleanText(text: string): string {
  return text.replace(/[\n\r\t]/g, " ").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
}

/** Cut a string at a valid UTF-8 boundary, never emitting a partial character. */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  const buffer = Buffer.from(text, "utf8")
  if (buffer.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0) {
    const lead = buffer[end - 1]
    if ((lead & 0xc0) === 0x80) {
      // Continuation byte: walk back to the character's lead byte.
      end -= 1
      continue
    }
    const width = lead < 0x80 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : 4
    if (end - 1 + width <= maxBytes) {
      end = end - 1 + width
      break
    }
    end -= 1
  }
  return buffer.subarray(0, end).toString("utf8")
}

function renderValue(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (value === null) return "null"
  if (typeof value === "string") return cleanText(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (typeof value === "bigint") return value.toString()
  try {
    const json = JSON.stringify(value)
    return json === undefined ? undefined : cleanText(json)
  } catch {
    return "[unserializable]"
  }
}

interface FieldToken {
  key: string
  token: string
}

function fieldTokens(fields: LogFields): { requestId: string | undefined; others: FieldToken[] } {
  const requestId = renderValue(fields.requestId) || undefined
  const others: FieldToken[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (key === "requestId") continue
    const rendered = renderValue(value)
    if (rendered === undefined) continue
    const snake = toSnakeCase(key)
    others.push({ key: snake, token: `${snake}=${rendered}` })
  }
  others.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
  return { requestId, others }
}

/**
 * Format one record. Never throws on hostile values: rendering problems turn
 * into a visible marker instead of losing the line.
 */
export function formatWeKnoraLine(input: WeKnoraLineInput): WeKnoraLine {
  const maxBytes = input.maxBytes ?? MAX_LOG_LINE_BYTES
  const header = `${LEVEL_LABELS[input.level].padEnd(5)}[${formatLocalTimestamp(input.now ?? new Date())}] `
  const messageRedaction = redactText(input.event)
  const message = cleanText(messageRedaction.text)
  const caller = input.caller.padEnd(CALLER_WIDTH)
  const { requestId, others } = fieldTokens(input.fields)

  const compose = (keep: number, text: string, marker: boolean): string => {
    const tokens: string[] = []
    if (requestId !== undefined) tokens.push(requestId)
    for (let index = 0; index < keep; index += 1) tokens.push(others[index].token)
    if (marker) tokens.push("truncated=true")
    return `${header}[${tokens.join(" ")}] ${caller} | ${text}\n`
  }

  let line = compose(others.length, message, false)
  const originalByteLength = Buffer.byteLength(line, "utf8")
  if (originalByteLength <= maxBytes) {
    return { line, truncated: false, originalByteLength, redactions: messageRedaction.redactions }
  }

  // Drop whole fields from the end first; level, time and request_id stay.
  for (let keep = others.length - 1; keep >= 0; keep -= 1) {
    line = compose(keep, message, true)
    if (Buffer.byteLength(line, "utf8") <= maxBytes) {
      return { line, truncated: true, originalByteLength, redactions: messageRedaction.redactions }
    }
  }

  // Keep every field that is left; the message absorbs the remaining budget.
  const prefix = compose(0, "", true)
  const budget = maxBytes - Buffer.byteLength(prefix, "utf8")
  if (budget > 0) {
    line = compose(0, truncateToBytes(message, budget), true)
    if (Buffer.byteLength(line, "utf8") <= maxBytes) {
      return { line, truncated: true, originalByteLength, redactions: messageRedaction.redactions }
    }
  }

  // Pathological input (e.g. an 8 KiB request id): cut at a character boundary
  // so the ceiling still holds.
  const body = compose(0, "", true).slice(0, -1)
  line = `${truncateToBytes(body, maxBytes - 1)}\n`
  return { line, truncated: true, originalByteLength, redactions: messageRedaction.redactions }
}

interface StackFrame {
  file: string
  line: number
  func: string
}

function parseFrame(frame: string): StackFrame | undefined {
  const withName = /^(.+?) \((.+):(\d+):(\d+)\)$/.exec(frame)
  if (withName) {
    return {
      func: shortFunctionName(withName[1]),
      file: withName[2],
      line: Number(withName[3]),
    }
  }
  const bare = /^(.+):(\d+):(\d+)$/.exec(frame)
  if (bare) {
    return { func: "anonymous", file: bare[1], line: Number(bare[2]) }
  }
  return undefined
}

function shortFunctionName(raw: string): string {
  const name = raw.replace(/^async\s+/, "").replace(/^new\s+/, "")
  if (!name) return "anonymous"
  const last = name.split(".").pop()
  return last && last.length > 0 ? last : "anonymous"
}

function basename(file: string): string {
  return file.replace(/^.*[\\/]/, "")
}

/**
 * Capture the first stack frame outside the logging adapter. Called only by
 * the text path — the JSON path never pays for a stack capture.
 */
export function captureCaller(): string {
  const stack = new Error().stack
  if (!stack) return CALLER_PLACEHOLDER
  for (const rawLine of stack.split("\n")) {
    const trimmed = rawLine.trim()
    if (!trimmed.startsWith("at ")) continue
    const frame = parseFrame(trimmed.slice(3))
    if (!frame) continue
    if (frame.file.startsWith("node:")) continue
    if (INTERNAL_FRAME.test(frame.file)) continue
    return `${basename(frame.file)}:${frame.line}[${frame.func}]`
  }
  return CALLER_PLACEHOLDER
}
