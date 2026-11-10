/**
 * Ticket 40 (SYNC-01B) — schedule, claim and recover durable sync runs.
 *
 * Acceptance criteria exercised here:
 *   1. Schedules store next-run state and need no new permanent service: a
 *      sweep enqueues due sources and rolls next_run_at forward; the worker
 *      timer is the only caller.
 *   2. Concurrent triggers claim exactly one active run for a source (the
 *      partial unique index + transactional claim; the loser gets an
 *      explicit conflict).
 *   3. Pending work resumes safely after a process restart (durable rows +
 *      startup requeue of interrupted runs).
 *   4. Successful updates activate atomically through the normal lifecycle;
 *      a failed run retains the prior active version.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { openDb, type DB } from "../ingestion/tracking/db"
import {
  type IngestionLifecycle,
  type IngestionStageRunner,
  type StageExecution,
} from "../ingestion/lifecycle"
import { createIngestionLifecycle } from "../ingestion/pipeline"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import { ActiveVersionRepository } from "../ingestion/tracking/active_version_repo"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { KnowledgeBaseServiceImpl } from "../knowledge/knowledge_base_service"
import { SyncDataSourceService } from "./data_source_service"
import { SyncRunConflictError, SyncRunService } from "./sync_run_service"

const EMBEDDING_PROFILE = "text-embedding-3-small:1536"

const STAGE_RUNNER_STUB: IngestionStageRunner = {
  close: async () => {},
  async run(_document, execution: StageExecution): Promise<void> {
    for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
      await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
    }
  },
}

// Ticket UT-04: the joint activation gate keeps lifecycle completions
// inactive. Sync tests verify sync-run semantics (claiming, failure
// retention, pausing, retirement) against ACTIVE documents, so this test
// wrapper constructs the active state directly after all four stages
// complete. No candidate_evidence is written and the production gate is
// untouched — explicit test-state construction.
function activatingStageRunner(db: DB, inner: IngestionStageRunner): IngestionStageRunner {
  return {
    close: () => inner.close(),
    async run(document, execution) {
      let completedStages = 0
      const tracked: StageExecution = {
        signal: execution.signal,
        executionId: execution.executionId,
        runStage: async (name, input, operation, summarize) => {
          const result = await execution.runStage(name, input, operation, summarize)
          completedStages += 1
          return result
        },
      }
      const result = await inner.run(document, tracked)
      if (completedStages === 4) {
        new DocumentRepo(db).activate(document.id)
      }
      return result
    },
  }
}

function staticFetch(body: string, contentType = "text/plain"): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(body, { status: 200, headers: { "content-type": contentType } })
    )) as typeof fetch
}

interface Setup {
  db: DB
  lifecycle: IngestionLifecycle
  sources: SyncDataSourceService
  runs: SyncRunService
  repo: DocumentRepo
  activeRepo: ActiveVersionRepository
  kb: { id: string }
  fetchOptions: { resolver: () => Promise<{ addresses: string[] }>; fetchImpl: typeof fetch }
}

function buildSetup(): Setup {
  const db = openDb(":memory:")
  const lifecycle = createIngestionLifecycle(db, {
    stageRunner: activatingStageRunner(db, STAGE_RUNNER_STUB),
    activationMode: "auto",
  })
  const fetchOptions = {
    resolver: async () => ({ addresses: ["93.184.216.34"] }),
    fetchImpl: staticFetch("同步内容"),
  }
  const sources = new SyncDataSourceService({ db, lifecycle, fetchOptions })
  const runs = new SyncRunService({ db, lifecycle, fetchOptions })
  const kbService = new KnowledgeBaseServiceImpl(new SqliteKnowledgeBaseRepo(db), EMBEDDING_PROFILE)
  const kb = kbService.create("demo", "KB")
  return {
    db,
    lifecycle,
    sources,
    runs,
    repo: new DocumentRepo(db),
    activeRepo: new ActiveVersionRepository(db),
    kb,
    fetchOptions,
  }
}

for (const [recovery, lateStatus] of [
  ["expired", 200], ["expired", 503],
  ["startup", 200], ["startup", 503],
  ["startup-backwards", 200], ["startup-backwards", 503],
] as const) {
  test(`a sync execution revoked by ${recovery} recovery cannot overwrite its replacement with HTTP ${lateStatus}`, async () => {
    const setup = buildSetup()
    let clock = new Date("2026-11-10T00:00:00.000Z")
    let fetched!: () => void
    const started = new Promise<void>((resolve) => { fetched = resolve })
    let release!: (response: Response) => void
    const pendingResponse = new Promise<Response>((resolve) => { release = resolve })
    let fetchCount = 0
    const runs = new SyncRunService({
      db: setup.db,
      lifecycle: setup.lifecycle,
      now: () => clock,
      leaseMs: 1_000,
      fetchOptions: {
        resolver: setup.fetchOptions.resolver,
        fetchImpl: (async () => {
          fetchCount += 1
          if (fetchCount === 1) {
            fetched()
            return pendingResponse
          }
          return new Response("replacement content", { headers: { "content-type": "text/plain" } })
        }) as typeof fetch,
      },
    })
    const source = setup.sources.create({ tenantId: "demo", knowledgeBaseId: setup.kb.id,
      kind: "url", uri: "https://example.com/lease" })
    const run = runs.enqueue("demo", source.id, "manual")
    const first = runs.claimNext()!
    const staleExecution = runs.executeClaimed(first)
    try {
      await started
      if (recovery === "expired") {
        clock = new Date(clock.getTime() + 1_001)
        assert.equal(runs.recoverExpiredLeases(), 1)
      } else {
        if (recovery === "startup-backwards") clock = new Date(clock.getTime() - 3_600_000)
        assert.equal(runs.recoverOnStartup(), 1)
      }
      const replacement = runs.claimNext()!
      const completed = await runs.executeClaimed(replacement)
      assert.equal(completed.status, "completed")
      const acceptedPages = runs.listRunPages(run.id)
      const acceptedDocs = setup.db.prepare("SELECT doc_id, content FROM documents ORDER BY doc_id").all()
      const acceptedSource = setup.db.prepare("SELECT * FROM sync_data_sources WHERE id = ?").get(source.id)
      const acceptedLedger = setup.db.prepare("SELECT * FROM sync_source_pages WHERE source_id = ? ORDER BY uri").all(source.id)
      release(new Response("late stale content", { status: lateStatus, headers: { "content-type": "text/plain" } }))
      await staleExecution
      assert.deepEqual(runs.getRun("demo", source.id, run.id), completed)
      assert.deepEqual(runs.listRunPages(run.id), acceptedPages)
      assert.deepEqual(setup.db.prepare("SELECT doc_id, content FROM documents ORDER BY doc_id").all(), acceptedDocs)
      assert.deepEqual(setup.db.prepare("SELECT * FROM sync_data_sources WHERE id = ?").get(source.id), acceptedSource)
      assert.deepEqual(setup.db.prepare("SELECT * FROM sync_source_pages WHERE source_id = ? ORDER BY uri").all(source.id), acceptedLedger)
    } finally {
      release(new Response("late response"))
      await staleExecution
      setup.db.close()
    }
  })
}

test("scheduled sources store next-run state; a sweep enqueues due sources and rolls the schedule", async () => {
  const setup = buildSetup()
  const source = setup.sources.create({
    tenantId: "demo",
    knowledgeBaseId: setup.kb.id,
    kind: "url",
    uri: "https://example.com/policy",
    interval: "1h",
  })
  // No sweep has run yet — nothing queued, no next_run_at... the first sweep
  // treats a NULL next_run_at as due.
  assert.equal(setup.runs.enqueueDueScheduled(), 1)
  const storedNext = setup.db
    .prepare(`SELECT next_run_at FROM sync_data_sources WHERE id = ?`)
    .get(source.id) as { next_run_at: string }
  assert.ok(storedNext.next_run_at, "next-run state is stored on the source")
  const queued = setup.db
    .prepare(`SELECT COUNT(*) AS n FROM sync_runs WHERE status = 'pending'`)
    .get() as { n: number }
  assert.equal(queued.n, 1)

  // The schedule rolled forward: an immediate second sweep enqueues nothing.
  assert.equal(setup.runs.enqueueDueScheduled(), 0)

  // The sweep executes the queued run to completion (no new permanent
  // service — this is exactly what the existing worker timer calls).
  await setup.runs.sweep()
  const run = setup.db.prepare(`SELECT status, summary, error FROM sync_runs`).get() as {
    status: string
    summary: string
    error: string | null
  }
  assert.equal(run.status, "completed", `run error: ${run.error ?? "none"}`)
  assert.match(run.summary ?? "", /submitted=1/)
})

test("concurrent triggers claim exactly one active run; the loser gets a conflict", async () => {
  const setup = buildSetup()
  const source = setup.sources.create({
    tenantId: "demo",
    knowledgeBaseId: setup.kb.id,
    kind: "url",
    uri: "https://example.com/policy",
  })
  const first = setup.runs.enqueue("demo", source.id, "manual")
  assert.throws(() => setup.runs.enqueue("demo", source.id, "schedule"), SyncRunConflictError)

  // Claim is transactional: the first claim wins, a second claim finds nothing.
  const claimed = setup.runs.claimNext()
  assert.ok(claimed)
  assert.equal(claimed.id, first.id)
  assert.equal(setup.runs.claimNext(), null, "no second active run can be claimed")
  await setup.runs.executeClaimed(claimed)

  // After completion a new trigger is fine.
  const again = setup.runs.enqueue("demo", source.id, "manual")
  assert.notEqual(again.id, first.id)
})

test("pending work resumes safely after a restart; expired leases are requeued", async () => {
  const setup = buildSetup()
  const source = setup.sources.create({
    tenantId: "demo",
    knowledgeBaseId: setup.kb.id,
    kind: "url",
    uri: "https://example.com/policy",
  })
  // A run was queued but the process died before claiming it.
  setup.runs.enqueue("demo", source.id, "manual")

  // A fresh service over the same db (the "restarted" process) resumes it.
  const restarted = new SyncRunService({
    db: setup.db,
    lifecycle: setup.lifecycle,
    fetchOptions: setup.fetchOptions,
  })
  assert.equal(restarted.recoverOnStartup(), 0, "nothing was running — no requeue needed")
  await restarted.sweep()
  const runs = restarted.listRuns("demo", source.id)
  assert.equal(runs.length, 1)
  assert.equal(
    runs[0].status,
    "completed",
    `pending work resumed and completed (run: ${JSON.stringify(runs[0])})`
  )

  // A run that was RUNNING when the process died is requeued on recovery.
  const second = setup.runs.enqueue("demo", source.id, "manual")
  const claimedAgain = restarted.claimNext()
  assert.ok(claimedAgain && claimedAgain.id === second.id)
  const interruptedReader = new SyncRunService({
    db: setup.db,
    lifecycle: setup.lifecycle,
    fetchOptions: setup.fetchOptions,
  })
  assert.equal(interruptedReader.recoverOnStartup(), 1, "the interrupted run is requeued")
  await interruptedReader.sweep()
  const after = interruptedReader.listRuns("demo", source.id)
  assert.equal(
    after[0].status,
    "completed",
    `the requeued run completes on the new process (error: ${after[0].error ?? "none"})`
  )
})

test("a failed run retains the prior active version; success activates atomically", async () => {
  let healthy = true
  const setup = buildSetup()
  const sources = new SyncDataSourceService({
    db: setup.db,
    lifecycle: setup.lifecycle,
    fetchOptions: {
      resolver: async () => ({ addresses: ["93.184.216.34"] }),
      fetchImpl: (() =>
        healthy
          ? Promise.resolve(
              new Response("<html><title>P</title><body>稳定内容</body></html>", {
                status: 200,
                headers: { "content-type": "text/html" },
              })
            )
          : Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch,
    },
  })
  // The run service must use the SAME flaky fetch — one execution path.
  const runs = new SyncRunService({
    db: setup.db,
    lifecycle: setup.lifecycle,
    fetchOptions: {
      resolver: async () => ({ addresses: ["93.184.216.34"] }),
      fetchImpl: (() =>
        healthy
          ? Promise.resolve(
              new Response("<html><title>P</title><body>稳定内容</body></html>", {
                status: 200,
                headers: { "content-type": "text/html" },
              })
            )
          : Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch,
    },
  })
  const source = sources.create({
    tenantId: "demo",
    knowledgeBaseId: setup.kb.id,
    kind: "url",
    uri: "https://example.com/policy",
  })

  // First sync succeeds → the page is ACTIVE.
  const first = await runs.runNow("demo", source.id)
  assert.equal(first.status, "completed")
  const activeDocId = setup.activeRepo.getActiveDocIds()[0]
  assert.ok(activeDocId)

  // The remote page goes down → the run FAILS but the old active version is
  // retained and searchable.
  healthy = false
  const failed = await runs.runNow("demo", source.id)
  assert.equal(failed.status, "failed")
  assert.match(failed.error ?? "", /ECONNREFUSED/)
  assert.deepEqual(setup.activeRepo.getActiveDocIds(), [activeDocId])

  // Recovery → the next successful run completes again (same content → an
  // honest "unchanged"), and the source stays ACTIVE and searchable.
  healthy = true
  const recovered = await runs.runNow("demo", source.id)
  assert.equal(recovered.status, "completed")
  assert.ok(setup.activeRepo.getActiveDocIds().includes(activeDocId))
})
