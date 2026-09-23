/**
 * Ticket 32 (MEM-01A) — the long-term memory HTTP API (user-owned).
 *
 * The routes never accept an owner: identity comes from the access context
 * middleware, so another user's record is the same 404 as an unknown id. An
 * assistant pin must resolve to an assistant the caller can see.
 */
import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express, { type NextFunction, type Request, type Response } from "express"

import { createMemoriesRouter } from "./memories"
import { LongTermMemoryStore } from "../memory/long_term_memory_store"
import { openDb } from "../ingestion/tracking/db"
import { SINGLE_TENANT_TENANT, type AccessContext } from "../access/context"
import type { Assistant, AssistantService } from "../assistants/assistant_service"

const alice: AccessContext = {
  tenantId: SINGLE_TENANT_TENANT,
  subjectId: "alice",
  groups: [],
  scopes: ["chat"],
}
const bob: AccessContext = {
  tenantId: SINGLE_TENANT_TENANT,
  subjectId: "bob",
  groups: [],
  scopes: ["chat"],
}

/**
 * One app, one store, two identities — the test header picks who is calling,
 * exactly like the real middleware picks who the token says is calling.
 */
function appFor(assistants?: AssistantService) {
  const app = express()
  app.use(express.json())
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.locals.accessContext = req.headers["x-test-user"] === "bob" ? bob : alice
    next()
  })
  const store = new LongTermMemoryStore({ db: openDb(":memory:") })
  app.use(
    "/api",
    createMemoriesRouter({ memories: store, ...(assistants ? { assistants } : {}) })
  )
  const server = app.listen(0)
  const port = (server.address() as AddressInfo).port
  return {
    store,
    close: () => server.close(),
    request: (user: "alice" | "bob", path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${port}/api${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-test-user": user,
          ...(init.headers ?? {}),
        },
      }),
  }
}

const fakeAssistants = (): AssistantService => {
  const assistant = {
    id: "ast-1",
    tenantId: SINGLE_TENANT_TENANT,
    status: "active",
  } as unknown as Assistant
  return {
    get: (id: string) => (id === "ast-1" ? assistant : null),
    visibleTo: (candidate: Assistant, ctx: AccessContext) =>
      candidate.id === "ast-1" && ctx.subjectId === "alice",
  } as unknown as AssistantService
}

test("Ticket 32: the product CRUD cycle — add, list, edit, forget, clear", async () => {
  const app = appFor(fakeAssistants())
  try {
    const created = await app.request("alice", "/memories", {
      method: "POST",
      body: JSON.stringify({ content: "回答优先提供 TypeScript 代码", assistantId: "ast-1" }),
    })
    assert.equal(created.status, 201)
    const { memory } = (await created.json()) as { memory: { id: string; assistantId: string | null } }
    assert.equal(memory.assistantId, "ast-1")

    const listed = await app.request("alice", "/memories")
    assert.equal(listed.status, 200)
    assert.equal(((await listed.json()) as { memories: unknown[] }).memories.length, 1)

    const edited = await app.request("alice", `/memories/${memory.id}`, {
      method: "PATCH",
      body: JSON.stringify({ content: "回答优先提供简洁示例" }),
    })
    assert.equal(edited.status, 200)
    assert.equal(
      ((await edited.json()) as { memory: { content: string } }).memory.content,
      "回答优先提供简洁示例"
    )

    const forgotten = await app.request("alice", `/memories/${memory.id}`, { method: "DELETE" })
    assert.equal(forgotten.status, 204)
    const relisted = (await (await app.request("alice", "/memories")).json()) as { memories: unknown[] }
    assert.equal(relisted.memories.length, 0)

    await app.request("alice", "/memories", { method: "POST", body: JSON.stringify({ content: "再来一条" }) })
    const cleared = await app.request("alice", "/memories", { method: "DELETE" })
    assert.equal(cleared.status, 200)
    assert.equal(((await cleared.json()) as { forgotten: number }).forgotten, 1)
  } finally {
    app.close()
  }
})

test("Ticket 32: another user cannot list, change or recall those records — same 404 as unknown", async () => {
  const app = appFor(fakeAssistants())
  try {
    const created = await app.request("alice", "/memories", {
      method: "POST",
      body: JSON.stringify({ content: "alice 的私有偏好" }),
    })
    const { memory } = (await created.json()) as { memory: { id: string } }

    const listed = await app.request("bob", "/memories")
    assert.equal(((await listed.json()) as { memories: unknown[] }).memories.length, 0)
    const patched = await app.request("bob", `/memories/${memory.id}`, {
      method: "PATCH",
      body: JSON.stringify({ content: "篡改" }),
    })
    assert.equal(patched.status, 404)
    const deleted = await app.request("bob", `/memories/${memory.id}`, { method: "DELETE" })
    assert.equal(deleted.status, 404)

    // Alice's record is untouched by all of bob's attempts.
    assert.equal(app.store.list(SINGLE_TENANT_TENANT, "alice").length, 1)
    assert.equal(app.store.list(SINGLE_TENANT_TENANT, "alice")[0].content, "alice 的私有偏好")
  } finally {
    app.close()
  }
})

test("Ticket 32: an assistant pin must be visible to the caller; content is validated", async () => {
  const app = appFor(fakeAssistants())
  try {
    const pinned = await app.request("alice", "/memories", {
      method: "POST",
      body: JSON.stringify({ content: "x", assistantId: "ast-1" }),
    })
    assert.equal(pinned.status, 201)

    // Unknown, cross-tenant and group-invisible assistants are the same 404;
    // ast-1 is visible to alice only, so bob's pin attempt is refused too.
    const unknown = await app.request("alice", "/memories", {
      method: "POST",
      body: JSON.stringify({ content: "x", assistantId: "ast-unknown" }),
    })
    assert.equal(unknown.status, 404)
    const invisible = await app.request("bob", "/memories", {
      method: "POST",
      body: JSON.stringify({ content: "x", assistantId: "ast-1" }),
    })
    assert.equal(invisible.status, 404)

    const empty = await app.request("alice", "/memories", {
      method: "POST",
      body: JSON.stringify({ content: "   " }),
    })
    assert.equal(empty.status, 400)
  } finally {
    app.close()
  }
})
