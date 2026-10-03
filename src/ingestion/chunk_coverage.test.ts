// UT-13：来源切块覆盖与关系保持。
//
// 契约（UP-07 AC 1/2/3/5，经 13 票继承）：摄取落库"期望检索清单"（每个
// 入索引块的稳定身份、内容哈希与覆盖的来源块），同输入/配置重推导出相同
// 身份与哈希（以持久清单核对，不是内部清单自比）；块覆盖按唯一块 id 判定
// ——重叠/continuation 复用同一块 id，不制造虚假覆盖；无覆盖缺口（有缺口
// 即管线硬失败）；上游（提取层）已有缺口时，即使清洗文本覆盖率 100%，
// 全文结论仍为待校验——下游不能补证上游真值。
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { closeDb, openDb } from "./tracking"
import { DocumentRepo } from "./tracking/doc_repo"
import {
  ExpectedChunkRepository,
  type ExpectedChunkEntry,
} from "./tracking/expected_chunk_repo"
import { ExtractionEvidenceRepository } from "./tracking/extraction_evidence_repo"
import { IngestionLifecycle } from "./lifecycle"
import { PipelineStageRunner } from "./pipeline"
import { evaluateBlockCoverage, evaluateFullDocumentCoverage } from "./chunk_coverage"
import { BuiltinPdfParser, DirectTextParser } from "./parser"
import { RecursiveChunker } from "./chunker/chunker"
import type { Chunk, Document } from "../types"
import type { IngestionStoreImpl } from "./storage"
import { loadConfig } from "../config"

const HERE = dirname(__filename)
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
// loadConfig() 是进程级 memoize：必须在任何 loadConfig 调用之前固定隔离库。
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "kefu-rag-ut13-")), "ingestion.db")

const TRUTH_DIR_TXT = resolve(HERE, "../../golden/upload-truth/txt")
const TRUTH_DIR_PDF = resolve(HERE, "../../golden/upload-truth/pdf")

interface Harness {
  ingest(file: string, dir: string): Promise<{
    docId: string
    chunks: Chunk[]
    system: Record<string, unknown>
  }>
}

function makeHarness(): Harness {
  return {
    async ingest(file, dir) {
      const db = openDb()
      const chunks: Chunk[] = []
      const fakeStore = {
        async storeChunks(incoming: Chunk[]): Promise<unknown> {
          chunks.push(...incoming)
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
        title: `UT-13 ${file}`,
        content: "",
        rawContent: readFileSync(join(dir, file)),
        fileName: file,
        mimeType: file.endsWith(".pdf") ? "application/pdf" : "text/plain",
        sourceIdentity: {
          kind: "file",
          uriOrExternalId: `C:/truth/ut13/${file}`,
          namespace: "ut13",
        },
      })
      const result = await lifecycle.runNext()
      assert.ok(result?.success, `${file} 必须完成摄取`)
      const document = new DocumentRepo(db).get(submitted.docId) as Document
      const system = document.metadata.system as Record<string, unknown>
      return { docId: submitted.docId, chunks, system }
    },
  }
}

test("UT-13 a) 期望检索清单持久化：TXT 清单与独立重推导的身份/哈希逐条一致", async () => {
  const harness = makeHarness()
  const { docId, chunks, system } = await harness.ingest("utf8-baseline.txt", TRUTH_DIR_TXT)
  const manifest: ExpectedChunkEntry[] = new ExpectedChunkRepository(openDb()).list(docId)
  assert.ok(manifest.length > 0, "清单必须落库")

  const indexChunks = chunks.filter((chunk) => chunk.metadata.kind !== "parent")
  assert.equal(manifest.length, indexChunks.length, "清单只含入索引块且数量一致")
  for (const [position, entry] of manifest.entries()) {
    assert.equal(entry.position, position, "清单按位置有序")
    assert.ok(entry.blockIds.length > 0, "每个索引块必须声明覆盖的来源块")
  }

  // 独立重推导：同一输入/配置（相同 doc、同一解析器与切块器）→ 相同身份
  // 与哈希。解析器 UT-09 证据行里的 rawExtraction 即解码原输出，清洗路径
  // 以同一实现重放，不读取任何管线内部状态。
  const evidence = new ExtractionEvidenceRepository(openDb()).get(docId)
  assert.ok(evidence)
  const parser = new DirectTextParser()
  const blocks = parser.normalizeRaw(evidence.artifact.rawExtraction, docId)
  const document = new DocumentRepo(openDb()).get(docId) as Document
  const rederived = await new RecursiveChunker().chunk(document, blocks)
  const rederivedIndex = rederived.filter((chunk) => chunk.metadata.kind !== "parent")
  assert.equal(rederivedIndex.length, manifest.length, "重推导入索引块数量一致")
  for (const [position, entry] of manifest.entries()) {
    assert.equal(entry.chunkId, rederivedIndex[position].id, `第 ${position} 块身份稳定`)
    assert.equal(
      entry.contentSha256,
      ExpectedChunkRepository.contentSha256(rederivedIndex[position].content),
      `第 ${position} 块内容哈希稳定`
    )
  }

  // 覆盖判定：全部块被索引块覆盖（唯一块 id，不因切块重叠虚增）。
  const coverage = evaluateBlockCoverage(blocks, rederivedIndex)
  assert.equal(coverage.verdict, "covered", `不得有覆盖缺口：${JSON.stringify(coverage.missingBlockIds)}`)
  assert.equal(coverage.coveredBlocks, blocks.length)
  assert.ok(system.parser, "解析决策已记录")
})

test("UT-13 b) 父子与章节/表格关系可核对；重叠不虚增覆盖", async () => {
  const harness = makeHarness()

  // 表格关系：pure-table 的表头-值关系落在同一个表格块并进入切块。
  const pure = await harness.ingest("pure-table.pdf", TRUTH_DIR_PDF)
  const pureIndexChunks = pure.chunks.filter((chunk) => chunk.metadata.kind !== "parent")
  const tableChunk = pureIndexChunks.find((chunk) =>
    (chunk.metadata.normalizedBlocks as Array<{ type?: string }> | undefined)?.some(
      (block) => block.type === "table"
    )
  )
  assert.ok(tableChunk, "表格块必须进入切块")
  assert.ok(
    tableChunk.metadata.parentId === undefined || typeof tableChunk.parentId === "string",
    "父子关联字段存在"
  )
  for (const value of ["姓名", "张三", "50元", "李四", "30元"]) {
    assert.ok(tableChunk.content.includes(value), `表头-值关系随块进入索引：${value}`)
  }
  const pureCoverage = evaluateBlockCoverage(
    pure.chunks.length > 0 ? await rederivePdfBlocks("pure-table.pdf", pure.docId) : [],
    pureIndexChunks
  )
  assert.equal(pureCoverage.verdict, "covered")

  // 重叠不虚增覆盖：长段落单块被切成多块，唯一块覆盖仍为 1。
  const longDoc = await harness.ingest("long-paragraph.txt", TRUTH_DIR_TXT)
  const longIndexChunks = longDoc.chunks.filter((chunk) => chunk.metadata.kind !== "parent")
  assert.ok(longIndexChunks.length > 1, "长段落必须切出多个索引块")
  const longManifest = new ExpectedChunkRepository(openDb()).list(longDoc.docId)
  const uniqueCoveredBlocks = new Set(longManifest.flatMap((entry) => entry.blockIds))
  assert.equal(uniqueCoveredBlocks.size, 1, "单块多切片：覆盖集合不因重叠/切片虚增")

  // 父子关系：每个 child 的 parentId 指向存在的 parent。
  const parentIds = new Set(
    longDoc.chunks.filter((chunk) => chunk.metadata.kind === "parent").map((chunk) => chunk.id)
  )
  assert.ok(parentIds.size > 0, "存在父块")
  for (const chunk of longIndexChunks) {
    assert.ok(
      chunk.parentId === null || parentIds.has(chunk.parentId ?? ""),
      "child 的 parentId 必须指向真实父块"
    )
  }
})

async function rederivePdfBlocks(file: string, docId: string) {
  const evidence = new ExtractionEvidenceRepository(openDb()).get(docId)
  assert.ok(evidence, `${file} 证据行存在`)
  const config = loadConfig()
  const parser = new BuiltinPdfParser({
    command: config.pythonCommand || "python",
    timeoutMs: config.parserTimeoutMs ?? 120_000,
    inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
    outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
  })
  return parser.normalizeRaw(evidence.artifact.rawExtraction, docId)
}

test("UT-13 c) 上游缺口不被下游补证：清洗文本 100% 覆盖但全文结论待校验", async () => {
  const harness = makeHarness()
  const { docId, chunks, system } = await harness.ingest("mixed-scan.pdf", TRUTH_DIR_PDF)
  const indexChunks = chunks.filter((chunk) => chunk.metadata.kind !== "parent")
  const blocks = await rederivePdfBlocks("mixed-scan.pdf", docId)

  const evidence = new ExtractionEvidenceRepository(openDb()).get(docId)
  assert.ok(evidence)
  const risks = (system.extraction as { risks?: { reviewRequired: boolean; reviewReasons: string[] } })
    ?.risks ?? null

  const verdict = evaluateFullDocumentCoverage({
    extractionEvidence: evidence.artifact,
    risks,
    blocks,
    indexChunks,
  })
  // 清洗文本的切块覆盖是 100%（第 1/3 页内容全部进入切块）……
  assert.equal(verdict.chunkCoverage.verdict, "covered")
  // ……但上游已知第 2 页无文本层 + 结构风险 → 全文结论不通过。
  assert.equal(verdict.verdict, "pending_review", "上游缺口必须让全文结论待校验")
  assert.ok(
    verdict.upstreamGaps.some((gap) => gap.includes("pages_without_text_layer_or_empty")),
    `上游缺口记录：${JSON.stringify(verdict.upstreamGaps)}`
  )

  // 对照：已验证简单范围无上游缺口 → 覆盖通过即进入索引核验等待态。
  const simple = await harness.ingest("simple-body.pdf", TRUTH_DIR_PDF)
  const simpleIndexChunks = simple.chunks.filter((chunk) => chunk.metadata.kind !== "parent")
  const simpleBlocks = await rederivePdfBlocks("simple-body.pdf", simple.docId)
  const simpleEvidence = new ExtractionEvidenceRepository(openDb()).get(simple.docId)
  assert.ok(simpleEvidence)
  const simpleVerdict = evaluateFullDocumentCoverage({
    extractionEvidence: simpleEvidence.artifact,
    risks: (simple.system.extraction as { risks?: { reviewRequired: boolean; reviewReasons: string[] } })?.risks ?? null,
    blocks: simpleBlocks,
    indexChunks: simpleIndexChunks,
  })
  assert.equal(simpleVerdict.verdict, "complete_pending_index_verification")
  assert.deepEqual(simpleVerdict.upstreamGaps, [])
})

test("UT-13 收尾：关闭隔离库", () => {
  closeDb()
})
