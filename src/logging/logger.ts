/**
 * LO-03: the neutral runtime-logging contract.
 *
 * Business code depends on this file only. It contains no vendor types: the
 * Pino implementation, the backpressure sink and the stdout destination all
 * live behind it (`pino_logger.ts`, `sink.ts`, `composition.ts`), so the
 * adapter can be replaced without touching a single call site.
 *
 * Lifecycle: one `Logger` per process, created by the composition root and
 * injected into `createApp`. A `child()` shares the same sink, counters and
 * lifetime — closing a parent closes every child.
 */

export type LogLevel = "debug" | "info" | "warn" | "error"

/** `off` is a real setting, not a missing logger: it disables emission. */
export type LogLevelSetting = LogLevel | "off"

export type LogFields = Record<string, unknown>

/**
 * Counters an operator can read at shutdown time. `waits` / `totalWaitMs` /
 * `maxWaitMs` are the observable side of stdout backpressure: a non-zero
 * `waits` means the pipe was full and the producer waited for `drain`
 * instead of the logger buffering without bound.
 */
export interface LoggerDiagnostics {
  level: LogLevelSetting
  /** Records accepted by the sink and handed to the destination. */
  written: number
  /** Destination writes that failed (broken pipe, destroyed stream, throw). */
  writeErrors: number
  /** Records that exceeded the per-record byte ceiling and were marked. */
  truncated: number
  /** Sensitive values replaced by `[redacted]` (nested and message text). */
  redacted: number
  /** Number of records that had to wait for a full pipe to drain. */
  waits: number
  totalWaitMs: number
  maxWaitMs: number
  /** Records currently waiting for a full pipe to drain (bounded by callers). */
  pendingWrites: number
  /** Records dropped because the logger was already closed. */
  skippedAfterClose: number
  /** True when `close()` gave up waiting for the pipe within its budget. */
  closeTimedOut: boolean
  closed: boolean
}

export interface Logger {
  readonly level: LogLevelSetting
  debug(event: string, fields?: LogFields): Promise<void>
  info(event: string, fields?: LogFields): Promise<void>
  warn(event: string, fields?: LogFields): Promise<void>
  error(event: string, fields?: LogFields): Promise<void>
  /** Bind correlation fields (requestId, traceId, operation…) once. */
  child(bindings: LogFields): Logger
  /** Resolve once every accepted record reached the destination. */
  flush(): Promise<void>
  /** Flush, then refuse further records. Idempotent. */
  close(): Promise<void>
  diagnostics(): LoggerDiagnostics
}

/**
 * The logger used when no composition-root logger was injected (bare
 * `createApp` mounts, probes, tests). Same contract, zero cost, zero output —
 * so an absent logger can never change business behaviour.
 */
export class SilentLogger implements Logger {
  readonly level: LogLevelSetting = "off"

  debug(_event: string, _fields?: LogFields): Promise<void> {
    return Promise.resolve()
  }

  info(_event: string, _fields?: LogFields): Promise<void> {
    return Promise.resolve()
  }

  warn(_event: string, _fields?: LogFields): Promise<void> {
    return Promise.resolve()
  }

  error(_event: string, _fields?: LogFields): Promise<void> {
    return Promise.resolve()
  }

  child(_bindings: LogFields): Logger {
    return this
  }

  flush(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  diagnostics(): LoggerDiagnostics {
    return {
      level: "off",
      written: 0,
      writeErrors: 0,
      truncated: 0,
      redacted: 0,
      waits: 0,
      totalWaitMs: 0,
      maxWaitMs: 0,
      pendingWrites: 0,
      skippedAfterClose: 0,
      closeTimedOut: false,
      closed: false,
    }
  }
}

/** Shared, mutable diagnostics cell — one per process logger tree. */
export class LogCounters {
  written = 0
  writeErrors = 0
  truncated = 0
  redacted = 0
  waits = 0
  totalWaitMs = 0
  maxWaitMs = 0
  pendingWrites = 0
  skippedAfterClose = 0
  closeTimedOut = false
  closed = false

  snapshot(level: LogLevelSetting): LoggerDiagnostics {
    return {
      level,
      written: this.written,
      writeErrors: this.writeErrors,
      truncated: this.truncated,
      redacted: this.redacted,
      waits: this.waits,
      totalWaitMs: this.totalWaitMs,
      maxWaitMs: this.maxWaitMs,
      pendingWrites: this.pendingWrites,
      skippedAfterClose: this.skippedAfterClose,
      closeTimedOut: this.closeTimedOut,
      closed: this.closed,
    }
  }
}

export function isLogLevel(value: string): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error"
}

/** `off` disables; an unknown or blank value falls back to the default. */
export function parseLogLevel(raw: string | undefined, fallback: LogLevelSetting = "info"): LogLevelSetting {
  const value = (raw ?? "").trim().toLowerCase()
  if (!value) return fallback
  if (value === "off" || value === "silent" || value === "none" || value === "false") return "off"
  return isLogLevel(value) ? value : fallback
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export function levelEnabled(configured: LogLevelSetting, level: LogLevel): boolean {
  if (configured === "off") return false
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[configured]
}
