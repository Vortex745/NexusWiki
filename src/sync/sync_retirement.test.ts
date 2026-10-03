/**
 * Ticket 41 (SYNC-02) — operate sync runs and confirm safe retirement.
 *
 * Acceptance criteria exercised here:
 *   1. List, detail and run-log views distinguish success, unchanged,
 *      timeout, rate limit and invalid URL (per-page status + machine
 *      -readable failure_kind, plus the summary breakdown).
 *   2. Pausing sync leaves imported content searchable (pause stops NEW
 *      syncs — scheduled and manual — and touches nothing already ingested).
 *   3. One temporary miss never retires content; two consecutive misses
 *      mark it pending retirement — and ONLY a complete (untruncated)
 *      sitemap read may fold into the missing-page ledger.
 *   4. Retirement requires explicit administrator confirmation, and only a
 *      page that is actually pending retirement can be confirmed.
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
import { ActiveVersionRepository } from "../ingestion/tracking/active_version_repo"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { KnowledgeBaseServiceImpl } from "../knowledge/knowledge_base_service"
import {
  classifyPageFailure,
  InvalidSyncSourceError,
  SyncDataSourceService,
  SyncPageNotFoundError,
  SyncPageRetirementConflictError,
  SyncSourceNotFoundError,
  type SyncPageFailureKind,
} from "./data_source_service"
import { SyncRunService } from "./sync_run_service"

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

interface RouteState {
  body?: string
  contentType?: string
  /** Respond with this HTTP status (default 200) — a real non-2xx path. */
  status?: number
  /** Reject the fetch with this error instead of resolving. */
  rejectWith?: Error
  /** Respond with a 3xx redirect to this location. */
  redirect?: string
}

/** Synthetic fetch over a MUTABLE route map; unknown paths reject. */
function fetchRouter(routes: Record<string, RouteState>): typeof fetch {
  return ((input: unknown) => {
    const url = new URL(String(input))
    const route = routes[url.pathname]
    if (!route) return Promise.reject(new Error(`no synthetic route for ${url.pathname}`))
    if (route.rejectWith) return Promise.reject(route.rejectWith)
    if (route.redirect) {
      return Promise.resolve(new Response(null, { status: 302, headers: { location: route.redirect } }))
    }
    return Promise.resolve(
      new Response(route.body, {
        status: route.status ?? 200,
        headers: { "content-type": route.contentType ?? "text/html; charset=utf-8" },
      })
    )
  }) as typeof fetch
}

interface Setup {
  db: DB
  lifecycle: IngestionLifecycle
  sources: SyncDataSourceService
  runs: SyncRunService
  activeRepo: ActiveVersionRepository
  kb: { id: string }
}

function buildSetup(
  routes: Record<string, RouteState>,
  overrides: { maxPagesPerRun?: number } = {}
): Setup {
  const db = openDb(":memory:")
  const lifecycle = createIngestionLifecycle(db, {
    stageRunner: activatingStageRunner(db, STAGE_RUNNER_STUB),
    activationMode: "auto",
  })
  const fetchOptions = {
    resolver: async () => ({ addresses: ["93.184.216.34"] }),
    fetchImpl: fetchRouter(routes),
  }
  const sources = new SyncDataSourceService({
    db,
    lifecycle,
    fetchOptions,
    ...(overrides.maxPagesPerRun !== undefined ? { maxPagesPerRun: overrides.maxPagesPerRun } : {}),
  })
  const runs = new SyncRunService({ db, lifecycle, fetchOptions })
  const kbService = new KnowledgeBaseServiceImpl(new SqliteKnowledgeBaseRepo(db), EMBEDDING_PROFILE)
  const kb = kbService.create("demo", "KB")
  return { db, lifecycle, sources, runs, activeRepo: new ActiveVersionRepository(db), kb }
}

function pageKind(page: { failureKind: SyncPageFailureKind | null } | undefined) {
  return page?.failureKind
}

function sitemapBody(pages: string[]): RouteState {
  return {
    body: `<?xml version="1.0"?><urlset>${pages
      .map((p) => `<url><loc>https://example.com/${p}</loc></url>`)
      .join("")}</urlset>`,
    contentType: "application/xml",
  }
}

test("the run-log distinguishes success, unchanged, timeout, rate limit and invalid URL", async () => {
  const routes: Record<string, RouteState> = {
    "/sitemap.xml": sitemapBody(["ok", "limited", "slow", "broken"]),
    "/ok": { body: "正常内容" },
    // A REAL 429 response — the classification must survive the fetcher's
    // own error message, not a hand-made string.
    "/limited": { body: "too many", status: 429 },
    "/slow": { body: "slow", rejectWith: new Error("fetch failed: timeout after 20000ms") },
    "/broken": { body: "broken", rejectWith: new Error("invalid redirect Location: %zz") },
  }
  const setup = buildSetup(routes)
  const source = setup.sources.create({
    tenantId: "demo",
    knowledgeBaseId: setup.kb.id,
    kind: "sitemap",
    uri: "https://example.com/sitemap.xml",
  })

  const first = await setup.runs.runNow("demo", source.id)
  assert.equal(first.status, "completed", `run error: ${first.error ?? "none"}`)
  assert.match(
    first.summary ?? "",
    /submitted=1 unchanged=0 failed=3 \(invalid_url=1 rate_limit=1 timeout=1\)/,
    "the summary headline carries the failure-kind breakdown"
  )

  const firstPages = setup.runs.listRunPages(first.id)
  assert.equal(firstPages.length, 4)
  const byUri = (uri: string) => firstPages.find((p) => p.uri.endsWith(uri))
  assert.equal(byUri("ok")?.status, "submitted")
  assert.equal(byUri("ok")?.failureKind, null)
  assert.equal(byUri("limited")?.status, "failed")
  assert.equal(pageKind(byUri("limited")), "rate_limit")
  assert.equal(pageKind(byUri("slow")), "timeout")
  assert.equal(pageKind(byUri("broken")), "invalid_url")

  // Second run with identical content: the run-log distinguishes UNCHANGED
  // from submitted, and the failing pages fail the same way again.
  const second = await setup.runs.runNow("demo", source.id)
  assert.equal(second.status, "completed")
  const okAgain = setup.runs.listRunPages(second.id).find((p) => p.uri.endsWith("ok"))
  assert.equal(okAgain?.status, "unchanged", "identical content is an honest no-op")
  assert.match(second.summary ?? "", /unchanged=1/)

  // Detail view: tenant-scoped read of one run (unknown = null).
  assert.ok(setup.runs.getRun("demo", source.id, first.id))
  assert.equal(setup.runs.getRun("other", source.id, first.id), null)
  assert.equal(setup.runs.getRun("demo", source.id, "no-such-run"), null)
})

test("pausing sync stops new runs but leaves imported content searchable", async () => {
  const routes: Record<string, RouteState> = {
    "/policy": { body: "<html><title>P</title><body>稳定内容</body></html>" },
  }
  const setup = buildSetup(routes)
  const source = setup.sources.create({
    tenantId: "demo",
    knowledgeBaseId: setup.kb.id,
    kind: "url",
    uri: "https://example.com/policy",
    interval: "1h",
  })
  const run = await setup.runs.runNow("demo", source.id)
  assert.equal(run.status, "completed")
  const activeDocId = setup.activeRepo.getActiveDocIds()[0]
  assert.ok(activeDocId, "the page is an active document before the pause")

  setup.sources.update("demo", source.id, { state: "paused" })

  // A manual trigger while paused fails honestly and touches nothing.
  const whilePaused = await setup.runs.runNow("demo", source.id)
  assert.equal(whilePaused.status, "failed")
  assert.match(whilePaused.error ?? "", /paused/)
  assert.deepEqual(setup.activeRepo.getActiveDocIds(), [activeDocId])
  assert.ok(
    setup.activeRepo.getActiveDocIds().includes(activeDocId),
    "imported content is still the searchable active version"
  )

  // The scheduler never enqueues a paused source, even when due.
  setup.db
    .prepare(`UPDATE sync_data_sources SET next_run_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`)
    .run(source.id)
  assert.equal(setup.runs.enqueueDueScheduled(), 0, "paused sources are not scheduled")
  assert.deepEqual(setup.activeRepo.getActiveDocIds(), [activeDocId])
})

test("one temporary miss never retires content; two misses mark it pending", async () => {
  const routes: Record<string, RouteState> = {
    "/sitemap.xml": sitemapBody(["a", "b", "c"]),
    "/a": { body: "页面A内容" },
    "/b": { body: "页面B内容" },
    "/c": { body: "页面C内容" },
  }
  const setup = buildSetup(routes)
  const source = setup.sources.create({
    tenantId: "demo",
    knowledgeBaseId: setup.kb.id,
    kind: "sitemap",
    uri: "https://example.com/sitemap.xml",
  })
  await setup.runs.runNow("demo", source.id)
  assert.equal(setup.activeRepo.getActiveDocIds().length, 3)
  const cDoc = setup.activeRepo.getActiveDocIds().find(() => true)
  const cLedger = () => setup.sources.listPages("demo", source.id).find((p) => p.uri.endsWith("/c"))!

  // First sync established the baseline: every page seen once, zero misses.
  assert.ok(cLedger())
  assert.equal(cLedger().missCount, 0)
  assert.equal(cLedger().retirementState, "none")

  // Sync 2: page c temporarily missing → ONE miss, content stays searchable.
  routes["/sitemap.xml"] = sitemapBody(["a", "b"])
  const second = await setup.runs.runNow("demo", source.id)
  assert.equal(second.status, "completed")
  assert.match(second.summary ?? "", /missing=1/, "the summary counts the missing page")
  const secondMissing = setup.runs
    .listRunPages(second.id)
    .find((p) => p.status === "missing" && p.uri.endsWith("/c"))
  assert.ok(secondMissing, "the run-log records the missing observation")
  assert.match(secondMissing.detail ?? "", /consecutive miss 1/)
  assert.doesNotMatch(secondMissing.detail ?? "", /pending/)
  assert.equal(cLedger().missCount, 1)
  assert.equal(cLedger().retirementState, "none")
  assert.ok(
    setup.activeRepo.getActiveDocIds().includes(cDoc!),
    "content is still searchable after one miss"
  )

  // Sync 3: the SECOND consecutive miss marks the page pending retirement.
  const third = await setup.runs.runNow("demo", source.id)
  assert.equal(third.status, "completed")
  const thirdMissing = setup.runs
    .listRunPages(third.id)
    .find((p) => p.status === "missing" && p.uri.endsWith("/c"))
  assert.ok(thirdMissing)
  assert.match(thirdMissing.detail ?? "", /pending retirement/)
  assert.equal(cLedger().missCount, 2)
  assert.equal(cLedger().retirementState, "pending_retirement")
  assert.ok(
    setup.activeRepo.getActiveDocIds().includes(cDoc!),
    "pending retirement does NOT retire the content by itself"
  )

  // The page returns → the miss counter resets and the pending mark clears.
  routes["/sitemap.xml"] = sitemapBody(["a", "b", "c"])
  await setup.runs.runNow("demo", source.id)
  assert.equal(cLedger().missCount, 0)
  assert.equal(cLedger().retirementState, "none", "a page that comes back is in good standing")
})

test("a truncated sitemap read never folds into the missing-page ledger", async () => {
  const routes: Record<string, RouteState> = {
    "/sitemap.xml": sitemapBody(["a", "b", "c"]),
    "/a": { body: "页面A内容" },
    "/b": { body: "页面B内容" },
    "/c": { body: "页面C内容" },
  }
  const setup = buildSetup(routes)
  const source = setup.sources.create({
    tenantId: "demo",
    knowledgeBaseId: setup.kb.id,
    kind: "sitemap",
    uri: "https://example.com/sitemap.xml",
  })
  // Seed the ledger with a full read (default window fits all three pages).
  await setup.runs.runNow("demo", source.id)
  assert.equal(setup.sources.listPages("demo", source.id).length, 3)

  // A capped window (2 of 3 pages) is a TRUNCATED listing — page c is still
  // in the real sitemap, so counting it missing would fabricate retirements.
  const capped = new SyncDataSourceService({
    db: setup.db,
    lifecycle: setup.lifecycle,
    fetchOptions: {
      resolver: async () => ({ addresses: ["93.184.216.34"] }),
      fetchImpl: fetchRouter(routes),
    },
    maxPagesPerRun: 2,
  })
  const report = await capped.runOnce("demo", source.id)
  assert.equal(report.truncated, true, "the report honestly notes the truncation")
  assert.equal(report.missing, undefined, "a truncated read observes NO missing pages")
  const cLedger = setup.sources.listPages("demo", source.id).find((p) => p.uri.endsWith("/c"))!
  assert.equal(cLedger.missCount, 0, "page c is not counted missing")
  assert.equal(cLedger.retirementState, "none")
})

test("a failed or garbage sitemap read leaves the ledger untouched", async () => {
  const routes: Record<string, RouteState> = {
    "/sitemap.xml": sitemapBody(["a", "b"]),
    "/a": { body: "页面A内容" },
    "/b": { body: "页面B内容" },
  }
  const setup = buildSetup(routes)
  const source = setup.sources.create({
    tenantId: "demo",
    knowledgeBaseId: setup.kb.id,
    kind: "sitemap",
    uri: "https://example.com/sitemap.xml",
  })
  await setup.runs.runNow("demo", source.id)
  const seeded = setup.sources.listPages("demo", source.id)
  assert.ok(seeded.every((p) => p.missCount === 0 && p.lastSeenAt))

  // The sitemap fetch fails → the run fails and NO ledger row moves.
  routes["/sitemap.xml"] = { body: "", rejectWith: new Error("ECONNREFUSED") }
  const failedRun = await setup.runs.runNow("demo", source.id)
  assert.equal(failedRun.status, "failed")
  assert.deepEqual(setup.sources.listPages("demo", source.id), seeded)

  // A 200 response that parses to ZERO URLs is a garbage read — equally
  // NOT an observation that every page vanished.
  routes["/sitemap.xml"] = { body: "<html>not a sitemap</html>", contentType: "application/xml" }
  const garbageRun = await setup.runs.runNow("demo", source.id)
  assert.equal(garbageRun.status, "failed")
  assert.match(garbageRun.error ?? "", /zero URLs/)
  assert.deepEqual(setup.sources.listPages("demo", source.id), seeded)
})

test("a redirecting page still links to its content for later retirement", async () => {
  const routes: Record<string, RouteState> = {
    "/sitemap.xml": sitemapBody(["r"]),
    "/r": { redirect: "/final" },
    "/final": { body: "重定向后的内容" },
  }
  const setup = buildSetup(routes)
  const source = setup.sources.create({
    tenantId: "demo",
    knowledgeBaseId: setup.kb.id,
    kind: "sitemap",
    uri: "https://example.com/sitemap.xml",
  })
  await setup.runs.runNow("demo", source.id)
  // The ledger is keyed by the LISTING URL; the content link must resolve
  // even though the page redirected to a different final URL.
  const ledger = setup.sources.listPages("demo", source.id).find((p) => p.uri.endsWith("/r"))!
  assert.ok(ledger, "the listing URL is tracked")
  assert.ok(ledger.ingestSourceId, "the redirecting page links to its ingestion source")
  assert.ok(ledger.documentId, "the redirecting page links to its document")
})

test("retirement requires explicit administrator confirmation of a pending page", async () => {
  const routes: Record<string, RouteState> = {
    "/sitemap.xml": sitemapBody(["a", "c"]),
    "/a": { body: "页面A内容" },
    "/c": { body: "页面C内容" },
  }
  const setup = buildSetup(routes)
  const source = setup.sources.create({
    tenantId: "demo",
    knowledgeBaseId: setup.kb.id,
    kind: "sitemap",
    uri: "https://example.com/sitemap.xml",
  })
  await setup.runs.runNow("demo", source.id)
  const cUri = setup.sources.listPages("demo", source.id).find((p) => p.uri.endsWith("/c"))!.uri

  // Two consecutive misses make c pending retirement.
  routes["/sitemap.xml"] = sitemapBody(["a"])
  await setup.runs.runNow("demo", source.id)
  await setup.runs.runNow("demo", source.id)
  assert.equal(
    setup.sources.listPages("demo", source.id).find((p) => p.uri === cUri)!.retirementState,
    "pending_retirement"
  )

  // Refusals: an unknown page (404), a page that is NOT pending (409), and
  // a cross-tenant caller (indistinguishable from an unknown source).
  assert.throws(
    () => setup.sources.confirmPageRetirement("demo", source.id, "https://example.com/unknown", "admin"),
    SyncPageNotFoundError
  )
  const aUri = setup.sources.listPages("demo", source.id).find((p) => p.uri.endsWith("/a"))!.uri
  assert.throws(
    () => setup.sources.confirmPageRetirement("demo", source.id, aUri, "admin"),
    (error: unknown) =>
      error instanceof SyncPageRetirementConflictError && /not pending/.test(error.message),
    "a page that never went missing cannot be retired"
  )
  assert.throws(
    () => setup.sources.confirmPageRetirement("other", source.id, cUri, "admin"),
    SyncSourceNotFoundError
  )

  // The explicit confirmation retires the CONTENT the safe way: the owning
  // ingestion source transitions to 'retired' with a tombstone and the
  // idempotent cleanup tasks (es / neo4j / pageindex / images).
  const confirmation = setup.sources.confirmPageRetirement("demo", source.id, cUri, "demo-admin")
  assert.equal(confirmation.uri, cUri)
  assert.equal(confirmation.lifecycleState, "retired")
  assert.ok(confirmation.tombstoneId)
  assert.equal(confirmation.enqueuedCleanupTasks, 4, "one cleanup task per op for the page's document")

  const ledger = setup.sources.listPages("demo", source.id).find((p) => p.uri === cUri)!
  assert.equal(ledger.retirementState, "retired", "the ledger records the confirmation")
  assert.throws(
    () => setup.sources.confirmPageRetirement("demo", source.id, cUri, "demo-admin"),
    SyncPageRetirementConflictError,
    "retirement is terminal — a retired page cannot be confirmed again"
  )
})

test("failure classification covers the fetcher's real error shapes", () => {
  assert.equal(classifyPageFailure(new Error("fetch failed: timeout after 30000ms")), "timeout")
  assert.equal(classifyPageFailure(new Error("body_read_timeout after 30000ms")), "timeout")
  assert.equal(classifyPageFailure(new Error("http 429 Too Many Requests")), "rate_limit")
  assert.equal(classifyPageFailure(new Error("fetch failed: http 429 Too Many Requests")), "rate_limit")
  assert.equal(classifyPageFailure(new Error("http 500 Internal Server Error")), "http_error")
  assert.equal(classifyPageFailure(new Error("invalid redirect Location: %zz")), "invalid_url")
  assert.equal(classifyPageFailure(new Error("ECONNREFUSED")), "network")
})
