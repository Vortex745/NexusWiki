/**
 * DR-22: reasons that mean the answer was generated from a degraded retrieval.
 * A missing capability (`reranker_not_configured`, `web_unconfigured`) or a
 * caller's empty scope (`no_knowledge_scope`) is a configuration/scope fact,
 * not an answer degradation — those stay visible on their own fields and must
 * not be reported as a partial answer.
 *
 * Shared by the simple and complex runners so both routes classify the same
 * retrieval evidence the same way.
 */
export const ANSWER_DEGRADATION_FAILURES: ReadonlySet<string> = new Set([
  "parent_expansion_unavailable",
  "reranker_unavailable",
])

export function degradationWasObserved(
  unavailableChannels: ReadonlySet<string> | readonly string[],
  degradedReasons: readonly string[] | undefined
): boolean {
  const channelCount =
    "size" in unavailableChannels
      ? unavailableChannels.size
      : unavailableChannels.length
  return (
    channelCount > 0 ||
    (degradedReasons ?? []).some(
      (reason) =>
        ANSWER_DEGRADATION_FAILURES.has(reason) || reason.endsWith(" unavailable")
    )
  )
}
