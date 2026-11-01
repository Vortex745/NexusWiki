/**
 * Conversation-context meter (2026-10-31).
 *
 * `usedTokens` is the session transcript accumulated since the last memory
 * compaction plus the rolling summary that rides every prompt. It is NOT the
 * literal prompt size: the runtime only ever feeds the rolling summary and the
 * latest six validated pairs, so a literal prompt-token gauge would sit flat
 * far below 100%. The meter exists to drive ONE visible event — when the
 * conversation footprint crosses `CONTEXT_COMPACT_TOKENS`, the session is
 * folded into long-term memory and the checkpoint resets the meter.
 */

import { estimatedTokenCount } from "../retrieval/context/assembler"

/** The upstream token estimator, re-exported as one stable seam for the meter. */
export const estimateContextTokens = estimatedTokenCount

export const DEFAULT_CONTEXT_COMPACT_TOKENS = 24_000

export interface ContextUsageInput {
  turns: ReadonlyArray<{ content: string; createdAt: string }>
  summary: string | null
  /** Newest turn covered by the last compaction; null = nothing compacted yet. */
  compactedThroughAt: string | null
  budgetTokens: number
}

export interface ContextUsageSnapshot {
  usedTokens: number
  summaryTokens: number
  budgetTokens: number
  percent: number
  compactedThroughAt: string | null
}

export function computeContextUsage(input: ContextUsageInput): ContextUsageSnapshot {
  const compactedThroughAt = input.compactedThroughAt
  const summaryTokens = input.summary ? estimateContextTokens(input.summary) : 0
  let usedTokens = summaryTokens
  for (const turn of input.turns) {
    if (compactedThroughAt !== null && turn.createdAt <= compactedThroughAt) continue
    usedTokens += estimateContextTokens(turn.content)
  }
  const percent =
    input.budgetTokens > 0
      ? Math.min(100, Math.floor((usedTokens / input.budgetTokens) * 100))
      : 100
  return {
    usedTokens,
    summaryTokens,
    budgetTokens: input.budgetTokens,
    percent,
    compactedThroughAt,
  }
}
