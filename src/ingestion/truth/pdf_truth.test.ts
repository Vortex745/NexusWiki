// UT-02：PDF 逐页真值与误成功复现。
//
// 本票不修生产行为：用独立设计的逐页真值（golden/upload-truth/pdf/，
// 扫描页同样有设计真值）经既有解析入口核对当前 builtin-pdf 路径，把漏页、
// 错序、表格吞噬正文与覆盖警告丢失写成可复核报告。复杂样本以"正确待校验"
// 为预期，页数或标记命中不能代替全文证据。
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { loadConfig } from "../../config"
import { closeDb, openDb } from "../tracking"
import { DocumentRepo } from "../tracking/doc_repo"
import { IngestionLifecycle } from "../lifecycle"
import { PipelineStageRunner } from "../pipeline"
import {
  BuiltinPdfParser,
  MarkItDownParser,
  MarkerParser,
  selectParserRoute,
  runBoundedProcess,
} from "../parser"
import type { BuiltinPdfParserOptions } from "../parser"
import type { IngestionStoreImpl, ChunkStoreMetrics } from "../storage"
import { checkChunkCoverage, compareTextToTruth } from "./truth_compare"

const HERE = dirname(__filename)
// loadConfig 在缺省环境必需一个 key（本票不调用任何模型）。
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
// loadConfig() 是进程级 memoize：必须在任何 loadConfig 调用之前固定隔离库，
// 否则 test 3 先冻结 config，test 5 会落到开发库 data/kefu-rag.db。
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "kefu-rag-ut02-")), "ingestion.db")
const TRUTH_DIR = resolve(HERE, "../../../golden/upload-truth/pdf")
const REPORT_DIR = resolve(HERE, "../../../.scratch/upload-truth")
const REPORT_PATH = join(REPORT_DIR, "ut02-pdf-reproduction.json")

interface TruthPage {
  page: number
  truthLines: string[]
  note?: string
}

interface TruthSample {
  id: string
  file: string
  fileSha256: string
  pageCount: number
  expectation: "exact" | "pending_review_allowed" | "parse_failure_allowed"
  pages: TruthPage[]
  relations?: Array<{ kind: string; values: string[] }>
  mustPreserve: string[]
  notes?: string
  capabilityGaps?: string[]
}

interface TruthManifest {
  manifestVersion: string
  annotationMethod: string
  samples: TruthSample[]
}

const manifest = JSON.parse(
  readFileSync(join(TRUTH_DIR, "truth-manifest.json"), "utf8")
) as TruthManifest

const sha256File = (filePath: string) =>
  createHash("sha256").update(readFileSync(filePath)).digest("hex")

const report: {
  ticket: string
  generatedAt: string | null
  annotationMethod: string
  disclaimer: string
  environment: Record<string, unknown>
  routeControl: Record<string, unknown>
  incompleteActivationReproduction: Record<string, unknown>
  samples: Array<Record<string, unknown>>
} = {
  ticket: "UT-02",
  generatedAt: null,
  annotationMethod: manifest.annotationMethod,
  disclaimer:
    "本报告是选定设计样本在当前工作树上的观测记录，不是生产成功率、修复后成绩" +
    "或可行性概率。marker/mineru 不可用，OCR 路径未测；复杂样本以正确待校验为预期。" +
    "真实正文留在本地，不发送 Jev。",
  environment: {},
  routeControl: {},
  incompleteActivationReproduction: {},
  samples: [],
}

function parserOptions(config: ReturnType<typeof loadConfig>): BuiltinPdfParserOptions {
  return {
    command: config.pythonCommand || "python",
    timeoutMs: config.parserTimeoutMs ?? 120_000,
    inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
    outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
  }
}

async function extractRawJson(
  config: ReturnType<typeof loadConfig>,
  pdfPath: string
): Promise<Record<string, unknown>> {
  const stdout = await runBoundedProcess({
    command: config.pythonCommand || "python",
    args: [BuiltinPdfParser.defaultScriptPath(), pdfPath],
    timeoutMs: config.parserTimeoutMs ?? 120_000,
    outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
  })
  return JSON.parse(stdout) as Record<string, unknown>
}

test("UT-02 真值清单完整性：样本字节与设计逐页真值哈希一致", () => {
  assert.equal(manifest.manifestVersion, "ut02-pdf-truth-v1")
  assert.equal(manifest.annotationMethod, "designed")
  assert.ok(manifest.samples.length >= 11)
  const ids = new Set<string>()
  for (const sample of manifest.samples) {
    assert.ok(!ids.has(sample.id))
    ids.add(sample.id)
    assert.equal(sha256File(join(TRUTH_DIR, sample.file)), sample.fileSha256, sample.id)
    assert.ok(
      ["exact", "pending_review_allowed", "parse_failure_allowed"].includes(sample.expectation)
    )
    const coveredPages = new Set(sample.pages.map((page) => page.page))
    assert.equal(sample.pages.length, sample.pageCount, `${sample.id} 真值必须逐页登记`)
    for (let page = 1; page <= sample.pageCount; page += 1) {
      assert.ok(coveredPages.has(page), `${sample.id} 缺少第 ${page} 页真值`)
    }
    for (const page of sample.pages) {
      if (page.truthLines.length === 0) continue
      assert.ok(page.truthLines.every((line) => line.trim().length > 0))
    }
  }
  const idsRequired = [
    "simple-body", "footnotes", "two-columns", "table-overlap", "pure-table",
    "empty-page", "image-figure", "mixed-scan", "scan-majority", "encrypted", "corrupted",
  ]
  for (const required of idsRequired) {
    assert.ok(ids.has(required), `missing required sample ${required}`)
  }
})

test("UT-02 路由对照：PDF 默认文字层提取；历史 marker 覆盖映射到 OCR API", () => {
  const route = selectParserRoute({ fileName: "样本.pdf", mimeType: "application/pdf" })
  assert.deepEqual(route.candidates, ["builtin-pdf"])
  assert.equal(route.authoritative, false)
  const override = selectParserRoute({
    fileName: "样本.pdf",
    mimeType: "application/pdf",
    override: "marker",
  })
  assert.deepEqual(override.candidates, ["ocr-api"])
  assert.equal(override.authoritative, true)
  report.routeControl = {
    pdfNoOverride: { candidates: route.candidates, authoritative: route.authoritative },
    pdfMarkerOverride: { candidates: override.candidates, authoritative: override.authoritative },
  }
})

test("UT-02 逐页真值核对：builtin-pdf 路径逐样本记录并落盘报告", async () => {
  const config = loadConfig()
  const builtin = new BuiltinPdfParser(parserOptions(config))
  const marker = new MarkerParser({
    command: config.markerCommand ?? "marker_single",
    timeoutMs: config.parserTimeoutMs ?? 120_000,
    inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
    outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
  })
  const markerAvailable = await probe(() => marker.parse({
    content: Buffer.from("probe"), fileName: "probe.pdf", documentId: "probe",
  }))
  report.environment = {
    python: config.pythonCommand || "python",
    script: BuiltinPdfParser.defaultScriptPath(),
    markerAvailable,
    builtinAvailable: true,
  }

  for (const sample of manifest.samples) {
    const entry: Record<string, unknown> = {
      id: sample.id,
      expectation: sample.expectation,
      notes: sample.notes ?? null,
      capabilityGaps: sample.capabilityGaps ?? [],
    }
    const pdfPath = join(TRUTH_DIR, sample.file)
    let raw: Record<string, unknown> | null = null
    let parseError: string | null = null
    let blocks: Awaited<ReturnType<typeof builtin.parse>> = []
    try {
      blocks = await builtin.parse({
        content: readFileSync(pdfPath),
        fileName: sample.file,
        mimeType: "application/pdf",
        documentId: sample.id,
      })
      try {
        raw = await extractRawJson(config, pdfPath)
      } catch {
        // rc≠0 时脚本 stdout 不会 resolve（parse 已给出真实失败）；此处仅影响
        // warnings 观测，不影响归一化块。
        raw = null
      }
      entry.parseStatus = "succeeded"
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error)
      entry.parseStatus = "failed"
      entry.parseError = parseError
    }
    entry.rawWarnings = raw ? (raw.warnings as string[]) : null
    entry.pageNumbers = parseError
      ? null
      : Array.from(
          new Set(blocks.map((block) => block.page).filter((page): page is number => typeof page === "number"))
        ).sort((a, b) => a - b)

    if (!parseError) {
      // 逐页对比：表格页以关系为真值（markdown 重排不按行比较，见 truthLines: []）。
      const pageResults: Array<Record<string, unknown>> = []
      for (const truthPage of sample.pages) {
        if (truthPage.truthLines.length === 0) {
          pageResults.push({ page: truthPage.page, verdict: "not_line_compared", note: truthPage.note ?? null })
          continue
        }
        const pageBlocks = blocks
          .filter((block) => block.page === truthPage.page)
          .sort((a, b) => a.index - b.index)
        if (pageBlocks.length === 0) {
          pageResults.push({
            page: truthPage.page,
            verdict: "page_missing",
            note: truthPage.note ?? "该页真值有内容，但当前解析没有产出任何块",
          })
          continue
        }
        const comparison = compareTextToTruth(
          truthPage.truthLines.join("\n"),
          pageBlocks.map((block) => block.text).join("\n")
        )
        pageResults.push({ page: truthPage.page, verdict: comparison.verdict, findings: comparison.findings })
      }
      entry.pageResults = pageResults

      // 切块边界词元覆盖：整个真值（含扫描页设计文本）对块文本。
      const truthAll = sample.pages
        .flatMap((page) => page.truthLines)
        .join("\n")
      if (truthAll.trim()) {
        const coverage = checkChunkCoverage(
          truthAll,
          blocks.map((block) => block.text)
        )
        entry.chunkCoverage = {
          verdict: coverage.verdict,
          missingTokenSamples: coverage.missingTokenSamples,
          fabricatedTokenSamples: coverage.fabricatedTokenSamples,
          coveredTruthLines: coverage.coveredTruthLines,
          totalTruthLines: coverage.totalTruthLines,
        }
      }
    }
    report.samples.push(entry)
  }

  writeReport()
  assert.equal(report.samples.length, manifest.samples.length)
  const byId = new Map(report.samples.map((entry) => [entry.id, entry]))

  // —— 确定性特征（修复后由对应票更新断言）——
  // 1) 简单正文：三页逐页精确匹配，页位保持。
  const simple = byId.get("simple-body") as { parseStatus: string; pageNumbers: number[]; pageResults: Array<{ page: number; verdict: string }> }
  assert.equal(simple.parseStatus, "succeeded")
  assert.deepEqual(simple.pageNumbers, [1, 2, 3])
  for (const result of simple.pageResults) {
    assert.equal(result.verdict, "match", `simple-body page ${result.page}: ${JSON.stringify(simple.pageResults)}`)
  }
  // 2) 脚注：小字脚注与正文同页保留。
  const footnotes = byId.get("footnotes") as { pageResults: Array<{ page: number; verdict: string }> }
  assert.equal(footnotes.pageResults[0].verdict, "match")
  // 3) 分栏：按 (y,x) 排序把左右栏交错——阅读顺序损失被逐页真值捕获。
  const columns = byId.get("two-columns") as { pageResults: Array<{ page: number; verdict: string; findings: Array<{ kind: string; detail: string }> }> }
  assert.equal(columns.pageResults[0].verdict, "loss")
  assert.ok(columns.pageResults[0].findings.some((f) => f.kind === "content"))
  // 4) 混合扫描：解析"成功"（假成功）——扫描页静默消失且无任何警告。
  const mixed = byId.get("mixed-scan") as {
    parseStatus: string; pageNumbers: number[]; rawWarnings: string[] | null;
    pageResults: Array<{ page: number; verdict: string }>
  }
  assert.equal(mixed.parseStatus, "succeeded")
  assert.deepEqual(mixed.pageNumbers, [1, 3])
  assert.deepEqual(mixed.rawWarnings, [], "2/3 覆盖率不触发低覆盖警告——假成功无任何提示")
  assert.equal(mixed.pageResults.find((r) => r.page === 2)?.verdict, "page_missing")
  // 5) 扫描为主：脚本发出低覆盖警告，但归一化块不含任何警告通道——警告丢失。
  const majority = byId.get("scan-majority") as { parseStatus: string; rawWarnings: string[] | null; pageNumbers: number[] }
  assert.equal(majority.parseStatus, "succeeded")
  assert.ok((majority.rawWarnings ?? []).length >= 1, "脚本必须发出低覆盖警告")
  assert.match((majority.rawWarnings ?? [])[0], /low text-layer coverage/)
  assert.deepEqual(majority.pageNumbers, [1])
  // 6) 重叠表格（UT-11 修复后）：重叠正文行不再缺失；表格 markdown 与
  //    正文行并存，重复内容以 fabrication 如实记录——保守保留而非猜测删除。
  const overlap = byId.get("table-overlap") as { parseStatus: string; pageResults: Array<{ page: number; verdict: string; findings: Array<{ kind: string; detail: string }> }> }
  assert.equal(overlap.parseStatus, "succeeded")
  const overlapPage = overlap.pageResults[0]
  assert.ok(
    !overlapPage.findings.some((f) => f.kind === "content" && f.detail.includes("覆盖校验行")),
    "重叠正文行不再缺失（UT-11 保守保留）"
  )
  assert.ok(
    overlapPage.findings.some((f) => f.kind === "fabrication"),
    "表格 markdown 与正文行并存——重复如实记录为 fabrication"
  )
  // 7) 纯表格：表头-值关系整体保留在同一个表格块内。
  const pure = report.samples.find((entry) => entry.id === "pure-table") as { parseStatus: string }
  assert.equal(pure.parseStatus, "succeeded")
  // 8) 空页：页位保留为 1、3，第 2 页静默缺席。
  const empty = byId.get("empty-page") as { parseStatus: string; pageNumbers: number[]; pageResults: Array<{ page: number; verdict: string }> }
  assert.equal(empty.parseStatus, "succeeded")
  assert.deepEqual(empty.pageNumbers, [1, 3])
  // 9) 图片样本：文字与图注保留；图片本身无证据通道（能力缺口）。
  const figure = byId.get("image-figure") as { parseStatus: string; pageResults: Array<{ page: number; verdict: string }> }
  assert.equal(figure.parseStatus, "succeeded")
  assert.equal(figure.pageResults[0].verdict, "match")
  // 10) 加密/损坏：显式失败，不产出部分内容假成功。
  const encrypted = byId.get("encrypted") as { parseStatus: string; parseError: string }
  assert.equal(encrypted.parseStatus, "failed")
  assert.match(encrypted.parseError, /code 1|builtin-pdf failed|malformed/)
  const corrupted = byId.get("corrupted") as { parseStatus: string; parseError: string }
  assert.equal(corrupted.parseStatus, "failed")
  assert.match(corrupted.parseError, /code 1|builtin-pdf failed|malformed/)
})

test("UT-02 表格关系真值：表头-值关系保留；UT-11 修复后重叠行作为正文保留", async () => {
  const config = loadConfig()
  const builtin = new BuiltinPdfParser(parserOptions(config))

  const pure = await builtin.parse({
    content: readFileSync(join(TRUTH_DIR, "pure-table.pdf")),
    fileName: "pure-table.pdf",
    mimeType: "application/pdf",
    documentId: "pure-table-relations",
  })
  const tableBlocks = pure.filter((block) => block.type === "table")
  const paragraphBlocks = pure.filter((block) => block.type === "paragraph")
  // UT-11 更新：表格区域内的文本块不再被抑制（保守保留），原提取行与
  // 表格 markdown 并存，重叠关系记录在两侧 metadata 中。
  assert.equal(tableBlocks.length, 1)
  const tableText = tableBlocks[0].text
  for (const relation of [["姓名", "金额", "是否退款"], ["张三", "50元", "是"], ["李四", "30元", "否"]]) {
    for (const value of relation) {
      assert.ok(tableText.includes(value), `表头-值关系缺失: ${value}`)
    }
  }

  const overlap = await builtin.parse({
    content: readFileSync(join(TRUTH_DIR, "table-overlap.pdf")),
    fileName: "table-overlap.pdf",
    mimeType: "application/pdf",
    documentId: "table-overlap-relations",
  })
  const overlapParagraphs = overlap.filter((block) => block.type === "paragraph")
  // UT-11 修复：重叠正文行作为正文保留（UT-02 复现时它被表格抑制，
  // 只以跨列拆碎的片段活在表格 markdown 中）。
  const overlapBody = overlapParagraphs.find((block) => block.text.includes("覆盖校验行"))
  assert.ok(overlapBody, "重叠正文行必须作为正文保留")
  assert.equal(
    overlapBody.text,
    "覆盖校验行：本行与表格区域重叠，必须作为正文保留。",
    "重叠行逐字保留，不接受跨列拆碎"
  )
  assert.ok(overlapBody.metadata.overlapsTable, "重叠关系记录在正文块 metadata")
  // 表格本身必须被提取，且 overlap 关系在表格侧同样可核对。
  const overlapTable = overlap.find((block) => block.type === "table")
  assert.ok(overlapTable, "表格本身必须被提取")
  assert.ok(overlapTable.metadata.overlappedByText === true, "重叠关系记录在表格块 metadata")
  assert.ok(overlapTable.text.includes("手续费"), "表头在表格 markdown 中")
})

test("UT-02 不完整激活复现：UT-04 修复后缺页候选不再替换激活身份", async () => {
  const config = loadConfig()
  const db = openDb()
  try {
    const storedChunks: Array<{ documentId: string; content: string }> = []
    const fakeStore = {
      async storeChunks(
        chunks: Array<{ documentId: string; content: string }>
      ): Promise<ChunkStoreMetrics> {
        storedChunks.push(...chunks.map(({ documentId, content }) => ({ documentId, content })))
        return {
          chunkCount: chunks.length,
          passageCount: chunks.length,
          batchCount: 1,
          embeddingBatchCount: 1,
          embeddingRequestCount: 1,
          embeddingRetryCount: 0,
          embeddingRateLimitCount: 0,
          embeddingDurationMs: 1,
          rateLimitWaitMs: 0,
          bulkRequestCount: 1,
          bulkDurationMs: 1,
        }
      },
      async storeEntities(): Promise<void> {},
      async storeWikilinks(): Promise<void> {},
      get chunkIndexName(): string {
        return "fake-index"
      },
      async close(): Promise<void> {},
    } as unknown as IngestionStoreImpl

    const resolveParser = (type: string) => {
      if (type === "builtin-pdf") return new BuiltinPdfParser(parserOptions(config))
      if (type === "marker") {
        return new MarkerParser({
          command: config.markerCommand ?? "marker_single",
          timeoutMs: config.parserTimeoutMs ?? 120_000,
          inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
          outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
        })
      }
      return new MarkItDownParser({
        command: config.markitdownCommand ?? "markitdown",
        timeoutMs: config.parserTimeoutMs ?? 120_000,
        inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
        outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
      })
    }
    const stageRunner = new PipelineStageRunner(db, resolveParser as never, fakeStore)
    const lifecycle = new IngestionLifecycle(db, stageRunner)

    // v1：完整的三页样本 → 完成，但被 UT-04 激活门槛拒绝（无完整性证据）。
    const v1 = lifecycle.submit({
      title: "逐页真值 v1（完整）",
      content: "",
      rawContent: readFileSync(join(TRUTH_DIR, "simple-body.pdf")),
      fileName: "policy.pdf",
      mimeType: "application/pdf",
      parserOverride: "builtin-pdf",
      sourceIdentity: { kind: "file", uriOrExternalId: "C:/truth/policy.pdf", namespace: "ut02" },
    })
    assert.equal(v1.status, "pending")
    const run1 = await lifecycle.runNext()
    assert.ok(run1?.success, "完整样本必须完成")
    // UT-04 更新：激活门槛 fail-closed——没有完整性/索引凭证的候选不再
    // 自动激活（UT-02 首次记录时 v1 完成即自动激活，那是缺陷基线）。
    const sourceRow = db.prepare("SELECT active_doc_id FROM sources WHERE source_id = (SELECT source_id FROM documents WHERE doc_id = ?)").get(v1.docId) as { active_doc_id: string | null }
    assert.equal(sourceRow.active_doc_id, null, "无凭证候选不得激活（UT-04 门槛）")

    // v2：同一来源的混合扫描样本（第 2 页无文本层）→ 解析"成功"但缺页。
    const v2 = lifecycle.submit({
      title: "逐页真值 v2（缺页候选）",
      content: "",
      rawContent: readFileSync(join(TRUTH_DIR, "mixed-scan.pdf")),
      fileName: "policy.pdf",
      mimeType: "application/pdf",
      parserOverride: "builtin-pdf",
      versionIntent: "new_version",
      sourceIdentity: { kind: "file", uriOrExternalId: "C:/truth/policy.pdf", namespace: "ut02" },
    })
    assert.equal(v2.status, "pending")
    const run2 = await lifecycle.runNext()
    assert.ok(run2?.success, "缺页候选照样完成（假成功在 UT-15+ 由内容凭证拦截）")
    const sourceAfter = db.prepare("SELECT active_doc_id FROM sources WHERE source_id = (SELECT source_id FROM documents WHERE doc_id = ?)").get(v1.docId) as { active_doc_id: string | null }
    assert.equal(sourceAfter.active_doc_id, null, "缺页候选不再替换激活身份（旧版本保护）")
    const documentRepo = new DocumentRepo(db)
    assert.match(
      documentRepo.getActivationBlockReason(v1.docId) ?? "",
      /activation_index_proof_missing/,
      "激活阻碍原因可核对"
    )

    // v2 的块里没有扫描页设计文本——缺页内容从未进入管线（该损失由
    // UT-09 逐页证据揭示，不再靠激活兜底）。
    const v2Chunks = storedChunks.filter((chunk) => chunk.documentId === v2.docId)
    assert.ok(v2Chunks.length > 0)
    const joined = v2Chunks.map((chunk) => chunk.content).join("\n")
    assert.ok(joined.includes("混-1"), "第 1 页文本应进入切块")
    assert.ok(joined.includes("混-3"), "第 3 页文本应进入切块")
    assert.ok(!joined.includes("扫-2"), "扫描页设计文本（扫-2）必须缺失——缺页被静默吞掉")

    report.incompleteActivationReproduction = {
      v1DocId: v1.docId,
      v2DocId: v2.docId,
      v1Activated: false,
      v2ReplacedActiveVersion: false,
      activationBlockReason: documentRepo.getActivationBlockReason(v1.docId),
      scannedPageTokensInChunks: false,
      note: "UT-04 修复：无凭证候选完成但不激活，缺页 v2 不再替换激活身份；" +
        "缺页本身由 UT-09 逐页证据诚实记录，正向激活路径由 UT-15/16/17 交付。",
    }
    writeReport()
  } finally {
    closeDb()
  }
})

function probe(operation: () => Promise<unknown>): Promise<boolean> {
  return new Promise<boolean>((resolveProbe) => {
    void (async () => {
      try {
        await operation()
        resolveProbe(true)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        resolveProbe(!message.includes("executable is unavailable"))
      }
    })()
  })
}

function writeReport(): void {
  report.generatedAt = new Date().toISOString()
  mkdirSync(REPORT_DIR, { recursive: true })
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n")
}
