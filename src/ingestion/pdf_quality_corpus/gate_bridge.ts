// Ticket 16: the corpus → quality-contract bridge.
//
// The golden corpus speaks its own closed-set vocabulary (issue labels such as
// `structure-unverified`, four assessed dimensions per page); the quality
// contract speaks verdicts with one dominant issue type per non-pass page.
// This module is the only place the two meet: it converts replay-served page
// answers into contract verdicts, enforces that every served verdict agrees
// with its own four-dimension conjunction (a pass can only stand on four
// passing dimensions), and hands the PdfPageQualityGate a QualityBatchEvaluator
// driven entirely by replay scenarios — no network, no model.
//
// The replay service refuses anything but a whole-cover request (requested ==
// coversPages), while the gate audits one page per request. The bridge there-
// fore pre-plays each scenario exactly once over its full cover, keeps the
// served per-page answers, and dispatches them by page number as the gate
// walks. Dispatch assumes the evaluator consumes one scenario per audit stage
// and stops at its first fault — exactly how evaluateDocumentQuality walks;
// a fault stops the walk, so a half-consumed scenario can never steal a
// dispatch from the next one.
import { clefCancellation, ClefProtocolError } from "../../clef/protocol_errors"
import type { QualityBatchOutcome } from "../quality/clef_page_quality"
import {
  QUALITY_CLEF_MODEL_ID,
  QUALITY_RULE_VERSION,
  QUALITY_JOINT_LABELS,
  type QualityJointLabel,
  QualityContractError,
  type PageQualityObservation,
  type PageQualityVerdict,
  type QualityContractErrorCode,
  type QualityIssueType,
  type QualityVerdict,
} from "../quality/contract"
import type { QualityBatchEvaluator } from "../quality/quality_evaluator"
import { PDF_QUALITY_DIMENSIONS, type DimensionAssessment } from "./corpus"
import {
  createReplayClefService,
  createReplayOcrService,
  loadReplayScenario,
  type ServedAnswerPage,
} from "./replay"

/**
 * The closed-set bridge from a corpus issue label to the contract's dominant
 * defect. Completeness markers (content visibly absent from the text, an
 * absent text layer, an audit that could not cover the page, an unavailable
 * page image) map to missing_content; accuracy markers to text_corruption;
 * the order marker to reading_order; and every unverifiable-or-flattened
 * structure marker — including `structure-unverified`, the closed-set rule's
 * "cannot be self-certified" verdict for obligation-bearing pages — to
 * structure_loss. `document-unreadable` is deliberately absent: an input
 * failure is never a page verdict, and the bridge refuses to convert one.
 */
export const LABEL_TO_ISSUE_TYPE: Readonly<Record<string, QualityIssueType>> = Object.freeze({
  "content-missing": "missing_content",
  "text-layer-absent": "missing_content",
  "audit-incomplete": "missing_content",
  "page-image-unavailable": "missing_content",
  "garbled-text-layer": "text_corruption",
  "content-fabricated": "text_corruption",
  "reading-order-broken": "reading_order",
  "structure-flattened": "structure_loss",
  "structure-unverified": "structure_loss",
})

/**
 * A pass stands only on four passing dimensions; any failing dimension means
 * fail and any remaining uncertain dimension means uncertain — the same
 * conjunction the answer's own labels encode. A served verdict that disagrees
 * with its own dimensions is an incoherent answer, not a verdict.
 */
function conjunctionVerdict(dimensions: Record<string, DimensionAssessment>): QualityVerdict {
  const assessments = PDF_QUALITY_DIMENSIONS.map((dimension) => dimensions[dimension])
  if (assessments.some((assessment) => assessment === "fail")) return "fail"
  if (assessments.some((assessment) => assessment === "uncertain")) return "uncertain"
  return "pass"
}

/**
 * Converts replay-served page answers into contract verdicts. Deterministic
 * observations are deterministic scripted joint choices, not provider measurements.
 * Legacy marginal probabilities remain in the original corpus records only. A pass must carry no defect label and a non-pass must name
 * exactly one dominant defect (labels agreeing on one issue type; disagreeing
 * labels are an incoherent answer).
 */
export function servedPagesToContractVerdicts(pages: readonly ServedAnswerPage[]): PageQualityVerdict[] {
  return pages.map((served) => {
    const expected = conjunctionVerdict(served.dimensions)
    if (served.verdict !== expected) {
      throw new QualityContractError(
        "answer_verdict_incoherent",
        `page ${served.page} verdict "${served.verdict}" disagrees with its four-dimension conjunction "${expected}"`
      )
    }
    const labels: readonly string[] = served.issueLabels.length > 0 ? served.issueLabels : ["none"]
    if (labels.includes("document-unreadable")) {
      throw new QualityContractError(
        "answer_issue_incoherent",
        `page ${served.page}: document-unreadable is an input failure and can never become a page verdict`
      )
    }
    const defects = labels.filter((label) => label !== "none")
    if (served.verdict === "pass" ? defects.length > 0 : defects.length === 0) {
      throw new QualityContractError(
        "answer_issue_incoherent",
        `page ${served.page} verdict "${served.verdict}" does not agree with its defect labels [${labels.join(", ")}]`
      )
    }
    const mapped = defects.map((label) => LABEL_TO_ISSUE_TYPE[label])
    if (defects.length > 0 && mapped.some((issueType) => issueType === undefined)) {
      throw new QualityContractError(
        "answer_issue_label_invalid",
        `page ${served.page} defect label is outside the bridgeable closed set: [${defects.join(", ")}]`
      )
    }
    const distinct = [...new Set(mapped)]
    if (distinct.length > 1) {
      throw new QualityContractError(
        "answer_issue_incoherent",
        `page ${served.page} names defect labels that disagree on the dominant defect: [${defects.join(", ")}]`
      )
    }
    const issueType = distinct[0]
    // This is an authored replay adapter, not a production response conversion.
    // A v1 marginal cannot recover a joint distribution. Script the resolved
    // semantic pair deterministically and retain original numbers in corpus data.
    const choice = (served.verdict === "pass" ? "pass_no_issue" : `${served.verdict}_${issueType}`) as QualityJointLabel
    const observation: PageQualityObservation = {
      jointDecision: {
        type: "choice",
        choice,
        probabilities: Object.fromEntries(QUALITY_JOINT_LABELS.map((label) => [label, label === choice ? 1 : 0])) as Record<QualityJointLabel, number>,
        confidence: 1,
      },
    }
    return { page: served.page, verdict: served.verdict, ...(issueType ? { issueType } : {}), observation }
  })
}

const BRIDGE_PAGE_IMAGE_BASE64 = "c2xpY2U="

const REPLAY_USAGE_INPUT = 1220
const REPLAY_USAGE_OUTPUT = 52

function batchOutcomeFor(verdict: PageQualityVerdict, requestedPages: readonly number[]): QualityBatchOutcome {
  return {
    ruleVersion: QUALITY_RULE_VERSION,
    requestedPages,
    verdicts: [verdict],
    usage: {
      promptTokens: REPLAY_USAGE_INPUT,
      completionTokens: REPLAY_USAGE_OUTPUT,
      totalTokens: REPLAY_USAGE_INPUT + REPLAY_USAGE_OUTPUT,
    },
    modelId: QUALITY_CLEF_MODEL_ID,
    actualModel: "@cf/cloudflare/clef",
    bodyBytes: 2048,
    durationMs: 1,
  }
}

/** The contract code for an answer set the replay's per-page check refused. */
function invalidReasonToCode(reason: string): QualityContractErrorCode {
  switch (reason) {
    case "unknown-verdict":
      return "answer_verdict_invalid"
    case "unknown-issue-label":
      return "answer_issue_label_invalid"
    case "missing-page":
      return "answer_missing"
    case "duplicate-page":
      return "duplicate_page_verdict"
    case "page-out-of-range":
      return "answer_page_unrequested"
    default:
      return "answer_type_invalid"
  }
}

interface PreplayedScenario {
  byPage: Map<number, ServedAnswerPage>
  /** Set on the first dispatch: the scenario's single fault, thrown as-is. */
  fault?: unknown
  exhausted: boolean
}

/**
 * Pre-plays each scenario once over its full cover and returns the gate's
 * one-page-per-request evaluator, dispatching served answers by page number.
 * A scenario whose scripted attempt is not an answer set (invalid body,
 * timeout, HTTP fault) becomes a thrown fault on its first dispatch, keeping
 * the evaluator's three outcome kinds — verdict, invalid response, service
 * failure — exactly as production's Clef seam raises them.
 */
export async function createReplayEvaluateBatch(scenarioIds: readonly string[]): Promise<QualityBatchEvaluator> {
  const preplayed: PreplayedScenario[] = []
  for (const scenarioId of scenarioIds) {
    const scenario = loadReplayScenario(scenarioId)
    const service = createReplayClefService({ scenarioId })
    const outcome = await service.auditPages({
      stage: scenario.stage,
      fixtureId: scenario.fixture,
      pages: scenario.coversPages.map((page) => ({ page, text: "", imageBase64: BRIDGE_PAGE_IMAGE_BASE64 })),
    })
    if (outcome.kind === "answered" || outcome.kind === "answered-from-durable-evidence") {
      preplayed.push({ byPage: new Map(outcome.pages.map((page) => [page.page, page])), exhausted: false })
      continue
    }
    if (outcome.kind === "invalid") {
      preplayed.push({
        byPage: new Map(),
        exhausted: false,
        fault: new QualityContractError(
          invalidReasonToCode(outcome.invalidReason),
          `replay scenario ${scenarioId} served an invalid answer set: ${outcome.invalidReason}`
        ),
      })
      continue
    }
    if (outcome.kind === "malformed") {
      preplayed.push({
        byPage: new Map(),
        exhausted: false,
        fault: new ClefProtocolError(
          "invalid_json",
          `replay scenario ${scenarioId} served a body that was not parseable JSON`
        ),
      })
      continue
    }
    if (outcome.kind === "timeout") {
      preplayed.push({
        byPage: new Map(),
        exhausted: false,
        fault: new ClefProtocolError(
          "timeout",
          `replay scenario ${scenarioId} timed out after ${outcome.timeoutMs}ms`
        ),
      })
      continue
    }
    if (outcome.kind === "service-error") {
      preplayed.push({
        byPage: new Map(),
        exhausted: false,
        fault: new ClefProtocolError(
          "http_status",
          `replay scenario ${scenarioId} answered HTTP ${outcome.httpStatus}`,
          { status: outcome.httpStatus }
        ),
      })
      continue
    }
    preplayed.push({ byPage: new Map(), exhausted: false, fault: clefCancellation("Clef quality") })
  }

  return async (input) => {
    if (input.pages.length !== 1) {
      throw new Error(`the replay bridge dispatches one page per request, received ${input.pages.length}`)
    }
    const page = input.pages[0].page
    const scenario = preplayed.find((entry) => !entry.exhausted && (entry.fault !== undefined || entry.byPage.has(page)))
    if (!scenario) {
      throw new Error(
        `no replay scenario in [${scenarioIds.join(", ")}] still serves page ${page}; the audit walked past its scripted covers`
      )
    }
    if (scenario.fault !== undefined) {
      scenario.exhausted = true
      throw scenario.fault
    }
    const served = scenario.byPage.get(page)!
    scenario.byPage.delete(page)
    if (scenario.byPage.size === 0) scenario.exhausted = true
    return batchOutcomeFor(servedPagesToContractVerdicts([served])[0], [page])
  }
}

/**
 * The one whole-document OCR attempt a gate's `ocrFallback` seam returns,
 * replayed from an OCR scenario: one text per declared page (page identity
 * preserved) and the attempt's provider call count — the two numbers the
 * persisted evidence must carry.
 */
export async function replayOcrCandidateTexts(
  scenarioId: string
): Promise<{ pageTexts: string[]; providerCallCount: number }> {
  const scenario = loadReplayScenario(scenarioId)
  const service = createReplayOcrService({ scenarioId })
  const outcome = await service.recognizeDocument({
    fixtureId: scenario.fixture,
    pageCount: scenario.coversPages.length,
  })
  if (outcome.kind !== "candidate" && outcome.kind !== "candidate-from-durable-evidence") {
    throw new Error(`replay OCR scenario ${scenarioId} did not serve a candidate (outcome: ${outcome.kind})`)
  }
  const pageTexts = scenario.coversPages.map((page) => {
    const entry = outcome.pages.find((candidate) => candidate.page === page)
    if (!entry) {
      throw new Error(`replay OCR scenario ${scenarioId} served no candidate text for page ${page}`)
    }
    return entry.text
  })
  return { pageTexts, providerCallCount: 1 }
}
