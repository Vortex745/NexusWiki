import {
  buildGenerationContextSnapshot,
  type BuildGenerationContextInput,
  type GenerationContextPiece,
} from "./generation_context"
import type { ContextCompressionResult } from "./context_compressor"
import {
  modelTokenCount,
  type ContextMaterial,
} from "../retrieval/context/assembler"
import type { Evidence, GenerationContextOmission } from "../types"

/**
 * PL-05 / PT-08 — ONE description of "the context this generation call actually
 * received", shared by the simple and the complex knowledge runner so the two
 * routes cannot disagree about what the model was shown.
 *
 * The rules it encodes:
 *   - a snapshot exists per ACTUAL generation call, never per retrieval round:
 *     a 补检 that did not regenerate adds nothing (PT-08:AC04);
 *   - adopted entries come from the string that was handed over — the
 *     assembler's material contributions for a deterministic context, the
 *     compressor's recorded non-empty blocks for a compressed one — and never
 *     from `finalContextCandidates` or from the final reference list (AC02);
 *   - an identity that did not reach that string is an omission with a reason,
 *     so a compression fallback switches the records over to the deterministic
 *     context instead of leaving them on compressed ids that were not used
 *     (AC03/AC05);
 *   - only identity, position, counts and the context digest leave here — never
 *     the prompt body (`buildGenerationContextSnapshot` guarantees that).
 */
export interface DescribeActualGenerationContextInput {
  /** 1-based index of the generation call this snapshot describes. */
  generationRound: number
  /** The exact context string handed to the generator. */
  context: string
  /** The deterministic material result behind `context`, when available. */
  material?: ContextMaterial | null
  /** The compression whose blocks are inside `context`, when it was adopted. */
  compression?: ContextCompressionResult | null
  /** The round's Evidence — the identities an omission has to name. */
  evidence?: readonly Evidence[]
  countTokens?: (text: string) => number
  omissions?: readonly GenerationContextOmission[]
}

/**
 * PT-06:AC05 / PT-08:AC01 — deterministic pieces in real output order: every
 * cited identity whose text the window actually placed in the context. A
 * candidate id whose snippet the window left out contributes nothing, so it can
 * never be listed as adopted just because a candidate carried it.
 */
export function generationPiecesFromMaterial(
  material: ContextMaterial
): GenerationContextPiece[] {
  return material.contributions.map((contribution) => ({
    evidenceId: contribution.evidenceId,
    documentId: contribution.documentId,
    chunkId: contribution.chunkId,
    text: contribution.text,
    fullMaterialText: contribution.fullMaterialText,
    representation: "deterministic_full" as const,
    tokens: contribution.tokens,
  }))
}

/**
 * PT-06:AC06 / PT-08:AC03 — compressed pieces, one per NON-EMPTY output block,
 * each naming the block index that records which source it came from.
 *
 * A compressor without block records (a preview-only implementation, an
 * injected fake) is still described from the real context: the citation marker
 * the retained identity actually left in it. Presence in that string is the
 * only adoption test, so nothing is reconstructed from the candidate list.
 */
export function generationPiecesFromCompression(
  compression: ContextCompressionResult,
  evidence: readonly Evidence[],
  countTokens: (text: string) => number
): GenerationContextPiece[] {
  const identityById = new Map(evidence.map((item) => [item.id, item]))
  if (compression.blocks && compression.blocks.length > 0) {
    return compression.blocks.map((block) => {
      const item = identityById.get(block.evidenceId)
      return {
        evidenceId: block.evidenceId,
        documentId: block.documentId || item?.documentId || "",
        chunkId: block.chunkId || item?.chunkId || "",
        text: block.text,
        representation: "compressed" as const,
        tokens: countTokens(block.text),
        compressedBlockIndex: block.blockIndex,
      }
    })
  }
  return compression.retainedEvidenceIds.map((evidenceId, index) => {
    const item = identityById.get(evidenceId)
    return {
      evidenceId,
      documentId: item?.documentId ?? "",
      chunkId: item?.chunkId ?? "",
      text: `[cite:${evidenceId}]`,
      representation: "compressed" as const,
      tokens: countTokens(`[cite:${evidenceId}]`),
      compressedBlockIndex: index,
    }
  })
}

/**
 * The identities of this round that did NOT reach the adopted context.
 *
 * Deterministic path: the assembler's own omissions, with `budget_exhausted`
 * kept distinct from a snippet the per-parent window could not carry.
 * Compressed path: the ids the compressor dropped, plus any identity whose
 * block is simply absent from the context.
 */
function omissionsForContext(
  input: DescribeActualGenerationContextInput,
  pieces: readonly GenerationContextPiece[]
): GenerationContextOmission[] {
  const adopted = new Set(pieces.map((piece) => piece.evidenceId))
  const omissions: GenerationContextOmission[] = [...(input.omissions ?? [])]
  const push = (omission: GenerationContextOmission): void => {
    if (
      omissions.some(
        (existing) =>
          existing.evidenceId === omission.evidenceId &&
          existing.reason === omission.reason
      )
    ) {
      return
    }
    omissions.push(omission)
  }
  const identityById = new Map(
    (input.evidence ?? []).map((item) => [item.id, item])
  )

  if (input.compression) {
    for (const evidenceId of input.compression.droppedEvidenceIds) {
      if (adopted.has(evidenceId)) continue
      const item = identityById.get(evidenceId)
      push({
        evidenceId,
        documentId: item?.documentId ?? "",
        chunkId: item?.chunkId ?? "",
        reason: "dropped_by_compression",
      })
    }
    for (const item of input.evidence ?? []) {
      if (adopted.has(item.id)) continue
      push({
        evidenceId: item.id,
        documentId: item.documentId,
        chunkId: item.chunkId,
        reason: "dropped_by_compression",
      })
    }
    return omissions
  }

  for (const omission of input.material?.omissions ?? []) {
    if (!omission.evidenceId) continue
    push({
      evidenceId: omission.evidenceId,
      documentId: omission.documentId,
      chunkId: omission.chunkId ?? "",
      reason: omission.reason === "budget_exhausted" ? "budget_exhausted" : "does_not_fit",
    })
  }
  for (const item of input.evidence ?? []) {
    if (adopted.has(item.id)) continue
    if (omissions.some((existing) => existing.evidenceId === item.id)) continue
    push({
      evidenceId: item.id,
      documentId: item.documentId,
      chunkId: item.chunkId,
      reason: "does_not_fit",
    })
  }
  return omissions
}

/**
 * Build the `generation-context-v1` snapshot of ONE real generation call.
 *
 * `compression` is only honoured when `context` really IS the compressed string;
 * a compression that was produced but not adopted (a lossy output, a refusal)
 * leaves the description on the deterministic material, which is exactly what
 * the generator was handed.
 */
export function describeActualGenerationContext(
  input: DescribeActualGenerationContextInput
) {
  const countTokens = input.countTokens ?? modelTokenCount
  const compression =
    input.compression && input.context === input.compression.context
      ? input.compression
      : null
  const pieces = compression
    ? generationPiecesFromCompression(compression, input.evidence ?? [], countTokens)
    : input.material
      ? generationPiecesFromMaterial(input.material)
      : []
  const build: BuildGenerationContextInput = {
    generationRound: input.generationRound,
    context: input.context,
    countTokens,
    pieces,
    omissions: omissionsForContext({ ...input, compression }, pieces),
  }
  return buildGenerationContextSnapshot(build)
}
