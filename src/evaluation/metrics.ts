/**
 * Eval refactor Ticket 04/06 — retrieval metrics.
 *
 * Input is the ordered, deduplicated view of the FINAL generation round's
 * candidate list, projected onto stable passageIds. The six metrics share one
 * scoring口径 so the API and the page cannot disagree:
 *
 * Metric rules fixed here (spec "指标口径"):
 *   - Denominator = number of distinct candidate passages actually returned
 *     (a filtered-away irrelevant passage would inflate the score).
 *   - Passage dedupe keeps the FIRST occurrence's position.
 *   - Unmappable candidates (no passageId) keep their diagnostic ranking
 *     position and count as non-relevant — never silently dropped.
 *   - Relevance is decided by the ground-truth set passed in alongside the
 *     ranking. The caller's per-candidate `relevant` flag is a display copy of
 *     that decision and is not read here.
 *   - GT present with no recall → 0; empty GT → not applicable (null), never a
 *     fake full score.
 *   - NDCG's ideal list is defined by K and the ground truth alone
 *     (IDCG@K over min(K, |GT|) perfect hits), so it never depends on what was
 *     actually retrieved.
 *   - The per-case `map` value is this case's average precision; its average
 *     across cases is MAP (the sixth displayed retrieval metric).
 *
 * Ticket 06 adds Recall / NDCG@3 / NDCG@10 / MRR / MAP to the Precision that
 * ticket 04 introduced, and bumps the version stamp with the key set.
 */

export const EVAL_METRIC_VERSION = "eval-metrics-v2"

/** The six retrieval metrics, in display order. */
export const EVAL_RETRIEVAL_METRIC_KEYS = [
  "precision",
  "recall",
  "ndcg@3",
  "ndcg@10",
  "mrr",
  "map",
] as const

export type EvalRetrievalMetricKey = (typeof EVAL_RETRIEVAL_METRIC_KEYS)[number]

/** NDCG cut-offs are part of the metric contract, not a page setting. */
export const EVAL_NDCG_CUTOFFS = [3, 10] as const

export type RetrievalMetrics = Record<EvalRetrievalMetricKey, number | null>

export interface ScoredCandidate {
  /** Stable corpus passageId, or null when the candidate could not be mapped
   * back to this dataset's corpus (diagnostic position). */
  passageId: string | null
  /** Display copy of the ground-truth decision; scoring uses the GT set. */
  relevant: boolean
}

/**
 * Deduplicate by passageId keeping the first occurrence's position. Unmapped
 * candidates (null) are identity-less and therefore each keep their own slot.
 */
export function dedupeByPassageId(
  candidates: readonly ScoredCandidate[]
): ScoredCandidate[] {
  const seen = new Set<string>()
  const out: ScoredCandidate[] = []
  for (const candidate of candidates) {
    if (candidate.passageId === null) {
      out.push(candidate)
      continue
    }
    if (seen.has(candidate.passageId)) continue
    seen.add(candidate.passageId)
    out.push(candidate)
  }
  return out
}

/** Distinct ranked positions that actually carry a ground-truth passage. */
function rankedHits(
  distinct: readonly ScoredCandidate[],
  relevant: ReadonlySet<string>
): number[] {
  const positions: number[] = []
  distinct.forEach((candidate, index) => {
    if (candidate.passageId !== null && relevant.has(candidate.passageId)) {
      positions.push(index + 1)
    }
  })
  return positions
}

/**
 * Precision over the published candidate ranking: relevant candidates divided
 * by distinct candidates. Returns null only when the case has no ground-truth
 * passages (not applicable) — with GT present, a miss scores 0.
 */
export function precision(
  candidates: readonly ScoredCandidate[],
  relevantPassageIds: readonly string[]
): number | null {
  const relevant = new Set(relevantPassageIds)
  if (relevant.size === 0) return null
  const distinct = dedupeByPassageId(candidates)
  if (distinct.length === 0) return 0
  return rankedHits(distinct, relevant).length / distinct.length
}

/**
 * Recall: ground-truth passages that appear anywhere in the ranking, over the
 * number of ground-truth passages.
 */
export function recall(
  candidates: readonly ScoredCandidate[],
  relevantPassageIds: readonly string[]
): number | null {
  const relevant = new Set(relevantPassageIds)
  if (relevant.size === 0) return null
  const distinct = dedupeByPassageId(candidates)
  return rankedHits(distinct, relevant).length / relevant.size
}

/**
 * Reciprocal rank of the FIRST relevant position (1-based over the distinct
 * ranking). Averaged across cases this is MRR. No relevant passage at all
 * (with GT present) scores 0, not "not applicable".
 */
export function reciprocalRank(
  candidates: readonly ScoredCandidate[],
  relevantPassageIds: readonly string[]
): number | null {
  const relevant = new Set(relevantPassageIds)
  if (relevant.size === 0) return null
  const positions = rankedHits(dedupeByPassageId(candidates), relevant)
  return positions.length > 0 ? 1 / positions[0] : 0
}

/**
 * Average precision for one case: mean of precision@k over the positions of
 * the retrieved relevant passages, with the ground-truth count as denominator
 * (so a missing ground-truth passage lowers the score instead of being
 * ignored). Its average across cases is MAP.
 */
export function averagePrecision(
  candidates: readonly ScoredCandidate[],
  relevantPassageIds: readonly string[]
): number | null {
  const relevant = new Set(relevantPassageIds)
  if (relevant.size === 0) return null
  const positions = rankedHits(dedupeByPassageId(candidates), relevant)
  if (positions.length === 0) return 0
  const sum = positions.reduce((total, position, index) => total + (index + 1) / position, 0)
  return sum / relevant.size
}

/**
 * NDCG@K with binary gains, over the distinct ranking. IDCG@K uses
 * min(K, |GT|) perfect hits, so the ideal list comes from K and the ground
 * truth only.
 */
export function ndcg(
  candidates: readonly ScoredCandidate[],
  relevantPassageIds: readonly string[],
  k: number
): number | null {
  if (!Number.isInteger(k) || k <= 0) return null
  const relevant = new Set(relevantPassageIds)
  if (relevant.size === 0) return null
  const distinct = dedupeByPassageId(candidates)
  const positions = rankedHits(distinct, relevant)
  const dcg = positions
    .filter((position) => position <= k)
    .reduce((total, position) => total + 1 / Math.log2(position + 1), 0)
  const idealHits = Math.min(k, relevant.size)
  let idcg = 0
  for (let index = 1; index <= idealHits; index += 1) {
    idcg += 1 / Math.log2(index + 1)
  }
  return idcg > 0 ? dcg / idcg : null
}

/** All six retrieval metrics for one case, computed from the same ranking. */
export function retrievalMetrics(
  candidates: readonly ScoredCandidate[],
  relevantPassageIds: readonly string[]
): RetrievalMetrics {
  return {
    precision: precision(candidates, relevantPassageIds),
    recall: recall(candidates, relevantPassageIds),
    "ndcg@3": ndcg(candidates, relevantPassageIds, 3),
    "ndcg@10": ndcg(candidates, relevantPassageIds, 10),
    mrr: reciprocalRank(candidates, relevantPassageIds),
    map: averagePrecision(candidates, relevantPassageIds),
  }
}

/**
 * Every metric "not applicable" — used when a case failed before producing a
 * scorable ranking. Reporting 0 there would launder a provider failure into a
 * retrieval failure.
 */
export function notApplicableRetrievalMetrics(): RetrievalMetrics {
  return {
    precision: null,
    recall: null,
    "ndcg@3": null,
    "ndcg@10": null,
    mrr: null,
    map: null,
  }
}
