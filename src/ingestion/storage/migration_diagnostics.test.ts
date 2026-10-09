import assert from "node:assert/strict"
import test from "node:test"
import { safeMigrationDiagnostic, ChunkIndexMigrationError, ChunkIndexMigrationRestoreError } from "./chunk_index_migration"

test("migration diagnostics expose only trusted local errors, never external messages", () => {
  const secret = "sk-private-key http://user:password@localhost document-body-private"
  for (const error of [new Error(secret), Object.assign(new Error(secret), {name: "ResponseError"}), new AggregateError([new Error(secret)], secret), secret]) {
    const message = safeMigrationDiagnostic(error)
    assert.ok(!message.includes("sk-private-key"))
    assert.ok(!message.includes("password"))
    assert.ok(!message.includes("document-body-private"))
    assert.match(message, /verify source write-lock state/)
  }
  assert.equal(safeMigrationDiagnostic(new ChunkIndexMigrationError("Configured and source embedding dimensions differ")), "Configured and source embedding dimensions differ")
})

test("write-lock restore failure is prominent without exposing either underlying failure", () => {
  const error = new ChunkIndexMigrationRestoreError([new Error("secret original"), new Error("secret restore")])
  assert.ok(error instanceof AggregateError)
  const message = safeMigrationDiagnostic(error)
  assert.match(message, /source write lock could not be restored/)
  assert.match(message, /verify.*before resuming/i)
  assert.ok(!message.includes("secret"))
})

test("transport failure and malformed endpoint remain safe at the public migration seam", async () => {
  const {migrateChunkIndex} = await import("./chunk_index_migration")
  const client = {indices: {exists: async () => {throw new Error("connect failed http://user:password@localhost/sk-private-key")}}} as never
  const options = {node: "http://localhost:9200", source: "source", target: "target", embeddingDimensions: 2}
  for (const node of [options.node, "sk-private-key"] ) {
    await assert.rejects(migrateChunkIndex(client, {...options, node}), (error: unknown) => {
      const message = safeMigrationDiagnostic(error)
      assert.ok(!message.includes("password"))
      assert.ok(!message.includes("sk-private-key"))
      return true
    })
  }
})
