/**
 * Eval refactor Ticket 04 — retrieval metrics (Precision first).
 *
 * Input is the ordered, deduplicated view of the FINAL generation round's
 * candidate list, projected onto stable passageIds. Ticket 06 adds Recall /
 * NDCG@3 / NDCG@10 / MRR / MAP to this same module and version stamp.
 *
 * Metric rules fixed here (spec "指标口径"):
 *   - Precision denominator = number of distinct candidate passages actually
 *     returned (a filtered-away irrelevant passage would inflate the score).
 *   - Passage dedupe keeps the FIRST occurrence's position.
 *   - Unmappable candidates (no passageId) stay in the ranking as diagnostic
 *     positions and count as non-relevant — never silently dropped.
 *   - GT present with no recall → 0; empty GT → not applicable (null).
 */

export const EVAL_METRIC_VERSION = "eval-metrics-v1"

export interface ScoredCandidate {
  /** Stable corpus passageId, or null when the candidate could not be mapped
   * back to this dataset's corpus (diagnostic position). */
  passageId: string | null
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

/**
 * Precision over the published candidate ranking.
 * Returns null only when the case has no ground-truth passages (not
 * applicable) — with GT present, a miss scores 0, not "no data".
 */
export function precision(
  candidates: readonly ScoredCandidate[],
  relevantPassageIds: readonly string[]
): number | null {
  if (relevantPassageIds.length === 0) return null
  const distinct = dedupeByPassageId(candidates)
  if (distinct.length === 0) return 0
  const hits = distinct.filter((candidate) => candidate.relevant).length
  return hits / distinct.length
}
