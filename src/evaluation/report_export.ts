/**
 * Ticket 28 (EVAL-02A) — carry an evaluation report away as JSON or CSV.
 *
 * The evaluation product stays in-process (ticket 04): nothing is persisted.
 * An export is the explicit, user-triggered way to take a report into an
 * interview or a document, so it must be self-describing — actual outputs,
 * metric values, configuration snapshots and run status — and it must never
 * contain a credential (the config snapshot only ever holds model ids and
 * profile ids).
 *
 * CSV is written by hand (no dependency): RFC 4180 quoting, CRLF rows, and a
 * header that names every column. Task-level values repeat on every row so a
 * single row is still interpretable after a spreadsheet filter.
 */

import type { EvalCaseResult, EvalExportFormat, EvalTaskDetail } from "./contracts"
import { EVAL_RETRIEVAL_METRIC_KEYS } from "./metrics"
import { EVAL_BLEU_KEYS, EVAL_ROUGE_KEYS } from "./text_metrics"
import { EVAL_GENERATION_CONTEXT_METRIC_KEYS } from "./context_metrics"

/** Bumped when the export shape changes in a way a reader must notice. */
export const EVAL_EXPORT_FORMAT_VERSION = 3

/**
 * The metric columns, in the page's display order. Ticket 09 appends the
 * generation-context stage as its own column: the candidate-stage columns keep
 * their `eval-metrics-v2` meaning and a `""` cell still means "not applicable",
 * never a fabricated zero.
 */
export const EVAL_EXPORT_METRIC_KEYS: readonly string[] = [
  ...EVAL_RETRIEVAL_METRIC_KEYS,
  ...EVAL_GENERATION_CONTEXT_METRIC_KEYS,
  ...EVAL_BLEU_KEYS,
  ...EVAL_ROUGE_KEYS,
]

/** Filesystem-safe, deterministic name (no user text beyond the dataset name). */
export function evalExportFilename(
  detail: EvalTaskDetail,
  format: EvalExportFormat
): string {
  const safeName = detail.dataset.name
    .replace(/[^A-Za-z0-9\u4e00-\u9fff._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
  const base = safeName || "evaluation"
  return `${base}-${detail.id.slice(0, 8)}.${format}`
}

export function evalExportContentType(format: EvalExportFormat): string {
  return format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8"
}

/**
 * The full report: the task detail the API serves (actual answers, metrics,
 * cleanup evidence, config snapshot) wrapped with the export's own version and
 * timestamp, so a reader can tell where it came from.
 */
export function exportTaskJson(detail: EvalTaskDetail, exportedAt: string): string {
  return `${JSON.stringify(
    {
      formatVersion: EVAL_EXPORT_FORMAT_VERSION,
      exportedAt,
      task: detail,
    },
    null,
    2
  )}\n`
}

function csvField(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function csvRow(values: unknown[]): string {
  return `${values.map(csvField).join(",")}\r\n`
}

const CASE_COLUMNS = [
  "case_id",
  "question",
  "outcome",
  "terminal_status",
  "error",
  "answer",
  "reference_answer",
  "duration_ms",
  "ordering_source",
  "ordering_reason",
  "final_context_round",
  "run_id",
  "retrieved_passage_ids",
  "candidate_count",
  "unmapped_candidates",
  /**
   * PL-05 / PT-09: the generation-context stage travels with its own
   * availability, so a `""` metric cell in CSV says "not measured, here is why"
   * instead of looking like a zero.
   */
  "generation_context_availability",
  "generation_context_round",
  "generation_context_reason",
] as const

const TASK_COLUMNS = [
  "task_id",
  "dataset_name",
  "dataset_version",
  "dataset_digest",
  "stage",
  "assistant_id",
  "assistant_version",
  "assistant_digest",
  "chat_model",
  "rerank_model",
  "rerank_source",
  "embedding_model",
] as const

/**
 * One row per case. Metric columns keep their real values (`""` = not
 * applicable), never a fabricated zero, and the BLEU/ROUGE columns are the same
 * similarity diagnostics the page labels as such — the column names carry the
 * metric keys so nothing is silently re-interpreted as accuracy.
 */
export function exportTaskCsv(detail: EvalTaskDetail): string {
  const config = detail.config
  const assistant = config.assistant
  const taskValues: unknown[] = [
    detail.id,
    detail.dataset.name,
    detail.dataset.version,
    detail.dataset.contentDigest,
    detail.stage,
    assistant?.assistantId ?? "",
    assistant?.version ?? "",
    assistant?.configDigest ?? "",
    config.chatModel,
    config.rerankModel ?? "",
    config.rerankSource,
    config.embeddingModel,
  ]
  let body = csvRow([...TASK_COLUMNS, ...CASE_COLUMNS, ...EVAL_EXPORT_METRIC_KEYS])
  for (const item of detail.cases) {
    body += csvRow([
      ...taskValues,
      ...caseValues(item),
      ...EVAL_EXPORT_METRIC_KEYS.map((key) => {
        const value = item.metrics[key]
        return value === null || value === undefined || !Number.isFinite(value) ? "" : value
      }),
    ])
  }
  return body
}

function caseValues(item: EvalCaseResult): unknown[] {
  return [
    item.caseId,
    item.question,
    item.outcome,
    item.terminalStatus ?? "",
    item.error ?? "",
    item.answer,
    item.referenceAnswer,
    item.durationMs,
    item.ordering?.source ?? "",
    item.ordering?.reason ?? "",
    item.finalContextRound ?? "",
    item.runId ?? "",
    item.retrievedPassageIds.join(" "),
    item.candidates.length,
    item.unmappedCandidates,
    item.generationContextAvailability ?? "",
    item.generationContextRound ?? "",
    item.generationContextReason ?? "",
  ]
}
