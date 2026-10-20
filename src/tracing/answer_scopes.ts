import type { AnswerRunEvent } from "../types/answer"
import type { AnswerEventsSource } from "../api/chat"
import type { OperationScope, TracingRuntime } from "./contract"

/**
 * LO-09 (partial): stage scopes for one Answer run.
 *
 * The HTTP root already exists (LO-06); this tracker adds the run's own
 * STAGE children — route → retrieval → context → validation → answer — from
 * the events the runner actually emits. Rules that matter:
 *
 *   - a stage span opens on its first event and closes when the run moves to
 *     another stage or terminates, so no phase is invented and none leaks;
 *   - the `answer` stage covers the delta stream, so it is the parent of the
 *     generation observed by the model seam (LO-08);
 *   - exactly one `done` closes everything, including on early exit;
 *   - round/tool scopes need the complex-loop internals and are NOT covered
 *     here yet (ticket stays open until they are).
 */
export class AnswerScopeTracker {
  private stage: OperationScope | undefined
  private stageName: string | undefined
  private closed = false

  constructor(
    private readonly parent: OperationScope,
    private readonly runAttributes: Readonly<Record<string, string | number | boolean>> = {},
  ) {}

  /** Feed one run event; safe to call after close (no-op). */
  observe(event: AnswerRunEvent): void {
    if (this.closed) return
    if (event.type === "done") {
      this.finish("ok")
      return
    }
    if (event.type === "progress") {
      this.open(event.stage)
      return
    }
    // answer_delta belongs to the answer stage; open it on the first token.
    if (event.type === "answer_delta") this.open("answer")
  }

  /** Close the current stage and the tracker (idempotent). */
  finish(outcome: "ok" | "error" | "cancelled" = "ok"): void {
    if (this.closed) return
    this.closed = true
    this.closeStage(outcome)
  }

  get currentStage(): string | undefined {
    return this.stageName
  }

  private open(name: string): void {
    if (this.stageName === name) return
    this.closeStage("ok")
    this.stageName = name
    this.stage = this.parent.runInContext(() => this.parent.startChild(`stage.${name}`, this.runAttributes))
  }

  private closeStage(outcome: "ok" | "error" | "cancelled"): void {
    if (!this.stage) {
      this.stageName = undefined
      return
    }
    this.stage.end(outcome === "ok" ? { outcome: "ok" } : { outcome: "error", message: outcome })
    this.stage = undefined
    this.stageName = undefined
  }
}

/**
 * Wrap a runner so every emitted event also drives the tracker. The event
 * stream the caller sees is unchanged (same objects, same order).
 */
export function tracedAnswerSource(
  source: AnswerEventsSource,
  tracing: TracingRuntime,
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
    try {
      for await (const event of source(message, options)) {
        tracker.observe(event)
        yield event
      }
      tracker.finish("ok")
    } catch (error) {
      tracker.finish("error")
      throw error
    }
  }
}
