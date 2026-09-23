/**
 * Ticket 42 (DEMO-01A) — seed and reset a deterministic demo namespace.
 *
 * Acceptance criteria exercised here:
 *   1. Seed uses deterministic identifiers and content digests and is
 *      idempotent when content is unchanged.
 *   2. Reset prints an exact preview and requires explicit --confirm
 *      (a preview writes nothing; a confirmed run without a complete
 *      inventory refuses).
 *   3. Reset matches only the fixed demo namespace across SQLite,
 *      Elasticsearch and Neo4j — the ES cleanup is a tenant-scoped
 *      delete_by_query, never an index deletion; only the namespace's
 *      provenance is stripped.
 *   4. Repeated seed/reset leaves unrelated data (another tenant) and
 *      workspace files untouched.
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import type { IngestionLifecycle, IngestionStageRunner, StageExecution } from "../ingestion/lifecycle"
import { createIngestionLifecycle } from "../ingestion/pipeline"
import { openDb, type DB } from "../ingestion/tracking/db"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import { SqliteFaqEntryRepo } from "../faq/faq_entry_repo"
import {
  DEMO_NAMESPACE_ES_INDEX,
  resetDemoNamespace,
  type DemoNamespaceClients,
} from "./demo_namespace"
import {
  DEMO_ADMIN_SUBJECT_ID,
  DEMO_FAQ_ENTRIES,
  DEMO_POLICY_KB_ID,
  DEMO_POLICY_DOCUMENTS,
  DEMO_PROJECT_DOCUMENTS,
  DEMO_PROJECT_KB_ID,
  demoDocumentDigest,
  seedDemoNamespace,
} from "./demo_seed"

const EMBEDDING_PROFILE = "text-embedding-3-small:1536"

const STAGE_RUNNER_STUB: IngestionStageRunner = {
  close: async () => {},
  async run(_document, execution: StageExecution): Promise<void> {
    for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
      await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
    }
  },
}

/** In-memory ES stand-in that evaluates ONLY the tenant term filter. */
function fakeEs(initial: Array<{ id: string; tenantId: string }> = []) {
  const documents = new Map(initial.map((doc) => [doc.id, { ...doc }]))
  const deleteByQueryCalls: Array<{ index: string; query: unknown }> = []
  let indexExists = true
  const tenantOf = (query: unknown): string | undefined => {
    const term = (query as { term?: { tenantId?: string } } | undefined)?.term
    return term?.tenantId
  }
  return {
    documents,
    deleteByQueryCalls,
    setIndexExists(value: boolean) {
      indexExists = value
    },
    client: {
      async exists(request: { index: string }) {
        if (request.index !== DEMO_NAMESPACE_ES_INDEX) return false
        return indexExists
      },
      async count(request: { index: string; query?: unknown }) {
        if (request.index !== DEMO_NAMESPACE_ES_INDEX) throw new Error(`unknown index ${request.index}`)
        const tenant = tenantOf(request.query)
        let n = 0
        for (const doc of documents.values()) {
          if (!tenant || doc.tenantId === tenant) n += 1
        }
        return { count: n }
      },
      async deleteByQuery(request: { index: string; query: unknown }) {
        if (request.index !== DEMO_NAMESPACE_ES_INDEX) throw new Error(`unknown index ${request.index}`)
        deleteByQueryCalls.push({ index: request.index, query: request.query })
        const tenant = tenantOf(request.query)
        assert.ok(tenant, "the namespace reset MUST scope the delete by tenant")
        let deleted = 0
        for (const [id, doc] of [...documents]) {
          if (doc.tenantId === tenant) {
            documents.delete(id)
            deleted += 1
          }
        }
        return { deleted }
      },
    },
  }
}

function fakeGraph(tenants: string[]) {
  const stripped: string[] = []
  return {
    stripped,
    client: {
      async listProvenanceTenants() {
        return [...tenants]
      },
      async stripProvenance(tenantId: string) {
        stripped.push(tenantId)
      },
    },
  }
}

interface Setup {
  db: DB
  lifecycle: IngestionLifecycle
  es: ReturnType<typeof fakeEs>
  graph: ReturnType<typeof fakeGraph>
  clients: DemoNamespaceClients
  workspaceFile: string
}

function buildSetup(): Setup {
  const db = openDb(":memory:")
  const lifecycle = createIngestionLifecycle(db, {
    stageRunner: STAGE_RUNNER_STUB,
    activationMode: "auto",
  })
  // The stub stage runner writes no chunks — stand in the ES documents the
  // REAL pipeline would have written: one per seeded demo document plus the
  // unrelated tenant's. The reset tests pin the SCOPING of the ES operation.
  const es = fakeEs([
    ...DEMO_PROJECT_DOCUMENTS.map((doc, i) => ({ id: `demo-es-${i}`, tenantId: "demo" })),
    ...DEMO_POLICY_DOCUMENTS.map((doc, i) => ({ id: `demo-es-p-${i}`, tenantId: "demo" })),
    { id: "other-es-0", tenantId: "other-tenant" },
  ])
  const graph = fakeGraph(["demo", "other-tenant"])
  const clients: DemoNamespaceClients = {
    db,
    es: es.client,
    graph: graph.client,
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-namespace-"))
  const workspaceFile = path.join(dir, "workspace-file.txt")
  fs.writeFileSync(workspaceFile, "unrelated workspace content", "utf8")
  return { db, lifecycle, es, graph, clients, workspaceFile }
}

/** Unrelated data in ANOTHER tenant — the reset must never touch it. */
function seedUnrelatedTenant(setup: Setup): void {
  setup.db
    .prepare(
      `INSERT INTO knowledge_bases (id, tenant_id, name, description, status, embedding_profile, created_at, updated_at)
       VALUES ('kb-other', 'other-tenant', 'Other KB', '', 'active', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    )
    .run(EMBEDDING_PROFILE)
  setup.lifecycle.submit({
    title: "别人的文档",
    content: "其他租户的文档内容",
    mimeType: "text/plain",
    knowledgeBaseId: "kb-other",
    versionIntent: "new_document",
    sourceIdentity: {
      kind: "url",
      uriOrExternalId: "https://other.example/doc",
      namespace: "other",
      tenantId: "other-tenant",
    },
  })
}

async function seed(setup: Setup) {
  return seedDemoNamespace({
    db: setup.db,
    lifecycle: setup.lifecycle,
    embeddingProfile: EMBEDDING_PROFILE,
  })
}

test("the seed is deterministic and idempotent over unchanged content", async () => {
  const setup = buildSetup()
  const first = await seed(setup)

  // Deterministic identifiers: the two fixed knowledge bases, every seeded
  // slug, digests that match the published content.
  assert.deepEqual(
    first.knowledgeBases.map((base) => base.id),
    [DEMO_PROJECT_KB_ID, DEMO_POLICY_KB_ID]
  )
  assert.ok(first.knowledgeBases.every((base) => base.created))
  assert.deepEqual(
    first.documents.map((doc) => doc.slug),
    [...DEMO_PROJECT_DOCUMENTS, ...DEMO_POLICY_DOCUMENTS].map((doc) => doc.slug)
  )
  for (const doc of first.documents) {
    assert.equal(doc.contentDigest, demoDocumentDigest(doc.slug))
    assert.equal(doc.outcome, "submitted")
  }
  assert.deepEqual(
    first.faqEntries.map((faq) => faq.question),
    DEMO_FAQ_ENTRIES.map((faq) => faq.question)
  )
  assert.ok(first.memories[0].created)

  // The documents are ACTIVE after the seed (lifecycle drained to activation).
  const activeDocs = new DocumentRepo(setup.db)
  const docRow = activeDocs.get(first.documents[0].documentId)
  assert.ok(docRow, "the seeded document exists")

  // Second seed over unchanged content: NOTHING is created twice.
  const second = await seed(setup)
  assert.ok(second.knowledgeBases.every((base) => !base.created))
  assert.ok(second.documents.every((doc) => doc.outcome === "unchanged"))
  assert.ok(second.faqEntries.every((faq) => !faq.created))
  assert.ok(second.memories.every((memory) => !memory.created))
  // One version per source — no duplicate versions from the re-seed.
  const versions = activeDocs.listVersionsBySource(activeDocs.get(first.documents[0].documentId)!.sourceId)
  assert.equal(versions.length, 1, "a re-seed over unchanged content creates no version")
})

test("the reset preview lists exact targets and writes nothing", async () => {
  const setup = buildSetup()
  await seed(setup)
  seedUnrelatedTenant(setup)
  const docsBefore = setup.db.prepare(`SELECT COUNT(*) AS n FROM documents`).get() as { n: number }

  const preview = await resetDemoNamespace(setup.clients, "demo", { confirm: false })

  assert.equal(preview.executed, false)
  assert.equal(preview.cleanup, undefined)
  // The preview names the exact namespace-owned rows: the documents table
  // holds 7 rows (6 demo + 1 unrelated) but the listing counts only 6.
  const documents = preview.inventory.sqliteTables.find((t) => t.table === "documents")
  assert.equal(documents?.rows, 6, "only the demo namespace's documents are listed")
  assert.ok(documents && documents.rows < docsBefore.n, "unrelated rows are not part of the listing")
  assert.equal(preview.inventory.esIndex.documents, 6, "ES count is scoped to the namespace")
  assert.equal(preview.inventory.neo4jProvenanceOwned, true)

  // Nothing was written anywhere.
  const docsAfter = setup.db.prepare(`SELECT COUNT(*) AS n FROM documents`).get() as { n: number }
  assert.equal(docsAfter.n, docsBefore.n)
  assert.equal(setup.es.deleteByQueryCalls.length, 0)
  assert.equal(setup.graph.stripped.length, 0)
})

test("a confirmed reset clears only the demo namespace across all three layers", async () => {
  const setup = buildSetup()
  await seed(setup)
  seedUnrelatedTenant(setup)
  const otherDocsBefore = setup.db
    .prepare(`SELECT COUNT(*) AS n FROM documents WHERE tenant_id = 'other-tenant'`)
    .get() as { n: number }

  const report = await resetDemoNamespace(setup.clients, "demo", { confirm: true })

  assert.equal(report.executed, true)
  assert.ok(report.cleanup)

  // SQLite: the namespace's rows are gone; the other tenant's are intact.
  const demoDocs = setup.db
    .prepare(`SELECT COUNT(*) AS n FROM documents WHERE tenant_id = 'demo'`)
    .get() as { n: number }
  assert.equal(demoDocs.n, 0)
  const demoKbs = setup.db
    .prepare(`SELECT COUNT(*) AS n FROM knowledge_bases WHERE tenant_id = 'demo'`)
    .get() as { n: number }
  assert.equal(demoKbs.n, 0)
  const demoMemories = setup.db
    .prepare(`SELECT COUNT(*) AS n FROM long_term_memories WHERE tenant_id = 'demo'`)
    .get() as { n: number }
  assert.equal(demoMemories.n, 0)
  const orphanedTasks = setup.db
    .prepare(
      `SELECT COUNT(*) AS n FROM task_pending_ops
       WHERE doc_id NOT IN (SELECT doc_id FROM documents)`
    )
    .get() as { n: number }
  assert.equal(orphanedTasks.n, 0, "join-scoped task rows were cleared with their documents")
  const otherDocs = setup.db
    .prepare(`SELECT COUNT(*) AS n FROM documents WHERE tenant_id = 'other-tenant'`)
    .get() as { n: number }
  assert.equal(otherDocs.n, otherDocsBefore.n, "the other tenant's documents are untouched")
  const otherKb = setup.db
    .prepare(`SELECT COUNT(*) AS n FROM knowledge_bases WHERE tenant_id = 'other-tenant'`)
    .get() as { n: number }
  assert.equal(otherKb.n, 1, "the other tenant's knowledge base is untouched")

  // Elasticsearch: ONE tenant-scoped delete_by_query — never an index delete.
  assert.equal(setup.es.deleteByQueryCalls.length, 1)
  const call = setup.es.deleteByQueryCalls[0]
  assert.equal(call.index, DEMO_NAMESPACE_ES_INDEX, "the shared index is never dropped")
  assert.deepEqual(call.query, { term: { tenantId: "demo" } })
  const otherInEs = [...setup.es.documents.values()].filter(
    (doc) => doc.tenantId === "other-tenant"
  )
  assert.equal(otherInEs.length, 1, "the other tenant's ES documents survive")

  // Neo4j: exactly the namespace's provenance was stripped.
  assert.deepEqual(setup.graph.stripped, ["demo"])

  // Workspace files are untouched.
  assert.equal(fs.existsSync(setup.workspaceFile), true)
  assert.equal(fs.readFileSync(setup.workspaceFile, "utf8"), "unrelated workspace content")
})

test("a confirmed reset refuses when a layer cannot be inventoried", async () => {
  const setup = buildSetup()
  await seed(setup)
  const broken: DemoNamespaceClients = {
    db: setup.db,
    es: setup.es.client,
    graph: {
      listProvenanceTenants: async () => {
        throw new Error("neo4j unavailable")
      },
      stripProvenance: async () => {},
    },
  }

  const report = await resetDemoNamespace(broken, "demo", { confirm: true })

  assert.equal(report.executed, false)
  assert.match(report.refusedReason ?? "", /neo4j unavailable/)
  const docs = setup.db
    .prepare(`SELECT COUNT(*) AS n FROM documents WHERE tenant_id = 'demo'`)
    .get() as { n: number }
  assert.equal(docs.n, 6, "nothing was deleted when the inventory was incomplete")
  assert.equal(setup.es.deleteByQueryCalls.length, 0)
})

test("a repeated seed/reset cycle rebuilds the same namespace and leaves others alone", async () => {
  const setup = buildSetup()
  seedUnrelatedTenant(setup)

  const firstSeed = await seed(setup)
  await resetDemoNamespace(setup.clients, "demo", { confirm: true })
  const secondSeed = await seed(setup)

  // The cycle reproduces the same digests and the same document count.
  assert.deepEqual(
    secondSeed.documents.map((doc) => [doc.slug, doc.contentDigest]),
    firstSeed.documents.map((doc) => [doc.slug, doc.contentDigest])
  )
  const demoDocs = setup.db
    .prepare(`SELECT COUNT(*) AS n FROM documents WHERE tenant_id = 'demo'`)
    .get() as { n: number }
  assert.equal(demoDocs.n, 6)
  // The unrelated tenant survived the whole cycle.
  const otherDocs = setup.db
    .prepare(`SELECT COUNT(*) AS n FROM documents WHERE tenant_id = 'other-tenant'`)
    .get() as { n: number }
  assert.equal(otherDocs.n, 1)
  assert.equal(setup.graph.stripped.filter((tenant) => tenant === "other-tenant").length, 0)
})

test("a seed whose ingestion cannot complete fails loudly instead of faking success", async () => {
  const db = openDb(":memory:")
  const failingLifecycle = createIngestionLifecycle(db, {
    stageRunner: {
      close: async () => {},
      async run(_document, execution: StageExecution) {
        // The chunk stage always fails (e.g. the embedding service is down).
        await execution.runStage("chunk", {}, async () => {
          throw new Error("embedding service unavailable")
        }, () => ({ stage: "chunk" }))
      },
    },
    activationMode: "auto",
  })

  await assert.rejects(
    () =>
      seedDemoNamespace({
        db,
        lifecycle: failingLifecycle,
        embeddingProfile: EMBEDDING_PROFILE,
      }),
    /seed ingestion/,
    "the seed must surface ingestion failure, never report success"
  )
})

test("a disabled seed FAQ entry is skipped on re-seed, not collided with", async () => {
  const setup = buildSetup()
  await seed(setup)

  // The operator disables one seeded FAQ entry (a legitimate demo action).
  const faqRepo = new SqliteFaqEntryRepo(setup.db)
  const entry = faqRepo.listByKnowledgeBase("demo", DEMO_POLICY_KB_ID)[0]
  assert.ok(entry)
  faqRepo.setStatus(entry.id, "demo", "disabled", new Date().toISOString())

  // The re-seed must NOT explode on the deterministic id — the row exists
  // (disabled) and is left exactly as the operator left it.
  const second = await seed(setup)
  assert.ok(
    second.faqEntries.every((faq) => !faq.created),
    "existing rows (any status) are skipped"
  )
  const after = faqRepo.getEntry(entry.id, "demo")
  assert.equal(after?.status, "disabled", "the operator's disable is preserved")
})

test("a missing Elasticsearch index inventories as zero documents, not an error", async () => {
  const setup = buildSetup()
  await seed(setup)
  seedUnrelatedTenant(setup)
  setup.es.setIndexExists(false)

  const preview = await resetDemoNamespace(setup.clients, "demo", { confirm: false })
  assert.equal(preview.inventory.esIndex.documents, 0, "missing index = no chunk documents")
  assert.equal(preview.inventory.errors.length, 0, "a missing index is NOT an inventory error")

  // A confirmed reset over the missing index also works (deletes nothing).
  const report = await resetDemoNamespace(setup.clients, "demo", { confirm: true })
  assert.equal(report.executed, true)
  assert.equal(report.cleanup?.esIndex.deleted, 0)
  assert.equal(report.cleanup?.esIndex.error, undefined)
})
