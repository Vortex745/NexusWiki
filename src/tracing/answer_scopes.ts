import type { AnswerRunEvent, AnswerRunStage } from "../types/answer"
import type { AnswerEventsSource } from "../api/chat"
import type { OperationScope, OperationOutcome } from "./contract"

/**
 * LO-09: real round / tool / stage scopes for one Answer run.
 *
 * The HTTP root already exists (LO-06); this tracker adds the run's own
 * children from the events the runner ACTUALLY emits:
 *
 *   run root
 *     └── round.N            (only when the run really enters round N > 0)
 *           └── stage.<name> (route / retrieval / context / validation / answer)
 *                 └── tool.<name> (one per tool call that really executed)
 *
 * Rules that matter:
 *   - a stage span opens on its first event and closes when the run moves to
 *     another stage or terminates, so no phase is invented and none leaks;
 *   - a tool span is emitted at the real tool-result boundary the runner
 *     reports (`selectedTool` on a retrieval event). A duplicate call was
 *     never executed, so it is recorded as an attribute and gets NO span;
 *   - the `answer` stage covers the delta stream, so it is the natural parent
 *     for the generation observed by the model seam (LO-08);
 *   - exactly one `done` closes everything, including on early exit;
 *   - every scope ends exactly once, whatever the terminal status.
 */

export type AnswerScopeOutcome = "ok" | "error" | "cancelled"

export class AnswerScopeTracker {
  private stage: OperationScope | undefined
  private stageName: string | undefined
  private round: OperationScope | undefined
  private roundNumber: number | undefined
  private closed = false
  /**
   * Stages already closed in the current round. A late duplicate progress
   * event (the runtime emits route/retrieval completion twice on some paths)
   * must not reopen a one-millisecond duplicate span in the trace tree.
   */
  private readonly completedStages = new Set<string>()

  constructor(
    private readonly parent: OperationScope,
    private readonly runAttributes: Readonly<Record<string, string | number | boolean>> = {},
  ) {}

  /** Feed one run event; safe to call after close (no-op). */
  observe(event: AnswerRunEvent): void {
    if (this.closed) return
    if (event.type === "done") {
      this.finish(outcomeForTerminal(event.result.status))
      return
    }
    // The run's own round is real data (correction rounds are 2, 4, …; the
    // initial pass is 0). A round scope exists only when a later round does.
    this.syncRound(event.round)
    if (event.type === "progress") {
      this.openStage(event.stage)
      if (event.stage === "route" && event.data.decision) {
        this.stage?.setAttributes({ "route.decision": event.data.decision })
      }
      if (event.stage === "retrieval" && event.status === "completed") {
        const data = event.data
        this.stage?.setAttributes({
          ...(typeof data.resultCount === "number" ? { "retrieval.result_count": data.resultCount } : {}),
          ...(data.degradedReasons?.length
            ? { "retrieval.degraded_reasons": data.degradedReasons.join(",") }
            : {}),
        })
      }
      if (event.stage === "retrieval") this.observeRetrieval(event as RetrievalProgress)
      return
    }
    // answer_delta belongs to the answer stage; open it on the first token.
    if (event.type === "answer_delta") this.openStage("answer")
  }

  /** Close the current stage, round and tracker (idempotent). */
  finish(outcome: AnswerScopeOutcome = "ok"): void {
    if (this.closed) return
    this.closed = true
    this.closeStage(outcome)
    this.closeRound(outcome)
  }

  get currentStage(): string | undefined {
    return this.stageName
  }

  get currentRound(): number | undefined {
    return this.roundNumber
  }

  runInStageContext<T>(stage: Exclude<AnswerRunStage, "done">, round: number, fn: () => T): T {
    if (this.closed) return fn()
    this.syncRound(round)
    this.openStage(stage)
    return (this.stage ?? this.round ?? this.parent).runInContext(fn)
  }

  /**
   * Run `fn` with the CURRENT stage as the active tracing parent. The event
   * stream is advanced inside this context, so model calls made while the
   * runner produces the next event nest under the stage that caused them
   * instead of becoming siblings at the trace root.
   */
  runInContext<T>(fn: () => T): T {
    const scope = this.stage ?? this.round ?? this.parent
    return scope.runInContext(fn)
  }

  private syncRound(round: number): void {
    if (!Number.isFinite(round) || round <= 0) return
    if (this.roundNumber === round) return
    this.closeStage("ok")
    this.closeRound("ok")
    this.completedStages.clear()
    this.roundNumber = round
    this.round = this.parent.startChild(`round.${round}`, {
      ...this.runAttributes,
      "answer.round": round,
    })
  }

  private openStage(name: string): void {
    if (this.stageName === name) return
    if (this.completedStages.has(name)) return
    this.closeStage("ok")
    this.stageName = name
    const parent = this.round ?? this.parent
    this.stage = parent.startChild(`stage.${name}`, this.runAttributes)
  }

  /**
   * One tool span per tool call the runner really executed. The event carries
   * the real tool name, the loop iteration and the result count; the span is
   * closed at this boundary, so a run that exits early cannot leak it.
   */
  private observeRetrieval(event: RetrievalProgress): void {
    if (!this.stage) return
    const data = event.data ?? {}
    const tool = data.selectedTool
    if (!tool) return
    if (data.duplicate === true) {
      // Skipped without backend execution — never presented as a tool call.
      this.stage.setAttributes({
        "tool.duplicate": true,
        ...(data.iteration !== undefined ? { "tool.duplicate_iteration": data.iteration } : {}),
      })
      return
    }
    const failed = event.status === "failed"
    const child = this.stage.startChild(`tool.${tool}`, {
      "langfuse.observation.type": "tool",
      "tool.name": tool,
      ...(data.iteration !== undefined ? { "tool.iteration": data.iteration } : {}),
      ...(data.complexLoop === true ? { "tool.loop": "complex" } : {}),
      ...(data.resultCount !== undefined ? { "tool.result_count": data.resultCount } : {}),
    })
    child.end({
      outcome: failed ? "error" : "ok",
      ...(failed ? { message: "tool stage reported failure" } : {}),
    })
  }

  private closeStage(outcome: AnswerScopeOutcome): void {
    if (!this.stage) {
      this.stageName = undefined
      return
    }
    const closedName = this.stageName
    this.stage.end(endOptionsFor(outcome))
    this.stage = undefined
    this.stageName = undefined
    if (closedName) this.completedStages.add(closedName)
  }

  private closeRound(outcome: AnswerScopeOutcome): void {
    if (!this.round) {
      this.roundNumber = undefined
      return
    }
    this.round.end(endOptionsFor(outcome))
    this.round = undefined
    this.roundNumber = undefined
  }
}

type RetrievalProgress = Extract<AnswerRunEvent, { type: "progress"; stage: "retrieval" }>

function endOptionsFor(outcome: AnswerScopeOutcome): { outcome: OperationOutcome; message?: string } {
  if (outcome === "ok") return { outcome: "ok" }
  return { outcome: "error", message: outcome }
}

/**
 * A business terminal is not automatically a tracing error: an insufficient
 * answer, a handoff or a clarification is the run doing its job. Only a
 * provider failure and a cancellation end as errors.
 */
export function outcomeForTerminal(status: string): AnswerScopeOutcome {
  if (status === "cancelled") return "cancelled"
  if (status === "provider_error") return "error"
  return "ok"
}

/**
 * Wrap a runner so every emitted event also drives the tracker. The event
 * stream the caller sees is unchanged (same objects, same order).
 */
export function tracedAnswerSource(
  source: AnswerEventsSource,
  resolveParent: () => OperationScope | undefined,
): AnswerEventsSource {
  return async function* traced(message, options) {
    const parent = resolveParent()
    if (!parent?.sampled) {
      yield* source(message, options)
      return
    }
    const tracker = new AnswerScopeTracker(parent, {
      "answer.message_length": message.length,
      "answer.session_id": options.sessionId ?? "",
    })
    // Manual iteration (instead of `for await`) so each `next()` runs with the
    // current stage's span active. That is what nests a generation under
    // `stage.route` / `stage.retrieval` / `stage.context` rather than leaving
    // every model call as a sibling at the root.
    const tracedOptions = {
      ...options,
      runInAnswerStage: <T>(stage: Exclude<AnswerRunStage, "done">, round: number, fn: () => T) =>
        tracker.runInStageContext(stage, round, fn),
    }
    const iterator = source(message, tracedOptions)[Symbol.asyncIterator]()
    try {
      let step = await tracker.runInContext(() => iterator.next())
      while (!step.done) {
        tracker.observe(step.value)
        yield step.value
        step = await tracker.runInContext(() => iterator.next())
      }
      tracker.finish("ok")
    } catch (error) {
      tracker.finish("error")
      throw error
    } finally {
      // A consumer that stopped early (client disconnect) must still release
      // the source's own resources; there is no terminal event to close on.
      try {
        await iterator.return?.()
      } catch {
        // Cleanup failure must not replace the original stream outcome.
      }
    }
  }
}
