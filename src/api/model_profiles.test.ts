/**
 * Ticket 16 (MODEL-01A) — the model-profile HTTP API and connectivity tests.
 *
 * Focus: admin-only surface, no credential material in any payload, PATCH
 * validation, protocol-specific probes with actionable errors, and the
 * evaluation selection gate refusing a disabled profile.
 */

import assert from "node:assert/strict"
import test from "node:test"
import type { AddressInfo } from "node:net"
import express, { type RequestHandler } from "express"
import type OpenAI from "openai"

import type { AppConfig } from "../config"
import { openDb } from "../ingestion/tracking/db"
import { ModelProfileRegistry } from "../models/profiles"
import { createModelProfilesRouter } from "./model_profiles"
import { EvaluationService } from "../evaluation/service"
import type { AccessContext } from "../access/context"

const BASE_CONFIG: AppConfig = {
  esNode: "http://es.test",
  esApiKey: "",
  openaiApiKey: "sk-secret-value",
  openaiBaseUrl: "https://chat.example.com/v1",
  openaiChatModel: "gpt-x",
  embeddingApiKey: "emb-key",
  embeddingBaseUrl: "https://embed.example.com/v1",
  embeddingModel: "embed-x",
  embeddingDimensions: 8,
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
  activationMode: "auto",
  conversationTtlDays: 30,
  conversationGcIntervalMs: 86_400_000,
  rerankApiKey: "",
  rerankBaseUrl: "https://rerank.example.com/v1",
  rerankModel: "rerank-x",
  rerankTimeoutMs: 5_000,
  rerankMaxDocumentChars: 4_000,
}

function configFor(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...BASE_CONFIG, ...overrides }
}

function fakeOpenAI(shape: Record<string, unknown>): OpenAI {
  return shape as unknown as OpenAI
}

function identity(ctx: Partial<AccessContext> & { scopes: AccessContext["scopes"] }): RequestHandler {
  return (_req, res, next) => {
    res.locals.accessContext = {
      tenantId: "t1",
      subjectId: "u1",
      groups: [],
      ...ctx,
    } as AccessContext
    next()
  }
}

async function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

test("profile metadata is admin-only and carries no credential material", async () => {
  const config = configFor({ openaiApiKey: "sk-secret-value" })
  const registry = new ModelProfileRegistry(openDb(":memory:"), config as never)
  const app = express()
  app.use(express.json())
  const okClients = {
    chatClient: fakeOpenAI({
      chat: { completions: { create: async () => ({ choices: [{}] }) } },
    }),
    embeddingClient: fakeOpenAI({
      embeddings: { create: async () => ({ data: [{ embedding: new Array(config.embeddingDimensions).fill(0.1) }] }) },
    }),
  }
  app.use(identity({ scopes: ["admin", "chat"] }))
  app.use("/api", createModelProfilesRouter({ registry, config, clients: okClients }))
  const admin = await listen(app)

  const readerApp = express()
  readerApp.use(express.json())
  readerApp.use(identity({ scopes: ["chat"] }))
  readerApp.use("/api", createModelProfilesRouter({ registry, config, clients: okClients }))
  const reader = await listen(readerApp)

  try {
    const readerResponse = await fetch(`${reader.base}/api/models/profiles`)
    assert.equal(readerResponse.status, 403)

    const response = await fetch(`${admin.base}/api/models/profiles`)
    assert.equal(response.status, 200)
    const body = (await response.json()) as { profiles: Array<{ id: string }> }
    assert.deepEqual(
      body.profiles.map((p) => p.id),
      ["chat", "embedding", "rerank"]
    )
    assert.ok(!JSON.stringify(body).includes("sk-secret-value"))

    // The okClients injected here also give the embedding probe a passing
    // round: vector returned at exactly the configured dimension.
    const embeddingOk = await fetch(`${admin.base}/api/models/profiles/embedding/test`, {
      method: "POST",
    })
    const embeddingBody = (await embeddingOk.json()) as { ok: boolean }
    assert.equal(embeddingBody.ok, true)
  } finally {
    await admin.close()
    await reader.close()
  }
})

test("PATCH validates the body, refuses unknown ids and toggles the persisted state", async () => {
  const config = configFor({ rerankApiKey: "sk-rerank" })
  const registry = new ModelProfileRegistry(openDb(":memory:"), config as never)
  const app = express()
  app.use(express.json())
  app.use(identity({ scopes: ["admin"] }))
  app.use("/api", createModelProfilesRouter({
    registry,
    config,
    clients: { chatClient: fakeOpenAI({}), embeddingClient: fakeOpenAI({}) },
  }))
  const { base, close } = await listen(app)
  try {
    const malformed = await fetch(`${base}/api/models/profiles/rerank`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    })
    assert.equal(malformed.status, 400)

    const unknown = await fetch(`${base}/api/models/profiles/nope`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })
    assert.equal(unknown.status, 404)

    const disabled = await fetch(`${base}/api/models/profiles/rerank`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    })
    assert.equal(disabled.status, 200)
    assert.equal(((await disabled.json()) as { profile: { selectable: boolean } }).profile.selectable, false)
    assert.equal(registry.selectable("rerank"), false)
  } finally {
    await close()
  }
})

test("enabling a credential-less rerank profile is refused with an actionable hint", async () => {
  const config = configFor({ rerankApiKey: "" })
  const registry = new ModelProfileRegistry(openDb(":memory:"), config as never)
  registry.setEnabled("rerank", false)
  const app = express()
  app.use(express.json())
  app.use(identity({ scopes: ["admin"] }))
  app.use("/api", createModelProfilesRouter({
    registry,
    config,
    clients: { chatClient: fakeOpenAI({}), embeddingClient: fakeOpenAI({}) },
  }))
  const { base, close } = await listen(app)
  try {
    const response = await fetch(`${base}/api/models/profiles/rerank`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })
    assert.equal(response.status, 400)
    const body = (await response.json()) as { error: string; hint: string }
    assert.match(body.hint, /RERANK_API_KEY/)
  } finally {
    await close()
  }
})

test("the chat probe validates its own protocol and classifies auth failures", async () => {
  const config = configFor()
  const registry = new ModelProfileRegistry(openDb(":memory:"), config as never)
  const okApp = express()
  okApp.use(express.json())
  okApp.use(identity({ scopes: ["admin"] }))
  okApp.use("/api", createModelProfilesRouter({
    registry,
    config,
    clients: {
      chatClient: fakeOpenAI({
        chat: { completions: { create: async () => ({ choices: [{}] }) } },
      }),
      embeddingClient: fakeOpenAI({}),
    },
  }))
  const ok = await listen(okApp)

  const authApp = express()
  authApp.use(express.json())
  authApp.use(identity({ scopes: ["admin"] }))
  authApp.use("/api", createModelProfilesRouter({
    registry,
    config,
    clients: {
      chatClient: fakeOpenAI({
        chat: {
          completions: {
            create: async () => {
              throw Object.assign(new Error("invalid api key"), { status: 401 })
            },
          },
        },
      }),
      embeddingClient: fakeOpenAI({}),
    },
  }))
  const auth = await listen(authApp)
  try {
    const okResponse = await fetch(`${ok.base}/api/models/profiles/chat/test`, { method: "POST" })
    assert.equal(okResponse.status, 200)
    const okBody = (await okResponse.json()) as { ok: boolean; latencyMs: number | null }
    assert.equal(okBody.ok, true)
    assert.equal(typeof okBody.latencyMs, "number")

    const authResponse = await fetch(`${auth.base}/api/models/profiles/chat/test`, { method: "POST" })
    const authBody = (await authResponse.json()) as { ok: boolean; error: string; hint: string }
    assert.equal(authBody.ok, false)
    assert.match(authBody.error, /authentication failed/)
    assert.match(authBody.hint, /API key/)
  } finally {
    await ok.close()
    await auth.close()
  }
})

test("the embedding probe verifies the vector dimension", async () => {
  const config = configFor({ embeddingDimensions: 8 })
  const registry = new ModelProfileRegistry(openDb(":memory:"), config as never)
  const app = express()
  app.use(express.json())
  app.use(identity({ scopes: ["admin"] }))
  app.use("/api", createModelProfilesRouter({
    registry,
    config,
    clients: {
      chatClient: fakeOpenAI({}),
      embeddingClient: fakeOpenAI({
        embeddings: { create: async () => ({ data: [{ embedding: new Array(4).fill(0.5) }] }) },
      }),
    },
  }))
  const { base, close } = await listen(app)
  try {
    const response = await fetch(`${base}/api/models/profiles/embedding/test`, { method: "POST" })
    const body = (await response.json()) as { ok: boolean; error: string }
    assert.equal(body.ok, false)
    assert.match(body.error, /provider returned 4, server expects 8/)
  } finally {
    await close()
  }
})

test("the rerank probe reports a missing credential and validates a live protocol round", async () => {
  const missingConfig = configFor({ rerankApiKey: "" })
  const missingRegistry = new ModelProfileRegistry(openDb(":memory:"), missingConfig as never)
  const missingApp = express()
  missingApp.use(express.json())
  missingApp.use(identity({ scopes: ["admin"] }))
  missingApp.use("/api", createModelProfilesRouter({
    registry: missingRegistry,
    config: missingConfig,
    clients: { chatClient: fakeOpenAI({}), embeddingClient: fakeOpenAI({}) },
  }))
  const missing = await listen(missingApp)
  try {
    const response = await fetch(`${missing.base}/api/models/profiles/rerank/test`, { method: "POST" })
    const body = (await response.json()) as { ok: boolean; hint: string }
    assert.equal(body.ok, false)
    assert.match(body.hint, /RERANK_API_KEY/)
  } finally {
    await missing.close()
  }

  // With a key, the probe rides the production DedicatedReranker; stub the
  // global fetch it uses and answer with the verified Edgefn response shape.
  const okConfig = configFor({ rerankApiKey: "sk-rerank-test" })
  const okRegistry = new ModelProfileRegistry(openDb(":memory:"), okConfig as never)
  const okApp = express()
  okApp.use(express.json())
  okApp.use(identity({ scopes: ["admin"] }))
  okApp.use("/api", createModelProfilesRouter({
    registry: okRegistry,
    config: okConfig,
    clients: { chatClient: fakeOpenAI({}), embeddingClient: fakeOpenAI({}) },
  }))
  const ok = await listen(okApp)
  const originalFetch = globalThis.fetch
  // Intercept ONLY the provider endpoint; the test client's own requests to
  // the local server must pass through to the original fetch.
  const stubbedFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.includes("rerank.example.com")) {
      return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.99 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return originalFetch(input, init)
  }) as typeof fetch
  globalThis.fetch = stubbedFetch
  try {
    const response = await fetch(`${ok.base}/api/models/profiles/rerank/test`, { method: "POST" })
    const body = (await response.json()) as { ok: boolean; latencyMs: number | null }
    assert.equal(body.ok, true)
    assert.equal(typeof body.latencyMs, "number")
  } finally {
    globalThis.fetch = originalFetch
    await ok.close()
  }
})

test("an unknown profile id refuses the probe with 404", async () => {
  const config = configFor()
  const registry = new ModelProfileRegistry(openDb(":memory:"), config as never)
  const app = express()
  app.use(express.json())
  app.use(identity({ scopes: ["admin"] }))
  app.use("/api", createModelProfilesRouter({
    registry,
    config,
    clients: { chatClient: fakeOpenAI({}), embeddingClient: fakeOpenAI({}) },
  }))
  const { base, close } = await listen(app)
  try {
    const response = await fetch(`${base}/api/models/profiles/nope/test`, { method: "POST" })
    assert.equal(response.status, 404)
  } finally {
    await close()
  }
})

test("the evaluation gate refuses a rerank override while the profile is disabled", () => {
  const config = configFor({ rerankApiKey: "sk-rerank-test" })
  const registry = new ModelProfileRegistry(openDb(":memory:"), config as never)
  registry.setEnabled("rerank", false)
  const service = new EvaluationService({
    config: config as never,
    clients: {} as never,
    createResources: () => ({}) as never,
    allowedChatModels: ["any-model"],
    allowedRerankModels: ["bge-reranker-v2-m3", "other-rerank"],
    createReranker: () => ({}) as never,
    modelProfileGate: registry,
  })
  assert.throws(
    () =>
      service.createTask(
        { datasetId: "refund-single-case", rerankModel: "other-rerank" },
        { tenantId: "t", subjectId: "u" }
      ),
    (error: Error & { issues?: string[] }) => {
      assert.match(error.message, /rerank model profile is disabled/)
      assert.deepEqual(error.issues, ["rerankModel"])
      return true
    }
  )
  // Enabling the profile admits the same override; disabling chat rejects its
  // override too.
  registry.setEnabled("rerank", true)
  registry.setEnabled("chat", false)
  assert.throws(
    () =>
      service.createTask(
        { datasetId: "refund-single-case", chatModel: "any-model" },
        { tenantId: "t", subjectId: "u" }
      ),
    /chat model profile is disabled/
  )
  registry.setEnabled("chat", true)
  // The gate passes once enabled: the same override is accepted (no throw —
  // the task runs in the background against the stubbed resources).
  assert.doesNotThrow(() =>
    service.createTask(
      { datasetId: "refund-single-case", rerankModel: "other-rerank" },
      { tenantId: "t", subjectId: "u" }
    )
  )
  void service.shutdown({ timeoutMs: 1000 })
})
