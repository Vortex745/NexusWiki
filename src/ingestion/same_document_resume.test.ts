// UT-18：同文档恢复身份与终态命令。
//
// 契约（UP-10 AC 1/5，经 18 票继承）：已接收文件经原恢复接口（lifecycle
// retry / reprocess，HTTP POST /ingest/:docId/retry|reprocess）从保留原件
// 重新处理——不发送第二份文件、不创建版本（docId/taskId/来源/知识库/版本
// 不变）；运行中或重复恢复不新增执行者；成功任务无操作；待校验未补证时
// 保留原因；取消任务只有明确恢复命令才开启新尝试；缺原件给可解释原因；
// 恢复沿现有生命周期并受同一完整性/索引门槛约束。
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { config as dotenvConfig } from "dotenv"
import { closeDb, openDb, type DB } from "./tracking"
import { DocumentRepo } from "./tracking/doc_repo"
import { IngestionLifecycle, type IngestionStageRunner } from "./lifecycle"
import { PipelineStageRunner } from "./pipeline"
import type { IngestionStoreImpl } from "./storage"
import { loadConfig } from "../config"

const HERE = "."
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
// 真实嵌入/ES 配置来自生产 .env（override:false，不覆盖已有环境变量）。
dotenvConfig({ override: false })
// loadConfig() 是进程级 memoize：必须在任何 loadConfig 调用之前固定隔离库。
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "kefu-rag-ut18-")), "ingestion.db")

const ORIGINAL = Buffer.from(
  "UT-18 恢复身份样本。否定校验：不支持口头申请。结尾校验词：恢复-42。\n",
  "utf8"
)

function makeFailingRunner(): IngestionStageRunner {
  return {
    close: async () => {},
    async run() {
      // 永久错误：直接终态失败（不进入重试预算）。
      throw new Error("permanent boom (ut18 first run)")
    },
  }
}

function makeWorkingStore() {
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

test("UT-18 a) 失败后恢复：同一 docId/taskId/版本/原件，无新版本，重跑受同一门槛约束", async () => {
  const db: DB = openDb()
  const failing = new IngestionLifecycle(db, makeFailingRunner())
  const submitted = failing.submit({
    title: "UT-18 恢复身份",
    content: "",
    rawContent: ORIGINAL,
    fileName: "resume.txt",
    mimeType: "text/plain",
    sourceIdentity: { kind: "file", uriOrExternalId: "C:/truth/ut18/resume.txt", namespace: "ut18" },
  })
  const failedRun = await failing.runNext()
  assert.equal(failedRun?.success, false, "首次运行按剧本失败")

  const documentRepo = new DocumentRepo(db)
  const beforeTask = db.prepare("SELECT id, status FROM task_pending_ops WHERE doc_id = ?").get(submitted.docId) as { id: number; status: string }
  const versionRowsBefore = db.prepare("SELECT COUNT(*) AS n FROM documents WHERE source_id = ?").get(
    documentRepo.get(submitted.docId)?.sourceId
  ) as { n: number }

  // 恢复：不重传文件、不创建版本——直接 retry，随后同一任务由正常管线执行。
  const working = new IngestionLifecycle(
    db,
    new PipelineStageRunner(db, undefined as never, makeWorkingStore())
  )
  const resume = working.retry(submitted.docId)
  assert.ok(resume)
  assert.equal(resume.changed, true, "失败任务允许明确恢复")
  assert.equal(resume.taskId, beforeTask.id, "复用同一任务行（同一 taskId）")
  assert.equal(resume.status, "pending")

  const rerun = await working.runNext()
  assert.ok(rerun?.success, "恢复后从保留原件重跑成功")
  const rerunTask = db.prepare("SELECT id, status FROM task_pending_ops WHERE doc_id = ?").get(submitted.docId) as { id: number; status: string }
  assert.equal(rerunTask.id, beforeTask.id, "仍是同一任务")

  const document = documentRepo.get(submitted.docId)
  assert.ok(document)
  assert.equal(document.version, 1, "版本不变")
  assert.deepEqual(document.rawContent, ORIGINAL, "原件字节不变")
  const versionRowsAfter = db.prepare("SELECT COUNT(*) AS n FROM documents WHERE source_id = ?").get(
    document.sourceId
  ) as { n: number }
  assert.equal(versionRowsAfter.n, versionRowsBefore.n, "没有创建新版本行")
  assert.equal(
    documentRepo.getOperationalState(submitted.docId)?.status,
    "completed"
  )
})

test("UT-18 b) 成功任务恢复为无操作；待校验候选恢复保留阻碍原因", async () => {
  const db: DB = openDb()
  const working = new IngestionLifecycle(
    db,
    new PipelineStageRunner(db, undefined as never, makeWorkingStore())
  )
  const submitted = working.submit({
    title: "UT-18 成功任务",
    content: "正文内容（无原件的内容型文档）。",
    source: "ut18-completed",
  })
  await working.runNext()
  assert.equal(new DocumentRepo(db).getOperationalState(submitted.docId)?.status, "completed")

  // 成功任务的 retry 是无操作（不新增执行者）。
  const noOp = working.retry(submitted.docId)
  assert.ok(noOp)
  assert.equal(noOp.changed, false)
  const stillCompleted = new DocumentRepo(db).getOperationalState(submitted.docId)?.status
  assert.equal(stillCompleted, "completed")

  // GBK 模糊编码：技术完成直接激活，但解码风险仍保留在文档元数据中；
  // retry 无操作——点击恢复不会重新执行已完成的候选。
  const gbk = working.submit({
    title: "UT-18 待校验候选",
    content: "",
    rawContent: readFileSync("golden/upload-truth/txt/legacy-gbk.txt"),
    fileName: "legacy-gbk.txt",
    mimeType: "text/plain",
    sourceIdentity: { kind: "file", uriOrExternalId: "C:/truth/ut18/gbk.txt", namespace: "ut18" },
  })
  const gbkRun = await working.runNext()
  assert.ok(gbkRun?.success)
  const gbkSystem = new DocumentRepo(db).get(gbk.docId)?.metadata.system as {
    decode?: { reviewRequired?: boolean; reviewReason?: string }
  }
  assert.equal(gbkSystem.decode?.reviewRequired, true, "解码风险保留为技术元数据")
  assert.equal(gbkSystem.decode?.reviewReason, "ambiguous_encoding")
  assert.equal(new DocumentRepo(db).getActivationBlockReason(gbk.docId), null)
  const resumeBlocked = working.retry(gbk.docId)
  assert.ok(resumeBlocked)
  assert.equal(resumeBlocked.changed, false, "已完成候选不因 retry 重新执行")
})

test("UT-18 c) 文件型文档缺保留原件：恢复被拒并给可解释原因，任务保持终态", async () => {
  const db: DB = openDb()
  const failing = new IngestionLifecycle(db, makeFailingRunner())
  const submitted = failing.submit({
    title: "UT-18 缺原件",
    content: "",
    rawContent: ORIGINAL,
    fileName: "lost-original.txt",
    mimeType: "text/plain",
    sourceIdentity: { kind: "file", uriOrExternalId: "C:/truth/ut18/lost.txt", namespace: "ut18" },
  })
  await failing.runNext()
  assert.equal(new DocumentRepo(db).getOperationalState(submitted.docId)?.status, "failed")

  // 原件丢失（模拟历史数据/清理）。
  db.prepare("UPDATE documents SET raw_content = NULL WHERE doc_id = ?").run(submitted.docId)

  const working = new IngestionLifecycle(
    db,
    new PipelineStageRunner(db, undefined as never, makeWorkingStore())
  )
  const refused = working.retry(submitted.docId)
  assert.ok(refused)
  assert.equal(refused.changed, false, "缺原件不得开启新尝试")
  assert.match(refused.reason ?? "", /original file content is not retained/, "给可解释原因")
  const task = db.prepare("SELECT id, status FROM task_pending_ops WHERE doc_id = ?").get(submitted.docId) as { id: number; status: string }
  assert.equal(task.status, "failed", "任务保持失败终态，未重新入队")
})

test("UT-18 d) 取消任务：明确恢复命令开启新尝试；终态后迟到取消无效", async () => {
  const db: DB = openDb()
  const working = new IngestionLifecycle(
    db,
    new PipelineStageRunner(db, undefined as never, makeWorkingStore())
  )
  const submitted = working.submit({
    title: "UT-18 取消后恢复",
    content: "待取消正文。",
    source: "ut18-cancel",
  })
  const cancellation = working.cancel(submitted.docId)
  assert.equal(cancellation?.status, "cancelled")

  // 明确恢复命令：重新开启尝试（同一任务行）。
  const resume = working.retry(submitted.docId)
  assert.ok(resume)
  assert.equal(resume.changed, true)
  assert.equal(resume.status, "pending")
  const rerun = await working.runNext()
  assert.ok(rerun?.success)

  // 终态后迟到取消无效（不能撤销已完成执行）。
  const lateCancel = working.cancel(submitted.docId)
  assert.equal(lateCancel?.changed, false, "终态后迟到取消不改状态")
})

test("UT-18 收尾：关闭隔离库", () => {
  closeDb()
})
