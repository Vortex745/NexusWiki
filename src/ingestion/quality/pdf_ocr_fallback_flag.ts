// PDF quality queue Ticket 04: the independent PDF OCR-fallback / quality-gate
// switch.
//
// This module owns the VOCABULARY of the switch, not the Clef evaluator
// (Ticket 01/03/07), not the page evidence (Ticket 05) and not the OCR attempt
// itself (Ticket 12). It answers three questions and nothing else:
//
//   1. Does the effective switch state gate THIS candidate? (`decidePdfQualityWorkflow`)
//   2. What does a gate have to report, and what happens when it says no?
//      (`PdfQualityGate`, `PdfQualityRejectionError`)
//   3. What is safe to write into ingestion task diagnostics?
//      (`pdfQualityDiagnostics` — stable codes only, never credentials,
//       endpoints, model prose or page text.)
//
// The switch itself is parsed and validated once, in server config
// (`AppConfig.pdfOcrFallbackEnabled`, env `PDF_OCR_FALLBACK_ENABLED`, default
// off). Nothing here reads the environment, so the ingestion path and the
// question-answering Clef path cannot drift into sharing one toggle.
import type { NormalizedBlock, ParserType } from "../../types"

/** The single env var backing the switch. Server-side only; never a request field. */
export const PDF_OCR_FALLBACK_ENABLED_ENV = "PDF_OCR_FALLBACK_ENABLED"

/** Stable diagnostic codes for the switch decision. */
export type PdfQualityWorkflowCode =
  /** Switch off (or unset): the candidate keeps the pre-ticket import path. */
  | "flag_disabled"
  /** Switch on, but the candidate is not a PDF — the flag governs PDF imports only. */
  | "non_pdf_document"
  /** Switch on, but there are no source bytes: a typed-in text submission has no PDF page to audit. */
  | "text_only_submission"
  /** Switch on and this PDF candidate must pass the page-quality gate before anything downstream runs. */
  | "pdf_quality_workflow_enabled"

export interface PdfQualityWorkflowInput {
  /** The effective, already-validated switch state from server config. */
  flagEnabled: boolean
  /** The candidate carries the original uploaded bytes (a PDF file, not pasted text). */
  hasSourceBytes: boolean
  fileName?: string | null
  mimeType?: string | null
}

export interface PdfQualityWorkflowDecision {
  readonly gated: boolean
  readonly code: PdfQualityWorkflowCode
  readonly flagEnabled: boolean
  readonly envKey: string
  readonly reason: string
}

function baseName(value: string): string {
  return value.split(/[?#]/, 1)[0].split(/[\\/]/).pop() ?? value
}

function extensionOf(value: string): string {
  const name = baseName(value).toLowerCase()
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return ""
  return name.slice(dot)
}

/**
 * Is this candidate a PDF file? The extension decides when there is one and a
 * parameter-free MIME type decides when there is not — the same precedence the
 * parser route uses, so the switch and the parser never disagree about which
 * document they are talking about.
 */
export function isPdfCandidateFile(input: { fileName?: string | null; mimeType?: string | null }): boolean {
  const extension = input.fileName ? extensionOf(input.fileName) : ""
  if (extension) return extension === ".pdf"
  const mimeType = input.mimeType?.split(";", 1)[0].trim().toLowerCase()
  return mimeType === "application/pdf"
}

/**
 * The one switch decision of the ingestion path. It is pure: the caller passes
 * the already-validated config value, so the same function explains a
 * production run and a test run.
 */
export function decidePdfQualityWorkflow(input: PdfQualityWorkflowInput): PdfQualityWorkflowDecision {
  if (!input.flagEnabled) {
    return frozenDecision(false, "flag_disabled", input,
      `${PDF_OCR_FALLBACK_ENABLED_ENV} is off; the candidate keeps the existing import path`)
  }
  if (!input.hasSourceBytes) {
    return frozenDecision(false, "text_only_submission", input,
      "the submission carries no uploaded source bytes; there is no PDF page to audit")
  }
  if (!isPdfCandidateFile(input)) {
    return frozenDecision(false, "non_pdf_document", input,
      `this switch governs PDF imports only; ${PDF_OCR_FALLBACK_ENABLED_ENV} does not apply to this candidate`)
  }
  return frozenDecision(true, "pdf_quality_workflow_enabled", input,
    "the PDF candidate is audited by the page-quality gate before chunking, vectorization, page-index writes and activation")
}

function frozenDecision(
  gated: boolean,
  code: PdfQualityWorkflowCode,
  input: PdfQualityWorkflowInput,
  reason: string
): PdfQualityWorkflowDecision {
  return Object.freeze({
    gated,
    code,
    flagEnabled: input.flagEnabled,
    envKey: PDF_OCR_FALLBACK_ENABLED_ENV,
    reason,
  })
}

export type PdfQualityGateVerdict = "pass" | "reject"

/**
 * What the gate may look at: the locally extracted candidate plus its durable
 * binding. Page images, the Clef audit and the OCR fallback are Ticket
 * 05/07/12 work behind this same interface.
 */
export interface PdfQualityGateCandidate {
  docId: string
  version: number
  parser: ParserType
  blocks: readonly NormalizedBlock[]
  rawExtractionSha256: string | null
  signal: AbortSignal
}

export interface PdfQualityGateResult {
  verdict: PdfQualityGateVerdict
  /** Stable reason codes (issue label + page), never model prose or page text. */
  reasonCodes: readonly string[]
  /** Did this audited candidate come from the whole-document OCR fallback? */
  ocrFallbackUsed: boolean
  /**
   * Ticket 09: the complete per-page audit behind the verdict — every declared
   * page with its own verdict, so recovery and the frontend render page-level
   * state without re-reading the audit envelope. Absent when nothing ran.
   */
  pageAudits?: readonly PdfQualityGatePageAudit[]
}

/** One declared page's audit outcome (closed sets; issueType only on a fail). */
export interface PdfQualityGatePageAudit {
  page: number
  verdict: "pass" | "fail" | "uncertain"
  issueType?: string
}

export interface PdfQualityGate {
  audit(candidate: PdfQualityGateCandidate): Promise<PdfQualityGateResult>
}

/**
 * Digits are prefixed in messages so a page number can never read like an HTTP
 * status (`503`, `429`) to the ingestion error classifier — a quality rejection
 * is permanent for the candidate, and must not be re-tried as a transient fault.
 * Exported for the gate (Ticket 14): free-text failure details that carry
 * counts use the same protection.
 */
export function messageSafeCode(code: string): string {
  return code.trim().slice(0, 64).replace(/[^A-Za-z0-9_:.\-]/g, "_").replace(/\d+/g, (digits) => `n${digits}`)
}

export const PDF_QUALITY_REJECTION_CODE = "pdf_quality_gate_rejected"
export const PDF_QUALITY_GATE_UNAVAILABLE_CODE = "pdf_quality_gate_unavailable"

/** Quality rejection is terminal for this candidate (queue README: never a pass, never a retry loop). */
export class PdfQualityRejectionError extends Error {
  readonly code = PDF_QUALITY_REJECTION_CODE
  readonly terminal = true
  readonly reasonCodes: readonly string[]

  /**
   * Ticket 14: optional free-text context appended after the reason codes —
   * e.g. the OCR attempt's two numbers (attempt count, provider call count).
   * Any digits it carries must already be messageSafeCode-protected by the
   * caller so the detail can never read like an HTTP status either.
   */
  constructor(reasonCodes: readonly string[], detail?: string) {
    const codes = reasonCodes.map(messageSafeCode)
    super(
      `${PDF_QUALITY_REJECTION_CODE}: the PDF page-quality audit did not pass` +
        (codes.length > 0 ? ` (reason codes: ${codes.join(";")})` : " (no reason code was reported)") +
        (detail ? `; ${detail}` : "")
    )
    this.name = "PdfQualityRejectionError"
    this.reasonCodes = Object.freeze([...reasonCodes])
  }
}

/**
 * The switch is on but no evaluator is wired yet (Tickets 07/08 land it). The
 * candidate then fails closed: an unaudited PDF must not be imported as if the
 * switch were off, because the operator asked for the gate.
 */
export class PdfQualityGateUnavailableError extends Error {
  readonly code = PDF_QUALITY_GATE_UNAVAILABLE_CODE
  readonly terminal = true

  constructor() {
    super(
      `${PDF_QUALITY_GATE_UNAVAILABLE_CODE}: ${PDF_OCR_FALLBACK_ENABLED_ENV} is on but the page-quality evaluator is not wired into the ingestion pipeline; configure the evaluator or set ${PDF_OCR_FALLBACK_ENABLED_ENV}=0 to restore the previous import path`
    )
    this.name = "PdfQualityGateUnavailableError"
  }
}

export interface PdfQualityDiagnostics {
  /** The EFFECTIVE switch state this candidate was processed under. */
  pdfOcrFallbackEnabled: boolean
  pdfQualityWorkflow: PdfQualityWorkflowCode
  pdfQualityWorkflowReason: string
  /** Null when nothing was audited. */
  pdfQualityGateVerdict: PdfQualityGateVerdict | null
  pdfQualityOcrFallbackUsed: boolean | null
  pdfQualityGateReasonCodes: string[]
  /** Ticket 09: null when nothing was audited; otherwise every declared page. */
  pdfQualityGatePages: readonly PdfQualityGatePageAudit[] | null
}

/**
 * The diagnostics projection for ingestion task records: the effective switch
 * state, one stable workflow code, and (when an audit ran) its verdict plus its
 * reason codes. Flat on purpose — it holds no credentials, no endpoints, no
 * provider payload and no document text, so it is safe to persist on a span.
 */
export function pdfQualityDiagnostics(
  decision: PdfQualityWorkflowDecision,
  gateResult?: PdfQualityGateResult | null
): PdfQualityDiagnostics {
  return {
    pdfOcrFallbackEnabled: decision.flagEnabled,
    pdfQualityWorkflow: decision.code,
    pdfQualityWorkflowReason: decision.reason,
    pdfQualityGateVerdict: gateResult?.verdict ?? null,
    pdfQualityOcrFallbackUsed: gateResult ? gateResult.ocrFallbackUsed : null,
    pdfQualityGateReasonCodes: gateResult ? [...gateResult.reasonCodes] : [],
    pdfQualityGatePages: gateResult?.pageAudits ?? null,
  }
}
