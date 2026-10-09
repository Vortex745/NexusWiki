import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Client } from "@elastic/elasticsearch"
import type { Driver } from "neo4j-driver"
import { openDb } from "../ingestion/tracking/db"
import type { Document } from "../types"
import { ArtifactCleanupService } from "./cleanup"

const document: Document = {
  id: "doc-1", sourceId: "source-1", contentHash: "hash", version: 1,
  title: "Doc", source: "doc.pdf", content: "", metadata: {},
  createdAt: new Date(0), tenantId: "tenant-a", knowledgeBaseId: "kb-a",
}

test("ES cleanup records generated image references before deleting scoped chunks", async () => {
  const db = openDb(":memory:")
  const assetPath = `${"a".repeat(64)}.png`
  let deleteQuery: unknown
  const es = {
    indices: { exists: async () => true },
    search: async () => ({ hits: { hits: [{ _source: {
      metadata: { image: { assetPath } },
    } }] } }),
    deleteByQuery: async (query: unknown) => { deleteQuery = query; return { deleted: 1 } },
  } as unknown as Client
  try {
    await new ArtifactCleanupService(db, { es }).run("cleanup_es", document)
    assert.deepEqual(db.prepare(`SELECT asset_path FROM cleanup_image_assets
      WHERE document_id = ?`).all(document.id), [{ asset_path: assetPath }])
    assert.deepEqual((deleteQuery as { query: { bool: { filter: unknown[] } } })
      .query.bool.filter, [
      { term: { documentId: "doc-1" } },
      { term: { tenantId: "tenant-a" } },
      { term: { knowledgeBaseId: "kb-a" } },
    ])
  } finally {
    db.close()
  }
})

test("graph cleanup removes exact provenance in one write transaction and limits orphan deletion", async () => {
  const db = openDb(":memory:")
  const removed = JSON.stringify([document.id, "chunk-1", "tenant-a", [], 0.9, "kb-a"])
  const shared = JSON.stringify(["doc-2", "chunk-2", "tenant-b", [], 0.4, "kb-b"])
  const lookalike = JSON.stringify(["doc-10", "chunk-3", "tenant-a", [], 0.7, "kb-a"])
  const records = [
    { id: "shared", provenance: [removed, shared], weight: 0.9, sourceId: "a", targetId: "b" },
    { id: "exclusive", provenance: [removed], weight: 0.9, sourceId: "c", targetId: "d" },
    { id: "lookalike", provenance: [lookalike], weight: 0.7, sourceId: "x", targetId: "y" },
  ]
  const calls: Array<{ query: string; args: Record<string, unknown> }> = []
  let writes = 0
  let closed = false
  const graph = { session: () => ({
    executeWrite: async (action: (tx: unknown) => Promise<void>) => {
      writes++
      await action({ run: async (query: string, args: Record<string, unknown>) => {
        calls.push({ query, args })
        return { records: calls.length === 1 ? records.map((row) => ({
          get: (key: keyof typeof row) => row[key],
        })) : [] }
      } })
    },
    close: async () => { closed = true },
  }) } as unknown as Driver
  try {
    await new ArtifactCleanupService(db, { graph }).run("cleanup_neo4j", document)
    assert.equal(writes, 1)
    assert.ok(closed)
    assert.ok(calls[0].query.includes("SET r._cleanup_lock"))
    const update = calls.find((call) => call.args.id === "shared")!
    assert.deepEqual(update.args, { id: "shared", provenance: [shared], weight: 0.4 })
    assert.ok(calls.find((call) => call.args.id === "exclusive")?.query.includes("DELETE r"))
    assert.ok(calls.find((call) => call.args.id === "lookalike")?.query.includes("REMOVE r._cleanup_lock"))
    assert.deepEqual(calls.at(-1)?.args, { ids: ["a", "b", "c", "d"] })
    assert.ok(calls.at(-1)?.query.includes("NOT (e)--()"))
  } finally { db.close() }
})

test("page-index cleanup deletes only the retired document's nodes", async () => {
  const db = openDb(":memory:")
  try {
    const insert = db.prepare(`INSERT INTO page_index_nodes
      (document_id, node_id, title, section_path, summary)
      VALUES (?, ?, 'title', '[]', 'summary')`)
    insert.run("doc-1", "node-1")
    insert.run("doc-2", "node-2")
    await new ArtifactCleanupService(db).run("cleanup_pageindex", document)
    assert.deepEqual(db.prepare("SELECT document_id FROM page_index_nodes").all(),
      [{ document_id: "doc-2" }])
  } finally {
    db.close()
  }
})

test("image cleanup keeps globally shared assets and removes only unreferenced generated images", async () => {
  const db = openDb(":memory:")
  const root = await mkdtemp(join(tmpdir(), "wiki-image-cleanup-"))
  const shared = `${"b".repeat(64)}.png`
  const orphan = `${"c".repeat(64)}.png`
  const original = "original-upload.pdf"
  const queries: unknown[] = []
  const es = {
    indices: { exists: async () => true },
    count: async (query: unknown) => {
      queries.push(query)
      return { count: JSON.stringify(query).includes(shared) ? 1 : 0 }
    },
  } as unknown as Client
  try {
    for (const name of [shared, orphan, original]) await writeFile(join(root, name), "bytes")
    for (const path of [shared, orphan]) db.prepare(`INSERT INTO cleanup_image_assets
      (document_id, asset_path) VALUES (?, ?)`).run(document.id, path)
    await new ArtifactCleanupService(db, { es, imageAssetPath: root })
      .run("cleanup_images", document)
    assert.equal(await readFile(join(root, shared), "utf8"), "bytes")
    assert.equal(await readFile(join(root, original), "utf8"), "bytes")
    await assert.rejects(readFile(join(root, orphan)), { code: "ENOENT" })
    assert.equal(db.prepare("SELECT * FROM cleanup_image_assets").all().length, 0)
    assert.ok(queries.every((query) => !JSON.stringify(query).includes("tenantId")))
    assert.ok(JSON.stringify(queries).includes("metadata.normalizedBlocks.image.assetPath"))
  } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})

test("image cleanup retains retry inventory when shared references cannot be checked", async () => {
  const db = openDb(":memory:")
  const es = { indices: { exists: async () => false } } as unknown as Client
  try {
    db.prepare("INSERT INTO cleanup_image_assets (document_id, asset_path) VALUES (?, ?)")
      .run(document.id, `${"d".repeat(64)}.png`)
    await assert.rejects(new ArtifactCleanupService(db, { es }).run("cleanup_images", document),
      /cannot verify shared image references/)
    assert.equal(db.prepare("SELECT * FROM cleanup_image_assets").all().length, 1)
  } finally { db.close() }
})

test("cleanup inventories and removes only selected-index chunks", async () => {
  const db = openDb(":memory:")
  const byIndex = new Map([ ["kefu-rag-chunks", ["legacy"]], ["selected-v2", ["selected"]] ])
  const calls: string[] = []
  const es = {
    indices: {exists: async ({index}: {index: string}) => {calls.push(index); return true}},
    search: async ({index}: {index: string}) => {calls.push(index); return {hits: {hits: []}}},
    deleteByQuery: async ({index}: {index: string}) => {calls.push(index); byIndex.set(index, []); return {deleted: 1}},
  } as unknown as Client
  try {
    await new ArtifactCleanupService(db, {es, indexName: "selected-v2"}).run("cleanup_es", document)
    assert.deepEqual(byIndex.get("kefu-rag-chunks"), ["legacy"])
    assert.deepEqual(byIndex.get("selected-v2"), [])
    assert.deepEqual(calls, ["selected-v2", "selected-v2", "selected-v2"])
  } finally {db.close()}
})

test("image reference verification uses the selected index before preserving shared assets", async () => {
  const db = openDb(":memory:")
  const indices: string[] = []
  const asset = `${"e".repeat(64)}.png`
  db.prepare("INSERT INTO cleanup_image_assets (document_id, asset_path) VALUES (?, ?)").run(document.id, asset)
  const es = {
    indices: {exists: async ({index}: {index: string}) => {indices.push(index); return true}},
    count: async ({index}: {index: string}) => {indices.push(index); return {count: index === "selected-v2" ? 1 : 0}},
  } as unknown as Client
  try {
    await new ArtifactCleanupService(db, {es, indexName: "selected-v2", imageAssetPath: "unused-assets"}).run("cleanup_images", document)
    assert.deepEqual(indices, ["selected-v2", "selected-v2"])
    assert.equal(db.prepare("SELECT * FROM cleanup_image_assets").all().length, 0)
  } finally {db.close()}
})
