import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
import { openDb, type DB } from "../ingestion/tracking/db"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import { PageIndexRepository } from "../ingestion/tracking/page_index_repo"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { KnowledgeBaseServiceImpl } from "../knowledge/knowledge_base_service"
import { createDocumentsRouter, type ChunkReader, type ChunkViewDoc } from "./documents"

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
  options: {
    tenantId?: string
    scopes?: AccessContext["scopes"]
    db?: DB
    chunkReader?: ChunkReader
  } = {}
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
  app.use("/api", createDocumentsRouter({
    documentRepo: repo,
    knowledgeBaseService: service,
    pageIndexRepo: new PageIndexRepository(db),
    ...(options.chunkReader ? { chunkReader: options.chunkReader } : {}),
  }))
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
  mimeType?: string
  rawContent?: Buffer
  content?: string
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
    content: options.content ?? `CONTENT-OF-${options.title}`,
    tenantId,
    allowedGroups: options.allowedGroups ?? [],
    knowledgeBaseId: kbId,
    ...(options.mimeType ? { mimeType: options.mimeType } : {}),
    ...(options.rawContent ? { rawContent: options.rawContent } : {}),
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

test("Ticket 11: catalog rows expose adoption and the activation hold reason", async () => {
  const setup = buildApp()
  try {
    setup.service.ensureDefault("demo")
    const kb = setup.service.create("demo", "Docs")
    const held = seed(setup, { knowledgeBaseId: kb.id, title: "Held", status: "completed" })
    setup.repo.recordActivationBlock(held, "activation_content_proof_pending_review")
    const adopted = seed(setup, {
      knowledgeBaseId: kb.id,
      title: "Adopted",
      status: "completed",
      activate: true,
    })

    const { server, port } = await listen(setup.app)
    try {
      const body = await request(port, `/knowledge-bases/${kb.id}/documents`)
      const rows = body.json?.documents as Array<Record<string, unknown>>
      const heldRow = rows.find((row) => row.docId === held)
      const adoptedRow = rows.find((row) => row.docId === adopted)
      // A completed candidate the gate denied is NOT adopted: the record read
      // needs the reason to render 待校验 instead of ✅.
      assert.equal(heldRow?.activationBlockReason, "activation_content_proof_pending_review")
      assert.equal(heldRow?.active, false)
      assert.equal(adoptedRow?.activationBlockReason, null)
      assert.equal(adoptedRow?.active, true)
    } finally {
      server.close()
    }
  } finally {
    setup.db.close()
  }
})

test("Ticket 11: the active filter returns only the usable version and a matching total", async () => {
  const setup = buildApp()
  try {
    setup.service.ensureDefault("demo")
    const kb = setup.service.create("demo", "Docs")
    seed(setup, { knowledgeBaseId: kb.id, title: "Active", status: "completed", activate: true })
    seed(setup, { knowledgeBaseId: kb.id, title: "Failed", status: "failed" })
    seed(setup, { knowledgeBaseId: kb.id, title: "Held", status: "completed" })

    const { server, port } = await listen(setup.app)
    try {
      const usable = await request(port, `/knowledge-bases/${kb.id}/documents?active=true`)
      assert.equal(usable.status, 200)
      // The sidebar tree filters server-side: the failed and held candidates
      // are not "documents the base can answer from", and the total must not
      // count them either.
      assert.equal(usable.json?.total, 1)
      assert.deepEqual(
        (usable.json?.documents as Array<{ title: string }>).map((doc) => doc.title),
        ["Active"],
      )
      const inactive = await request(port, `/knowledge-bases/${kb.id}/documents?active=false`)
      assert.equal(inactive.json?.total, 2)
      assert.equal((await request(port, `/knowledge-bases/${kb.id}/documents?active=bogus`)).status, 400)
    } finally {
      server.close()
    }
  } finally {
    setup.db.close()
  }
})

test("A deleted (retired) document leaves the catalog: rows, total and facets", async () => {
  const setup = buildApp({ scopes: ["chat", "admin"] })
  try {
    setup.service.ensureDefault("demo")
    const kb = setup.service.create("demo", "Docs")
    seed(setup, { knowledgeBaseId: kb.id, title: "A", status: "completed", metadata: { tags: ["policy"], folder: "HR" }, activate: true })
    const gone = seed(setup, { knowledgeBaseId: kb.id, title: "B", status: "completed", metadata: { tags: ["legal"], folder: "IT" }, activate: true })
    seed(setup, { knowledgeBaseId: kb.id, title: "C", status: "completed" })

    // The catalog's delete action is the source retirement command; the rows
    // survive (tombstone + citation traceability) but must stop being listed.
    const { server, port } = await listen(setup.app)
    try {
      const before = await request(port, `/knowledge-bases/${kb.id}/documents`)
      assert.equal(before.json?.total, 3)
      assert.deepEqual(before.json?.tags, ["legal", "policy"])
      assert.deepEqual(before.json?.folders, ["HR", "IT"])

      setup.db.prepare("UPDATE sources SET lifecycle_state = 'retired' WHERE source_id = ?")
        .run(setup.repo.get(gone)!.sourceId)

      const after = await request(port, `/knowledge-bases/${kb.id}/documents`)
      assert.equal(after.status, 200)
      assert.equal(after.json?.total, 2, "the deleted document is out of the count")
      assert.deepEqual(
        (after.json?.documents as Array<{ title: string }>).map((doc) => doc.title),
        ["C", "A"],
        "newest first, and the deleted one is gone",
      )
      // A facet that only the deleted document carried would offer a filter
      // that always answers "no documents match".
      assert.deepEqual(after.json?.tags, ["policy"])
      assert.deepEqual(after.json?.folders, ["HR"])
      for (const doc of after.json?.documents as Array<Record<string, unknown>>) {
        assert.equal(doc.retired, false, "every listed row is live")
      }

      // The version view stays reachable for a citation from a past answer.
      assert.equal((await request(port, `/documents/${gone}`)).status, 200)

      // Deleting every remaining row empties the catalog without breaking it.
      setup.db.prepare("UPDATE sources SET lifecycle_state = 'retired'").run()
      const emptied = await request(port, `/knowledge-bases/${kb.id}/documents`)
      assert.equal(emptied.json?.total, 0)
      assert.deepEqual(emptied.json?.documents, [])
      assert.deepEqual(emptied.json?.tags, [])
      assert.deepEqual(emptied.json?.folders, [])
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
    const policyDocId = seed(setup, {
      knowledgeBaseId: kb.id,
      title: "PolicyOnly",
      allowedGroups: ["demo-policy"],
      metadata: { tags: ["secret"] },
    })

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

      // Ticket 13 (DOC-02): the version view and preview obey the same doc
      // group rule — a doc invisible in the catalog is invisible here too.
      assert.equal((await request(port, `/documents/${policyDocId}`)).status, 404)
      assert.equal((await request(port, `/documents/${policyDocId}/preview`)).status, 404)
    } finally {
      server.close()
    }
  } finally {
    setup.db.close()
  }
})

function makeChunkReader(chunks: Array<Partial<ChunkViewDoc> & { id: string }>): ChunkReader {
  const docs = chunks.map((chunk) => ({
    id: chunk.id,
    documentId: chunk.documentId ?? "doc",
    kind: chunk.kind ?? "child",
    content: chunk.content ?? "",
    parentId: chunk.parentId ?? null,
    allowedGroups: chunk.allowedGroups ?? [],
    metadata: chunk.metadata ?? {},
  })) as ChunkViewDoc[]
  return {
    async get(documentId, chunkId) {
      return docs.find((doc) => doc.documentId === documentId && doc.id === chunkId) ?? null
    },
    async listChildChunks(documentId) {
      return docs.filter((doc) => doc.documentId === documentId && doc.kind === "child")
    },
  }
}

test("Ticket 13 DOC-02: the version view shows exact version, sections and preview", async () => {
  const setup = buildApp()
  try {
    setup.service.ensureDefault("demo")
    const kb = setup.service.create("demo", "Docs")
    const docId = seed(setup, { knowledgeBaseId: kb.id, title: "Policy", activate: true })
    setup.db.prepare(
      `INSERT INTO page_index_nodes (
        document_id, node_id, title, section_path, page_start, page_end,
        summary, parent_id, child_ids, linked_chunk_ids
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '[]', '[]')`
    ).run(docId, "n1", "退款政策", JSON.stringify(["第一章", "退款"]), 3, 4, "summary")

    const { server, port } = await listen(setup.app)
    try {
      const detail = await request(port, `/documents/${docId}`)
      assert.equal(detail.status, 200)
      const document = detail.json?.document as Record<string, unknown>
      assert.equal(document.version, 1)
      assert.equal(document.active, true)
      assert.equal(document.retired, false)
      assert.equal(document.mimeType, "text/plain")
      const sections = detail.json?.sections as Array<Record<string, unknown>>
      assert.equal(sections.length, 1)
      assert.deepEqual(sections[0].sectionPath, ["第一章", "退款"])
      assert.equal(sections[0].pageStart, 3)

      const preview = await request(port, `/documents/${docId}/preview`)
      assert.equal(preview.status, 200)
      assert.equal(preview.json?.available, true)
      assert.match(String(preview.json?.text), /CONTENT-OF-Policy/)

      // Unknown and cross-tenant doc ids are the same 404.
      assert.equal((await request(port, "/documents/does-not-exist")).status, 404)
      const foreign = seed(setup, { tenantId: "other", knowledgeBaseId: "kb-other", title: "Foreign" })
      assert.equal((await request(port, `/documents/${foreign}`)).status, 404)
    } finally {
      server.close()
    }
  } finally {
    setup.db.close()
  }
})

test("Ticket 13 DOC-02: HTML preview strips markup; unavailable capability is reported, not blank", async () => {
  const setup = buildApp({
    chunkReader: makeChunkReader([]),
  })
  try {
    setup.service.ensureDefault("demo")
    const kb = setup.service.create("demo", "Docs")
    const htmlDoc = seed(setup, {
      knowledgeBaseId: kb.id,
      title: "Web page",
      mimeType: "text/html",
      content: "",
      rawContent: Buffer.from("<html><body><p>退货政策 7 天</p><script>evil()</script></body></html>"),
    })
    const pdfDoc = seed(setup, {
      knowledgeBaseId: kb.id,
      title: "Scanned PDF",
      mimeType: "application/pdf",
      content: "",
      rawContent: Buffer.from("%PDF-1.4 binary"),
      activate: true,
    })

    const { server, port } = await listen(setup.app)
    try {
      const htmlPreview = await request(port, `/documents/${htmlDoc}/preview`)
      assert.equal(htmlPreview.json?.available, true)
      assert.match(String(htmlPreview.json?.text), /退货政策 7 天/)
      assert.doesNotMatch(String(htmlPreview.json?.text), /<p>|script/)

      const pdfPreview = await request(port, `/documents/${pdfDoc}/preview`)
      assert.equal(pdfPreview.json?.available, false, "no silent blank preview")
      assert.match(String(pdfPreview.json?.reason), /OCR|文本层/)
      assert.equal(pdfPreview.json?.text, undefined)
    } finally {
      server.close()
    }
  } finally {
    setup.db.close()
  }
})

test("Ticket 13 DOC-02: chunk views carry metadata and neighbors; retired stays traceable", async () => {
  const setup = buildApp()
  try {
    setup.service.ensureDefault("demo")
    const kb = setup.service.create("demo", "Docs")
    const docId = seed(setup, { knowledgeBaseId: kb.id, title: "Policy", activate: true })
    const chunks: Array<Partial<ChunkViewDoc> & { id: string }> = [
      { id: "c0", documentId: docId, content: "first", metadata: { index: 0, kind: "child" } },
      { id: "c1", documentId: docId, content: "middle", metadata: { index: 1, kind: "child", page: 5, sectionPath: ["第一章"] } },
      { id: "c2", documentId: docId, content: "last", metadata: { index: 2, kind: "child" } },
      // A group-restricted chunk of the same doc that this viewer cannot see.
      { id: "secret", documentId: docId, content: "secret", allowedGroups: ["demo-policy"], metadata: { index: 5 } },
    ]
    const appSetup = buildApp({ db: setup.db, chunkReader: makeChunkReader(chunks) })

    const { server, port } = await listen(appSetup.app)
    try {
      const view = await request(port, `/documents/${docId}/chunks/c1`)
      assert.equal(view.status, 200)
      const chunk = view.json?.chunk as Record<string, unknown>
      assert.equal(chunk.index, 1)
      assert.equal(chunk.page, 5)
      assert.deepEqual(chunk.sectionPath, ["第一章"])
      assert.equal(chunk.content, "middle")
      const neighbors = view.json?.neighbors as Array<{ chunkId: string }>
      assert.deepEqual(neighbors.map((n) => n.chunkId), ["c0", "c2"])

      // Missing chunk → 410 but the document stays traceable.
      const missing = await request(port, `/documents/${docId}/chunks/nope`)
      assert.equal(missing.status, 410)
      assert.equal((missing.json?.document as Record<string, unknown>).title, "Policy")

      // Retire the source: the version view survives (traceability), the
      // chunk text answers 410, and nothing re-enters retrieval.
      setup.db.prepare(
        `UPDATE sources SET lifecycle_state = 'retired' WHERE source_id = (
          SELECT source_id FROM documents WHERE doc_id = ?)`
      ).run(docId)
      const detail = await request(port, `/documents/${docId}`)
      assert.equal(detail.status, 200, "historic citations stay traceable after retirement")
      assert.equal((detail.json?.document as Record<string, unknown>).retired, true)
      const retiredPreview = await request(port, `/documents/${docId}/preview`)
      assert.equal(retiredPreview.json?.available, true, "SQLite text still previews")
      const retiredChunk = await request(port, `/documents/${docId}/chunks/c1`)
      assert.equal(retiredChunk.status, 200, "chunk index still holds the text until cleanup")
    } finally {
      server.close()
    }
  } finally {
    setup.db.close()
  }
})

test("document detail exposes processingPolicy and nulls candidateState for the new policy", async () => {
  const setup = buildApp()
  try {
    const docId = seed(setup, {
      title: "DocReader document",
      status: "completed",
      metadata: { system: { ingestionPolicy: { version: "weknora-technical-v1" } } },
    })
    const legacyId = seed(setup, { title: "Legacy document", status: "completed" })
    const { server, port } = await listen(setup.app)
    try {
      const current = await request(port, `/documents/${docId}`)
      assert.equal(current.status, 200)
      const document = current.json?.document as Record<string, unknown>
      assert.equal(document.processingPolicy, "weknora-technical-v1")
      assert.equal(document.candidateState, null)

      const legacy = await request(port, `/documents/${legacyId}`)
      assert.equal(legacy.status, 200)
      const legacyDocument = legacy.json?.document as Record<string, unknown>
      assert.equal(legacyDocument.processingPolicy, null)
      assert.equal(legacyDocument.candidateState, "approved")
    } finally {
      server.close()
    }
  } finally {
    setup.db.close()
  }
})
