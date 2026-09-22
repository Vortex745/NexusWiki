/**
 * Ticket 29 (EVAL-02B) — decide whether a Feedback submission has a target at
 * all, BEFORE anything is written.
 *
 * Three questions, answered from server-owned data only (never from the
 * request body):
 *
 * 1. Does this process have a trace for the run? No → unknown.
 * 2. Does the run's session belong to the caller? A run of another tenant or
 *    another subject is answered exactly like an unknown run, so feedback can
 *    never be used to probe which run ids exist.
 * 3. Did the run reach a terminal result? A run that is still streaming (or
 *    died without a terminal event) has no answer to rate yet → incomplete.
 *
 * The message id stays client-owned: the server cannot mint or verify a
 * browser message id, so it is shape-validated and stored as provenance
 * (feedback → run → message), while ownership is always enforced through the
 * run itself.
 */

import type { AnswerRunEvent, AnswerTerminalStatus } from "../types"

export interface FeedbackTarget {
  runId: string
  /** Server-derived: the session the run's trace belongs to. */
  sessionId: string
  /** The terminal status the run actually reached. */
  terminalStatus: AnswerTerminalStatus
}

export type FeedbackTargetResolution =
  | { resolution: "ok"; target: FeedbackTarget }
  | { resolution: "unknown" }
  | { resolution: "incomplete" }

export interface FeedbackTargetOwner {
  tenantId: string
  subjectId: string
}

export interface FeedbackTargetDeps {
  /** The run's persisted trace, or null when this process never saw it. */
  getRun(runId: string): { sessionId: string; events: AnswerRunEvent[] } | null
  /** True only when the session's directory belongs to (tenant, subject). */
  ownsSession(sessionId: string, tenantId: string, subjectId: string): boolean
}

export interface FeedbackTargetResolver {
  resolve(runId: string, owner: FeedbackTargetOwner): FeedbackTargetResolution
}

export function createFeedbackTargetResolver(
  deps: FeedbackTargetDeps
): FeedbackTargetResolver {
  return {
    resolve(runId, owner) {
      const run = deps.getRun(runId)
      if (!run) return { resolution: "unknown" }
      if (!deps.ownsSession(run.sessionId, owner.tenantId, owner.subjectId)) {
        return { resolution: "unknown" }
      }
      // The LAST terminal event wins: a branch that was regenerated keeps its
      // earlier events, and the newest one is the answer the user is rating.
      const done = [...run.events].reverse().find((event) => event.type === "done")
      if (!done) return { resolution: "incomplete" }
      return {
        resolution: "ok",
        target: {
          runId,
          sessionId: run.sessionId,
          terminalStatus: done.result.status,
        },
      }
    },
  }
}
