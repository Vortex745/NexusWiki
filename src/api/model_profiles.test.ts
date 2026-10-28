/**
 * Ticket 16 (MODEL-01A) — the model-profile HTTP API and connectivity tests.
 *
 * Focus: admin-only surface, no credential material in any payload, PATCH
 * validation, and protocol-specific probes with actionable errors.
 */

import assert from "node:assert/strict"
import test from "node:test"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import express, { type RequestHandler } from "express"
import type OpenAI from "openai"

import type { AppConfig } from "../config"
import { openDb } from "../ingestion/tracking/db"
import { ModelProfileRegistry } from "../models/profiles"
import { createModelProfilesRouter } from "./model_profiles"
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

test("the settings workspace saves a slot into .env and probes the saved values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-settings-"))
  const envPath = join(dir, ".env")
  // The file carries only the key at first, so the slot's URL and model still
  // read as boot config until the settings form saves them.
  await writeFile(envPath, "OPENAI_API_KEY=sk-boot\n# keep me\n", "utf8")
  // A local OpenAI-compatible provider stands in for the saved endpoint.
  const provider = http.createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    }
    const rejected = req.headers.authorization !== "Bearer sk-saved"
    if (req.url === "/v1/models") {
      if (rejected) return json(401, { error: { message: "nope" } })
      return json(200, { object: "list", data: [{ id: "saved-b" }, { id: "saved-a" }] })
    }
    if (req.url === "/v1/chat/completions") {
      if (rejected) return json(401, { error: { message: "nope" } })
      let raw = ""
      req.on("data", (chunk) => (raw += chunk))
      req.on("end", () =>
        json(200, {
          id: "completion",
          object: "chat.completion",
          created: 0,
          model: JSON.parse(raw || "{}").model,
          choices: [
            { index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" },
          ],
        })
      )
      return
    }
    json(404, { error: { message: "not found" } })
  })
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()))
  const baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`

  const config = configFor()
  const registry = new ModelProfileRegistry(
    openDb(":memory:"),
    config as never,
    envPath
  )
  const app = express()
  app.use(express.json())
  app.use(identity({ scopes: ["admin"] }))
  app.use(
    "/api",
    createModelProfilesRouter({
      registry,
      config,
      // A saved slot must probe with its own credentials, never the boot client.
      clients: {
        chatClient: fakeOpenAI({
          chat: {
            completions: {
              create: async () => {
                throw new Error("the boot client must not probe a saved slot")
              },
            },
          },
        }),
        embeddingClient: fakeOpenAI({}),
      },
    })
  )
  const admin = await listen(app)

  try {
    const before = (await (
      await fetch(`${admin.base}/api/models/profiles/chat/config`)
    ).json()) as { config: { baseUrl: string; source: string } }
    assert.equal(before.config.baseUrl, config.openaiBaseUrl)
    assert.equal(before.config.source, "env")

    const saved = await fetch(`${admin.base}/api/models/profiles/chat/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl, model: "saved-a", apiKey: "sk-saved" }),
    })
    assert.equal(saved.status, 200)
    const savedBody = await saved.json()
    assert.equal((savedBody as { config: { source: string } }).config.source, "file")
    assert.ok(!JSON.stringify(savedBody).includes("sk-saved"))

    const envText = await readFile(envPath, "utf8")
    assert.ok(envText.includes("OPENAI_API_KEY=sk-saved"))
    assert.ok(envText.includes("OPENAI_CHAT_MODEL=saved-a"))
    assert.ok(envText.includes("# keep me"))

    const listed = (await (
      await fetch(`${admin.base}/api/models/profiles`)
    ).json()) as { profiles: Array<{ id: string; model: string; baseUrlHost: string }> }
    const chat = listed.profiles.find((profile) => profile.id === "chat")
    assert.equal(chat?.model, "saved-a")
    assert.ok((chat?.baseUrlHost ?? "").startsWith("127.0.0.1"))

    const discovered = (await (
      await fetch(`${admin.base}/api/models/profiles/chat/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    ).json()) as { ok: boolean; models: string[] }
    assert.equal(discovered.ok, true)
    assert.deepEqual(discovered.models, ["saved-a", "saved-b"])

    const probed = (await (
      await fetch(`${admin.base}/api/models/profiles/chat/test`, { method: "POST" })
    ).json()) as { ok: boolean; error: string | null }
    assert.equal(probed.ok, true)

    // Saving without a key keeps the stored credential.
    await fetch(`${admin.base}/api/models/profiles/chat/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl, model: "saved-b" }),
    })
    assert.ok((await readFile(envPath, "utf8")).includes("OPENAI_API_KEY=sk-saved"))
  } finally {
    await admin.close()
    provider.closeAllConnections?.()
    provider.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("rerank discovery keeps only the models the provider publishes as rerankers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-rerank-"))
  const envPath = join(dir, ".env")
  await writeFile(envPath, "# keep me\n", "utf8")
  const provider = http.createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    }
    if (req.url === "/v1/models") {
      if (req.headers.authorization !== "Bearer sk-rerank") {
        return json(401, { error: { message: "nope" } })
      }
      return json(200, {
        object: "list",
        data: [
          { id: "glm-4.6" },
          { id: "Qwen/Qwen3-Reranker-8B" },
          { id: "BAAI/bge-reranker-v2-m3" },
        ],
      })
    }
    json(404, { error: { message: "not found" } })
  })
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()))
  const baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`

  const config = configFor()
  const registry = new ModelProfileRegistry(openDb(":memory:"), config as never, envPath)
  const app = express()
  app.use(express.json())
  app.use(identity({ scopes: ["admin"] }))
  app.use(
    "/api",
    createModelProfilesRouter({
      registry,
      config,
      clients: { chatClient: fakeOpenAI({}), embeddingClient: fakeOpenAI({}) },
    })
  )
  const admin = await listen(app)

  try {
    const saved = await fetch(`${admin.base}/api/models/profiles/rerank/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl, model: "BAAI/bge-reranker-v2-m3", apiKey: "sk-rerank" }),
    })
    assert.equal(saved.status, 200)

    const discovered = (await (
      await fetch(`${admin.base}/api/models/profiles/rerank/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    ).json()) as { ok: boolean; models: string[] }
    assert.equal(discovered.ok, true)
    assert.deepEqual(discovered.models, ["BAAI/bge-reranker-v2-m3", "Qwen/Qwen3-Reranker-8B"])
  } finally {
    await admin.close()
    provider.closeAllConnections?.()
    provider.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("the settings routes refuse malformed values, a read-only server and an unknown slot", async () => {
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
  const admin = await listen(app)
  const put = (body: unknown) =>
    fetch(`${admin.base}/api/models/profiles/chat/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

  try {
    assert.equal((await put({ baseUrl: "ftp://chat.example.com", model: "m" })).status, 400)
    assert.equal((await put({ baseUrl: "https://chat.example.com/v1", model: "  " })).status, 400)
    const readOnly = await put({ baseUrl: "https://chat.example.com/v1", model: "m", apiKey: "k" })
    assert.equal(readOnly.status, 400)
    assert.match(((await readOnly.json()) as { error: string }).error, /read-only/)
    const rerankDiscover = (await (
      await fetch(`${admin.base}/api/models/profiles/rerank/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    ).json()) as { ok: boolean; models: string[] }
    // The slot now probes like the others; without a credential it reports
    // that instead of the old protocol refusal.
    assert.equal(rerankDiscover.ok, false)
    assert.deepEqual(rerankDiscover.models, [])
    assert.equal((await fetch(`${admin.base}/api/models/profiles/nope/config`)).status, 404)
  } finally {
    await admin.close()
  }
})
