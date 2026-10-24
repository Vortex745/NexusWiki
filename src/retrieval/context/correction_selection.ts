import type { RetrievalResult } from "../../types"

/**
 * PT-04 / PT-05 — the ONE gap-first (补检优先) correction selection rule shared
 * by the simple and the complex knowledge runners.
 *
 * The defect this module removes: after the Critic rejected a draft, the
 * correction retrieval appended its new results to the TAIL of the same result
 * array that already held the older shortlist. `ContextAssemblerImpl` walks its
 * groups in insertion order with a shrinking budget, so the old top-10 parent
 * chunks consumed the whole 6,000-token context and the fresh gap fact never
 * reached the second generation prompt — while the trajectory still reported it
 * as a `finalContextCandidates` hit.
 *
 * The rule (deterministic, replayable, no model call, no budget change):
 *   1. The CURRENT round's gap results come first, in the order the caller
 *      collected them (replanner gap-query order, then each search's own order).
 *      Nothing is re-scored and no reranker is introduced.
 *   2. Identity dedup keys on the same `${documentId}\0${chunkId}` pair the
 *      runners have always used, and the FIRST occurrence wins — so when a gap
 *      hit and an older hit share an identity, the GAP result is the one that
 *      is selected (its parent chunk and therefore its window), and the older
 *      duplicate never consumes budget a second time.
 *   3. The remaining budget is then filled by the older material in its
 *      existing order — a gap hit never displaces older material it did not
 *      need to, and the assembler's per-parent grouping keeps a shared parent
 *      window anchored on the gap snippet because that snippet is seen first.
 *   4. `omittedGapFacts` reports the gap facts that did not reach the context
 *      that was actually built, so a run can never claim the correction was
 *      covered when it was not. Existing validation rules still decide the
 *      terminal — this records, it does not gate.
 */

/** Runner-wide chunk identity: the pair both routes deduplicate and cite on. */
export function chunkIdentity(result: RetrievalResult): string {
  return `${result.chunk.documentId}\0${result.chunk.id}`
}

export interface CorrectionCandidateSelection {
  /**
   * Every retained result, gap material first and older material after.
   * Duplicates are KEPT so `buildEvidence` still merges the channels/score of a
   * chunk that was hit by both the initial retrieval and the gap retrieval.
   */
  orderedResults: RetrievalResult[]
  /**
   * Identity-deduplicated, gap-first ordered candidate list — the assembler
   * input of this round and the observed `finalContextCandidates`.
   */
  candidates: RetrievalResult[]
  /**
   * The current round's gap material that survived dedup, in gap order. Each
   * entry is the winning candidate for its identity, so a coverage check on
   * this list is a check on what was actually selected.
   */
  gapCandidates: RetrievalResult[]
}

export interface CorrectionCandidateSelectionInput {
  /** This round's gap-retrieval results, in gap-query order. */
  gapResults: readonly RetrievalResult[]
  /** Everything selected before this round, in its existing order. */
  olderResults: readonly RetrievalResult[]
}

/**
 * Apply the shared gap-first selection rule to one correction round.
 *
 * Pure and order-preserving: the same inputs always produce the same output
 * list, so a recorded trajectory replays identically.
 */
export function selectCorrectionCandidates(
  input: CorrectionCandidateSelectionInput
): CorrectionCandidateSelection {
  const seen = new Set<string>()
  const candidates: RetrievalResult[] = []
  const gapCandidates: RetrievalResult[] = []

  for (const result of input.gapResults) {
    const identity = chunkIdentity(result)
    if (seen.has(identity)) continue
    seen.add(identity)
    candidates.push(result)
    gapCandidates.push(result)
  }
  for (const result of input.olderResults) {
    const identity = chunkIdentity(result)
    if (seen.has(identity)) continue
    seen.add(identity)
    candidates.push(result)
  }

  return {
    // Gap first, older after; duplicates preserved for Evidence channel merging.
    orderedResults: [...input.gapResults, ...input.olderResults],
    candidates,
    gapCandidates,
  }
}

/**
 * Why a selected gap fact did not reach the generation context.
 * - `context_budget`: the bounded assembler could not fit it (even first).
 * - `compression`: an LLM-compressed context dropped it, so the compressed
 *   output does not close the correction round.
 *
 * Mirrors the `GapFactOmissionTrace.reason` union in `src/types/answer.ts`;
 * kept module-private because callers pass literals.
 */
type GapFactOmissionReason = "context_budget" | "compression"

export interface GapFactOmission {
  documentId: string
  chunkId: string
  identity: string
  evidenceId?: string
  reason: GapFactOmissionReason
}

export interface GapFactCoverageInput {
  /** The gap material selected for this round, in gap order. */
  gapCandidates: readonly RetrievalResult[]
  /** Chunk-identity → stable Evidence id map of this round. */
  citationIds?: ReadonlyMap<string, string>
  /** The context string that was (or would be) handed to the model. */
  context: string
  /**
   * `verbatim` for the deterministic assembler, which never rewrites text: a
   * fact survived exactly when its snippet appears in the context (the same
   * condition the assembler uses to emit the citation). `citation` for the
   * LLM compressor, which rewrites prose but must keep the deterministic
   * `[cite:ev_...]` header of every block it retained.
   */
  mode: "verbatim" | "citation"
  reason: GapFactOmissionReason
}

/**
 * Which selected gap facts are MISSING from `context`.
 *
 * A caller that adopts a produced context without this check would report a
 * starved correction round as "gap covered".
 */
export function findUncoveredGapFacts(
  input: GapFactCoverageInput
): GapFactOmission[] {
  const uncovered: GapFactOmission[] = []
  for (const result of input.gapCandidates) {
    const identity = chunkIdentity(result)
    const evidenceId = input.citationIds?.get(identity)
    let carried: boolean
    if (input.mode === "citation") {
      carried =
        evidenceId !== undefined &&
        input.context.includes(`[cite:${evidenceId}]`)
    } else {
      const fact = result.chunk.content
      carried =
        fact.trim().length === 0
          ? evidenceId === undefined ||
            input.context.includes(`[cite:${evidenceId}]`)
          : input.context.includes(fact)
    }
    if (carried) continue
    uncovered.push({
      documentId: result.chunk.documentId,
      chunkId: result.chunk.id,
      identity,
      ...(evidenceId !== undefined ? { evidenceId } : {}),
      reason: input.reason,
    })
  }
  return uncovered
}
