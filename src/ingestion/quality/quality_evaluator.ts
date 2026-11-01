// Ticket 07: per-page quality evaluator.
//
// One pass over every declared page, each page judged alone in its own request
// (the measured one-page-per-request policy), with each answer staying bound to
// the page whose question asked for it. The document result is the fail-closed
// contract reducer: any failing, uncertain or unexamined page blocks the pass.
// Four outcomes stay distinct forever: a quality failure and uncertainty are
// verdicts, an invalid response is the provider answering unusably, and a
// service failure is the provider not answering at all — neither fault is ever
// reshaped into a verdict. Verdicts follow the answer's choice field alone;
// probabilities and confidence are recorded for audit and never thresholded.
//
// Ticket 18: a page request that fails with a TRANSIENT provider fault — a
// timeout, a connection failure, a rate limit or a server error — is retried
// inside the walk against the bounded budget the caller hands in (the gate
// wires the shared ingestion budget), and every batch records how many
// attempts it spent plus its own usage. Permanent protocol and
// invalid-response faults are never retried, cancellation interrupts a wait
// immediately, and an exhausted budget stays a service failure — never a
// verdict, and never a loop.
import type { TokenUsage } from "../../types"
import { ClefProtocolError, classifyClefError, clefErrorCode, type ClefProtocolErrorCode } from "../../clef/protocol_errors"
import {
  QUALITY_RULE_VERSION,
  QualityContractError,
  reduceDocumentQuality,
  type DocumentQualityOutcome,
  type PageQualityVerdict,
  type QualityContractErrorCode,
} from "./contract"
import type { QualityBatchOutcome } from "./clef_page_quality"
import type { QualityPageEvidence } from "./evidence"
import type { QualityRequestInput } from "./request"

/** The one evaluation seam: production binds it to `ClefPageQualityClient.evaluateBatch`. */
export type QualityBatchEvaluator = (
  input: QualityRequestInput,
  callOptions?: { signal?: AbortSignal }
) => Promise<QualityBatchOutcome>

/** How one page's evaluation ended. A verdict, an invalid response and a service fault are never merged. */
export type PageEvaluationKind = "verdict" | "invalid_response" | "service_failure"

export interface PageEvaluation {
  page: number
  kind: PageEvaluationKind
  /** Present only for kind "verdict". */
  verdict?: PageQualityVerdict
  /** Present only for kind "invalid_response": the stable contract code the response failed. */
  code?: QualityContractErrorCode
  /** Present only for kind "service_failure": the shared Clef taxonomy code of the fault. */
  classification?: ClefProtocolErrorCode
  /**
   * Ticket 18: how many provider requests this batch needed — 1 when the first
   * answer stood, more when transient faults consumed retries, and the full
   * budget plus one when the retries were exhausted. Recorded per batch for
   * recovery and diagnostics.
   */
  attempts: number
  /**
   * Ticket 18: this batch's own usage. A faulted page records zero — its true
   * provider cost never reached us, and inventing a number would be a claim.
   */
  usage: TokenUsage
}

export interface DocumentQualityEvaluation {
  /** Fail-closed reducer result over every declared page; failing, uncertain and unexamined pages block the pass. */
  document: DocumentQualityOutcome
  /** Per-page outcomes in page order, each in exactly one distinct kind. */
  pages: readonly PageEvaluation[]
  usage: TokenUsage
}

/**
 * The contract codes the response parser can raise once a request is on the wire.
 * Anything else a QualityBatchEvaluator throws is evidence-side and crashes loudly
 * instead of posing as a provider-response outcome.
 */
const RESPONSE_FAULT_CODES: ReadonlySet<QualityContractErrorCode> = new Set<QualityContractErrorCode>([
  "response_envelope_invalid",
  "response_usage_invalid",
  "answer_missing",
  "answer_question_invalid",
  "answer_page_unrequested",
  "answer_page_missing",
  "answer_issue_missing",
  "answer_type_invalid",
  "answer_verdict_invalid",
  "answer_issue_label_invalid",
  "answer_probability_invalid",
  "answer_confidence_invalid",
  "answer_verdict_incoherent",
  "answer_issue_incoherent",
  "issue_label_conflict",
])

const EMPTY_USAGE: TokenUsage = Object.freeze({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })

const zeroUsage = (): TokenUsage => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })

/**
 * Ticket 18: the transient class of Clef provider faults — the only faults
 * with evidence-backed grounds to spend another attempt. A timeout, a
 * connection failure, a rate limit (HTTP 429) and a server error (HTTP 5xx)
 * may answer differently on a second request; a permanent protocol fault,
 * an invalid response or an unknown fault may not, and gets no retry.
 * Ticket 28: the fault travels as its taxonomy code and optional HTTP status —
 * the decision-call executor raises its faults as tagged plain Errors that
 * carry no `code`/`status` properties, so the check reads the classified tag.
 */
function isTransientClefFault(code: ClefProtocolErrorCode, status?: number): boolean {
  if (code === "timeout" || code === "transport") return true
  if (code === "http_status") {
    return status === 429 || (status !== undefined && status >= 500)
  }
  return false
}

/**
 * Waits out one retry delay with the run's own cancellation semantics: an
 * aborted signal rejects immediately — before and during the wait — so a
 * cancelled or superseded run never sits out a backoff it will not spend.
 * Ticket 19: shared with the page-quality gate, whose whole-document OCR
 * attempt waits out the same bounded budget between transient retries.
 */
export function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abortReason = () =>
      signal?.reason ?? new DOMException("The operation was aborted", "AbortError")
    if (signal?.aborted) {
      reject(abortReason())
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(abortReason())
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }
    signal?.addEventListener("abort", onAbort)
  })
}

/**
 * Evaluates every declared page, one request per page in page order. Verdict pages never stop
 * the walk — the document keeps their full audit — while an invalid response or a service
 * failure stops spending on further requests: the transport or the provider is broken, and the
 * remaining pages stay unexamined, which blocks the pass.
 *
 * Ticket 18: a transient fault does not stop the walk by itself. The page's
 * request is retried while the caller's budget (`retryDelays`) still has
 * entries, waiting out each entry with cancellation honored; a fault with no
 * budget entry left — or a permanent protocol fault, which is never retried —
 * ends the page as a service failure whose `attempts` records what was spent.
 * Without a budget the walk keeps its pre-ticket shape: one attempt per page.
 */
export async function evaluateDocumentQuality(input: {
  pages: readonly QualityPageEvidence[]
  documentPageCount: number
  evaluateBatch: QualityBatchEvaluator
  ruleVersion?: string
  signal?: AbortSignal
  /**
   * Ticket 18: the bounded transient-retry budget, one wait entry per retry.
   * Production (the page-quality gate) wires the shared ingestion budget;
   * absent or empty means no retry — one attempt per page.
   */
  retryDelays?: readonly number[]
}): Promise<DocumentQualityEvaluation> {
  input.signal?.throwIfAborted()
  const ruleVersion = input.ruleVersion ?? QUALITY_RULE_VERSION
  const retryDelays = input.retryDelays ?? []
  const ordered = [...input.pages].sort((left, right) => left.page - right.page)

  const pages: PageEvaluation[] = []
  const verdicts: PageQualityVerdict[] = []
  const usage: TokenUsage = { ...EMPTY_USAGE }

  for (const page of ordered) {
    let settled: PageEvaluation | undefined
    let attempts = 0
    while (settled === undefined) {
      input.signal?.throwIfAborted()
      attempts += 1
      try {
        const batch = await input.evaluateBatch(
          { pages: [page], documentPageCount: input.documentPageCount, ruleVersion },
          { signal: input.signal }
        )
        input.signal?.throwIfAborted()
        for (const verdict of batch.verdicts) {
          verdicts.push(verdict)
          usage.promptTokens += batch.usage.promptTokens
          usage.completionTokens += batch.usage.completionTokens
          usage.totalTokens += batch.usage.totalTokens
        }
        settled = Object.freeze({
          page: page.page,
          kind: "verdict",
          verdict: batch.verdicts[0],
          attempts,
          usage: { ...batch.usage },
        })
      } catch (error) {
        // Cancellation stops pending and future calls outright: never reshaped,
        // never retried, never sat out in a backoff.
        if (classifyClefError(error) === "cancelled") throw error
        if (error instanceof QualityContractError && RESPONSE_FAULT_CODES.has(error.code)) {
          settled = Object.freeze({
            page: page.page,
            kind: "invalid_response",
            code: error.code,
            attempts,
            usage: zeroUsage(),
          })
          break
        }
        // Ticket 28: the decision-call executor raises its faults as TAGGED
        // plain Errors, not ClefProtocolError instances — the taxonomy tag is
        // the contract, so executor-raised faults follow the same retry and
        // settlement policy as the client's own protocol errors. Untagged
        // errors (a run-budget error, a request-builder bug) keep crashing
        // loudly instead of posing as a provider-response outcome.
        const clefCode = error instanceof ClefProtocolError ? error.code : clefErrorCode(error)
        if (clefCode !== undefined) {
          const retryIndex = attempts - 1
          const delay = isTransientClefFault(
            clefCode,
            error instanceof ClefProtocolError ? error.status : undefined
          ) && retryIndex < retryDelays.length
            ? retryDelays[retryIndex]
            : undefined
          if (delay === undefined) {
            settled = Object.freeze({
              page: page.page,
              kind: "service_failure",
              classification: clefCode,
              attempts,
              usage: zeroUsage(),
            })
            break
          }
          await delayWithSignal(delay, input.signal)
          continue
        }
        throw error
      }
    }
    pages.push(settled)
    // A faulted page stops spending on further requests: the remaining pages
    // stay unexamined, which is what blocks the pass. (Ticket 18: retries live
    // inside the page's own budget above; once the page settles on a fault,
    // the walk itself stops exactly as it did before.)
    if (settled.kind !== "verdict") break
  }

  const declaredPages = Array.from({ length: input.documentPageCount }, (_, index) => index + 1)
  const document = reduceDocumentQuality({ ruleVersion, declaredPages, verdicts })
  return Object.freeze({
    document,
    pages: Object.freeze(pages),
    usage: Object.freeze(usage),
  })
}
