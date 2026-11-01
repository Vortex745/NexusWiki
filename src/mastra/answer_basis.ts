import type { AnswerBasis, AnswerRunResult } from "../types"

/** A public basis may refer only to the citations in the final answer. */
export function bindAnswerBasis(
  basis: AnswerBasis | undefined,
  references: AnswerRunResult["references"]
): AnswerBasis | undefined {
  if (!basis || typeof basis.text !== "string" || !Array.isArray(basis.referenceIds)) return undefined
  const text = basis.text.trim()
  if (!text || text.length > 240 || basis.referenceIds.length === 0 || basis.referenceIds.length > 8) return undefined
  const referenceIds: string[] = []
  const finalIds = new Set(references.map(({ id }) => id))
  for (const candidate of basis.referenceIds) {
    if (typeof candidate !== "string") return undefined
    const id = candidate.trim()
    if (!id || id.length > 200 || !finalIds.has(id)) return undefined
    if (!referenceIds.includes(id)) referenceIds.push(id)
  }
  return { text, referenceIds }
}
