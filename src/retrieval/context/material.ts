import type { Chunk, RetrievalResult } from "../../types"
import type { ContextMaterial } from "./assembler"
import type { ContextAssembler } from "./interface"

/**
 * PT-06:AC09 — the ONE compatibility bridge between the material contract and
 * the legacy string contract.
 *
 * Both knowledge runners call it instead of `assembler.assemble()`. When the
 * wired assembler implements `assembleMaterial` they get the real material
 * (raw parent blocks, per-parent candidate windows, the exact final context,
 * contributions and omissions). When it is a legacy string-only assembler — the
 * complex loop adapter, a test fake, an older caller — they get the same string
 * they always got and `material: null`, and must not pretend to know counts the
 * assembler never reported.
 */
export interface ResolvedContextMaterial {
  material: ContextMaterial | null
  /** The context string that will be handed to the generator. */
  context: string
}

export async function resolveContextMaterial(
  assembler: ContextAssembler,
  results: RetrievalResult[],
  citationIds?: ReadonlyMap<string, string>,
  options?: { authorizeParent?: (child: Chunk, parent: Chunk) => boolean }
): Promise<ResolvedContextMaterial> {
  if (typeof assembler.assembleMaterial === "function") {
    const material = await assembler.assembleMaterial(
      results,
      citationIds,
      options ?? {}
    )
    return { material, context: material.context }
  }
  return { material: null, context: await assembler.assemble(results, citationIds) }
}
