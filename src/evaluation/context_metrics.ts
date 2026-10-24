/**
 * PL-05 / PT-09 — the generation-context stage of evaluation.
 *
 * The six `eval-metrics-v2` retrieval metrics answer "did the RIGHT material
 * reach the candidate ranking?". This module answers a different question with
 * its own version stamp: "did authorized ground-truth material actually reach
 * the generator's context?". It is computed only from a real
 * `generation-context-v1` snapshot — never from `finalContextCandidates` and
 * never from the final reference list, because both of those can name material
 * the budget cut away.
 */
import { GENERATION_CONTEXT_SNAPSHOT_VERSION } from "../types/answer"
import type { GenerationContextSnapshot } from "../types/answer"

export const EVAL_GENERATION_CONTEXT_METRIC_VERSION =
  GENERATION_CONTEXT_SNAPSHOT_VERSION

export const EVAL_GENERATION_CONTEXT_METRIC_KEYS = [
  "generationContextEvidenceRecall",
] as const

export type EvalGenerationContextMetricKey =
  (typeof EVAL_GENERATION_CONTEXT_METRIC_KEYS)[number]

export type GenerationContextMetrics = Record<
  EvalGenerationContextMetricKey,
  number | null
>

/** Why the context stage has no number for this case. */
export type GenerationContextAvailability =
  | "measured"
  | "empty_ground_truth"
  | "missing_snapshot"
  | "not_generated"

export interface AdoptedContextSource {
  /** Stable corpus passage id, or null when it cannot be mapped (diagnostic). */
  passageId: string | null
  /** An entry counts only when it carries non-empty output in the context. */
  nonEmptyOutput: boolean
}

export interface GenerationContextOutcome {
  metrics: GenerationContextMetrics
  availability: GenerationContextAvailability
  reason?: string
}

/**
 * Numerator: distinct ground-truth passages whose material really sits in the
 * generation context. Denominator: distinct ground-truth passages. A non-empty
 * GT set with nothing adopted is 0 — honest miss, not "not applicable".
 */
export function generationContextEvidenceRecall(
  adopted: readonly AdoptedContextSource[],
  relevantPassageIds: readonly string[]
): number | null {
  const groundTruth = new Set(relevantPassageIds.filter(Boolean))
  if (groundTruth.size === 0) return null
  const hits = new Set<string>()
  for (const entry of adopted) {
    if (!entry.nonEmptyOutput) continue
    if (entry.passageId === null) continue
    if (groundTruth.has(entry.passageId)) hits.add(entry.passageId)
  }
  return hits.size / groundTruth.size
}

export function notApplicableGenerationContextMetrics(): GenerationContextMetrics {
  return { generationContextEvidenceRecall: null }
}

/**
 * Turns one real snapshot into the scored adoption list, or explains why the
 * case cannot be scored. An absent snapshot is NOT treated as an empty one.
 */
export function evaluateGenerationContext(
  snapshot: GenerationContextSnapshot | null | undefined,
  passageIdForSource: (entry: {
    documentId: string
    chunkId: string
  }) => string | null,
  relevantPassageIds: readonly string[],
  options: { generated: boolean; snapshotVersionKnown: boolean }
): GenerationContextOutcome {
  const nullMetrics = notApplicableGenerationContextMetrics()
  if (!options.generated) {
    return {
      metrics: nullMetrics,
      availability: "not_generated",
      reason: "本次运行没有实际生成调用，不能从候选或引用推断采用。",
    }
  }
  if (!snapshot) {
    return {
      metrics: nullMetrics,
      availability: "missing_snapshot",
      reason: "该运行的事件没有 generation-context-v1 快照（旧记录不回填）。",
    }
  }
  if (
    snapshot.version !== EVAL_GENERATION_CONTEXT_METRIC_VERSION ||
    !options.snapshotVersionKnown
  ) {
    return {
      metrics: nullMetrics,
      availability: "missing_snapshot",
      reason: `快照版本 ${snapshot.version} 与当前口径不可直接比较。`,
    }
  }
  const groundTruth = new Set(relevantPassageIds.filter(Boolean))
  if (groundTruth.size === 0) {
    return {
      metrics: nullMetrics,
      availability: "empty_ground_truth",
      reason: "该用例没有真值段落，上下文召回不适用。",
    }
  }
  const adopted: AdoptedContextSource[] = snapshot.entries.map((entry) => ({
    passageId: passageIdForSource(entry),
    // An entry with no output of its own (empty compressed block, zero-length
    // span) did not reach the generator.
    nonEmptyOutput:
      entry.representation === "compressed"
        ? entry.compressedBlockIndex !== undefined
        : entry.span !== undefined && entry.span.end > entry.span.start,
  }))
  return {
    metrics: {
      generationContextEvidenceRecall: generationContextEvidenceRecall(
        adopted,
        relevantPassageIds
      )!,
    },
    availability: "measured",
  }
}
