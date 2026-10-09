import assert from "node:assert/strict"
import test from "node:test"
import type { Client } from "@elastic/elasticsearch"
import { esWikiChunkReader } from "./engine"

test("Wiki reads the selected physical index rather than the legacy index", async () => {
  const reads: string[] = []
  const client = { search: async ({index}: {index: string}) => {
    reads.push(index)
    return { hits: { hits: [{_source: {id: "c", content: index === "selected-v2" ? "new content" : "old content"}}] } }
  }} as unknown as Client
  assert.deepEqual(await esWikiChunkReader(client, "selected-v2").list("doc"), [{id: "c", content: "new content"}])
  assert.deepEqual(reads, ["selected-v2"])
})
