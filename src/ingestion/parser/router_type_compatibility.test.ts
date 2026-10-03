// UT-06：类型匹配与 PDF 参数隔离。
//
// 契约（UP-02 AC 1/2/4/5）：TXT（无论是否携带历史客户端发来的 PDF 专用
// override）都走兼容文本路径；实际策略、原意图与调整原因可从持久化的
// parser metadata 核对；PDF 与其他既有格式维持正确路由；未知类型不盲目
// 声明兼容。AC 4 要求先复现误路由再以"真实上传到解析选择"验证修复，
// 不能只用字符串单测证明。
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { loadConfig } from "../../config"
import { closeDb, openDb } from "../tracking"
import { DocumentRepo } from "../tracking/doc_repo"
import { IngestionLifecycle } from "../lifecycle"
import { PipelineStageRunner } from "../pipeline"
import {
  BuiltinPdfParser,
  DirectTextParser,
  MarkItDownParser,
  MarkerParser,
  selectParserRoute,
} from "../parser"
import type { IngestionStoreImpl } from "../storage"

test("UT-06 路由：TXT 携带 PDF 专用 override 归一到文本路径且记录原意图", () => {
  for (const override of ["marker", "builtin-pdf", "mineru"] as const) {
    const route = selectParserRoute({ fileName: "样本.txt", mimeType: "text/plain", override })
    // UT-10：类型匹配的文本路径由 markitdown 换为保真 direct-txt（进程内
    // 解码）；override 归一语义不变，原意图仍记录在 reason。
    assert.deepEqual(route.candidates, ["direct-txt"], override)
    assert.equal(route.authoritative, false, override)
    assert.match(route.reason, new RegExp(override), "调整原因必须保留原 override")
    assert.match(route.reason, /not compatible with text files/)
  }
})

test("UT-06 路由：类型兼容的 override 保持权威单候选，既有格式不受影响", () => {
  // PDF 上显式选择 PDF 类解析器 → 权威。
  const markerOnPdf = selectParserRoute({ fileName: "a.pdf", mimeType: "application/pdf", override: "marker" })
  assert.deepEqual(markerOnPdf.candidates, ["marker"])
  assert.equal(markerOnPdf.authoritative, true)
  // mineru 同样支持 PDF（OCR 提取器）→ 权威保持既有行为。
  const mineruOnPdf = selectParserRoute({ fileName: "scan.pdf", override: "mineru" })
  assert.deepEqual(mineruOnPdf.candidates, ["mineru"])
  assert.equal(mineruOnPdf.authoritative, true)
  // markitdown 是通用文本转换器：显式选择简单 PDF 的 markitdown 合法。
  const markitdownOnPdf = selectParserRoute({ fileName: "simple.pdf", mimeType: "application/pdf", override: "markitdown" })
  assert.deepEqual(markitdownOnPdf.candidates, ["markitdown"])
  assert.equal(markitdownOnPdf.authoritative, true)

  // 无 override 的自动路由回归：PDF / 图片 / 文本 / Markdown / CSV。
  assert.deepEqual(selectParserRoute({ fileName: "a.pdf" }).candidates, ["marker", "builtin-pdf"])
  assert.deepEqual(selectParserRoute({ fileName: "a.png" }).candidates, ["mineru"])
  // UT-10：.txt / text/plain 走保真 direct-txt；结构化文本（md/csv）不变。
  assert.deepEqual(selectParserRoute({ fileName: "a.txt" }).candidates, ["direct-txt"])
  assert.deepEqual(selectParserRoute({ fileName: "notes.md" }).candidates, ["markitdown"])
  assert.deepEqual(selectParserRoute({ fileName: "table.csv", mimeType: "text/csv" }).candidates, ["markitdown"])

  // 图片上选择文本/PDF 解析器 → 归一到 OCR 路径。
  const markerOnPng = selectParserRoute({ fileName: "scan.png", override: "marker" })
  assert.deepEqual(markerOnPng.candidates, ["mineru"])
  assert.match(markerOnPng.reason, /marker/)

  // 无法确认的类型不得盲目声明兼容。
  assert.throws(
    () => selectParserRoute({ fileName: "mystery.qqq", override: "marker" }),
    /Cannot confirm type compatibility/
  )
})

test("UT-06 真实上传到解析选择：TXT + 历史 PDF override 实际用 markitdown 解析成功", async () => {
  // AC 4：不经 HTTP 字符串断言，而是把真实字节经 lifecycle → pipeline →
  // 真实 markitdown 跑完 chunk 阶段，核对持久化的 parser metadata。
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "kefu-rag-ut06-")), "routing.db")
  const config = loadConfig()
  const db = openDb()
  try {
    const storedChunks: Array<{ documentId: string; content: string }> = []
    const fakeStore = {
      async storeChunks(chunks: Array<{ documentId: string; content: string }>) {
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

    const resolveParser = (type: string) => {
      if (type === "direct-txt") {
        // UT-10：TXT 的类型匹配路径是进程内保真解码。
        return new DirectTextParser()
      }
      if (type === "builtin-pdf") {
        return new BuiltinPdfParser({
          command: config.pythonCommand || "python",
          timeoutMs: config.parserTimeoutMs ?? 120_000,
          inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
          outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
        })
      }
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
    const lifecycle = new IngestionLifecycle(
      db,
      new PipelineStageRunner(db, resolveParser as never, fakeStore)
    )

    // 历史客户端场景：TXT 携带 PDF 专用 override（UT-01 复现的缺陷输入）。
    const submitted = lifecycle.submit({
      title: "路由修复复现",
      content: "",
      rawContent: Buffer.from("路由修复复现：TXT 内容原样进入文本路径。校验词 路由-42。", "utf8"),
      fileName: "misroute-repro.txt",
      mimeType: "text/plain",
      parserOverride: "marker",
      sourceIdentity: { kind: "file", uriOrExternalId: "C:/truth/misroute.txt", namespace: "ut06" },
    })
    assert.equal(submitted.status, "pending")
    const result = await lifecycle.runNext()
    assert.equal(result?.success, true, "归一后 TXT 必须经保真文本路径成功解析（marker 缺失不再拖垮 TXT）")

    const document = new DocumentRepo(db).get(submitted.docId)
    assert.ok(document)
    const parserMetadata = (document.metadata as { system?: { parser?: { selected?: string; reason?: string } } }).system?.parser
    // UT-10：TXT 的类型匹配路径是 direct-txt（保真解码），不再是 markitdown。
    assert.equal(parserMetadata?.selected, "direct-txt", "实际策略记录在持久 metadata")
    assert.match(parserMetadata?.reason ?? "", /marker/, "原意图（marker override）保留在原因里")
    assert.match(parserMetadata?.reason ?? "", /not compatible with text files/, "调整原因可核对")

    const joined = storedChunks.filter((chunk) => chunk.documentId === submitted.docId)
      .map((chunk) => chunk.content).join("\n")
    assert.ok(joined.includes("路由-42"), "TXT 内容真实进入切块")
  } finally {
    closeDb()
  }
})
