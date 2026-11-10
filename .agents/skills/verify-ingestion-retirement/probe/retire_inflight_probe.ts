import assert from "node:assert/strict"
import { openDb } from "../../../../src/ingestion/tracking"
import { ActiveVersionRepository } from "../../../../src/ingestion/tracking/active_version_repo"
import { DocumentRepo } from "../../../../src/ingestion/tracking/doc_repo"
import { TaskRepo } from "../../../../src/ingestion/tracking/task_repo"
import { IngestionLifecycle, type IngestionExecutionResult, type IngestionStageRunner } from "../../../../src/ingestion/lifecycle"
import { SqliteSourceLifecycleStore } from "../../../../src/knowledge/source_lifecycle_store"
import { RetirementServiceImpl } from "../../../../src/knowledge/retirement"

const scenarios = ["control", "pending", "before-stages", "inside-write", "before-completion", "transient"] as const

async function main(): Promise<void> {
  for (const pauseAt of scenarios) {
    const db = openDb(":memory:")
    const events: string[] = []
    let release!: () => void
    const paused = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    let runnerCalls = 0
    const runner: IngestionStageRunner = {
      async close() {},
      async run(_document, execution) {
        runnerCalls += 1
        if (pauseAt === "before-stages") { entered(); await paused }
        for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
          await execution.runStage(stage, {}, async () => {
            if ((pauseAt === "inside-write" || pauseAt === "transient") && stage === "storeChunks") {
              entered()
              await paused
              if (pauseAt === "transient") throw new Error("503 service unavailable")
            }
            events.push(`write:${stage}`)
          }, () => ({ stage }))
        }
        if (pauseAt === "before-completion") { entered(); await paused }
      },
    }
    const lifecycle = new IngestionLifecycle(db, runner, () => new Date(), "auto", {
      async run(op) { events.push(`cleanup:${op}`) },
    })
    const docs = new DocumentRepo(db)
    const tasks = new TaskRepo(db)
    const sources = new SqliteSourceLifecycleStore(db)
    const retirement = new RetirementServiceImpl(db, sources, tasks)
    const submitted = lifecycle.submit({ title: `Retirement ${pauseAt}`, content: "retained content", source: `probe://${pauseAt}` })
    assert.ok(submitted.status === "pending")
    const document = docs.get(submitted.docId)!
    const tenant = document.tenantId ?? "default"
    if (pauseAt === "pending") retirement.retire(document.sourceId, tenant, "probe", "probe")
    const running = lifecycle.runNext()
    try {
      let cleanupWhileRunning: IngestionExecutionResult | null = null
      if (pauseAt !== "control" && pauseAt !== "pending") {
        await started
        retirement.retire(document.sourceId, tenant, "probe", "probe")
        cleanupWhileRunning = await lifecycle.runNext()
      }
      release()
      const result = await running
      if (pauseAt === "control") {
        assert.equal(result?.success, true, "normal ingestion completes")
        assert.equal(docs.getActive(document.sourceId)?.id, submitted.docId)
        retirement.retire(document.sourceId, tenant, "probe", "probe")
      } else {
        assert.equal(cleanupWhileRunning, null, "cleanup must wait for the outstanding execution")
        assert.equal(result?.success, false, "retired ingestion cannot complete")
        assert.equal(docs.getStatus(submitted.docId), "failed")
        assert.equal(docs.getActive(document.sourceId), null)
        assert.equal(tasks.getById(submitted.taskId)?.status, "failed")
        assert.equal(tasks.getById(submitted.taskId)?.nextAttemptAt, null, "retirement never retries")
      }
      const writesBeforeDrain = events.filter((event) => event.startsWith("write:"))
      if (pauseAt === "pending") assert.equal(runnerCalls, 0, "pending retired ingest never enters the runner")
      if (pauseAt === "before-stages" || pauseAt === "pending") assert.equal(writesBeforeDrain.length, 0)
      if (pauseAt === "inside-write" || pauseAt === "transient") {
        assert.ok(!writesBeforeDrain.includes("write:storeGraph"), "retirement prevents the next stage")
      }
      while (await lifecycle.runNext()) {}
      const cleanupEvents = events.filter((event) => event.startsWith("cleanup:"))
      assert.deepEqual(cleanupEvents, ["cleanup:cleanup_es", "cleanup:cleanup_neo4j", "cleanup:cleanup_pageindex", "cleanup:cleanup_images"])
      const cleanupIndex = events.findIndex((event) => event.startsWith("cleanup:"))
      assert.ok(events.slice(cleanupIndex).every((event) => event.startsWith("cleanup:")), "no artifacts return after cleanup")
      assert.equal(sources.getSource(document.sourceId, tenant)?.lifecycleState, "retired")
      assert.ok(!new ActiveVersionRepository(db).getActiveDocIds().includes(submitted.docId))
      assert.equal(retirement.retire(document.sourceId, tenant, "again", "probe")?.enqueuedCleanupTasks, 0)
      console.log(JSON.stringify({ scenario: pauseAt, verdict: "pass", documentStatus: docs.getStatus(submitted.docId), events }))
    } finally {
      release()
      await running
      db.close()
    }
  }

  const db = openDb(":memory:")
  try {
    const docs = new DocumentRepo(db)
    const tasks = new TaskRepo(db)
    const sources = new SqliteSourceLifecycleStore(db)
    const lifecycle = new IngestionLifecycle(db, { async close() {}, async run() {} })
    const submitted = lifecycle.submit({ title: "Activation guard", content: "content", source: "probe://activation" })
    const document = docs.get(submitted.docId)!
    new RetirementServiceImpl(db, sources, tasks).retire(document.sourceId, document.tenantId ?? "default", "probe", "probe")
    docs.activate(submitted.docId)
    assert.equal(docs.getActive(document.sourceId), null, "repository activation rejects a retired source")
    console.log(JSON.stringify({ scenario: "direct-activation", verdict: "pass" }))
  } finally {
    db.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
