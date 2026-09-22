import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
import { openDb, type DB } from "../ingestion/tracking/db"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { KnowledgeBaseServiceImpl } from "../knowledge/knowledge_base_service"
import { createDocumentsRouter } from "./documents"

/**
 * Ticket 11 (DOC-01A) — the knowledge-base document catalog HTTP contract.
 *
 * Acceptance criteria exercised here:
 *   1. Paginated + knowledge-scoped (tenant from the AccessContext; unknown or
 *      cross-tenant base = the same 404).
 *   2. Filters by processing state, tag and one-level folder; facets returned.
 *   3. Readers see authorized metadata (group visibility, ticket 10
 *      semantics); the route is read-only.
 *   4. Catalog rows never carry document content.
 */

const EMBEDDING_PROFILE = "text-embedding-3-small:1536"

function contextFor(tenantId: string, scopes: AccessContext["scopes"] = ["chat"]): AccessContext {
  return { ...singleTenantAccessContext(), tenantId, scopes, groups: ["demo-tech"] }
}

interface TestSetup {
  db: DB
  app: express.Express
  repo: DocumentRepo
  service: KnowledgeBaseServiceImpl
}

function buildApp(
  options: { tenantId?: string; scopes?: AccessContext["scopes"]; db?: DB } = {}
): TestSetup {
  const db = options.db ?? openDb(":memory:")
  const repo = new DocumentRepo(db)
  const service = new KnowledgeBaseServiceImpl(new SqliteKnowledgeBaseRepo(db), EMBEDDING_PROFILE)
  const app = express()
  app.use(express.json())
  app.use((_req, res, next) => {
    res.locals.accessContext = contextFor(options.tenantId ?? "demo", options.scopes)
    next()
  })
  app.use("/api", createDocumentsRouter({ documentRepo: repo, knowledgeBaseService: service }))
  return { db, app, repo, service }
}

async function listen(app: express.Express) {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

async function request(
  port: number,
  path: string
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`)
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null }
}

interface SeedOptions {
  tenantId?: string
  knowledgeBaseId?: string
  title: string
  status?: "pending" | "completed" | "failed" | "cancelled"
  metadata?: Record<string, unknown>
  allowedGroups?: string[]
  activate?: boolean
}

// Monotonic creation timestamps: documents created in the same millisecond
// tie-break by doc_id, which would make "newest first" assertions flaky.
let seedSeq = 0

function seed(setup: TestSetup, options: SeedOptions): string {
  const tenantId = options.tenantId ?? "demo"
  const kbId = options.knowledgeBaseId ?? `kb-test-${Math.random().toString(16).slice(2, 8)}`
  const source = setup.repo.createSource({
    sourceId: `src-${Math.random().toString(16).slice(2, 8)}`,
    sourceKey: `key-${Math.random().toString(16).slice(2, 8)}`,
    kind: "submission",
    uri: `uri-${Math.random().toString(16).slice(2, 8)}`,
    namespace: "test",
    tenantId,
    allowedGroups: options.allowedGroups ?? [],
    knowledgeBaseId: kbId,
  })
  const docId = `doc-${Math.random().toString(16).slice(2, 8)}`
  setup.repo.insert({
    docId,
    sourceId: source.sourceId,
    contentHash: `hash-${docId}`,
    version: 1,
    title: options.title,
    source: "api",
    content: `CONTENT-OF-${options.title}`,
    tenantId,
    allowedGroups: options.allowedGroups ?? [],
    knowledgeBaseId: kbId,
    ...(options.metadata ? { metadata: options.metadata } : {}),
  })
  if (options.status && options.status !== "pending") {
    setup.repo.updateStatus(docId, options.status)
  }
  if (options.activate) {
    setup.repo.activate(docId)
  }
  const createdAt = new Date(Date.parse("2026-01-01T00:00:00.000Z") + (seedSeq++) * 1000).toISOString()
  setup.db.prepare("UPDATE documents SET created_at = ?, updated_at = ? WHERE doc_id = ?")
    .run(createdAt, createdAt, docId)
  return docId
}

test("Ticket 11: the catalog is paginated, knowledge-scoped and carries no content", async () => {
  const setup = buildApp()
  try {
    setup.service.ensureDefault("demo")
    const kb = setup.service.create("demo", "Docs")
    for (let i = 1; i <= 25; i += 1) {
      seed(setup, { knowledgeBaseId: kb.id, title: `Doc ${String(i).padStart(2, "0")}`, activate: true })
    }
    // A foreign-tenant document in a foreign base must never leak.
    seed(setup, { tenantId: "other", knowledgeBaseId: "kb-other", title: "Foreign" })

    const { server, port } = await listen(setup.app)
    try {
      const page1 = await request(port, `/knowledge-bases/${kb.id}/documents?page=1&pageSize=10`)
      assert.equal(page1.status, 200)
      assert.equal(page1.json?.total, 25)
      assert.equal((page1.json?.documents as unknown[]).length, 10)
      assert.equal(page1.json?.page, 1)
      for (const doc of page1.json?.documents as Array<Record<string, unknown>>) {
        assert.equal(doc.content, undefined, "no content in the catalog")
        assert.equal(doc.rawContent, undefined)
      }
      // Newest first — deterministic because the seed stamps distinct times.
      const titles = (page1.json?.documents as Array<{ title: string }>).map((d) => d.title)
      assert.deepEqual(titles, ["Doc 25", "Doc 24", "Doc 23", "Doc 22", "Doc 21", "Doc 20", "Doc 19", "Doc 18", "Doc 17", "Doc 16"])

      const page3 = await request(port, `/knowledge-bases/${kb.id}/documents?page=3&pageSize=10`)
      assert.equal((page3.json?.documents as unknown[]).length, 5)

      // Unknown and cross-tenant bases are the same 404.
      assert.equal((await request(port, "/knowledge-bases/kb-nope/documents")).status, 404)
      assert.equal((await request(port, "/knowledge-bases/kb-other/documents")).status, 404)
    } finally {
      server.close()
    }
  } finally {
    setup.db.close()
  }
})

test("Ticket 11: filters by status, tag and folder, with facets over the visible rows", async () => {
  const setup = buildApp({ scopes: ["chat", "admin"] })
  try {
    setup.service.ensureDefault("demo")
    const kb = setup.service.create("demo", "Docs")
    seed(setup, { knowledgeBaseId: kb.id, title: "A", status: "completed", metadata: { tags: ["policy", "hr"], folder: "HR" }, activate: true })
    seed(setup, { knowledgeBaseId: kb.id, title: "B", status: "failed", metadata: { tags: ["policy"], folder: "IT" } })
    seed(setup, { knowledgeBaseId: kb.id, title: "C", status: "completed", metadata: { folder: "HR" } })
    seed(setup, { knowledgeBaseId: kb.id, title: "D", status: "pending" })

    const { server, port } = await listen(setup.app)
    try {
      const all = await request(port, `/knowledge-bases/${kb.id}/documents`)
      assert.equal(all.status, 200)
      assert.equal(all.json?.total, 4)
      assert.deepEqual(all.json?.tags, ["hr", "policy"])
      assert.deepEqual(all.json?.folders, ["HR", "IT"])

      const byStatus = await request(port, `/knowledge-bases/${kb.id}/documents?status=completed`)
      assert.equal(byStatus.json?.total, 2)

      const byTag = await request(port, `/knowledge-bases/${kb.id}/documents?tag=policy`)
      assert.equal(byTag.json?.total, 2)

      const byFolder = await request(port, `/knowledge-bases/${kb.id}/documents?folder=IT`)
      assert.equal(byFolder.json?.total, 1)
      assert.equal((byFolder.json?.documents as Array<{ title: string }>)[0]?.title, "B")

      const combined = await request(port, `/knowledge-bases/${kb.id}/documents?status=completed&tag=policy&folder=HR`)
      assert.equal(combined.json?.total, 1)
      assert.equal((combined.json?.documents as Array<{ title: string }>)[0]?.title, "A")

      // Invalid filter values are 400, not silent empty pages.
      assert.equal((await request(port, `/knowledge-bases/${kb.id}/documents?status=bogus`)).status, 400)
      assert.equal((await request(port, `/knowledge-bases/${kb.id}/documents?pageSize=0`)).status, 400)
      assert.equal((await request(port, `/knowledge-bases/${kb.id}/documents?pageSize=101`)).status, 400)
    } finally {
      server.close()
    }
  } finally {
    setup.db.close()
  }
})

test("Ticket 11: readers see only group-authorized metadata; admins see all; read-only", async () => {
  const setup = buildApp({ scopes: ["chat"] }) // viewer groups: ["demo-tech"]
  try {
    setup.service.ensureDefault("demo")
    const kb = setup.service.create("demo", "Docs")
    seed(setup, { knowledgeBaseId: kb.id, title: "TenantWide", allowedGroups: [], activate: true })
    seed(setup, { knowledgeBaseId: kb.id, title: "TechOnly", allowedGroups: ["demo-tech"] })
    seed(setup, { knowledgeBaseId: kb.id, title: "PolicyOnly", allowedGroups: ["demo-policy"], metadata: { tags: ["secret"] } })

    const { server, port } = await listen(setup.app)
    try {
      const reader = await request(port, `/knowledge-bases/${kb.id}/documents`)
      assert.equal(reader.status, 200)
      const readerTitles = (reader.json?.documents as Array<{ title: string }>).map((d) => d.title)
      assert.ok(readerTitles.includes("TenantWide"), "tenant-wide rows are visible")
      assert.ok(readerTitles.includes("TechOnly"), "own-group rows are visible")
      assert.ok(!readerTitles.includes("PolicyOnly"), "other-group rows are invisible")
      // Facets respect the same visibility: "secret" belongs to an
      // other-group row and must not leak into the reader's filter options.
      assert.deepEqual(reader.json?.tags, [])

      // The same rows through an admin context (same db): the admin sees all.
      const adminSetup = buildApp({ scopes: ["chat", "admin"], db: setup.db })
      const { server: server2, port: port2 } = await listen(adminSetup.app)
      try {
        const admin = await request(port2, `/knowledge-bases/${kb.id}/documents`)
        assert.equal(admin.json?.total, 3, "the admin sees every row")
        assert.deepEqual(admin.json?.tags, ["secret"])
      } finally {
        server2.close()
      }

      // The route is read-only: only GET exists — a POST/DELETE to the same
      // path cannot mutate anything.
      const postRes = await fetch(`http://127.0.0.1:${port}/api/knowledge-bases/${kb.id}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "nope" }),
      })
      assert.equal(postRes.status, 404, "no write route exists")
    } finally {
      server.close()
    }
  } finally {
    setup.db.close()
  }
})
