// UT-11：简单 PDF 正文与脚注保真。
//
// 契约（UP-06 AC 1/4/5，经 11 票继承）：已验证简单文本 PDF 的正文、脚注、
// 数值、否定与顺序逐字保留；表格重叠正文不再被抑制（保守保留，重叠关系
// 两侧记录）；每项允许变换（点线归一）在块 metadata 有来源记录，原文可
// 从证据 rawExtraction 核对；提取脚本的覆盖警告经归一化与文档状态完整
// 传递（不再丢弃），逐页空白/未提取/异常由证据层诚实区分；疑似页眉页脚
// 无过滤、默认保留。
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
import { BuiltinPdfParser, normalizeBuiltinPdf } from "./parser"
import type { BuiltinPdfParserOptions } from "./parser"
import type { IngestionStoreImpl } from "./storage"
import { loadConfig } from "../config"

const HERE = dirname(__filename)
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
// loadConfig() 是进程级 memoize：必须在任何 loadConfig 调用之前固定隔离库。
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "kefu-rag-ut11-")), "ingestion.db")

const TRUTH_DIR = resolve(HERE, "../../golden/upload-truth/pdf")

function parserOptions(config: ReturnType<typeof loadConfig>): BuiltinPdfParserOptions {
  return {
    command: config.pythonCommand || "python",
    timeoutMs: config.parserTimeoutMs ?? 120_000,
    inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
    outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
  }
}

async function parseSample(
  file: string,
  documentId: string
): Promise<{ parser: BuiltinPdfParser; blocks: ReturnType<typeof normalizeBuiltinPdf> }> {
  const parser = new BuiltinPdfParser(parserOptions(loadConfig()))
  const raw = await parser.parseRaw({
    content: readFileSync(join(TRUTH_DIR, file)),
    fileName: file,
    mimeType: "application/pdf",
  })
  return { parser, blocks: parser.normalizeRaw(raw, documentId) }
}

test("UT-11 脚注保真：脚注行与正文同页逐字保留，顺序不变", async () => {
  const { blocks } = await parseSample("footnotes.pdf", "ut11-footnotes")
  const joined = blocks.map((block) => block.text).join("\n")
  const truthLines = [
    "脚注样本标题",
    "正文一：退款申请需在七天内提交。",
    "正文二：不支持口头申请。",
    "正文三：审核时限为三个工作日。",
    "※ 脚注：本条款不适用于 2026-01-01 之前的订单。",
  ]
  let cursor = 0
  for (const line of truthLines) {
    const found = joined.indexOf(line, cursor)
    assert.ok(found >= 0, `真值行缺失或乱序: ${line}`)
    cursor = found
  }
  // 数值与否定逐字保留。
  assert.ok(joined.includes("2026-01-01 之前"), "脚注日期数值保留")
  assert.ok(joined.includes("不适用"), "否定语义保留")
  // 页位来源保留。
  assert.ok(blocks.every((block) => block.page === 1))
})

test("UT-11 变换溯源：点线归一记录在块 metadata，普通文本不标记", () => {
  const raw = {
    version: 1,
    pageCount: 1,
    outline: [],
    blocks: [
      {
        page: 1,
        bbox: [0, 0, 300, 20],
        fontSize: 12,
        bold: false,
        text: "目录项............12",
      },
      {
        page: 1,
        bbox: [0, 30, 300, 50],
        fontSize: 12,
        bold: false,
        text: "普通正文行，校验词：甲-1。",
      },
    ],
    tables: [],
    warnings: [],
    stats: { textChars: 50, pagesWithText: 1 },
  }
  const blocks = normalizeBuiltinPdf(raw, "ut11-dot-leader")
  const toc = blocks.find((block) => block.text.includes("目录项"))
  assert.ok(toc, "目录行保留")
  assert.notEqual(toc.text, "目录项............12", "点线行按既定规则归一")
  const transforms = toc.metadata.transforms as string[] | undefined
  assert.ok(transforms?.includes("dot_leader_normalized"), "变换来源记录在块 metadata")
  const plain = blocks.find((block) => block.text.includes("普通正文行"))
  assert.ok(plain)
  assert.equal(plain.text, "普通正文行，校验词：甲-1。", "普通文本逐字保留")
  assert.equal(plain.metadata.transforms, undefined, "无变换不伪造记录")
})

test("UT-11 覆盖警告传递：scan-majority 的低覆盖警告进 metadata 与证据", async () => {
  // 归一化层：parseRaw 捕获提取 payload 自身的警告，extractionProvenance 暴露。
  const { parser, blocks } = await parseSample("scan-majority.pdf", "ut11-scan-majority")
  assert.ok(blocks.length > 0, "有文本层的页正常产出块")
  const provenance = parser.extractionProvenance()
  assert.ok(provenance, "提取摘要必须可用")
  assert.ok(
    provenance.warnings.some((warning) => warning.includes("low text-layer coverage: 1/3")),
    `低覆盖警告完整传递：${JSON.stringify(provenance.warnings)}`
  )
  assert.equal(
    (provenance.metadata.extraction as { pageCount: number | null }).pageCount,
    3
  )

  // 状态层：lifecycle 端到端后 system.extraction 与证据行都带警告。
  const db = openDb()
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
  } as unknown as IngestionStoreImpl
  const lifecycle = new IngestionLifecycle(db, new PipelineStageRunner(db, undefined as never, fakeStore))
  const submitted = lifecycle.submit({
    title: "UT-11 scan-majority",
    content: "",
    rawContent: readFileSync(join(TRUTH_DIR, "scan-majority.pdf")),
    fileName: "scan-majority.pdf",
    mimeType: "application/pdf",
    sourceIdentity: { kind: "file", uriOrExternalId: "C:/truth/ut11/scan-majority.pdf", namespace: "ut11" },
  })
  const result = await lifecycle.runNext()
  assert.ok(result?.success, "scan-majority 完成解析（警告≠失败）")

  const document = new DocumentRepo(db).get(submitted.docId)
  assert.ok(document)
  const system = document.metadata.system as {
    extraction?: { warnings: string[]; pageCount: number; pagesWithText: number }
    parser?: { selected?: string }
  }
  assert.equal(system.parser?.selected, "builtin-pdf")
  assert.ok(system.extraction, "提取摘要进文档状态")
  assert.ok(
    system.extraction?.warnings.some((warning) => warning.includes("low text-layer coverage")),
    "警告在状态中完整传递"
  )
  const evidence = new ExtractionEvidenceRepository(db).get(submitted.docId)
  assert.ok(evidence)
  assert.ok(
    evidence.artifact.warnings.some((warning) => warning.includes("low text-layer coverage")),
    "警告进持久证据行"
  )
  // 逐页：scan-majority 2 页无文本层——有警告时 note 指向扫描/OCR 缺口。
  const unextracted = evidence.artifact.pages.filter((page) => page.status !== "extracted")
  assert.equal(unextracted.length, 2, "两个无文本层页逐页登记")
  for (const page of unextracted) {
    assert.match(page.note ?? "", /scanned|OCR/, "警告在场时 note 指向扫描/OCR 缺口")
  }
})

test("UT-11 逐页区分：设计空页如实记 cause unknown，页位保持", async () => {
  const db = openDb()
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
  } as unknown as IngestionStoreImpl
  const lifecycle = new IngestionLifecycle(db, new PipelineStageRunner(db, undefined as never, fakeStore))
  const submitted = lifecycle.submit({
    title: "UT-11 empty-page",
    content: "",
    rawContent: readFileSync(join(TRUTH_DIR, "empty-page.pdf")),
    fileName: "empty-page.pdf",
    mimeType: "application/pdf",
    sourceIdentity: { kind: "file", uriOrExternalId: "C:/truth/ut11/empty-page.pdf", namespace: "ut11" },
  })
  const result = await lifecycle.runNext()
  assert.ok(result?.success)

  // 页位保持：第 1/3 页文本进入切块。
  const joined = storedChunks
    .filter((chunk) => chunk.documentId === submitted.docId)
    .map((chunk) => chunk.content)
    .join("\n")
  assert.ok(joined.includes("甲-1"), "第一页文本进切块")
  assert.ok(joined.includes("丙-3"), "第三页文本进切块（页位保持）")

  const evidence = new ExtractionEvidenceRepository(db).get(submitted.docId)
  assert.ok(evidence)
  assert.equal(evidence.artifact.pageCount, 3)
  assert.deepEqual(evidence.artifact.warnings, [], "2/3 覆盖不触发整文件警告")
  const page2 = evidence.artifact.pages.find((page) => page.page === 2)
  assert.ok(page2)
  assert.equal(page2.status, "unextracted_no_text_layer_or_empty")
  assert.match(page2.note ?? "", /cause unknown/, "无警告时空白原因如实标未知，不伪造映射")
  const page1 = evidence.artifact.pages.find((page) => page.page === 1)
  const page3 = evidence.artifact.pages.find((page) => page.page === 3)
  assert.equal(page1?.status, "extracted")
  assert.equal(page3?.status, "extracted")
})

test("UT-11 收尾：关闭隔离库", () => {
  closeDb()
})
