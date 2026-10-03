// UT-22：TXT 实测优化与核心性能口径。
//
// 契约（UP-05 AC 4 / UP-11 AC 4-6，经 22 票继承）：同样本/真值/配置比较
// 直接文本路径（direct-txt，进程内）与既有 CLI（markitdown）的冷/暖成本；
// 记录统一口径的分阶段耗时。direct-txt 已因保真理由采用（UT-10）——本票
// 实测其速度收益作为额外证据；markitdown 不可用时如实单列。
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { config as dotenvConfig } from "dotenv"
import { closeDb, openDb } from "./tracking"
import { IngestionLifecycle } from "./lifecycle"
import { PipelineStageRunner } from "./pipeline"
import { DirectTextParser, MarkItDownParser } from "./parser"
import type { IngestionStoreImpl } from "./storage"
import { loadConfig } from "../config"

const HERE = dirname(__filename)
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
dotenvConfig({ override: false })
// loadConfig() 是进程级 memoize：必须在任何 loadConfig 调用之前固定隔离库。
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "kefu-rag-ut22-")), "ingestion.db")

const TRUTH_DIR = resolve(HERE, "../../golden/upload-truth/txt")
const REPORT_DIR = resolve(HERE, "../../.scratch/upload-truth")

function makeWorkingStore(): IngestionStoreImpl {
  return {
    async storeChunks(chunks: Array<unknown>): Promise<unknown> {
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
}

/** 计时器：冷=首次调用，暖=其后 N 次的中位数。被测路径是异步的，
 * 必须等待完成才算耗时——否则只测到 Promise 调度，数字无意义。 */
async function coldWarmTiming<T>(
  cold: () => Promise<T> | T,
  warm: () => Promise<T> | T,
  warmRuns: number
): Promise<{ coldMs: number; warmMedianMs: number }> {
  const t0 = performance.now()
  await cold()
  const coldMs = performance.now() - t0
  const samples: number[] = []
  for (let i = 0; i < warmRuns; i += 1) {
    const s = performance.now()
    await warm()
    samples.push(performance.now() - s)
  }
  samples.sort((a, b) => a - b)
  return { coldMs, warmMedianMs: samples[Math.floor(samples.length / 2)] }
}

test("UT-22 TXT 冷/暖启动对比：同样本下 direct-txt 与 markitdown CLI 实测", async (t) => {
  const config = loadConfig()
  const bytes = readFileSync(join(TRUTH_DIR, "utf8-baseline.txt"))
  const report: Record<string, unknown> = {
    sample: "utf8-baseline.txt",
    bytes: bytes.length,
    warmRuns: 5,
    note: "同机器同进程内计时；direct-txt 无进程启动成本，CLI 含 python 解释器冷启动。",
  }

  // direct-txt：进程内解码（生产采用的保真路径）。
  const direct = new DirectTextParser()
  const directTiming = await coldWarmTiming(
    () => direct.parseRaw({ content: bytes, fileName: "utf8-baseline.txt" }),
    () => direct.parseRaw({ content: bytes, fileName: "utf8-baseline.txt" }),
    5
  )
  report.directTxt = { ...directTiming, unit: "ms", process: "in-process" }

  // markitdown CLI：真实子进程冷/暖（能力缺失时如实单列）。
  const cli = new MarkItDownParser({
    command: config.markitdownCommand ?? "markitdown",
    timeoutMs: config.parserTimeoutMs ?? 120_000,
    inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
    outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
  })
  try {
    const cliTiming = await coldWarmTiming(
      () => cli.parseRaw({ content: bytes, fileName: "utf8-baseline.txt" }),
      () => cli.parseRaw({ content: bytes, fileName: "utf8-baseline.txt" }),
      3
    )
    report.markitdownCli = { ...cliTiming, unit: "ms", process: "subprocess" }
    const speedup = (report.markitdownCli as { warmMedianMs: number }).warmMedianMs /
      (report.directTxt as { warmMedianMs: number }).warmMedianMs
    report.warmMedianSpeedup = Number(speedup.toFixed(1))
    assert.ok(speedup > 1, "direct-txt 暖启动中位数应快于 CLI 子进程")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Windows 上 pip 脚本可能是 .bat 包装器（EINVAL→could not start），
    // 与真正的 ENOENT 一样都是"CLI 在本机不可用"，如实单列。
    if (message.includes("executable is unavailable") || message.includes("could not start")) {
      report.markitdownCli = { status: "capability_missing", detail: message.slice(0, 120) }
      t.skip(`markitdown 不可用，CLI 对比未验收：${message.slice(0, 60)}`)
      return
    }
    throw error
  } finally {
    mkdirSync(REPORT_DIR, { recursive: true })
    writeFileSync(join(REPORT_DIR, "ut22-txt-benchmark.json"), JSON.stringify(report, null, 2) + "\n")
  }
})

test("UT-22 端到端分阶段口径：上传→解析→校验→切块→存储→激活", async () => {
  const db = openDb()
  const lifecycle = new IngestionLifecycle(
    db,
    new PipelineStageRunner(db, undefined as never, makeWorkingStore())
  )
  const submitted = lifecycle.submit({
    title: "UT-22 分阶段口径",
    content: "",
    rawContent: readFileSync(join(TRUTH_DIR, "utf8-baseline.txt")),
    fileName: "utf8-baseline.txt",
    mimeType: "text/plain",
    sourceIdentity: { kind: "file", uriOrExternalId: "C:/truth/ut22/baseline.txt", namespace: "ut22" },
  })
  const startedAt = Date.now()
  const result = await lifecycle.runNext()
  const endToEndMs = Date.now() - startedAt
  assert.ok(result?.success)

  // 分阶段耗时来自持久 span（kind='stage'：chunk/wikify/storeChunks/
  // storeGraph 粒度），直接读现成的 duration_ms 列，非事后推测。
  const spans = db.prepare(
    "SELECT kind, name, status, duration_ms FROM processing_spans WHERE doc_id = ? ORDER BY id ASC"
  ).all(submitted.docId) as Array<{ kind: string; name: string; status: string; duration_ms: number | null }>
  const stageSpans = spans.filter((span) => span.kind === "stage" && span.duration_ms !== null)
  assert.ok(stageSpans.length > 0, "分阶段 span 已持久记录")
  for (const span of stageSpans) {
    assert.ok(span.duration_ms !== null && span.duration_ms >= 0, `阶段 ${span.name} 耗时非负`)
  }
  assert.ok(endToEndMs < 60_000, "单文档端到端受界")

  // 统一口径说明（写盘供 B1 报告引用）。解析/校验在 chunk 阶段内、
  // 嵌入/索引在 storeChunks 阶段内、激活在根 span 收尾——未单列的阶段
  // 如实说明，不虚构更细粒度。
  mkdirSync(REPORT_DIR, { recursive: true })
  writeFileSync(
    join(REPORT_DIR, "ut22-stage-timing.json"),
    JSON.stringify({
      docId: submitted.docId,
      endToEndMs,
      stages: stageSpans.map((span) => ({
        stage: span.name,
        durationMs: span.duration_ms,
      })),
      caliber:
        "口径：submit 入队 → runNext 端到端墙钟；阶段粒度为持久 span 的 " +
        "chunk/wikify/storeChunks/storeGraph（解析与校验在 chunk 内、嵌入与 " +
        "ES bulk 索引在 storeChunks 内、联合门槛与激活在根 span 收尾）。" +
        "span 为管线运行时持久记录，非事后推测；更细粒度单列后续票。",
    }, null, 2) + "\n"
  )
})

test("UT-22 收尾：关闭隔离库", () => {
  closeDb()
})
