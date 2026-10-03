// UT-10：TXT 保真解码与保守清洗。
//
// 契约（UP-05 AC 1/2/3/5，经 10 票继承）：纯文本走进程内 direct-txt 路径，
// 编码证据（BOM/严格 UTF-8）明确；只做两项已约定变换（剥前导 BOM、
// CRLF/CR→LF），词间空格、代码缩进、制表含义、数字、顺序、有效重复与
// 字面 Markdown 语法原样保留；模糊编码（GBK 猜测）与损坏字节如实记
// 待校验，与文件原有合法 U+FFFD 区分；解码来源随块 metadata 可追溯，
// 其他格式不误入本路径。真值样本与允许变换清单来自
// golden/upload-truth/txt/truth-manifest.json（UT-01 建立，与被测实现独立）。
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
import { DirectTextParser, decodeTextBytes } from "./parser"
import type { IngestionStoreImpl } from "./storage"
import { selectParserRoute } from "./parser"
import { checkChunkCoverage, compareTextToTruth } from "./truth/truth_compare"

const HERE = dirname(__filename)
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
// loadConfig() 是进程级 memoize：必须在任何 loadConfig 调用之前固定隔离库。
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "kefu-rag-ut10-")), "ingestion.db")

const TRUTH_DIR = resolve(HERE, "../../golden/upload-truth/txt")

interface TruthSample {
  id: string
  file: string
  encoding: string
  bom: boolean
  lineEnding: string
  decodeExpectation: string
  truthText: string
}

interface TruthManifest {
  samples: TruthSample[]
}

const manifest = JSON.parse(
  readFileSync(join(TRUTH_DIR, "truth-manifest.json"), "utf8")
) as TruthManifest

function makeFakeStore() {
  const storedChunks: Array<{ documentId: string; content: string }> = []
  const fakeStore = {
    async storeChunks(
      chunks: Array<{ documentId: string; content: string }>
    ): Promise<unknown> {
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
  }
  return { fakeStore: fakeStore as unknown as IngestionStoreImpl, storedChunks }
}

async function ingestSample(
  sample: TruthSample,
  idSuffix = ""
): Promise<{
  docId: string
  storedChunks: Array<{ documentId: string; content: string }>
}> {
  const db = openDb()
  const { fakeStore, storedChunks } = makeFakeStore()
  const lifecycle = new IngestionLifecycle(
    db,
    // direct-txt 是进程内解析器，生产 configuredParser 即可；不注入也走同一路径。
    new PipelineStageRunner(db, undefined as never, fakeStore)
  )
  const submitted = lifecycle.submit({
    title: `UT-10 ${sample.id}${idSuffix}`,
    content: "",
    rawContent: readFileSync(join(TRUTH_DIR, sample.file)),
    fileName: sample.file,
    mimeType: "text/plain",
    sourceIdentity: {
      kind: "file",
      uriOrExternalId: `C:/truth/ut10/${sample.file}${idSuffix}`,
      namespace: "ut10",
    },
  })
  const result = await lifecycle.runNext()
  assert.ok(result?.success, `${sample.id} 必须经保真 TXT 路径完成解析`)
  return { docId: submitted.docId, storedChunks }
}

// ---------------------------------------------------------------------------
// 单元：解码证据
// ---------------------------------------------------------------------------

test("UT-10 解码：BOM 是最强编码证据，解码输出保留 BOM 与原行尾", () => {
  for (const id of ["utf8-bom", "utf16le-bom", "utf16be-bom"]) {
    const sample = manifest.samples.find((entry) => entry.id === id) as TruthSample
    const bytes = readFileSync(join(TRUTH_DIR, sample.file))
    const outcome = decodeTextBytes(bytes)
    assert.equal(outcome.provenance.encoding, sample.encoding, id)
    assert.equal(outcome.provenance.evidence, "bom", id)
    assert.equal(outcome.provenance.reviewRequired, false, id)
    // BOM 与原行尾在提取边界保留——清洗才应用已约定变换。
    assert.ok(outcome.text.startsWith("\uFEFF"), `${id} 提取边界保留 BOM`)
    assert.equal(outcome.text.slice(1), sample.truthText, `${id} BOM 后逐字一致`)
  }
})

test("UT-10 解码：无 BOM 的有效 UTF-8 即证据，不待校验", () => {
  const sample = manifest.samples.find((entry) => entry.id === "utf8-baseline") as TruthSample
  const outcome = decodeTextBytes(readFileSync(join(TRUTH_DIR, sample.file)))
  assert.equal(outcome.provenance.encoding, "utf-8")
  assert.equal(outcome.provenance.evidence, "strict-utf8")
  assert.equal(outcome.provenance.reviewRequired, false)
  assert.equal(outcome.text, sample.truthText)
})

test("UT-10 解码：GBK 回退是猜测——内容可读但必须待校验", () => {
  const sample = manifest.samples.find((entry) => entry.id === "legacy-gbk") as TruthSample
  const outcome = decodeTextBytes(readFileSync(join(TRUTH_DIR, sample.file)))
  assert.equal(outcome.provenance.encoding, "gbk")
  assert.equal(outcome.provenance.evidence, "fallback-guess")
  assert.equal(outcome.provenance.reviewRequired, true)
  assert.equal(outcome.provenance.reviewReason, "ambiguous_encoding")
  assert.ok(outcome.provenance.warnings.length > 0)
  // GBK 解码内容与设计真值一致（待校验 ≠ 内容错，而是编码无法确认）。
  assert.equal(outcome.text.replace(/\r\n/g, "\n"), sample.truthText.replace(/\r\n/g, "\n"))
})

test("UT-10 解码：损坏字节与原有合法 U+FFFD 分别记录，不混为一谈", () => {
  // 损坏字节：非有效 UTF-8，且 GBK(gb18030) fatal 解码也在截断的多字节
  // 序列上失败 → 解码引入替换字符（corrupt_bytes）。
  const corrupt = decodeTextBytes(Buffer.from([0x81]))
  assert.equal(corrupt.provenance.reviewRequired, true)
  assert.equal(corrupt.provenance.reviewReason, "corrupt_bytes")
  assert.ok(corrupt.text.includes("\uFFFD"), "非 fatal 解码引入 U+FFFD")
  // 原有合法 U+FFFD：严格 UTF-8 成功，U+FFFD 来自文件本身——不算解码错误，
  // 但内容带损坏证据，仍明确待校验（不以非空字符串判完整）。
  const legitimate = decodeTextBytes(Buffer.from("旧内容\uFFFD", "utf8"))
  assert.equal(legitimate.provenance.evidence, "strict-utf8")
  assert.equal(legitimate.provenance.reviewRequired, true)
  assert.equal(legitimate.provenance.reviewReason, "legitimate_replacement_char_present")
  assert.equal(legitimate.text, "旧内容\uFFFD")
})

// ---------------------------------------------------------------------------
// 单元：保守清洗
// ---------------------------------------------------------------------------

test("UT-10 清洗：字面 Markdown 语法原样保留，全文单块不重排", () => {
  const sample = manifest.samples.find((entry) => entry.id === "literal-markdown") as TruthSample
  const raw = readFileSync(join(TRUTH_DIR, sample.file)).toString("utf8")
  const parser = new DirectTextParser()
  const blocks = parser.normalizeRaw(raw, "doc-literal")
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].text, raw, "LF 无 BOM 样本：清洗输出与解码输出逐字一致")
  assert.ok(blocks[0].text.includes("# 这一行以井号开头"), "字面 # 保留")
  assert.ok(blocks[0].text.includes("**双星号必须原样保留**"), "字面 ** 保留")
  assert.ok(blocks[0].text.includes("1. 第一项"), "字面列表记号保留")
  assert.ok(blocks[0].text.includes("|列A|列B|"), "字面表格竖线保留")
})

test("UT-10 清洗：只应用已约定变换（剥 BOM、CRLF→LF），其余逐字保留", () => {
  const parser = new DirectTextParser()
  parser.parseRaw({ content: Buffer.from("\uFEFF标题行\r\n    缩进行   \r\n", "utf8"), fileName: "t.txt" })
  const blocks = parser.normalizeRaw("\uFEFF标题行\r\n    缩进行   \r\n", "doc-transforms")
  assert.equal(blocks[0].text, "标题行\n    缩进行   \n", "BOM 剥掉、CRLF 归一，缩进与行尾空格逐字保留")
  const decode = blocks[0].metadata.decode as { allowedTransforms: string[] }
  assert.deepEqual(decode.allowedTransforms.sort(), ["CRLF/CR -> LF", "strip single leading BOM"])
})

test("UT-10 清洗：空或纯空白文本明确失败，不产空块", () => {
  const parser = new DirectTextParser()
  assert.throws(() => parser.normalizeRaw("   \n\r\n  ", "doc-empty"), /no text content/)
})

// ---------------------------------------------------------------------------
// 摄取入口端到端：全部真值样本符合独立真值（AC 1）
// ---------------------------------------------------------------------------

test("UT-10 端到端：8 个真值样本从摄取入口符合独立真值且可追溯", async () => {
  const db = openDb()
  const documents = new DocumentRepo(db)
  for (const sample of manifest.samples) {
    const { docId, storedChunks } = await ingestSample(sample)

    // 字节、解码与清洗来源可追溯：system.decode + 完整证据行 + 原件未动。
    const document = documents.get(docId)
    assert.ok(document, sample.id)
    assert.deepEqual(document.rawContent, readFileSync(join(TRUTH_DIR, sample.file)), `${sample.id} 原件逐字节保留`)
    const system = document.metadata.system as {
      decode?: { encoding: string; evidence: string; allowedTransforms: string[]; reviewRequired: boolean; reviewReason?: string; warnings: string[] }
      parser?: { selected?: string }
    }
    assert.equal(system.parser?.selected, "direct-txt", `${sample.id} 走保真路径`)
    assert.ok(system.decode, `${sample.id} 解码来源必须落 metadata`)
    assert.deepEqual(system.decode?.allowedTransforms, sample.decodeExpectation === "exact"
      ? []
      : sample.decodeExpectation === "exact_after_crlf_normalization"
        ? ["CRLF/CR -> LF"]
        : sample.bom
          ? ["strip single leading BOM"]
          : ["CRLF/CR -> LF"], `${sample.id} 允许变换可追溯`)

    // 证据行：原始提取（清洗前）+ 独立哈希。
    const evidence = new ExtractionEvidenceRepository(db).get(docId)
    assert.ok(evidence, `${sample.id} 证据行存在`)
    assert.equal(evidence.valid, true, `${sample.id} 证据有效：${evidence.invalidReason ?? ""}`)
    assert.equal(evidence.artifact.parserType, "direct-txt")
    const raw = evidence.artifact.rawExtraction

    // 提取边界：按 decodeExpectation 核对独立真值。
    if (sample.decodeExpectation === "exact") {
      assert.equal(raw, sample.truthText, `${sample.id} 提取输出与真值逐字一致`)
    } else if (sample.decodeExpectation === "exact_modulo_leading_bom") {
      assert.equal(raw, `\uFEFF${sample.truthText}`, `${sample.id} 仅差前导 BOM`)
    } else if (sample.decodeExpectation === "exact_after_crlf_normalization") {
      assert.equal(raw.replace(/\r\n/g, "\n"), sample.truthText, `${sample.id} CRLF 归一后与真值一致`)
    } else {
      // pending_review_allowed：内容符合真值，但模糊编码明确待校验。
      const comparison = compareTextToTruth(sample.truthText, raw)
      assert.equal(comparison.verdict, "match", `${sample.id} GBK 内容与真值一致：${JSON.stringify(comparison.findings)}`)
      assert.equal(system.decode?.reviewRequired, true, `${sample.id} 模糊编码必须待校验`)
      assert.equal(system.decode?.reviewReason, "ambiguous_encoding")
    }

    // 切块边界：词元覆盖无损、不伪造。
    const childTexts = storedChunks
      .filter((chunk) => chunk.documentId === docId)
      .map((chunk) => chunk.content)
    assert.ok(childTexts.length > 0, `${sample.id} 必须产出切块`)
    const coverage = checkChunkCoverage(sample.truthText, childTexts)
    assert.equal(coverage.verdict, "match", `${sample.id} 切块覆盖：${JSON.stringify({ missing: coverage.missingTokenSamples, fabricated: coverage.fabricatedTokenSamples })}`)
  }
})

test("UT-10 端到端：字面语法与空白语义进切块（不被猜测删除）", async () => {
  const literal = manifest.samples.find((entry) => entry.id === "literal-markdown") as TruthSample
  const crlf = manifest.samples.find((entry) => entry.id === "crlf-indent") as TruthSample

  const literalRun = await ingestSample(literal, "-chunk-check")
  const literalJoined = literalRun.storedChunks
    .filter((chunk) => chunk.documentId === literalRun.docId)
    .map((chunk) => chunk.content)
    .join("\n")
  assert.ok(literalJoined.includes("# 这一行以井号开头"), "字面 # 进入切块")
  assert.ok(literalJoined.includes("**双星号必须原样保留**"), "字面 ** 进入切块")
  assert.ok(literalJoined.includes("|列A|列B|"), "字面表格进入切块")
  assert.ok(literalJoined.includes("1. 第一项"), "字面列表进入切块")

  const crlfRun = await ingestSample(crlf, "-chunk-check")
  const crlfJoined = crlfRun.storedChunks
    .filter((chunk) => chunk.documentId === crlfRun.docId)
    .map((chunk) => chunk.content)
    .join("\n")
  assert.ok(crlfJoined.includes("    server_port = 8080"), "代码缩进进入切块")
  assert.ok(crlfJoined.includes("        ssl_enabled = false"), "嵌套缩进进入切块")
  assert.ok(crlfJoined.includes("行尾空格行：   "), "行尾空格进入切块")
  assert.ok(crlfJoined.includes("不启用自动重试"), "否定语义进入切块")
})

test("UT-10 路由边界：其他格式不误入保真 TXT 路径", () => {
  // 只有 .txt / text/plain 走 direct-txt；结构化文本保持 MarkItDown 路由。
  assert.deepEqual(selectParserRoute({ fileName: "a.txt" }).candidates, ["direct-txt"])
  assert.deepEqual(selectParserRoute({ fileName: "a.txt", mimeType: "text/plain" }).candidates, ["direct-txt"])
  assert.deepEqual(selectParserRoute({ fileName: "blob", mimeType: "text/plain" }).candidates, ["direct-txt"])
  assert.deepEqual(selectParserRoute({ fileName: "notes.md" }).candidates, ["markitdown"])
  assert.deepEqual(selectParserRoute({ fileName: "table.csv", mimeType: "text/csv" }).candidates, ["markitdown"])
  assert.deepEqual(selectParserRoute({ fileName: "data.json" }).candidates, ["markitdown"])
  assert.deepEqual(selectParserRoute({ fileName: "doc.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }).candidates, ["markitdown"])
  // 显式 direct-txt override 在非文本类上被归一（类型匹配语义不变）。
  const overrideOnPdf = selectParserRoute({ fileName: "a.pdf", mimeType: "application/pdf", override: "direct-txt" })
  assert.deepEqual(overrideOnPdf.candidates, ["marker", "builtin-pdf"])
  assert.match(overrideOnPdf.reason, /direct-txt is not compatible with pdf files/)
})

test("UT-10 收尾：关闭隔离库", () => {
  closeDb()
})
