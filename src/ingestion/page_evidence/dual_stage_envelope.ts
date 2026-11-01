// Ticket 06: durable dual-stage evidence envelope.
//
// One envelope holds the original-file identity and the two candidate stages a
// PDF import can produce — the local extraction and the OCR fallback — each in
// its own slot with its own candidate id and its own audit history. Audits are
// appended immutably and can never cross stages; a stage moves through the
// explicit missing / present / stale / invalid / superseded states that the
// gate and cache tickets decide on. There is deliberately no approval field:
// the only pass signal in an envelope is a recorded audit whose verdicts passed
// the contract reducer, and serialization round-trips preserve exactly that.
import type { OriginalFileIdentity } from "../source_identity"
import {
  type PageQualityVerdict,
  QualityContractError,
  reduceDocumentQuality,
} from "../quality/contract"

export const DUAL_STAGE_ENVELOPE_SCHEMA_VERSION = 1

export type DualStageSource = "local_extraction" | "ocr_candidate"

export const DUAL_STAGE_SOURCES: readonly DualStageSource[] = ["local_extraction", "ocr_candidate"]

/** The explicit states a stage slot can be in; "present" is reached only by construction or a candidate arriving. */
export type DualStageState = "missing" | "present" | "stale" | "invalid" | "superseded"

/** States that can be set after construction; presence and absence are structural. */
export type DualStageMarkedState = "stale" | "invalid" | "superseded"

export type QualityAuditOutcome = "passed" | "rejected" | "service_fault" | "invalid_response"

export interface QualityRequestRecord {
  requestId: string
  pages: readonly number[]
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null
  /**
   * Ticket 18: how many provider attempts this request spent — 1 when the
   * first answer stood, more when transient faults consumed bounded retries.
   * Optional so envelopes written before the field existed still parse; a
   * present count is a positive whole number.
   */
  attempts?: number
  startedAt: string
  finishedAt: string
}

export interface QualityStageAudit {
  stage: DualStageSource
  candidateId: string
  decisionProvider?: "chat" | "typesafe" | "clef"
  decisionModel?: string
  /** Historical audit identity; new records use decisionProvider/decisionModel. */
  clefModel?: string
  ruleVersion: string
  outcome: QualityAuditOutcome
  ranAt: string
  requests: readonly QualityRequestRecord[]
  verdicts: readonly PageQualityVerdict[]
  /**
   * Ticket 10: the aggregate token usage and wall-clock cost of the whole
   * audit (every per-page request included). Optional so envelopes written
   * before the field existed still parse; present on every new audit.
   */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  durationMs?: number
  /**
   * Ticket 12: how many provider HTTP calls the whole-document OCR fallback
   * attempt issued (Volcengine batches ≤16 pages per call). Present only on an
   * `ocr_candidate` stage audit — the attempt count itself is the existence of
   * that audit, so the persisted evidence reports both numbers.
   */
  ocrProviderCallCount?: number
  /**
   * Ticket 24: the fingerprint of the OCR configuration that produced the OCR
   * candidate this audit judged. Present only on an `ocr_candidate` stage
   * audit; a cache decision comparing it against the current configuration
   * invalidates the OCR stage's evidence without touching local evidence.
   * Optional so envelopes written before the field existed still parse — and
   * such records fail the comparison (invalidated) rather than reuse.
   */
  ocrParserConfigVersion?: string
}

export interface DualStageRecord {
  state: DualStageState
  candidateId: string | null
  audits: readonly QualityStageAudit[]
}

export interface DualStageEvidenceEnvelope {
  schemaVersion: number
  originalFile: OriginalFileIdentity
  declaredPageCount: number
  evidenceVersion: string
  stages: { local_extraction: DualStageRecord; ocr_candidate: DualStageRecord }
}

export type DualStageEnvelopeErrorCode =
  | "envelope_input_invalid"
  | "stage_unknown"
  | "stage_not_present"
  | "stage_candidate_conflict"
  | "audit_candidate_mismatch"
  | "audit_invalid"
  | "state_transition_invalid"
  | "envelope_parse_invalid"

export class DualStageEnvelopeError extends Error {
  constructor(readonly code: DualStageEnvelopeErrorCode, message: string) {
    super(message)
    this.name = "DualStageEnvelopeError"
  }
}

const DIGEST = /^[0-9a-f]{64}$/
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const OUTCOMES: readonly QualityAuditOutcome[] = ["passed", "rejected", "service_fault", "invalid_response"]
const MARKED_STATES: readonly DualStageMarkedState[] = ["stale", "invalid", "superseded"]
const STAGE_STATES: readonly DualStageState[] = ["missing", "present", "stale", "invalid", "superseded"]

function fail(code: DualStageEnvelopeErrorCode, message: string): never {
  throw new DualStageEnvelopeError(code, message)
}

function requireDigest(value: unknown, code: DualStageEnvelopeErrorCode, label: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    fail(code, `${label} must be a sha256 hex digest, got ${JSON.stringify(value)}`)
  }
  return value
}

function requireIso(value: unknown, code: DualStageEnvelopeErrorCode, label: string): string {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    fail(code, `${label} must be an ISO-8601 UTC timestamp, got ${JSON.stringify(value)}`)
  }
  return value
}

function requirePositivePages(pages: readonly unknown[], code: DualStageEnvelopeErrorCode, label: string): readonly number[] {
  if (!Array.isArray(pages) || pages.length === 0) {
    fail(code, `${label} must list the pages it covers`)
  }
  const seen = new Set<number>()
  for (const page of pages) {
    if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 1) {
      fail(code, `${label} carries an invalid page number: ${JSON.stringify(page)}`)
    }
    if (seen.has(page)) fail(code, `${label} covers page ${page} more than once`)
    seen.add(page)
  }
  return Object.freeze([...pages])
}

function stageRecordOf(source: DualStageSource, envelope: DualStageEvidenceEnvelope): DualStageRecord {
  if (source !== "local_extraction" && source !== "ocr_candidate") {
    fail("stage_unknown", `"${String(source)}" is not a stage of this envelope`)
  }
  return envelope.stages[source]
}

function missingRecord(source: DualStageSource): DualStageRecord {
  return Object.freeze({ state: "missing", candidateId: null, audits: Object.freeze([]) })
}

/**
 * Validates one audit against the contract reducer and the recorded metadata.
 * Shared by recording and parsing so a serialized envelope can never carry an
 * audit that could not have been recorded in the first place.
 */
function validateAudit(audit: QualityStageAudit, stageCandidateId: string, declaredPageCount: number): QualityStageAudit {
  if (!audit || typeof audit !== "object") fail("audit_invalid", "a stage audit must be an object")
  if (audit.stage !== "local_extraction" && audit.stage !== "ocr_candidate") {
    fail("audit_invalid", `audit stage "${String(audit.stage)}" is outside the closed set`)
  }
  if (audit.candidateId !== stageCandidateId) {
    fail("audit_candidate_mismatch", `the audit is bound to candidate ${audit.candidateId}, but this stage carries ${stageCandidateId}`)
  }
  if (audit.decisionProvider !== undefined || audit.decisionModel !== undefined) {
    if (
      audit.decisionProvider !== "chat" &&
      audit.decisionProvider !== "typesafe" &&
      audit.decisionProvider !== "clef"
    ) {
      fail("audit_invalid", "an audit decision provider is outside the closed set")
    }
    if (typeof audit.decisionModel !== "string" || audit.decisionModel.trim() === "") {
      fail("audit_invalid", "an audit records the decision model identity it ran under")
    }
  } else if (typeof audit.clefModel !== "string" || audit.clefModel.trim() === "") {
    fail("audit_invalid", "a historical audit records the Clef model identity it ran under")
  }
  if (typeof audit.ruleVersion !== "string" || audit.ruleVersion.trim() === "") {
    fail("audit_invalid", "an audit records the rule-contract version it ran under")
  }
  if (!OUTCOMES.includes(audit.outcome)) {
    fail("audit_invalid", `audit outcome "${String(audit.outcome)}" is outside the closed set`)
  }
  requireIso(audit.ranAt, "audit_invalid", "audit ranAt")

  // Ticket 10: aggregate cost, when present, must be well-formed and complete.
  if (audit.usage !== undefined) {
    const usage = audit.usage
    if (
      !usage ||
      typeof usage !== "object" ||
      !Number.isSafeInteger(usage.promptTokens) ||
      usage.promptTokens < 0 ||
      !Number.isSafeInteger(usage.completionTokens) ||
      usage.completionTokens < 0 ||
      !Number.isSafeInteger(usage.totalTokens) ||
      usage.totalTokens < 0
    ) {
      fail("audit_invalid", "audit usage must be non-negative integer token counts")
    }
  }
  if (audit.durationMs !== undefined && (!Number.isSafeInteger(audit.durationMs) || audit.durationMs < 0)) {
    fail("audit_invalid", "audit durationMs must be a non-negative integer")
  }
  // Ticket 12: the OCR attempt's provider-call count, when present, is a count.
  if (
    audit.ocrProviderCallCount !== undefined &&
    (!Number.isSafeInteger(audit.ocrProviderCallCount) || audit.ocrProviderCallCount < 0)
  ) {
    fail("audit_invalid", "audit ocrProviderCallCount must be a non-negative integer")
  }
  // Ticket 24: the OCR configuration fingerprint, when present, is a real identity.
  if (audit.ocrParserConfigVersion !== undefined && (typeof audit.ocrParserConfigVersion !== "string" || audit.ocrParserConfigVersion.trim() === "")) {
    fail("audit_invalid", "audit ocrParserConfigVersion must be a non-empty configuration fingerprint")
  }

  if (!Array.isArray(audit.requests) || audit.requests.length === 0) {
    fail("audit_invalid", "an audit records the requests it made, even when they all failed")
  }
  for (const request of audit.requests) {
    if (!request || typeof request !== "object") fail("audit_invalid", "every request record must be an object")
    if (typeof request.requestId !== "string" || request.requestId.trim() === "") {
      fail("audit_invalid", "every request record carries a request id")
    }
    requirePositivePages(request.pages, "audit_invalid", `request ${request.requestId}`)
    if (
      request.attempts !== undefined &&
      (!Number.isSafeInteger(request.attempts) || request.attempts < 1)
    ) {
      fail("audit_invalid", `request ${request.requestId} carries an invalid attempt count`)
    }
    if (
      request.usage !== null &&
      (!request.usage ||
        typeof request.usage !== "object" ||
        !Number.isSafeInteger(request.usage.promptTokens) ||
        request.usage.promptTokens < 0 ||
        !Number.isSafeInteger(request.usage.completionTokens) ||
        request.usage.completionTokens < 0 ||
        !Number.isSafeInteger(request.usage.totalTokens) ||
        request.usage.totalTokens < 0)
    ) {
      fail("audit_invalid", `request ${request.requestId} carries malformed usage`)
    }
    const startedAt = requireIso(request.startedAt, "audit_invalid", `request ${request.requestId} startedAt`)
    const finishedAt = requireIso(request.finishedAt, "audit_invalid", `request ${request.requestId} finishedAt`)
    if (Date.parse(finishedAt) < Date.parse(startedAt)) {
      fail("audit_invalid", `request ${request.requestId} finished before it started`)
    }
  }

  if (!Array.isArray(audit.verdicts)) fail("audit_invalid", "an audit records its page verdicts, even when empty")
  let passedAllPages: boolean
  try {
    const declaredPages = Array.from({ length: declaredPageCount }, (_, index) => index + 1)
    const outcome = reduceDocumentQuality({ ruleVersion: audit.ruleVersion, declaredPages, verdicts: audit.verdicts })
    passedAllPages = outcome.passed
  } catch (error) {
    if (error instanceof QualityContractError) {
      fail("audit_invalid", `audit verdicts violate the quality contract (${error.code}): ${error.message}`)
    }
    throw error
  }
  if (audit.outcome === "passed" && !passedAllPages) {
    fail("audit_invalid", "an audit may only report passed when every declared page verdict is pass")
  }

  return audit
}

function freezeEnvelope(envelope: DualStageEvidenceEnvelope): DualStageEvidenceEnvelope {
  return Object.freeze({
    ...envelope,
    originalFile: Object.freeze({ ...envelope.originalFile }),
    stages: Object.freeze({
      local_extraction: Object.freeze({
        ...envelope.stages.local_extraction,
        audits: Object.freeze([...envelope.stages.local_extraction.audits]),
      }),
      ocr_candidate: Object.freeze({
        ...envelope.stages.ocr_candidate,
        audits: Object.freeze([...envelope.stages.ocr_candidate.audits]),
      }),
    }),
  })
}

/**
 * Opens the envelope for one candidate: the local extraction stage starts
 * present with its candidate id, the OCR stage starts missing.
 */
export function createDualStageEvidenceEnvelope(input: {
  originalFile: OriginalFileIdentity
  declaredPageCount: number
  evidenceVersion: string
  localCandidateId: string
}): DualStageEvidenceEnvelope {
  if (!input.originalFile || typeof input.originalFile !== "object") {
    fail("envelope_input_invalid", "the envelope carries the original file identity")
  }
  requireDigest(input.originalFile.sha256, "envelope_input_invalid", "original file digest")
  if (!Number.isSafeInteger(input.originalFile.byteLength) || input.originalFile.byteLength < 1) {
    fail("envelope_input_invalid", "the original file identity needs its byte length")
  }
  if (!Number.isSafeInteger(input.declaredPageCount) || input.declaredPageCount < 1) {
    fail("envelope_input_invalid", `a document declares a positive whole page count, got ${String(input.declaredPageCount)}`)
  }
  if (typeof input.evidenceVersion !== "string" || input.evidenceVersion.trim() === "") {
    fail("envelope_input_invalid", "the envelope declares the evidence version that produced its candidate")
  }
  return freezeEnvelope({
    schemaVersion: DUAL_STAGE_ENVELOPE_SCHEMA_VERSION,
    originalFile: input.originalFile,
    declaredPageCount: input.declaredPageCount,
    evidenceVersion: input.evidenceVersion,
    stages: {
      local_extraction: Object.freeze({ state: "present", candidateId: requireDigest(input.localCandidateId, "envelope_input_invalid", "local candidate id"), audits: Object.freeze([]) }),
      ocr_candidate: missingRecord("ocr_candidate"),
    },
  })
}

/**
 * Appends an audit to its own stage, immutably. The other stage is untouched:
 * local and OCR evidence cannot overwrite one another.
 */
export function recordQualityStageAudit(
  envelope: DualStageEvidenceEnvelope,
  audit: QualityStageAudit
): DualStageEvidenceEnvelope {
  const record = stageRecordOf(audit.stage, envelope)
  if (record.state !== "present") {
    fail("stage_not_present", `the ${audit.stage} stage is ${record.state} and cannot accept an audit`)
  }
  validateAudit(audit, record.candidateId!, envelope.declaredPageCount)
  return freezeEnvelope({
    ...envelope,
    stages: {
      ...envelope.stages,
      [audit.stage]: Object.freeze({
        ...record,
        audits: Object.freeze([...record.audits, Object.freeze({ ...audit })]),
      }),
    },
  })
}

/**
 * Brings a candidate into a stage slot. An occupied slot refuses a different
 * candidate until it is explicitly superseded; the same candidate is a no-op.
 */
export function setStageCandidate(
  envelope: DualStageEvidenceEnvelope,
  stage: DualStageSource,
  candidateId: string
): DualStageEvidenceEnvelope {
  const record = stageRecordOf(stage, envelope)
  requireDigest(candidateId, "envelope_input_invalid", `${stage} candidate id`)
  if (record.state === "present") {
    if (record.candidateId === candidateId) return envelope
    fail("stage_candidate_conflict", `the ${stage} stage already carries a candidate; supersede it first`)
  }
  if (record.state === "stale" || record.state === "invalid") {
    fail("stage_candidate_conflict", `the ${stage} stage is ${record.state}; mark it superseded before replacing the candidate`)
  }
  return freezeEnvelope({
    ...envelope,
    stages: { ...envelope.stages, [stage]: Object.freeze({ state: "present", candidateId, audits: record.audits }) },
  })
}

/** Moves a present or superseded stage into an explicit stale / invalid / superseded state. */
export function markStageState(
  envelope: DualStageEvidenceEnvelope,
  stage: DualStageSource,
  state: DualStageMarkedState
): DualStageEvidenceEnvelope {
  if (!MARKED_STATES.includes(state)) {
    fail("state_transition_invalid", `"${String(state)}" is not a state that can be set after construction`)
  }
  const record = stageRecordOf(stage, envelope)
  if (record.state === "missing") {
    fail("stage_not_present", `the ${stage} stage has no candidate to mark ${state}`)
  }
  if (record.state === state) {
    fail("state_transition_invalid", `the ${stage} stage is already ${state}`)
  }
  return freezeEnvelope({
    ...envelope,
    stages: { ...envelope.stages, [stage]: Object.freeze({ ...record, state }) },
  })
}

/** The most recent audit of a stage, or null when the stage has never been audited. */
export function latestStageAudit(
  envelope: DualStageEvidenceEnvelope,
  stage: DualStageSource
): QualityStageAudit | null {
  const record = stageRecordOf(stage, envelope)
  return record.audits.length > 0 ? record.audits[record.audits.length - 1] : null
}

/** Serializes the envelope for durable storage. The shape is JSON-safe by construction. */
export function serializeDualStageEnvelope(envelope: DualStageEvidenceEnvelope): string {
  return JSON.stringify(envelope)
}

/**
 * Restores an envelope from storage. Everything is re-validated, including
 * every audit's verdicts against the contract reducer, so a tampered or
 * truncated envelope fails closed instead of resuming into a wrong state.
 */
export function parseDualStageEnvelope(text: string): DualStageEvidenceEnvelope {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    fail("envelope_parse_invalid", `the stored envelope is not valid JSON: ${(error as Error).message}`)
  }
  if (!value || typeof value !== "object") fail("envelope_parse_invalid", "the stored envelope is not an object")
  const draft = value as Record<string, unknown>
  if (draft.schemaVersion !== DUAL_STAGE_ENVELOPE_SCHEMA_VERSION) {
    fail("envelope_parse_invalid", `unsupported envelope schema version ${JSON.stringify(draft.schemaVersion)}`)
  }
  const originalFile = draft.originalFile as OriginalFileIdentity | undefined
  if (!originalFile || typeof originalFile !== "object") {
    fail("envelope_parse_invalid", "the stored envelope lost the original file identity")
  }
  requireDigest(originalFile.sha256, "envelope_parse_invalid", "original file digest")
  if (!Number.isSafeInteger(originalFile.byteLength) || originalFile.byteLength < 1) {
    fail("envelope_parse_invalid", "the stored envelope lost the original file byte length")
  }
  if (!Number.isSafeInteger(draft.declaredPageCount) || (draft.declaredPageCount as number) < 1) {
    fail("envelope_parse_invalid", "the stored envelope lost its declared page count")
  }
  if (typeof draft.evidenceVersion !== "string" || draft.evidenceVersion.trim() === "") {
    fail("envelope_parse_invalid", "the stored envelope lost its evidence version")
  }
  const stages = draft.stages as Record<string, unknown> | undefined
  if (!stages || typeof stages !== "object") {
    fail("envelope_parse_invalid", "the stored envelope lost its stage slots")
  }
  const parsedStages = {} as Record<DualStageSource, DualStageRecord>
  for (const source of DUAL_STAGE_SOURCES) {
    const slot = stages[source] as Record<string, unknown> | undefined
    if (!slot || typeof slot !== "object") {
      fail("envelope_parse_invalid", `the stored envelope lost its ${source} stage`)
    }
    if (!STAGE_STATES.includes(slot.state as DualStageState)) {
      fail("envelope_parse_invalid", `the ${source} stage carries the unknown state ${JSON.stringify(slot.state)}`)
    }
    const candidateId =
      slot.candidateId === null ? null : requireDigest(slot.candidateId, "envelope_parse_invalid", `${source} candidate id`)
    if ((slot.state === "present" || slot.state === "stale" || slot.state === "invalid" || slot.state === "superseded") && candidateId === null) {
      fail("envelope_parse_invalid", `the ${source} stage is ${String(slot.state)} without a candidate`)
    }
    if (slot.state === "missing" && candidateId !== null) {
      fail("envelope_parse_invalid", "a missing stage cannot carry a candidate")
    }
    if (!Array.isArray(slot.audits)) {
      fail("envelope_parse_invalid", `the ${source} stage lost its audit history`)
    }
    const audits = candidateId === null ? [] : [...(slot.audits as QualityStageAudit[])].map((audit) => {
      try {
        return validateAudit(audit, candidateId, draft.declaredPageCount as number)
      } catch (error) {
        if (error instanceof DualStageEnvelopeError) {
          fail("envelope_parse_invalid", `the stored ${source} audit is invalid: ${error.message}`)
        }
        throw error
      }
    })
    parsedStages[source] = Object.freeze({ state: slot.state as DualStageState, candidateId, audits: Object.freeze(audits) })
  }
  return freezeEnvelope({
    schemaVersion: DUAL_STAGE_ENVELOPE_SCHEMA_VERSION,
    originalFile,
    declaredPageCount: draft.declaredPageCount as number,
    evidenceVersion: draft.evidenceVersion,
    stages: parsedStages,
  })
}
