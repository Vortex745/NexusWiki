// UT-07 / UT-08：能力与错误分类、有界重试与取消传播。
//
// UT-07：缺命令与永久输入错误不被自动反复执行；注入缺命令核对调用次数与
// 最终原因；未知错误不无依据归为暂时；任务状态返回机器可读原因与允许操作。
// UT-08：注入暂时错误后有界恢复（2s/4s/8s → dead letter），尝试/退避可观察；
// 取消立即阻止后续尝试且保留取消语义；嵌入共享闸门回归由 store.test.ts 继续
// 覆盖（AC 4 的既有部分）。
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { closeDb, openDb } from "./tracking"
import { DocumentRepo } from "./tracking/doc_repo"
import {
  IngestionLifecycle,
  type IngestionStageRunner,
  type StageExecution,
} from "./lifecycle"
import {
  classifyIngestionError,
  INGESTION_FAILURE_REASON_CODES,
  allowedOperationsFor,
  redactedFailureMessage,
  RETRY_DELAYS_MS,
} from "./error_classification"
import { PdfQualityRejectionError } from "./quality/pdf_ocr_fallback_flag"

// loadConfig() 是进程级 memoize：本文件任何 openDb 前必须就绪。
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"

function completingRunner(): IngestionStageRunner {
  return {
    close: async () => {},
    async run(_document, execution: StageExecution): Promise<void> {
      for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
        await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
      }
    },
  }
}

test("UT-07 分类：能力缺失/永久输入/暂时/取消各归其类，未知不归暂时", () => {
  const capability = classifyIngestionError(
    new Error("Parser executable is unavailable: marker_single")
  )
  assert.equal(capability.category, "capability_missing")
  assert.equal(capability.retryable, false)
  assert.equal(capability.reasonCode, INGESTION_FAILURE_REASON_CODES.parserCapabilityMissing)

  const noUsable = classifyIngestionError(
    new Error("No usable parser for a.txt: tried marker, builtin-pdf. Install one of the missing runtimes")
  )
  assert.equal(noUsable.category, "capability_missing")
  assert.equal(noUsable.reasonCode, INGESTION_FAILURE_REASON_CODES.noUsableParser)

  const malformed = classifyIngestionError(
    new Error("builtin-pdf failed: malformed builtin-pdf output: no text blocks (the PDF likely has no text layer)")
  )
  assert.equal(malformed.category, "permanent_input")
  assert.equal(malformed.retryable, false)

  const transient = classifyIngestionError(new Error("embedding request hit 429 rate limit"))
  assert.equal(transient.category, "transient")
  assert.equal(transient.retryable, true)

  const timeout = classifyIngestionError(new Error("Parser process timed out after 120000ms"))
  assert.equal(timeout.category, "transient")

  const cancelled = classifyIngestionError(new Error("Parser process was cancelled"))
  assert.equal(cancelled.category, "cancelled")
  assert.equal(cancelled.retryable, false)

  // 未知错误：没有暂时性依据 → 立即终止（不无依据归为暂时）。
  const unknown = classifyIngestionError(new Error("something exploded with code -1073741515"))
  assert.equal(unknown.category, "permanent_input")
  assert.equal(unknown.retryable, false)
  assert.equal(unknown.reasonCode, INGESTION_FAILURE_REASON_CODES.unclassifiedTreatedPermanent)

  // 允许操作区分待能力与待修正。
  assert.deepEqual(allowedOperationsFor("capability_missing"), ["configure_parser_then_retry", "cancel"])
  assert.deepEqual(allowedOperationsFor("permanent_input"), ["fix_input_then_retry", "cancel"])
  assert.deepEqual(allowedOperationsFor("transient"), ["wait_for_auto_retry", "cancel"])

  // 理由脱敏：凭据形态的 URL 不进入状态消息。
  assert.equal(
    redactedFailureMessage(new Error("fetch failed for https://user:secret@host.example/x")),
    "fetch failed for ***@***"
  )
})

test("Ticket 18 分类：质量拒绝按类型归为终态，理由码措辞不构成再次重试的依据", () => {
  // 票 18：gate 的拒绝理由码会带分类词（如 service_failure:timeout:1）。
  // 按类型而不是按消息分类，拒绝才不会重新进入 transient 类并触发任务级
  // 第二轮整档重试（gate 内的预算已经花完）。
  const rejection = new PdfQualityRejectionError(["service_failure:timeout:1", "missing_content:2"])
  assert.ok(rejection.message.includes("timeout"), "前置：消息里确实出现了 timeout 词形")
  const classification = classifyIngestionError(rejection)
  assert.equal(classification.category, "permanent_input")
  assert.equal(classification.reasonCode, INGESTION_FAILURE_REASON_CODES.pdfQualityGateRejected)
  assert.equal(classification.retryable, false, "gate 已花掉自己的有界预算；第二轮重试是双重花费")

  assert.deepEqual([...RETRY_DELAYS_MS], [2_000, 4_000, 8_000], "有界预算是唯一共享表")
})

test("Ticket 26 落账：质量拒绝的审计明细码进入 failure 记录，其他失败不带该字段", async () => {
  const db = openDb(":memory:")
  try {
    // 质量拒绝：明细码（含页码）必须原样进入持久化 failure 记录——前端
    // 凭它区分真质量拒绝与审计服务故障（粗分类同为 permanent_input）。
    const rejectionRunner: IngestionStageRunner = {
      close: async () => {},
      async run(_document, execution: StageExecution): Promise<void> {
        await execution.runStage("chunk", {}, async () => {
          throw new PdfQualityRejectionError(["quality_failed:3", "service_failure:timeout:5"])
        }, () => ({}))
      },
    }
    const rejectionLifecycle = new IngestionLifecycle(db, rejectionRunner)
    const rejected = rejectionLifecycle.submit({ title: "拒绝样本", content: "c", source: "rejection-test" })
    assert.equal((await rejectionLifecycle.runNext())?.success, false)
    const failure = rejectionLifecycle.getStatus(rejected.docId)?.failure
    assert.equal(failure?.reasonCode, INGESTION_FAILURE_REASON_CODES.pdfQualityGateRejected)
    assert.deepEqual(
      failure?.reasonCodes,
      ["quality_failed:3", "service_failure:timeout:5"],
      "审计明细码原样持久化（数字不被 messageSafeCode 改写）",
    )

    // 非质量失败：不携带 reasonCodes 字段（ absence 本身是前端判断依据）。
    const plainLifecycle = new IngestionLifecycle(db, {
      close: async () => {},
      async run(_document, execution: StageExecution): Promise<void> {
        await execution.runStage("chunk", {}, async () => {
          throw new Error("MarkItDown executable is unavailable. Parser executable is unavailable: markitdown")
        }, () => ({}))
      },
    })
    const plain = plainLifecycle.submit({ title: "普通失败样本", content: "c", source: "plain-test" })
    assert.equal((await plainLifecycle.runNext())?.success, false)
    const plainFailure = plainLifecycle.getStatus(plain.docId)?.failure
    assert.equal(plainFailure?.reasonCode, INGESTION_FAILURE_REASON_CODES.parserCapabilityMissing)
    assert.equal(plainFailure?.reasonCodes, undefined, "非质量失败没有审计明细码")
  } finally {
    db.close()
  }
})

test("UT-07 注入缺命令：解析只被调用一次即终止，原因与允许操作可读", async () => {
  const db = openDb(":memory:")
  try {
    // 单候选路由（TXT → markitdown），注入解析器恒定报告可执行文件缺失。
    let parseCalls = 0
    const runner: IngestionStageRunner = {
      close: async () => {},
      async run(_document, execution: StageExecution): Promise<void> {
        await execution.runStage(
          "chunk",
          {},
          async () => {
            parseCalls += 1
            throw new Error("MarkItDown executable is unavailable. Configure MARKITDOWN_COMMAND. Parser executable is unavailable: markitdown")
          },
          () => ({})
        )
      },
    }
    const lifecycle = new IngestionLifecycle(db, runner)
    const submitted = lifecycle.submit({ title: "缺能力样本", content: "content", source: "cap-test" })
    const result = await lifecycle.runNext()

    assert.equal(result?.success, false)
    assert.equal(parseCalls, 1, "缺命令不被自动反复执行——单次运行内只调用一次")
    assert.equal(await lifecycle.runNext(), null, "没有可再领取的任务：不进入重试排队")

    const status = lifecycle.getStatus(submitted.docId)
    assert.equal(status?.task?.status, "failed", "立即终止而非 pending 重试")
    assert.equal(status?.documentStatus, "failed")
    assert.equal(status?.task?.nextAttemptAt, null, "没有下次尝试排期")
    assert.equal(status?.failure?.category, "capability_missing")
    assert.equal(status?.failure?.reasonCode, INGESTION_FAILURE_REASON_CODES.parserCapabilityMissing)
    assert.deepEqual(status?.failure?.allowedOperations, ["configure_parser_then_retry", "cancel"])
    assert.match(status?.failure?.message ?? "", /MARKITDOWN_COMMAND/)
    // 绝不标完整成功：失败文档停在 failed 且从未激活。
    assert.equal(status?.documentVersion.active, false)
  } finally {
    db.close()
  }
})

test("UT-08 注入暂时错误：2s/4s/8s 有界恢复可观察，第 4 次失败后稳定终止", async () => {
  const db = openDb(":memory:")
  let now = Date.parse("2026-08-01T00:00:00.000Z")
  let attempts = 0
  const runner: IngestionStageRunner = {
    close: async () => {},
    async run(_document, execution: StageExecution): Promise<void> {
      attempts += 1
      await execution.runStage(
        "chunk",
        {},
        async () => {
          throw new Error("embedding provider rate limit 429: temporary")
        },
        () => ({})
      )
    },
  }
  const lifecycle = new IngestionLifecycle(db, runner, () => new Date(now))
  try {
    const submitted = lifecycle.submit({ title: "暂时故障样本", content: "content", source: "transient-test" })
    const delays = [2_000, 4_000, 8_000]
    for (const [index, delay] of delays.entries()) {
      const result = await lifecycle.runNext()
      const status = lifecycle.getStatus(submitted.docId)
      assert.equal(result?.success, false)
      assert.equal(status?.task?.status, "pending", `第 ${index + 1} 次失败后仍可重试`)
      assert.equal(status?.task?.failCount, index + 1, "尝试次数可观察")
      assert.equal(status?.task?.nextAttemptAt, new Date(now + delay).toISOString(), "退避可观察")
      assert.equal(status?.failure?.category, "transient")
      assert.deepEqual(status?.failure?.allowedOperations, ["wait_for_auto_retry", "cancel"])
      now += delay
    }
    const exhausted = await lifecycle.runNext()
    const finalStatus = lifecycle.getStatus(submitted.docId)
    assert.equal(exhausted?.success, false)
    assert.equal(finalStatus?.task?.status, "failed")
    assert.equal(finalStatus?.task?.failCount, 4, "总预算 = 1 + 3 次重试")
    assert.equal(finalStatus?.task?.nextAttemptAt, null)
    assert.equal(attempts, 4, "有效总预算可复核")
    assert.equal(finalStatus?.failure?.category, "transient")
  } finally {
    db.close()
  }
})

test("UT-08 取消传播：退避等待期取消立即终结，取消后没有后续尝试", async () => {
  const db = openDb(":memory:")
  let now = Date.parse("2026-08-01T00:00:00.000Z")
  const lifecycle = new IngestionLifecycle(db, {
    close: async () => {},
    async run(_document, execution: StageExecution): Promise<void> {
      await execution.runStage(
        "chunk",
        {},
        async () => {
          throw new Error("rate limit 429: temporary")
        },
        () => ({})
      )
    },
  }, () => new Date(now))
  try {
    // 运行中取消（真取消：abort 注入执行信号）保留取消语义——该路径由
    // lifecycle.test.ts 的取消竞态测试覆盖；这里验证退避期的取消收敛。
    const submitted = lifecycle.submit({ title: "退避期取消", content: "c2", source: "cancel-test-2" })
    const failed = await lifecycle.runNext()
    assert.equal(failed?.success, false)
    assert.equal(lifecycle.getStatus(submitted.docId)?.task?.status, "pending", "暂时故障进入退避")
    assert.ok(lifecycle.getStatus(submitted.docId)?.task?.nextAttemptAt)

    now += 1_000
    const cancellation = lifecycle.cancel(submitted.docId)
    assert.equal(cancellation?.status, "cancelled", "退避等待期的 pending 任务立即取消")
    assert.equal(cancellation?.changed, true)
    assert.equal(lifecycle.getStatus(submitted.docId)?.documentStatus, "cancelled")
    assert.equal(await lifecycle.runNext(), null, "取消后没有可领取的后续尝试")
  } finally {
    db.close()
  }
})

test("UT-07/08 降级链：同类型候选回退记录尝试链，跨类型不悄悄当同等能力", () => {
  const db = openDb(":memory:")
  try {
    // 该契约属于 pipeline 的候选遍历（类型兼容回退 + attempts 记录），
    // 已由 UT-06 的真实上传测试与 parser.test.ts 覆盖；此处断言分类器把
    // "不可用回退后仍失败" 的错误如实归为能力缺失（UT-07 AC 3 的分类面）。
    const fallbackExhausted = classifyIngestionError(
      new Error("No usable parser for broken.pdf: tried marker, builtin-pdf (PDF documents require layout-aware parsing). Install one of the missing runtimes")
    )
    assert.equal(fallbackExhausted.category, "capability_missing")
    assert.equal(fallbackExhausted.reasonCode, INGESTION_FAILURE_REASON_CODES.noUsableParser)
    assert.equal(allowedOperationsFor(fallbackExhausted.category).includes("configure_parser_then_retry"), true)
  } finally {
    db.close()
  }
})

test("UT-07/08 分类后元数据持久化：重启后状态仍可读", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "kefu-rag-ut07-"))
  process.env.SQLITE_PATH = join(tempDir, "failure.db")
  let now = Date.parse("2026-08-02T00:00:00.000Z")
  const db = openDb()
  const lifecycle = new IngestionLifecycle(db, {
    close: async () => {},
    async run(_document, execution: StageExecution): Promise<void> {
      await execution.runStage(
        "chunk",
        {},
        async () => {
          throw new Error("MarkItDown executable is unavailable: markitdown")
        },
        () => ({})
      )
    },
  }, () => new Date(now))
  try {
    const submitted = lifecycle.submit({ title: "持久失败", content: "content", source: "persist-fail" })
    await lifecycle.runNext()
    // 模拟重启：关闭并重新打开数据库。
    closeDb()
    const reopened = openDb()
    const reopenedLifecycle = new IngestionLifecycle(reopened, completingRunner(), () => new Date(now))
    const status = reopenedLifecycle.getStatus(submitted.docId)
    assert.equal(status?.failure?.category, "capability_missing")
    assert.equal(status?.failure?.reasonCode, INGESTION_FAILURE_REASON_CODES.parserCapabilityMissing)
    assert.deepEqual(status?.failure?.allowedOperations, ["configure_parser_then_retry", "cancel"])
    assert.match(status?.failure?.message ?? "", /executable is unavailable/)
  } finally {
    closeDb()
  }
})
