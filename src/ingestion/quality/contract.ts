import type { TokenUsage } from "../../types"

export const QUALITY_RULE_VERSION = "pdf-page-quality-v2"
export const LEGACY_QUALITY_RULE_VERSION = "pdf-page-quality-v1"

/** Same provider model as question routing; declared here so quality never imports the router. */
export const QUALITY_CLEF_MODEL_ID = "@cf/cloudflare/clef"

export const QUALITY_VERDICTS = ["pass", "fail", "uncertain"] as const
export type QualityVerdict = (typeof QUALITY_VERDICTS)[number]

export const QUALITY_ISSUE_TYPES = ["missing_content", "text_corruption", "reading_order", "structure_loss"] as const
export type QualityIssueType = (typeof QUALITY_ISSUE_TYPES)[number]

export const QUALITY_NO_ISSUE_LABEL = "no_issue"
export type QualityIssueLabel = QualityIssueType | typeof QUALITY_NO_ISSUE_LABEL
export const QUALITY_ISSUE_LABELS: readonly QualityIssueLabel[] = [...QUALITY_ISSUE_TYPES, QUALITY_NO_ISSUE_LABEL]

// Live Clef rejects slash-delimited option IDs with HTTP 400; keep semantic
// verdict/issue pairs as stable identifiers using letters and underscores.
export const QUALITY_JOINT_LABELS = [
  "pass_no_issue", "fail_missing_content", "fail_text_corruption", "fail_reading_order", "fail_structure_loss",
  "uncertain_missing_content", "uncertain_text_corruption", "uncertain_reading_order", "uncertain_structure_loss",
] as const
export type QualityJointLabel = (typeof QUALITY_JOINT_LABELS)[number]
export interface QualityJointDecision {
  type: "choice"
  choice: QualityJointLabel
  probabilities: Record<QualityJointLabel, number>
  confidence: number
}

export type QualityContractErrorCode =
  | "empty_page_set"
  | "page_number_invalid"
  | "page_not_declared"
  | "page_out_of_document"
  | "duplicate_page"
  | "duplicate_page_verdict"
  | "verdict_invalid"
  | "issue_label_invalid"
  | "issue_label_conflict"
  | "observation_missing"
  | "image_bytes_missing"
  | "image_base64_invalid"
  | "image_size_mismatch"
  | "image_digest_mismatch"
  | "image_media_type_invalid"
  | "image_media_type_mismatch"
  | "image_content_invalid"
  | "image_content_truncated"
  | "image_page_mismatch"
  | "image_resolution_mismatch"
  | "image_resolution_invalid"
  | "image_resolution_too_large"
  | "image_too_large"
  | "image_aggregate_too_large"
  | "text_declaration_conflict"
  | "text_placeholder"
  | "batch_page_limit_exceeded"
  | "request_body_too_large"
  | "response_envelope_invalid"
  | "response_usage_invalid"
  | "answer_missing"
  | "answer_question_invalid"
  | "answer_page_unrequested"
  | "answer_page_missing"
  | "answer_issue_missing"
  | "answer_type_invalid"
  | "answer_verdict_invalid"
  | "answer_issue_label_invalid"
  | "answer_probability_invalid"
  | "answer_confidence_invalid"
  | "answer_verdict_incoherent"
  | "answer_issue_incoherent"

/**
 * Contract failures are permanent for the candidate: they carry a stable code and a
 * message built only from page numbers and limits, never model text or image payload.
 */
export class QualityContractError extends Error {
  constructor(readonly code: QualityContractErrorCode, message: string) {
    super(message)
    this.name = "QualityContractError"
  }
}

export interface LegacyPageQualityObservation {
  verdictProbabilities: Record<QualityVerdict, number>
  verdictConfidence: number
  issueProbabilities: Record<QualityIssueLabel, number>
  issueConfidence: number
}

export type PageQualityObservation = LegacyPageQualityObservation | { jointDecision: QualityJointDecision }

/** Revalidated on durable reads too: a selected joint label must remain its own argmax. */
export function validateJointDecision(raw: unknown, page: number): QualityJointDecision {
  const answer = raw as QualityJointDecision | undefined
  if (!answer || answer.type !== "choice") throw new QualityContractError("answer_type_invalid", `page ${page} joint answer must be a typed Choice`)
  if (!QUALITY_JOINT_LABELS.includes(answer.choice)) throw new QualityContractError("answer_verdict_invalid", `page ${page} joint choice is outside the closed set`)
  if (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) throw new QualityContractError("answer_confidence_invalid", `page ${page} joint confidence is not a bounded number`)
  const probabilities = answer.probabilities
  if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities) || Object.keys(probabilities).length !== QUALITY_JOINT_LABELS.length || !QUALITY_JOINT_LABELS.every((key) => Object.hasOwn(probabilities, key))) {
    throw new QualityContractError("answer_probability_invalid", `page ${page} joint probabilities do not cover the closed set exactly`)
  }
  const values = QUALITY_JOINT_LABELS.map((key) => probabilities[key])
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) || Math.abs(values.reduce((total, value) => total + value, 0) - 1) > 0.001 + Number.EPSILON) {
    throw new QualityContractError("answer_probability_invalid", `page ${page} joint probabilities must be bounded and sum to one`)
  }
  if (Math.max(...values) - probabilities[answer.choice] > 0.001 + Number.EPSILON) throw new QualityContractError("answer_verdict_incoherent", `page ${page} joint choice contradicts its probabilities`)
  return Object.freeze({ type: "choice", choice: answer.choice, probabilities: Object.freeze({ ...probabilities }), confidence: answer.confidence })
}

export function jointDecisionVerdict(choice: QualityJointLabel): { verdict: QualityVerdict; issueType?: QualityIssueType } {
  if (choice === "pass_no_issue") return { verdict: "pass" }
  const separator = choice.indexOf("_")
  const verdict = choice.slice(0, separator)
  const issueType = choice.slice(separator + 1)
  return { verdict: verdict as "fail" | "uncertain", issueType: issueType as QualityIssueType }
}

export interface PageQualityVerdict {
  page: number
  verdict: QualityVerdict
  issueType?: QualityIssueType
  observation: PageQualityObservation
}

export interface DocumentQualityOutcome {
  ruleVersion: string
  /** Every declared page carries a pass verdict; probability and confidence never enter this decision. */
  passed: boolean
  declaredPageCount: number
  evaluatedPageCount: number
  verdicts: readonly PageQualityVerdict[]
  failingPages: readonly number[]
  uncertainPages: readonly number[]
  unexaminedPages: readonly number[]
}

export function assertQualityPageNumber(page: number, context: string): void {
  if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 1) {
    throw new QualityContractError("page_number_invalid", `${context}: page number must be a positive safe integer`)
  }
}

function isQualityVerdict(value: unknown): value is QualityVerdict {
  return typeof value === "string" && (QUALITY_VERDICTS as readonly string[]).includes(value)
}

function isQualityIssueType(value: unknown): value is QualityIssueType {
  return typeof value === "string" && (QUALITY_ISSUE_TYPES as readonly string[]).includes(value)
}

/**
 * The single document-level verdict: one verdict per declared page, and pass only when
 * every declared page passed. Uncertain, failing and unexamined pages all block the pass.
 */
export function reduceDocumentQuality(input: {
  ruleVersion: string
  declaredPages: readonly number[]
  verdicts: readonly PageQualityVerdict[]
}): DocumentQualityOutcome {
  const declared = new Set<number>()
  for (const page of input.declaredPages) {
    assertQualityPageNumber(page, "declared page")
    if (declared.has(page)) throw new QualityContractError("duplicate_page", `page ${page} is declared more than once`)
    declared.add(page)
  }
  if (declared.size === 0) throw new QualityContractError("empty_page_set", "a quality document must declare at least one page")

  const byPage = new Map<number, PageQualityVerdict>()
  for (const verdict of input.verdicts) {
    if (!verdict || typeof verdict !== "object") {
      throw new QualityContractError("verdict_invalid", "quality verdict must be an object")
    }
    assertQualityPageNumber(verdict.page, "verdict page")
    if (!declared.has(verdict.page)) {
      throw new QualityContractError("page_not_declared", `verdict for page ${verdict.page} has no declared page`)
    }
    if (byPage.has(verdict.page)) {
      throw new QualityContractError("duplicate_page_verdict", `page ${verdict.page} has more than one verdict`)
    }
    if (!isQualityVerdict(verdict.verdict)) {
      throw new QualityContractError("verdict_invalid", `page ${verdict.page} verdict is outside the closed set`)
    }
    const labeled = verdict.issueType !== undefined
    if (labeled && !isQualityIssueType(verdict.issueType)) {
      throw new QualityContractError("issue_label_invalid", `page ${verdict.page} issue label is outside the closed set`)
    }
    if (verdict.verdict === "pass" ? labeled : !labeled) {
      throw new QualityContractError(
        "issue_label_conflict",
        `page ${verdict.page} must carry an issue label only when its verdict is not pass`
      )
    }
    const observation = verdict.observation
    if (!observation || typeof observation !== "object") {
      throw new QualityContractError("observation_missing", `page ${verdict.page} lost its model observation`)
    }
    if (input.ruleVersion === QUALITY_RULE_VERSION) {
      if (!("jointDecision" in observation)) throw new QualityContractError("observation_missing", `page ${verdict.page} requires a v2 joint observation`)
      const joint = validateJointDecision(observation.jointDecision, verdict.page)
      const derived = jointDecisionVerdict(joint.choice)
      if (derived.verdict !== verdict.verdict || derived.issueType !== verdict.issueType) throw new QualityContractError("issue_label_conflict", `page ${verdict.page} differs from its joint decision`)
    } else if (input.ruleVersion === LEGACY_QUALITY_RULE_VERSION) {
      if (!("verdictProbabilities" in observation) || !observation.verdictProbabilities || !observation.issueProbabilities || typeof observation.verdictConfidence !== "number" || typeof observation.issueConfidence !== "number") throw new QualityContractError("observation_missing", `page ${verdict.page} lost its legacy observation`)
    } else {
      throw new QualityContractError("verdict_invalid", "unsupported page-quality rule version")
    }
    byPage.set(verdict.page, verdict)
  }

  const sortedPages = [...declared].sort((left, right) => left - right)
  const verdicts: PageQualityVerdict[] = []
  const failingPages: number[] = []
  const uncertainPages: number[] = []
  const unexaminedPages: number[] = []
  for (const page of sortedPages) {
    const verdict = byPage.get(page)
    if (!verdict) {
      unexaminedPages.push(page)
      continue
    }
    verdicts.push(verdict)
    if (verdict.verdict === "fail") failingPages.push(page)
    else if (verdict.verdict === "uncertain") uncertainPages.push(page)
  }

  return Object.freeze({
    ruleVersion: input.ruleVersion,
    passed: unexaminedPages.length === 0 && failingPages.length === 0 && uncertainPages.length === 0,
    declaredPageCount: declared.size,
    evaluatedPageCount: verdicts.length,
    verdicts: Object.freeze(verdicts),
    failingPages: Object.freeze(failingPages),
    uncertainPages: Object.freeze(uncertainPages),
    unexaminedPages: Object.freeze(unexaminedPages),
  })
}

export function mapQualityUsage(usage: { input_tokens: number; output_tokens: number }): TokenUsage {
  return {
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens,
  }
}
