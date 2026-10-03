// UT-12：PDF 结构风险待校验与过滤审计。
//
// 契约（UP-06 AC 2/3/4/5，经 12 票继承）：表格/分栏/无文本层页等无法确认
// 完整性的结构给出稳定待校验理由码（原文始终保留，转换未经等价验证不得
// 替换原提取）；能力缺口与检测器漏判风险如实声明；排除规则审计为空
// （本路径不做任何排除）；负例（混合/扫描/加密/损坏）不得宣布完整。
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { closeDb, openDb } from "./tracking"
import { DocumentRepo } from "./tracking/doc_repo"
import { ExtractionEvidenceRepository } from "./tracking/extraction_evidence_repo"
import { IngestionLifecycle } from "./lifecycle"
import { PipelineStageRunner } from "./pipeline"
import { analyzeStructureRisks } from "./parser"
import type { IngestionStoreImpl } from "./storage"

const HERE = dirname(__filename)
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
// loadConfig() 是进程级 memoize：必须在任何 loadConfig 调用之前固定隔离库。
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "kefu-rag-ut12-")), "ingestion.db")

const TRUTH_DIR = resolve(HERE, "../../golden/upload-truth/pdf")

function makeFakeStore() {
  const storedChunks: Array<{ documentId: string; content: string }> = []
  const fakeStore = {
    async storeChunks(
      chunks: Array<{ documentId: string; content: string }>
    ): Promise<unknown> {
      storedChunks.push(...chunks.map(({ documentId, content }) => ({ documentId, content })))
      return {
        chunkCount: chunks.length, passageCount: chunks.length, batchCount: 1,
        embeddingBatchCount: 1, embeddingRequestCount: 1, embeddingRetryCount: 0,
        embeddingRateLimitCount: 0, embeddingDurationMs: 1, rateLimitWaitMs: 0,
        bulkRequestCount: 1, bulkDurationMs: 1,
      }
    },
    async storeEntities(): Promise<void> {},
    async storeWikilinks(): Promise<void> {},
    get chunkIndexName(): string { return "fake-index" },
    async close(): Promise<void> {},
  }
  return { fakeStore: fakeStore as unknown as IngestionStoreImpl, storedChunks }
}

async function ingestPdf(file: string): Promise<{
  docId: string
  document: NonNullable<ReturnType<DocumentRepo["get"]>>
}> {
  const db = openDb()
  const { fakeStore } = makeFakeStore()
  const lifecycle = new IngestionLifecycle(
    db,
    new PipelineStageRunner(db, undefined as never, fakeStore)
  )
  const submitted = lifecycle.submit({
    title: `UT-12 ${file}`,
    content: "",
    rawContent: readFileSync(join(TRUTH_DIR, file)),
    fileName: file,
    mimeType: "application/pdf",
    sourceIdentity: { kind: "file", uriOrExternalId: `C:/truth/ut12/${file}`, namespace: "ut12" },
  })
  const result = await lifecycle.runNext()
  assert.ok(result?.success, `${file} 必须完成解析`)
  const document = new DocumentRepo(db).get(submitted.docId)
  assert.ok(document)
  return { docId: submitted.docId, document }
}

function risksOf(document: NonNullable<ReturnType<DocumentRepo["get"]>>): {
  reviewRequired: boolean
  reviewReasons: string[]
  possibleColumnPages: number[]
  pagesWithoutTextBlocks: number[]
  candidateTables: number
  tablesOverlappingText: number
  capabilityGaps: string[]
  detectorLimits: string[]
  exclusionRules: string[]
} {
  const system = document.metadata.system as {
    extraction?: {
      risks?: {
        reviewRequired: boolean
        reviewReasons: string[]
        possibleColumnPages: number[]
        pagesWithoutTextBlocks: number[]
        candidateTables: number
        tablesOverlappingText: number
        capabilityGaps: string[]
        detectorLimits: string[]
        exclusionRules: string[]
      }
    }
  }
  assert.ok(system.extraction?.risks, "结构风险必须落 system.extraction.risks")
  return system.extraction.risks
}

// ---------------------------------------------------------------------------
// 单元：分栏启发式与风险聚合
// ---------------------------------------------------------------------------

const baseBlock = {
  bold: false,
  fontSize: 12,
}

test("UT-12 单元：分栏页被标记，单栏页不误标", () => {
  const twoColumns = {
    version: 1,
    pageCount: 1,
    outline: [],
    blocks: [
      { page: 1, bbox: [50, 100, 280, 130], text: "左栏一：退货时限为七天。", ...baseBlock },
      { page: 1, bbox: [50, 140, 280, 170], text: "左栏二：需保留原始包装。", ...baseBlock },
      { page: 1, bbox: [320, 100, 550, 130], text: "右栏一：发票需在三十天内开具。", ...baseBlock },
      { page: 1, bbox: [320, 140, 550, 170], text: "右栏二：金额上限 500 元。", ...baseBlock },
    ],
    tables: [],
    warnings: [],
    stats: { textChars: 100, pagesWithText: 1 },
  }
  const risks = analyzeStructureRisks(twoColumns)
  assert.deepEqual(risks.possibleColumnPages, [1])
  assert.ok(risks.reviewReasons.includes("columns_reading_order_unverified"))
  assert.equal(risks.reviewRequired, true)

  const singleColumn = {
    version: 1,
    pageCount: 1,
    outline: [],
    blocks: [
      { page: 1, bbox: [50, 100, 545, 130], text: "正文一。", ...baseBlock },
      { page: 1, bbox: [50, 140, 545, 170], text: "正文二。", ...baseBlock },
      { page: 1, bbox: [50, 180, 545, 210], text: "正文三。", ...baseBlock },
    ],
    tables: [],
    warnings: [],
    stats: { textChars: 30, pagesWithText: 1 },
  }
  const clean = analyzeStructureRisks(singleColumn)
  assert.deepEqual(clean.possibleColumnPages, [])
  assert.equal(clean.reviewRequired, false, "简单线性文本 PDF 不待校验")
})

test("UT-12 单元：无文本层页、候选表格与重叠计数聚合为稳定理由码", () => {
  const risks = analyzeStructureRisks({
    version: 1,
    pageCount: 3,
    outline: [],
    blocks: [
      { page: 1, bbox: [50, 100, 545, 130], text: "第一页正文。", ...baseBlock },
      { page: 3, bbox: [50, 100, 545, 130], text: "第三页正文。", ...baseBlock },
    ],
    tables: [{ page: 1, bbox: [60, 200, 500, 300], markdown: "| 姓名 | 金额 |\n|---|---|\n| 张三 | 50元 |" }],
    warnings: [],
    stats: { textChars: 50, pagesWithText: 2 },
  })
  assert.deepEqual(risks.pagesWithoutTextBlocks, [2])
  assert.equal(risks.candidateTables, 1)
  assert.equal(risks.tablesOverlappingText, 0, "表格区域无正文块重叠时计数为 0")
  assert.deepEqual(risks.reviewReasons, [
    "pages_without_text_layer_or_empty",
    "candidate_table_conversion_unverified",
  ])
  // 过滤审计：本路径无任何排除；能力缺口与检测器边界如实声明。
  assert.deepEqual(risks.exclusionRules, [])
  assert.ok(risks.capabilityGaps.some((gap) => gap.includes("formula")))
  assert.ok(risks.capabilityGaps.some((gap) => gap.includes("image")))
  assert.ok(risks.capabilityGaps.some((gap) => gap.includes("OCR")))
  assert.ok(risks.detectorLimits.length >= 2, "检测器漏判风险必须记录")
})

// ---------------------------------------------------------------------------
// 摄取入口端到端：负例不得宣布完整，正例保持清洁
// ---------------------------------------------------------------------------

test("UT-12 端到端：简单 PDF 清洁、复杂结构全部有稳定待校验理由", async () => {
  // 正例：已验证简单范围不待校验。
  for (const file of ["simple-body.pdf", "footnotes.pdf"]) {
    const { document } = await ingestPdf(file)
    const risks = risksOf(document)
    assert.equal(risks.reviewRequired, false, `${file} 不应待校验：${JSON.stringify(risks.reviewReasons)}`)
    assert.deepEqual(risks.exclusionRules, [], `${file} 排除审计为空`)
  }

  // 分栏：阅读顺序未验证。
  const columns = await ingestPdf("two-columns.pdf")
  const columnsRisks = risksOf(columns.document)
  assert.ok(columnsRisks.reviewReasons.includes("columns_reading_order_unverified"), "分栏必须有理由码")
  assert.ok(columnsRisks.possibleColumnPages.includes(1))
  // 六条真值行仍逐字保留（风险标记不删内容）。
  const columnsEvidence = new ExtractionEvidenceRepository(openDb()).get(columns.docId)
  assert.ok(columnsEvidence)
  for (const line of ["左栏一：退货时限为七天。", "右栏二：金额上限 500 元。", "右栏三：不支持口头承诺。"]) {
    assert.ok(
      columnsEvidence.artifact.rawExtraction.includes(line),
      `分栏真值行逐字保留：${line}`
    )
  }

  // 混合扫描：无文本层页 → 待校验（不再凭 2/3 覆盖宣布完整）。
  const mixed = await ingestPdf("mixed-scan.pdf")
  const mixedRisks = risksOf(mixed.document)
  assert.ok(mixedRisks.reviewReasons.includes("pages_without_text_layer_or_empty"))
  assert.deepEqual(mixedRisks.pagesWithoutTextBlocks, [2])
  const mixedEvidence = new ExtractionEvidenceRepository(openDb()).get(mixed.docId)
  assert.ok(mixedEvidence)
  assert.equal(mixedEvidence.artifact.pages.find((page) => page.page === 2)?.status, "unextracted_no_text_layer_or_empty")

  // 表格重叠：正文行保留 + 重叠风险标记（候选转换未经等价验证）。
  const overlap = await ingestPdf("table-overlap.pdf")
  const overlapRisks = risksOf(overlap.document)
  assert.ok(overlapRisks.reviewReasons.includes("candidate_table_conversion_unverified"))
  assert.ok(overlapRisks.reviewReasons.includes("table_text_overlap_preserved_for_review"))
  assert.equal(overlapRisks.tablesOverlappingText, 1)

  // 纯表格：表头-值关系保留，转换仍未验证（保守待校验）。
  const pure = await ingestPdf("pure-table.pdf")
  const pureRisks = risksOf(pure.document)
  assert.ok(pureRisks.reviewReasons.includes("candidate_table_conversion_unverified"))
  const pureEvidence = new ExtractionEvidenceRepository(openDb()).get(pure.docId)
  assert.ok(pureEvidence)
  const pureTableBlocks = pureEvidence.artifact.rawExtraction
  for (const value of ["姓名", "金额", "是否退款", "张三", "50元", "李四", "30元"]) {
    assert.ok(pureTableBlocks.includes(value), `表头-值关系在原提取中保留：${value}`)
  }
})

test("UT-12 收尾：关闭隔离库", () => {
  closeDb()
})
