import { LogCounters, SilentLogger, parseLogLevel, type Logger, type LogLevelSetting } from "./logger"
import { createPinoLogger, type LogFormat } from "./pino_logger"
import { BackpressureSink, type LogDestination, type LogSink } from "./sink"
import { RotatingFileDestination, resolveLogDir } from "./file_destination"
import { TeeLogger } from "./tee_logger"

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

/**
 * LF-03: process-wide logging as a single composition root.
 *
 * stdout keeps its existing contract: one JSON object per line, same levels,
 * same redaction and byte ceiling. `LOG_FILE` (default on) adds two daily text
 * files using the WeKnora format: `system-YYYY-MM-DD.log` receives the same
 * records as stdout, `agent-YYYY-MM-DD.log` receives Agent run metadata only.
 * `LOG_LEVEL=off` silences stdout and both files.
 *
 * This is the only place that builds sinks, encoders and file streams; callers
 * receive the neutral `Logger` contract and never see Pino or `node:fs`.
 */
export type LogFileSetting = "on" | "off"

/** Only an explicit `off` disables file output; blank or unknown keeps the default. */
export function parseLogFileSetting(raw: string | undefined): LogFileSetting {
  return (raw ?? "").trim().toLowerCase() === "off" ? "off" : "on"
}

export interface ProcessLoggers {
  /** JSON stdout plus the system text file. */
  system: Logger
  /** Agent run metadata file only; silent when files are disabled. */
  agent: Logger
  /** Flush both logs, close the file streams, then refuse further records. */
  close(): Promise<void>
}

export interface ProcessLoggerOptions {
  /** Test/probe seam: deliver to this destination instead of process.stdout. */
  destination?: LogDestination
  service?: string
  bindings?: Record<string, unknown>
  closeTimeoutMs?: number
  /** Test seam: wall clock used for rotation, naming and retention. */
  now?: () => Date
  /** Test seam: first file-delivery failure reporter. */
  onFileFailure?: (error: unknown) => void
  /** Retention window in days, today included (default 7). */
  retentionDays?: number
}

export function createProcessLoggers(
  env: NodeJS.ProcessEnv = process.env,
  options: ProcessLoggerOptions = {},
): ProcessLoggers {
  const level: LogLevelSetting = parseLogLevel(env.LOG_LEVEL, "info")
  if (level === "off") {
    const silent = new SilentLogger()
    return { system: silent, agent: silent, close: () => Promise.resolve() }
  }

  const closeTimeoutMs = options.closeTimeoutMs
  const bindings = {
    service: options.service ?? "kefu-rag",
    pid: process.pid,
    ...(options.bindings ?? {}),
  }
  const build = (counters: LogCounters, destination: LogDestination, format: LogFormat): Logger => {
    const sink: LogSink = new BackpressureSink(
      destination,
      counters,
      closeTimeoutMs !== undefined ? { closeTimeoutMs } : {},
    )
    return createPinoLogger({
      level,
      sink,
      counters,
      format,
      bindings,
      ...(closeTimeoutMs !== undefined ? { closeTimeoutMs } : {}),
    })
  }

  const stdout = build(
    new LogCounters(),
    options.destination ?? (process.stdout as unknown as LogDestination),
    "json",
  )

  if (parseLogFileSetting(env.LOG_FILE) === "off") {
    return { system: stdout, agent: new SilentLogger(), close: () => stdout.close() }
  }

  const dir = resolveLogDir(env.LOG_DIR)
  const files: RotatingFileDestination[] = []
  const buildFile = (prefix: string): Logger => {
    const counters = new LogCounters()
    const destination = new RotatingFileDestination({
      dir,
      prefix,
      counters,
      ...(options.retentionDays !== undefined ? { retentionDays: options.retentionDays } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.onFileFailure !== undefined ? { onFailure: options.onFileFailure } : {}),
    })
    files.push(destination)
    return build(counters, destination, "weknora")
  }

  const system = new TeeLogger([stdout, buildFile("system")])
  const agent = buildFile("agent")
  let closePromise: Promise<void> | undefined
  return {
    system,
    agent,
    close: () => {
      closePromise ??= (async () => {
        // Flush the sinks first, then close the file handles behind them.
        await Promise.allSettled([system.close(), agent.close()])
        await Promise.allSettled(files.map(async (destination) => destination.close()))
      })()
      return closePromise
    },
  }
}
