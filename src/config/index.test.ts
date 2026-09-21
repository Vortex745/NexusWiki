/**
 * Ticket 01 (IAM-01): the demo flag must not be able to run on the token-less
 * single-tenant identity path. If it could, `GET /api/session` would report
 * the local admin scopes to an anonymous browser and the demo would never ask
 * anyone to sign in.
 *
 * `loadConfig` caches its result for the lifetime of the process and node's
 * test runner gives each test FILE its own process, so the failing case has
 * to be exercised first.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { loadConfig } from "./index"

process.env.OPENAI_API_KEY = "test-key"
process.env.DEMO_OIDC = "1"

test("Ticket 01: DEMO_OIDC=1 without DEMO_OIDC_PASSWORD fails at startup", () => {
  delete process.env.DEMO_OIDC_PASSWORD
  assert.throws(() => loadConfig(), /DEMO_OIDC_PASSWORD is required/)
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
