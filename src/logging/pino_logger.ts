import pino from "pino"
import {
  LogCounters,
  levelEnabled,
  type LogFields,
  type Logger,
  type LogLevel,
  type LogLevelSetting,
  type LoggerDiagnostics,
} from "./logger"
import { enforceMaxLineBytes, sanitizeFields, type SanitizeStats } from "./sanitize"
import type { LogSink } from "./sink"
import { captureCaller, formatWeKnoraLine, type WeKnoraLine } from "./weknora_text"

/**
 * `json` is the stdout contract (LO-03). `weknora` is the file-only text line
 * format added by LF-01; both paths share level filtering, sanitization,
 * counters and the sink, so only the encoder differs.
 */
export type LogFormat = "json" | "weknora"

/**
 * LO-03: the Pino adapter. This is the only file in the codebase that may
 * import `pino`; business code sees `Logger` from `logger.ts` only.
 *
 * Responsibilities kept here (not in business code):
 *  - one JSON object per line, with level/time/event and bound correlation;
 *  - credential redaction before serialization;
 *  - the 8 KiB runtime-log ceiling (truncation marker + correlation kept);
 *  - delivery through the backpressure sink, so a slow pipe slows producers.
 *
 * Pino is used as the encoder only: a synchronous capture destination hands
 * back the serialized line so the adapter can cap it and hand it to the sink
 * itself. That keeps the vendor out of the delivery path and makes the byte
 * ceiling testable without touching pino internals.
 */

export interface PinoLoggerOptions {
  level: LogLevelSetting
  sink: LogSink
  bindings?: LogFields
  /**
   * Counters cell. Pass the SAME instance the sink was built with so
   * `diagnostics()` reports one coherent picture; when a different cell is
   * supplied, the two are summed.
   */
  counters?: LogCounters
  /** Budget for flush-on-close (default 2000 ms). */
  closeTimeoutMs?: number
  /** Encoder: single-line JSON (stdout) or WeKnora text (files). Default json. */
  format?: LogFormat
}

interface SharedState {
  sink: LogSink
  format: LogFormat
  counters: LogCounters
  sanitize: SanitizeStats
  closePromise?: Promise<void>
  closeTimeoutMs: number
}

export class PinoLogger implements Logger {
  readonly level: LogLevelSetting
  private readonly serializer: pino.Logger | undefined
  private readonly shared: SharedState
  private readonly bindings: LogFields
  private readonly format: LogFormat
  private captured: string[] = []

  constructor(options: PinoLoggerOptions, bindings: LogFields = {}, shared?: SharedState) {
    this.level = options.level
    this.bindings = { ...(options.bindings ?? {}), ...bindings }
    this.format = shared?.format ?? options.format ?? "json"
    this.shared =
      shared ??
      ({
        sink: options.sink,
        format: this.format,
        counters: options.counters ?? options.sink.counters,
        sanitize: { redacted: 0 },
        closeTimeoutMs: options.closeTimeoutMs ?? 2000,
      } satisfies SharedState)
    if (this.format === "json") {
      // Level filtering happens before pino, but pino is configured as well so
      // a stray direct call cannot emit below the configured threshold.
      this.serializer = pino(
        {
          level: this.level === "off" ? "silent" : this.level,
          base: undefined,
          timestamp: pino.stdTimeFunctions.isoTime,
          messageKey: "event",
          formatters: { level: (label) => ({ level: label }) },
          safe: true,
        },
        {
          write: (chunk: string) => {
            this.captured.push(chunk)
          },
        } as unknown as pino.DestinationStream,
      )
    }
  }

  debug(event: string, fields?: LogFields): Promise<void> {
    return this.log("debug", event, fields, this.captureCallerForText())
  }

  info(event: string, fields?: LogFields): Promise<void> {
    return this.log("info", event, fields, this.captureCallerForText())
  }

  warn(event: string, fields?: LogFields): Promise<void> {
    return this.log("warn", event, fields, this.captureCallerForText())
  }

  error(event: string, fields?: LogFields): Promise<void> {
    return this.log("error", event, fields, this.captureCallerForText())
  }

  async log(level: LogLevel, event: string, fields?: LogFields, caller?: string): Promise<void> {
    if (!levelEnabled(this.level, level)) return
    const counters = this.shared.counters
    if (counters.closed) {
      counters.skippedAfterClose += 1
      return
    }
    const merged: LogFields = { ...this.bindings, ...(fields ?? {}) }
    const sanitized = sanitizeFields(merged, this.shared.sanitize)
    counters.redacted = this.shared.sanitize.redacted

    if (this.format === "weknora") {
      let formatted: WeKnoraLine
      try {
        formatted = formatWeKnoraLine({
          level,
          event,
          fields: sanitized,
          caller: caller ?? "",
        })
      } catch (error) {
        // Formatting must never break the caller: emit a minimal honest line.
        const reason = error instanceof Error ? error.message : String(error)
        formatted = formatWeKnoraLine({
          level: "error",
          event: "log.serialize_failed",
          fields: { reason, event_name: event },
          caller: caller ?? "",
        })
      }
      if (formatted.redactions > 0) {
        this.shared.sanitize.redacted += formatted.redactions
        counters.redacted = this.shared.sanitize.redacted
      }
      if (formatted.truncated) counters.truncated += 1
      await this.shared.sink.write(formatted.line)
      return
    }

    let line: string
    try {
      line = this.encode(level, event, sanitized)
    } catch (error) {
      // Serialization must never break the caller: emit a minimal, honest
      // record instead of the unrepresentable payload (AC05).
      const reason = error instanceof Error ? error.message : String(error)
      line = `${JSON.stringify({
        level: "error",
        time: new Date().toISOString(),
        event: "log.serialize_failed",
        originalEvent: event,
        reason,
      })}\n`
    }
    const capped = enforceMaxLineBytes(line)
    if (capped.truncated) counters.truncated += 1
    await this.shared.sink.write(capped.line)
  }

  child(bindings: LogFields): Logger {
    return new PinoLogger(
      { level: this.level, sink: this.shared.sink, counters: this.shared.counters, format: this.format },
      { ...this.bindings, ...bindings },
      this.shared,
    )
  }

  async flush(): Promise<void> {
    await this.shared.sink.flush(this.shared.closeTimeoutMs)
  }

  close(): Promise<void> {
    if (!this.shared.closePromise) {
      this.shared.closePromise = (async () => {
        this.shared.counters.closed = true
        await this.shared.sink.close(this.shared.closeTimeoutMs)
      })()
    }
    return this.shared.closePromise
  }

  diagnostics(): LoggerDiagnostics {
    const base = this.shared.counters.snapshot(this.level)
    const sinkCounters = this.shared.sink.counters
    if (sinkCounters === this.shared.counters) return base
    return {
      ...base,
      written: base.written + sinkCounters.written,
      writeErrors: base.writeErrors + sinkCounters.writeErrors,
      waits: base.waits + sinkCounters.waits,
      totalWaitMs: base.totalWaitMs + sinkCounters.totalWaitMs,
      maxWaitMs: Math.max(base.maxWaitMs, sinkCounters.maxWaitMs),
      pendingWrites: Math.max(base.pendingWrites, sinkCounters.pendingWrites),
      closeTimedOut: base.closeTimedOut || sinkCounters.closeTimedOut,
      closed: base.closed || sinkCounters.closed,
    }
  }

  private captureCallerForText(): string | undefined {
    // Only the text path pays for a stack capture (LF-01-AC06).
    return this.format === "weknora" ? captureCaller() : undefined
  }

  private encode(level: LogLevel, event: string, fields: LogFields): string {
    const serializer = this.serializer
    if (!serializer) throw new Error("json encoder requested without a pino serializer")
    this.captured.length = 0
    serializer[level](fields, event)
    return this.captured.join("")
  }
}

/** Build the process logger over a sink (see `composition.ts`). */
export function createPinoLogger(options: PinoLoggerOptions): Logger {
  return new PinoLogger(options)
}
