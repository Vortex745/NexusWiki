// Ticket 20: content binding and activation gate.
//
// One question, answered fail-closed: is THIS candidate's content accepted by
// an audit that is provably about it? Acceptance requires the stage to be
// present with the active candidate id, and its latest audit to be bound to
// that same candidate id, the shared Clef model and the quality-rule version,
// with an outcome of passed whose verdicts still re-reduce to an all-page pass.
// The candidate id itself (ticket 05) binds the original-file hash, the
// extraction-result hash and the parser/configuration identity, so binding the
// audit to the id binds it to all five elements. There is deliberately no
// approval override: missing, expired (stale/superseded/invalid) or mismatched
// audits keep the document content-not-accepted, and unknown envelope schemas
// fail closed. This gate runs before — never instead of — the chunk-coverage
// and index-validation gates that stay required for activation.
import {
  DUAL_STAGE_ENVELOPE_SCHEMA_VERSION,
  latestStageAudit,
  type DualStageEvidenceEnvelope,
  type DualStageSource,
} from "./dual_stage_envelope"
import type { ExtractionCandidateIdentity } from "./candidate_identity"
import {
  QUALITY_RULE_VERSION,
  QualityContractError,
  reduceDocumentQuality,
} from "../quality/contract"

/**
 * Stable reason-code contract (consumed by ticket 26's frontend mapping).
 * Codes may only be added, never renamed; an unknown state fails closed below.
 */
export const QUALITY_GATE_REASON_CODES: readonly string[] = Object.freeze([
  "quality_gate_envelope_schema_mismatch",
  "quality_gate_binding_mismatch",
  "quality_gate_stage_not_present",
  "quality_gate_candidate_mismatch",
  "quality_gate_audit_missing",
  "quality_gate_model_mismatch",
  "quality_gate_rule_mismatch",
  "quality_gate_audit_not_passed",
  "quality_gate_audit_incoherent",
])

const QUALITY_GATE_ENVELOPE_SCHEMA_MISMATCH = "quality_gate_envelope_schema_mismatch"
const QUALITY_GATE_BINDING_MISMATCH = "quality_gate_binding_mismatch"
const QUALITY_GATE_STAGE_NOT_PRESENT = "quality_gate_stage_not_present"
const QUALITY_GATE_CANDIDATE_MISMATCH = "quality_gate_candidate_mismatch"
const QUALITY_GATE_AUDIT_MISSING = "quality_gate_audit_missing"
const QUALITY_GATE_MODEL_MISMATCH = "quality_gate_model_mismatch"
const QUALITY_GATE_RULE_MISMATCH = "quality_gate_rule_mismatch"
const QUALITY_GATE_AUDIT_NOT_PASSED = "quality_gate_audit_not_passed"
const QUALITY_GATE_AUDIT_INCOHERENT = "quality_gate_audit_incoherent"

export interface QualityGateDecision {
  passed: boolean
  /** Machine-readable reason codes (stable contract). */
  reasonCodes: string[]
  /** One readable summary (all reason codes joined). */
  reason: string | null
}

function denied(reasonCodes: string[]): QualityGateDecision {
  return { passed: false, reasonCodes, reason: reasonCodes.join(";") }
}

/**
 * Decides whether the given stage's content is quality-accepted for the active
 * candidate. Takes only the envelope, the candidate's identity record and the
 * stage — there is no approval parameter to bypass it with.
 */
export function evaluateQualityGate(input: {
  envelope: DualStageEvidenceEnvelope
  identity: ExtractionCandidateIdentity
  stage: DualStageSource
  decisionProvider?: "chat" | "typesafe" | "clef"
  decisionModel?: string
}): QualityGateDecision {
  if (input.envelope?.schemaVersion !== DUAL_STAGE_ENVELOPE_SCHEMA_VERSION) {
    return denied([QUALITY_GATE_ENVELOPE_SCHEMA_MISMATCH])
  }
  if (
    input.identity.originalFile.sha256 !== input.envelope.originalFile.sha256 ||
    input.identity.originalFile.byteLength !== input.envelope.originalFile.byteLength
  ) {
    return denied([QUALITY_GATE_BINDING_MISMATCH])
  }

  const record = input.envelope.stages[input.stage]
  if (!record || record.state !== "present") {
    // missing (no candidate at all) and stale / invalid / superseded (expired) both stay unaccepted.
    return denied([QUALITY_GATE_STAGE_NOT_PRESENT])
  }
  if (record.candidateId !== input.identity.candidateId) {
    return denied([QUALITY_GATE_CANDIDATE_MISMATCH])
  }

  const audit = latestStageAudit(input.envelope, input.stage)
  if (!audit) return denied([QUALITY_GATE_AUDIT_MISSING])
  if (audit.candidateId !== input.identity.candidateId) {
    return denied([QUALITY_GATE_CANDIDATE_MISMATCH])
  }
  const decisionProvider = input.decisionProvider ?? "chat"
  const decisionModel = input.decisionModel ?? "unspecified"
  const modelMatches = audit.decisionProvider !== undefined
    ? audit.decisionProvider === decisionProvider && audit.decisionModel === decisionModel
    : decisionProvider === "clef" && audit.clefModel === decisionModel
  if (!modelMatches) return denied([QUALITY_GATE_MODEL_MISMATCH])
  if (audit.ruleVersion !== QUALITY_RULE_VERSION) return denied([QUALITY_GATE_RULE_MISMATCH])
  if (audit.outcome !== "passed") return denied([QUALITY_GATE_AUDIT_NOT_PASSED])

  // Never trust the outcome flag alone: an in-process envelope may have been
  // tampered with after recording, so the verdicts must still reduce to an
  // all-page pass over every declared page.
  const declaredPages = Array.from({ length: input.envelope.declaredPageCount }, (_, index) => index + 1)
  try {
    const outcome = reduceDocumentQuality({ ruleVersion: audit.ruleVersion, declaredPages, verdicts: audit.verdicts })
    if (!outcome.passed) return denied([QUALITY_GATE_AUDIT_INCOHERENT])
  } catch (error) {
    if (error instanceof QualityContractError) return denied([QUALITY_GATE_AUDIT_INCOHERENT])
    throw error
  }

  return { passed: true, reasonCodes: [], reason: null }
}
