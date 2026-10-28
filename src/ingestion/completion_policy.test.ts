import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { IngestionLifecycle } from "./lifecycle"
import { PipelineStageRunner } from "./pipeline"
import { openDb } from "./tracking"
import { DocumentRepo } from "./tracking/doc_repo"
import type { IngestionStoreImpl } from "./storage"

function fakeStore(counters: { proofReads: number }): IngestionStoreImpl {
  return {
    async storeChunks() {},
    async storeEntities() {},
    async storeWikilinks() {},
    async readIndexEntries() {
      counters.proofReads += 1
      throw new Error("index proof reads must not happen on the new hot path")
    },
    async countVisibleIndexEntries() {
      counters.proofReads += 1
      throw new Error("visibility probes must not happen on the new hot path")
    },
    get chunkIndexName() { return "test-chunks" },
    async close() {},
  } as unknown as IngestionStoreImpl
}

test("technical completion writes the policy marker, activates and never reads index proofs", async () => {
  const db = openDb(":memory:")
  const counters = { proofReads: 0 }
  try {
    const runner = new PipelineStageRunner(db, undefined, fakeStore(counters))
    const lifecycle = new IngestionLifecycle(db, runner)
    const submitted = lifecycle.submit({
      title: "Completion policy",
      content: "policy body",
      source: "policy:completion",
      metadata: {
        tags: ["policy"],
        system: {
          ingestionPolicy: { version: "forged" },
          parser: { selected: "forged" },
        },
      },
    })

    const result = await lifecycle.runNext()
    assert.equal(result?.success, true)
    const document = new DocumentRepo(db).get(submitted.docId)!
    const system = document.metadata.system as Record<string, unknown>
    const policy = system.ingestionPolicy as Record<string, unknown>
    assert.equal(policy.version, "weknora-technical-v1")
    assert.equal(policy.parser, null)
    assert.equal(policy.upstreamSha, null)
    assert.equal(policy.pdfMode, null)
    assert.equal(typeof policy.completedAt, "string")
    assert.equal(system.parser, undefined, "caller-supplied system.parser must not survive")
    assert.deepEqual(document.metadata.tags, ["policy"], "catalog metadata is preserved")

    const repo = new DocumentRepo(db)
    assert.equal(repo.getActive(document.sourceId)?.id, submitted.docId)
    assert.equal(repo.getCandidateEvidence(submitted.docId), null)
    assert.equal(lifecycle.getStatus(submitted.docId)?.activationBlockReason, null)
    assert.equal(counters.proofReads, 0, "content/index proof reads stay off the hot path")
  } finally {
    db.close()
  }
})

test("the pipeline no longer imports or calls the retired proof, coverage or gate modules", () => {
  const source = readFileSync(join(__dirname, "pipeline.ts"), "utf8")
  for (const retired of [
    "produceContentProof",
    "verifyIndexEntries",
    "evaluateBlockCoverage",
    "ExpectedChunkRepository",
    "evaluateActivationGate",
    "readIndexEntries",
    "countVisibleIndexEntries",
  ]) {
    assert.doesNotMatch(source, new RegExp(`\\b${retired}\\b`), `${retired} must not remain on the new hot path`)
  }
})
