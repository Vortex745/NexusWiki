/**
 * Ticket 02 (KB-01) — knowledge-base domain + deterministic default + the
 * one-time demo-data rebuild.
 *
 * Acceptance criteria exercised here:
 *   1. Empty and repeated startup create exactly one default knowledge base
 *      per tenant.
 *   2. Knowledge bases support active and archived states without deleting
 *      workspace or database files.
 *   3. Legacy requests without a knowledge-base field resolve to the tenant
 *      default rather than all knowledge bases.
 *   4. The rebuild path lists exact SQLite, Elasticsearch and Neo4j targets
 *      before any data-layer cleanup.
 */
import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { Client } from "@elastic/elasticsearch"
import { openDb, type DB } from "../ingestion/tracking/db"
import { defaultKnowledgeBaseId } from "../types/knowledge_base"
import { SqliteKnowledgeBaseRepo } from "./knowledge_base_repo"
import {
  InvalidKnowledgeBaseScopeError,
  KnowledgeBaseNotFoundError,
  KnowledgeBaseServiceImpl,
} from "./knowledge_base_service"
import {
  DEMO_REBUILD_ES_INDEXES,
  DEMO_REBUILD_SQLITE_TABLES,
  runDemoRebuild,
  type DemoRebuildGraph,
} from "./demo_rebuild"

const EMBEDDING_PROFILE = "text-embedding-3-small:1536"

function serviceFor(db: DB, now?: () => Date): KnowledgeBaseServiceImpl {
  return new KnowledgeBaseServiceImpl(
    new SqliteKnowledgeBaseRepo(db),
    EMBEDDING_PROFILE,
    now
  )
}

function countRows(db: DB, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n
}

function tableExists(db: DB, table: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table) !== undefined
  )
}

/** Minimal Elasticsearch stand-in: index existence, document count, delete. */
function fakeEs(indexes: Record<string, number>): {
  client: Client
  deleted: string[]
} {
  const deleted: string[] = []
  const client = {
    indices: {
      exists: async ({ index }: { index: string }) => index in indexes,
      delete: async ({ index }: { index: string }) => {
        if (!(index in indexes)) {
          throw Object.assign(new Error("index_not_found_exception"), {
            meta: { statusCode: 404 },
          })
        }
        deleted.push(index)
        delete indexes[index]
      },
    },
    count: async ({ index }: { index: string }) => ({
      count: indexes[index] ?? 0,
    }),
  } as unknown as Client
  return { client, deleted }
}

function fakeGraph(tenants: string[]): DemoRebuildGraph & { stripped: string[] } {
  const stripped: string[] = []
  return {
    listProvenanceTenants: async () => [...tenants],
    stripProvenance: async (tenantId: string) => {
      stripped.push(tenantId)
    },
    stripped,
  }
}

test("the default knowledge-base id is deterministic per tenant", () => {
  assert.equal(defaultKnowledgeBaseId("demo"), "kb-default-demo")
  assert.equal(defaultKnowledgeBaseId("demo"), defaultKnowledgeBaseId("demo"))
  assert.notEqual(defaultKnowledgeBaseId("demo"), defaultKnowledgeBaseId("default"))
})

test("an empty and a repeated startup create exactly one default per tenant", () => {
  const db = openDb(":memory:")
  const service = serviceFor(db)

  const created = service.ensureDefault("demo")
  assert.equal(created.id, defaultKnowledgeBaseId("demo"))
  assert.equal(created.tenantId, "demo")
  assert.equal(created.status, "active")
  assert.equal(created.embeddingProfile, EMBEDDING_PROFILE)

  // Repeated startup: same instance, then a fresh instance (a restarted
  // process) reading the same database.
  service.ensureDefault("demo")
  serviceFor(db).ensureDefault("demo")

  assert.equal(service.list("demo").length, 1)
  assert.equal(countRows(db, "knowledge_bases"), 1)
})

test("each tenant owns its own default and cannot read another tenant's", () => {
  const db = openDb(":memory:")
  const service = serviceFor(db)

  const demo = service.ensureDefault("demo")
  const other = service.ensureDefault("other")

  assert.notEqual(demo.id, other.id)
  assert.equal(service.getById(demo.id, "other"), null)
  assert.equal(service.getById(other.id, "demo"), null)
  assert.deepEqual(
    service.list("demo").map((kb) => kb.id),
    [demo.id]
  )
})

test("archive and activate change status only — no row, file or table is lost", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-lifecycle-"))
  const dbPath = path.join(dir, "kefu-rag.db")
  const assetDir = path.join(dir, "image-assets")
  fs.mkdirSync(assetDir, { recursive: true })
  const asset = path.join(assetDir, "logo.png")
  fs.writeFileSync(asset, "png")

  const db = openDb(dbPath)
  try {
    const service = serviceFor(db)
    // Ticket 08 (KB-04): the DEFAULT knowledge base can no longer be archived
    // (every omitted selection resolves to it), so the lifecycle subject is a
    // created base.
    service.ensureDefault("demo")
    const kb = service.create("demo", "Policies")

    const archived = service.archive(kb.id, "demo")
    assert.equal(archived?.status, "archived")
    assert.equal(service.getById(kb.id, "demo")?.status, "archived")
    assert.equal(service.list("demo").length, 2)

    // Nothing was removed: the row, the database file and the workspace file
    // all survive archiving.
    assert.equal(countRows(db, "knowledge_bases"), 2)
    assert.equal(fs.existsSync(dbPath), true)
    assert.equal(fs.existsSync(asset), true)

    assert.equal(service.activate(kb.id, "demo")?.status, "active")
    // Unknown id and another tenant's id are indistinguishable (→ 404).
    assert.equal(service.archive(kb.id, "other"), null)
    assert.equal(service.archive("kb-missing", "demo"), null)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a request without a knowledge-base field resolves to the default, never to all", () => {
  const db = openDb(":memory:")
  const service = serviceFor(db)
  const fallback = service.ensureDefault("demo")
  const second = {
    ...fallback,
    id: "kb-policies",
    name: "Policies",
  }
  new SqliteKnowledgeBaseRepo(db).insertIfAbsent(second)

  // Missing field → exactly the default, not every knowledge base.
  assert.deepEqual(service.resolveScope("demo"), {
    knowledgeBaseIds: [fallback.id],
  })
  assert.equal(service.list("demo").length, 2)

  // An explicit empty array is "no knowledge context", not "all".
  assert.deepEqual(service.resolveScope("demo", []), { knowledgeBaseIds: [] })

  // Explicit ids are de-duplicated in the order given.
  assert.deepEqual(service.resolveScope("demo", [second.id, second.id, fallback.id]), {
    knowledgeBaseIds: [second.id, fallback.id],
  })

  // Illegal and cross-tenant ids fail loudly instead of widening the scope.
  assert.throws(
    () => service.resolveScope("demo", ["kb-missing"]),
    KnowledgeBaseNotFoundError
  )
  assert.throws(
    () => service.resolveScope("other", [fallback.id]),
    KnowledgeBaseNotFoundError
  )
  assert.throws(
    () => service.resolveScope("demo", [""]),
    InvalidKnowledgeBaseScopeError
  )

  // A tenant that only appears now gets its default through the same path.
  assert.deepEqual(service.resolveScope("fresh"), {
    knowledgeBaseIds: [defaultKnowledgeBaseId("fresh")],
  })
  assert.equal(service.list("fresh").length, 1)
})

test("a dry run lists the exact targets and deletes nothing", async () => {
  const db = openDb(":memory:")
  const service = serviceFor(db)
  service.ensureDefault("demo")
  const es = fakeEs({ [DEMO_REBUILD_ES_INDEXES[0]]: 42 })
  const graph = fakeGraph(["demo"])

  const report = await runDemoRebuild({ db, es: es.client, graph }, { confirm: false })

  assert.equal(report.executed, false)
  assert.equal(report.cleanup, undefined)
  // The listing covers the whole schema: a table added to the SCHEMA but not
  // to the rebuild's target list would survive a "full" rebuild silently.
  assert.deepEqual(
    [...DEMO_REBUILD_SQLITE_TABLES].sort(),
    (
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
  )
  assert.equal(
    report.inventory.sqliteTables.find((target) => target.table === "knowledge_bases")
      ?.rows,
    1
  )
  assert.deepEqual(report.inventory.esIndexes, [
    { index: DEMO_REBUILD_ES_INDEXES[0], exists: true, documents: 42 },
  ])
  assert.deepEqual(report.inventory.neo4jProvenanceTenants, ["demo"])
  assert.deepEqual(report.inventory.knowledgeBaseTenants, ["demo"])
  assert.deepEqual(report.inventory.errors, [])

  // Read-only: nothing was deleted anywhere.
  assert.deepEqual(es.deleted, [])
  assert.deepEqual(graph.stripped, [])
  assert.equal(service.list("demo").length, 1)
})

test("a confirmed rebuild clears exactly the listed targets and removes no file or table", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-rebuild-"))
  const dbPath = path.join(dir, "kefu-rag.db")
  const assetDir = path.join(dir, "image-assets")
  fs.mkdirSync(assetDir, { recursive: true })
  const asset = path.join(assetDir, "logo.png")
  fs.writeFileSync(asset, "png")

  const db = openDb(dbPath)
  try {
    const service = serviceFor(db)
    service.ensureDefault("demo")
    db.prepare(
      `INSERT INTO session_bindings (session_id, tenant_id, subject_id, created_at)
       VALUES ('s1', 'demo', 'local', '2026-09-22T00:00:00.000Z')`
    ).run()
    const es = fakeEs({ [DEMO_REBUILD_ES_INDEXES[0]]: 42 })
    const graph = fakeGraph(["demo"])

    const report = await runDemoRebuild({ db, es: es.client, graph }, { confirm: true })

    assert.equal(report.executed, true)
    assert.deepEqual(es.deleted, [DEMO_REBUILD_ES_INDEXES[0]])
    assert.deepEqual(graph.stripped, ["demo"])
    assert.equal(countRows(db, "knowledge_bases"), 0)
    assert.equal(countRows(db, "session_bindings"), 0)

    // Data-layer cleanup only: the table, the database file and the workspace
    // file all survive.
    assert.equal(tableExists(db, "knowledge_bases"), true)
    assert.equal(fs.existsSync(dbPath), true)
    assert.equal(fs.existsSync(asset), true)

    // The rebuild leaves the tenants it found with their deterministic default.
    const recreated = serviceFor(db).ensureDefault("demo")
    assert.equal(recreated.id, defaultKnowledgeBaseId("demo"))
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a confirmed rebuild refuses when a layer could not be inventoried", async () => {
  const db = openDb(":memory:")
  const service = serviceFor(db)
  service.ensureDefault("demo")
  const es = fakeEs({ [DEMO_REBUILD_ES_INDEXES[0]]: 1 })
  const graph: DemoRebuildGraph = {
    listProvenanceTenants: async () => {
      throw new Error("neo4j unreachable")
    },
    stripProvenance: async () => undefined,
  }

  const report = await runDemoRebuild({ db, es: es.client, graph }, { confirm: true })

  assert.equal(report.executed, false)
  assert.equal(report.cleanup, undefined)
  assert.match(report.refusedReason ?? "", /neo4j unreachable/)
  assert.deepEqual(es.deleted, [])
  assert.equal(service.list("demo").length, 1)
})

test("a confirmed rebuild refuses when Elasticsearch cannot be inventoried", async () => {
  const db = openDb(":memory:")
  const service = serviceFor(db)
  service.ensureDefault("demo")
  const es = {
    indices: {
      exists: async () => {
        throw new Error("es unreachable")
      },
      delete: async () => {
        throw new Error("delete must not be reached")
      },
    },
    count: async () => ({ count: 0 }),
  } as unknown as Client
  const graph = fakeGraph(["demo"])

  const report = await runDemoRebuild({ db, es, graph }, { confirm: true })

  assert.equal(report.executed, false)
  assert.match(report.refusedReason ?? "", /es unreachable/)
  assert.deepEqual(graph.stripped, [])
  assert.equal(service.list("demo").length, 1)
})

test("evaluation scopes are not rebuild targets", async () => {
  const db = openDb(":memory:")
  serviceFor(db).ensureDefault("demo")
  const es = fakeEs({ [DEMO_REBUILD_ES_INDEXES[0]]: 1 })
  const graph = fakeGraph(["demo", "eval-abc12345"])

  const report = await runDemoRebuild({ db, es: es.client, graph }, { confirm: true })

  assert.deepEqual(report.inventory.neo4jProvenanceTenants, ["demo"])
  assert.deepEqual(graph.stripped, ["demo"])
})
