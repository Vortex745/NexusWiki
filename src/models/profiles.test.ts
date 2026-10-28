/**
 * Ticket 16 (MODEL-01A) — the built-in model-profile registry.
 *
 * Focus: non-secret metadata only, idempotent seeding, a persisted toggle
 * that survives restart, and a selection gate that refuses disabled or
 * unknown profiles (and never lets a toggle outrun the credentials).
 */

import assert from "node:assert/strict"
import test from "node:test"

import type { AppConfig } from "../config"
import { openDb, type DB } from "../ingestion/tracking/db"
import { ModelProfileRegistry } from "./profiles"

const BASE_CONFIG: AppConfig = {
  esNode: "http://es.test",
  esApiKey: "",
  openaiApiKey: "sk-secret-value",
  openaiBaseUrl: "https://chat.example.com/v1",
  openaiChatModel: "gpt-x",
  embeddingApiKey: "emb-key",
  embeddingBaseUrl: "https://embed.example.com/v1",
  embeddingModel: "embed-x",
  embeddingDimensions: 512,
  openaiRequestTimeoutMs: 1_000,
  openaiMaxRetries: 0,
  neo4jUri: "bolt://neo4j.test",
  neo4jUser: "neo4j",
  neo4jPassword: "password",
  sqlitePath: ":memory:",
  pollIntervalMs: 1,
  claimedTimeoutMs: 1,
  accessMode: "single_tenant",
  demoOidc: false,
  demoOidcPort: 3900,
  demoOidcAudience: "nexusrag-demo",
  demoOidcPassword: "",
  adminLoginId: "admin",
  adminLoginPassword: "",
  activationMode: "auto",
  conversationTtlDays: 30,
  conversationGcIntervalMs: 86_400_000,
  rerankApiKey: "",
  rerankBaseUrl: "https://rerank.example.com/v1",
  rerankModel: "rerank-x",
  rerankTimeoutMs: 5_000,
  rerankMaxDocumentChars: 4_000,
  // Ticket 35: never spawn the MCP capability server from tests.
  mcpCapabilitiesEnabled: false,
}

function configFor(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...BASE_CONFIG, ...overrides }
}

function countRows(db: DB): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM model_profiles").get() as { n: number }).n
}

test("profiles seed once, map to the three credential slots, and expose no secrets", () => {
  const db = openDb(":memory:")
  const config = configFor({
    openaiChatModel: "gpt-x",
    embeddingModel: "embed-x",
    embeddingDimensions: 512,
    openaiBaseUrl: "https://chat.example.com/v1?key=should-not-leak",
    rerankBaseUrl: "https://rerank.example.com/v1",
  })
  const registry = new ModelProfileRegistry(db, config)

  const profiles = registry.list()
  assert.deepEqual(
    profiles.map((p) => p.id),
    ["chat", "embedding", "rerank"]
  )
  const chat = profiles.find((p) => p.id === "chat")!
  const embedding = profiles.find((p) => p.id === "embedding")!
  const rerank = profiles.find((p) => p.id === "rerank")!

  assert.equal(chat.model, "gpt-x")
  assert.equal(chat.baseUrlHost, "chat.example.com")
  assert.equal(chat.configured, true)
  assert.equal(chat.selectable, true)

  assert.equal(embedding.model, "embed-x")
  assert.equal(embedding.dimensions, 512)

  // No key configured → rerank seeds disabled and unselectable.
  assert.equal(rerank.configured, false)
  assert.equal(rerank.enabled, false)
  assert.equal(rerank.selectable, false)

  const serialized = JSON.stringify(profiles)
  assert.ok(!serialized.includes("should-not-leak"), "no query/credential material")
  assert.ok(!serialized.includes("apiKey"), "no key field")
  assert.ok(!serialized.includes("https://"), "no full provider URLs — host only")
  assert.equal(countRows(db), 3, "exactly one row per built-in profile")
})

test("seeding is idempotent and the persisted toggle survives a restart", () => {
  const db = openDb(":memory:")
  const config = configFor({ rerankApiKey: "sk-test" })
  const first = new ModelProfileRegistry(db, config)
  new ModelProfileRegistry(db, config) // same process re-entry
  new ModelProfileRegistry(db, config) // simulated restart on the same file
  assert.equal(countRows(db), 3)

  // Rerank with a key seeds enabled; disabling persists across "restarts".
  assert.equal(first.selectable("rerank"), true)
  first.setEnabled("rerank", false)
  const second = new ModelProfileRegistry(db, config)
  assert.equal(second.selectable("rerank"), false)
  assert.equal(second.get("rerank")?.configured, true, "still configured — key present")
})

test("setEnabled refuses unknown ids and enabling a credential-less profile", () => {
  const db = openDb(":memory:")
  const registry = new ModelProfileRegistry(db, configFor())

  assert.throws(() => registry.setEnabled("nope", true), /unknown model profile/)
  const error = (() => {
    try {
      registry.setEnabled("rerank", true)
      return null
    } catch (e) {
      return e as Error & { status?: number; hint?: string }
    }
  })()
  assert.ok(error)
  assert.equal(error.status, 400)
  assert.match(error.hint ?? "", /RERANK_API_KEY/)
})

test("a persisted enabled flag cannot outrun missing credentials", () => {
  const db = openDb(":memory:")
  const withKey = configFor({ rerankApiKey: "sk-test" })
  const registry = new ModelProfileRegistry(db, withKey)
  registry.setEnabled("rerank", false)
  registry.setEnabled("rerank", true)
  assert.equal(registry.selectable("rerank"), true)

  // The operator later removes the key and the process restarts: the row still
  // says enabled, but the slot is empty → selection stays refused.
  const withoutKey = configFor({ rerankApiKey: "" })
  const restarted = new ModelProfileRegistry(db, withoutKey)
  assert.equal(restarted.get("rerank")?.enabled, true)
  assert.equal(restarted.get("rerank")?.configured, false)
  assert.equal(restarted.selectable("rerank"), false)
})

test("the selection gate covers chat and rerank", () => {
  const db = openDb(":memory:")
  const registry = new ModelProfileRegistry(db, configFor({ rerankApiKey: "sk-test" }))
  assert.equal(registry.selectable("chat"), true)
  assert.equal(registry.selectable("rerank"), true)
  registry.setEnabled("chat", false)
  assert.equal(registry.selectable("chat"), false)
  registry.setEnabled("rerank", false)
  assert.equal(registry.selectable("rerank"), false)
})
