// Ticket 10 Phase D P1 — Evaluation types + golden set schema foundation.
//
// Spec references (tickets.md):
//   §9 L1554-1562 — Offline evaluation and release thresholds
//   §10 L1564-1569 — Real dependency release gate
//
// These types are consumed by:
//   - golden/schema.ts (P1) — structural validation of golden set fixtures
//   - hard_invariants.ts (P3) — deterministic release invariants
//   - quality_metrics.ts (P4) — threshold-based quality metrics
//   - artifact.ts (P5) — machine-readable artifact writer
//   - smoke.ts (P6) — real dependency smoke gate
//
// Evaluation runner consumes public Answer run events (AnswerRunEvent) and
// IngestionLifecycle behavior only — it must not call private Planner,
// Searcher or repository methods (spec L1488).

import type { AnswerTerminalStatus } from "../types/answer"
import type { RouterDecision } from "../types/agent"

// ---------------------------------------------------------------------------
// Spec §9 L1556-1557: Golden set
// ---------------------------------------------------------------------------

/**
 * Spec L1556: golden set contains at least 60 versioned cases across 6
 * categories. `REQUIRED_CATEGORY_COUNTS` encodes the minimum counts.
 */
export type GoldenCaseCategory =
  | "direct" // ≥10
  | "simple" // ≥15
  | "complex" // ≥10
  | "ambiguous" // ≥10 (ambiguous/clarification)
  | "insufficient" // ≥10 (insufficient/degraded)
  | "correction" // ≥5

/** Spec L1556: required minimum counts per category (10+15+10+10+10+5 = 60). */
export const REQUIRED_CATEGORY_COUNTS: Record<GoldenCaseCategory, number> = {
  direct: 10,
  simple: 15,
  complex: 10,
  ambiguous: 10,
  insufficient: 10,
  correction: 5,
}

/**
 * Ticket 10 (tool-loop evaluation gates): scenario tags for golden cases that
 * exercise specific tool-loop behaviors. When present, the evaluation framework
 * applies tool-loop-specific invariants and metrics (criterion #1, #2, #5).
 */
export type ToolLoopScenario =
  | "single-tool" // simple route: LLM picks one read-only tool
  | "multi-tool" // complex route: LLM alternates ≥2 different tools
  | "duplicate-call" // complex route: duplicate tool call pressure (criterion #6)
  | "budget-exhaustion" // complex route: iteration or tool-call budget exhausted
  | "cancellation" // user cancellation during tool-loop decision or retrieval
  | "deterministic-fallback" // correction round: 0 loop results → searcher fallback

/**
 * Ticket 10 (criterion #3): the approved read-only retrieval tool set. Any tool
 * registered or executed outside this set is an authorization violation
 * (hard invariant `unauthorized_tool_rejection`).
 */
export const APPROVED_READ_ONLY_TOOLS: readonly string[] = [
  "semantic_lexical_hybrid",
  "graph_navigation",
  "pageindex_hierarchy",
]

/**
 * Spec L1557: each knowledge case declares expected Source identities or
 * acceptable Evidence IDs, required coverage criteria, and whether handoff
 * is acceptable. It does not embed secrets or unrestricted production
 * conversations.
 */
export interface GoldenCase {
  /** Versioned case identifier, e.g. "direct-01". Stable across versions. */
  id: string
  /** Case schema version — bumped when expected fields change shape. */
  version: number
  category: GoldenCaseCategory
  /** The user message fed into the Answer run. Bounded, synthetic, no secrets. */
  userMessage: string
  /** Expected Router decision. Direct/ambiguous always set; insufficient may omit. */
  expectedRoute?: RouterDecision
  /**
   * Spec L1557: expected Source identities. May be empty for `direct`
   * (no retrieval) and `ambiguous` (no retrieval until resumed).
   */
  expectedSourceIds: string[]
  /**
   * Spec L1557: acceptable Evidence IDs (alternative to expectedSourceIds).
   * Knowledge routes (simple/complex/insufficient/correction) must declare at
   * least one of expectedSourceIds / acceptableEvidenceIds non-empty.
   */
  acceptableEvidenceIds: string[]
  /** Spec L1557: required coverage criteria the answer must address. */
  requiredCoverageCriteria?: string[]
  /** Spec L1557: whether handoff is acceptable as a terminal status. */
  handoffAcceptable?: boolean
  /** Case rationale / scenario description. Not secrets, not production conversations. */
  notes?: string
  /**
   * Ticket 10 (criterion #1): tags this case as exercising a specific tool-loop
   * behavior. When present, the case is included in tool-loop-specific invariants
   * and quality metrics. When absent, the case is a general (non-tool-loop) case.
   */
  scenario?: ToolLoopScenario
  /**
   * Ticket 10 (criterion #2): expected maximum LLM decision iterations for this
   * case. The hard invariant `tool_loop_budget_termination` verifies the observed
   * `CaseResult.iterationsExecuted` does not exceed this value. When absent, the
   * default ceiling `COMPLEX_LOOP_MAX_ITERATIONS` (3) is used.
   */
  expectedMaxIterations?: number
  /**
   * Ticket 10 (criterion #2): expected maximum retrieval tool calls for this
   * case. The hard invariant `tool_loop_budget_termination` verifies the observed
   * `CaseResult.toolCallCount` does not exceed this value. When absent, the
   * default ceiling `COMPLEX_LOOP_MAX_TOOL_CALLS` (4) is used.
   */
  expectedMaxToolCalls?: number
  /**
   * Ticket 10 (criterion #5): when true, the case expects a deterministic
   * searcher fallback to occur (0 loop results → searcher.search). The quality
   * metric `tool_loop_fallback_rate` uses this to compute the expected-vs-actual
   * fallback rate.
   */
  expectedFallback?: boolean
  /**
   * Ticket 10 (criterion #6): when true, this case uses compressed Context
   * (semantic Evidence-Context compression). Compressed and uncompressed cases
   * must use the same expected Evidence and completion requirements.
   */
  compressed?: boolean
}

/** Spec L1556: versioned golden set with at least 60 cases. */
export interface GoldenSet {
  /** Dataset version, e.g. "2026.07". */
  version: string
  cases: GoldenCase[]
}

// ---------------------------------------------------------------------------
// Spec §9 L1558: Hard release invariants (deterministic, non-overridable)
// ---------------------------------------------------------------------------

export type HardInvariantKey =
  | "terminal_convergence_100"
  | "unknown_citation_count_zero"
  | "knowledge_completed_zero_refs_zero"
  | "unauthorized_evidence_zero"
  | "direct_route_completion_without_retrieval_95"
  | "cancellation_late_answer_zero"
  | "tool_loop_budget_termination"
  | "unauthorized_tool_rejection"

export interface HardInvariantResult {
  key: HardInvariantKey
  passed: boolean
  /** Human-readable expected value, e.g. "100% of runs reach a terminal status". */
  expected: string
  /** Human-readable actual value, e.g. "59/60 (98.3%)". */
  actual: string
  /** Case IDs that contributed to the failure (empty when passed). */
  failingCaseIds: string[]
}

// ---------------------------------------------------------------------------
// Spec §9 L1559: Quality thresholds
// ---------------------------------------------------------------------------

export type QualityMetricKey =
  | "retrieval_hit_at_10"
  | "expected_source_recall"
  | "required_criteria_coverage"
  | "citation_supported_claim_rate"
  | "correction_success"
  | "tool_loop_fallback_rate"

/** Spec L1559: minimum thresholds (fractions in [0,1]). */
export const QUALITY_THRESHOLDS: Record<QualityMetricKey, number> = {
  retrieval_hit_at_10: 0.85,
  expected_source_recall: 0.8,
  required_criteria_coverage: 0.8,
  citation_supported_claim_rate: 0.9,
  correction_success: 0.7,
  tool_loop_fallback_rate: 0.8,
}

export interface QualityMetricResult {
  key: QualityMetricKey
  threshold: number
  actual: number
  passed: boolean
  /** Number of cases the metric was computed over. */
  sampleSize: number
}

// ---------------------------------------------------------------------------
// Spec §9 L1561: Model-judge scores (reported separately, cannot override)
// ---------------------------------------------------------------------------

export interface ModelJudgeScore {
  caseId: string
  /** L1561: fixed evaluator model/configuration recorded in the artifact. */
  evaluatorModel: string
  /** Score in [0,1]. */
  score: number
  rationale?: string
}

// ---------------------------------------------------------------------------
// Spec §9 L1560: Baseline comparison (latency + token cost)
// ---------------------------------------------------------------------------

export interface BaselineComparison {
  p95LatencyMs: number
  p95LatencyBaselineMs: number
  /** True when p95 latency regresses by more than 20% over the baseline. */
  p95LatencyRegression: boolean
  averageTokens: number
  averageTokensBaseline: number
  /** True when average total tokens regress by more than 20% over the baseline. */
  averageTokensRegression: boolean
}

// ---------------------------------------------------------------------------
// Spec §9 L1562: Per-case status + machine-readable artifact
// ---------------------------------------------------------------------------

export type CaseResultStatus = "passed" | "failed" | "skipped"

export interface CaseResult {
  caseId: string
  status: CaseResultStatus
  terminalStatus?: AnswerTerminalStatus
  routeDecision?: RouterDecision
  retrievedEvidenceIds: string[]
  /** Citation IDs found in the approved answer text. */
  citationsInAnswer: string[]
  durationMs: number
  tokenCount: number
  failureReason?: string
  /** Spec L1562: redacted failure evidence — no prompts, no private content. */
  redactedFailureEvidence?: string
  /**
   * Ticket 10 (criterion #2): number of retrieval tool calls actually executed
   * (excludes duplicates). Derived from the public AnswerRunEvent retrieval
   * events with `complexLoop === true` and `duplicate === false`. Present only
   * for cases that entered the tool loop.
   */
  toolCallCount?: number
  /**
   * Ticket 10 (criterion #2): number of LLM decision iterations actually
   * executed. Derived from the route event's `complexLoopIterations`. Present
   * only for cases that entered the tool loop.
   */
  iterationsExecuted?: number
  /**
   * Ticket 10 (criterion #5): true when a deterministic `searcher.search`
   * fallback occurred (correction round with 0 loop results → fallback). Derived
   * from retrieval events with `fallback === true`.
   */
  fallbackUsed?: boolean
  /**
   * Ticket 10 (criterion #3): retrieval tools selected by the LLM during this
   * run (deduplicated). Derived from retrieval events' `selectedTool`. The hard
   * invariant `unauthorized_tool_rejection` verifies every entry is in
   * `APPROVED_READ_ONLY_TOOLS`.
   */
  selectedTools?: string[]
  /**
   * Ticket 10 (criterion #5): why the tool loop terminated. Derived from the
   * route event's `complexLoopStopReason`. Present only for cases that entered
   * the tool loop.
   */
  complexLoopStopReason?: string
}

/** Spec L1562: machine-readable artifact. */
export interface EvaluationArtifact {
  schemaVersion: 1
  /** Git revision (commit SHA) the evaluation ran against. */
  repositoryRevision: string
  /** Golden set version (GoldenSet.version). */
  datasetVersion: string
  providerModelIds: {
    chat: string
    embedding: string
    /** L1561: fixed evaluator model/configuration. */
    evaluator?: string
  }
  /** ISO 8601 timestamp. */
  generatedAt: string
  aggregateMetrics: {
    hardInvariants: HardInvariantResult[]
    qualityMetrics: QualityMetricResult[]
    baseline: BaselineComparison
    /** L1561: reported separately; deterministic failures cannot be overridden. */
    modelJudgeScores?: ModelJudgeScore[]
  }
  perCaseStatus: CaseResult[]
}

// ---------------------------------------------------------------------------
// Spec §10 L1564-1569: Real dependency smoke gate
// ---------------------------------------------------------------------------

export type SmokeCapabilityKey =
  | "markitdown"
  | "marker"
  | "mineru"
  | "elasticsearch_vector"
  | "elasticsearch_bm25"
  | "neo4j"
  | "pageindex"
  | "embedding"
  | "chat"
  | "cancellation"
  | "graceful_shutdown"
  | "langfuse"

/**
 * Spec L1567: missing capabilities are allowed for local development but are
 * not accepted as a production release pass. The artifact records skipped
 * capability checks as failures for the production profile.
 */
export type EvaluationProfile = "local" | "production"

export type SmokeResultStatus = "passed" | "skipped" | "failed"

export interface SmokeResult {
  capability: SmokeCapabilityKey
  profile: EvaluationProfile
  status: SmokeResultStatus
  /** Reason for skip or failure (undefined when passed). */
  reason?: string
  durationMs: number
}

/**
 * Spec L1568: smoke fixtures are bounded, synthetic and committed without
 * private data. They verify observable outputs and identities. The probe is
 * the caller-supplied function that invokes the real capability with a
 * committed fixture and verifies the observable output.
 */
export interface SmokeProbeResult {
  ok: boolean
  /** Failure reason (used when ok=false). */
  reason?: string
  /** Observable outputs/identities (L1568). */
  outputs?: string[]
}

/**
 * Caller-supplied async probe. The smoke runner does NOT own fixtures or
 * provider calls — it just invokes the probe and records the result.
 */
export type SmokeProbe = () => Promise<SmokeProbeResult>

/**
 * Bundle of optional probes per capability. Undefined probe = capability not
 * configured (skipped on local, failed on production per L1567).
 */
export interface SmokeProbeBundle {
  markitdown?: SmokeProbe
  marker?: SmokeProbe
  mineru?: SmokeProbe
  elasticsearch_vector?: SmokeProbe
  elasticsearch_bm25?: SmokeProbe
  neo4j?: SmokeProbe
  pageindex?: SmokeProbe
  embedding?: SmokeProbe
  chat?: SmokeProbe
  cancellation?: SmokeProbe
  graceful_shutdown?: SmokeProbe
  langfuse?: SmokeProbe
}
