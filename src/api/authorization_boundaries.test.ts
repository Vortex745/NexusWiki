import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"
import type { Request } from "express"

import { createAccessMiddleware } from "./access_middleware"
import { createApp } from "./server"
import { createDocumentsRouter, type ChunkReader, type ChunkViewDoc } from "./documents"
import type { AccessContext, IdentityAdapter } from "../access/context"
import { openDb, type DB } from "../ingestion/tracking/db"
import { SqliteSessionBinder } from "../access/session_binder"
import { SqliteConversationHistoryStore } from "../answer/conversation_history_store"
import { AnswerTraceRepository } from "../answer/trace_repository"
import { LongTermMemoryStore } from "../memory/long_term_memory_store"
import { KnowledgeBaseServiceImpl } from "../knowledge/knowledge_base_service"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import { PageIndexRepository } from "../ingestion/tracking/page_index_repo"
import { createRetrievalScopeResolver } from "../retrieval/scope"
import type { AnswerReference, AnswerRunEvent } from "../types"
import type { AnswerEventsSource } from "./chat"

/**
 * DR-18 — authorization and tenant boundaries for exact resource reads.
 *
 * Every assertion goes through real HTTP + the real access middleware/session
 * binder/retrieval scope/document router. Covered resources:
 *   - session / run history   GET  /api/chat/runs/:runId
 *   - conversation history    GET  /api/conversations/:id
 *   - document + citation     GET  /api/documents/:docId[/chunks/:chunkId]
 *   - long-term memory        GET/PATCH /api/memories[/:id]
 *
 * Unauthenticated → 401; same-tenant peer without ownership/group → the same
 * 404 an unknown id produces; another tenant → the same 404. No response may
 * reveal that a forbidden resource exists.
 */

const TENANT_A = "tenant-a"
const TENANT_B = "tenant-b"

/** Synthetic identities selected by a test header — no token/provider needed. */
const identities: Record<string, AccessContext> = {
  alice: { tenantId: TENANT_A, subjectId: "u-alice", groups: ["tech"], scopes: ["chat"] },
  bob: { tenantId: TENANT_A, subjectId: "u-bob", groups: [], scopes: ["chat"] },
  dana: { tenantId: TENANT_A, subjectId: "u-dana", groups: ["policy"], scopes: ["chat"] },
  eve: { tenantId: TENANT_B, subjectId: "u-eve", groups: ["policy"], scopes: ["chat"] },
}

const adapter: IdentityAdapter = {
  resolve: async (req) => {
    const raw = (req as Request).headers["x-test-identity"]
    return typeof raw === "string" ? identities[raw] ?? null : null
  },
}

async function listen(app: express.Express) {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return {
    server,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  }
}

interface Reply {
  status: number
  text: string
  json: Record<string, unknown> | null
}

async function call(
  base: string,
  path: string,
  identity?: keyof typeof identities,
  init: RequestInit = {}
): Promise<Reply> {
  const res = await fetch(`${base}/api${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(identity ? { "x-test-identity": identity } : {}),
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  let json: Record<string, unknown> | null = null
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    json = null
  }
  return { status: res.status, text, json }
}

const reference: AnswerReference = {
  id: "ev-1",
  documentId: "doc-public",
  documentVersionId: "doc-public",
  documentVersion: 1,
  chunkId: "chunk-public",
  title: "公开政策",
  source: "policy.txt",
  page: 1,
  sectionPath: ["公开"],
  excerpt: "公开条款内容",
  channels: ["bm25"],
  score: 0.9,
  wikilinks: [],
}

function runEvents(runId: string, sessionId: string): AnswerRunEvent[] {
  const base = {
    schemaVersion: 1 as const,
    sessionId,
    runId,
    createdAt: "2026-10-22T00:00:00.000Z",
    durationMs: null,
    attempt: 1,
    round: 1,
    inputSummary: "",
    outputSummary: "",
  }
  return [
    {
      ...base,
      type: "done",
      stage: "done",
      status: "completed",
      eventId: `${runId}:1`,
      sequence: 1,
      result: {
        runId,
        status: "insufficient_evidence",
        reply: "当前证据不足，需要人工确认。",
        references: [reference],
        degradation: { status: "insufficient", unavailableChannels: [] },
      },
    },
  ]
}

interface Harness {
  db: DB
  base: string
  close: () => Promise<void>
  memories: LongTermMemoryStore
  documentRepo: DocumentRepo
}

/** One real server: enforced chat + identity middleware, real SQLite stores. */
async function buildHarness(): Promise<Harness> {
  const db = openDb(":memory:")
  const knowledgeBases = new KnowledgeBaseServiceImpl(new SqliteKnowledgeBaseRepo(db), "test:3")
  knowledgeBases.ensureDefault(TENANT_A)
  const conversationHistory = new SqliteConversationHistoryStore(db)
  const memories = new LongTermMemoryStore({ db })
  const sessionBinder = new SqliteSessionBinder(db)
  const documentRepo = new DocumentRepo(db)
  const trace = new AnswerTraceRepository(db)

  const eventsSource: AnswerEventsSource = async function* (_message, options) {
    const runId = options.runId ?? "run"
    const sessionId = options.sessionId ?? "session"
    for (const event of runEvents(runId, sessionId)) {
      trace.onEvent(event)
      yield event
    }
  }

  const accessMiddleware = createAccessMiddleware({
    mode: "enforced",
    adapter,
    requiredScope: "chat",
  })
  const managementAccessMiddleware = createAccessMiddleware({ mode: "enforced", adapter })

  const app = createApp({
    db,
    eventsSource,
    accessMiddleware,
    managementAccessMiddleware,
    sessionBinder,
    retrievalScopeResolver: createRetrievalScopeResolver(knowledgeBases),
    knowledgeBaseService: knowledgeBases,
    conversationHistory,
    memories,
  })
  const { server, base } = await listen(app)
  return {
    db,
    base,
    memories,
    documentRepo,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      db.close()
    },
  }
}

function seedDocument(
  repo: DocumentRepo,
  db: DB,
  input: {
    docId: string
    tenantId: string
    allowedGroups: string[]
    title: string
  }
): void {
  const source = repo.createSource({
    sourceId: `src-${input.docId}`,
    sourceKey: `key-${input.docId}`,
    kind: "submission",
    uri: `uri-${input.docId}`,
    namespace: "test",
    tenantId: input.tenantId,
    allowedGroups: input.allowedGroups,
    knowledgeBaseId: `kb-${input.tenantId}`,
  })
  repo.insert({
    docId: input.docId,
    sourceId: source.sourceId,
    contentHash: `hash-${input.docId}`,
    version: 1,
    title: input.title,
    source: "api",
    content: `CONTENT-OF-${input.docId}`,
    tenantId: input.tenantId,
    allowedGroups: input.allowedGroups,
    knowledgeBaseId: `kb-${input.tenantId}`,
  })
  db.prepare("UPDATE documents SET created_at = ?, updated_at = ? WHERE doc_id = ?")
    .run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", input.docId)
}

test("DR-18: unauthenticated calls are denied on every exact read surface", async () => {
  const harness = await buildHarness()
  try {
    harness.memories.create({
      tenantId: TENANT_A,
      subjectId: "u-alice",
      content: "alice 的私有偏好",
    })
    seedDocument(harness.documentRepo, harness.db, {
      docId: "doc-public",
      tenantId: TENANT_A,
      allowedGroups: [],
      title: "公开政策",
    })

    for (const path of [
      "/chat/runs/run-any",
      "/conversations/sess-any",
      "/memories",
      "/documents/doc-public",
      "/documents/doc-public/chunks/chunk-public",
    ]) {
      const denied = await call(harness.base, path)
      assert.equal(denied.status, 401, `${path} must reject an unauthenticated caller`)
      assert.equal(
        denied.text.includes("alice 的私有偏好"),
        false,
        `${path} must not expose memory content`
      )
    }
  } finally {
    await harness.close()
  }
})

test("DR-18: run, conversation and memory reads succeed for the owner only", async () => {
  const harness = await buildHarness()
  try {
    const memory = harness.memories.create({
      tenantId: TENANT_A,
      subjectId: "u-alice",
      content: "alice 的私有偏好",
    })
    seedDocument(harness.documentRepo, harness.db, {
      docId: "doc-public",
      tenantId: TENANT_A,
      allowedGroups: [],
      title: "公开政策",
    })

    const chat = await call(harness.base, "/chat", "alice", {
      method: "POST",
      body: JSON.stringify({ message: "退款期限？", stream: false, sessionId: "sess-alice", runId: "run-alice" }),
    })
    assert.equal(chat.status, 200)

    // Owner: the run, its references and the history turns are readable.
    const ownRun = await call(harness.base, "/chat/runs/run-alice", "alice")
    assert.equal(ownRun.status, 200)
    assert.equal(ownRun.text.includes("chunk-public"), true, "the owner sees the run references")
    assert.equal(ownRun.text.includes("当前证据不足"), true)

    const ownHistory = await call(harness.base, "/conversations/sess-alice", "alice")
    assert.equal(ownHistory.status, 200)
    assert.equal(ownHistory.text.includes("当前证据不足"), true)

    const ownMemory = await call(harness.base, "/memories", "alice")
    assert.equal(ownMemory.status, 200)
    assert.equal(ownMemory.text.includes("alice 的私有偏好"), true)

    // Same tenant, different subject: the owner's data is invisible.
    const peerRun = await call(harness.base, "/chat/runs/run-alice", "bob")
    assert.equal(peerRun.status, 404)
    assert.equal(peerRun.text.includes("chunk-public"), false)
    const peerHistory = await call(harness.base, "/conversations/sess-alice", "bob")
    assert.equal(peerHistory.status, 404)
    assert.equal(peerHistory.text.includes("当前证据不足"), false)
    const peerMemory = await call(harness.base, "/memories", "bob")
    assert.equal(peerMemory.status, 200)
    assert.equal(peerMemory.json?.memories instanceof Array && (peerMemory.json.memories as unknown[]).length === 0, true)
    const peerMemoryWrite = await call(harness.base, `/memories/${memory.id}`, "bob", {
      method: "PATCH",
      body: JSON.stringify({ content: "篡改" }),
    })
    assert.equal(peerMemoryWrite.status, 404)

    // Another tenant: same invisible result.
    for (const identity of ["eve"] as const) {
      assert.equal((await call(harness.base, "/chat/runs/run-alice", identity)).status, 404)
      assert.equal((await call(harness.base, "/conversations/sess-alice", identity)).status, 404)
      const list = await call(harness.base, "/memories", identity)
      assert.equal((list.json?.memories as unknown[]).length, 0)
    }
    assert.equal((await call(harness.base, "/memories", "alice")).text.includes("alice 的私有偏好"), true)
  } finally {
    await harness.close()
  }
})

test("DR-18: unknown and forbidden run, conversation and memory reads are indistinguishable", async () => {
  const harness = await buildHarness()
  try {
    const memory = harness.memories.create({ tenantId: TENANT_A, subjectId: "u-alice", content: "私有" })
    await call(harness.base, "/chat", "alice", {
      method: "POST",
      body: JSON.stringify({ message: "问题", stream: false, sessionId: "sess-known", runId: "run-known" }),
    })

    for (const [forbidden, unknown, init] of [
      ["/chat/runs/run-known", "/chat/runs/run-unknown", {}],
      ["/conversations/sess-known", "/conversations/sess-unknown", {}],
      [
        `/memories/${memory.id}`,
        "/memories/mem-unknown",
        { method: "PATCH", body: JSON.stringify({ content: "篡改" }) },
      ],
    ] as Array<[string, string, RequestInit]>) {
      const forbiddenReply = await call(harness.base, forbidden, "bob", init)
      const unknownReply = await call(harness.base, unknown, "bob", init)
      assert.equal(forbiddenReply.status, unknownReply.status, `${forbidden} status parity`)
      assert.equal(forbiddenReply.text, unknownReply.text, `${forbidden} body parity`)
    }
  } finally {
    await harness.close()
  }
})

/** Real access middleware + real documents router with a controlled chunk index. */
async function buildDocumentHarness() {
  const db = openDb(":memory:")
  const knowledgeBases = new KnowledgeBaseServiceImpl(new SqliteKnowledgeBaseRepo(db), "test:3")
  knowledgeBases.ensureDefault(TENANT_A)
  const repo = new DocumentRepo(db)
  seedDocument(repo, db, { docId: "doc-public", tenantId: TENANT_A, allowedGroups: [], title: "公开政策" })
  seedDocument(repo, db, {
    docId: "doc-policy",
    tenantId: TENANT_A,
    allowedGroups: ["policy"],
    title: "受限政策",
  })
  seedDocument(repo, db, { docId: "doc-foreign", tenantId: TENANT_B, allowedGroups: [], title: "外租户政策" })

  const chunks: ChunkViewDoc[] = [
    {
      id: "chunk-public",
      documentId: "doc-public",
      kind: "child",
      content: "公开条款内容",
      parentId: null,
      allowedGroups: [],
      metadata: { index: 0 },
    },
    {
      id: "chunk-policy",
      documentId: "doc-policy",
      kind: "child",
      content: "受限条款内容",
      parentId: null,
      allowedGroups: [],
      metadata: { index: 0 },
    },
    {
      id: "chunk-foreign",
      documentId: "doc-foreign",
      kind: "child",
      content: "外租户条款内容",
      parentId: null,
      allowedGroups: [],
      metadata: { index: 0 },
    },
  ]
  const chunkReader: ChunkReader = {
    async get(documentId, chunkId) {
      return chunks.find((chunk) => chunk.documentId === documentId && chunk.id === chunkId) ?? null
    },
    async listChildChunks(documentId) {
      return chunks.filter((chunk) => chunk.documentId === documentId)
    },
  }

  const app = express()
  app.use(express.json())
  app.use("/api/documents", createAccessMiddleware({ mode: "enforced", adapter, requiredScope: "chat" }))
  app.use(
    "/api",
    createDocumentsRouter({
      documentRepo: repo,
      knowledgeBaseService: knowledgeBases,
      pageIndexRepo: new PageIndexRepository(db),
      chunkReader,
    })
  )
  const { server, base } = await listen(app)
  return {
    db,
    base,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      db.close()
    },
  }
}

test("DR-18: documents and citations obey tenant and group visibility with 404 parity", async () => {
  const harness = await buildDocumentHarness()
  try {
    // Authorized: tenant-wide document and a group-authorized document.
    assert.equal((await call(harness.base, "/documents/doc-public", "bob")).status, 200)
    const allowedDoc = await call(harness.base, "/documents/doc-policy", "dana")
    assert.equal(allowedDoc.status, 200)
    assert.equal(allowedDoc.text.includes("受限政策"), true)
    const allowedChunk = await call(harness.base, "/documents/doc-policy/chunks/chunk-policy", "dana")
    assert.equal(allowedChunk.status, 200)
    assert.equal(allowedChunk.text.includes("受限条款内容"), true)

    // Same tenant without the authorizing group: the document and its citation
    // are the same 404 as an unknown id.
    const forbiddenDoc = await call(harness.base, "/documents/doc-policy", "alice")
    const forbiddenChunk = await call(harness.base, "/documents/doc-policy/chunks/chunk-policy", "alice")
    assert.equal(forbiddenDoc.status, 404)
    assert.equal(forbiddenChunk.status, 404)
    assert.equal(forbiddenChunk.text.includes("受限条款内容"), false)
    assert.equal(forbiddenChunk.text.includes("受限政策"), false)

    // Cross-tenant reads are equally indistinguishable.
    const foreignDoc = await call(harness.base, "/documents/doc-foreign", "alice")
    const foreignChunk = await call(harness.base, "/documents/doc-foreign/chunks/chunk-foreign", "alice")
    assert.equal(foreignDoc.status, 404)
    assert.equal(foreignChunk.status, 404)
    assert.equal(foreignChunk.text.includes("外租户条款内容"), false)

    const unknownDoc = await call(harness.base, "/documents/doc-unknown", "alice")
    const unknownChunk = await call(harness.base, "/documents/doc-unknown/chunks/chunk-unknown", "alice")
    assert.equal(forbiddenDoc.text, unknownDoc.text, "forbidden and unknown document body parity")
    assert.equal(forbiddenChunk.text, unknownChunk.text, "forbidden and unknown citation body parity")
    assert.equal(foreignDoc.text, unknownDoc.text)

    // Unauthenticated document/citation reads are denied by the middleware.
    assert.equal((await call(harness.base, "/documents/doc-public")).status, 401)
    assert.equal((await call(harness.base, "/documents/doc-public/chunks/chunk-public")).status, 401)
  } finally {
    await harness.close()
  }
})
