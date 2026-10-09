import assert from "node:assert/strict"
import test from "node:test"
import { openDb } from "../ingestion/tracking/db"
import { inventoryDemoNamespace } from "./demo_namespace"
import { inventoryDemoRebuild } from "./demo_rebuild"
import { DEMO_TENANT_ID } from "../identity/demo_accounts"
import type { Client } from "@elastic/elasticsearch"

test("demo maintenance inventories only the selected index and never writes in preview", async () => {
  const db = openDb(":memory:")
  const reads: string[] = []
  const exists = async ({index}: {index: string}) => {reads.push(index); return true}
  const count = async ({index}: {index: string}) => {reads.push(index); return {count: index === "selected-v2" ? 3 : 99}}
  const graph = {listProvenanceTenants: async () => [], stripProvenance: async () => {throw new Error("preview must not write")}}
  try {
    const namespace = await inventoryDemoNamespace({db, es: {exists, count, deleteByQuery: async () => {throw new Error("preview must not delete")}}, graph, indexName: "selected-v2"}, DEMO_TENANT_ID)
    assert.deepEqual(namespace.esIndex, {index: "selected-v2", documents: 3})
    const rebuild = await inventoryDemoRebuild({db, es: {indices: {exists, delete: async () => {throw new Error("preview must not delete")}}, count} as unknown as Client, graph, indexName: "selected-v2"})
    assert.deepEqual(rebuild.esIndexes, [{index: "selected-v2", exists: true, documents: 3}])
    assert.deepEqual(reads, ["selected-v2", "selected-v2", "selected-v2", "selected-v2"])
  } finally {db.close()}
})
