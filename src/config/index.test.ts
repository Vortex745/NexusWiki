/**
 * Ticket 01 (IAM-01): the demo flag must not be able to run on the token-less
 * single-tenant identity path. If it could, `GET /api/session` would report
 * the local admin scopes to an anonymous browser and the demo would never ask
 * anyone to sign in.
 *
 * `loadConfig` caches its result for the lifetime of the process and node's
 * test runner gives each test FILE its own process, so the failing case has
 * to be exercised first. Decision config cases use separate processes to
 * exercise startup behavior without adding a production cache-reset API.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import test from "node:test"

import { loadConfig } from "./index"

process.env.OPENAI_API_KEY = "test-key"
process.env.DEMO_OIDC = "1"

function decisionConfig(env: Record<string, string> = {}): {
  status: number | null
  config?: Record<string, unknown>
  error?: string
} {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, OPENAI_API_KEY: "test-key", DEMO_OIDC: "" }
  for (const key of [
    "DECISION_PROVIDER",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "DECISION_REQUEST_TIMEOUT_MS",
    "PDF_OCR_FALLBACK_ENABLED",
  ]) {
    delete childEnv[key]
  }
  const child = spawnSync(process.execPath, ["--import", "tsx", "-e", `
    try {
      const config = require(${JSON.stringify(resolve(__dirname, "index.ts"))}).loadConfig()
      process.stdout.write(JSON.stringify({ config: {
        decisionProvider: config.decisionProvider,
        cloudflareAccountId: config.cloudflareAccountId,
        cloudflareApiToken: config.cloudflareApiToken,
        decisionRequestTimeoutMs: config.decisionRequestTimeoutMs,
      } }))
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: error.message }))
      process.exitCode = 1
    }
  `], { env: { ...childEnv, ...env }, encoding: "utf8" })
  assert.equal(child.error, undefined)
  return { status: child.status, ...JSON.parse(child.stdout) }
}

test("decision provider defaults to Chat with no Cloudflare credentials", () => {
  const result = decisionConfig()
  assert.equal(result.status, 0)
  assert.deepEqual(result.config, {
    decisionProvider: "chat",
    cloudflareAccountId: "",
    cloudflareApiToken: "",
    decisionRequestTimeoutMs: 10_000,
  })
})

test("Clef reads normalized server-side credentials and the request timeout", () => {
  const result = decisionConfig({
    DECISION_PROVIDER: " clef ",
    CLOUDFLARE_ACCOUNT_ID: " test-account ",
    CLOUDFLARE_API_TOKEN: " test-token ",
    DECISION_REQUEST_TIMEOUT_MS: " 2500 ",
  })
  assert.equal(result.status, 0)
  assert.deepEqual(result.config, {
    decisionProvider: "clef",
    cloudflareAccountId: "test-account",
    cloudflareApiToken: "test-token",
    decisionRequestTimeoutMs: 2500,
  })
})

test("Clef fails at startup when either credential is missing or blank", () => {
  const cases: Record<string, string>[] = [
    {},
    { CLOUDFLARE_ACCOUNT_ID: "test-account" },
    { CLOUDFLARE_API_TOKEN: "test-token" },
    { CLOUDFLARE_ACCOUNT_ID: " ", CLOUDFLARE_API_TOKEN: "\t" },
  ]
  for (const env of cases) {
    const result = decisionConfig({ DECISION_PROVIDER: "clef", ...env })
    assert.equal(result.status, 1)
    assert.match(result.error!, /DECISION_PROVIDER=clef/)
    if (!env.CLOUDFLARE_ACCOUNT_ID?.trim()) {
      assert.match(result.error!, /CLOUDFLARE_ACCOUNT_ID/)
    }
    if (!env.CLOUDFLARE_API_TOKEN?.trim()) {
      assert.match(result.error!, /CLOUDFLARE_API_TOKEN/)
    }
    assert.doesNotMatch(result.error!, /test-account|test-token/)
  }
})

test("unknown decision providers fail at startup instead of selecting Chat", () => {
  for (const provider of ["unknown-provider", "Clef", "CHAT"]) {
    const result = decisionConfig({ DECISION_PROVIDER: provider })
    assert.equal(result.status, 1)
    assert.match(result.error!, /DECISION_PROVIDER must be chat or clef/)
    assert.equal(result.error!.includes(provider), false)
  }
})

test("decision timeouts must be positive safe integers within the timer range", () => {
  for (const timeout of [
    "2147483648", "9007199254740992", "Infinity", "NaN", "1000ms", "1.5", "0", "-1",
  ]) {
    const result = decisionConfig({ DECISION_REQUEST_TIMEOUT_MS: timeout })
    assert.equal(result.status, 1)
    assert.match(result.error!, /DECISION_REQUEST_TIMEOUT_MS must be a positive/)
  }
})

test("blank decision settings normalize to the Chat defaults", () => {
  const result = decisionConfig({
    DECISION_PROVIDER: " \t ",
    CLOUDFLARE_ACCOUNT_ID: " \t ",
    CLOUDFLARE_API_TOKEN: " \t ",
    DECISION_REQUEST_TIMEOUT_MS: " \t ",
  })
  assert.equal(result.status, 0)
  assert.deepEqual(result.config, {
    decisionProvider: "chat",
    cloudflareAccountId: "",
    cloudflareApiToken: "",
    decisionRequestTimeoutMs: 10_000,
  })
})

test("Chat accepts missing credentials and legal decision timer boundaries", () => {
  for (const timeout of ["1", "2147483647"]) {
    const result = decisionConfig({ DECISION_PROVIDER: "chat", DECISION_REQUEST_TIMEOUT_MS: timeout })
    assert.equal(result.status, 0)
    assert.equal(result.config!.decisionProvider, "chat")
    assert.equal(result.config!.decisionRequestTimeoutMs, Number(timeout))
    assert.equal(result.config!.cloudflareAccountId, "")
    assert.equal(result.config!.cloudflareApiToken, "")
  }
})

test("Ticket 01: DEMO_OIDC=1 without DEMO_OIDC_PASSWORD boots on the documented demo default", () => {
  // The gate is nominal by design (see config/index.ts): a fixed default keeps
  // a fresh clone sign-in-able without .env. This is a startup check, so it
  // runs in its own process — `loadConfig` memoizes for the process lifetime.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OPENAI_API_KEY: "test-key",
    DEMO_OIDC: "1",
  }
  delete childEnv.DEMO_OIDC_PASSWORD
  const modulePath = JSON.stringify(resolve(__dirname, "index.ts"))
  const startupScript = [
    `const { loadConfig } = require(${modulePath})`,
    "const config = loadConfig()",
    "process.stdout.write(JSON.stringify({ demoOidc: config.demoOidc, accessMode: config.accessMode }))",
  ].join("\n")
  const child = spawnSync(process.execPath, ["--import", "tsx", "-e", startupScript], {
    env: childEnv,
    encoding: "utf8",
  })
  assert.equal(child.status, 0, `startup must succeed without an explicit password: ${child.stderr}`)
  assert.deepEqual(JSON.parse(child.stdout), { demoOidc: true, accessMode: "enforced" })
})

test("Ticket 01: DEMO_OIDC=1 forces the enforced identity path", () => {
  process.env.DEMO_OIDC_PASSWORD = "demo-password"
  const config = loadConfig()
  assert.equal(config.demoOidc, true)
  assert.equal(
    config.accessMode,
    "enforced",
    "the demo must never resolve identities from the token-less single-tenant path"
  )
})

/**
 * Ticket 04 (PDF quality): PDF_OCR_FALLBACK_ENABLED is read in a child process
 * for the same reason the decision provider is — `loadConfig` memoizes for the
 * lifetime of the process, and the flag has to be observed unset / on / off as
 * separate startups. The Clef decision fields ride along in every reading so
 * the isolation requirement is compared, never assumed.
 */
function pdfFlagConfig(env: Record<string, string> = {}): {
  status: number | null
  config?: Record<string, unknown>
  error?: string
} {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, OPENAI_API_KEY: "test-key", DEMO_OIDC: "" }
  for (const key of [
    "DECISION_PROVIDER",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "DECISION_REQUEST_TIMEOUT_MS",
    "PDF_OCR_FALLBACK_ENABLED",
  ]) {
    delete childEnv[key]
  }
  const child = spawnSync(process.execPath, ["--import", "tsx", "-e", `
    try {
      const config = require(${JSON.stringify(resolve(__dirname, "index.ts"))}).loadConfig()
      process.stdout.write(JSON.stringify({ config: {
        pdfOcrFallbackEnabled: config.pdfOcrFallbackEnabled,
        decisionProvider: config.decisionProvider,
        cloudflareAccountId: config.cloudflareAccountId,
        cloudflareApiToken: config.cloudflareApiToken,
        decisionRequestTimeoutMs: config.decisionRequestTimeoutMs,
      } }))
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: error.message }))
      process.exitCode = 1
    }
  `], { env: { ...childEnv, ...env }, encoding: "utf8" })
  assert.equal(child.error, undefined)
  return { status: child.status, ...JSON.parse(child.stdout) }
}

const PDF_FLAG_OFF = {
  pdfOcrFallbackEnabled: false,
  decisionProvider: "chat",
  cloudflareAccountId: "",
  cloudflareApiToken: "",
  decisionRequestTimeoutMs: 10_000,
}

test("Ticket 04: PDF_OCR_FALLBACK_ENABLED defaults to false when unset", () => {
  const result = pdfFlagConfig()
  assert.equal(result.status, 0)
  assert.deepEqual(result.config, PDF_FLAG_OFF)
})

test("Ticket 04: PDF_OCR_FALLBACK_ENABLED enables only on 1/true and disables on 0/false", () => {
  for (const enabled of ["1", "true", " 1 ", "TRUE", "True"]) {
    const result = pdfFlagConfig({ PDF_OCR_FALLBACK_ENABLED: enabled })
    assert.equal(result.status, 0, `${enabled} must be accepted`)
    assert.equal(result.config!.pdfOcrFallbackEnabled, true, `${enabled} enables the switch`)
  }
  for (const disabled of ["0", "false", " 0 ", "FALSE"]) {
    const result = pdfFlagConfig({ PDF_OCR_FALLBACK_ENABLED: disabled })
    assert.equal(result.status, 0, `${disabled} must be accepted`)
    assert.equal(result.config!.pdfOcrFallbackEnabled, false, `${disabled} keeps the existing import path`)
  }
  // A blank value is "not configured", exactly like the other trimmed settings.
  const blank = pdfFlagConfig({ PDF_OCR_FALLBACK_ENABLED: " \t " })
  assert.equal(blank.status, 0)
  assert.equal(blank.config!.pdfOcrFallbackEnabled, false)
})

test("Ticket 04: an unrecognised PDF_OCR_FALLBACK_ENABLED fails at startup instead of silently disabling the gate", () => {
  for (const value of ["yes", "no", "on", "off", "2", "-1", "1.5", "enabled", "10"]) {
    const result = pdfFlagConfig({ PDF_OCR_FALLBACK_ENABLED: value })
    assert.equal(result.status, 1, `${value} is not a legal switch value`)
    assert.match(result.error!, /PDF_OCR_FALLBACK_ENABLED must be 1, 0, true or false/)
    // The startup error names the setting, never the operator's value.
    assert.equal(result.error!.includes(value), false)
  }
})

test("Ticket 04: the PDF flag leaves the question-routing Clef configuration untouched", () => {
  const clefEnv = {
    DECISION_PROVIDER: "clef",
    CLOUDFLARE_ACCOUNT_ID: "test-account",
    CLOUDFLARE_API_TOKEN: "test-token",
    DECISION_REQUEST_TIMEOUT_MS: "2500",
  }
  const off = pdfFlagConfig({ ...clefEnv, PDF_OCR_FALLBACK_ENABLED: "0" })
  const on = pdfFlagConfig({ ...clefEnv, PDF_OCR_FALLBACK_ENABLED: "1" })
  assert.equal(off.status, 0)
  assert.equal(on.status, 0)
  assert.deepEqual(off.config!.pdfOcrFallbackEnabled, false)
  assert.deepEqual(on.config!.pdfOcrFallbackEnabled, true)
  // Every question-routing field is byte-identical with the switch on and off.
  for (const key of [
    "decisionProvider",
    "cloudflareAccountId",
    "cloudflareApiToken",
    "decisionRequestTimeoutMs",
  ]) {
    assert.deepEqual(on.config![key], off.config![key], `${key} must not depend on the PDF flag`)
  }
  assert.deepEqual(
    {
      decisionProvider: on.config!.decisionProvider,
      cloudflareAccountId: on.config!.cloudflareAccountId,
      cloudflareApiToken: on.config!.cloudflareApiToken,
      decisionRequestTimeoutMs: on.config!.decisionRequestTimeoutMs,
    },
    {
      decisionProvider: "clef",
      cloudflareAccountId: "test-account",
      cloudflareApiToken: "test-token",
      decisionRequestTimeoutMs: 2500,
    }
  )
})

test("Ticket 04: the PDF flag is independent of the answer-run budget and activation settings", () => {
  const result = pdfFlagConfig({
    PDF_OCR_FALLBACK_ENABLED: "1",
    ACTIVATION_MODE: "review",
    ANSWER_RUN_MAX_MODEL_CALLS: "7",
  })
  assert.equal(result.status, 0)
  assert.equal(result.config!.pdfOcrFallbackEnabled, true)
  // Nothing above changed the routing defaults the flag must not touch.
  assert.equal(result.config!.decisionProvider, "chat")
  assert.equal(result.config!.decisionRequestTimeoutMs, 10_000)
})
