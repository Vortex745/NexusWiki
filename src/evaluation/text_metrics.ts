/**
 * Eval refactor Ticket 07 — BLEU-1/2/4 over the fixed text rules.
 *
 * Scored from the case's ACTUAL final reply against the dataset's reference
 * answer — never from a substituted reference (a legitimate refusal keeps its
 * own text and therefore its own honest low score). These are text-similarity
 * numbers: they are not accuracy, not faithfulness, and not a semantic judge.
 *
 * Formula (fixed here, no RAGAS involved):
 *   - Modified n-gram precision with clipping: matched_n = Σ min(hyp count,
 *     ref count) over the reference's n-grams; total_n = max(0, |hyp| - n + 1).
 *   - Smoothing (Lin & Och "add 1 to zero counts"), applied to orders n ≥ 2
 *     only: a zero match scores 1/(total_n + 1). Order 1 is NOT smoothed, so an
 *     answer with no shared unigram scores a real 0 instead of a floor value.
 *   - Brevity penalty: 1 when the hypothesis is at least as long as the
 *     reference, otherwise exp(1 - |ref|/|hyp|).
 *   - BLEU-n = BP · exp(Σ_{k≤n} (1/n)·ln(prec_k)); uniform weights. A zero
 *     precision anywhere yields exactly 0 — the output can never be NaN or
 *     Infinity.
 *   - Empty reference → not applicable (null): there is nothing to compare
 *     against. Empty hypothesis with a real reference → 0.
 */

import { EVAL_TEXT_RULE_VERSION, tokenizeEvalText } from "./text_rules"

export const EVAL_BLEU_VERSION = "eval-bleu-v1"

export const EVAL_BLEU_KEYS = ["bleu-1", "bleu-2", "bleu-4"] as const
export type EvalBleuKey = (typeof EVAL_BLEU_KEYS)[number]
export type BleuMetrics = Record<EvalBleuKey, number | null>

export type BleuOrder = 1 | 2 | 4

function ngramCounts(tokens: readonly string[], n: number): Map<string, number> {
  const counts = new Map<string, number>()
  for (let start = 0; start + n <= tokens.length; start += 1) {
    const gram = tokens.slice(start, start + n).join("\u0000")
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  return counts
}

/** Σ min(hypothesis count, reference count) — clipping, so repetition cannot score. */
function clippedMatches(
  hypothesis: readonly string[],
  reference: readonly string[],
  n: number
): number {
  const referenceCounts = ngramCounts(reference, n)
  let matched = 0
  for (const [gram, count] of ngramCounts(hypothesis, n)) {
    matched += Math.min(count, referenceCounts.get(gram) ?? 0)
  }
  return matched
}

function modifiedPrecision(
  hypothesis: readonly string[],
  reference: readonly string[],
  n: number
): number {
  const total = Math.max(0, hypothesis.length - n + 1)
  if (total === 0) return 0
  const clipped = clippedMatches(hypothesis, reference, n)
  if (clipped > 0) return clipped / total
  // Lin & Och add-1-to-zero smoothing for higher orders only.
  return n === 1 ? 0 : 1 / (total + 1)
}

function brevityPenalty(hypothesisLength: number, referenceLength: number): number {
  if (hypothesisLength === 0) return 0
  if (hypothesisLength >= referenceLength) return 1
  return Math.exp(1 - referenceLength / hypothesisLength)
}

/**
 * BLEU-n for one pair of texts, or null when the reference carries no tokens
 * (not applicable). The result is always a finite number in [0, 1].
 */
export function bleu(hypothesis: string, reference: string, order: BleuOrder): number | null {
  const hypothesisTokens = tokenizeEvalText(hypothesis)
  const referenceTokens = tokenizeEvalText(reference)
  if (referenceTokens.length === 0) return null
  if (hypothesisTokens.length === 0) return 0

  const weight = 1 / order
  let logSum = 0
  for (let n = 1; n <= order; n += 1) {
    const precision = modifiedPrecision(hypothesisTokens, referenceTokens, n)
    // A zero precision makes the geometric mean exactly 0 (ln(0) = -∞).
    if (precision <= 0) return 0
    logSum += weight * Math.log(precision)
  }

  const score =
    brevityPenalty(hypothesisTokens.length, referenceTokens.length) * Math.exp(logSum)
  if (!Number.isFinite(score)) return 0
  return Math.min(1, Math.max(0, score))
}

/** BLEU-1/2/4 for one case, all three from the same token sequences. */
export function bleuMetrics(hypothesis: string, reference: string): BleuMetrics {
  return {
    "bleu-1": bleu(hypothesis, reference, 1),
    "bleu-2": bleu(hypothesis, reference, 2),
    "bleu-4": bleu(hypothesis, reference, 4),
  }
}

/** Every BLEU "not applicable" — used when a case produced no reply at all. */
export function notApplicableBleuMetrics(): BleuMetrics {
  return { "bleu-1": null, "bleu-2": null, "bleu-4": null }
}

/** The text rules the numbers above were computed with (shown on the page). */
export const EVAL_BLEU_TEXT_RULE_VERSION = EVAL_TEXT_RULE_VERSION
