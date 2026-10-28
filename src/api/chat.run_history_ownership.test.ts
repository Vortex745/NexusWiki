import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test, { type TestContext } from "node:test"
import type { Request } from "express"
import type { AccessContext } from "../access/context"
import { SqliteConversationHistoryStore } from "../answer/conversation_history_store"
import { AnswerTraceRepository } from "../answer/trace_repository"
import { openDb } from "../ingestion/tracking/db"
import type { AnswerRunEvent } from "../types"
import { createAccessMiddleware } from "./access_middleware"
import { createApp } from "./server"

const owner: AccessContext = {
  tenantId: "tenant-bob", subjectId: "bob", groups: [], scopes: ["chat"],
}
const identities: Record<string, AccessContext> = {
  "Bearer bob": owner,
  "Bearer alice-same-tenant": { ...owner, subjectId: "alice" },
  "Bearer alice-other-tenant": {
    tenantId: "tenant-alice", subjectId: "alice", groups: [], scopes: ["chat"],
  },
  "Bearer bob-other-tenant": { ...owner, tenantId: "tenant-alice" },
  "Bearer bob-no-chat": { ...owner, scopes: [] },
}
const notFound = { error: "Answer run not found" }

async function historyApp(t: TestContext, locked = true) {
  const db = openDb(":memory:")
  const directories = new SqliteConversationHistoryStore(db)
  const traces = new AnswerTraceRepository(db)
  directories.ensureDirectory("bob-session", owner.tenantId, owner.subjectId, "Synthetic private question")
  if (locked) {
    directories.lockSession("bob-session", owner.tenantId, owner.subjectId, {
      assistantId: "synthetic-assistant", assistantVersion: 1, knowledgeBaseIds: ["synthetic-kb"],
    })
  }
  const base = {
    schemaVersion: 1 as const,
    runId: "bob-run", sessionId: "bob-session",
    createdAt: "2026-10-28T00:00:00.000Z",
    durationMs: null, attempt: 1, round: 1, inputSummary: "", outputSummary: "",
  }
  const events: AnswerRunEvent[] = [
    {
      ...base, type: "progress", stage: "route", status: "running",
      eventId: "bob-run:1", sequence: 1, message: "Synthetic private event", data: {},
    },
    {
      ...base, type: "done", stage: "done", status: "completed",
      eventId: "bob-run:2", sequence: 2,
      result: {
        runId: "bob-run", status: "completed", reply: "Synthetic private reply",
        references: [], degradation: { status: "none", unavailableChannels: [] },
      },
    },
  ]
  for (const event of events) traces.onEvent(event)
  const app = createApp({
    db, conversationHistory: directories,
    eventsSource: async function* () { throw new Error("History must not start generation") },
    accessMiddleware: createAccessMiddleware({
      mode: "enforced", requiredScope: "chat",
      adapter: { resolve: async (req) => identities[(req as Request).get("authorization") ?? ""] ?? null },
    }),
  })
  const server = app.listen(0)
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
  })
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, events, traces }
}

test("an authenticated user in another tenant cannot restore a private run", async (t) => {
  const { base } = await historyApp(t)
  const response = await fetch(`${base}/api/chat/runs/bob-run`, {
    headers: { authorization: "Bearer alice-other-tenant" },
  })
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), notFound)
})

test("the owner restores the complete ordered events of a locked session", async (t) => {
  const { base, events } = await historyApp(t)
  const response = await fetch(`${base}/api/chat/runs/bob-run`, {
    headers: { authorization: "Bearer bob" },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { runId: "bob-run", sessionId: "bob-session", events })
})

test("the owner can restore a session before any assistant or knowledge lock exists", async (t) => {
  const { base, events } = await historyApp(t, false)
  const response = await fetch(`${base}/api/chat/runs/bob-run`, {
    headers: { authorization: "Bearer bob" },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { runId: "bob-run", sessionId: "bob-session", events })
})

for (const scenario of [
  { name: "another subject in the same tenant", token: "Bearer alice-same-tenant", query: "" },
  { name: "the same subject identifier in another tenant", token: "Bearer bob-other-tenant", query: "" },
  {
    name: "a foreign user supplying the owner's identity in query parameters",
    token: "Bearer alice-other-tenant",
    query: "?tenantId=tenant-bob&subjectId=bob&sessionId=bob-session",
  },
]) {
  test(`${scenario.name} receives the same not-found response`, async (t) => {
    const { base } = await historyApp(t)
    const response = await fetch(`${base}/api/chat/runs/bob-run${scenario.query}`, {
      headers: {
        authorization: scenario.token,
        "x-tenant-id": owner.tenantId,
        "x-subject-id": owner.subjectId,
      },
    })
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), notFound)
  })
}

test("unknown runs and persisted traces without a directory are indistinguishable", async (t) => {
  const { base, events, traces } = await historyApp(t)
  traces.onEvent({ ...events[0], runId: "orphan-run", sessionId: "missing-session", eventId: "orphan:1" })
  for (const runId of ["unknown-run", "orphan-run"]) {
    const response = await fetch(`${base}/api/chat/runs/${runId}`, {
      headers: { authorization: "Bearer bob" },
    })
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), notFound)
  }
})

test("missing identity is rejected by the existing authentication gate", async (t) => {
  const { base } = await historyApp(t)
  const response = await fetch(`${base}/api/chat/runs/bob-run`)
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: "missing identity" })
})

test("an authenticated owner without chat scope is rejected before history is returned", async (t) => {
  const { base } = await historyApp(t)
  const response = await fetch(`${base}/api/chat/runs/bob-run`, {
    headers: { authorization: "Bearer bob-no-chat" },
  })
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: "missing scope: chat" })
})
