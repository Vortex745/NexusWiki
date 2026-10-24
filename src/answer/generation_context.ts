import { createHash } from "node:crypto"
import {
  GENERATION_CONTEXT_SNAPSHOT_VERSION,
  type GenerationContextOmission,
  type GenerationContextRepresentation,
  type GenerationContextSnapshot,
} from "../types/answer"

/**
 * PL-05 / PT-08 — the one place that turns "what the generator was actually
 * handed" into a `generation-context-v1` snapshot.
 *
 * The snapshot is derived from the context STRING that was passed to the
 * generation adapter, so it cannot disagree with the real prompt: entries are
 * located inside that string, counted in it, and a source that was cut away
 * never appears. Nothing here reconstructs a context from candidates or from
 * the final reference list.
 */
export interface GenerationContextPiece {
  evidenceId: string
  documentId: string
  chunkId: string
  /** The exact text this source contributed to the context string. */
  text: string
  /** The full authorized material for that source, when it exists. */
  fullMaterialText?: string
  representation: GenerationContextRepresentation
  tokens: number
  /** Compressed entries must name the non-empty output block they produced. */
  compressedBlockIndex?: number
}

export interface BuildGenerationContextInput {
  generationRound: number
  context: string
  countTokens: (text: string) => number
  pieces: readonly GenerationContextPiece[]
  omissions?: readonly GenerationContextOmission[]
}

/**
 * Locates each contributed piece inside the actual context, in output order.
 * A piece that is not present in the string (cut by the budget, or dropped by a
 * failed compression) is recorded as an omission instead of an adopted entry —
 * presence in a candidate list is never treated as adoption.
 */
export function buildGenerationContextSnapshot(
  input: BuildGenerationContextInput
): GenerationContextSnapshot {
  const entries: GenerationContextSnapshot["entries"] = []
  const omissions: GenerationContextOmission[] = [...(input.omissions ?? [])]
  let cursor = 0
  let outputOrder = 0
  for (const piece of input.pieces) {
    if (piece.representation === "compressed" && piece.compressedBlockIndex === undefined) {
      // An identity with no non-empty output block did not reach the generator.
      omissions.push({
        evidenceId: piece.evidenceId,
        documentId: piece.documentId,
        chunkId: piece.chunkId,
        reason: "dropped_by_compression",
      })
      continue
    }
    const start = piece.text.length > 0 ? input.context.indexOf(piece.text, cursor) : -1
    if (start < 0) {
      omissions.push({
        evidenceId: piece.evidenceId,
        documentId: piece.documentId,
        chunkId: piece.chunkId,
        reason: "does_not_fit",
      })
      continue
    }
    const end = start + piece.text.length
    cursor = end
    outputOrder += 1
    entries.push({
      evidenceId: piece.evidenceId,
      documentId: piece.documentId,
      chunkId: piece.chunkId,
      outputOrder,
      representation: piece.representation,
      span:
        piece.representation === "compressed"
          ? undefined
          : {
              start,
              end,
              coverage:
                piece.fullMaterialText !== undefined &&
                piece.fullMaterialText === piece.text
                  ? "full"
                  : "partial",
            },
      ...(piece.representation === "compressed"
        ? { compressedBlockIndex: piece.compressedBlockIndex }
        : {}),
      tokens: piece.tokens,
    })
  }
  return {
    version: GENERATION_CONTEXT_SNAPSHOT_VERSION,
    generationRound: input.generationRound,
    representation: classifyRepresentation(entries),
    tokenCount: input.countTokens(input.context),
    contextLength: input.context.length,
    entries,
    omissions,
    digest: createHash("sha256").update(input.context, "utf8").digest("hex").slice(0, 16),
  }
}

function classifyRepresentation(
  entries: GenerationContextSnapshot["entries"]
): GenerationContextRepresentation {
  if (entries.length === 0) return "deterministic_full"
  if (entries.some((entry) => entry.representation === "compressed")) return "compressed"
  return entries.some((entry) => entry.span?.coverage === "partial")
    ? "deterministic_partial"
    : "deterministic_full"
}

/**
 * Why a run has nothing to report. Kept next to the snapshot so a consumer can
 * tell "no facts reached the generator" apart from "this record predates the
 * snapshot" — the two must never render as the same number.
 */
export function generationContextUnavailable(
  reason: "no_generation_call" | "legacy_event"
): { generationContextUnavailable: "no_generation_call" | "legacy_event" } {
  return { generationContextUnavailable: reason }
}
