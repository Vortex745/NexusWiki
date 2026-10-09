import assert from "node:assert/strict"
import test from "node:test"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

function configuredIndex(value?: string): { status: number | null; index?: string; error?: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, OPENAI_API_KEY: "test-key", DEMO_OIDC: "", DECISION_PROVIDER: "chat" }
  if (value === undefined) delete env.ES_CHUNK_INDEX
  else env.ES_CHUNK_INDEX = value
  const child = spawnSync(process.execPath, ["--import", "tsx", "-e", `
    try { console.log(JSON.stringify({index: require(${JSON.stringify(resolve(__dirname, "index.ts"))}).loadConfig().esChunkIndexName})) }
    catch (error) { console.log(JSON.stringify({error: error.message})); process.exitCode = 1 }
  `], { env, encoding: "utf8" })
  assert.equal(child.error, undefined)
  return { status: child.status, ...JSON.parse(child.stdout) }
}

test("ES_CHUNK_INDEX defaults, trims, and rejects unsafe physical index targets", () => {
  assert.equal(configuredIndex().index, "kefu-rag-chunks")
  assert.equal(configuredIndex("  ").index, "kefu-rag-chunks")
  assert.equal(configuredIndex(" migrated-chunks-v2 ").index, "migrated-chunks-v2")
  for (const index of ["*", "chunks,other", "Uppercase", ".", "..", "_hidden", "-bad", "+bad", "bad/name", "bad name", "bad#name", "x".repeat(256)]) {
    const result = configuredIndex(index)
    assert.equal(result.status, 1, index)
    assert.match(result.error!, /ES_CHUNK_INDEX/)
  }
})
