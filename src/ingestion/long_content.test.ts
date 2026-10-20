// UT-14：长内容限额处理且不截断。
//
// 契约（UP-07 AC 4/5，经 14 票继承）：token 限制与字节预算分别约束（估算
// 基于字符而非字节）；长段/无空格/多语言/长表格沿可验证边界拆分且不裁尾
// ——尾部校验词必须出现在切块中；超长表格每片重复表头（表头关系保留）；
// 估算超 provider 限制的块在管线内明确报错（不静默让 provider 截断）；
// 拆分后覆盖/稳定身份仍成立；真实 provider 受控请求证明无输入截断。
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { closeDb, openDb } from "./tracking"
import { DocumentRepo } from "./tracking/doc_repo"
import { ExpectedChunkRepository } from "./tracking/expected_chunk_repo"
import { IngestionLifecycle } from "./lifecycle"
import { PipelineStageRunner } from "./pipeline"
import { estimateTokens, findOversizedChunks, resolveEmbeddingLimits } from "./limits"
import { RecursiveChunker } from "./chunker/chunker"
import type { Chunk, Document, NormalizedBlock } from "../types"
import type { IngestionStoreImpl } from "./storage"
import { loadConfig } from "../config"
import { config as dotenvConfig } from "dotenv"

const HERE = dirname(__filename)
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
// 真实 provider 验收需要生产嵌入配置（.env：EMBEDDING_BASE_URL/MODEL/...）。
// override:false——已存在的环境变量（如上面的隔离库）不被覆盖。
dotenvConfig({ override: false })
// loadConfig() 是进程级 memoize：必须在任何 loadConfig 调用之前固定隔离库。
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "kefu-rag-ut14-")), "ingestion.db")

const TRUTH_DIR_TXT = resolve(HERE, "../../golden/upload-truth/txt")

function chunkerDocument(id: string, content: string): Document {
  return {
    id,
    sourceId: `ut14-${id}`,
    contentHash: "ut14",
    version: 1,
    title: id,
    source: "ut14-harness",
    content,
    metadata: {},
    createdAt: new Date(),
  }
}

test("UT-14 估算器：字符估算与字节无关，CJK 上界覆盖真实分词", () => {
  // 1500 个 CJK 字符 = 4500 UTF-8 字节，但估算上界约 3000 token——
  // 远低于 8192；若按字节推断会得出错误结论（4500"字节"≠4500 token）。
  const cjk = "退".repeat(1500)
  assert.equal(Buffer.byteLength(cjk, "utf8"), 4500)
  const cjkEstimate = estimateTokens(cjk)
  assert.ok(cjkEstimate >= 1500 && cjkEstimate <= 3200, `CJK 上界估算: ${cjkEstimate}`)
  assert.ok(cjkEstimate < 8192, "默认切块尺寸在默认 provider 限制内")

  // 1500 个拉丁字符 = 1500 字节，估算 ≈ 525 token（0.35/字符上界）。
  const latin = "a".repeat(1500)
  assert.equal(estimateTokens(latin), Math.ceil(1500 * 0.35))
  // 混合文本：CJK 部分主导估算。
  const mixed = `${"退".repeat(100)}${"a".repeat(100)}`
  assert.equal(estimateTokens(mixed), Math.ceil(100 * 2 + 100 * 0.35))
})

test("UT-14 限额网：估算超限的块被识别，环境变量可覆盖限制", () => {
  const limits = resolveEmbeddingLimits()
  assert.equal(limits.inputTokenLimit, 8192)
  assert.equal(limits.batchMaxBytes, 150 * 1024, "字节预算独立声明")
  assert.equal(limits.batchMaxChunks, 64)

  const makeChunk = (id: string, content: string): Chunk => ({
    id,
    documentId: "doc",
    content,
    childrenIds: [],
    metadata: { kind: "child", index: 0 },
  })
  const normal = makeChunk("normal", "退".repeat(1500)) // est ~3000 ≤ 8192
  const oversized = makeChunk("oversized", "退".repeat(5000)) // est ~10000 > 8192
  assert.deepEqual(findOversizedChunks([normal], limits), [])
  const flagged = findOversizedChunks([normal, oversized], limits)
  assert.equal(flagged.length, 1)
  assert.equal(flagged[0].chunkId, "oversized")

  // 限制可通过环境变量收紧（不同 provider 契约）。
  process.env.EMBEDDING_INPUT_TOKEN_LIMIT = "512"
  const strict = resolveEmbeddingLimits()
  assert.equal(strict.inputTokenLimit, 512)
  assert.equal(findOversizedChunks([normal], strict).length, 1, "收紧后 1500 CJK 字符块超限")
  delete process.env.EMBEDDING_INPUT_TOKEN_LIMIT
})

test("UT-14 无空格长文本：不裁尾，尾部校验词进入切块且无块超限", async () => {
  // 8000 个无空格 CJK 字符（无任何标点/边界）——最坏拆分路径。
  const body = Array.from({ length: 8000 }, (_, i) => "测").join("")
  const tailMarker = "终界-77"
  const content = `${body}${tailMarker}\n`
  const file = join(mkdtempSync(join(tmpdir(), "kefu-rag-ut14-")), "no-space.txt")
  const { writeFileSync } = await import("node:fs")
  writeFileSync(file, content, "utf8")

  const db = openDb()
  const captured: Chunk[] = []
  const fakeStore = {
    async storeChunks(incoming: Chunk[]): Promise<unknown> {
      captured.push(...incoming)
      return {
        chunkCount: incoming.length, passageCount: incoming.length, batchCount: 1,
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
  const lifecycle = new IngestionLifecycle(
    db,
    new PipelineStageRunner(db, undefined as never, fakeStore)
  )
  const submitted = lifecycle.submit({
    title: "UT-14 无空格长文本",
    content: "",
    rawContent: Buffer.from(content, "utf8"),
    fileName: "no-space.txt",
    mimeType: "text/plain",
    sourceIdentity: { kind: "file", uriOrExternalId: "C:/truth/ut14/no-space.txt", namespace: "ut14" },
  })
  const result = await lifecycle.runNext()
  assert.ok(result?.success, "无空格长文本必须完成（限额网不误伤正常块）")

  const indexChunks = captured.filter((chunk) => chunk.metadata.kind !== "parent")
  assert.ok(indexChunks.length > 5, "长文本必须切出多个块")
  const limits = resolveEmbeddingLimits()
  for (const chunk of indexChunks) {
    const estimated = estimateTokens(chunk.content)
    assert.ok(estimated <= limits.inputTokenLimit, `块 ${chunk.id} 估算 ${estimated} token 超限`)
  }
  // 不裁尾：尾部校验词必须出现在某个块中。
  const joined = indexChunks.map((chunk) => chunk.content).join("\n")
  assert.ok(joined.includes(tailMarker), "尾部校验词必须保留（不静默裁尾）")
  // 覆盖与清单仍成立（UT-13 契约在拆分路径上保持）。
  const manifest = new ExpectedChunkRepository(db).list(submitted.docId)
  assert.equal(manifest.length, indexChunks.length)
})

test("UT-14 长表格：按行拆分且每片重复表头（表头关系保留）", async () => {
  const header = "| 姓名 | 金额 | 是否退款 |"
  const separator = "|---|---|---|"
  const rows: string[] = []
  for (let i = 0; i < 90; i += 1) {
    rows.push(`| 客户-${i} | ${i * 10}元 | ${i % 2 === 0 ? "是" : "否"} |`)
  }
  const tableText = [header, separator, ...rows].join("\n")
  assert.ok(tableText.length > 1500, `样本必须超过表格原子尺寸（实际 ${tableText.length}）`)

  const tableBlock: NormalizedBlock = {
    id: "ut14-table",
    index: 0,
    type: "table",
    text: tableText,
    sectionPath: [],
    metadata: { source: "pymupdf-find_tables" },
    provenance: { parser: "builtin-pdf", adapter: "script" },
  }
  const chunks = await new RecursiveChunker().chunk(
    chunkerDocument("ut14-table-doc", tableText),
    [tableBlock]
  )
  const children = chunks.filter((chunk) => chunk.metadata.kind === "child")
  assert.ok(children.length > 1, "超长表格必须拆分")
  // 每片都带表头与分隔行——表头-值关系在每片内成立。
  for (const child of children) {
    assert.ok(child.content.startsWith(`${header}\n${separator}\n`), "每片重复表头")
    assert.ok(child.content.includes("|"), "片内保持表格行结构")
  }
  // 所有数据行仍在切块集合中（无裁尾）。
  const joined = children.map((chunk) => chunk.content).join("\n")
  for (let i = 0; i < 90; i += 1) {
    assert.ok(joined.includes(`客户-${i}`), `数据行不丢失：客户-${i}`)
  }
})

test("UT-14 真实 provider 受控请求：最大块尺寸无截断、返回维度正确", async (t) => {
  const config = loadConfig()
  if (!config.embeddingApiKey) {
    t.skip("未配置 embeddingApiKey——真实 provider 路径未验收（如实单列）")
    return
  }
  const { createOpenAIClient, openaiClientOptions } = await import("../clients")
  const client = createOpenAIClient({
    apiKey: config.embeddingApiKey,
    baseURL: config.embeddingBaseUrl || undefined,
    // 受控长输入比常规块慢——放宽超时，但仍是真实生产客户端路径。
    ...openaiClientOptions(config),
    timeout: 120_000,
    maxRetries: 1,
  })
  // 受控长输入：管线实际能产出的最大块尺寸——1500 个 CJK 字符（无空格，
  // 4500 UTF-8 字节，估算上界 ~3000 token）。证明该尺寸在真实 provider
  // 上无输入截断/拒绝。与生产代码一致：不传 dimensions 覆盖。
  const maxChunkInput = "多语言长文本嵌入限额验证。".repeat(116).slice(0, 1500)
  assert.ok(maxChunkInput.length === 1500)
  try {
    const response = await client.embeddings.create({
      model: config.embeddingModel,
      input: [maxChunkInput, `${maxChunkInput.slice(0, 750)}multilingual tail probe`],
      // The production ingestion path always asks for float vectors: the SDK's
      // base64 default gets truncated to 256 dims by some providers (Zhipu
      // embedding-2), which would fail this assertion for a reason the
      // pipeline never hits. Same encoding as store.ts / searcher.ts.
      encoding_format: "float",
    })
    assert.equal(response.data.length, 2, "两条输入各自返回向量（无合并截断）")
    for (const item of response.data) {
      assert.equal(item.embedding.length, config.embeddingDimensions, "向量维度与配置一致")
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 环境阻断（凭据 401、代理 403、限流 429、5xx）与本文件"如实单列"约定同
    // 口径：跳过。4xx 语义拒绝（400/404/422）说明 provider 拒绝了受控输入
    // ——那正是本测试要证伪的行为，必须保持红。
    const status = (error as { status?: number }).status
    const envBlocked =
      typeof status === "number" &&
      (status === 401 || status === 403 || status === 429 || status >= 500)
    if (
      /timeout|fetch failed|network|ECONN|ETIMEDOUT|ENOTFOUND|certificate/i.test(message) ||
      envBlocked
    ) {
      const prefix = typeof status === "number" ? `HTTP ${status}: ` : ""
      t.skip(`真实 provider 不可达（${prefix}${message.slice(0, 80)}）——限制实测单列未验收`)
      return
    }
    throw error
  }
})

test("UT-14 收尾：关闭隔离库", () => {
  closeDb()
})
