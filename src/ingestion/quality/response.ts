import type { TokenUsage } from "../../types"
import { clefEnvelopeSchema, clefUsageSchema, type ClefProviderResult } from "../../clef/protocol_envelope"
import {
  QualityContractError,
  mapQualityUsage,
  validateJointDecision,
  jointDecisionVerdict,
  type PageQualityVerdict,
  type QualityContractErrorCode,
} from "./contract"

const QUESTION_NAME = /^page_([1-9]\d*)$/

function fail(code: QualityContractErrorCode, message: string): never {
  throw new QualityContractError(code, message)
}

/** The shared Clef wire result; kept under the quality-side name for its published contract. */
export type QualityProviderResult = ClefProviderResult

/** Transport-level envelope check; the answer set and usage stay untrusted until parseQualityAnswers. */
export function parseQualityResponseEnvelope(json: unknown): { result: QualityProviderResult } {
  const envelope = clefEnvelopeSchema.safeParse(json)
  if (!envelope.success) fail("response_envelope_invalid", "Clef quality provider returned an invalid response envelope")
  return { result: envelope.data.result }
}

export function parseQualityUsage(usage: unknown): TokenUsage {
  const parsed = clefUsageSchema.safeParse(usage)
  if (!parsed.success) fail("response_usage_invalid", "Clef quality provider returned invalid or missing usage")
  return mapQualityUsage(parsed.data)
}

/**
 * Turns one Clef quality response into exactly one verdict per requested page. Page numbers are
 * bound by the question name the caller sent, so an answer about an unrequested page, a missing
 * page answer, or a label outside the closed set is rejected rather than trusted.
 */
export function parseQualityAnswers(
  raw: unknown,
  requestedPages: readonly number[]
): { verdicts: readonly PageQualityVerdict[]; usage: TokenUsage; actualModel: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("response_envelope_invalid", "Clef quality provider result is not an object")
  }
  const result = raw as QualityProviderResult
  if (typeof result.model !== "string" || result.model.length === 0 || result.model.length > 128) {
    fail("response_envelope_invalid", "Clef quality provider did not report its actual model")
  }
  const usage = parseQualityUsage(result.usage)
  const answers = result.answers
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    fail("answer_missing", "Clef quality provider returned no answers")
  }

  const requested = new Set(requestedPages)
  const verdictAnswers = new Map<number, unknown>()
  for (const [key, value] of Object.entries(answers as Record<string, unknown>)) {
    const match = QUESTION_NAME.exec(key)
    if (!match) fail("answer_question_invalid", "Clef quality answer is not keyed by a canonical page question")
    const page = Number(match[1])
    if (!requested.has(page)) fail("answer_page_unrequested", `Clef quality answered page ${page}, which was not requested`)
    const target = verdictAnswers
    if (target.has(page)) fail("answer_question_invalid", `Clef quality answered the same page question twice`)
    target.set(page, value)
  }

  const verdicts: PageQualityVerdict[] = []
  for (const page of requestedPages) {
    if (!verdictAnswers.has(page)) fail("answer_page_missing", `Clef quality answer for page ${page} is missing`)
    const jointDecision = validateJointDecision(verdictAnswers.get(page), page)
    verdicts.push(Object.freeze({
      page,
      ...jointDecisionVerdict(jointDecision.choice),
      observation: Object.freeze({ jointDecision }),
    }))
  }

  return Object.freeze({ verdicts: Object.freeze(verdicts), usage, actualModel: result.model })
}
