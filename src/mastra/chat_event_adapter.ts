/**
 * Ticket 05 — Chat/Answer event adapter.
 *
 * Produces an `AnswerEventsSource`-compatible async iterable that consumes
 * the Mastra Answer topology (Ticket 03 hybrid: deterministic Workflow gates
 * around bounded Mastra Agent single-shot loops) and emits the existing 6
 * `AnswerRunEvent` types (progress ×4 stages + answer_delta + done) with
 * schema-versioned payload, ordering, run/session identity, cancellation,
 * and terminal-exactly-once semantics preserved.
 *
 * The adapter is the production Answer event source. It remains decoupled
 * from `@mastra/core` through the injected `MastraRunner` seam so event
 * compatibility can be tested without constructing a live provider runtime.
 *
 * Contracts preserved (per Ticket 05 spec):
 *   #1 Chat request fields + validation behavior (message/stream/runId/sessionId)
 *   #2 Answer event names + payload fields + ordering + run/session identity
 *   #3 SSE + complete JSON parity from one Answer event source
 *   #4 Historical replay compatibility for pre-Mastra runs
 *   #5 Client disconnect + AbortSignal cancellation → one cancelled terminal event, no late answer
 *   #6 Duplicate runner invocation cannot publish the same answer twice
 *
 * References:
 *   - T01 stream contract: agent.stream() result is NOT itself async-iterable;
 *     use streamResult.fullStream (typed events) or streamResult.textStream.
 *   - T02 §3: tenantId must NOT be a free-form tool arg; sourced from AccessContext.
 *   - T03 §3: 6-gate map (GATE 0 route → GATE 1 route-specific → GATE 2 context →
 *     GATE 3 answer Draft → GATE 4 validation → GATE 5 publish / GATE 6 handoff).
 *   - T03 §5: Mastra Agent maxSteps=1 + maxRetries=0 (single-shot, no competition).
 *   - T03 §7: the runner owns in-flight and pre-persistence cancellation;
 *     the adapter rejects pre-run aborts and terminalizes runner AbortErrors.
 *   - T04 §3: Memory → Store adapter contract (MastraMemoryAdapter); this chat
 *     adapter does NOT own memory — it delegates to the Answer pipeline.
 */

import { randomUUID } from "node:crypto"
import type {
  AnswerRunEvent,
  AnswerRunEventPayload,
  AnswerRunResult,
  AnswerRunStage,
  AnswerTerminalStatus,
  RouterDecision,
  RouteTraceData,
  RetrievalTraceData,
  ContextTraceData,
  ValidationTraceData,
  ReasoningEffort,
} from "../types"
import type { AnswerRunOptions, AnswerRunObserver } from "../answer/generation"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
import type { RetrievalScope } from "../types/retrieval_scope"
import {
  createRunContext,
  hasRunResourceBudgetFailure,
  isRunBudgetError,
  runWithRunContext,
  type RunContext,
  type RunResourceBudgetOptions,
} from "../runtime/run_context"
import { withBudget } from "../runtime/deadline"
import {
  isDraftPublishable,
  publicTerminalCopy,
} from "../answer/terminal_copy"
import { bindAnswerBasis } from "./answer_basis"
import { createAnswerDeliveryMachine } from "./answer_run_state"

/**
 * Transport-level event source signature — structurally identical to
 * `AnswerEventsSource` in src/api/chat.ts. Inlined here (instead of imported)
 * to honor T02 #5 dependency direction: src/mastra/* must not import
 * src/api/*. TypeScript structural typing ensures the adapter's return type
 * is assignable to AnswerEventsSource at the createChatRouter injection site.
 */
export type MastraChatEventSource = (
  message: string,
  options: AnswerRunOptions
) => AsyncIterable<AnswerRunEvent>

/**
 * Map a terminal status (AnswerRunResult.status) to the run execution status
 * (AnswerRunEventBase.status). The two are distinct:
 *   - AnswerRunEventBase.status = run execution state (running/completed/degraded/failed/cancelled)
 *   - AnswerRunResult.status = terminal outcome (8 values including clarification_required, handoff_required, etc.)
 */
function terminalStatusToRunStatus(
  terminal: AnswerTerminalStatus
): AnswerRunEvent["status"] {
  switch (terminal) {
    case "completed":
      return "completed"
    case "cancelled":
      return "cancelled"
    case "provider_error":
    case "invalid_citation":
      return "failed"
    case "clarification_required":
    case "insufficient_retrieval":
    case "insufficient_evidence":
    case "handoff_required":
      return "degraded"
    default:
      return "degraded"
  }
}

// ---------------------------------------------------------------------------
// MastraRunner seam — decouples adapter from the real @mastra/core package.
// Ticket 09 (route migration) wires this to the actual Mastra Agent; here it
// is an injected function so the event contract can be tested in isolation.
// ---------------------------------------------------------------------------

/**
 * Input to the Mastra runner. Mirrors AnswerRunOptions but with required
 * runId + sessionId (the adapter assigns them before invoking the runner).
 * `accessContext` is always non-undefined (adapter falls back to
 * singleTenantAccessContext per T04 §4 backward-compat).
 */
export interface MastraRunnerInput {
  message: string
  runId: string
  sessionId: string
  signal: AbortSignal
  accessContext: AccessContext
  /** Ticket 05 (KB-03A): server-computed knowledge scope, forwarded verbatim
   * from `AnswerRunOptions.retrievalScope`. Omitted when the run carries no
   * knowledge scope — the retrieval channels then keep their unfiltered reads. */
  retrievalScope?: RetrievalScope
  /** Ticket 19 (AST-01B): the transport-resolved assistant version snapshot
   * (prompt + rerank binding), forwarded verbatim — runners never read raw
   * request fields for the assistant overlay. */
  assistant?: import("../assistants/assistant_service").AssistantRunSnapshot
  /**
   * Ticket 33 (MEM-01B): false disables long-term memory recall for this
   * run (narrowing-only transport flag). The memory-recall wrapper reads it;
   * runners receive the RECALLED memories via {@link longTermMemories}.
   */
  useMemory?: boolean
  /**
   * Ticket 36 (WEB-01): true opts this run into web search (configured
   * Tavily). Forwarded verbatim from the transport's opt-in flag; runners
   * pass it to the searcher's web channel. URL reads from message-supplied
   * links never depend on this flag.
   */
  useWeb?: boolean
  /**
   * Ticket 33 (MEM-01B): the owner-scoped long-term memories recalled into
   * this run, injected by the memory-recall wrapper. Runners render them
   * through `renderMemoryPromptSuffix` — never as evidence or citations.
   */
  longTermMemories?: import("./memory_prompt").RecalledMemory[]
  /** Explicit saved-memory inspection query; bypasses knowledge retrieval. */
  memoryIntent?: boolean
  /**
   * The run's frozen reasoning-effort request, forwarded verbatim from
   * `AnswerRunOptions`. Absent means the run never asked — no runner may
   * invent a value, and the provider payload keeps its old shape.
   */
  reasoningEffort?: ReasoningEffort
  /** Route preparation produced once by the dispatch runner. Standalone
   * route runners may omit it and perform their own ownership check. */
  preparedRoute?: PreparedMastraRoute
  /** Live streaming hook. Runners that stream tokens call it as each token
   * arrives; the adapter turns these into answer_delta events with
   * arrival-order sequence numbers while the runner is still executing.
   * The output `tokens` array stays authoritative for the final replay —
   * the adapter subtracts tokens already published live. Optional: runners
   * that omit the hook keep the buffered end-of-run replay. */
  onAnswerDelta?: (token: string) => void
  /**
   * Real stage boundaries and known results while the runner is in flight.
   * A one-argument call remains a running opener. The final aggregated traces
   * stay authoritative; live validation details never publish answerBasis.
   */
  onStageProgress?: <S extends ProgressStage>(stage: S, details?: StageProgressDetails<S>) => void
}

/** The four stages a progress event can report on. */
export type ProgressStage = "route" | "retrieval" | "context" | "validation"

export interface StageProgressData {
  route: RouteTraceData
  retrieval: RetrievalTraceData
  context: ContextTraceData
  validation: ValidationTraceData
}

export interface StageProgressDetails<S extends ProgressStage> {
  status?: "running" | "completed" | "failed"
  round?: number
  data?: StageProgressData[S]
}

export interface PreparedMastraRoute {
  decision: RouterDecision
  effectiveMessage: string
  contextualizedQuery: string
  routeTrace: RouteTraceData
}

/**
 * Output from the Mastra runner. The adapter translates this into the 6
 * AnswerRunEvent types. Fields mirror AnswerRunResult so the adapter does
 * minimal shaping.
 */
export interface MastraRunnerOutput {
  /** Final reply text (assembled from answer_delta tokens). */
  reply: string
  /** Terminal status — one of AnswerRunResult.status. */
  status: AnswerRunResult["status"]
  /** Citation references for the reply. */
  references: AnswerRunResult["references"]
  /** Degradation flags (e.g. contextualization-failed, provider-fallback). */
  degradation: AnswerRunResult["degradation"]
  /** Streamed answer tokens (answer_delta events). May be empty if the runner
   *  assembles the reply without streaming. */
  tokens: string[]
  /** Trace data for the 4 progress stages. */
  routeTrace: RouteTraceData
  retrievalTrace: RetrievalTraceData
  contextTrace: ContextTraceData
  validationTrace: ValidationTraceData
  summarizationUsage?: AnswerRunResult["summarizationUsage"]
  summarizationDurationMs?: AnswerRunResult["summarizationDurationMs"]
  summarizationCheckpoint?: AnswerRunResult["summarizationCheckpoint"]
  summarizationOutcome?: AnswerRunResult["summarizationOutcome"]
  /**
   * Ticket 31 (FAQ-01B): present only when the run was answered directly by
   * a unique normalized FAQ exact match. Copied onto the done event's result
   * so transports can label the standard answer.
   */
  faq?: AnswerRunResult["faq"]
  /**
   * Ticket 33 (MEM-01B): the long-term memories recalled into this run's
   * prompts (absent when memory is disabled, unwired or empty). Copied onto
   * the done event's result — informational trace, never a citation.
   */
  memoryUsed?: AnswerRunResult["memoryUsed"]
}

/**
 * Injected Mastra runner. The adapter calls this exactly once per Answer run
 * (per T03 §5 Mastra Agent maxSteps=1 + maxRetries=0). The runner MUST:
 *   - Respect `signal.aborted` (throw AbortError on abort)
 *   - Return a single MastraRunnerOutput (no internal retries)
 *   - NOT emit AnswerRunEvents directly (the adapter owns event emission)
 */
export type MastraRunner = (input: MastraRunnerInput) => Promise<MastraRunnerOutput>

// ---------------------------------------------------------------------------
// Chat request validation — mirrors src/api/chat.ts:73-84 so the adapter
// preserves the existing chat request fields + validation behavior (T05 #1).
// ---------------------------------------------------------------------------

const ID_PATTERN = /^[a-zA-Z0-9-]{1,100}$/

export interface ChatRequestShape {
  message: string
  stream?: boolean
  runId?: string
  sessionId?: string
}

/**
 * Validate a ChatRequest-shaped input and return normalized message + runId
 * + sessionId. Throws on invalid input (mirrors the 400 behavior in
 * createChatRouter, but the adapter surfaces the error as a thrown exception
 * so the caller can map it to the appropriate HTTP response).
 */
export function validateChatRequest(input: ChatRequestShape): {
  message: string
  runId: string
  sessionId: string
} {
  if (!input.message?.trim()) {
    throw new Error("message is required")
  }
  const sessionId =
    typeof input.sessionId === "string" && ID_PATTERN.test(input.sessionId)
      ? input.sessionId
      : randomUUID()
  const runId =
    typeof input.runId === "string" && ID_PATTERN.test(input.runId)
      ? input.runId
      : randomUUID()
  return { message: input.message, runId, sessionId }
}

// ---------------------------------------------------------------------------
// Event construction helpers — emit the 6 AnswerRunEvent types with correct
// payload + ordering + run/session identity (T05 #2).
// ---------------------------------------------------------------------------

function makeBaseEvent(args: {
  runId: string
  sessionId: string
  /** Eval refactor Ticket 01: stamped on the event when the caller set it. */
  caseId?: string
  sequence: number
  stage: AnswerRunStage
  status: AnswerRunEvent["status"]
  runStartedAt: number
}): Omit<AnswerRunEvent, "type" | "message" | "data" | "token" | "result"> {
  // Note: spread below adds the discriminated `type` field per payload variant.
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    sessionId: args.sessionId,
    runId: args.runId,
    ...(args.caseId !== undefined ? { caseId: args.caseId } : {}),
    eventId: `${args.runId}:${args.sequence}`,
    sequence: args.sequence,
    createdAt: now,
    stage: args.stage,
    status: args.status,
    durationMs: Date.now() - args.runStartedAt,
    attempt: 1,
    round: 0,
    inputSummary: "",
    outputSummary: "",
  }
}

function makeProgressEvent(
  base: Omit<AnswerRunEvent, "type" | "message" | "data" | "token" | "result">,
  payload: Extract<AnswerRunEventPayload, { type: "progress" }>
): AnswerRunEvent {
  return { ...base, ...payload } as AnswerRunEvent
}

function makeAnswerDeltaEvent(
  base: Omit<AnswerRunEvent, "type" | "message" | "data" | "token" | "result">,
  token: string
): AnswerRunEvent {
  return { ...base, type: "answer_delta", stage: "answer", token } as AnswerRunEvent
}

/**
 * Progress message per stage. Live and post-run events for a stage share one
 * message so the two are indistinguishable apart from their payload data.
 */
const STAGE_PROGRESS_MESSAGE: Record<ProgressStage, string> = {
  route: "Routing query",
  retrieval: "Retrieving evidence",
  context: "Contextualizing",
  validation: "Validating draft",
}

function makeDoneEvent(
  base: Omit<AnswerRunEvent, "type" | "message" | "data" | "token" | "result">,
  result: AnswerRunResult
): AnswerRunEvent {
  return { ...base, type: "done", stage: "done", result } as AnswerRunEvent
}

// ---------------------------------------------------------------------------
// Cancellation — T03 §7 three checkpoints + late-event prohibition.
// ---------------------------------------------------------------------------

function checkAbort(signal: AbortSignal, checkpoint: string): void {
  if (signal.aborted) {
    const err = new Error(`Answer run cancelled at ${checkpoint}`)
    err.name = "AbortError"
    throw err
  }
}

// ---------------------------------------------------------------------------
// Adapter factory — returns an MastraChatEventSource that consumes the Mastra
// Answer topology via the injected MastraRunner.
// ---------------------------------------------------------------------------

export interface MastraChatEventAdapterOptions {
  runner: MastraRunner
  /** Authoritative local trace persistence. Failure stops publication. */
  traceObserver?: AnswerRunObserver
  /**
   * T13 (spec issue #13 criterion #1+#2): observer fanout. The adapter calls
   * each observer's `onEvent(event)` BEFORE yielding the event.
   *
   * Observers are fire-and-forget per T06 §5.1: observer failure is
   * swallowed (console.warn) and NEVER breaks the event stream or alters
   * the user-visible trace. Fanout order matches T06 §5.3:
   *   1. AnswerTraceRepository (hard dependency — caller constructs the
   *      list in this order; the adapter itself only warns on failure).
   *   2. langfuseObserver (soft — already swallows internally).
   *
   * When omitted, no observers are notified.
   */
  observers?: AnswerRunObserver[]
  /**
   * P7.2: Per-run deadline budget in milliseconds. When set, the adapter
   * constructs a `RunContext` (linking `AnswerRunOptions.signal` as the
   * external cancel signal) and wraps the runner invocation in
   * `withBudget`. The resulting `ctx.signal` is passed to the runner as
   * `input.signal` so every stage (route/retrieval/context/answer/
   * validation/publish) honors cancellation from BOTH the deadline timer
   * AND the external transport signal — converging to exactly one
   * terminal event through the delivery state machine.
   *
   * When omitted: no deadline enforcement; the adapter passes
   * `AnswerRunOptions.signal` directly to the runner (pre-P7.2 behavior
   * — backward compat).
   */
  budgetMs?: number
  /** Whole-run aggregate model call, token, and cost limits. */
  resourceBudget?: RunResourceBudgetOptions
}

/**
 * Create an MastraChatEventSource backed by the Mastra Answer topology. The
 * returned function implements the event-source contract injected into
 * `createChatRouter(traceRepository, eventsSource)` (T05 #3).
 *
 * The adapter:
 *   - Validates the chat request (T05 #1)
 *   - Emits 6 AnswerRunEvent types in T03 §3 gate order (T05 #2)
 *   - Supports both SSE streaming and complete JSON collection (T05 #3)
 *   - Produces events replayable via AnswerTraceRepository.getRun (T05 #4)
 *   - Emits exactly one cancelled terminal when the run aborts before the
 *     runner's completion boundary (T05 #5)
 *   - Guarantees terminal-exactly-once (T05 #6)
 */
export function createMastraChatEventAdapter(
  options: MastraChatEventAdapterOptions
): MastraChatEventSource {
  const { runner, traceObserver, observers, budgetMs, resourceBudget } = options
  return async function* mastraChatEventSource(
    message: string,
    runOptions?: AnswerRunOptions
  ): AsyncGenerator<AnswerRunEvent> {
    // T05 #1: chat request validation. The adapter performs the same
    // validation as createChatRouter so it can be dropped in as a
    // transport-level eventsSource without weakening the contract.
    const { message: validatedMessage, runId, sessionId } = validateChatRequest({
      message,
      runId: runOptions?.runId,
      sessionId: runOptions?.sessionId,
    })

    // T04 §4: accessContext fallback — singleTenantAccessContext when
    // undefined preserves backward compat for bare-router mounts.
    const accessContext: AccessContext =
      runOptions?.accessContext ?? singleTenantAccessContext()

    // Eval refactor Ticket 01: optional case correlation stamped on every
    // event (normal chat leaves it undefined — payload unchanged).
    const caseId = runOptions?.caseId

    // T03 §7 checkpoint 1: before LLM call. (Moved inside try block so an
    // already-aborted signal produces a cancelled terminal event instead of
    // throwing out of the generator — T05 #5.)
    const signal = runOptions?.signal ?? new AbortController().signal

    const runStartedAt = Date.now()
    let sequence = 0
    const delivery = createAnswerDeliveryMachine<MastraRunnerOutput>()
    const advanceDelivery = (observation: Parameters<typeof delivery.advance>[0]) => {
      const result = delivery.advance(observation)
      if (result.kind === "rejected") throw result.error
      return result.state
    }
    let traceFailure: unknown
    let runContext: RunContext | undefined
    const stageRounds: Partial<Record<ProgressStage, number>> = {}
    let initialRetrievalRound: number | undefined
    const stageStatuses = new Map<string, AnswerRunEvent["status"]>()
    const stageKey = (stage: ProgressStage, round: number, data: StageProgressData[ProgressStage]): string =>
      `${stage}:${round}:${stage === "context" ? (data as ContextTraceData).phase ?? "assembly" : ""}`
    const nextSequence = () => ++sequence

    /**
     * T13 (T06 §5.1 fire-and-forget): notify each observer of an event
     * BEFORE yielding it. Observer failure is swallowed (console.warn) and
     * never propagates into the Answer event stream.
     */
    const notifyObservers = (event: AnswerRunEvent): void => {
      if (traceObserver) {
        try {
          traceObserver.onEvent(event)
        } catch (err) {
          traceFailure = err
          throw err
        }
      }
      if (!observers || observers.length === 0) return
      for (const observer of observers) {
        try {
          observer.onEvent(event)
        } catch (err) {
          console.warn(
            "[mastra-adapter] Observer failed; event stream unaffected:",
            err instanceof Error ? err.message : err,
          )
        }
      }
    }

    // Helper: emit a progress event for a stage.
    const emitProgress = function* (
      stage: "route" | "retrieval" | "context" | "validation",
      messageText: string,
      data: RouteTraceData | RetrievalTraceData | ContextTraceData | ValidationTraceData
    ): Generator<AnswerRunEvent> {
      const base = makeBaseEvent({
        runId,
        sessionId,
        caseId,
        sequence: nextSequence(),
        stage,
        status: "completed",
        runStartedAt,
      })
      base.round = stage === "validation"
        ? (data as ValidationTraceData).round ?? stageRounds[stage] ?? 0
        : stage === "retrieval"
          ? initialRetrievalRound ?? 0
        : stageRounds[stage] ?? 0
      // A final trace enriches the actual stage result; it cannot turn a
      // reported provider failure into a successful completion.
      if (stageStatuses.get(stageKey(stage, base.round, data)) === "failed") base.status = "failed"
      const event = makeProgressEvent(base, {
        type: "progress",
        stage,
        message: messageText,
        data: data as RouteTraceData & RetrievalTraceData & ContextTraceData & ValidationTraceData,
      })
      notifyObservers(event)
      yield event
    }

    try {
      // T03 §7 checkpoint 1: before LLM call.
      checkAbort(signal, "GATE 0 (before route)")

      // P7.2: When budgetMs is configured, construct a RunContext that
      // links the transport signal as externalSignal and wrap the runner
      // invocation in `withBudget`. The runner receives `ctx.signal` as
      // `input.signal`, so every stage (route/retrieval/context/answer/
      // validation/publish) honors cancellation from BOTH the deadline
      // timer AND the external transport signal. `DeadlineExpiredError`
      // is named "AbortError" so the catch path below treats deadline
      // expiry identically to external cancel → exactly one terminal.
      //
      // When budgetMs is omitted: pass `signal` directly (pre-P7.2
      // behavior — backward compat).
      // Live signal bridge: streaming runners publish tokens through
      // input.onAnswerDelta and settled stages through input.onStageProgress as
      // they happen; the adapter drains that queue and yields events while the
      // runner is still executing, so the transport sees true in-run progress
      // instead of one final burst. One ordered queue keeps a stage event from
      // overtaking the tokens that were produced before it. Tokens already
      // published live are subtracted from the runnerOutput.tokens replay —
      // runners that ignore the hook keep the buffered end-of-run replay.
      type LiveSignal =
        | { kind: "delta"; token: string }
        | { kind: "stage"; stage: ProgressStage; details?: StageProgressDetails<ProgressStage> }
      const liveSignals: LiveSignal[] = []
      let deltasPublished = 0
      let runnerSignal = signal
      let wakeDrainer: (() => void) | null = null
      const wake = (): void => {
        wakeDrainer?.()
        wakeDrainer = null
      }
      const onAnswerDelta = (token: string): void => {
        if (delivery.state.kind !== "running" || runnerSignal.aborted) return
        liveSignals.push({ kind: "delta", token })
        wake()
      }
      const onStageProgress: NonNullable<MastraRunnerInput["onStageProgress"]> = (
        stage, details
      ): void => {
        if (delivery.state.kind !== "running" || runnerSignal.aborted) return
        // Only final business completion can publish a model basis. Copy the
        // payload now so a runner cannot mutate a queued validation record.
        const data = details?.data ? { ...details.data } : undefined
        if (data) delete (data as ValidationTraceData).answerBasis
        liveSignals.push({ kind: "stage", stage, details: { ...details, data } })
        wake()
      }
      const invokeRunner = (ctxSignal: AbortSignal): Promise<MastraRunnerOutput> => {
        runnerSignal = ctxSignal
        return runner({
          message: validatedMessage,
          runId,
          sessionId,
          signal: ctxSignal,
          accessContext,
          // Ticket 05 (KB-03A): the transport already resolved the request's
          // knowledge selection against the caller's identity — forward the
          // server-computed scope, never the raw request field.
          ...(runOptions?.retrievalScope
            ? { retrievalScope: runOptions.retrievalScope }
            : {}),
          // Ticket 19 (AST-01B): the server-resolved assistant snapshot.
          ...(runOptions?.assistant ? { assistant: runOptions.assistant } : {}),
          // Ticket 33 (MEM-01B): the narrowing-only memory disable flag.
          ...(runOptions?.useMemory === false ? { useMemory: false } : {}),
          // Ticket 36 (WEB-01): the explicit web-search opt-in flag.
          ...(runOptions?.useWeb === true ? { useWeb: true } : {}),
          // The run's frozen reasoning-effort request (omitted = never asked).
          ...(runOptions?.reasoningEffort
            ? { reasoningEffort: runOptions.reasoningEffort }
            : {}),
          onAnswerDelta,
          onStageProgress,
        })
      }

      // Early route progress: lights up downstream thinking UIs during the
      // route/retrieval latency window instead of after the whole run.
      {
        const base = makeBaseEvent({
          runId,
          sessionId,
          caseId,
          sequence: nextSequence(),
          stage: "route",
          status: "running",
          runStartedAt,
        })
        const event = makeProgressEvent(base, {
          type: "progress",
          stage: "route",
          message: "Routing query",
          data: {} as RouteTraceData,
        })
        notifyObservers(event)
        yield event
      }

      advanceDelivery({ type: "runner_started" })
      const runnerPromise = (async (): Promise<MastraRunnerOutput> => {
        if (budgetMs !== undefined || resourceBudget !== undefined) {
          const ctx: RunContext = createRunContext({
            budgetMs: budgetMs ?? Number.POSITIVE_INFINITY,
            externalSignal: signal,
            resourceBudget,
          })
          runContext = ctx
          return runWithRunContext(
            ctx,
            () => withBudget((ctxSignal) => invokeRunner(ctxSignal), ctx)
          )
        }
        return invokeRunner(signal)
      })()
      runnerPromise.then(
        output => {
          advanceDelivery({ type: "runner_fulfilled", output })
          wake()
        },
        err => {
          const isAbort = err instanceof Error && err.name === "AbortError"
          const resourceBudgetExceeded = isRunBudgetError(err) ||
            (runContext !== undefined && hasRunResourceBudgetFailure(runContext))
          advanceDelivery({
            type: "runner_rejected",
            failure: isAbort
              ? { kind: "cancelled", resourceBudgetExceeded }
              : { kind: "provider_error", resourceBudgetExceeded },
          })
          wake()
        },
      )
      // Drain live signals until the runner settles and the queue empties.
      while (true) {
        if (runnerSignal.aborted && (
          delivery.state.kind === "running" ||
          (delivery.state.kind === "settled" && delivery.state.resolution.kind === "rejected")
        )) {
          liveSignals.length = 0
          await runnerPromise
          checkAbort(runnerSignal, "live event publication")
        }
        const signal = liveSignals.shift()
        if (signal) {
          if (signal.kind === "delta") {
            deltasPublished += 1
            const base = makeBaseEvent({
              runId,
              sessionId,
              caseId,
              sequence: nextSequence(),
              stage: "answer",
              status: "running",
              runStartedAt,
            })
            const event = makeAnswerDeltaEvent(base, signal.token)
            notifyObservers(event)
            yield event
          } else {
            const base = makeBaseEvent({
              runId,
              sessionId,
              caseId,
              sequence: nextSequence(),
              stage: signal.stage,
              status: signal.details?.status ?? "running",
              runStartedAt,
            })
            base.round = signal.details?.round ?? 0
            stageRounds[signal.stage] = base.round
            if (signal.stage === "retrieval") initialRetrievalRound ??= base.round
            stageStatuses.set(stageKey(signal.stage, base.round, signal.details?.data ?? {}), base.status)
            const event = makeProgressEvent(base, {
              type: "progress",
              stage: signal.stage,
              message: STAGE_PROGRESS_MESSAGE[signal.stage],
              data: (signal.details?.data ?? {}) as RouteTraceData &
                RetrievalTraceData &
                ContextTraceData &
                ValidationTraceData,
            })
            notifyObservers(event)
            yield event
          }
          continue
        }
        if (delivery.state.kind === "settled") break
        await new Promise<void>((resolve) => {
          wakeDrainer = resolve
        })
      }

      await runnerPromise
      const settled = delivery.state
      if (settled.kind !== "settled" || settled.resolution.kind !== "fulfilled") {
        throw new Error("Answer runner did not fulfill delivery")
      }
      const runnerOutput = settled.resolution.output

      // The runner owns route/retrieval/context execution and persistence.
      // Once it returns, its output is authoritative: a later transport abort
      // must not rewrite already-persisted completed state as cancelled.
      // Emit only stages that actually ran, using the real aggregated trace.
      yield* emitProgress("route", "Routing query", runnerOutput.routeTrace)
      if (Object.keys(runnerOutput.retrievalTrace).length > 0) {
        yield* emitProgress("retrieval", "Retrieving evidence", runnerOutput.retrievalTrace)
      }
      if (Object.keys(runnerOutput.contextTrace).length > 0) {
        yield* emitProgress("context", "Contextualizing", runnerOutput.contextTrace)
      }

      // GATE 4 — validation (Critic per T03 §6).
      if (Object.keys(runnerOutput.validationTrace).length > 0) {
        const { answerBasis, ...validationTrace } = runnerOutput.validationTrace
        const publicBasis = runnerOutput.status === "completed" && validationTrace.passed === true
          ? bindAnswerBasis(answerBasis, runnerOutput.references)
          : undefined
        yield* emitProgress(
          "validation",
          "Validating draft",
          { ...validationTrace, ...(publicBasis ? { answerBasis: publicBasis } : {}) }
        )
      }

      // Only validated tokens are publishable knowledge output. A terminal that
      // did not approve the draft publishes none of them, even when the runner
      // still hands back the generated text (it cannot retract it) — the done
      // event's public terminal copy is the only text that surface carries.
      // Tokens that were already streamed live are skipped — replay covers
      // runners that ignored the onAnswerDelta hook (deltasPublished === 0).
      const publishableTokens = isDraftPublishable(runnerOutput.status)
        ? runnerOutput.tokens.slice(deltasPublished)
        : []
      for (const token of publishableTokens) {
        const base = makeBaseEvent({
          runId,
          sessionId,
          caseId,
          sequence: nextSequence(),
          stage: "answer",
          status: "running",
          runStartedAt,
        })
        const event = makeAnswerDeltaEvent(base, token)
        notifyObservers(event)
        yield event
      }

    } catch (err) {
      if (err === traceFailure) throw err
      // RouteNotSupportedError indicates an incomplete Mastra route map. All
      // production routes are migrated, so surface it as a hard error instead
      // of converting it into a misleading terminal result.
      if (
        err instanceof Error &&
        err.name === "RouteNotSupportedError"
      ) {
        throw err
      }
      if (delivery.state.kind === "created" || delivery.state.kind === "running") {
        const isAbort = err instanceof Error && err.name === "AbortError"
        const resourceBudgetExceeded = isRunBudgetError(err) ||
          (runContext !== undefined && hasRunResourceBudgetFailure(runContext))
        advanceDelivery({
          type: "runner_rejected",
          failure: isAbort
            ? { kind: "cancelled", resourceBudgetExceeded }
            : { kind: "provider_error", resourceBudgetExceeded },
        })
      }
    }

    const terminal = advanceDelivery({ type: "terminal_claimed" })
    if (terminal.kind !== "terminal") throw new Error("Answer delivery did not reach terminal")
    const { resolution } = terminal
    let result: AnswerRunResult
    if (resolution.kind === "fulfilled") {
      const output = resolution.output
      result = {
        runId,
        reply: isDraftPublishable(output.status) ? output.reply : publicTerminalCopy(output.status),
        status: output.status,
        references: isDraftPublishable(output.status) ? output.references : [],
        degradation: output.degradation,
        summarizationUsage: output.summarizationUsage,
        summarizationDurationMs: output.summarizationDurationMs,
        summarizationCheckpoint: output.summarizationCheckpoint,
        summarizationOutcome: output.summarizationOutcome,
        ...(output.faq ? { faq: output.faq } : {}),
        ...(output.memoryUsed ? { memoryUsed: output.memoryUsed } : {}),
      }
    } else {
      const { failure } = resolution
      const status = failure.kind === "cancelled" ? "cancelled" : "provider_error"
      result = {
        runId,
        reply: publicTerminalCopy(status),
        status,
        references: [],
        degradation: {
          status: "insufficient",
          unavailableChannels: [],
          reason: failure.resourceBudgetExceeded
            ? "resource_budget_exceeded"
            : undefined,
        },
      }
    }
    if (runOptions?.reasoningEffort) result.requestedReasoningEffort = runOptions.reasoningEffort
    const event = makeDoneEvent(makeBaseEvent({
      runId,
      sessionId,
      caseId,
      sequence: nextSequence(),
      stage: "done",
      status: terminalStatusToRunStatus(result.status),
      runStartedAt,
    }), result)
    notifyObservers(event)
    yield event
  }
}
