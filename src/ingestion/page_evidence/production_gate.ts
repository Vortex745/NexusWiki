// Ticket 21: the production page-quality gate assembly.
//
// Every part the page-quality gate (ticket 08) needs exists as a module — the
// per-page Clef evaluator, the PyMuPDF preview renderer, the Volcengine OCR
// parser — but none of it was ever wired to the ingestion pipeline, so an
// enabled switch was a kill switch, not a feature. This module is the wiring:
// one factory binding those parts into the `PdfQualityGate` seam that
// `PipelineStageRunner` already accepts, so every PDF entry point that goes
// through `createIngestionLifecycle` audits its candidate the same way.
//
// The audit re-grounds the candidate from DURABLE state, never from the
// in-flight blocks: original bytes from the documents row, the raw extraction
// from the extraction artifact (hash-validated on read), and page previews
// rendered fresh from the original at audit time. The accepted envelope lands
// in the document's candidate evidence alongside the content and index proofs.
import type { DB } from "../tracking/db"
import { DocumentRepo } from "../tracking/doc_repo"
import { ExtractionEvidenceRepository } from "../tracking/extraction_evidence_repo"
import { executeDecisionCall } from "../../runtime/decision_call"
import type { AppConfig } from "../../config"
import { ClefPageQualityClient } from "../quality/clef_page_quality"
import {
  PdfQualityRejectionError,
  type PdfQualityGate,
  type PdfQualityGateCandidate,
  type PdfQualityGateResult,
} from "../quality/pdf_ocr_fallback_flag"
import { readBuiltinPdfPageTexts } from "../parser/builtin_pdf"
import { OcrApiParser, ocrApiParserConfigVersion, readOcrApiPageTexts } from "../parser/ocr_api"
import type { ParseDocumentInput } from "../parser/markitdown"
import { deriveOriginalFileIdentity } from "../source_identity"
import type { PdfOcrFallbackAttempt } from "./pdf_page_quality_gate"
import { PdfPageQualityGate } from "./pdf_page_quality_gate"
import { latestStageAudit, type DualStageEvidenceEnvelope, type DualStageSource } from "./dual_stage_envelope"
import { evaluateQualityGate } from "./quality_gate"
import {
  buildPdfExtractionEvidenceBundle,
  type PdfEvidenceException,
  type PdfExtractionEvidenceBundle,
  type PdfPageTextRecord,
} from "./page_evidence"
import {
  createBuiltinPdfPreviewRenderer,
  type PagePreviewRenderer,
} from "./preview_renderer"

/** The parts the production gate is assembled from (injectable for tests). */
export interface ProductionPdfQualityGateDeps {
  documentRepo: DocumentRepo
  extractionEvidence: ExtractionEvidenceRepository
  renderer: PagePreviewRenderer
  ocrParser: Pick<OcrApiParser, "parseRaw">
  evaluateBatch: (input: Parameters<ClefPageQualityClient["evaluateBatch"]>[0], callOptions?: { signal?: AbortSignal }) => ReturnType<ClefPageQualityClient["evaluateBatch"]>
  /**
   * Ticket 24: the fingerprint of the OCR configuration this gate's fallback
   * runs under. OCR-stage audits are stamped with it and resume decisions
   * compare it, so a changed OCR configuration invalidates the recorded OCR
   * evidence while local evidence stays untouched.
   */
  ocrParserConfigVersion?: string
}

export class ProductionPdfQualityGate implements PdfQualityGate {
  constructor(private readonly deps: ProductionPdfQualityGateDeps) {}

  async audit(candidate: PdfQualityGateCandidate): Promise<PdfQualityGateResult> {
    // The evidence is assembled ONCE per audit, from durable state, before the
    // inner gate runs; its sync evidenceFor seam receives the ready bundle.
    const bundle = await this.assembleEvidence(candidate)
    // Ticket 22: a resume/reprocess whose recorded audit is still bound to
    // THIS candidate reuses it — no duplicate Clef calls — after the
    // content-binding gate rechecks every binding from the fresh evidence.
    const reused = this.reusedAuditResult(candidate, bundle)
    if (reused) return reused
    const inner = new PdfPageQualityGate({
      evidenceFor: () => bundle,
      evaluateBatch: this.deps.evaluateBatch,
      persist: (record) => {
        candidate.signal.throwIfAborted()
        this.persist(record)
      },
      // Ticket 23: the second audit's rejection is durable evidence too —
      // the record a resume re-raises instead of re-spending the OCR attempt.
      persistRejection: (record) => {
        candidate.signal.throwIfAborted()
        this.persist(record)
      },
      persistDiagnostic: (record) => {
        candidate.signal.throwIfAborted()
        if (this.deps.documentRepo.get(record.docId)?.version !== record.version) return
        const existing = this.deps.documentRepo.getCandidateEvidence(record.docId)
        const base = existing && typeof existing === "object" && !Array.isArray(existing) ? existing as Record<string, unknown> : {}
        this.deps.documentRepo.setCandidateEvidence(record.docId, { ...base, pdfQualityDiagnostic: record })
      },
      // Ticket 24: the OCR configuration this fallback runs under, stamped on
      // the OCR-stage audit it produces.
      ocrParserConfigVersion: this.deps.ocrParserConfigVersion,
      ocrFallback: async ({ signal }) => this.ocrFallback(candidate, signal),
    })
    return inner.audit(candidate)
  }

  /**
   * Ticket 22: the resume path. A recorded, still-valid audit in the
   * document's candidate evidence releases the candidate downstream WITHOUT a
   * new audit — but only after the content-binding gate re-verifies it
   * against the freshly assembled evidence: same candidate id (original-file
   * hash + extraction hash + parser/config + renders), present stage, current
   * Clef model and rule version, passed outcome, and verdicts that still
   * re-reduce to an all-page pass. Missing, corrupt, stale, mismatched or
   * never-passed records are a cache miss: the full audit runs again. The
   * recorded page verdicts are the diagnostics a resume reports — never new
   * ones, because none were earned.
   *
   * Ticket 23: one recorded shape is re-raised instead of reused or retried —
   * a rejection whose OCR-stage audit is still bound to THIS candidate. The
   * one whole-document OCR attempt was already spent on this exact input and
   * its second audit said no, so a resume terminates on the recorded reason
   * codes without a new OCR attempt or Clef call. Any other failure-shaped
   * record (a local-only rejection, a binding/model/rule mismatch, a corrupt
   * envelope) is a cache miss: the audit runs again.
   */
  private reusedAuditResult(
    candidate: PdfQualityGateCandidate,
    bundle: PdfExtractionEvidenceBundle
  ): PdfQualityGateResult | null {
    try {
      const existing = this.deps.documentRepo.getCandidateEvidence(candidate.docId)
      const recorded = existing && typeof existing === "object" && !Array.isArray(existing)
        ? (existing as Record<string, unknown>).pdfQualityAudit
        : undefined
      if (!recorded || typeof recorded !== "object" || Array.isArray(recorded)) return null
      const audit = recorded as {
        version?: unknown
        candidateId?: unknown
        envelope?: unknown
        decision?: { passed?: unknown; reasonCodes?: unknown }
      }
      if (audit.version !== candidate.version) return null
      if (audit.candidateId !== bundle.identity.candidateId) return null
      const envelope = audit.envelope as DualStageEvidenceEnvelope | undefined
      if (!envelope || typeof envelope !== "object" || !envelope.stages) return null
      const recordedDecision = audit.decision
      if (!recordedDecision || typeof recordedDecision !== "object") return null
      // The accepted candidate is the OCR rescue when its stage carries the
      // audit; otherwise the local extraction. The gate recheck below decides
      // whether either still binds.
      const ocrRecord = envelope.stages.ocr_candidate
      let stage: DualStageSource =
        ocrRecord?.state === "present" && ocrRecord.audits.length > 0 ? "ocr_candidate" : "local_extraction"
      // Ticket 24: the OCR stage binds to the configuration that produced it.
      // A changed OCR configuration (or an unstampable old record, or a gate
      // without a fingerprint to compare) invalidates the OCR stage's
      // evidence — the decision then falls back to the local stage, whose
      // rejected audit is a cache miss, so the full audit reruns under the
      // new configuration. Matching fingerprints reuse as before.
      if (stage === "ocr_candidate") {
        const latestOcr = latestStageAudit(envelope, "ocr_candidate")
        if (latestOcr?.ocrParserConfigVersion !== this.deps.ocrParserConfigVersion) {
          stage = "local_extraction"
        }
      }
      const decision = evaluateQualityGate({ envelope, identity: bundle.identity, stage })

      if (recordedDecision.passed === true) {
        if (!decision.passed) return null
        const latest = latestStageAudit(envelope, stage)
        if (!latest) return null
        candidate.signal.throwIfAborted()
        return {
          verdict: "pass",
          reasonCodes: [],
          ocrFallbackUsed: stage === "ocr_candidate",
          pageAudits: latest.verdicts.map((verdict) => ({
            page: verdict.page,
            verdict: verdict.verdict,
            ...(verdict.issueType ? { issueType: verdict.issueType } : {}),
          })),
        }
      }

      // Ticket 23: the recorded rejection re-raise. The gate recheck must deny
      // for the not-passed outcome ALONE and the denial must be about the OCR
      // stage — a schema, binding, candidate, model or rule mismatch means the
      // record is not this candidate's rejection, and a local-only rejection
      // spent no attempt a retry must not repeat. Both run the audit again.
      if (
        recordedDecision.passed === false &&
        !decision.passed &&
        decision.reasonCodes.length === 1 &&
        decision.reasonCodes[0] === "quality_gate_audit_not_passed" &&
        stage === "ocr_candidate" &&
        latestStageAudit(envelope, stage)?.outcome === "rejected"
      ) {
        candidate.signal.throwIfAborted()
        throw new PdfQualityRejectionError(
          Array.isArray(recordedDecision.reasonCodes)
            ? recordedDecision.reasonCodes.filter((code): code is string => typeof code === "string")
            : [],
          "resume re-raised the recorded rejection; no new OCR attempt was spent"
        )
      }

      return null
    } catch (error) {
      // The re-raise is intentional control flow; everything else that cannot
      // be read or re-verified is a cache miss (never a crash, never a pass
      // on unreadable evidence).
      if (error instanceof PdfQualityRejectionError) throw error
      return null
    }
  }

  /**
   * Re-grounds the audited candidate as page-aligned evidence. Every input is
   * durable: the original bytes, the hash-validated extraction artifact and a
   * fresh render of each declared page. Anything missing is a loud failure —
   * an audit grounded on less than the full evidence set can never run.
   */
  private async assembleEvidence(candidate: PdfQualityGateCandidate): Promise<PdfExtractionEvidenceBundle> {
    const bytes = this.deps.documentRepo.getRawContent(candidate.docId)
    if (!bytes || bytes.length === 0) {
      throw new Error(
        `the page-quality gate needs the original document bytes of ${candidate.docId}; none are retained`
      )
    }
    const document = this.deps.documentRepo.get(candidate.docId)
    if (!document) {
      throw new Error(`the page-quality gate cannot find document ${candidate.docId}`)
    }
    const read = this.deps.extractionEvidence.get(candidate.docId, candidate.version)
    if (!read) {
      throw new Error(
        `the page-quality gate needs an extraction evidence record for ${candidate.docId} v${candidate.version}; none exists`
      )
    }
    if (!read.valid) {
      throw new Error(
        `the extraction evidence of ${candidate.docId} v${candidate.version} failed validation (${read.invalidReason}); it cannot ground an audit`
      )
    }
    const artifact = read.artifact

    // Page texts come from the parser's own durable raw extraction, read in
    // that parser's shape. A gated PDF candidate can only be produced by one
    // of these two parsers (the router keeps legacy text converters off PDFs);
    // anything else is a loud failure, never a guessed reading.
    let pageCount: number
    let pageTexts: PdfPageTextRecord[]
    let documentWarnings: readonly string[]
    let documentExceptions: readonly PdfEvidenceException[]
    if (artifact.parserType === "ocr-api") {
      const reading = readOcrApiPageTexts(artifact.rawExtraction)
      pageCount = reading.pageCount
      pageTexts = reading.pageTexts
      documentWarnings = []
      documentExceptions = []
    } else if (artifact.parserType === "builtin-pdf") {
      const reading = readBuiltinPdfPageTexts(artifact.rawExtraction)
      pageCount = reading.pageCount
      pageTexts = reading.pageTexts
      documentWarnings = reading.documentWarnings
      documentExceptions = reading.exceptions
    } else {
      throw new Error(
        `the page-quality gate cannot read the raw extraction of parser "${artifact.parserType}" (document ${candidate.docId}); PDF audits need builtin-pdf or ocr-api output`
      )
    }
    if (artifact.pageCount !== null && artifact.pageCount !== pageCount) {
      throw new Error(
        `the extraction evidence of ${candidate.docId} declares ${artifact.pageCount} pages but its raw extraction declares ${pageCount}`
      )
    }

    const previews = await this.deps.renderer({
      content: bytes,
      pageCount,
      signal: candidate.signal,
    })
    const originalFile = deriveOriginalFileIdentity({
      bytes,
      fileName: document.fileName,
      mimeType: document.mimeType,
      fallbackId: candidate.docId,
    })
    return buildPdfExtractionEvidenceBundle({
      originalFile,
      extractionResultSha256: artifact.rawExtractionSha256,
      parserType: artifact.parserType,
      parserConfigVersion: artifact.parserConfigVersion,
      pageCount,
      pageTexts,
      previews,
      documentWarnings,
      documentExceptions,
    })
  }

  /**
   * The one whole-document OCR fallback attempt: the same Volcengine parser
   * the ocr-api route uses, over the retained original bytes. Its batched raw
   * output is read into one text per declared page; each batch was one
   * provider HTTP call, and that count is what the attempt reports.
   */
  private async ocrFallback(
    candidate: PdfQualityGateCandidate,
    signal: AbortSignal
  ): Promise<PdfOcrFallbackAttempt> {
    const document = this.deps.documentRepo.get(candidate.docId)
    if (!document) {
      throw new Error(`the OCR fallback cannot find document ${candidate.docId}`)
    }
    const bytes = this.deps.documentRepo.getRawContent(candidate.docId)
    if (!bytes || bytes.length === 0) {
      throw new Error(`the OCR fallback needs the original document bytes of ${candidate.docId}; none are retained`)
    }
    const input: Omit<ParseDocumentInput, "documentId"> = {
      content: bytes,
      fileName: document.fileName ?? `${candidate.docId}.pdf`,
      ...(document.mimeType !== null ? { mimeType: document.mimeType } : {}),
      signal,
    }
    const reading = readOcrApiPageTexts(await this.deps.ocrParser.parseRaw(input))
    return {
      pageTexts: reading.pageTexts.map((record) => record.text),
      providerCallCount: reading.providerCallCount,
    }
  }

  /**
   * The accepted audit envelope joins the document's candidate evidence. The
   * record is merged, never a whole-column overwrite: the content and index
   * proofs (written later in the same run, and by UT-16) stay intact.
   */
  private persist(record: { docId: string; version: number; candidateId: string; envelope: unknown; decision: unknown }): void {
    if (this.deps.documentRepo.get(record.docId)?.version !== record.version) return
    const existing = this.deps.documentRepo.getCandidateEvidence(record.docId)
    const base = existing && typeof existing === "object" && !Array.isArray(existing)
      ? existing as Record<string, unknown>
      : {}
    this.deps.documentRepo.setCandidateEvidence(record.docId, {
      ...base,
      pdfQualityAudit: {
        version: record.version,
        candidateId: record.candidateId,
        envelope: record.envelope,
        decision: record.decision,
      },
    })
  }
}

/**
 * The production assembly: durable-state repos, the PyMuPDF preview renderer,
 * the Volcengine OCR parser and the Clef page-quality client bound through the
 * run-context decision executor.
 */
export function createProductionPdfQualityGate(db: DB, config: AppConfig): PdfQualityGate {
  return new ProductionPdfQualityGate({
    documentRepo: new DocumentRepo(db),
    extractionEvidence: new ExtractionEvidenceRepository(db),
    renderer: createBuiltinPdfPreviewRenderer({
      command: config.pythonCommand ?? "python",
      timeoutMs: config.parserTimeoutMs ?? 120_000,
      inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
      outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
    }),
    ocrParser: new OcrApiParser({
      accessKeyId: config.ocrAccessKeyId ?? "",
      secretAccessKey: config.ocrSecretAccessKey ?? "",
      sessionToken: config.ocrSessionToken,
      timeoutMs: config.parserTimeoutMs ?? 120_000,
      inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
      outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
    }),
    // Ticket 24: the OCR configuration fingerprint, from the same settings the
    // pipeline's parser fingerprint uses, so a resume compares the gate's
    // current OCR configuration against the one that produced the record.
    ocrParserConfigVersion: ocrApiParserConfigVersion({
      timeoutMs: config.parserTimeoutMs ?? 120_000,
      inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
      outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
    }),
    evaluateBatch: (() => {
      const client = new ClefPageQualityClient({
        accountId: config.cloudflareAccountId ?? "",
        apiToken: config.cloudflareApiToken ?? "",
        timeoutMs: config.decisionRequestTimeoutMs ?? 10_000,
        execute: executeDecisionCall,
      })
      return (input: Parameters<ClefPageQualityClient["evaluateBatch"]>[0], callOptions?: { signal?: AbortSignal }) =>
        client.evaluateBatch(input, callOptions)
    })(),
  })
}
