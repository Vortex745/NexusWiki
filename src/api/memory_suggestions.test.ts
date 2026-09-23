/**
 * Ticket 33 (MEM-01B) — the suggestion review API: only pending rows settle,
 * accepting publishes a real memory, ownership is per (tenant, subject).
 */
import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express, { type NextFunction, type Request, type Response } from "express"

import { createMemorySuggestionsRouter } from "./memory_suggestions"
import { LongTermMemoryStore } from "../memory/long_term_memory_store"
import { MemorySuggestionStore } from "../memory/memory_suggestion_store"
import { openDb } from "../ingestion/tracking/db"
import { SINGLE_TENANT_TENANT, type AccessContext } from "../access/context"

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

function appFor() {
  const app = express()
  app.use(express.json())
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.locals.accessContext = req.headers["x-test-user"] === "bob" ? bob : alice
    next()
  })
  const db = openDb(":memory:")
  const store = new LongTermMemoryStore({ db })
  const suggestions = new MemorySuggestionStore({ db })
  app.use("/api", createMemorySuggestionsRouter({ suggestions, memories: store }))
  const server = app.listen(0)
  const port = (server.address() as AddressInfo).port
  return {
    suggestions,
    store,
    close: () => server.close(),
    request: (user: "alice" | "bob", path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${port}/api${path}`, {
        ...init,
        headers: { "content-type": "application/json", "x-test-user": user, ...(init.headers ?? {}) },
      }),
  }
}

test("Ticket 33: the review loop — pending list, accept publishes a memory, dismiss discards", async () => {
  const app = appFor()
  try {
    const suggestion = app.suggestions.createPending({
      tenantId: SINGLE_TENANT_TENANT,
      subjectId: "alice",
      assistantId: null,
      sourceRunId: "run-1",
      content: "记住：回答结论先行",
    })!
    const listed = await app.request("alice", "/memory-suggestions")
    assert.equal(((await listed.json()) as { suggestions: unknown[] }).suggestions.length, 1)

    const accepted = await app.request("alice", `/memory-suggestions/${suggestion.id}/accept`, {
      method: "POST",
    })
    assert.equal(accepted.status, 200)
    const { memory } = (await accepted.json()) as { memory: { content: string } }
    assert.equal(memory.content, "记住：回答结论先行")
    // The published memory is a plain user-owned record.
    assert.equal(app.store.list(SINGLE_TENANT_TENANT, "alice").length, 1)
    // The suggestion is settled — accepting again is a 409, not a duplicate.
    const again = await app.request("alice", `/memory-suggestions/${suggestion.id}/accept`, {
      method: "POST",
    })
    assert.equal(again.status, 409)

    const other = app.suggestions.createPending({
      tenantId: SINGLE_TENANT_TENANT,
      subjectId: "alice",
      assistantId: null,
      sourceRunId: "run-2",
      content: "记住：不要术语堆砌",
    })!
    const dismissed = await app.request("alice", `/memory-suggestions/${other.id}/dismiss`, {
      method: "POST",
    })
    assert.equal(dismissed.status, 200)
    assert.equal(app.store.list(SINGLE_TENANT_TENANT, "alice").length, 1, "dismiss publishes nothing")
  } finally {
    app.close()
  }
})

test("Ticket 33: another user's suggestion is the same 404 as an unknown one", async () => {
  const app = appFor()
  try {
    const suggestion = app.suggestions.createPending({
      tenantId: SINGLE_TENANT_TENANT,
      subjectId: "alice",
      assistantId: null,
      sourceRunId: "run-1",
      content: "alice 的建议",
    })!
    const bobList = await app.request("bob", "/memory-suggestions")
    assert.equal(((await bobList.json()) as { suggestions: unknown[] }).suggestions.length, 0)
    const accept = await app.request("bob", `/memory-suggestions/${suggestion.id}/accept`, {
      method: "POST",
    })
    assert.equal(accept.status, 404)
    const dismiss = await app.request("bob", `/memory-suggestions/${suggestion.id}/dismiss`, {
      method: "POST",
    })
    assert.equal(dismiss.status, 404)
    assert.equal(app.suggestions.list(SINGLE_TENANT_TENANT, "alice").length, 1)
  } finally {
    app.close()
  }
})
