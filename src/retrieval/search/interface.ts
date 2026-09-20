import type { Query, RetrievalResult } from "../../types"
import type { AccessContext } from "../../access/context"

export type RetrievalChannel = RetrievalResult["source"]

export interface SearchOptions {
  hypothesis?: string
  graphSeeds?: string[]
  /**
   * Ticket 07 P1: Request Access Context. Each retrieval channel uses this
   * to constrain its query by Tenant and access groups (spec §6).
   * Undefined in single-tenant callers and legacy paths — channels treat
   * undefined as "no ACL filter" and rely on the active-version filter only.
   */
  accessContext?: AccessContext
  /**
   * Ticket 06: Select an allowed subset of retrieval channels to execute.
   * Undefined/omitted → execute all four channels (backward compat with
   * pre-Ticket 06 callers). Non-empty array of known channels → execute
   * only those channels. Empty array or unknown channel names are rejected
   * by `validateChannelSelection` (spec §7: "rejects an empty or unknown
   * selection"). The LLM agent uses this field to choose read-only tools
   * (e.g. skip PageIndex for a non-page-oriented query).
   */
  channels?: RetrievalChannel[]
  /**
   * P7.2: Optional AbortSignal honored at retrieval stage boundaries
   * (before channel dispatch, after Promise.allSettled, after rerank).
   * When the signal is already aborted at entry, `search` rejects with
   * an AbortError immediately — no ES/Neo4j queries are issued.
   *
   * Note: the per-channel ES/Neo4j fetches themselves do NOT receive the
   * signal (that would require widening the `SearchOperations` interface).
   * The signal is checked at stage boundaries so a cancellation that
   * arrives mid-fetch is honored as soon as `allSettled` settles, before
   * rerank/parent-load. This is the declared P7.2 scope ("each stage
   * honors cancellation" at the stage boundary); deeper client-level
   * abort is deferred to a future item.
   */
  signal?: AbortSignal
}

export interface GraphBudget {
  seeds: string[]
  hops: number
  candidates: number
}

/**
 * Eval refactor Ticket 03: how the published (post-fusion) evidence ordering
 * was produced. This is the honest score source of the ranking — evaluation
 * (tickets 06/13) must not present a fused fallback as a dedicated-rerank
 * result.
 */
export interface RetrievalOrdering {
  /** "dedicated_rerank" → the configured web reranker scored this ordering;
   *  "fused" → the RRF-fused order was published unchanged. */
  source: "dedicated_rerank" | "fused"
  /** Why the fused order was published. Absent for dedicated_rerank. */
  reason?: "not_configured" | "below_threshold" | "unavailable"
}

/**
 * Dedicated rerank boundary: transport + protocol live in the adapter, the
 * searcher only sees "reorder or throw". Implementations MUST rethrow
 * cancellation (AbortError) instead of swallowing it, and MUST reject on
 * malformed responses (illegal index, non-finite score) rather than
 * degrading silently.
 */
export interface Reranker {
  /** Provider model identity (no credentials). */
  readonly model: string
  rerank(
    query: string,
    results: RetrievalResult[],
    signal?: AbortSignal
  ): Promise<RetrievalResult[]>
}

/**
 * Thrown when a rerank seam has no dedicated reranker configured. Kept
 * distinct from a provider failure so the published ordering can say
 * "not_configured" instead of "unavailable".
 */
export class RerankerNotConfiguredError extends Error {
  constructor(
    message = "dedicated reranker is not configured (set RERANK_API_KEY and RERANK_BASE_URL)"
  ) {
    super(message)
    this.name = "RerankerNotConfiguredError"
  }
}

export interface SearchOutcome {
  status: "ok" | "degraded" | "insufficient"
  results: RetrievalResult[]
  unavailableChannels: RetrievalChannel[]
  /**
   * Ticket 06: Channels that were not requested by the caller (omitted from
   * `SearchOptions.channels`). Distinguishable from `unavailableChannels`
   * (channels that were requested but failed during execution). Populated
   * only when the caller selected a subset; omitted/empty when all channels
   * were executed (spec §7: "Unselected channels are distinguishable from
   * unavailable channels in safe retrieval trace metadata").
   */
  unselectedChannels?: RetrievalChannel[]
  degradationReasons?: string[]
  graphBudget?: GraphBudget
  /**
   * Ticket 03: score source of `results`. Always present on a real result
   * set; omitted on the `insufficient` early return (no results to rank).
   */
  ordering?: RetrievalOrdering
}

export interface Searcher {
  search(query: Query, options?: SearchOptions): Promise<SearchOutcome>
}

/**
 * Ticket 06: All four retrieval channels supported by the Searcher contract.
 * Used as the default execution set when `SearchOptions.channels` is omitted,
 * and as the known-set for `validateChannelSelection` unknown-channel detection.
 */
export const ALL_RETRIEVAL_CHANNELS: readonly RetrievalChannel[] = [
  "vector",
  "bm25",
  "graph",
  "pageIndex",
]

/**
 * Ticket 06: Validate and resolve the caller's channel selection.
 *
 * Returns the channels to execute:
 * - `undefined` → all four channels (backward compat with pre-Ticket 06
 *   callers that omit the `channels` field entirely).
 * - Non-empty array of known channels → deduped, caller order preserved.
 *
 * Throws on invalid input (spec §7: "rejects an empty or unknown selection"):
 * - `[]` (empty array) → "at least one retrieval channel must be selected"
 * - Unknown channel name → "unknown retrieval channel: <name>"
 *
 * The returned array is always a fresh mutable copy — callers can mutate it
 * without affecting the `ALL_RETRIEVAL_CHANNELS` const.
 */
export function validateChannelSelection(
  channels?: RetrievalChannel[]
): RetrievalChannel[] {
  if (channels === undefined) {
    return [...ALL_RETRIEVAL_CHANNELS]
  }
  if (channels.length === 0) {
    throw new Error("at least one retrieval channel must be selected")
  }
  const known = new Set<RetrievalChannel>(ALL_RETRIEVAL_CHANNELS)
  for (const ch of channels) {
    if (!known.has(ch)) {
      throw new Error(`unknown retrieval channel: ${ch}`)
    }
  }
  // Dedupe, preserve caller order
  return [...new Set(channels)]
}
