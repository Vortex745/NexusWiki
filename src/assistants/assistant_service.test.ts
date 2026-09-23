/**
 * Ticket 18 (AST-01A) — assistant workspace service + HTTP API.
 *
 * Focus: validated contracts, immutable versions that stay readable after
 * edits, group-filtered reader visibility that omits execution config, and
 * the archived state machine.
 */

import assert from "node:assert/strict"
import test from "node:test"
import type { AddressInfo } from "node:net"
import express, { type RequestHandler } from "express"

import type { AppConfig } from "../config"
import type { DB } from "../ingestion/tracking/db"
import { openDb } from "../ingestion/tracking/db"
import {
  AssistantArchivedError,
  AssistantService,
  InvalidAssistantCommandError,
} from "./assistant_service"
import { KnowledgeBaseServiceImpl } from "../knowledge/knowledge_base_service"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { createAssistantsRouter } from "../api/assistants"
import type { AccessContext } from "../access/context"
import type { AnswerRunEvent } from "../types"

const CONFIG: AppConfig = {
  esNode: "http://es.test",
  esApiKey: "",
  openaiApiKey: "chat-key",
  openaiBaseUrl: "http://chat.test",
  openaiChatModel: "test-chat-model",
  embeddingApiKey: "emb-key",
  embeddingBaseUrl: "http://emb.test",
  embeddingModel: "test-embedding-model",
  embeddingDimensions: 3,
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
  rerankApiKey: "rerank-key",
  rerankBaseUrl: "https://reranker.test/v1",
  rerankModel: "bge-reranker-v2-m3",
  rerankTimeoutMs: 5_000,
  rerankMaxDocumentChars: 4_000,
  // Ticket 35: never spawn the MCP capability server from tests.
  mcpCapabilitiesEnabled: false,
}

const VALID_CONFIG = {
  systemPrompt: "你是客服助手",
  knowledgeBaseIds: [],
  chatModelProfileId: "chat" as const,
  rerankModelProfileId: null,
  toolPolicy: "read_only_retrieval" as const,
  memoryEnabled: false,
}

function identity(ctx: Partial<AccessContext> & { scopes: AccessContext["scopes"]; groups?: string[] }): RequestHandler {
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

function buildService(db: DB, options: { rerankSelectable?: boolean } = {}) {
  const knowledgeBases = new KnowledgeBaseServiceImpl(
    new SqliteKnowledgeBaseRepo(db),
    "test-embedding-model:3"
  )
  return new AssistantService(db, knowledgeBases, {
    assertRerankProfileSelectable: () => {
      if (options.rerankSelectable === false) {
        throw new InvalidAssistantCommandError(
          "the rerank model profile is disabled on this server"
        )
      }
    },
  })
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

// A never-consumed fake events source — createApp requires the field but the
// assistant routes never touch the answer runtime.
const unusedEventsSource = async function* (_message: string): AsyncGenerator<AnswerRunEvent> {
  yield {} as AnswerRunEvent
}

test("create validates the contract, seeds version 1, and get returns the config", () => {
  const db = openDb(":memory:")
  const service = buildService(db)
  const created = service.create("t1", "admin-1", {
    name: "客服助手",
    description: "demo",
    config: VALID_CONFIG,
  })
  assert.equal(created.status, "active")
  assert.equal(created.currentVersion, 1)
  assert.equal(created.version.config.systemPrompt, "你是客服助手")
  assert.deepEqual(created.allowedGroups, [])
  // Read back through a fresh service (restart semantics).
  const reread = buildService(db).get(created.id, "t1")
  assert.equal(reread?.version.config.toolPolicy, "read_only_retrieval")
})

test("invalid commands are refused with field-named errors", () => {
  const db = openDb(":memory:")
  const knowledgeBases = new KnowledgeBaseServiceImpl(
    new SqliteKnowledgeBaseRepo(db),
    "test-embedding-model:3"
  )
  const service = new AssistantService(db, knowledgeBases)
  const tenant = "t1"
  knowledgeBases.ensureDefault(tenant)

  assert.throws(() => service.create(tenant, "u", { name: "  ", config: VALID_CONFIG }), /name must be a non-empty string/)
  assert.throws(
    () => service.create(tenant, "u", { name: "x", config: { ...VALID_CONFIG, chatModelProfileId: "other" } }),
    /chatModelProfileId/
  )
  assert.throws(
    () => service.create(tenant, "u", { name: "x", config: { ...VALID_CONFIG, rerankModelProfileId: "gpt" } }),
    /rerankModelProfileId/
  )
  assert.throws(
    () => service.create(tenant, "u", { name: "x", config: { ...VALID_CONFIG, toolPolicy: "admin_all" } }),
    /toolPolicy/
  )
  assert.throws(
    () => service.create(tenant, "u", { name: "x", config: { ...VALID_CONFIG, knowledgeBaseIds: [42] } }),
    /knowledgeBaseIds/
  )
  // An unknown or archived knowledge base binding is refused at save time.
  assert.throws(
    () =>
      service.create(tenant, "u", {
        name: "x",
        config: { ...VALID_CONFIG, knowledgeBaseIds: ["kb-missing"] },
      }),
    /unknown knowledge base/
  )
  // A non-default KB that is archived is refused at binding time too.
  const kb = knowledgeBases.create(tenant, "政策库")
  knowledgeBases.archive(kb.id, tenant)
  assert.throws(
    () =>
      service.create(tenant, "u", {
        name: "x",
        config: { ...VALID_CONFIG, knowledgeBaseIds: [kb.id] },
      }),
    /archived knowledge base/
  )
  // A disabled rerank profile is refused through the injected seam.
  const gated = buildService(db, { rerankSelectable: false })
  assert.throws(
    () =>
      gated.create(tenant, "u", {
        name: "x",
        config: { ...VALID_CONFIG, rerankModelProfileId: "rerank" },
      }),
    /rerank model profile is disabled/
  )
})

test("edits create immutable new versions; old versions stay readable", () => {
  const db = openDb(":memory:")
  const service = buildService(db)
  const created = service.create("t1", "admin-1", { name: "助手", config: VALID_CONFIG })

  // Metadata-only edit: no new version.
  const renamed = service.edit(created.id, "t1", "admin-1", { name: "改名", description: "新描述" })
  assert.equal(renamed.currentVersion, 1)
  assert.equal(renamed.name, "改名")

  // Config edit: version 2 becomes current; version 1 is untouched.
  const edited = service.edit(created.id, "t1", "admin-1", {
    config: { ...VALID_CONFIG, systemPrompt: "新提示词", toolPolicy: "none" },
  })
  assert.equal(edited.currentVersion, 2)
  assert.equal(edited.version.config.systemPrompt, "新提示词")

  const versions = service.listVersions(created.id, "t1")
  assert.deepEqual(
    versions.map((v) => v.version),
    [1, 2]
  )
  const old = service.getVersion(created.id, "t1", 1)
  assert.equal(old?.config.systemPrompt, "你是客服助手", "version 1 is immutable")
  assert.equal(old?.config.toolPolicy, "read_only_retrieval")
})

test("archived assistants refuse edits, restore reactivates", () => {
  const db = openDb(":memory:")
  const service = buildService(db)
  const created = service.create("t1", "admin-1", { name: "助手", config: VALID_CONFIG })
  service.archive(created.id, "t1")
  assert.equal(service.get(created.id, "t1")?.status, "archived")
  assert.throws(() => service.edit(created.id, "t1", "u", { name: "x" }), AssistantArchivedError)
  // The archived assistant's versions remain readable (conversation references).
  assert.equal(service.getVersion(created.id, "t1", 1)?.config.systemPrompt, "你是客服助手")
  const restored = service.restore(created.id, "t1")
  assert.equal(restored.status, "active")
})

test("reader visibility follows allowed groups; admins and zero-group viewers see all", () => {
  const db = openDb(":memory:")
  const service = buildService(db)
  service.create("t1", "admin-1", {
    name: "全员",
    config: VALID_CONFIG,
    allowedGroups: [],
  })
  service.create("t1", "admin-1", {
    name: "技术专属",
    config: VALID_CONFIG,
    allowedGroups: ["technical"],
  })
  const admin: AccessContext = { tenantId: "t1", subjectId: "a", groups: [], scopes: ["admin", "chat"] }
  const zeroGroupReader: AccessContext = { tenantId: "t1", subjectId: "r0", groups: [], scopes: ["chat"] }
  const technicalReader: AccessContext = { tenantId: "t1", subjectId: "r1", groups: ["technical"], scopes: ["chat"] }
  const policyReader: AccessContext = { tenantId: "t1", subjectId: "r2", groups: ["policy"], scopes: ["chat"] }

  // listForViewer lazily seeds the deterministic default assistant, which is
  // group-free and therefore visible to every viewer.
  const namesFor = (ctx: AccessContext) =>
    service.listForViewer(ctx.tenantId, ctx).map((a) => a.name)
  assert.equal(service.listForViewer("t1", admin).length, 3)
  assert.equal(service.listForViewer("t1", zeroGroupReader).length, 3)
  // List order is created_at ASC — the default assistant is seeded last.
  assert.deepEqual(namesFor(technicalReader), ["全员", "技术专属", "默认助手"])
  assert.deepEqual(namesFor(policyReader), ["全员", "默认助手"])
  // Cross-tenant rows never appear (and get their own default there).
  assert.deepEqual(namesFor({ tenantId: "other-tenant", subjectId: "x", groups: [], scopes: ["admin"] }), ["默认助手"])
})

test("HTTP: admin commands, reader payload omits config, visibility is a 404", async () => {
  const db = openDb(":memory:")
  const knowledgeBases = new KnowledgeBaseServiceImpl(
    new SqliteKnowledgeBaseRepo(db),
    "test-embedding-model:3"
  )
  const service = new AssistantService(db, knowledgeBases)
  const app = express()
  app.use(express.json())
  app.use(
    identity({
      scopes: ["admin", "chat"],
      // This identity carries groups AND admin — admins are never restricted.
      groups: ["technical"],
    })
  )
  app.use("/api", createAssistantsRouter({ service }))
  const admin = await listen(app)

  const readerApp = express()
  readerApp.use(express.json())
  readerApp.use(identity({ scopes: ["chat"], groups: ["policy"] }))
  readerApp.use("/api", createAssistantsRouter({ service }))
  const reader = await listen(readerApp)

  try {
    const created = await fetch(`${admin.base}/api/assistants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "政策助手",
        description: "",
        allowedGroups: ["policy"],
        config: VALID_CONFIG,
      }),
    })
    assert.equal(created.status, 201)
    const createdBody = (await created.json()) as { assistant: { id: string; config?: unknown } }
    const id = createdBody.assistant.id
    assert.ok(createdBody.assistant.config, "admin payload carries the config")

    const malformed = await fetch(`${admin.base}/api/assistants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", config: { ...VALID_CONFIG, toolPolicy: "whatever" } }),
    })
    assert.equal(malformed.status, 400)

    const readerList = await fetch(`${reader.base}/api/assistants`)
    const readerBody = (await readerList.json()) as { assistants: Array<Record<string, unknown>> }
    // The lazily-seeded default assistant + the policy-visible one.
    assert.equal(readerBody.assistants.length, 2)
    const listed = readerBody.assistants.find((a) => a.id === id)
    assert.ok(listed, "group-visible row for the policy reader")
    assert.equal("config" in listed, false, "reader payload omits the config")
    assert.equal("allowedGroups" in listed, false)

    const readerVersion = await fetch(`${reader.base}/api/assistants/${id}/versions/1`)
    const versionBody = (await readerVersion.json()) as { version: Record<string, unknown> }
    assert.equal(versionBody.version.version, 1)
    assert.equal("config" in versionBody.version, false)

    const adminVersion = await fetch(`${admin.base}/api/assistants/${id}/versions/1`)
    const adminVersionBody = (await adminVersion.json()) as { version: Record<string, unknown> }
    assert.ok("config" in adminVersionBody.version)

    const archived = await fetch(`${admin.base}/api/assistants/${id}/archive`, { method: "POST" })
    assert.equal(archived.status, 200)
    const patched = await fetch(`${admin.base}/api/assistants/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    })
    assert.equal(patched.status, 409)

    // A grouped reader outside allowedGroups gets the same 404 as unknown.
    const invisibleApp = express()
    invisibleApp.use(express.json())
    invisibleApp.use(identity({ scopes: ["chat"], groups: ["technical"] }))
    invisibleApp.use("/api", createAssistantsRouter({ service }))
    const invisible = await listen(invisibleApp)
    try {
      const denied = await fetch(`${invisible.base}/api/assistants/${id}`)
      assert.equal(denied.status, 404)
    } finally {
      await invisible.close()
    }
  } finally {
    await admin.close()
    await reader.close()
  }
})
