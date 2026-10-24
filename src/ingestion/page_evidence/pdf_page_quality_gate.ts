// Ticket 08: the smallest end-to-end PDF quality path.
//
// The page-quality gate that Tickets 04/07/20/25 built their seams for: the
// locally extracted candidate is grounded page by page (its own text plus its
// own render), every page is judged alone in its own Clef request, and the
// pass signal is a recorded dual-stage audit that the content-binding gate
// re-verifies — the same envelope shape a later OCR fallback (Ticket 12)
// would join. OCR is never consulted here: a local extraction that passes
// quality IS the accepted candidate, and nothing downstream re-opens that
// decision. Cancellation propagates through the evaluator seam (an AbortError
// is re-raised, never reshaped into a verdict), so a cancelled or superseded
// run persists no audit and cannot release the gate.
import { QUALITY_CLEF_MODEL_ID } from "../quality/contract"
import { validateQualityPages } from "../quality/evidence"
import { OcrApiError, RETRY_DELAYS_MS } from "../error_classification"
import {
  messageSafeCode,
  PdfQualityRejectionError,
  type PdfQualityGate,
  type PdfQualityGateCandidate,
  type PdfQualityGateResult,
} from "../quality/pdf_ocr_fallback_flag"
import {
  delayWithSignal,
  evaluateDocumentQuality,
  type DocumentQualityEvaluation,
  type QualityBatchEvaluator,
} from "../quality/quality_evaluator"
import {
  createDualStageEvidenceEnvelope,
  recordQualityStageAudit,
  setStageCandidate,
  type DualStageEvidenceEnvelope,
  type DualStageSource,
  type QualityAuditOutcome,
  type QualityStageAudit,
} from "./dual_stage_envelope"
import type { PdfExtractionEvidenceBundle } from "./page_evidence"
import { evaluateQualityGate, type QualityGateDecision } from "./quality_gate"
import { deriveQualityPageEvidence, imageEvidence } from "./quality_bridge"

/** The audit trail the successful path persists. */
export interface PdfPageQualityAuditRecord {
  docId: string
  version: number
  candidateId: string
  envelope: DualStageEvidenceEnvelope
  decision: QualityGateDecision
}

export interface PdfPageQualityDiagnosticRecord extends PdfPageQualityAuditRecord {
  diagnostic: true
  reusable: false
  faultPages: readonly {
    stage: DualStageSource
    page: number
    attempts: number
    reasonCode: string
    errorCategory: "invalid_response" | "service_failure"
    verdict: null
  }[]
}

/**
 * Ticket 12: one whole-document OCR fallback attempt. The attempt is the
 * document-level pass; `providerCallCount` is how many provider HTTP calls it
 * issued (Volcengine batches ≤16 pages per call) — the persisted evidence
 * reports both numbers.
 */
export interface PdfOcrFallbackAttempt {
  /** One text per declared page, index 0 = page 1 (page identity preserved). */
  pageTexts: readonly string[]
  providerCallCount: number
}

export interface PdfPageQualityGateOptions {
  /**
   * Grounds the audited candidate as page-aligned evidence (per-page text +
   * per-page render). The production wiring derives it from the candidate's
   * own extraction evidence record; tests inject a synthetic bundle.
   */
  evidenceFor(candidate: PdfQualityGateCandidate): PdfExtractionEvidenceBundle
  /** The one-page-per-request Clef seam (production binds ClefPageQualityClient.evaluateBatch). */
  evaluateBatch: QualityBatchEvaluator
  /** Where the accepted audit envelope lands. */
  persist(record: PdfPageQualityAuditRecord): void
  /** Fault evidence is durable but never eligible for approval or audit reuse. */
  persistDiagnostic?(record: PdfPageQualityDiagnosticRecord): void
  /**
   * Ticket 23: where a REJECTED second audit's evidence lands. Only the OCR
   * fallback's second-audit rejection persists — the durable record that the
   * one whole-document attempt was spent and its audit said no, so a resume
   * re-raises the rejection instead of re-spending the attempt on identical
   * input. Provider faults use persistDiagnostic instead and remain retryable
   * on a later explicitly requested run. Production binds the merge writer.
   */
  persistRejection?(record: PdfPageQualityAuditRecord): void
  now?(): Date
  /**
   * Ticket 12: the whole-document OCR fallback seam. Present → a local
   * all-page fail/uncertain audit triggers the whole-document attempt (its
   * OCR text joins the SAME page evaluator with the original page images for
   * a second audit); absent → the local result stands, fail-closed as before.
   * Ticket 19: the attempt rides the Volcengine fault taxonomy — a transient
   * fault (timeout, rate limit, connection failure, server error) consumes
   * the bounded budget before the attempt can end, while a permanent input or
   * capability fault surfaces directly and a cancellation stops everything.
   * Whatever attempt does return is still audited at most once.
   */
  ocrFallback?(input: {
    pageCount: number
    signal: AbortSignal
  }): Promise<PdfOcrFallbackAttempt>
  /**
   * Ticket 19: the bounded transient-retry budget for the whole-document OCR
   * fallback attempt. Between attempts the gate waits out the next delay, so
   * a hard rate-limited service is never met with self-inflicted rapid
   * retries that exhaust the budget a second later would have survived.
   * Defaults to the shared ingestion budget; an empty array means one attempt.
   */
  ocrRetryDelays?: readonly number[]
  /**
   * Ticket 24: the fingerprint of the OCR configuration behind the
   * `ocrFallback` seam. Stamped onto every `ocr_candidate` stage audit so a
   * resume can tell which configuration produced the OCR evidence and
   * invalidate the stage when the configuration changed. Absent → the audit
   * carries no fingerprint (and reuse of such records fails the comparison).
   */
  ocrParserConfigVersion?: string
  /**
   * Ticket 18: the bounded transient-retry budget for every Clef page request
   * (both audit stages). Defaults to the shared ingestion budget; a test may
   * shrink it. Empty or absent of entries means one attempt per page.
   */
  retryDelays?: readonly number[]
}

/**
 * Maps the evaluator's four distinct outcomes onto the audit vocabulary.
 * A quality failure or uncertainty is a rejection; an unusable provider
 * response and an unanswered provider stay their own kinds — never verdicts.
 */
function auditOutcome(evaluation: DocumentQualityEvaluation): QualityAuditOutcome {
  if (evaluation.document.passed) return "passed"
  if (evaluation.pages.some((page) => page.kind === "invalid_response")) return "invalid_response"
  if (evaluation.pages.some((page) => page.kind === "service_failure")) return "service_fault"
  return "rejected"
}

/**
 * Stable rejection reason codes: issue label + page for quality failures,
 * `uncertain` + page for undecided pages, the contract/taxonomy code +
 * page for provider faults, and `missing_evidence` + page for every page the
 * audit never covered (ticket 15: named, never silently absorbed by the fault
 * code that stopped the walk). Never model prose, never page text.
 */
function rejectionReasonCodes(evaluation: DocumentQualityEvaluation): string[] {
  const codes: string[] = []
  for (const page of evaluation.pages) {
    if (page.kind === "verdict") {
      const verdict = page.verdict!
      // A passed page needs no reason code; only failures and undecided
      // pages explain why the document did not pass.
      if (verdict.verdict === "fail") {
        codes.push(`${verdict.issueType ?? "quality_failed"}:${page.page}`)
      } else if (verdict.verdict === "uncertain") {
        codes.push(`uncertain:${page.page}`)
      }
    } else if (page.kind === "invalid_response") {
      codes.push(`${page.code}:${page.page}`)
    } else {
      codes.push(`service_failure:${page.classification ?? "unknown"}:${page.page}`)
    }
  }
  // Ticket 15: pages the stopped walk left unexamined are missing evidence —
  // they block the pass on their own and are reported alongside the fault.
  // The faulted page itself has no verdict either, but its own fault code
  // already names it; only the pages no code covers are missing evidence.
  const reported = new Set(evaluation.pages.map((page) => page.page))
  for (const page of evaluation.document.unexaminedPages) {
    if (!reported.has(page)) codes.push(`missing_evidence:${page}`)
  }
  return codes
}

export class PdfPageQualityGate implements PdfQualityGate {
  constructor(private readonly options: PdfPageQualityGateOptions) {}

  async audit(candidate: PdfQualityGateCandidate): Promise<PdfQualityGateResult> {
    const bundle = this.options.evidenceFor(candidate)
    const pages = validateQualityPages(deriveQualityPageEvidence(bundle))
    const identity = bundle.identity
    const auditClock = this.options.now ?? (() => new Date())
    const auditStartMs = auditClock().getTime()
    const ranAt = new Date(auditStartMs).toISOString()

    // One request per page, in page order; an AbortError from a cancelled or
    // superseded run is re-raised by the evaluator — nothing below runs. An
    // input that cannot fit the measured transport limits fails explicitly
    // from the validation above or the request builder — never truncated.
    // Ticket 18: a transient provider fault consumes the bounded retry budget
    // before it can end the audit; the budget is the shared ingestion one.
    const evaluation = await evaluateDocumentQuality({
      pages,
      documentPageCount: bundle.declaredPageCount,
      evaluateBatch: this.options.evaluateBatch,
      signal: candidate.signal,
      retryDelays: this.options.retryDelays ?? RETRY_DELAYS_MS,
    })

    const outcome = auditOutcome(evaluation)
    const envelope = recordQualityStageAudit(
      createDualStageEvidenceEnvelope({
        originalFile: identity.originalFile,
        declaredPageCount: bundle.declaredPageCount,
        evidenceVersion: bundle.evidenceVersion,
        localCandidateId: identity.candidateId,
      }),
      this.stageAudit("local_extraction", identity.candidateId, evaluation, outcome, auditStartMs, auditClock, ranAt)
    )

    // Ticket 12: a local all-page fail or uncertain result — and only that —
    // hands the decision to exactly one whole-document OCR attempt. An invalid
    // response or a service fault is the provider failing, not the document
    // failing quality, so it never triggers OCR (ticket 11 terminality).
    if (outcome === "rejected" && this.options.ocrFallback) {
      return this.auditWithOcrFallback({
        candidate,
        bundle,
        envelope,
        localEvaluation: evaluation,
        localCodes: rejectionReasonCodes(evaluation),
        auditClock,
      })
    }

    if (outcome !== "passed") {
      if (outcome === "service_fault" || outcome === "invalid_response") {
        this.persistFaultDiagnostic(candidate, envelope, "local_extraction", evaluation, rejectionReasonCodes(evaluation))
      }
      const maxAttempts = Math.max(...evaluation.pages.map((page) => page.attempts), 1)
      throw new PdfQualityRejectionError(
        rejectionReasonCodes(evaluation),
        // Ticket 18: a provider-fault stop reports how far the bounded budget
        // went — the count is digit-protected so it can never read like an
        // HTTP status to the task-level classifier.
        outcome === "service_fault" || outcome === "invalid_response"
          ? `the audit stopped on a provider fault after at most ${messageSafeCode(String(maxAttempts))} attempt(s) on a page`
          : undefined
      )
    }

    // Re-verify the recorded envelope through the content-binding gate —
    // exactly the decision a restart would reach from the persisted record.
    const decision = evaluateQualityGate({
      envelope,
      identity,
      stage: "local_extraction",
    })
    if (!decision.passed) {
      throw new PdfQualityRejectionError(decision.reasonCodes)
    }

    this.options.persist({
      docId: candidate.docId,
      version: candidate.version,
      candidateId: identity.candidateId,
      envelope,
      decision,
    })
    // Ticket 09: the summary carries the complete per-page audit — every
    // declared page with its own verdict — so recovery and the frontend can
    // render page-level state from the task record alone.
    return {
      verdict: "pass",
      reasonCodes: [],
      ocrFallbackUsed: false,
      pageAudits: evaluation.document.verdicts.map((verdict) => ({
        page: verdict.page,
        verdict: verdict.verdict,
        ...(verdict.issueType ? { issueType: verdict.issueType } : {}),
      })),
    }
  }

  private persistFaultDiagnostic(candidate: PdfQualityGateCandidate, envelope: DualStageEvidenceEnvelope, stage: DualStageSource, evaluation: DocumentQualityEvaluation, reasonCodes: readonly string[]): void {
    candidate.signal.throwIfAborted()
    this.options.persistDiagnostic?.({
      docId: candidate.docId,
      version: candidate.version,
      candidateId: envelope.stages[stage].candidateId!,
      envelope,
      decision: { passed: false, reasonCodes: [...reasonCodes], reason: reasonCodes.join(";") },
      diagnostic: true,
      reusable: false,
      faultPages: evaluation.pages.filter((page) => page.kind !== "verdict").map((page) => ({
        stage, page: page.page, attempts: page.attempts,
        reasonCode: page.kind === "service_failure" ? `service_failure:${page.classification}:${page.page}` : `${page.code}:${page.page}`,
        errorCategory: page.kind as "invalid_response" | "service_failure",
        verdict: null,
      })),
    })
  }

  /** One stage's audit record from one evaluator pass (shared by both stages). */
  private stageAudit(
    stage: DualStageSource,
    candidateId: string,
    evaluation: DocumentQualityEvaluation,
    outcome: QualityAuditOutcome,
    startMs: number,
    auditClock: () => Date,
    ranAt: string,
    ocrProviderCallCount?: number
  ): QualityStageAudit {
    return {
      stage,
      candidateId,
      clefModel: QUALITY_CLEF_MODEL_ID,
      ruleVersion: evaluation.document.ruleVersion,
      outcome,
      ranAt,
      requests: evaluation.pages.map((page) => ({
        requestId: `page-${page.page}`,
        pages: [page.page],
        // Ticket 18: per-batch usage is attributable now that every request is
        // one page. A faulted request records null — its true provider cost
        // never reached us, and inventing a number would be a claim.
        usage: page.kind === "verdict" ? { ...page.usage } : null,
        // Ticket 18: how many attempts the request spent, transient retries
        // included, for recovery and diagnostics.
        attempts: page.attempts,
        startedAt: ranAt,
        finishedAt: ranAt,
      })),
      verdicts: evaluation.document.verdicts,
      // Ticket 10: the aggregate cost of every per-page request, persisted
      // with the audit for recovery and release evidence.
      usage: { ...evaluation.usage },
      durationMs: Math.max(0, auditClock().getTime() - startMs),
      ...(ocrProviderCallCount !== undefined ? { ocrProviderCallCount } : {}),
      // Ticket 24: only the OCR stage records which OCR configuration
      // produced its candidate — local evidence is independent of it.
      ...(stage === "ocr_candidate" && this.options.ocrParserConfigVersion !== undefined
        ? { ocrParserConfigVersion: this.options.ocrParserConfigVersion }
        : {}),
    }
  }

  /**
   * Ticket 12: the one whole-document OCR attempt and its second audit. The
   * OCR candidate keeps page identity — original page image plus the OCR text
   * for that page — and is audited by the SAME evaluator. Its audit joins the
   * same envelope as a separate `ocr_candidate` stage, kept apart from local
   * extraction and persisted only once the second audit passes. Ticket 19:
   * the attempt itself rides the Volcengine taxonomy — transient faults
   * consume the bounded budget (with a growing wait between attempts) before
   * the attempt can end, and whatever attempt does return is audited at most
   * once; a second-audit failure rejects the candidate with both stages'
   * reason codes.
   */
  private async auditWithOcrFallback(args: {
    candidate: PdfQualityGateCandidate
    bundle: PdfExtractionEvidenceBundle
    envelope: DualStageEvidenceEnvelope
    localEvaluation: DocumentQualityEvaluation
    localCodes: readonly string[]
    auditClock: () => Date
  }): Promise<PdfQualityGateResult> {
    const { candidate, bundle, envelope, localCodes, auditClock } = args
    const identity = bundle.identity
    const fallbackStartMs = auditClock().getTime()
    const fallbackRanAt = new Date(fallbackStartMs).toISOString()

    // Ticket 19: the attempt rides the existing Volcengine fault taxonomy. A
    // transient fault (timeout, rate limit, connection failure, server error)
    // consumes the bounded budget with a growing wait between attempts, so a
    // hard rate-limited service is not met with self-inflicted rapid retries;
    // exhaustion ends the attempt as a terminal service-unavailable rejection
    // — never a quality pass. A permanent input or capability fault surfaces
    // directly, and a cancellation (AbortError) stops the attempt and any
    // pending wait at once.
    const attempt = await this.attemptWholeDocumentOcr({
      pageCount: bundle.declaredPageCount,
      signal: candidate.signal,
      retryDelays: this.options.ocrRetryDelays ?? RETRY_DELAYS_MS,
      localCodes,
    })
    if (
      !attempt ||
      !Array.isArray(attempt.pageTexts) ||
      attempt.pageTexts.length !== bundle.declaredPageCount
    ) {
      throw new Error(
        `the OCR fallback attempt must return one text per declared page (${bundle.declaredPageCount})`
      )
    }
    if (!Number.isSafeInteger(attempt.providerCallCount) || attempt.providerCallCount < 0) {
      throw new Error("the OCR fallback attempt must report a non-negative provider call count")
    }

    // Page identity preserved: original page image + that page's OCR text.
    const ocrPages = attempt.pageTexts.map((text, index) => {
      const page = index + 1
      if (text.trim() === "") {
        throw new PdfQualityRejectionError([...localCodes, `ocr_fallback:empty_page:${page}`])
      }
      return {
        page,
        image: imageEvidence(bundle.pages[index]),
        extractedText: text,
        textLayerAbsent: false,
      }
    })
    const ocrEvidence = validateQualityPages(ocrPages)

    // The same evaluator judges the OCR candidate, one request per page.
    const fallbackEvaluation = await evaluateDocumentQuality({
      pages: ocrEvidence,
      documentPageCount: bundle.declaredPageCount,
      evaluateBatch: this.options.evaluateBatch,
      signal: candidate.signal,
      retryDelays: this.options.retryDelays ?? RETRY_DELAYS_MS,
    })
    const fallbackOutcome = auditOutcome(fallbackEvaluation)

    // The OCR candidate IS this candidate's second evidence source, so the
    // stage slot carries the same candidate id before it can take its audit.
    const auditedEnvelope = recordQualityStageAudit(
      setStageCandidate(envelope, "ocr_candidate", identity.candidateId),
      this.stageAudit(
        "ocr_candidate",
        identity.candidateId,
        fallbackEvaluation,
        fallbackOutcome,
        fallbackStartMs,
        auditClock,
        fallbackRanAt,
        attempt.providerCallCount
      )
    )

    if (fallbackOutcome !== "passed") {
      const rejectionCodes = [
        ...localCodes,
        ...rejectionReasonCodes(fallbackEvaluation).map((code) => `ocr_fallback:${code}`),
      ]
      // Ticket 23: the rejection itself is durable evidence — the record that
      // the one whole-document attempt was spent on THIS candidate and its
      // audit said no. A resume re-raises it (no new OCR attempt, no new Clef
      // spend) instead of re-running the identical audit.
      candidate.signal.throwIfAborted()
      if (fallbackOutcome === "rejected") {
        this.options.persistRejection?.({
          docId: candidate.docId,
          version: candidate.version,
          candidateId: identity.candidateId,
          envelope: auditedEnvelope,
          decision: { passed: false, reasonCodes: rejectionCodes, reason: rejectionCodes.join(";") },
        })
      } else {
        this.persistFaultDiagnostic(candidate, auditedEnvelope, "ocr_candidate", fallbackEvaluation, rejectionCodes)
      }
      throw new PdfQualityRejectionError(
        rejectionCodes,
        // Ticket 14: the failure record states ticket 12's two numbers — the
        // single attempt and its provider call count. The count is digit-
        // protected so it can never read like an HTTP status to the classifier.
        `one whole-document OCR attempt was spent issuing ${messageSafeCode(String(attempt.providerCallCount))} provider call(s)`
      )
    }

    // Re-verify through the content-binding gate over the OCR stage — exactly
    // the decision a restart would reach from the persisted record.
    const decision = evaluateQualityGate({
      envelope: auditedEnvelope,
      identity,
      stage: "ocr_candidate",
    })
    if (!decision.passed) {
      throw new PdfQualityRejectionError(decision.reasonCodes)
    }

    this.options.persist({
      docId: candidate.docId,
      version: candidate.version,
      candidateId: identity.candidateId,
      envelope: auditedEnvelope,
      decision,
    })
    return {
      verdict: "pass",
      reasonCodes: [],
      ocrFallbackUsed: true,
      pageAudits: fallbackEvaluation.document.verdicts.map((verdict) => ({
        page: verdict.page,
        verdict: verdict.verdict,
        ...(verdict.issueType ? { issueType: verdict.issueType } : {}),
      })),
    }
  }

  /**
   * Ticket 19: the whole-document OCR attempt under the existing Volcengine
   * fault taxonomy. Only the transient class (timeout, rate limit, connection
   * failure, server error) may consume the bounded budget, waiting out the
   * next delay between attempts; an exhausted budget ends the attempt as a
   * terminal service-unavailable rejection — a service that never answered
   * must not end as a quality pass, and a task-level retry would re-spend
   * every budget the audit already consumed. Permanent input and capability
   * faults surface directly, and a cancellation is never overwritten by a
   * later stale result.
   */
  private async attemptWholeDocumentOcr(args: {
    pageCount: number
    signal: AbortSignal
    retryDelays: readonly number[]
    localCodes: readonly string[]
  }): Promise<PdfOcrFallbackAttempt> {
    const { pageCount, signal, retryDelays, localCodes } = args
    for (let attempts = 1; ; attempts += 1) {
      try {
        const attempt = await this.options.ocrFallback!({ pageCount, signal })
        // A resolved attempt after cancellation is stale — discarded unused,
        // never audited, never mistaken for a fresh verdict.
        signal.throwIfAborted()
        return attempt
      } catch (error) {
        if (error instanceof OcrApiError && error.category === "transient") {
          const retryIndex = attempts - 1
          if (retryIndex < retryDelays.length) {
            await delayWithSignal(retryDelays[retryIndex], signal)
            continue
          }
          throw new PdfQualityRejectionError(
            [...localCodes, "ocr_fallback:service_unavailable"],
            `the whole-document OCR attempt stayed unavailable after ${messageSafeCode(String(attempts))} attempt(s)`
          )
        }
        throw error
      }
    }
  }
}
