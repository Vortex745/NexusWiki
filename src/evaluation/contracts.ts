/**
 * Eval refactor Ticket 04 — task/result contracts shared by the service, the
 * HTTP API, and the page. One shape, no per-consumer projections.
 *
 * Memory-only by design: nothing here is persisted to SQLite, JSON files, or
 * a persistent trace backend (spec "任务、上传数据集和结果只存内存").
 */

import type { AnswerTerminalStatus } from "../types"
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
  runId?: string
  durationMs: number
  /** Per-case metric values; null = not applicable for this case. */
  metrics: Record<string, number | null>
  /** Distinct passage ids in rank order (first occurrence wins). */
  retrievedPassageIds: string[]
  candidates: EvalRankedCandidate[]
  /** How many candidates could not be mapped back to this corpus. */
  unmappedCandidates: number
}

/** Aggregate of one metric across cases (sample size is always explicit). */
export interface EvalMetricSummary {
  value: number | null
  sampleSize: number
  notApplicable: number
}

export interface EvalMetricsSummary {
  version: string
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

/** Redacted configuration snapshot — never contains credentials. */
export interface EvalTaskConfigSnapshot {
  chatModel: string
  rerankModel: string | null
  embeddingModel: string
  rerankSource: "dedicated_rerank" | "not_configured"
}

export interface EvalTaskSummary {
  id: string
  dataset: EvalTaskDatasetRef
  stage: EvalTaskStage
  progress: { finished: number; total: number }
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
