// UT-13: chunk coverage and full-document truthfulness evaluation.
//
// The chunk stage builds chunks FROM normalized blocks, so by construction
// every block should appear in at least one index-bound chunk. This module
// verifies that expectation independently (unique block-id coverage — overlap
// and continuation pieces reuse the same block id and therefore cannot
// fabricate extra coverage), and rules on the FULL document: when the
// extraction layer already recorded gaps (unextracted pages, structural risk
// flags), a 100% chunk coverage of the CLEANED text must NOT upgrade the
// document to complete — downstream results can never retro-certify upstream
// truth (UP-07 AC 3).
import type { Chunk, NormalizedBlock } from "../types"
import type { ExtractionEvidenceRecord } from "./tracking/extraction_evidence_repo"

export interface BlockCoverageResult {
  totalBlocks: number
  coveredBlocks: number
  missingBlockIds: string[]
  verdict: "covered" | "gaps"
}

/**
 * prepareChunkingBlocks may split one normalized block into section parts and
 * derive their ids as `${blockId}:section:${index}`. Coverage is judged
 * against the ORIGINAL normalized block, so the suffix is stripped here.
 */
function baseBlockId(id: string): string {
  const marker = ":section:"
  const index = id.indexOf(marker)
  return index >= 0 ? id.slice(0, index) : id
}

/**
 * Unique-block-id coverage over the index-bound chunks. Parent chunks carry
 * no block payload; continuation (overlap) pieces reference the SAME block
 * id, so overlaps never inflate coverage.
 */
export function evaluateBlockCoverage(
  blocks: NormalizedBlock[],
  indexChunks: Chunk[]
): BlockCoverageResult {
  const allBlockIds = new Set(blocks.map((block) => block.id))
  const covered = new Set<string>()
  for (const chunk of indexChunks) {
    const chunkBlocks = chunk.metadata.normalizedBlocks as
      | Array<{ id?: string }>
      | undefined
    for (const block of chunkBlocks ?? []) {
      if (typeof block.id === "string") {
        const base = baseBlockId(block.id)
        if (allBlockIds.has(base)) {
          covered.add(base)
        }
      }
    }
  }
  const missingBlockIds = blocks
    .filter((block) => !covered.has(block.id))
    .map((block) => block.id)
  return {
    totalBlocks: allBlockIds.size,
    coveredBlocks: covered.size,
    missingBlockIds,
    verdict: missingBlockIds.length === 0 ? "covered" : "gaps",
  }
}

export interface FullDocumentCoverageInput {
  extractionEvidence: ExtractionEvidenceRecord | null
  /** UT-12 structural risk flags (parser provenance), when present. */
  risks?: { reviewRequired: boolean; reviewReasons: string[] } | null
  blocks: NormalizedBlock[]
  indexChunks: Chunk[]
}

export interface FullDocumentCoverageVerdict {
  /** 覆盖判定只针对清洗后的文本——它不是全文结论。 */
  chunkCoverage: BlockCoverageResult
  /** 上游（提取层）已知的缺口：下游覆盖不能补证这些内容。 */
  upstreamGaps: string[]
  /**
   * 全文结论：
   * - pending_review：上游有已知缺口（即使清洗文本覆盖率 100%）；
   * - complete_pending_index_verification：块覆盖无缺口，等待索引核验（UT-16）。
   */
  verdict: "complete_pending_index_verification" | "pending_review"
  reasonCodes: string[]
}

export function evaluateFullDocumentCoverage(
  input: FullDocumentCoverageInput
): FullDocumentCoverageVerdict {
  const chunkCoverage = evaluateBlockCoverage(input.blocks, input.indexChunks)
  const upstreamGaps: string[] = []
  const reasonCodes: string[] = []

  const unextractedPages = (input.extractionEvidence?.pages ?? [])
    .filter((page) => page.status !== "extracted")
    .map((page) => page.page)
  if (unextractedPages.length > 0) {
    upstreamGaps.push(`pages_without_text_layer_or_empty: ${unextractedPages.join(",")}`)
  }
  if (input.extractionEvidence && input.extractionEvidence.warnings.length > 0) {
    upstreamGaps.push(`extraction_warnings: ${input.extractionEvidence.warnings.length}`)
  }
  for (const reason of input.risks?.reviewReasons ?? []) {
    upstreamGaps.push(`structural_risk: ${reason}`)
  }

  if (chunkCoverage.verdict === "gaps") {
    reasonCodes.push("chunk_coverage_gaps")
  }
  reasonCodes.push(...upstreamGaps)

  return {
    chunkCoverage,
    upstreamGaps,
    verdict:
      chunkCoverage.verdict === "gaps" || upstreamGaps.length > 0
        ? "pending_review"
        : "complete_pending_index_verification",
    reasonCodes,
  }
}
