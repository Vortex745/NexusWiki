// UT-01：TXT 独立真值与缺陷复现。
//
// 本票不修生产行为：它把"设计的真值"与"当前管线的实际输出"逐边界对比，
// 把损失定位到 解码/提取、清洗（normalize）、切块 三个边界，并把当前失败
// （PDF override 污染 TXT、markitdown 输出归一化损失）写成可复核的报告。
// 真值由 golden/upload-truth/txt/generate.mjs 设计并登记哈希，与被测提取
// 完全独立；真实正文不发送 Jev（Jev 只见脱敏统计）。
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { createApp } from "../../api/server"
import { loadConfig } from "../../config"
import { closeDb, openDb } from "../tracking"
import { DocumentRepo } from "../tracking/doc_repo"
import { RecursiveChunker } from "../chunker/chunker"
import {
  MarkItDownParser,
  MarkerParser,
  selectParserRoute,
} from "../parser"
import { normalizeMarkItDown } from "../parser/normalize"
import type { Document } from "../../types"
import {
  checkChunkCoverage,
  compareTextToTruth,
  compareTransformedText,
  tokenizeForCoverage,
} from "./truth_compare"

const HERE = dirname(__filename)
const TRUTH_DIR = resolve(HERE, "../../../golden/upload-truth/txt")
const REPORT_DIR = resolve(HERE, "../../../.scratch/upload-truth")
const REPORT_PATH = join(REPORT_DIR, "ut01-txt-reproduction.json")

interface TruthSample {
  id: string
  file: string
  encoding: string
  bom: boolean
  lineEnding: string
  fileSha256: string
  truthSha256: string
  truthText: string
  decodeExpectation: string
  mustPreserve: string[]
}

interface TruthManifest {
  manifestVersion: string
  annotationMethod: string
  allowedDecodeTransforms: string[]
  samples: TruthSample[]
}

const manifest = JSON.parse(
  readFileSync(join(TRUTH_DIR, "truth-manifest.json"), "utf8")
) as TruthManifest

const sha256 = (value: string | Buffer, encoding: "utf8" = "utf8") =>
  createHash("sha256")
    .update(typeof value === "string" ? Buffer.from(value, encoding) : value)
    .digest("hex")

// 报告对象由本文件内多个测试共同填充，最后一个测试落盘。
const report: {
  ticket: string
  generatedAt: string | null
  annotationMethod: string
  disclaimer: string
  environment: Record<string, unknown>
  routeControl: Record<string, unknown>
  overrideReproduction: Record<string, unknown>
  samples: Array<Record<string, unknown>>
} = {
  ticket: "UT-01",
  generatedAt: null,
  annotationMethod: manifest.annotationMethod,
  disclaimer:
    "本报告是选定设计样本在当前工作树上的观测记录，不是生产成功率、" +
    "修复后成绩或可行性概率。真实正文不发送 Jev。",
  environment: {},
  routeControl: {},
  overrideReproduction: {},
  samples: [],
}

test("UT-01 真值清单完整性：样本字节与设计真值哈希一致", () => {
  assert.equal(manifest.manifestVersion, "ut01-txt-truth-v1")
  assert.equal(manifest.annotationMethod, "designed")
  assert.ok(manifest.samples.length >= 8)
  const seen = new Set<string>()
  for (const sample of manifest.samples) {
    assert.ok(!seen.has(sample.id), `duplicate sample id ${sample.id}`)
    seen.add(sample.id)
    const bytes = readFileSync(join(TRUTH_DIR, sample.file))
    assert.equal(
      sha256(bytes),
      sample.fileSha256,
      `sample ${sample.id} bytes drifted from the registered hash`
    )
    assert.equal(
      sha256(sample.truthText, "utf8"),
      sample.truthSha256,
      `truth text for ${sample.id} drifted from the registered hash`
    )
    assert.ok(sample.truthText.trim().length > 0)
    assert.ok(sample.mustPreserve.length > 0)
    assert.ok(
      ["exact", "exact_modulo_leading_bom", "exact_after_crlf_normalization", "pending_review_allowed"]
        .includes(sample.decodeExpectation)
    )
  }
  // 覆盖面抽查：编码族与行尾族都必须在固定样本内。
  const encodings = new Set(manifest.samples.map((sample) => sample.encoding))
  for (const required of ["utf-8", "utf-16le", "utf-16be", "gbk"]) {
    assert.ok(encodings.has(required), `missing required encoding family ${required}`)
  }
  const lineEndings = new Set(manifest.samples.map((sample) => sample.lineEnding))
  for (const required of ["lf", "crlf"]) {
    assert.ok(lineEndings.has(required), `missing required line-ending family ${required}`)
  }
})

test("UT-01 比较规则：精确匹配与允许的解码变换", () => {
  const truth = "订单编号：A-2026-1004\n不支持退款。\n"
  assert.equal(compareTextToTruth(truth, truth).verdict, "match")
  // CRLF→LF 是允许变换：verdict match 且不允许的发现为零。
  const crlf = compareTextToTruth(truth, "订单编号：A-2026-1004\r\n不支持退款。\r\n")
  assert.equal(crlf.verdict, "match")
  assert.equal(crlf.findings.length, 0)
  // 前导 BOM：显式允许时记录为 allowed whitespace 发现，仍然 match。
  const bomAllowed = compareTextToTruth(truth, "\uFEFF订单编号：A-2026-1004\n不支持退款。\n", { allowLeadingBom: true })
  assert.equal(bomAllowed.verdict, "match")
  assert.ok(bomAllowed.findings.some((f) => f.allowed))
  // 同一 BOM 在清洗边界（不允许 BOM）必须算差异。
  const bomDisallowed = compareTextToTruth(truth, "\uFEFF订单编号：A-2026-1004\n不支持退款。\n")
  assert.equal(bomDisallowed.verdict, "loss")
})

test("UT-01 比较规则：绝不以删除全部空白掩盖损失", () => {
  const truth = "步骤一：登录账户\n    retry_limit = 3\n"
  // 全部行首缩进被剥掉（内部间距不变）：内容签名相同，但比较必须仍然判 loss。
  const stripped = compareTextToTruth(truth, "步骤一：登录账户\nretry_limit = 3\n")
  assert.equal(stripped.verdict, "loss")
  assert.ok(stripped.findings.some((f) => f.kind === "whitespace"))
  // 仅缩进丢失：内容相同，verdict 仍是 loss。
  const indentLost = compareTextToTruth(truth, "步骤一：登录账户\nretry_limit = 3\n")
  assert.equal(indentLost.verdict, "loss")
  assert.ok(indentLost.findings.some((f) => f.kind === "whitespace" && f.detail.includes("leading whitespace")))
})

test("UT-01 比较规则：数值、否定、顺序与有效重复损失必须被判为 content loss", () => {
  const truth = "订单编号：A-2026-1004\n不支持七天无理由退款。\n步骤一\n步骤二\n步骤三\n同一行内容原样重复\n同一行内容原样重复\n同一行内容原样重复\n"
  // 数值改变
  const numberChanged = compareTextToTruth(truth, "订单编号：A-2026-9999\n不支持七天无理由退款。\n步骤一\n步骤二\n步骤三\n同一行内容原样重复\n同一行内容原样重复\n同一行内容原样重复\n")
  assert.equal(numberChanged.verdict, "loss")
  assert.ok(numberChanged.findings.some((f) => f.kind === "content" && f.detail.includes("A-2026-1004")))
  // 否定丢失（"不"字被吞）
  const negation = compareTextToTruth(
    truth,
    "订单编号：A-2026-1004\n支持七天无理由退款。\n步骤一\n步骤二\n步骤三\n同一行内容原样重复\n同一行内容原样重复\n同一行内容原样重复\n"
  )
  assert.equal(negation.verdict, "loss")
  assert.ok(negation.findings.some((f) => f.kind === "content"))
  // 顺序交换（LCS 无法精确配对被换的行）
  const reordered = compareTextToTruth(
    truth,
    "订单编号：A-2026-1004\n不支持七天无理由退款。\n步骤二\n步骤一\n步骤三\n同一行内容原样重复\n同一行内容原样重复\n同一行内容原样重复\n"
  )
  assert.equal(reordered.verdict, "loss")
  assert.ok(reordered.findings.some((f) => f.kind === "content"))
  // 有效重复减少（三次变两次）
  const repetitionLost = compareTextToTruth(
    truth,
    "订单编号：A-2026-1004\n不支持七天无理由退款。\n步骤一\n步骤二\n步骤三\n同一行内容原样重复\n同一行内容原样重复\n"
  )
  assert.equal(repetitionLost.verdict, "loss")
  assert.ok(repetitionLost.findings.some((f) => f.kind === "content"))
})

test("UT-01 比较规则：U+FFFD 与 NUL 判 corrupt（模糊编码 → 待校验类）", () => {
  const truth = "旧编码真值样本\n"
  const corrupt = compareTextToTruth(truth, "旧编码真值样本\uFFFD\n")
  assert.equal(corrupt.verdict, "corrupt")
  const nul = compareTextToTruth(truth, "旧编码真值样本\n\0")
  assert.equal(nul.verdict, "corrupt")
})

test("UT-01 比较规则：切块覆盖按词元判定缺口且能发现伪造内容", () => {
  const truth = "订单编号：A-2026-1004\n不支持七天无理由退款。\n结尾校验词：终线-42\n"
  // 覆盖：chunks 重排/合并空白不产生缺口。
  const covered = checkChunkCoverage(truth, ["不支持七天无理由退款。", "订单编号：A-2026-1004 结尾校验词：终线-42"])
  assert.equal(covered.verdict, "match")
  assert.equal(covered.coveredTruthLines, 3)
  // 缺口：一条真值内容完全缺失。
  const missing = checkChunkCoverage(truth, ["订单编号：A-2026-1004", "结尾校验词：终线-42"])
  assert.equal(missing.verdict, "loss")
  assert.ok(missing.missingTokenSamples.length > 0)
  // 伪造：chunk 出现真值中不存在的词元（CJK 按字切分）。
  const fabricated = checkChunkCoverage(truth, [truth, "凭空捏造的句子"])
  assert.equal(fabricated.verdict, "loss")
  assert.ok(fabricated.fabricatedTokenSamples.length > 0)
  for (const character of "凭空捏造的句子") {
    assert.ok(fabricated.fabricatedTokenSamples.includes(character))
  }
  // 词元器：拉丁/数字连续段为词级 token（标点为分隔，与 eval-text-v1 同构）+ CJK 字级。
  assert.deepEqual(tokenizeForCoverage("A-2026 不支持"), ["a", "2026", "不", "支", "持"])
})

test("UT-01 路由对照：无 override 的 TXT 按类型匹配路由", () => {
  const route = selectParserRoute({ fileName: "样本.txt", mimeType: "text/plain" })
  // UT-10 更新：TXT 的类型匹配路径改为保真 direct-txt（进程内解码），
  // 不再经 markitdown CLI——CLI 在提取边界剥行尾空格、清洗边界解释字面语法。
  assert.deepEqual(route.candidates, ["direct-txt"])
  assert.equal(route.authoritative, false)
  report.routeControl = {
    txtNoOverride: { candidates: route.candidates, authoritative: route.authoritative },
  }
})

test("UT-01 缺陷复现：TXT 携带 PDF 专用 override 被原样接受且只路由到 override", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-ut01-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")
  const eventsSource = async function* () {}
  const server = createApp({
    eventsSource,
    ingestAccessMiddleware: (_req, res, next) => {
      res.locals.accessContext = {
        tenantId: "tenant-a",
        subjectId: "truth-user",
        groups: ["support"],
        scopes: ["ingest"],
      }
      next()
    },
  }).listen(0)
  try {
    await new Promise<void>((resolveListen) => server.once("listening", resolveListen))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const body = Buffer.from("退货政策真值样本：override 污染复现。\n", "utf8")
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/file`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": "override-pollution.txt",
        "x-file-mime-type": "text/plain",
        "x-parser": "marker",
      },
      body,
    })
    // 当前行为：admission 不区分文件类型，PDF 专用 override 被持久化。
    assert.equal(response.status, 200)
    const submitted = await response.json() as { docId: string; status: string }
    assert.equal(submitted.status, "pending")
    const document = new DocumentRepo(openDb()).get(submitted.docId)
    assert.equal(document?.parserOverride, "marker")
    assert.equal(document?.fileName, "override-pollution.txt")
    assert.deepEqual(document?.rawContent, body)

    // UT-06 已修复该缺陷：override 仍被持久化（原意图保留），但路由归一到
    // 类型匹配的文本路径——不再被 PDF 专用解析器劫持。
    assert.equal(document?.parserOverride, "marker")
    assert.equal(document?.fileName, "override-pollution.txt")
    assert.deepEqual(document?.rawContent, body)

    const normalizedRoute = selectParserRoute({
      fileName: "override-pollution.txt",
      mimeType: "text/plain",
      override: "marker",
    })
    // UT-10 更新：类型匹配的文本路径是 direct-txt。
    assert.deepEqual(normalizedRoute.candidates, ["direct-txt"])
    assert.equal(normalizedRoute.authoritative, false)
    assert.match(normalizedRoute.reason, /marker/, "调整原因保留原 override 意图")
    report.overrideReproduction = {
      admission: "accepted-with-override",
      persistedParserOverride: document?.parserOverride,
      routeCandidates: normalizedRoute.candidates,
      authoritative: normalizedRoute.authoritative,
      adjustmentReason: normalizedRoute.reason,
      note:
        "UT-06 修复：PDF 专用 override 在 TXT 上归一到类型匹配路径并记录原意图。" +
        "UT-01 首次记录时该路由缺陷为 candidates=[marker] authoritative=true，" +
        "marker 缺失导致 TXT 以 2s/4s/8s 重试后 dead-letter。",
    }
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("UT-01 特征记录：真实 markitdown 逐边界对比设计真值并落盘报告", async () => {
  const config = loadConfig()
  const markitdown = new MarkItDownParser({
    command: config.markitdownCommand ?? "markitdown",
    timeoutMs: config.parserTimeoutMs ?? 120_000,
    inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
    outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
  })
  const marker = new MarkerParser({
    command: config.markerCommand ?? "marker_single",
    timeoutMs: config.parserTimeoutMs ?? 120_000,
    inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
    outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
  })

  const markitdownAvailable = await probeParser(() =>
    markitdown.parseRaw({ content: Buffer.from("probe", "utf8"), fileName: "probe.txt" }))
  const markerAvailable = await probeParser(() =>
    marker.parse({ content: Buffer.from("probe", "utf8"), fileName: "probe.txt", documentId: "probe" }))
  report.environment = {
    markitdown: {
      command: config.markitdownCommand ?? "markitdown",
      available: markitdownAvailable,
    },
    marker: { command: config.markerCommand ?? "marker_single", available: markerAvailable },
  }

  if (!markitdownAvailable) {
    // 能力缺失必须如实登记，不得伪造测量结果。
    for (const sample of manifest.samples) {
      report.samples.push({
        id: sample.id,
        extraction: { status: "capability_missing" },
        cleaning: { status: "not_run" },
        chunkCoverage: { status: "not_run" },
      })
    }
    writeReport()
    return
  }

  const chunker = new RecursiveChunker()
  for (const sample of manifest.samples) {
    const bytes = readFileSync(join(TRUTH_DIR, sample.file))
    const entry: Record<string, unknown> = { id: sample.id, encoding: sample.encoding }
    let raw: string | null = null
    try {
      raw = await markitdown.parseRaw({
        content: bytes,
        fileName: sample.file,
        mimeType: "text/plain",
      })
      const extraction = compareTextToTruth(sample.truthText, raw, { allowLeadingBom: true })
      entry.extraction = { status: "measured", verdict: extraction.verdict, findings: extraction.findings }
    } catch (error) {
      entry.extraction = {
        status: "parse_failed",
        error: error instanceof Error ? error.message : String(error),
      }
    }

    if (raw !== null) {
      try {
        const blocks = normalizeMarkItDown(raw, sample.id)
        const joined = blocks.map((block) => block.text).join("\n\n")
        const cleaning = compareTransformedText(raw, joined)
        entry.cleaning = { status: "measured", verdict: cleaning.verdict, findings: cleaning.findings }
        const chunks = await chunker.chunk(chunkerDocument(sample.id, joined), blocks)
        const childTexts = chunks
          .filter((chunk) => chunk.metadata.kind !== "parent")
          .map((chunk) => chunk.content)
        const coverage = checkChunkCoverage(sample.truthText, childTexts)
        entry.chunkCoverage = {
          status: "measured",
          verdict: coverage.verdict,
          missingTokenSamples: coverage.missingTokenSamples,
          fabricatedTokenSamples: coverage.fabricatedTokenSamples,
          coveredTruthLines: coverage.coveredTruthLines,
          totalTruthLines: coverage.totalTruthLines,
        }
      } catch (error) {
        entry.cleaning = {
          status: "normalize_failed",
          error: error instanceof Error ? error.message : String(error),
        }
        entry.chunkCoverage = { status: "not_run" }
      }
    } else {
      entry.cleaning = { status: "not_run" }
      entry.chunkCoverage = { status: "not_run" }
    }
    report.samples.push(entry)
  }

  writeReport()
  assert.equal(report.samples.length, manifest.samples.length)

  const byId = new Map(report.samples.map((entry) => [entry.id, entry]))

  // —— 当前行为的确定性特征（修复后由对应票更新这些断言）——
  // 1) markitdown 对本样本族能正确解码（BOM/UTF-16/GBK 检测在工作树上有效）。
  for (const id of ["utf8-baseline", "utf8-bom", "utf16le-bom", "utf16be-bom", "legacy-gbk", "long-paragraph"]) {
    const extraction = byId.get(id)?.extraction as { status: string; verdict?: string }
    assert.equal(extraction.status, "measured", `${id} extraction not measured`)
    assert.equal(extraction.verdict, "match", `${id} extraction verdict drifted: ${JSON.stringify(extraction)}`)
  }
  // 2) markitdown 输出剥掉行尾空格：crlf-indent 在提取边界即出现空白损失。
  const crlfExtraction = byId.get("crlf-indent")?.extraction as { status: string; verdict?: string; findings?: Array<{ kind: string; detail: string }> }
  assert.equal(crlfExtraction.status, "measured")
  assert.equal(crlfExtraction.verdict, "loss")
  assert.ok(crlfExtraction.findings?.some((f) => f.kind === "whitespace"))
  // 3) 清洗边界：normalizeMarkItDown 丢掉字面 `#` 记号（设计好的损失样本），
  //    且基线样本的缩进在清洗边界丢失（逐行 trim）——但内容不丢。
  const literalCleaning = byId.get("literal-markdown")?.cleaning as { status: string; verdict?: string; findings?: Array<{ kind: string; detail: string }> }
  assert.equal(literalCleaning.status, "measured")
  assert.equal(literalCleaning.verdict, "loss")
  assert.ok(literalCleaning.findings?.some((f) => f.kind === "content" && f.detail.includes("missing truth line 1")))
  const baselineCleaning = byId.get("utf8-baseline")?.cleaning as { status: string; verdict?: string; findings?: Array<{ kind: string }> }
  assert.equal(baselineCleaning.status, "measured")
  assert.equal(baselineCleaning.verdict, "loss")
  assert.ok(baselineCleaning.findings?.every((f) => f.kind === "whitespace"))
  // 4) 切块边界：当前 chunker 对全部样本不丢词元、不伪造词元。
  for (const entry of report.samples) {
    const coverage = entry.chunkCoverage as { status: string; verdict?: string }
    assert.equal(coverage.status, "measured", `${entry.id} coverage not measured`)
    assert.equal(coverage.verdict, "match", `${entry.id} chunk coverage drifted`)
  }
})

function chunkerDocument(id: string, content: string): Document {
  return {
    id,
    sourceId: `truth-${id}`,
    contentHash: "truth",
    version: 1,
    title: id,
    source: "truth-harness",
    content,
    metadata: {},
    createdAt: new Date(),
  }
}

async function probeParser(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    await operation()
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("executable is unavailable")) return false
    // 任何其它错误说明执行器存在但拒绝 probe 输入——能力存在。
    return true
  }
}

function writeReport(): void {
  report.generatedAt = new Date().toISOString()
  mkdirSync(REPORT_DIR, { recursive: true })
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n")
}
