/**
 * Eval refactor Ticket 01 — runner observation helpers.
 *
 * Maps the runner-internal ordered candidate list (the assembler input of
 * the final generation round) into the transport-agnostic
 * `RankedCandidateObservation` records carried on `RetrievalTraceData`.
 * Shared by the simple and complex knowledge runners so both routes expose
 * the SAME observation semantics for injected observers (evaluation).
 *
 * Boundary (T02 #5): this module MUST NOT import `src/api/*` or `src/index`.
 */

import type {
  RankedCandidateObservation,
  RetrievalResult,
} from "../types"

/**
 * Project the ordered candidates of one generation round into ranked
 * observation records. `evidenceByIdentity` (optional) attaches the Evidence
 * id each candidate received from `buildEvidence`, so observers can join
 * candidates with the done event's references without treating the reference
 * list AS the ranking.
 */
export function toRankedCandidateObservations(
  results: RetrievalResult[],
  evidenceByIdentity?: Map<string, string>
): RankedCandidateObservation[] {
  return results.map((result, index) => {
    const identity = `${result.chunk.documentId}\0${result.chunk.id}`
    const evidenceId = evidenceByIdentity?.get(identity)
    return {
      rank: index + 1,
      documentId: result.chunk.documentId,
      chunkId: result.chunk.id,
      score: result.score,
      channels: [...(result.channels ?? [result.source])],
      ...(evidenceId !== undefined ? { evidenceId } : {}),
    }
  })
}
