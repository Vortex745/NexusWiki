import { LogCounters, SilentLogger, parseLogLevel, type Logger, type LogLevelSetting } from "./logger"
import { createPinoLogger } from "./pino_logger"
import { BackpressureSink, type LogDestination, type LogSink } from "./sink"

/**
 * LO-03: the composition root for runtime logging.
 *
 * `LOG_LEVEL` is the single switch: `off` returns a silent logger (rollback /
 * disable without touching code), `debug|info|warn|error` enable structured
 * JSON on stdout. Nothing else in the process builds a sink or a Pino
 * instance, so there is exactly one owner of the stdout pipeline and exactly
 * one place to replace it.
 */

export interface ServerLoggerOptions {
  /** Test/probe seam: deliver to this destination instead of process.stdout. */
  destination?: LogDestination
  service?: string
  bindings?: Record<string, unknown>
  closeTimeoutMs?: number
}

export function createServerLogger(
  env: NodeJS.ProcessEnv = process.env,
  options: ServerLoggerOptions = {},
): Logger {
  const level: LogLevelSetting = parseLogLevel(env.LOG_LEVEL, "info")
  if (level === "off") return new SilentLogger()
  const counters = new LogCounters()
  const sink: LogSink = new BackpressureSink(
    options.destination ?? (process.stdout as unknown as LogDestination),
    counters,
    options.closeTimeoutMs !== undefined ? { closeTimeoutMs: options.closeTimeoutMs } : {},
  )
  return createPinoLogger({
    level,
    sink,
    counters,
    ...(options.closeTimeoutMs !== undefined ? { closeTimeoutMs: options.closeTimeoutMs } : {}),
    bindings: {
      service: options.service ?? "kefu-rag",
      pid: process.pid,
      ...(options.bindings ?? {}),
    },
  })
}
