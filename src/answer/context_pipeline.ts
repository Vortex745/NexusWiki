import type {
  ContextCompressionDecision,
  ContextTraceData,
  Evidence,
  RetrievalResult,
} from "../types"
import { modelTokenCount, type ContextMaterial } from "../retrieval/context/assembler"
import {
  computeContextBudget,
  computeMaterialBudget,
} from "../retrieval/context/budget"
import { resolveContextMaterial } from "../retrieval/context/material"
import type { ContextAssembler } from "../retrieval/context/interface"
import type {
  ContextCompressor,
  ContextCompressionResult,
} from "./context_compressor"

/**
 * PT-06 / PT-07 — the ONE context-preparation sequence both knowledge routes
 * run: assemble the complete authorized MATERIAL, decide compression from its
 * real counts against the unchanged budget, attempt it only when the material
 * actually needs it, and fall back to the in-budget deterministic context on
 * every refusal — with the source records switched over to the context that is
 * really going to the generator.
 *
 * There is deliberately no second implementation of this for the complex route:
 * the complex runner calls the same function, so a material-selection rule can
 * only ever exist here.
 */
export const DEFAULT_MAX_CONTEXT_TOKENS = 6_000

export interface PrepareContextInput {
  assembler: ContextAssembler
  /** This round's ordered candidates — gap-first for a correction round. */
  results: RetrievalResult[]
  citationIds?: ReadonlyMap<string, string>
  evidence: Evidence[]
  query: string
  compressor?: ContextCompressor
  /** Never raised above the configured budget here; defaults to 6000. */
  maxContextTokens?: number
  signal?: AbortSignal
  /**
   * PT-04 / PT-05 AC07 — a caller-side adoption rule. A compressed context that
   * lost a selected gap fact must not close the round; the runner passes the
   * check and this function keeps the deterministic context instead, while the
   * rejected output stays visible on the trace.
   */
  shouldAdoptCompression?: (compression: ContextCompressionResult) => boolean
}

export interface PreparedContext {
  /** The context string the generator MUST be handed. */
  context: string
  /**
   * The in-budget DETERMINISTIC context — the fallback every refusal returns to
   * (PT-06:AC07). Exposed so a caller can check its own adoption rule (gap-fact
   * coverage) against the text that actually generates when compression is not
   * adopted, without assembling a second time.
   */
  deterministicContext: string
  /** COUNT 1/2/3 source of truth, or null for a legacy string-only assembler. */
  material: ContextMaterial | null
  /** The compressed context that was adopted, when there is one. */
  compression: ContextCompressionResult | null
  /** A compression that ran but was NOT adopted — trace evidence only. */
  rejectedCompression: ContextCompressionResult | null
  /** True when `shouldAdoptCompression` refused an otherwise valid output. */
  gapLossRejected: boolean
  decision: ContextCompressionDecision
}

/**
 * The trace fields describing what compression did (adopted or refused). One
 * owner, so the simple and the complex runner cannot report the same event with
 * different shapes.
 */
export function compressionTraceFields(
  prepared: PreparedContext
): Pick<
  ContextTraceData,
  | "compressionRan"
  | "compressionInputTokens"
  | "compressionOutputTokens"
  | "compressionRetainedEvidenceIds"
  | "compressionDroppedEvidenceIds"
  | "compressionUsage"
  | "compressionDecision"
  | "contextTokenCount"
  | "compressionRejectedForGapLoss"
> {
  const shown = prepared.compression ?? prepared.rejectedCompression
  return {
    compressionRan: prepared.compression !== null,
    contextTokenCount: prepared.decision.finalTokens,
    compressionDecision: prepared.decision,
    ...(shown
      ? {
          compressionInputTokens: shown.inputTokens,
          compressionOutputTokens: shown.outputTokens,
          compressionRetainedEvidenceIds: shown.retainedEvidenceIds,
          compressionDroppedEvidenceIds: shown.droppedEvidenceIds,
          ...(shown.usage ? { compressionUsage: shown.usage } : {}),
        }
      : {}),
    ...(prepared.gapLossRejected
      ? { compressionRejectedForGapLoss: true }
      : {}),
  }
}

export async function prepareGenerationContext(
  input: PrepareContextInput
): Promise<PreparedContext> {
  const maxContextTokens = input.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS
  const resolved = await resolveContextMaterial(
    input.assembler,
    input.results,
    input.citationIds
  )
  const { material } = resolved
  let context = resolved.context
  /**
   * PT-06:AC07 - the deterministic in-budget text every refusal falls back to.
   * It only diverges from context on the single branch that adopts a compressed
   * output, so an adoption rule can always be checked against real fallback text.
   */
  const deterministicContext = context
  const compressor = input.compressor

  const decisionOf = (
    outcome: ContextCompressionDecision["outcome"],
    modelCallMade: boolean,
    overBudget?: boolean
  ): ContextCompressionDecision => ({
    ...(material
      ? {
          rawTokens: material.rawTokens,
          candidateTokens: material.candidateTokens,
          omittedCount: material.omissions.length,
        }
      : {}),
    finalTokens: material ? material.tokenCount : modelTokenCount(context),
    maxContextTokens,
    ...(overBudget !== undefined ? { overBudget } : {}),
    outcome,
    modelCallMade,
  })

  // ---------------------------------------------------------------------------
  // Legacy assembler (PT-06:AC09): it cannot report material, so the run keeps
  // the pre-ticket behavior — the compressor's own internal bypass decides —
  // and the trace says `preview_only` instead of pretending the preview sum was
  // the material.
  // ---------------------------------------------------------------------------
  if (!material) {
    if (!compressor) {
      return {
        context,
        deterministicContext,
        material: null,
        compression: null,
        rejectedCompression: null,
        gapLossRejected: false,
        decision: decisionOf("not_configured", false),
      }
    }
    const legacy = await runLegacyCompression(input)
    if (legacy.threw) {
      return {
        context,
        deterministicContext,
        material: null,
        compression: null,
        rejectedCompression: null,
        gapLossRejected: false,
        decision: decisionOf("provider_error", true),
      }
    }
    const result = legacy.result
    if (!result) {
      return {
        context,
        deterministicContext,
        material: null,
        compression: null,
        rejectedCompression: null,
        gapLossRejected: false,
        decision: decisionOf("preview_only", true),
      }
    }
    if (
      input.shouldAdoptCompression &&
      !input.shouldAdoptCompression(result)
    ) {
      return {
        context,
        deterministicContext,
        material: null,
        compression: null,
        rejectedCompression: result,
        gapLossRejected: true,
        decision: decisionOf("rejected_for_gap_loss", true),
      }
    }
    return {
      context: result.context,
      deterministicContext,
      material: null,
      compression: result,
      rejectedCompression: null,
      gapLossRejected: false,
      decision: decisionOf("compressed", true, true),
    }
  }

  // ---------------------------------------------------------------------------
  // PT-06:AC02/AC03 — the decision is made on the candidate windows plus every
  // fixed text, against the SAME budget. Under budget costs no model call.
  // ---------------------------------------------------------------------------
  const budget = computeMaterialBudget(material, { maxContextTokens })
  if (!budget.overBudget) {
    return {
      context,
      deterministicContext,
      material,
      compression: null,
      rejectedCompression: null,
      gapLossRejected: false,
      decision: decisionOf(
        compressor ? "within_budget" : "not_configured",
        false,
        false
      ),
    }
  }
  if (!compressor) {
    // Over budget with no compressor wired: the deterministic in-budget context
    // is what generates, and the reason is recorded rather than implied.
    return {
      context,
      deterministicContext,
      material,
      compression: null,
      rejectedCompression: null,
      gapLossRejected: false,
      decision: decisionOf("not_configured", false, true),
    }
  }

  if (typeof compressor.compressMaterial === "function") {
    let outcome
    try {
      outcome = await compressor.compressMaterial({
        evidence: input.evidence,
        query: input.query,
        material,
        maxContextTokens,
        signal: input.signal,
      })
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err
      return {
        context,
        deterministicContext,
        material,
        compression: null,
        rejectedCompression: null,
        gapLossRejected: false,
        decision: decisionOf("provider_error", true, true),
      }
    }
    const result = outcome.result
    if (!result) {
      return {
        context,
        deterministicContext,
        material,
        compression: null,
        rejectedCompression: null,
        gapLossRejected: false,
        decision: decisionOf(outcome.refusal ?? "refused", true, true),
      }
    }
    if (
      input.shouldAdoptCompression &&
      !input.shouldAdoptCompression(result)
    ) {
      return {
        context,
        deterministicContext,
        material,
        compression: null,
        rejectedCompression: result,
        gapLossRejected: true,
        decision: decisionOf("rejected_for_gap_loss", true, true),
      }
    }
    return {
      context: result.context,
      deterministicContext,
      material,
      compression: result,
      rejectedCompression: null,
      gapLossRejected: false,
      decision: decisionOf("compressed", true, true),
    }
  }

  // A compressor without the material entry point: still decided from the REAL
  // material (so oversized material is no longer invisible), executed through
  // its legacy signature, and its preview-based bypass is not trusted as proof
  // that the material fit.
  const legacy = await runLegacyCompression(input)
  if (legacy.threw) {
    return {
      context,
      deterministicContext,
      material,
      compression: null,
      rejectedCompression: null,
      gapLossRejected: false,
      decision: decisionOf("provider_error", true, true),
    }
  }
  const result = legacy.result
  if (!result) {
    return {
      context,
      deterministicContext,
      material,
      compression: null,
      rejectedCompression: null,
      gapLossRejected: false,
      decision: decisionOf("refused", true, true),
    }
  }
  if (input.shouldAdoptCompression && !input.shouldAdoptCompression(result)) {
    return {
      context,
      deterministicContext,
      material,
      compression: null,
      rejectedCompression: result,
      gapLossRejected: true,
      decision: decisionOf("rejected_for_gap_loss", true, true),
    }
  }
  context = result.context
  return {
    context: result.context,
    deterministicContext,
    material,
    compression: result,
    rejectedCompression: null,
    gapLossRejected: false,
    decision: decisionOf("compressed", true, true),
  }
}

async function runLegacyCompression(
  input: PrepareContextInput
): Promise<{ result: ContextCompressionResult | null; threw: boolean }> {
  const compressor = input.compressor!
  try {
    const result = await compressor.compress(
      input.evidence,
      input.query,
      { maxContextTokens: input.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS },
      input.signal
    )
    return { result, threw: false }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err
    // PT-06:AC07 — a provider failure is a fallback, not a crash: the
    // deterministic in-budget context is what the round generates from.
    return { result: null, threw: true }
  }
}

/**
 * PT-06:AC02 — the legacy preview sum, kept available for callers that have no
 * material (the complex loop's observation adapter). Exposed so a regression can
 * show the preview count and the real material count are different numbers.
 */
export function previewContextBudget(
  evidence: Evidence[],
  maxContextTokens: number = DEFAULT_MAX_CONTEXT_TOKENS
) {
  return computeContextBudget(evidence, { maxContextTokens })
}
