/**
 * Ticket 39 (SYNC-01A) — URL/sitemap data sources and one safe sync.
 *
 * Acceptance criteria exercised here:
 *   1. Data sources store resource, target knowledge base, interval choice
 *      and lifecycle through the module-owned service (validation + tenant
 *      scoping).
 *   2. A manual sync reuses SAFE fetching (private-network deny) and the
 *      NORMAL ingestion lifecycle (real worker drain to active).
 *   3. Identical content returns "unchanged" without a duplicate version; a
 *      changed remote page becomes ONE new version of the same identity.
 *   4. Fetch failure/policy deny leaves the old active version searchable and
 *      records the failure honestly; a paused source refuses to run.
 */

import assert from "node:assert/strict"
import test from "node:test"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
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
import {
  InvalidSyncSourceError,
  SyncDataSourceService,
  SyncSourceNotFoundError,
} from "./data_source_service"

const EMBEDDING_PROFILE = "text-embedding-3-small:1536"

const STAGE_RUNNER_STUB: IngestionStageRunner = {
  close: async () => {},
  async run(_document, execution: StageExecution): Promise<void> {
    for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
      await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
    }
  },
}

interface RouteState {
  body: string
  contentType?: string
}

/** Synthetic fetch over a MUTABLE route map; unknown paths reject. */
function fetchRouter(routes: Record<string, RouteState>): typeof fetch {
  return ((input: unknown) => {
    const url = new URL(String(input))
    const route = routes[url.pathname]
    if (!route) return Promise.reject(new Error(`no synthetic route for ${url.pathname}`))
    return Promise.resolve(
      new Response(route.body, {
        status: 200,
        headers: { "content-type": route.contentType ?? "text/html; charset=utf-8" },
      })
    )
  }) as typeof fetch
}

interface Setup {
  db: DB
  lifecycle: IngestionLifecycle
  service: SyncDataSourceService
  repo: DocumentRepo
  activeRepo: ActiveVersionRepository
  kb: { id: string }
  context: AccessContext
}

function buildSetup(
  routes: Record<string, RouteState>,
  fetchOverrides: { resolver?: () => Promise<{ addresses: string[] }> } = {}
): Setup {
  const db = openDb(":memory:")
  const lifecycle = createIngestionLifecycle(db, {
    stageRunner: STAGE_RUNNER_STUB,
    activationMode: "auto",
  })
  const service = new SyncDataSourceService({
    db,
    lifecycle,
    fetchOptions: {
      resolver: fetchOverrides.resolver ?? (async () => ({ addresses: ["93.184.216.34"] })),
      fetchImpl: fetchRouter(routes),
    },
  })
  const kbService = new KnowledgeBaseServiceImpl(new SqliteKnowledgeBaseRepo(db), EMBEDDING_PROFILE)
  const kb = kbService.create("demo", "KB")
  return {
    db,
    lifecycle,
    service,
    repo: new DocumentRepo(db),
    activeRepo: new ActiveVersionRepository(db),
    kb,
    context: {
      ...singleTenantAccessContext(),
      tenantId: "demo",
      scopes: ["chat", "admin"],
      groups: [],
    },
  }
}

async function drain(lifecycle: IngestionLifecycle): Promise<void> {
  while (await lifecycle.runNext()) {
    // keep draining — the real worker path: claim → run → complete → activate
  }
}

test("create validates kind, uri and interval; reads are tenant-scoped", () => {
  const setup = buildSetup({})
  const source = setup.service.create({
    tenantId: "demo",
    knowledgeBaseId: setup.kb.id,
    kind: "url",
    uri: "https://example.com/policy",
    interval: "6h",
  })
  assert.equal(source.interval, "6h")
  assert.equal(source.state, "active")
  assert.throws(
    () =>
      setup.service.create({
        tenantId: "demo",
        knowledgeBaseId: setup.kb.id,
        kind: "ftp" as never,
        uri: "https://example.com/x",
      }),
    InvalidSyncSourceError
  )
  assert.throws(
    () =>
      setup.service.create({
        tenantId: "demo",
        knowledgeBaseId: setup.kb.id,
        kind: "url",
        uri: "not-a-url",
      }),
    InvalidSyncSourceError
  )
  assert.throws(
    () =>
      setup.service.create({
        tenantId: "demo",
        knowledgeBaseId: setup.kb.id,
        kind: "url",
        uri: "https://example.com/x",
        interval: "5h" as never,
      }),
    InvalidSyncSourceError
  )
  assert.throws(() => setup.service.get("other", source.id), SyncSourceNotFoundError)
  assert.equal(setup.service.list("demo", setup.kb.id).length, 1)
})

test("a manual URL sync ingests through the normal lifecycle to ACTIVE", async () => {
  const setup = buildSetup({
    "/policy": { body: "<html><title>报销政策</title><body>三个工作日到账</body></html>" },
  })
  const source = setup.service.create({
    tenantId: "demo",
    knowledgeBaseId: setup.kb.id,
    kind: "url",
    uri: "https://example.com/policy",
  })
  const report = await setup.service.runOnce("demo", source.id)
  assert.equal(report.pages.length, 1)
  assert.equal(report.pages[0].status, "submitted")
  await drain(setup.lifecycle)
  const doc = setup.repo.get(report.pages[0].documentId!)
  assert.match(doc!.content, /三个工作日到账/)
  assert.equal(doc!.mimeType, "text/plain", "HTML is reduced to plain text for ingestion")
  assert.ok(
    setup.activeRepo.getActiveDocIds().includes(report.pages[0].documentId!),
    "the synced page is an ACTIVE document — searchable like any other"
  )
  assert.match(setup.service.get("demo", source.id).lastSyncStatus ?? "", /submitted=1/)
})

test("identical content is unchanged with no duplicate version; changed content is one new version", async () => {
  const routes: Record<string, RouteState> = {
    "/policy": { body: "<html><title>P</title><body>稳定内容</body></html>" },
  }
  const setup = buildSetup(routes)
  const source = setup.service.create({
    tenantId: "demo",
    knowledgeBaseId: setup.kb.id,
    kind: "url",
    uri: "https://example.com/policy",
  })
  const first = await setup.service.runOnce("demo", source.id)
  await drain(setup.lifecycle)
  const second = await setup.service.runOnce("demo", source.id)
  await drain(setup.lifecycle)
  assert.equal(second.pages[0].status, "unchanged", "identical content is an honest no-op")
  const docId = first.pages[0].documentId!
  assert.equal(setup.repo.listVersionsBySource(setup.repo.get(docId)!.sourceId).length, 1)

  // The remote page changes → exactly ONE new version of the SAME identity.
  routes["/policy"] = { body: "<html><title>P</title><body>更新后的内容</body></html>" }
  const third = await setup.service.runOnce("demo", source.id)
  await drain(setup.lifecycle)
  assert.equal(third.pages[0].status, "submitted")
  const versions = setup.repo.listVersionsBySource(setup.repo.get(docId)!.sourceId)
  assert.equal(versions.length, 2, "one new version, not a detached document")
  assert.ok(setup.activeRepo.getActiveDocIds().includes(third.pages[0].documentId!))
})

test("a fetch failure submits nothing; the old active version stays searchable", async () => {
  const routes: Record<string, RouteState> = {
    "/policy": { body: "<html><title>P</title><body>旧的稳定内容</body></html>" },
  }
  const setup = buildSetup(routes)
  const source = setup.service.create({
    tenantId: "demo",
    knowledgeBaseId: setup.kb.id,
    kind: "url",
    uri: "https://example.com/policy",
  })
  const first = await setup.service.runOnce("demo", source.id)
  await drain(setup.lifecycle)
  const activeDocId = first.pages[0].documentId!

  // The remote page goes down.
  const failing = new SyncDataSourceService({
    db: setup.db,
    lifecycle: setup.lifecycle,
    fetchOptions: {
      resolver: async () => ({ addresses: ["93.184.216.34"] }),
      fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch,
    },
  })
  const report = await failing.runOnce("demo", source.id)
  assert.equal(report.pages[0].status, "failed")
  assert.match(report.pages[0].detail ?? "", /ECONNREFUSED/)
  await drain(setup.lifecycle)
  assert.ok(
    setup.activeRepo.getActiveDocIds().includes(activeDocId),
    "the previous active version is still the searchable one"
  )
  assert.match(failing.get("demo", source.id).lastSyncStatus ?? "", /failed=1/)
})

test("a private-network target is policy-denied before anything is fetched", async () => {
  const setup = buildSetup(
    { "/x": { body: "secret" } },
    { resolver: async () => ({ addresses: ["10.0.0.9"] }) }
  )
  const source = setup.service.create({
    tenantId: "demo",
    knowledgeBaseId: setup.kb.id,
    kind: "url",
    uri: "http://intranet.local/x",
  })
  const report = await setup.service.runOnce("demo", source.id)
  assert.equal(report.pages[0].status, "failed")
  assert.match(report.pages[0].detail ?? "", /policy denied/)
})

test("a sitemap source syncs bounded pages; a paused source refuses to run", async () => {
  const locs = [1, 2, 3]
    .map((i) => `<url><loc>https://cdn.example.com/page${i}</loc></url>`)
    .join("")
  const setup = buildSetup({
    "/sitemap.xml": {
      body: `<?xml version="1.0" encoding="UTF-8"?><urlset>${locs}</urlset>`,
      contentType: "application/xml",
    },
    "/page1": { body: "第一页内容", contentType: "text/plain" },
    "/page2": { body: "第二页内容", contentType: "text/plain" },
    "/page3": { body: "第三页内容", contentType: "text/plain" },
  })
  const source = setup.service.create({
    tenantId: "demo",
    knowledgeBaseId: setup.kb.id,
    kind: "sitemap",
    uri: "https://example.com/sitemap.xml",
  })
  const report = await setup.service.runOnce("demo", source.id)
  assert.equal(report.pages.length, 3)
  assert.ok(report.pages.every((page) => page.status === "submitted"))
  await drain(setup.lifecycle)
  assert.equal(setup.activeRepo.getActiveDocIds().length, 3)

  setup.service.update("demo", source.id, { state: "paused" })
  await assert.rejects(() => setup.service.runOnce("demo", source.id), InvalidSyncSourceError)

  // Interval choice updates through the operator lifecycle.
  const updated = setup.service.update("demo", source.id, { interval: "24h", state: "active" })
  assert.equal(updated.interval, "24h")
})
