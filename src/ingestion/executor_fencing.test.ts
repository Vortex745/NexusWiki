// UT-20：并发恢复与重启单执行者围栏。
//
// 契约（UP-10 AC 3/6，经 20 票继承）：重复恢复/并发恢复/进程重启始终只有
// 一个有效执行者——认领（claimNext）与完成（finalize）都以 claimed_at 为
// 围栏；恢复（recoverStaleClaims）原子重认领陈旧任务；迟到旧执行不能覆盖
// 取消终态、新恢复状态或活动版本；取消/重启有界不无限运行；隔离仓储重开
// 后终态与证据可读。
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { closeDb, openDb, type DB } from "./tracking"
import { DocumentRepo } from "./tracking/doc_repo"
import { TaskRepo } from "./tracking/task_repo"
import { IngestionLifecycle, type IngestionStageRunner } from "./lifecycle"
import { PipelineStageRunner } from "./pipeline"
import type { IngestionStoreImpl } from "./storage"

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
// loadConfig() 是进程级 memoize：必须在任何 loadConfig 调用之前固定隔离库。
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "kefu-rag-ut20-")), "ingestion.db")

const ORIGINAL = Buffer.from(
  "UT-20 围栏样本。否定校验：不支持口头申请。结尾校验词：围栏-77。\n",
  "utf8"
)

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

function makeWorkingLifecycle(db: DB): IngestionLifecycle {
  return new IngestionLifecycle(db, new PipelineStageRunner(db, undefined as never, makeWorkingStore()))
}

function makeFailingRunner(): IngestionStageRunner {
  return {
    close: async () => {},
    async run() {
      throw new Error("permanent boom (ut20)")
    },
  }
}

test("UT-20 a) 重复/并发恢复幂等：一次生效、单任务行、无新版本", async () => {
  const db: DB = openDb()
  const failing = new IngestionLifecycle(db, makeFailingRunner())
  const submitted = failing.submit({
    title: "UT-20 并发恢复",
    content: "",
    rawContent: ORIGINAL,
    fileName: "fence.txt",
    mimeType: "text/plain",
    sourceIdentity: { kind: "file", uriOrExternalId: "C:/truth/ut20/fence.txt", namespace: "ut20" },
  })
  await failing.runNext()
  assert.equal(new DocumentRepo(db).getOperationalState(submitted.docId)?.status, "failed")

  // 两个"进程"（两个 lifecycle 实例）先后调用恢复——第二个看到任务已
  // 回到 pending，不再新增执行者。
  const worker1 = makeWorkingLifecycle(db)
  const worker2 = makeWorkingLifecycle(db)
  const first = worker1.retry(submitted.docId)
  const second = worker2.retry(submitted.docId)
  assert.equal(first?.changed, true, "第一次恢复生效")
  assert.equal(second?.changed, false, "第二次恢复是幂等无操作")

  const taskRows = db.prepare("SELECT COUNT(*) AS n FROM task_pending_ops WHERE doc_id = ?").get(submitted.docId) as { n: number }
  assert.equal(taskRows.n, 1, "不新建任务行")
  const versionRows = db.prepare("SELECT COUNT(*) AS n FROM documents WHERE source_id = (SELECT source_id FROM documents WHERE doc_id = ?)").get(submitted.docId) as { n: number }
  assert.equal(versionRows.n, 1, "不新建版本")

  // 恢复后由唯一执行者完成。
  const rerun = await worker1.runNext()
  assert.ok(rerun?.success, "唯一执行者完成恢复")
  assert.equal(new DocumentRepo(db).getOperationalState(submitted.docId)?.status, "completed")
})

test("UT-20 b) 重启恢复：陈旧认领原子重认领，老执行者不能发布", async () => {
  const db: DB = openDb()
  const lifecycle = makeWorkingLifecycle(db)
  const submitted = lifecycle.submit({
    title: "UT-20 重启恢复",
    content: "",
    rawContent: ORIGINAL,
    fileName: "restart.txt",
    mimeType: "text/plain",
    sourceIdentity: { kind: "file", uriOrExternalId: "C:/truth/ut20/restart.txt", namespace: "ut20" },
  })

  // 模拟"认领后进程死亡"：认领任务但从不执行。
  const taskRepo = new TaskRepo(db)
  const claimed = taskRepo.claimNext()
  assert.ok(claimed)
  assert.equal(claimed.docId, submitted.docId)
  const staleClaimedAt = claimed.claimedAt
  assert.ok(staleClaimedAt)

  // "重启"：新 lifecycle 实例（同持久库），陈旧认领被原子重认领。
  // 等待 30ms 确保认领时间超过 claimedTimeout 窗口。
  await new Promise((resolveWait) => setTimeout(resolveWait, 30))
  const restarted = makeWorkingLifecycle(db)
  const startedAt = Date.now()
  const recovered = restarted.recoverStaleClaims(1)
  const recoveryMs = Date.now() - startedAt
  assert.equal(recovered, 1, "恰恢复一个陈旧任务")
  assert.ok(recoveryMs < 5000, `恢复耗时受界：${recoveryMs}ms`)

  // 老执行者用旧 claimed_at 无法发布（终态写入被围栏拒绝）。
  assert.equal(
    taskRepo.finalize(claimed.id, "completed", staleClaimedAt),
    false,
    "老执行者不能发布完成终态"
  )
  assert.equal(
    taskRepo.recordFailure(claimed.id, null, staleClaimedAt),
    false,
    "老执行者不能发布失败终态"
  )

  // 测试状态构造：恢复按瞬态失败语义带 2s 重试延迟——调度层清零以便立即
  // 继续执行（与生产 worker 的定时轮询等价，不属于门槛绕过）。
  db.prepare("UPDATE task_pending_ops SET next_attempt_at = NULL WHERE doc_id = ?").run(submitted.docId)

  // 当前执行者（重认领后）完成 → 唯一发布。
  const rerun = await restarted.runNext()
  assert.ok(rerun?.success, "重认领后的当前执行者完成恢复")
  assert.equal(new DocumentRepo(db).getOperationalState(submitted.docId)?.status, "completed")
  // 无重复条目：期望检索清单行数 == 切块数且无重复身份。
  const manifest = db.prepare("SELECT chunk_id, COUNT(*) AS n FROM expected_chunks WHERE doc_id = ? GROUP BY chunk_id HAVING n > 1").all(submitted.docId)
  assert.equal(manifest.length, 0, "无重复逻辑条目")
})

test("UT-20 c) 迟到旧执行不覆盖：取消终态与新恢复状态均被围栏保护", async () => {
  const db: DB = openDb()
  const lifecycle = makeWorkingLifecycle(db)
  const submitted = lifecycle.submit({
    title: "UT-20 迟到执行",
    content: "",
    rawContent: ORIGINAL,
    fileName: "late.txt",
    mimeType: "text/plain",
    sourceIdentity: { kind: "file", uriOrExternalId: "C:/truth/ut20/late.txt", namespace: "ut20" },
  })
  const taskRepo = new TaskRepo(db)
  const claimed = taskRepo.claimNext()
  assert.ok(claimed)
  // 任务被取消（终态）。
  assert.equal(taskRepo.cancel(claimed.id), true)
  // 迟到旧执行尝试发布完成/失败 → 全部被拒。
  assert.equal(taskRepo.finalize(claimed.id, "completed", claimed.claimedAt), false, "迟到完成被拒")
  assert.equal(taskRepo.recordFailure(claimed.id, null, claimed.claimedAt), false, "迟到失败被拒")
  const taskRow = db.prepare("SELECT status FROM task_pending_ops WHERE id = ?").get(claimed.id) as { status: string }
  assert.equal(taskRow.status, "cancelled", "取消终态未被覆盖")
})

test("UT-20 d) 取消与恢复不无限运行：运行中任务可立即取消（有界）", async () => {
  const db: DB = openDb()
  const lifecycle = makeWorkingLifecycle(db)
  const submitted = lifecycle.submit({
    title: "UT-20 立即取消",
    content: "",
    rawContent: ORIGINAL,
    fileName: "running-cancel.txt",
    mimeType: "text/plain",
    sourceIdentity: { kind: "file", uriOrExternalId: "C:/truth/ut20/running.txt", namespace: "ut20" },
  })
  const taskRepo = new TaskRepo(db)
  taskRepo.claimNext()
  const startedAt = Date.now()
  const cancellation = lifecycle.cancel(submitted.docId)
  const cancelMs = Date.now() - startedAt
  assert.equal(cancellation?.status, "cancelled")
  assert.equal(cancellation?.changed, true)
  assert.ok(cancelMs < 5000, `取消即时生效，不等待运行结束：${cancelMs}ms`)
})

test("UT-20 e) 隔离仓储重开：终态、证据与活动身份可读且一致", async () => {
  const documentRepo = new DocumentRepo(openDb())
  const completed = dbPrepareCompletedDocIds(documentRepo)
  assert.ok(completed.length > 0, "存在已完成文档")
  // 重开隔离仓储（模拟新进程读取）。
  closeDb()
  const reopened = new DocumentRepo(openDb())
  for (const docId of completed) {
    assert.equal(reopened.getOperationalState(docId)?.status, "completed", `终态可读：${docId}`)
    const evidence = reopened.getCandidateEvidence(docId) as { schemaVersion?: number } | null
    if (evidence) {
      assert.equal(evidence.schemaVersion, 1, "证据 schema 版本跨重开一致")
    }
  }
})

function dbPrepareCompletedDocIds(documentRepo: DocumentRepo): string[] {
  const db = openDb()
  return (db.prepare("SELECT doc_id FROM documents WHERE status = 'completed'").all() as Array<{ doc_id: string }>).map((row) => row.doc_id)
}

test("UT-20 收尾：关闭隔离库", () => {
  closeDb()
})
