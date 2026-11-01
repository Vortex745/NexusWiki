/**
 * Ticket 31 (FAQ-01B) — deterministic FAQ matching over ACTIVE entries.
 *
 * Two matchers, both pure and LLM-free:
 *
 *  - Exact: the normalized message equals the entry's normalized question OR
 *    one of its normalized variants. The ticket's contract is "a UNIQUE exact
 *    match answers directly" — zero matches, or two entries matching (two
 *    knowledge bases in scope may both carry the same question), means no
 *    direct answer, never a guess between standards.
 *  - Fuzzy: containment between the normalized message and the question or a
 *    variant, with a length floor so a two-character question cannot match
 *    everything. Fuzzy matches never answer directly — they only become
 *    evidence in the normal cited path.
 *
 * Both read only what `FaqEntryService.listActive` returns: disabled entries
 * are structurally absent (ticket 30), so they cannot match by construction.
 */

import { normalizeFaqQuestion } from "../types/faq"
import type { FaqActiveIdentityRow } from "./faq_entry_repo"

/** Containment matches below this many normalized characters are ignored. */
export const FAQ_FUZZY_MIN_CHARS = 6

/** How many fuzzy entries may join one search as evidence. */
export const FAQ_FUZZY_EVIDENCE_LIMIT = 3

export interface FaqExactMatch {
  row: FaqActiveIdentityRow
  /** True when the message hit a VARIANT of the entry rather than its question. */
  viaVariant: boolean
}

/**
 * The unique exact match for the message, or null. Zero matches and more
 * than one match both return null — an ambiguous question must fall through
 * to the normal cited answer path instead of silently picking a standard.
 */
export function matchExactFaq(
  rows: readonly FaqActiveIdentityRow[],
  message: string
): FaqExactMatch | null {
  const normalized = normalizeFaqQuestion(message)
  if (!normalized) return null
  let found: FaqExactMatch | null = null
  for (const row of rows) {
    if (row.normalizedQuestion === normalized) {
      if (found) return null
      found = { row, viaVariant: false }
      continue
    }
    if (row.variants.some((variant) => normalizeFaqQuestion(variant) === normalized)) {
      if (found) return null
      found = { row, viaVariant: true }
    }
  }
  return found
}

/**
 * Entries whose question or a variant contains the normalized query (or is
 * contained by it), longest overlap first. Exact equality always counts;
 * containment needs the {@link FAQ_FUZZY_MIN_CHARS} floor. Deterministic:
 * ties break by entry id.
 */
export function matchFuzzyFaqs(
  rows: readonly FaqActiveIdentityRow[],
  query: string,
  limit: number = FAQ_FUZZY_EVIDENCE_LIMIT
): FaqActiveIdentityRow[] {
  const normalized = normalizeFaqQuestion(query)
  if (!normalized || limit <= 0) return []
  const scored: Array<{ row: FaqActiveIdentityRow; overlap: number }> = []
  for (const row of rows) {
    let best = 0
    for (const candidate of [row.normalizedQuestion, ...row.variants.map(normalizeFaqQuestion)]) {
      if (!candidate) continue
      if (candidate === normalized) {
        best = Math.max(best, candidate.length)
        continue
      }
      if (
        candidate.length >= FAQ_FUZZY_MIN_CHARS &&
        (normalized.includes(candidate) || candidate.includes(normalized))
      ) {
        best = Math.max(best, Math.min(candidate.length, normalized.length))
      }
    }
    if (best > 0) scored.push({ row, overlap: best })
  }
  scored.sort((left, right) =>
    right.overlap - left.overlap || left.row.entryId.localeCompare(right.row.entryId)
  )
  return scored.slice(0, limit).map(({ row }) => row)
}
