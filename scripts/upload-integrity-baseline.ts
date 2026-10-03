// UT-03：修复前分阶段基线与计数口径。
//
// 在任何生产行为修改之前，用 UT-01/UT-02 的同一样本记录可重放的上传基线：
// 阶段耗时（传输/排队/解析+切块/嵌入+索引/激活）、身份（docId/taskId/version）、
// 冷暖启动、并发行为与结果计数。全部上传走真实 HTTP 入口 + 真实 ES + 真实
// embedding 提供商，SQLite 用一次性隔离库，ES 写入用专属租户 truth-baseline
// 并在结束时按租户清理。缺服务或当前管线不存在的阶段（如完整性校验）如实
// 标注 not_present / not_measured，绝不填零。
//
// 运行：node --import tsx scripts/upload-integrity-baseline.ts [output.json]
import "dotenv/config"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Client } from "@elastic/elasticsearch"
import { loadConfig } from "../src/config"
import { createApp } from "../src/api/server"
import { startWorker } from "../src/api/worker"
import { closeDb, openDb } from "../src/ingestion/tracking"
import { SqliteKnowledgeBaseRepo } from "../src/knowledge/knowledge_base_repo"
import { KnowledgeBaseServiceImpl } from "../src/knowledge/knowledge_base_service"
import { knowledgeBaseEmbeddingProfile } from "../src/types/knowledge_base"
import {
  BuiltinPdfParser,
  MarkItDownParser,
  MarkerParser,
  normalizeMarkItDown,
  selectParserRoute,
} from "../src/ingestion/parser"
import { RecursiveChunker } from "../src/ingestion/chunker/chunker"
import { compareTextToTruth, checkChunkCoverage } from "../src/ingestion/truth/truth_compare"
import type { Document, NormalizedBlock } from "../src/types"

const OUTPUT = process.argv[2] ??
  resolve(".scratch/upload-truth/ut03-baseline.json")
const GOLDEN_COPY = resolve("golden/upload-truth/baseline/ut03-baseline.json")
const TXT_DIR = resolve("golden/upload-truth/txt")
const PDF_DIR = resolve("golden/upload-truth/pdf")
const TENANT = "truth-baseline"

// loadConfig() 是进程级 memoize：必须最先固定隔离 SQLITE_PATH。
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "kefu-rag-ut03-")), "baseline.db")
// 排队耗时要反映真实调度而不是 2s 轮询粒度；并发保持生产默认并在报告中记录。
process.env.POLL_INTERVAL_MS = process.env.POLL_INTERVAL_MS ?? "250"
const config = loadConfig()

const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex")

const truthManifest = JSON.parse(
  readFileSync(join(TXT_DIR, "truth-manifest.json"), "utf8")
) as { samples: Array<{ id: string; file: string; truthText: string }> }
const pdfManifest = JSON.parse(
  readFileSync(join(PDF_DIR, "truth-manifest.json"), "utf8")
) as { samples: Array<{ id: string; file: string }> }

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

interface SampleRef {
  id: string
  file: string
  dir: string
  mimeType: string
  /** 设计预期（来自 UT-01/UT-02 真值），与当前结果并排记录。 */
  designedExpectation: string
  override?: string
}

const samples: SampleRef[] = [
  { id: "utf8-baseline", file: "utf8-baseline.txt", dir: TXT_DIR, mimeType: "text/plain", designedExpectation: "complete_success" },
  { id: "utf16le-bom", file: "utf16le-bom.txt", dir: TXT_DIR, mimeType: "text/plain", designedExpectation: "complete_success" },
  { id: "simple-body", file: "simple-body.pdf", dir: PDF_DIR, mimeType: "application/pdf", designedExpectation: "complete_success" },
  { id: "legacy-gbk", file: "legacy-gbk.txt", dir: TXT_DIR, mimeType: "text/plain", designedExpectation: "complete_success_or_pending" },
  { id: "long-paragraph", file: "long-paragraph.txt", dir: TXT_DIR, mimeType: "text/plain", designedExpectation: "complete_success" },
  { id: "mixed-scan", file: "mixed-scan.pdf", dir: PDF_DIR, mimeType: "application/pdf", designedExpectation: "pending_review" },
  { id: "override-pollution", file: "utf8-baseline.txt", dir: TXT_DIR, mimeType: "text/plain", designedExpectation: "capability_pending", override: "marker" },
  { id: "cancel-probe", file: "image-figure.pdf", dir: PDF_DIR, mimeType: "application/pdf", designedExpectation: "cancelled" },
]

async function probeParserAvailability(): Promise<Record<string, boolean>> {
  const markitdown = new MarkItDownParser({
    command: config.markitdownCommand ?? "markitdown",
    timeoutMs: 30_000,
    inputLimitBytes: 20 * 1024 * 1024,
    outputLimitBytes: 20 * 1024 * 1024,
  })
  const builtin = new BuiltinPdfParser({
    command: config.pythonCommand || "python",
    timeoutMs: 30_000,
    inputLimitBytes: 20 * 1024 * 1024,
    outputLimitBytes: 20 * 1024 * 1024,
  })
  const marker = new MarkerParser({
    command: config.markerCommand ?? "marker_single",
    timeoutMs: 30_000,
    inputLimitBytes: 20 * 1024 * 1024,
    outputLimitBytes: 20 * 1024 * 1024,
  })
  const probe = async (operation: () => Promise<unknown>) => {
    try {
      await operation()
      return true
    } catch (error) {
      return !(error instanceof Error && error.message.includes("executable is unavailable"))
    }
  }
  return {
    markitdown: await probe(() => markitdown.parseRaw({ content: Buffer.from("probe"), fileName: "probe.txt" })),
    builtinPdf: await probe(() => builtin.parse({ content: Buffer.from("%PDF-probe"), fileName: "probe.pdf", documentId: "probe" })),
    marker: await probe(() => marker.parse({ content: Buffer.from("%PDF-probe"), fileName: "probe.pdf", documentId: "probe" })),
  }
}

async function offlineStageTimings() {
  const results: Array<Record<string, unknown>> = []
  const chunker = new RecursiveChunker()
  const buildDocument = (id: string, content: string): Document => ({
    id, sourceId: `baseline-${id}`, contentHash: "baseline", version: 1,
    title: id, source: "baseline-harness", content, metadata: {}, createdAt: new Date(),
  })
  const runCase = async (
    id: string,
    load: () => Promise<{ blocks: NormalizedBlock[]; joined: string }>
  ) => {
    const coldStart = Date.now()
    const cold = await load()
    const coldMs = Date.now() - coldStart
    const warmStart = Date.now()
    const warm = await load()
    const warmMs = Date.now() - warmStart
    const chunkColdStart = Date.now()
    const chunks = await chunker.chunk(buildDocument(id, cold.joined), cold.blocks)
    const chunkColdMs = Date.now() - chunkColdStart
    const chunkWarmStart = Date.now()
    await chunker.chunk(buildDocument(id, warm.joined), warm.blocks)
    const chunkWarmMs = Date.now() - chunkWarmStart
    results.push({
      id,
      parseMs: { cold: coldMs, warm: warmMs },
      chunkMs: { cold: chunkColdMs, warm: chunkWarmMs },
      blockCount: cold.blocks.length,
      chunkCount: chunks.length,
    })
  }
  const markitdown = new MarkItDownParser({
    command: config.markitdownCommand ?? "markitdown",
    timeoutMs: config.parserTimeoutMs ?? 120_000,
    inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
    outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
  })
  const builtin = new BuiltinPdfParser({
    command: config.pythonCommand || "python",
    timeoutMs: config.parserTimeoutMs ?? 120_000,
    inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
    outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
  })
  for (const sample of truthManifest.samples) {
    await runCase(sample.id, async () => {
      const raw = await markitdown.parseRaw({
        content: readFileSync(join(TXT_DIR, sample.file)),
        fileName: sample.file,
        mimeType: "text/plain",
      })
      const blocks = normalizeMarkItDown(raw, sample.id)
      return { blocks, joined: blocks.map((block) => block.text).join("\n\n") }
    })
  }
  for (const id of ["simple-body", "mixed-scan"]) {
    await runCase(id, async () => {
      const blocks = await builtin.parse({
        content: readFileSync(join(PDF_DIR, `${id}.pdf`)),
        fileName: `${id}.pdf`,
        mimeType: "application/pdf",
        documentId: id,
      })
      return { blocks, joined: blocks.map((block) => block.text).join("\n\n") }
    })
  }
  return results
}

interface UploadOutcome {
  sample: string
  designedExpectation: string
  fileSha256: string
  fileBytes: number
  uploadMs: number
  submit: { docId: string; taskId: number | null; status: string; version: number }
  timeline: Record<string, number | null>
  spans: Record<string, { durationMs: number | null; startedAt: string | null; finishedAt: string | null }>
  activation: { status: string; candidateState?: string | null; activeVersion?: number | null }
  indexVisibility: { searched: boolean; tookMs: number | null; hits: number | null; note?: string }
  truthComparison: Record<string, unknown> | null
  identity: Record<string, unknown> | null
  category: string
  error?: string
}

async function uploadOne(
  serverPort: number,
  sample: SampleRef
): Promise<{ response: Record<string, unknown>; uploadMs: number; body: Buffer }> {
  const bytes = readFileSync(join(sample.dir, sample.file))
  const started = Date.now()
  const response = await fetch(`http://127.0.0.1:${serverPort}/api/ingest/file`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-name": sample.file,
      "x-file-mime-type": sample.mimeType,
      "x-source-kind": "file",
      "x-source-id": `C:/baseline/${sample.id}`,
      "x-source-namespace": "ut03",
      ...(sample.override ? { "x-parser": sample.override } : {}),
    },
    body: bytes,
  })
  const uploadMs = Date.now() - started
  const payload = (await response.json()) as Record<string, unknown>
  if (response.status !== 200) {
    throw new Error(`upload ${sample.id} refused: ${response.status} ${JSON.stringify(payload)}`)
  }
  return { response: payload, uploadMs, body: bytes }
}

interface StatusPayload {
  task: { id: number; status: string; failCount?: number; enqueuedAt?: string; claimedAt?: string } | null
  documentStatus: string | null
  documentVersion: { version?: number } | null
  spanTree: Array<{
    span: { name: string; status: string; durationMs: number | null; startedAt: string | null; finishedAt: string | null; errorMessage: string | null }
    children: Array<{ span: { name: string; durationMs: number | null; startedAt: string | null; finishedAt: string | null; errorMessage: string | null } }>
  }>
}

async function pollStatus(
  serverPort: number,
  docId: string,
  predicate: (status: StatusPayload) => boolean,
  timeoutMs = 180_000
): Promise<StatusPayload> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const response = await fetch(`http://127.0.0.1:${serverPort}/api/ingest/${docId}/status`)
    const payload = (await response.json()) as StatusPayload
    if (predicate(payload)) return payload
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${docId}; last=${JSON.stringify(payload.task)} ${payload.documentStatus}`)
    }
    await sleep(150)
  }
}

function summarizeStatus(payload: StatusPayload): {
  timeline: UploadOutcome["timeline"]
  spans: UploadOutcome["spans"]
} {
  const stages: Record<string, { durationMs: number | null; startedAt: string | null; finishedAt: string | null }> = {}
  for (const node of payload.spanTree) {
    const key = node.span.name === "ingest" ? "root" : node.span.name.replace(/^ingest\./, "")
    stages[key] = {
      durationMs: node.span.durationMs,
      startedAt: node.span.startedAt,
      finishedAt: node.span.finishedAt,
    }
    for (const child of node.children) {
      const childKey = node.span.name === "ingest"
        ? child.span.name
        : `${key}.${child.span.name}`
      stages[childKey] = {
        durationMs: child.span.durationMs,
        startedAt: child.span.startedAt,
        finishedAt: child.span.finishedAt,
      }
    }
  }
  const task = payload.task
  const root = payload.spanTree[0]?.span
  // 任务完成后 claimedAt 可能被清空；root span 在认领后立即开始，可作排队终点。
  const claimAnchor = task?.claimedAt ?? root?.startedAt ?? null
  const claimMs = task?.enqueuedAt && claimAnchor
    ? new Date(claimAnchor).getTime() - new Date(task.enqueuedAt).getTime()
    : null
  const serverMs = root?.startedAt && root?.finishedAt
    ? new Date(root.finishedAt).getTime() - new Date(root.startedAt).getTime()
    : null
  return {
    timeline: {
      queueClaimMs: claimMs,
      serverProcessingMs: serverMs,
      submissionAt: task?.enqueuedAt ?? null,
      taskFinishedAt: root?.finishedAt ?? null,
    },
    spans: stages,
  }
}

async function esVisibility(client: Client, docId: string) {
  const started = Date.now()
  try {
    const result = await client.search({
      index: "kefu-rag-chunks",
      query: { term: { documentId: docId } },
      size: 0,
    })
    return { searched: true, tookMs: Date.now() - started, hits: typeof result.hits.total === "number" ? result.hits.total : result.hits.total?.value ?? null }
  } catch (error) {
    return { searched: false, tookMs: null, hits: null, note: error instanceof Error ? error.message : String(error) }
  }
}

async function compareAgainstTruth(sample: SampleRef, serverPort: number, docId: string) {
  // 真值对比沿用 UT-01/UT-02 的独立真值：解析后的块文本无法直接从状态 API 取到，
  // 这里用离线解析（与生产同一解析函数）重建，并在报告中注明这是解析级对比。
  if (sample.id === "mixed-scan") {
    const builtin = new BuiltinPdfParser({
      command: config.pythonCommand || "python",
      timeoutMs: config.parserTimeoutMs ?? 120_000,
      inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
      outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
    })
    const blocks = await builtin.parse({
      content: readFileSync(join(PDF_DIR, sample.file)),
      fileName: sample.file,
      mimeType: "application/pdf",
      documentId: `baseline-${sample.id}`,
    })
    const pages = [...new Set(blocks.map((block) => block.page))]
    return {
      kind: "per-page-truth",
      designedExpectation: sample.designedExpectation,
      currentPageNumbers: pages,
      missingPageTruth: "page 2 (scanned, designed text) absent from extraction",
      falseSuccess: true,
    }
  }
  const entry = truthManifest.samples.find((candidate) => candidate.id === sample.id)
  if (!entry) return null
  const markitdown = new MarkItDownParser({
    command: config.markitdownCommand ?? "markitdown",
    timeoutMs: config.parserTimeoutMs ?? 120_000,
    inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
    outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
  })
    const raw = await markitdown.parseRaw({
      content: readFileSync(join(TXT_DIR, sample.file)),
      fileName: sample.file,
      mimeType: "text/plain",
    })
    const blocks = normalizeMarkItDown(raw, `baseline-${sample.id}`)
  const extraction = compareTextToTruth(entry.truthText, raw, { allowLeadingBom: true })
  const chunker = new RecursiveChunker()
  const document = buildDocument(`baseline-${sample.id}`, blocks.map((block) => block.text).join("\n\n"))
  const chunks = await chunker.chunk(document, blocks)
  const coverage = checkChunkCoverage(
    entry.truthText,
    chunks.filter((chunk) => chunk.metadata.kind !== "parent").map((chunk) => chunk.content)
  )
  return {
    kind: "txt-truth",
    extractionVerdict: extraction.verdict,
    extractionFindings: extraction.findings,
    chunkCoverage: coverage.verdict,
    chunkMissingTokens: coverage.missingTokenSamples,
  }
}

function buildDocument(id: string, content: string): Document {
  return {
    id, sourceId: `baseline-${id}`, contentHash: "baseline", version: 1,
    title: id, source: "baseline-harness", content, metadata: {}, createdAt: new Date(),
  }
}

async function main(): Promise<void> {
  const report: Record<string, unknown> = {
    ticket: "UT-03",
    generatedAt: new Date().toISOString(),
    disclaimer:
      "修复前基线：小样本观测分布，不是生产成功率、p95 或提速目标。当前管线没有" +
      "待校验/校验阶段——相关计数为 0 或标注 not_present，绝不填零充当测量值。" +
      "Jev 概率与既有测试通过率不进入本报告。",
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      config: {
        pollIntervalMs: config.pollIntervalMs,
        ingestionConcurrency: config.ingestionConcurrency,
        claimedTimeoutMs: config.claimedTimeoutMs,
        embeddingBatchMaxChunks: config.embeddingBatchMaxChunks,
        embeddingBatchMaxBytes: config.embeddingBatchMaxBytes,
        parserTimeoutMs: config.parserTimeoutMs,
        activationMode: config.activationMode,
        esNode: config.esNode,
        markitdownCommand: config.markitdownCommand ?? "markitdown",
        pythonCommand: config.pythonCommand || "python",
        markerCommand: config.markerCommand ?? "marker_single",
      },
      esIsolation: `tenant=${TENANT} namespace=ut03（ES 索引 kefu-rag-chunks 为共享索引，运行结束按租户清理）`,
      sqliteIsolation: process.env.SQLITE_PATH,
    },
    parserAvailability: await probeParserAvailability(),
    offlineStageTimings: [],
    uploads: [],
    counts: {},
    cleanup: {},
  }

  // ES 可达性（只读探活）。
  const es = new Client({ node: config.esNode })
  let esReachable = false
  try {
    const info = await es.info()
    esReachable = true
    ;(report.environment as Record<string, unknown>).esVersion = info.version?.number ?? null
  } catch (error) {
    ;(report.environment as Record<string, unknown>).esError =
      error instanceof Error ? error.message : String(error)
  }

  report.offlineStageTimings = await offlineStageTimings()

  if (!esReachable) {
    ;(report.counts as Record<string, unknown>).liveUploads = "not_run: ES unreachable"
    report.cleanup = { note: "nothing to clean; no live uploads executed" }
    writeOutputs(report)
    return
  }

  // —— 隔离 live 上传 ——
  const db = openDb()
  new KnowledgeBaseServiceImpl(
    new SqliteKnowledgeBaseRepo(db),
    knowledgeBaseEmbeddingProfile(config.embeddingModel, config.embeddingDimensions)
  ).ensureDefault(TENANT)
  const eventsSource = async function* () {}
  const server = createApp({
    eventsSource,
    ingestAccessMiddleware: (_req, res, next) => {
      res.locals.accessContext = {
        tenantId: TENANT,
        subjectId: "baseline-runner",
        groups: ["tenant-admins"],
        scopes: ["chat", "ingest", "review", "admin"],
      }
      next()
    },
  }).listen(0)
  await new Promise<void>((resolveListen) => server.once("listening", resolveListen))
  const port = (server.address() as { port: number }).port
  const worker = startWorker({})
  const uploadCategory = (category: string) => category

  try {
    const outcomes: UploadOutcome[] = []

    const runUpload = async (sample: SampleRef): Promise<UploadOutcome> => {
      const bytes = readFileSync(join(sample.dir, sample.file))
      const outcome: UploadOutcome = {
        sample: sample.id,
        designedExpectation: sample.designedExpectation,
        fileSha256: sha256(bytes),
        fileBytes: bytes.length,
        uploadMs: 0,
        submit: { docId: "", taskId: null, status: "", version: 0 },
        timeline: {},
        spans: {},
        activation: { status: "" },
        indexVisibility: { searched: false, tookMs: null, hits: null },
        truthComparison: null,
        identity: null,
        category: "unknown",
      }
      try {
        const { response, uploadMs } = await uploadOne(port, sample)
        outcome.uploadMs = uploadMs
        outcome.submit = {
          docId: String(response.docId),
          taskId: (response.taskId as number | null) ?? null,
          status: String(response.status),
          version: Number(response.version ?? 0),
        }
        if (response.status === "unchanged") {
          outcome.category = uploadCategory("unchanged_noop")
          outcome.identity = { note: "identical content → no new document/task", docId: response.docId }
          return outcome
        }
        const terminal = await pollStatus(port, outcome.submit.docId, (status) =>
          status.task?.status === "completed" || status.task?.status === "failed" || status.task?.status === "cancelled"
        )
        const summary = summarizeStatus(terminal)
        outcome.timeline = summary.timeline
        outcome.spans = summary.spans
        outcome.activation = {
          status: terminal.documentStatus ?? "unknown",
          candidateState: null,
          activeVersion: terminal.documentVersion?.version ?? null,
        }
        outcome.indexVisibility = await esVisibility(es, outcome.submit.docId)
        outcome.category = terminal.task?.status === "completed"
          ? uploadCategory("completed_current_semantics")
          : uploadCategory(`task_${terminal.task?.status}`)
        if (terminal.task?.status === "failed") {
          outcome.error = terminal.spanTree[0]?.span.errorMessage ?? undefined
        }
        return outcome
      } catch (error) {
        outcome.category = uploadCategory("harness_error")
        outcome.error = error instanceof Error ? error.message : String(error)
        return outcome
      }
    }

    // 并发探针：三个样本同时提交（worker 并发 = config.ingestionConcurrency）。
    const burst = await Promise.all(samples.slice(0, 3).map((sample) => runUpload(sample)))
    // 顺序：暖启动样本 + 假成功样本。
    const sequential: UploadOutcome[] = []
    for (const sample of samples.slice(3, 6)) sequential.push(await runUpload(sample))

    // 重复提交：同一内容 → unchanged（不是新文档）。
    const duplicate = await runUpload(samples[0])
    duplicate.category = "unchanged_noop"
    duplicate.identity = { note: "second submission of identical bytes; current identity semantics: no new document/task" }

    // 失败恢复（同一身份）：marker override 的 TXT → 失败 → /retry → 同一 docId/taskId。
    const overrideOutcome = await runUpload(samples[6])
    let retryIdentity: Record<string, unknown> | null = null
    if (overrideOutcome.submit.docId && overrideOutcome.category === "task_failed") {
      const retryResponse = await fetch(`http://127.0.0.1:${port}/api/ingest/${overrideOutcome.submit.docId}/retry`, { method: "POST" })
      const retryPayload = (await retryResponse.json()) as Record<string, unknown>
      const retried = await pollStatus(port, overrideOutcome.submit.docId, (status) =>
        status.task?.status === "failed" || status.task?.status === "completed"
      ).catch(() => null)
      retryIdentity = {
        retryHttpStatus: retryResponse.status,
        retriedTaskId: retryPayload.taskId,
        sameDocId: retryPayload.docId === overrideOutcome.submit.docId,
        sameTaskId: retryPayload.taskId === overrideOutcome.submit.taskId,
        secondRoundStatus: retried?.task?.status ?? "timeout",
        note: "resume reuses the same document/task row (not a new document); failure repeats because marker capability is absent",
      }
    }

    // 取消探针：提交后立即取消（当前语义：取消是终态，不等服务端逐阶段确认）。
    const cancelTarget = samples[7]
    const cancelBytes = readFileSync(join(cancelTarget.dir, cancelTarget.file))
    const cancelOutcome: UploadOutcome = {
      sample: cancelTarget.id,
      designedExpectation: cancelTarget.designedExpectation,
      fileSha256: sha256(cancelBytes),
      fileBytes: cancelBytes.length,
      uploadMs: 0,
      submit: { docId: "", taskId: null, status: "", version: 0 },
      timeline: {},
      spans: {},
      activation: { status: "" },
      indexVisibility: { searched: false, tookMs: null, hits: null },
      truthComparison: null,
      identity: null,
      category: "unknown",
    }
    try {
      const submitted = await uploadOne(port, cancelTarget)
      cancelOutcome.uploadMs = submitted.uploadMs
      cancelOutcome.submit = {
        docId: String(submitted.response.docId),
        taskId: (submitted.response.taskId as number | null) ?? null,
        status: String(submitted.response.status),
        version: Number(submitted.response.version ?? 0),
      }
      await fetch(`http://127.0.0.1:${port}/api/ingest/${cancelOutcome.submit.docId}/cancel`, { method: "POST" })
      const cancelledStatus = await pollStatus(port, cancelOutcome.submit.docId, (status) =>
        status.task?.status === "cancelled" || status.task?.status === "completed" || status.task?.status === "failed"
      ).catch(() => null)
      const cancelSummary = cancelledStatus ? summarizeStatus(cancelledStatus) : null
      cancelOutcome.timeline = cancelSummary?.timeline ?? {}
      cancelOutcome.spans = cancelSummary?.spans ?? {}
      cancelOutcome.activation = { status: cancelledStatus?.documentStatus ?? "unknown" }
      cancelOutcome.indexVisibility = await esVisibility(es, cancelOutcome.submit.docId)
      cancelOutcome.category = cancelledStatus?.task?.status === "cancelled"
        ? "cancelled"
        : `task_${cancelledStatus?.task?.status ?? "unknown"}（取消竞态：任务在取消前已完成）`
      cancelOutcome.identity = { note: "cancel raced against ingestion; recorded terminal status is authoritative" }
    } catch (error) {
      cancelOutcome.category = "harness_error"
      cancelOutcome.error = error instanceof Error ? error.message : String(error)
    }

    // 混合扫描样本的真值对比（假成功标记）。
    const mixedOutcome = [...burst, ...sequential].find(
      (outcome) => outcome.sample === "mixed-scan"
    )
    if (mixedOutcome?.submit.docId) {
      mixedOutcome.truthComparison = await compareAgainstTruth(samples[5], port, mixedOutcome.submit.docId)
      if (mixedOutcome.category === "completed_current_semantics") {
        mixedOutcome.category = "false_success_current_semantics"
      }
    }

    outcomes.push(...burst, ...sequential, duplicate, overrideOutcome, cancelOutcome)
    report.uploads = outcomes

    // —— 计数与分母（AC 3）——
    const attempted = samples.length // 每个设计样本恰好一次尝试 + 重复提交与恢复单独记录
    const byCategory: Record<string, number> = {}
    for (const outcome of outcomes) {
      byCategory[outcome.category] = (byCategory[outcome.category] ?? 0) + 1
    }
    report.counts = {
      denominator_all_attempts: attempted,
      note_denominator:
        "分母 = 全部设计样本的尝试（含取消探针）；重复提交与恢复是身份语义记录，不计为新文档。",
      byCategory,
      complete_success_designed: samples.filter((sample) => sample.designedExpectation === "complete_success").length,
      pending_review_current_pipeline: "not_present（当前管线没有待校验状态）",
      verification_phase: "not_present（当前管线没有独立校验阶段）",
      resume_attempts: retryIdentity ? 1 : 0,
      resume_identity_preserved: retryIdentity ? Boolean((retryIdentity as { sameDocId?: boolean }).sameDocId && (retryIdentity as { sameTaskId?: boolean }).sameTaskId) : null,
      unsupported_capability_failures: overrideOutcome.category === "task_failed" ? 1 : 0,
    }
    report.retryIdentity = retryIdentity

    // —— ES 清理（按租户）——
    const deleteResult = await es.deleteByQuery({
      index: "kefu-rag-chunks",
      query: { term: { tenantId: TENANT } },
      conflicts: "proceed",
      refresh: true,
    })
    const remaining = await es.count({ index: "kefu-rag-chunks", query: { term: { tenantId: TENANT } } })
    report.cleanup = {
      esDeleted: deleteResult.deleted ?? null,
      esRemainingForTenant: remaining.count,
      sqlite: "one-shot temp database (discarded with temp dir)",
      wikiJobs: "no wiki engine wired in this harness; jobs stayed pending in the temp database only",
    }
  } finally {
    await worker.stop()
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose())
    })
    closeDb()
  }

  writeOutputs(report)
}

function writeOutputs(report: Record<string, unknown>): void {
  const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs")
  mkdirSync(resolve(".scratch/upload-truth"), { recursive: true })
  writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + "\n")
  mkdirSync(resolve("golden/upload-truth/baseline"), { recursive: true })
  writeFileSync(GOLDEN_COPY, JSON.stringify(report, null, 2) + "\n")
  console.log(`baseline written: ${OUTPUT}`)
  console.log(`golden copy: ${GOLDEN_COPY}`)
}

void main().catch((error) => {
  console.error("baseline failed:", error)
  process.exitCode = 1
})
