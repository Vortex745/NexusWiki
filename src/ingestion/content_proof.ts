// UT-15: content integrity proof — the joint verdict over extraction
// evidence, structural risks and chunk coverage.
//
// 契约（UP-08 AC 1/2/4/5，经 15 票继承）：提取、清洗和切块证据汇成一个
// 内容结论；结论绑定同一原件（raw extraction 哈希）、产物（期望检索清单
// 哈希）与解析配置；只有已验证支持范围且证据完整才是 pass——页数、无警告、
// 非空输出都不单独构成证明；pass 只意味着"进入索引核验"（UT-16），绝不
// 直接激活。
import { createHash } from "node:crypto"
import { evaluateFullDocumentCoverage } from "./chunk_coverage"
import type { ExtractionEvidenceRecord } from "./tracking/extraction_evidence_repo"
import type { Chunk, NormalizedBlock } from "../types"

export interface ContentProof {
  schemaVersion: 1
  /** pass = 内容证据完整（仍需索引核验）；pending_review = 有明确待校验原因。 */
  verdict: "pass" | "pending_review"
  /** 稳定理由码（下游覆盖缺口、上游提取缺口、结构风险、解码待校验）。 */
  reasonCodes: string[]
  /** 绑定：同一原件、产物与解析配置——换输入或配置即另一份凭证。 */
  bindings: {
    rawExtractionSha256: string | null
    parserConfigVersion: string | null
    expectedChunkCount: number
    expectedChunksSha256: string
  }
  evaluatedAt: string
}

export interface ManifestEntryLike {
  chunkId: string
  contentSha256: string
}

/**
 * 期望清单的绑定摘要：排序后逐条 (chunkId, contentSha256) 的联合哈希。
 * 内容凭证与索引核验凭证各自携带它——两者相等才证明绑定同一份产物
 * （UT-17 联合核验的"匹配"判据）。
 */
export function manifestDigest(entries: ManifestEntryLike[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...entries]
          .map((entry) => [entry.chunkId, entry.contentSha256])
          .sort((left, right) => (left[0] < right[0] ? -1 : 1))
      )
    )
    .digest("hex")
}

export interface ProduceContentProofInput {
  extractionEvidence: ExtractionEvidenceRecord | null
  /** 解码/结构层的待校验理由码（UT-10 decode + UT-12 risks）。 */
  reviewReasons: string[]
  blocks: NormalizedBlock[]
  indexChunks: Chunk[]
  manifestEntries: ManifestEntryLike[]
  parserConfigVersion: string | null
}

/**
 * 把证据汇成内容结论。复用 UT-13 的覆盖判定与上游缺口规则：
 * - 清洗文本覆盖有缺口 → pending_review（chunk_coverage_gaps）；
 * - 上游已知缺口（未提取页/提取警告/结构风险/解码待校验）→ pending_review
 *   （下游覆盖不能补证上游真值）；
 * - 两者皆无 → pass——但仍只进入索引核验，不激活。
 */
export function produceContentProof(input: ProduceContentProofInput): ContentProof {
  const coverage = evaluateFullDocumentCoverage({
    extractionEvidence: input.extractionEvidence,
    risks:
      input.reviewReasons.length > 0
        ? { reviewRequired: true, reviewReasons: input.reviewReasons }
        : null,
    blocks: input.blocks,
    indexChunks: input.indexChunks,
  })

  // 期望清单的绑定哈希：任何一条产物内容变化都会改变凭证。
  const manifestSha256 = manifestDigest(input.manifestEntries)

  return {
    schemaVersion: 1,
    verdict: coverage.verdict === "pending_review" ? "pending_review" : "pass",
    reasonCodes: coverage.reasonCodes,
    bindings: {
      rawExtractionSha256: input.extractionEvidence?.rawExtractionSha256 ?? null,
      parserConfigVersion: input.parserConfigVersion,
      expectedChunkCount: input.manifestEntries.length,
      expectedChunksSha256: manifestSha256,
    },
    evaluatedAt: new Date().toISOString(),
  }
}
