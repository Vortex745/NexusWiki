import { v5 as uuid } from "uuid"
import { createHash } from "node:crypto"
import type { Document, Chunk, NormalizedBlock } from "../../types"
import { normalizeMarkItDown } from "../parser/normalize"
import { prepareChunkingBlocks, type ChunkingStrategy, type ChunkingTier } from "./strategy"

const MAX_CHUNK_SIZE = 1500
const MAX_CHILD_CHUNK_SIZE = 512
const CHUNK_OVERLAP = 80
const MIN_CHUNK_SIZE = 80
const SEMANTIC_SIMILARITY_THRESHOLD = 0.15

export class RecursiveChunker {
  constructor(private readonly strategy: ChunkingStrategy = "auto") {}

  async chunk(doc: Document, blocks?: NormalizedBlock[]): Promise<Chunk[]> {
    if (!blocks && doc.content.trim()) blocks = normalizeMarkItDown(doc.content, doc.id)
    if (blocks) {
      const prepared = prepareChunkingBlocks(blocks, this.strategy)
      return this.chunkBlocks(doc, prepared.blocks, prepared.tier)
    }

    const segments = this.split(doc.content)
    const contentHash = createHash("sha256").update(doc.content).digest("hex")
    return segments.map((text, i) => ({
      id: uuid(`kefu-rag:chunk:${doc.id}:child:${contentHash}:${i}:${text}`, uuid.URL),
      documentId: doc.id,
      content: text,
      childrenIds: [],
      metadata: {
        kind: "child",
        index: i,
        title: doc.title,
        source: doc.source,
        sourceId: doc.sourceId,
        documentVersion: doc.version,
      },
    }))
  }

  private chunkBlocks(doc: Document, blocks: NormalizedBlock[], tier: ChunkingTier): Chunk[] {
    const sourceContent = blocks.map(({ text }) => text).join("\n\n")
    const sourceHash = createHash("sha256").update(sourceContent).digest("hex")
    const groups: NormalizedBlock[][] = []

    for (const block of blocks) {
      const current = groups.at(-1)
      if (!current || this.sectionKey(current[0]) !== this.sectionKey(block)) {
        groups.push([block])
      } else {
        current.push(block)
      }
    }

    const chunks: Chunk[] = []
    const emittedStructure = new Set<string>()
    let childIndex = 0

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex]
      const sectionPath = group[0].sectionPath
      const parentContent = group.map(({ text }) => text).join("\n\n")
      const parentId = uuid(
        `kefu-rag:chunk:${doc.id}:parent:${groupIndex}:${sourceHash}:${this.sectionKey(group[0])}:${parentContent}`,
        uuid.URL
      )
      const textRuns: NormalizedBlock[][] = []
      let textRun: NormalizedBlock[] = []
      for (const block of group) {
        if (block.type === "image") {
          if (textRun.length > 0) textRuns.push(textRun)
          textRun = []
        } else {
          textRun.push(block)
        }
      }
      if (textRun.length > 0) textRuns.push(textRun)
      const children = textRuns.flatMap((run) =>
        this.mergeSmallSegments(this.splitBlocks(run))
      )
        .map(({ text, blocks: segmentBlocks }) => {
        const index = childIndex
        childIndex += 1
        return {
          id: uuid(`kefu-rag:chunk:${doc.id}:child:${sourceHash}:${index}:${text}`, uuid.URL),
          documentId: doc.id,
          content: text,
          parentId,
          childrenIds: [],
          metadata: {
            kind: "child",
            index,
            title: doc.title,
            source: doc.source,
            sourceId: doc.sourceId,
            documentVersion: doc.version,
            sectionPath,
            chunkingStrategy: tier,
            contextHeader: sectionPath.join(" > "),
            normalizedBlocks: segmentBlocks.map((block) => {
              const continuation = emittedStructure.has(block.id)
              emittedStructure.add(block.id)
              return {
                id: block.id,
                index: block.index,
                type: block.type,
                headingLevel: block.headingLevel,
                page: block.page,
                sectionPath: block.sectionPath,
                boundingBox: block.boundingBox,
                metadata: block.metadata,
                provenance: block.provenance,
                ...(continuation
                  ? { continuation: true }
                  : { table: block.table, image: block.image }),
              }
            }),
          },
        } satisfies Chunk
      })

      const imageChildren = group.flatMap((block, blockIndex) => {
        if (block.type !== "image") return []
        const previous = [...group.slice(0, blockIndex)]
          .reverse()
          .find(({ type }) => type !== "image")
        const next = group.slice(blockIndex + 1).find(({ type }) => type !== "image")
        const nearbyText = [previous?.text, block.text, next?.text]
          .filter((value): value is string => !!value)
          .map((value) => value.slice(0, MAX_CHILD_CHUNK_SIZE / 2))
          .join("\n\n")
        const image = block.image ?? {}
        const assetIdentity = typeof image.assetId === "string"
          ? image.assetId
          : `metadata:${block.id}`
        const id = uuid(
          `kefu-rag:chunk:${doc.id}:image:${block.index}:${assetIdentity}:${block.text}`,
          uuid.URL
        )
        return [{
          id,
          documentId: doc.id,
          content: nearbyText,
          parentId,
          childrenIds: [],
          metadata: {
            kind: "image",
            index: block.index,
            title: doc.title,
            source: doc.source,
            sourceId: doc.sourceId,
            documentVersion: doc.version,
            page: block.page,
            sectionPath: block.sectionPath,
            chunkingStrategy: tier,
            contextHeader: block.sectionPath.join(" > "),
            image,
            assetStatus: typeof image.assetId === "string"
              ? "available"
              : "metadata_only",
            normalizedBlocks: [{
              id: block.id,
              index: block.index,
              type: block.type,
              page: block.page,
              sectionPath: block.sectionPath,
              boundingBox: block.boundingBox,
              image,
              metadata: block.metadata,
              provenance: block.provenance,
            }],
          },
        } satisfies Chunk]
      })

      const orderedChildren = [...children, ...imageChildren].sort((left, right) => {
        const leftIndex = left.metadata.kind === "image"
          ? left.metadata.index as number
          : ((left.metadata.normalizedBlocks as Array<{ index: number }>)[0]?.index ?? 0)
        const rightIndex = right.metadata.kind === "image"
          ? right.metadata.index as number
          : ((right.metadata.normalizedBlocks as Array<{ index: number }>)[0]?.index ?? 0)
        return leftIndex - rightIndex
      })

      chunks.push(...orderedChildren, {
        id: parentId,
        documentId: doc.id,
        content: parentContent,
        childrenIds: orderedChildren.map(({ id }) => id),
        metadata: {
          kind: "parent",
          title: doc.title,
          source: doc.source,
          sourceId: doc.sourceId,
          documentVersion: doc.version,
          sectionPath,
          chunkingStrategy: tier,
          contextHeader: sectionPath.join(" > "),
          normalizedBlocks: [],
        },
      })
    }

    return chunks
  }

  /**
   * Merge undersized segments into their neighbours so degenerate fragments
   * (e.g. a two-character TOC label) never reach the index. Merging runs per
   * text run only — never across an image boundary. A segment that continues
   * the previous segment's block rejoins without a separator so split block
   * text reconstructs exactly; otherwise "\n\n" joins distinct blocks. Size
   * limits win: no merge may push a segment past MAX_CHUNK_SIZE.
   */
  private mergeSmallSegments(
    segments: Array<{ text: string; blocks: NormalizedBlock[] }>
  ): Array<{ text: string; blocks: NormalizedBlock[] }> {
    const mergeInto = (
      target: { text: string; blocks: NormalizedBlock[] },
      incoming: { text: string; blocks: NormalizedBlock[] }
    ): void => {
      const lastBlockId = target.blocks.at(-1)?.id
      const separator =
        lastBlockId && lastBlockId === incoming.blocks[0]?.id ? "" : "\n\n"
      target.text += separator + incoming.text
      for (const block of incoming.blocks) {
        if (!target.blocks.some(({ id }) => id === block.id)) {
          target.blocks.push(block)
        }
      }
    }

    const result: Array<{ text: string; blocks: NormalizedBlock[] }> = []
    for (const segment of segments) {
      if (segment.text.length < MIN_CHUNK_SIZE && result.length > 0) {
        const previous = result[result.length - 1]
        if (previous.text.length + segment.text.length + 2 <= MAX_CHUNK_SIZE) {
          mergeInto(previous, segment)
          continue
        }
      }
      result.push({ text: segment.text, blocks: [...segment.blocks] })
    }
    if (result.length > 1 && result.at(-1)!.text.length < MIN_CHUNK_SIZE) {
      const last = result.pop()!
      const previous = result.at(-1)!
      if (previous.text.length + last.text.length + 2 <= MAX_CHUNK_SIZE) {
        mergeInto(previous, last)
      } else {
        result.push(last)
      }
    }
    return result
  }

  private sectionKey(block: NormalizedBlock): string {
    return JSON.stringify(block.sectionPath)
  }

  private splitBlocks(blocks: NormalizedBlock[]): Array<{
    text: string
    blocks: NormalizedBlock[]
  }> {
    const result: Array<{ text: string; blocks: NormalizedBlock[] }> = []
    let text = ""
    let included: NormalizedBlock[] = []
    let lastBlockId: string | null = null
    let lastBlockText = ""

    const flush = (): void => {
      if (!text) return
      result.push({ text, blocks: included })
      text = ""
      included = []
      lastBlockId = null
      lastBlockText = ""
    }

    for (const block of blocks) {
      for (const piece of this.splitBlockText(block)) {
        let separator = text && lastBlockId !== block.id ? "\n\n" : ""
        const semanticBreak = text.length >= MIN_CHUNK_SIZE
          && lastBlockId !== block.id
          && this.embeddingSimilarity(lastBlockText, block.text)
            < SEMANTIC_SIMILARITY_THRESHOLD
        if (semanticBreak
          || text.length + separator.length + piece.length > MAX_CHILD_CHUNK_SIZE) {
          flush()
          separator = ""
        }
        text += separator + piece
        if (!included.some(({ id }) => id === block.id)) included.push(block)
        lastBlockId = block.id
        lastBlockText = block.text
      }
    }
    flush()
    return result
  }

  private splitLongText(text: string, boundaries?: string[]): string[] {
    const pieces: string[] = []
    let offset = 0
    while (offset < text.length) {
      const remaining = text.length - offset
      if (remaining <= MAX_CHILD_CHUNK_SIZE) {
        pieces.push(text.slice(offset))
        break
      }

      const targetWindow = text.slice(offset, offset + MAX_CHILD_CHUNK_SIZE)
      const length = this.safeBoundary(targetWindow, boundaries) || MAX_CHILD_CHUNK_SIZE
      pieces.push(text.slice(offset, offset + length))
      offset += Math.max(length - CHUNK_OVERLAP, 1)
    }
    return pieces
  }

  private splitBlockText(block: NormalizedBlock): string[] {
    // Tables stay atomic below the child size limit — a pipe-delimited table
    // split mid-row yields fragments that are useless for retrieval. Beyond
    // that, UT-14: an oversized table splits at ROW boundaries and every
    // continuation piece repeats the header lines, so the header-value
    // relation survives in each chunk instead of living only in the first.
    if (block.type === "table") {
      if (block.text.length <= MAX_CHUNK_SIZE) {
        return [block.text]
      }
      return this.splitTableText(block.text)
    }
    return this.splitLongText(block.text)
  }

  /**
   * UT-14: split an oversized markdown table at row boundaries, repeating the
   * header (and its separator line) on every piece. Rows are packed greedily
   * so each piece stays within the child size budget where possible; a single
   * row longer than the budget is emitted alone (the token-limit net in
   * limits.ts guards the embedding path).
   */
  private splitTableText(text: string): string[] {
    const lines = text.split("\n")
    const isSeparator = (line: string): boolean =>
      /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-")
    let headerLines: string[] = []
    if (lines.length >= 2 && isSeparator(lines[1])) {
      headerLines = [lines[0], lines[1]]
    } else if (lines[0]?.includes("|")) {
      headerLines = [lines[0]]
    }
    const bodyLines = lines.slice(headerLines.length)
    const headerPrefix = headerLines.length > 0 ? `${headerLines.join("\n")}\n` : ""
    const headerBudget = headerPrefix.length

    const pieces: string[] = []
    let current = ""
    for (const line of bodyLines) {
      const candidate = current ? `${current}\n${line}` : line
      if (current && headerBudget + candidate.length + 1 > MAX_CHILD_CHUNK_SIZE) {
        pieces.push(`${headerPrefix}${current}`)
        current = line
      } else {
        current = candidate
      }
    }
    if (current) pieces.push(`${headerPrefix}${current}`)
    return pieces
  }

  private safeBoundary(text: string, boundaries?: string[]): number {
    const candidates = boundaries ?? ["\n\n", "\n", "。", "！", "？", ". ", "! ", "? ", " ", "\t"]
    let length = 0
    for (const boundary of candidates) {
      const index = text.lastIndexOf(boundary)
      if (index >= MIN_CHUNK_SIZE) {
        length = Math.max(length, index + boundary.length)
      }
    }
    return length
  }

  private embeddingSimilarity(left: string, right: string): number {
    const leftVector = this.textEmbedding(left)
    const rightVector = this.textEmbedding(right)
    let dot = 0
    let leftMagnitude = 0
    let rightMagnitude = 0

    for (const value of leftVector.values()) leftMagnitude += value * value
    for (const [token, value] of rightVector) {
      dot += (leftVector.get(token) ?? 0) * value
      rightMagnitude += value * value
    }
    if (leftMagnitude === 0 || rightMagnitude === 0) return 0
    return dot / Math.sqrt(leftMagnitude * rightMagnitude)
  }

  private textEmbedding(text: string): Map<string, number> {
    const vector = new Map<string, number>()
    const words = text.toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    for (const word of words) {
      const tokens = word.length < 3
        ? [word]
        : Array.from({ length: word.length - 1 }, (_, index) =>
            word.slice(index, index + 2)
          )
      for (const token of tokens) {
        vector.set(token, (vector.get(token) ?? 0) + 1)
      }
    }
    return vector
  }

  private split(text: string): string[] {
    return this.splitLongText(text.trim())
  }
}
