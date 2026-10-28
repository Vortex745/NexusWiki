import assert from "node:assert/strict"
import test from "node:test"
import { IngestionLifecycle, type IngestionStageRunner } from "./lifecycle"
import { openDb } from "./tracking"
import { DocumentRepo } from "./tracking/doc_repo"

test("a failed active reprocess leaves the old version and active pointer intact", async () => {
  const db = openDb(":memory:")
  let run = 0
  const runner: IngestionStageRunner = {
    close: async () => {},
    async run(_document, execution) {
      run += 1
      if (run > 1) throw new Error("reprocess parser failure")
      for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
        await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
      }
    },
  }
  const lifecycle = new IngestionLifecycle(db, runner)
  try {
    const original = lifecycle.submit({
      title: "Policy",
      content: "version one",
      source: "policy:reprocess-failure",
    })
    assert.equal((await lifecycle.runNext())?.success, true)
    const repo = new DocumentRepo(db)
    assert.equal(repo.getActive(repo.get(original.docId)!.sourceId)?.id, original.docId)

    const reprocessed = lifecycle.reprocess(original.docId)
    assert.ok(reprocessed)
    assert.equal(reprocessed.changed, true)
    assert.notEqual(reprocessed.docId, original.docId)

    const failed = await lifecycle.runNext()
    assert.equal(failed?.success, false)
    assert.equal(repo.getStatus(reprocessed.docId), "failed")
    assert.equal(repo.getStatus(original.docId), "completed")
    assert.equal(repo.getActive(repo.get(original.docId)!.sourceId)?.id, original.docId)
    assert.equal(lifecycle.getStatus(original.docId)?.documentVersion.active, true)
    assert.equal(lifecycle.getStatus(reprocessed.docId)?.documentVersion.active, false)
  } finally {
    db.close()
  }
})
