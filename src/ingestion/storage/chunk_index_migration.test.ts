import test from "node:test"
import assert from "node:assert/strict"
import type { Client } from "@elastic/elasticsearch"
import { migrateChunkIndex } from "./chunk_index_migration"

function cluster(options: { corrupt?: boolean; targetExists?: boolean; reindexFails?: boolean } = {}) {
  const source = [{ _id: "one", _routing: "tenant", _source: {
    text: "preserve this exact body", tenantId: "tenant", embedding: [0.25, 0.5],
    metadata: { normalizedBlocks: [{ metadata: { fontSize: 12.5 }, boundingBox: [0.5, 2, 3, 4] }] },
  } }]
  const state = { sourceLocked: false, targetLocked: false, target: [] as typeof source, created: false }
  const mappings = { properties: { embedding: { type: "dense_vector", dims: 2 }, metadata: { type: "object", properties: { normalizedBlocks: { properties: { metadata: { properties: { fontSize: { type: "long" } } } } } } } } }
  const client = {
    indices: {
      exists: async ({ index }: { index: string }) => index === "source" || Boolean(options.targetExists),
      getMapping: async ({ index }: { index: string }) => ({ [index]: { mappings } }),
      getSettings: async () => ({ source: { settings: { index: { uuid: "do-not-copy", number_of_shards: "1", blocks: { write: "false" } } } } }),
      stats: async () => ({ _all: { total: { store: { size_in_bytes: 1024 } } } }),
      putSettings: async ({ index, settings }: { index: string; settings: { "index.blocks.write": boolean } }) => {
        if (index === "source") state.sourceLocked = settings["index.blocks.write"]
        else state.targetLocked = settings["index.blocks.write"]
      },
      refresh: async () => ({}),
      create: async ({ mappings: targetMapping, settings }: any) => {
        assert.equal(targetMapping.properties.metadata.properties.normalizedBlocks.properties.metadata.properties.fontSize.type, "float")
        assert.equal(settings.uuid, undefined)
        state.created = true
      },
    },
    cat: { allocation: async () => [{ "disk.avail": "999999999" }] },
    openPointInTime: async ({ index }: any) => ({ id: index }),
    closePointInTime: async () => ({}),
    search: async ({ pit, search_after }: any) => ({ hits: { hits: search_after ? [] : (pit.id === "source" ? source : state.target.map(hit => ({ ...hit, fields: {
      "metadata.normalizedBlocks.metadata.fontSize": [12.5],
      "metadata.normalizedBlocks.boundingBox": [0.5, 2, 3, 4],
    } }))).map(hit => ({ ...hit, sort: [1] })) } }),
    reindex: async () => {
      state.target = structuredClone(source)
      if (options.corrupt) state.target[0]._source.text = "lost body"
      return { total: 1, created: 1, failures: options.reindexFails ? [{ cause: "copy failed" }] : [] }
    },
  } as unknown as Client
  return { client, state }
}

const base = { node: "http://localhost:9200", source: "source", target: "target", embeddingDimensions: 2 }
test("migration preview checks prerequisites without creating or locking indexes", async () => {
  const { client, state } = cluster()
  const result = await migrateChunkIndex(client, base)
  assert.equal(result.phase, "preview")
  assert.equal(state.created, false)
  assert.equal(state.sourceLocked, false)
})

test("migration verifies original body, vector, routing and fractional docvalues before cutover", async () => {
  const { client, state } = cluster()
  const result = await migrateChunkIndex(client, { ...base, apply: true })
  assert.equal(result.phase, "verified")
  assert.equal(result.sourceCount, 1)
  assert.equal(result.targetCount, 1)
  assert.equal(result.fractionalValues, 2)
  assert.equal(state.sourceLocked, true)
  assert.equal(state.targetLocked, true)
  assert.equal(state.target[0]._routing, "tenant")
  assert.deepEqual(state.target[0]._source.embedding, [0.25, 0.5])
})

test("inconsistent copy restores the source lock and never reports cutover ready", async () => {
  const { client, state } = cluster({ corrupt: true })
  await assert.rejects(migrateChunkIndex(client, { ...base, apply: true }), /mismatch/)
  assert.equal(state.sourceLocked, false)
  assert.equal(state.created, true) // Keep the failed destination for review.
})

test("reindex failures preserve originals and restore their write state", async () => {
  const { client, state } = cluster({ reindexFails: true })
  await assert.rejects(migrateChunkIndex(client, { ...base, apply: true }), /Reindex failed/)
  assert.equal(state.sourceLocked, false)
})

test("pre-existing target, remote cluster, wildcard and dimension mismatch are refused before writes", async () => {
  const existing = cluster({ targetExists: true })
  await assert.rejects(migrateChunkIndex(existing.client, { ...base, apply: true }), /already exists/)
  assert.equal(existing.state.created, false)
  const { client, state } = cluster()
  await assert.rejects(migrateChunkIndex(client, { ...base, apply: true, node: "http://example.com:9200" }), /loopback/)
  await assert.rejects(migrateChunkIndex(client, { ...base, apply: true, target: "target*" }), /physical/)
  await assert.rejects(migrateChunkIndex(client, { ...base, apply: true, embeddingDimensions: 3 }), /dimensions differ/)
  assert.equal(state.sourceLocked, false)
})
