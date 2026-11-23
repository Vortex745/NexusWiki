import type {
  AnswerBasis,
  AnswerReference,
  CriticVerdict,
  Evidence,
  RouterDecision,
} from "../types"
import { bindAnswerBasis } from "./answer_basis"

type KnowledgeRoute = "simple" | "complex"
type ValidationRound = 1 | 2 | 3
type KnowledgeAttempt =
  | { readonly kind: "validate"; readonly round: ValidationRound }
  | { readonly kind: "last_regeneration" }

interface DraftCandidate {
  readonly reply: string
  readonly tokens: readonly string[]
  readonly evidence: readonly Evidence[]
}

interface ApprovedAnswer {
  readonly reply: string
  readonly tokens: readonly string[]
  readonly references: readonly AnswerReference[]
  readonly answerBasis?: AnswerBasis
}

type KnowledgeRefusal =
  | "insufficient_retrieval"
  | "insufficient_evidence"
  | "invalid_citation"
  | "provider_error"
  | "handoff_required"

type KnowledgeOutcome =
  | { readonly kind: "completed"; readonly answer: ApprovedAnswer }
  | { readonly kind: "refused"; readonly status: KnowledgeRefusal }

export type KnowledgeState =
  | { readonly kind: "routing"; readonly expectedRoute: KnowledgeRoute }
  | { readonly kind: "retrieving"; readonly route: KnowledgeRoute; readonly attempt: KnowledgeAttempt }
  | { readonly kind: "assembling"; readonly route: KnowledgeRoute; readonly attempt: KnowledgeAttempt }
  | { readonly kind: "generating"; readonly route: KnowledgeRoute; readonly attempt: KnowledgeAttempt }
  | { readonly kind: "validating"; readonly route: KnowledgeRoute; readonly round: ValidationRound; readonly candidate: DraftCandidate }
  | { readonly kind: "replanning"; readonly route: KnowledgeRoute; readonly failedRound: ValidationRound }
  | { readonly kind: "approved"; readonly candidate: DraftCandidate; readonly basis?: AnswerBasis }
  | { readonly kind: "ready_to_commit"; readonly answer: ApprovedAnswer }
  | { readonly kind: "handoff_pending"; readonly reason: "coverage_not_met" }
  | { readonly kind: "resolved"; readonly outcome: KnowledgeOutcome }

export type KnowledgeObservation =
  | { readonly type: "route_selected"; readonly route: RouterDecision }
  | { readonly type: "retrieval_finished"; readonly result: "usable" | "unavailable" | "empty" | "provider_failure" }
  | { readonly type: "context_prepared" }
  | { readonly type: "draft_checked"; readonly draft: DraftCandidate; readonly citations: "valid" | "invalid" }
  | { readonly type: "validation_finished"; readonly verdict: CriticVerdict }
  | { readonly type: "gaps_planned"; readonly result: "queries_available" | "exhausted" }
  | { readonly type: "publication_checked"; readonly references: readonly AnswerReference[] }
  | { readonly type: "answer_committed" }
  | { readonly type: "handoff_finished"; readonly result: "created" | "unavailable" }

type DeliveryFailure =
  | { readonly kind: "cancelled"; readonly resourceBudgetExceeded?: boolean }
  | { readonly kind: "provider_error"; readonly resourceBudgetExceeded: boolean }

type DeliveryResolution<T> =
  | { readonly kind: "fulfilled"; readonly output: T }
  | { readonly kind: "rejected"; readonly failure: DeliveryFailure }

export type AnswerDeliveryState<T> =
  | { readonly kind: "created" }
  | { readonly kind: "running" }
  | { readonly kind: "settled"; readonly resolution: DeliveryResolution<T> }
  | { readonly kind: "terminal"; readonly resolution: DeliveryResolution<T> }

type DeliveryObservation<T> =
  | { readonly type: "runner_started" }
  | { readonly type: "runner_fulfilled"; readonly output: T }
  | { readonly type: "runner_rejected"; readonly failure: DeliveryFailure }
  | { readonly type: "terminal_claimed" }

class InvalidAnswerTransition extends Error {
  readonly name = "InvalidAnswerTransition"

  constructor(
    readonly from: KnowledgeState["kind"] | AnswerDeliveryState<unknown>["kind"],
    readonly observation: string,
    readonly reason: "wrong_phase" | "wrong_owner" | "already_terminal",
  ) {
    super(`Cannot apply ${observation} in ${from}: ${reason}`)
  }
}

type TransitionResult<S> =
  | { readonly kind: "accepted"; readonly state: S }
  | { readonly kind: "rejected"; readonly state: S; readonly error: InvalidAnswerTransition }

interface KnowledgeAnswerMachine {
  readonly state: KnowledgeState
  advance(observation: KnowledgeObservation): TransitionResult<KnowledgeState>
}

export function createKnowledgeAnswerMachine(expectedRoute: KnowledgeRoute): KnowledgeAnswerMachine {
  let state: KnowledgeState = { kind: "routing", expectedRoute }

  return {
    get state() { return state },
    advance(observation) {
      let next: KnowledgeState | undefined
      let reason: InvalidAnswerTransition["reason"] = "wrong_phase"
      switch (state.kind) {
        case "routing":
          if (observation.type === "route_selected") {
            if (observation.route === state.expectedRoute) {
              next = { kind: "retrieving", route: state.expectedRoute, attempt: { kind: "validate", round: 1 } }
            } else {
              reason = "wrong_owner"
            }
          }
          break
        case "retrieving":
          if (observation.type === "retrieval_finished") {
            switch (observation.result) {
              case "usable":
                next = { kind: "assembling", route: state.route, attempt: state.attempt }
                break
              case "unavailable":
                next = { kind: "resolved", outcome: { kind: "refused", status: "insufficient_retrieval" } }
                break
              case "provider_failure":
                next = { kind: "resolved", outcome: { kind: "refused", status: "provider_error" } }
                break
              case "empty":
                next = state.attempt.kind === "validate" && state.attempt.round === 1
                  ? { kind: "resolved", outcome: { kind: "refused", status: "insufficient_evidence" } }
                  : { kind: "handoff_pending", reason: "coverage_not_met" }
                break
              default: {
                const exhaustive: never = observation
                return exhaustive
              }
            }
          }
          break
        case "assembling":
          if (observation.type === "context_prepared") {
            next = { kind: "generating", route: state.route, attempt: state.attempt }
          }
          break
        case "generating":
          if (observation.type === "draft_checked") {
            if (observation.citations === "invalid") {
              next = { kind: "resolved", outcome: { kind: "refused", status: "invalid_citation" } }
            } else if (state.attempt.kind === "last_regeneration") {
              next = { kind: "handoff_pending", reason: "coverage_not_met" }
            } else {
              next = {
                kind: "validating", route: state.route, round: state.attempt.round,
                candidate: { ...observation.draft, tokens: [...observation.draft.tokens], evidence: [...observation.draft.evidence] },
              }
            }
          }
          break
        case "validating":
          if (observation.type === "validation_finished") {
            next = observation.verdict.passed
              ? { kind: "approved", candidate: state.candidate, basis: observation.verdict.answerBasis }
              : { kind: "replanning", route: state.route, failedRound: state.round }
          }
          break
        case "replanning":
          if (observation.type === "gaps_planned") {
            const nextAttempt: Record<ValidationRound, KnowledgeAttempt> = {
              1: { kind: "validate", round: 2 },
              2: { kind: "validate", round: 3 },
              3: { kind: "last_regeneration" },
            }
            next = observation.result === "exhausted"
              ? { kind: "handoff_pending", reason: "coverage_not_met" }
              : { kind: "retrieving", route: state.route, attempt: nextAttempt[state.failedRound] }
          }
          break
        case "approved":
          if (observation.type === "publication_checked") {
            const references = [...observation.references]
            const answerBasis = bindAnswerBasis(state.basis, references)
            next = references.length === 0
              ? { kind: "resolved", outcome: { kind: "refused", status: "insufficient_evidence" } }
              : {
                  kind: "ready_to_commit",
                  answer: {
                    reply: state.candidate.reply, tokens: state.candidate.tokens, references,
                    ...(answerBasis ? { answerBasis } : {}),
                  },
                }
          }
          break
        case "ready_to_commit":
          if (observation.type === "answer_committed") {
            next = { kind: "resolved", outcome: { kind: "completed", answer: state.answer } }
          }
          break
        case "handoff_pending":
          if (observation.type === "handoff_finished") {
            next = {
              kind: "resolved",
              outcome: { kind: "refused", status: observation.result === "created" ? "handoff_required" : "insufficient_evidence" },
            }
          }
          break
        case "resolved":
          reason = "already_terminal"
          break
        default: {
          const exhaustive: never = state
          return exhaustive
        }
      }
      if (!next) {
        return { kind: "rejected", state, error: new InvalidAnswerTransition(state.kind, observation.type, reason) }
      }
      state = next
      return { kind: "accepted", state }
    },
  }
}

interface AnswerDeliveryMachine<T> {
  readonly state: AnswerDeliveryState<T>
  advance(observation: DeliveryObservation<T>): TransitionResult<AnswerDeliveryState<T>>
}

export function createAnswerDeliveryMachine<T>(): AnswerDeliveryMachine<T> {
  let state: AnswerDeliveryState<T> = { kind: "created" }

  return {
    get state() { return state },
    advance(observation) {
      let next: AnswerDeliveryState<T> | undefined
      switch (state.kind) {
        case "created":
          if (observation.type === "runner_started") next = { kind: "running" }
          if (observation.type === "runner_rejected") next = { kind: "settled", resolution: { kind: "rejected", failure: observation.failure } }
          break
        case "running":
          if (observation.type === "runner_fulfilled") next = { kind: "settled", resolution: { kind: "fulfilled", output: observation.output } }
          if (observation.type === "runner_rejected") next = { kind: "settled", resolution: { kind: "rejected", failure: observation.failure } }
          break
        case "settled":
          if (observation.type === "terminal_claimed") next = { kind: "terminal", resolution: state.resolution }
          break
        case "terminal":
          break
        default: {
          const exhaustive: never = state
          return exhaustive
        }
      }
      if (!next) {
        return {
          kind: "rejected", state,
          error: new InvalidAnswerTransition(state.kind, observation.type, state.kind === "terminal" ? "already_terminal" : "wrong_phase"),
        }
      }
      state = next
      return { kind: "accepted", state }
    },
  }
}
