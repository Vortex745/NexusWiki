import type { NormalizedBlock } from "../../types"

export type ChunkingStrategy = "auto" | "heading" | "heuristic" | "recursive"
export type ChunkingTier = Exclude<ChunkingStrategy, "auto">

const SECTION = /^(?:\d+(?:\.\d+)*[.)、]?\s+\S|[一二三四五六七八九十]+[、.]\s*\S|第[\d一二三四五六七八九十百]+[章节篇部]|(?:chapter|section|part)\s+\d+)/i

export function prepareChunkingBlocks(blocks: NormalizedBlock[],
  strategy: ChunkingStrategy): { blocks: NormalizedBlock[]; tier: ChunkingTier } {
  const hasHeadings = blocks.some((block) => block.sectionPath.length > 0)
  if ((strategy === "auto" || strategy === "heading") && hasHeadings) {
    return { blocks, tier: "heading" }
  }
  if (strategy === "recursive" || strategy === "heading") return { blocks, tier: "recursive" }
  let section: string[] = []
  let found = false
  const prepared = blocks.flatMap((block) => {
    if (block.type !== "paragraph") return [{ ...block, sectionPath: section }]
    const lines = block.text.replace(/\r\n?/g, "\n").split("\n")
    const parts: Array<{ text: string[]; path: string[] }> = []
    for (const line of lines) {
      if (line.trim().length <= 200 && SECTION.test(line.trim())) {
        section = [line.trim()]
        found = true
        parts.push({ text: [], path: section })
      }
      if (!parts.length) parts.push({ text: [], path: section })
      parts.at(-1)!.text.push(line)
    }
    return parts.map((part, index) => ({ ...block,
      id: parts.length === 1 ? block.id : `${block.id}:section:${index}`,
      text: part.text.join("\n"), sectionPath: part.path,
      provenance: { ...block.provenance, originalBlockId: block.id },
    }))
  })
  return found ? { blocks: prepared, tier: "heuristic" } : { blocks, tier: "recursive" }
}
