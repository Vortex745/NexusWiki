/**
 * Ticket 02：PDF 质量门独立标注语料的载入入口。
 *
 * 语料（真实 PDF 字节 + 逐页期望裁决 + 覆盖图）位于仓库根的
 * `golden/pdf-quality-corpus/`，由 `generate.py` 一次生成、可复现。这里只提供
 * 只读载入与闭集词汇，供后续票（05/07/09/12/16/17/27）把页面真值接到质量门上；
 * 本模块不调用任何提取器、Clef 或 OCR，因此标注不可能被实现产物污染。
 *
 * 与生产解析器无关的独立性核对由测试用 pdf-lib 完成（不是 builtin-pdf）。
 */
import { accessSync, constants, existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ReplayScenario } from "./replay"

/** 票面要求的 11 个必需类别。 */
export const REQUIRED_PDF_QUALITY_CATEGORIES = [
  "pure-text",
  "scanned",
  "mixed",
  "blank-page",
  "image-cover",
  "garbled",
  "table",
  "multi-column",
  "encrypted",
  "damaged",
  "unopenable",
] as const

/** 语料实际使用的类别闭集（必需类别 + 复杂内容补充类别）。 */
export const PDF_QUALITY_CATEGORIES = [
  ...REQUIRED_PDF_QUALITY_CATEGORIES,
  "footnote",
  "formula",
  "partial-rasterization",
  "batch-splitting",
] as const

export const PDF_QUALITY_VERDICTS = ["pass", "fail", "uncertain"] as const

/** 页面问题的闭集标签；`none` 表示该页无问题，其它标签不得自由发挥。 */
export const PDF_QUALITY_ISSUE_LABELS = [
  "none",
  "text-layer-absent",
  "garbled-text-layer",
  "content-missing",
  "content-fabricated",
  "reading-order-broken",
  "structure-flattened",
  "structure-unverified",
  "page-image-unavailable",
  "document-unreadable",
  "audit-incomplete",
] as const

export const PDF_QUALITY_DIMENSIONS = [
  "completeness",
  "accuracy",
  "readingOrder",
  "structureFidelity",
] as const

export const PDF_QUALITY_PAGE_LAYOUTS = [
  "single-column",
  "two-column",
  "table",
  "image-cover",
  "blank",
  "mixed",
  "rasterized",
  "unreadable",
] as const

/** 页面上人眼可见内容的载体类型。 */
export const PDF_QUALITY_CARRIERS = [
  "text-layer",
  "image-only",
  "image-plus-text-layer",
  "image-plus-garbled-text-layer",
  "blank",
  "unreadable",
] as const

/** 每行可见内容的文本角色（用于结构义务的判定）。 */
export const PDF_QUALITY_TEXT_ROLES = [
  "title",
  "body",
  "footnote",
  "table-cell",
  "formula",
  "caption",
  "image-only-text",
  "label",
] as const

/** 页面必须被证明保留的结构。 */
export const PDF_QUALITY_STRUCTURE_OBLIGATIONS = [
  "table-cell-alignment",
  "header-value-relation",
  "column-reading-order",
  "footnote-retention",
  "formula-fidelity",
  "page-position",
  "image-presence",
  "number-and-negation-fidelity",
] as const

export type PdfQualityVerdict = (typeof PDF_QUALITY_VERDICTS)[number]
export type PdfQualityIssueLabel = (typeof PDF_QUALITY_ISSUE_LABELS)[number]
export type PdfQualityDimension = (typeof PDF_QUALITY_DIMENSIONS)[number]
export type PdfQualityStage = "local" | "ocr-candidate"
export type DimensionAssessment = "pass" | "fail" | "uncertain"

export interface PageExpectation {
  verdict: PdfQualityVerdict
  issueLabels: PdfQualityIssueLabel[]
  dimensions: Record<PdfQualityDimension, DimensionAssessment>
}

export interface VisibleLine {
  line: string
  role: (typeof PDF_QUALITY_TEXT_ROLES)[number]
}

export interface PageAnnotation {
  authoredBy: string
  independentOfImplementationOutput: boolean
  derivation: string
  consultedSources: string[]
  documentPropertyUsed: string[]
}

export interface CorpusPage {
  page: number
  carrier: (typeof PDF_QUALITY_CARRIERS)[number]
  layout: (typeof PDF_QUALITY_PAGE_LAYOUTS)[number]
  blankByDesign: boolean
  /** 文本层与可见内容的关系：按设计忠实 / 部分缺失 / 乱码 / 无文本层 / 不可读。 */
  textLayerAuthored: "faithful" | "faithful-partial" | "garbled" | "absent" | "unreadable"
  visible: VisibleLine[]
  structureObligations: string[]
  expected: { local: PageExpectation; ocrCandidate: PageExpectation }
  annotation: PageAnnotation
}

export interface CorpusFixture {
  fixtureId: string
  file: string
  categories: string[]
  fileSha256: string
  fileBytes: number
  pageCount: number
  evidencePageCount: number
  byteStableOnRegeneration: boolean
  openableByIndependentReader: boolean
  auditEligible: boolean
  documentOutcome: "auditable" | "input-failure"
  productionMethod: string
  productionNotes: string
  pageMappingFormat: string
  documentExpectation: {
    verdict: PdfQualityVerdict | null
    issueLabels: PdfQualityIssueLabel[]
    requiresZeroServiceCalls: boolean
    note: string
  }
  sourceDocument: {
    identity: string
    kind: string
    origin: string
    title: string
    producer: string
    creationDateFixed: string
    downloadUrl: string | null
  }
  fixturePasswordTestVector?: string | null
  passwordIsNotACredential?: boolean
  pages: CorpusPage[]
}

export interface CoverageScenario {
  scenarioId: string
  description: string
  categories: string[]
  fixtureIds: string[]
  replayScenarioIds: string[]
  replayFree?: boolean
  replayFreeReason?: string | null
}

export interface CoverageMap {
  schemaVersion: string
  requiredAcceptanceScenarioIds: string[]
  scenarios: CoverageScenario[]
  unrepresented: Array<{ case: string; reason: string; approximatedBy: string | null }>
}

export interface CorpusManifest {
  schemaVersion: string
  ticket: string
  generatedBy: string
  generatedWith: Record<string, unknown>
  annotationProvenance: {
    method: string
    statement: string
    notDerivedFrom: string[]
    independentVerification: string
    structureObligationRule: string
    closedSetRule: string
  }
  externalServiceDependency: string
  readerToleranceObservations: Array<{ reader: string; observation: string }>
  verdicts: string[]
  issueLabels: string[]
  carriers: string[]
  pageLayouts: string[]
  textRoles: string[]
  structureObligations: string[]
  dimensions: string[]
  requiredCategories: string[]
  categories: string[]
  labelDimensionMap: Record<string, Record<string, DimensionAssessment>>
  fixtures: CorpusFixture[]
}

function resolveCorpusDir(): string {
  const relative = join("golden", "pdf-quality-corpus")
  const candidates = [
    resolve(__dirname, "..", "..", "..", relative),
    resolve(process.cwd(), relative),
  ]
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.R_OK)
      return candidate
    } catch {
      continue
    }
  }
  return candidates[0]
}

/** 语料根目录（绝对路径）；PDF 在 `pdfs/`，回放在 `replay/`。 */
export const PDF_QUALITY_CORPUS_ROOT = resolveCorpusDir()

function readJson<T>(relativePath: string): T {
  const absolute = join(PDF_QUALITY_CORPUS_ROOT, relativePath)
  if (!existsSync(absolute)) {
    throw new Error(`pdf quality corpus is missing ${relativePath} (looked in ${PDF_QUALITY_CORPUS_ROOT})`)
  }
  return JSON.parse(readFileSync(absolute, "utf8")) as T
}

export interface LoadedPdfQualityCorpus {
  root: string
  manifest: CorpusManifest
  fixtures: CorpusFixture[]
  coverageMap: CoverageMap
  replayScenarios: ReplayScenario[]
}

let cached: LoadedPdfQualityCorpus | null = null

/** 载入语料清单、覆盖图与全部回放场景（纯本地读取，无副作用）。 */
export function loadPdfQualityCorpus(): LoadedPdfQualityCorpus {
  if (cached) return cached
  const manifest = readJson<CorpusManifest>("corpus-manifest.json")
  const coverageMap = readJson<CoverageMap>("coverage-map.json")
  // 延迟 require 以避免与 replay.ts 形成循环依赖。
  const replay = require("./replay") as typeof import("./replay")
  const replayScenarios = replay.listReplayScenarios()
  cached = { root: PDF_QUALITY_CORPUS_ROOT, manifest, fixtures: manifest.fixtures, coverageMap, replayScenarios }
  return cached
}

export function listPdfQualityFixtures(): CorpusFixture[] {
  return loadPdfQualityCorpus().fixtures
}

export function pdfQualityFixture(fixtureId: string): CorpusFixture {
  const fixture = loadPdfQualityCorpus().fixtures.find((entry) => entry.fixtureId === fixtureId)
  if (!fixture) {
    throw new Error(`unknown pdf quality fixture: ${fixtureId}`)
  }
  return fixture
}

/** 读取 fixture 的原始 PDF 字节（同步，供注入到被测入口）。 */
export function readFixturePdf(fixtureId: string): Buffer {
  const fixture = pdfQualityFixture(fixtureId)
  const absolute = join(PDF_QUALITY_CORPUS_ROOT, fixture.file)
  if (!existsSync(absolute)) {
    throw new Error(`fixture pdf bytes are missing on disk: ${absolute}`)
  }
  return readFileSync(absolute)
}

/** 该页人眼可见的内容行（独立真值；图像页给出的是"页面上印着什么"）。 */
export function visibleLinesOf(fixtureId: string, page: number): string[] {
  const entry = pageOf(fixtureId, page)
  return entry.visible.map((line) => line.line)
}

export function pageOf(fixtureId: string, page: number): CorpusPage {
  const fixture = pdfQualityFixture(fixtureId)
  const entry = fixture.pages.find((candidate) => candidate.page === page)
  if (!entry) {
    throw new Error(`fixture ${fixtureId} has no page annotation for page ${page}`)
  }
  return entry
}

/**
 * 某一阶段每页的期望裁决 + 闭集标签 + 四维评估。
 * `local` 是"本地文本提取候选"的期望；`ocr-candidate` 是整篇 OCR 兜底候选的期望。
 */
export function expectedPageVerdicts(
  fixtureId: string,
  stage: PdfQualityStage
): Array<{ page: number; verdict: PdfQualityVerdict; issueLabels: PdfQualityIssueLabel[]; dimensions: Record<PdfQualityDimension, DimensionAssessment> }> {
  return pdfQualityFixture(fixtureId).pages.map((entry) => {
    const expectation = stage === "local" ? entry.expected.local : entry.expected.ocrCandidate
    return { page: entry.page, ...expectation }
  })
}

/** 文档级期望：可读文档进入审计，不可读文档必须是输入失败。 */
export function expectedDocumentOutcome(fixtureId: string): { auditEligible: boolean; documentOutcome: string } {
  const fixture = pdfQualityFixture(fixtureId)
  return { auditEligible: fixture.auditEligible, documentOutcome: fixture.documentOutcome }
}
