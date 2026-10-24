/**
 * Eval refactor Ticket 04 — task/result contracts shared by the service, the
 * HTTP API, and the page. One shape, no per-consumer projections.
 *
 * Memory-only by design: nothing here is persisted to SQLite, JSON files, or
 * a persistent trace backend (spec "任务、上传数据集和结果只存内存").
 */

import type {
  AnswerModelProfileSnapshot,
  AnswerTerminalStatus,
  FinalContextOrdering,
} from "../types"
import type { EvalDisposeReport } from "./isolated_resources"

/**
 * Task stages. `queued`/`preparing`/`running`/`cleaning` are transient;
 * `completed`/`completed_with_errors`/`failed` are terminal (spec).
 */
export type EvalTaskStage =
  | "queued"
  | "preparing"
  | "running"
  | "cleaning"
  | "completed"
  | "completed_with_errors"
  | "failed"

export const EVAL_TASK_TERMINAL_STAGES: readonly EvalTaskStage[] = [
  "completed",
  "completed_with_errors",
  "failed",
]

export type EvalCleanupReport = EvalDisposeReport

/**
 * Ticket 14: cleanup is incomplete when a release step failed, i.e. the scope
 * may still own an index or graph provenance. `skipped` is NOT a failure — it
 * means this scope never created resources, so there was nothing of its own to
 * release. Kept here so the service, the residue tool and the page agree on
 * what "not fully released" means.
 */
export function cleanupIncomplete(report: EvalCleanupReport | null): boolean {
  if (!report) return false
  return report.esIndex === "failed" || report.graphProvenance === "failed"
}

/** One ranked candidate of the FINAL generation round, joined to the corpus. */
export interface EvalRankedCandidate {
  /** 1-based position in the final ordered candidate list (the scoring input). */
  rank: number
  /** Stable corpus passageId, or null when the candidate does not belong to
   * this dataset's corpus (isolation/diagnostic case — kept in the ranking). */
  passageId: string | null
  documentId: string
  chunkId: string
  score: number
  channels: string[]
  relevant: boolean
}

export interface EvalCaseResult {
  caseId: string
  question: string
  /** Ground truth — display/diagnosis only, never sent to the answering agent. */
  referenceAnswer: string
  outcome: "answered" | "failed"
  /** The real final reply. Empty when the case failed before producing one. */
  answer: string
  /** Real terminal status of the Answer run (when one was produced). */
  terminalStatus?: AnswerTerminalStatus
  /** Failure reason when outcome is "failed" (provider/timeout/etc.). */
  error?: string
  /**
   * Ticket 06: how the scored ranking was produced — `dedicated_rerank` means
   * the configured reranker scored it, `fused` means an unscored order was
   * published (fusion, below-threshold, unavailable reranker, or a multi-query
   * merge). A degraded ranking is never labelled as a dedicated-rerank result.
   * Absent when no final round was published.
   */
  ordering?: FinalContextOrdering
  runId?: string
  /**
   * Ticket 27 (EVAL-01B2): the frozen model snapshot the shared Answer entry
   * stamped on this case's terminal event (ticket 17). It is the per-TASK
   * snapshot — the config copy plus the task's reranker — so an allowed
   * override is observable per case and can never be mistaken for the shared
   * configuration. Absent when the run produced no terminal result.
   */
  modelProfile?: AnswerModelProfileSnapshot
  durationMs: number
  /** Per-case metric values; null = not applicable for this case. */
  metrics: Record<string, number | null>
  /** Distinct passage ids in rank order (first occurrence wins). */
  retrievedPassageIds: string[]
  /**
   * 1-based generation round whose context produced the scored ranking
   * (1 = initial draft, +1 per correction regeneration). Ticket 13: this is
   * what makes "which evidence did the last accepted correction use" visible.
   */
  finalContextRound?: number
  /** The scored ranking itself, in the order the scorer saw it. */
  candidates: EvalRankedCandidate[]
  /** How many candidates could not be mapped back to this corpus. */
  unmappedCandidates: number
  /**
   * PL-05 / PT-09: the generation-context stage, scored only from a real
   * `generation-context-v1` snapshot. `availability` explains why the context
   * metric is null (empty GT / legacy record without a snapshot / a run that
   * never called a generator) so an old report can never be read as a 0.
   */
  generationContextAvailability?: import("./context_metrics").GenerationContextAvailability
  generationContextReason?: string
  /** The real generation round the scored context comes from. */
  generationContextRound?: number
  generationContextRepresentation?: import("../types/answer").GenerationContextRepresentation
  generationContextTokenCount?: number
  generationContextVersion?: string
}

/** Aggregate of one metric across cases (sample size is always explicit). */
export interface EvalMetricSummary {
  value: number | null
  sampleSize: number
  notApplicable: number
}

export interface EvalMetricsSummary {
  version: string
  /**
   * Ticket 07/08: the generation-side metrics behind the similarity numbers
   * and the text rules they share, so the page can state the口径 instead of
   * implying the scores are accuracy.
   */
  generation?: { bleuVersion: string; rougeVersion: string; textRuleVersion: string }
  /**
   * PL-05: the actual-context stage carries its own version so a candidate-stage
   * average and a generation-context average can never be silently compared.
   */
  context?: { version: string }
  metrics: Record<string, EvalMetricSummary>
}

export interface EvalTaskDatasetRef {
  /** Built-in dataset id when the task used a built-in sample. */
  id?: string
  name: string
  version: string
  contentDigest: string
  caseCount: number
  passageCount: number
}

/**
 * Ticket 28 (EVAL-02A): an IMMUTABLE assistant configuration snapshot — either
 * a stored assistant version or one of the built-in comparison configurations.
 *
 * Only the execution-relevant subset travels here: the leading system prompt
 * and the rerank binding. Knowledge-base bindings are deliberately excluded —
 * an evaluation's corpus is its dataset, and re-resolving a tenant knowledge
 * base inside an isolated eval scope would silently narrow the run to nothing.
 * `configDigest` covers exactly those execution fields, so two snapshots with
 * the same digest always ran under the same configuration.
 */
export interface EvalAssistantSnapshot {
  assistantId: string
  version: number
  name: string
  configDigest: string
  /** "" = no leading prompt (the built-in comparison pair has none). */
  systemPrompt: string
  /** `null` = this configuration runs WITHOUT the dedicated reranker. */
  rerankModelProfileId: "rerank" | null
  /**
   * Ticket 34 (TOOL-01A): the tool allowlist the version pins — evaluations
   * run the same bounded tools normal chat runs, never more.
   */
  toolPolicy: "none" | "read_only_retrieval"
}

/** Redacted configuration snapshot — never contains credentials. */
export interface EvalTaskConfigSnapshot {
  chatModel: string
  rerankModel: string | null
  embeddingModel: string
  rerankSource: "dedicated_rerank" | "not_configured"
  /** Ticket 28: the assistant snapshot this task ran with, when it named one. */
  assistant?: EvalAssistantSnapshot
}

/** Export formats a settled task can be carried away in (ticket 28). */
export type EvalExportFormat = "json" | "csv"

export interface EvalTaskExport {
  format: EvalExportFormat
  filename: string
  contentType: string
  body: string
}

/** One metric of a comparison: both sides plus the delta (right − left). */
export interface EvalComparisonMetric {
  left: number | null
  right: number | null
  delta: number | null
}

export interface EvalComparisonCase {
  caseId: string
  question: string
  left: {
    outcome: EvalCaseResult["outcome"]
    answer: string
    ordering?: FinalContextOrdering
    metrics: Record<string, number | null>
  }
  right: {
    outcome: EvalCaseResult["outcome"]
    answer: string
    ordering?: FinalContextOrdering
    metrics: Record<string, number | null>
  }
}

export interface EvalComparisonSide {
  taskId: string
  stage: EvalTaskStage
  assistant?: EvalAssistantSnapshot
  config: EvalTaskConfigSnapshot
  metrics: EvalMetricsSummary
}

/**
 * Ticket 28: two immutable configurations compared on the SAME dataset. The
 * comparison is only defined when both tasks ran the same content digest —
 * anything else would compare two different questions.
 */
export interface EvalComparison {
  formatVersion: number
  dataset: { name: string; version: string; contentDigest: string }
  left: EvalComparisonSide
  right: EvalComparisonSide
  metrics: Record<string, EvalComparisonMetric>
  cases: EvalComparisonCase[]
  /** True when the two snapshots differ ONLY in the rerank binding. */
  rerankComparison: boolean
}

export interface EvalTaskSummary {
  id: string
  dataset: EvalTaskDatasetRef
  stage: EvalTaskStage
  progress: { finished: number; total: number }
  /**
   * Ticket 10: how the settled cases ended. `degraded` is a subset of
   * `answered` — a case whose published ranking was NOT scored by the
   * dedicated reranker (fused fallback, unavailable reranker, merged order).
   * A low score is never counted as a failure: only a case that never produced
   * a reply is `failed`.
   */
  counts: { answered: number; failed: number; degraded: number }
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

export interface EvalTaskDetail extends EvalTaskSummary {
  config: EvalTaskConfigSnapshot
  cases: EvalCaseResult[]
  metrics: EvalMetricsSummary
  /** Cleanup evidence — independent from the run outcome (spec). */
  cleanup: EvalCleanupReport | null
  /** Task-level failure (prepare failed, capacity, timeout). Never overwrites a
   *  cleanup error: the two are reported separately. */
  error?: string
}
