import type { AnswerRunEvent } from "../types"
import type { LogFields, Logger, LogLevel } from "./logger"

/**
 * LF-06: Answer-run execution metadata for the Agent log.
 *
 * The wrapper sits on the event source that the HTTP transport consumes, so
 * streaming and non-streaming runs share one entry point and business
 * orchestration is untouched. It is transparent: the same event objects are
 * yielded in the same order, and logging never sits on the iteration path —
 * metadata snapshots go into a small bounded queue drained in the background.
 *
 * Nothing here records content. Only ids, stages, counters and terminal
 * classifications leave the process; `answer_delta` is aggregated into
 * `delta_count` rather than logged token by token.
 */

export const DEFAULT_AGENT_LOG_QUEUE = 1024

export interface AgentRunLogContext {
  requestId?: string
  traceId?: string
  spanId?: string
  /** True when the transport is streaming this run (SSE). */
  stream?: boolean
}

export interface AgentRunLogOptions {
  context?: AgentRunLogContext
  /** Bounded progress queue (default 1024). The terminal slot is separate. */
  queueLimit?: number
}

/** The slice of `AnswerRunOptions` the wrapper needs; source signatures stay intact. */
interface AgentRunSourceOptions {
  runId?: string
  sessionId?: string
  signal?: AbortSignal
}

interface AgentLogEntry {
  level: LogLevel
  event: string
  fields: LogFields
}

/** Terminal status → level (LF-06-AC04). Unforeseen failures stay loud. */
export function levelForTerminal(status: string): LogLevel {
  switch (status) {
    case "completed":
      return "info"
    case "clarification_required":
    case "insufficient_retrieval":
    case "insufficient_evidence":
    case "invalid_citation":
    case "handoff_required":
    case "cancelled":
      return "warn"
    default:
      // provider_error, failed, and anything new.
      return "error"
  }
}

/**
 * Wrap an Answer event source so every run is observable in the Agent file.
 * With no logger (or `LOG_LEVEL=off`) the original source is returned as-is.
 */
export function withAgentRunLogging<Options extends AgentRunSourceOptions>(
  source: (message: string, options: Options) => AsyncIterable<AnswerRunEvent>,
  logger: Logger | undefined,
  options: AgentRunLogOptions = {},
): (message: string, options: Options) => AsyncIterable<AnswerRunEvent> {
  if (!logger || logger.level === "off") return source
  const context: AgentRunLogContext = options.context ?? {}
  const queueLimit = Math.max(1, Math.floor(options.queueLimit ?? DEFAULT_AGENT_LOG_QUEUE))

  return async function* loggedRun(message, runOptions) {
    const state = new AgentRunLogState(logger, context, queueLimit)
    try {
      for await (const event of source(message, runOptions)) {
        state.observe(event)
        yield event
      }
      state.end(runOptions)
    } catch (error) {
      state.fail(error, runOptions)
      throw error
    } finally {
      // An early consumer return (client hang-up) also needs one terminal.
      state.end(runOptions)
    }
  }
}

class AgentRunLogState {
  private readonly queue: AgentLogEntry[] = []
  private readonly logger: Logger
  private readonly context: AgentRunLogContext
  private readonly limit: number
  private terminalEntry: AgentLogEntry | undefined
  private terminalLogged = false
  private draining = false
  private dropped = 0
  private deltaCount = 0
  private routeDecision: string | undefined
  private validationPassed: boolean | undefined
  private lastEvent: AnswerRunEvent | undefined

  constructor(logger: Logger, context: AgentRunLogContext, limit: number) {
    this.logger = logger
    this.context = context
    this.limit = limit
  }

  observe(event: AnswerRunEvent): void {
    this.lastEvent = event
    if (event.type === "answer_delta") {
      // LF-06-AC07: never one record per token.
      this.deltaCount += 1
      return
    }
    if (event.type === "done") {
      this.logTerminal(event)
      return
    }
    if (event.type === "progress") {
      if (event.stage === "route" && event.data.decision !== undefined) {
        this.routeDecision = event.data.decision
      }
      if (event.stage === "validation" && event.data.passed !== undefined) {
        this.validationPassed = event.data.passed
      }
    }
    this.enqueue("info", "answer.run.event", this.metadata(event))
  }

  /** Normal stream end: the source may have stopped without a terminal. */
  end(runOptions: AgentRunSourceOptions): void {
    if (this.terminalLogged) return
    this.terminalLogged = true
    const aborted = runOptions.signal?.aborted === true
    const fields: LogFields = {
      ...this.baseMetadata(runOptions),
      missing_terminal: true,
      status: aborted ? "cancelled" : "missing_terminal",
      reply_length: 0,
      reference_count: 0,
      delta_count: this.deltaCount,
      ...this.droppedFields(),
    }
    this.enqueueTerminal(aborted ? "warn" : "error", "answer.run.terminal", fields)
  }

  /** The source threw: record the failure once, then let the caller rethrow. */
  fail(error: unknown, runOptions: AgentRunSourceOptions): void {
    if (this.terminalLogged) return
    this.terminalLogged = true
    const aborted =
      runOptions.signal?.aborted === true ||
      (error instanceof Error && (error.name === "AbortError" || error.name === "CanceledError"))
    const errorName = error instanceof Error ? error.name : "Error"
    const errorMessage = error instanceof Error ? error.message : String(error)
    const fields: LogFields = {
      ...this.baseMetadata(runOptions),
      missing_terminal: true,
      status: aborted ? "cancelled" : "failed",
      reply_length: 0,
      reference_count: 0,
      delta_count: this.deltaCount,
      ...this.droppedFields(),
      ...(aborted ? {} : { error_name: errorName, error: errorMessage }),
    }
    this.enqueueTerminal(aborted ? "warn" : "error", "answer.run.terminal", fields)
  }

  private logTerminal(event: Extract<AnswerRunEvent, { type: "done" }>): void {
    if (this.terminalLogged) return
    this.terminalLogged = true
    const result = event.result
    const fields: LogFields = {
      ...this.metadata(event),
      // The terminal carries the precise outcome, not the event-level "degraded".
      status: result.status,
      reply_length: result.reply.length,
      reference_count: result.references.length,
      degradation_status: result.degradation.status,
      degradation_reasons: result.degradation.unavailableChannels,
      ...(result.degradation.reason ? { degradation_reason: result.degradation.reason } : {}),
      ...(this.validationPassed !== undefined ? { validation_passed: this.validationPassed } : {}),
      ...(this.routeDecision !== undefined ? { route_decision: this.routeDecision } : {}),
      ...(result.modelProfile
        ? {
            chat_model: result.modelProfile.chatModel,
            rerank_model: result.modelProfile.rerankModel,
            embedding_profile: result.modelProfile.embeddingProfile,
          }
        : {}),
      delta_count: this.deltaCount,
      ...this.droppedFields(),
    }
    this.enqueueTerminal(levelForTerminal(result.status), "answer.run.terminal", fields)
  }

  private metadata(event: AnswerRunEvent): LogFields {
    return {
      run_id: event.runId,
      session_id: event.sessionId,
      ...this.correlationFields(),
      event_id: event.eventId,
      sequence: event.sequence,
      event_type: event.type,
      stage: event.stage,
      status: event.status,
      duration_ms: event.durationMs,
      attempt: event.attempt,
      round: event.round,
      stream: this.context.stream ?? false,
    }
  }

  /** Base metadata when no event exists (empty stream, thrown source). */
  private baseMetadata(runOptions: AgentRunSourceOptions): LogFields {
    if (this.lastEvent) return this.metadata(this.lastEvent)
    return {
      ...(runOptions.runId ? { run_id: runOptions.runId } : {}),
      ...(runOptions.sessionId ? { session_id: runOptions.sessionId } : {}),
      ...this.correlationFields(),
      stream: this.context.stream ?? false,
    }
  }

  private correlationFields(): LogFields {
    return {
      ...(this.context.requestId ? { request_id: this.context.requestId } : {}),
      ...(this.context.traceId ? { trace_id: this.context.traceId } : {}),
      ...(this.context.spanId ? { span_id: this.context.spanId } : {}),
    }
  }

  private droppedFields(): LogFields {
    return this.dropped > 0 ? { dropped_records: this.dropped } : {}
  }

  private enqueue(level: LogLevel, event: string, fields: LogFields): void {
    this.queue.push({ level, event, fields })
    if (this.queue.length > this.limit) {
      // LF-06-AC08: drop the oldest progress record, never the terminal.
      this.queue.shift()
      this.dropped += 1
    }
    void this.drain()
  }

  private enqueueTerminal(level: LogLevel, event: string, fields: LogFields): void {
    this.terminalEntry ??= { level, event, fields }
    void this.drain()
  }

  /**
   * Background drain: awaits the logger here, never on the event-iteration
   * path. Logger failures (slow disk, refused writes) are swallowed.
   */
  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      for (;;) {
        const entry = this.queue.shift() ?? this.takeTerminal()
        if (!entry) break
        try {
          await this.logger[entry.level](entry.event, entry.fields)
        } catch {
          // LF-06-AC09: a logger fault must not change the answer.
        }
      }
    } finally {
      this.draining = false
      if (this.queue.length > 0 || this.terminalEntry) void this.drain()
    }
  }

  private takeTerminal(): AgentLogEntry | undefined {
    const entry = this.terminalEntry
    this.terminalEntry = undefined
    return entry
  }
}
