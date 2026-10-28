import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import test from "node:test"

function docreaderConfig(env: Record<string, string> = {}): {
  status: number | null
  config?: Record<string, unknown>
  error?: string
} {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, OPENAI_API_KEY: "test-key", DEMO_OIDC: "" }
  delete childEnv.DOCREADER_ADDR
  delete childEnv.DOCREADER_TIMEOUT_MS
  const child = spawnSync(process.execPath, ["--import", "tsx", "-e", `
    try {
      const config = require(${JSON.stringify(resolve(__dirname, "index.ts"))}).loadConfig()
      process.stdout.write(JSON.stringify({ config: {
        docreaderAddr: config.docreaderAddr,
        docreaderTimeoutMs: config.docreaderTimeoutMs,
      } }))
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: error.message }))
      process.exitCode = 1
    }
  `], { env: { ...childEnv, ...env }, encoding: "utf8" })
  assert.equal(child.error, undefined)
  return { status: child.status, ...JSON.parse(child.stdout) }
}

test("DocReader config defaults to loopback and a 300s total budget", () => {
  const result = docreaderConfig()
  assert.equal(result.status, 0)
  assert.deepEqual(result.config, {
    docreaderAddr: "127.0.0.1:50051",
    docreaderTimeoutMs: 300_000,
  })
})

test("DocReader config trims the address and reads a positive timeout", () => {
  const result = docreaderConfig({
    DOCREADER_ADDR: " 127.0.0.1:50052 ",
    DOCREADER_TIMEOUT_MS: "45000",
  })
  assert.equal(result.status, 0)
  assert.deepEqual(result.config, {
    docreaderAddr: "127.0.0.1:50052",
    docreaderTimeoutMs: 45_000,
  })
})

test("DocReader config treats a blank address as the loopback default", () => {
  const result = docreaderConfig({ DOCREADER_ADDR: "  " })
  assert.equal(result.status, 0)
  assert.equal(result.config!.docreaderAddr, "127.0.0.1:50051")
})

test("DocReader config rejects a non-positive or non-integer timeout at startup", () => {
  for (const value of ["0", "-1", "1.5", "abc"]) {
    const result = docreaderConfig({ DOCREADER_TIMEOUT_MS: value })
    assert.notEqual(result.status, 0)
    assert.match(result.error!, /DOCREADER_TIMEOUT_MS must be a positive integer/)
  }
})
