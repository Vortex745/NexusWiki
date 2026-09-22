/**
 * Ticket 20 (CONV-01A) — server-owned conversation history.
 *
 * Focus: user isolation (another user = 404), terminal statuses that keep
 * success / refusal / failure / cancellation distinguishable after reload,
 * the one-time idempotent browser import (never destructive), and the
 * transport write path — completed runs are covered by the memory layer's
 * validated pairs and are NOT duplicated; non-completed terminals land in
 * the history-only table; a stream that dies records provider_error or
 * cancelled.
 */

import assert from "node:assert/strict"
import test from "node:test"
import type { AddressInfo } from "node:net"
import type { RequestHandler } from "express"

import { openDb } from "../ingestion/tracking/db"
import { createApp } from "../api/server"
import type { AnswerRunOptions } from "../answer/generation"
import type { AnswerRunEvent } from "../types"
import { SqliteConversationHistoryStore } from "./conversation_history_store"
import { SqliteConversationStore } from "./conversation_store"
import type { AccessContext } from "../access/context"

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

async function listen(app: import("express").Express): Promise<{ base: string; close: () => Promise<void> }> {
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

function doneEvent(sessionId: string, runId: string, status: string, reply: string): AnswerRunEvent {
  return {
    schemaVersion: 1,
    sessionId,
    runId,
    eventId: "e-done",
    sequence: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    stage: "done",
    status: "completed",
    durationMs: null,
    attempt: 1,
    round: 1,
    inputSummary: "",
    outputSummary: "",
    type: "done",
    result: {
      runId,
      status,
      reply,
      references: [],
      degradation: { status: "none" },
    },
  } as unknown as AnswerRunEvent
}

test("history is user-isolated and terminal statuses stay distinguishable", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationHistoryStore(db)

  // A completed run: the memory layer wrote the validated pair — history
  // adds nothing and the assistant turn reads as "completed".
  const memory = new SqliteConversationStore(db)
  store.ensureDirectory("sess-1", "t1", "alice", "退款政策是什么？")
  memory.saveValidatedTurn({
    sessionId: "sess-1",
    tenantId: "t1",
    role: "user",
    content: "退款政策是什么？",
    runId: "run-1",
    createdAt: "2026-01-01T00:00:01.000Z",
  })
  memory.saveValidatedTurn({
    sessionId: "sess-1",
    tenantId: "t1",
    role: "assistant",
    content: "退款在 3 个工作日内到账。",
    runId: "run-1",
    createdAt: "2026-01-01T00:00:02.000Z",
  })

  // Refusal, cancellation and failure runs: history-only turns with their
  // terminal status — visible in history, invisible to validated memory.
  store.ensureDirectory("sess-2", "t1", "alice", "能帮我操作退款吗")
  store.recordUnvalidatedRun(
    "sess-2",
    "t1",
    "alice",
    "能帮我操作退款吗",
    "需要您补充订单号。",
    "run-2",
    "clarification_required"
  )
  store.recordUnvalidatedRun(
    "sess-2",
    "t1",
    "alice",
    "继续",
    "退款在 3 个工",
    "run-3",
    "cancelled"
  )
  store.recordUnvalidatedRun("sess-2", "t1", "alice", "再试一次", "", "run-4", "provider_error")

  const directories = store.listDirectories("t1", "alice")
  assert.equal(directories.length, 2)
  assert.equal(directories[0].id, "sess-2", "most recently active first")
  assert.equal(directories[1].title, "退款政策是什么？", "title derives from the first user message")

  const turns = store.getTurns("sess-2", "t1", "alice")
  // Every non-completed run records its own user turn + assistant turn pair.
  assert.deepEqual(
    turns.map((t) => `${t.role}:${t.terminalStatus}`),
    [
      "user:null",
      "assistant:clarification_required",
      "user:null",
      "assistant:cancelled",
      "user:null",
      "assistant:provider_error",
    ]
  )
  // The completed run's unified view reads "completed" from the memory pair.
  const completedTurns = store.getTurns("sess-1", "t1", "alice")
  assert.deepEqual(
    completedTurns.map((t) => `${t.role}:${t.terminalStatus}`),
    ["user:null", "assistant:completed"]
  )
  // Validated memory contains ONLY the memory pair — the refused, cancelled
  // and failed runs never entered it (criterion 4).
  const memoryTurns = db
    .prepare(`SELECT role FROM conversation_turns WHERE kind = 'validated'`)
    .all() as Array<{ role: string }>
  assert.deepEqual(memoryTurns.map((r) => r.role), ["user", "assistant"])

  // Another user's directory: 404-equivalent, both for reads and writes.
  assert.throws(() => store.getTurns("sess-1", "t1", "bob"), /conversation not found/)
  assert.throws(() => store.recordUnvalidatedRun("sess-1", "t1", "bob", "hi", "", "run-x", "cancelled"), /conversation not found/)
  assert.throws(() => store.getTurns("sess-1", "other-tenant", "alice"), /conversation not found/)
  // listDirectories never leaks other users' directories.
  assert.equal(store.listDirectories("t1", "bob").length, 0)
})

test("the one-time browser import is idempotent, user-isolated and never touches memory", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationHistoryStore(db)
  const threads = [
    {
      id: "local-thread-1",
      title: "本地对话一",
      messages: [
        { role: "user" as const, content: "你好" },
        { role: "assistant" as const, content: "您好，请问有什么可以帮您？" },
      ],
    },
    { id: "local-thread-2", messages: [{ role: "user" as const, content: "退货流程" }] },
  ]

  const first = store.importThreads("t1", "alice", threads)
  assert.deepEqual(first, { imported: 2, skipped: 0 })

  // Re-import: existing directories are skipped, not duplicated or merged.
  const second = store.importThreads("t1", "alice", threads)
  assert.deepEqual(second, { imported: 0, skipped: 2 })
  assert.equal(store.listDirectories("t1", "alice").length, 2)

  const turns = store.getTurns("local-thread-1", "t1", "alice")
  assert.equal(turns.length, 2)
  assert.equal(turns[0].content, "你好")
  assert.equal(turns[1].content, "您好，请问有什么可以帮您？")

  // Imported messages live in the history table, never in validated memory.
  const memoryCount = db
    .prepare(`SELECT COUNT(*) AS n FROM conversation_turns WHERE kind = 'validated'`)
    .get() as { n: number }
  assert.equal(memoryCount.n, 0)

  // A same-id thread of another user is a skip (PK conflict → no error, no
  // leak either way); bob then cannot read alice's thread by that id.
  const other = store.importThreads("t1", "bob", threads)
  assert.deepEqual(other, { imported: 0, skipped: 2 })
  assert.equal(store.getTurns("local-thread-1", "t1", "alice").length, 2)
  assert.throws(() => store.getTurns("local-thread-1", "t1", "bob"), /conversation not found/)
})

test("the chat transport records only non-completed terminals; completed runs are not duplicated", async () => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  const db = openDb(":memory:")
  const history = new SqliteConversationHistoryStore(db)
  const memory = new SqliteConversationStore(db)
  // The completed run's pair is written by the memory layer (runner side).
  memory.saveValidatedTurn({
    sessionId: "sess-http-1",
    tenantId: "t1",
    role: "user",
    content: "能帮我操作退款吗",
    runId: "run-ok",
    createdAt: "2026-01-01T00:00:01.000Z",
  })
  memory.saveValidatedTurn({
    sessionId: "sess-http-1",
    tenantId: "t1",
    role: "assistant",
    content: "已受理。",
    runId: "run-ok",
    createdAt: "2026-01-01T00:00:02.000Z",
  })
  const app = createApp({
    db,
    eventsSource: async function* (_message: string, options: AnswerRunOptions): AsyncIterable<AnswerRunEvent> {
      yield doneEvent(options.sessionId ?? "s", options.runId ?? "r", "clarification_required", "需要您补充订单号。")
    },
    accessMiddleware: identity({ scopes: ["chat"] }),
    conversationHistory: history,
  })
  const { base, close } = await listen(app)
  try {
    // Run 1: a refusal (the fake source always answers clarification_required).
    const response = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "能帮我操作退款吗",
        sessionId: "sess-http-1",
        stream: false,
      }),
    })
    assert.equal(response.status, 200)

    const directories = history.listDirectories("t1", "u1")
    assert.equal(directories.length, 1)
    assert.equal(directories[0].id, "sess-http-1")
    assert.equal(directories[0].title, "能帮我操作退款吗")

    // The unified view: the memory pair (completed) + the refusal run's
    // user turn and assistant turn.
    const turns = history.getTurns("sess-http-1", "t1", "u1")
    assert.deepEqual(
      turns.map((t) => `${t.role}:${t.terminalStatus}`),
      [
        "user:null",
        "assistant:completed",
        "user:null",
        "assistant:clarification_required",
      ]
    )
    // The refusal run never entered validated memory (criterion 4).
    const memoryRows = db
      .prepare(`SELECT role, content FROM conversation_turns WHERE kind = 'validated' ORDER BY id`)
      .all() as Array<{ role: string; content: string }>
    assert.deepEqual(memoryRows.map((r) => r.content), ["能帮我操作退款吗", "已受理。"])
  } finally {
    await close()
  }
})

test("a stream that dies without a terminal event records a provider_error turn", async () => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  const db = openDb(":memory:")
  const history = new SqliteConversationHistoryStore(db)
  const app = createApp({
    db,
    eventsSource: async function* (): AsyncIterable<AnswerRunEvent> {
      yield {
        schemaVersion: 1,
        sessionId: "s",
        runId: "r",
        eventId: "e-progress",
        sequence: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        stage: "route",
        status: "running",
        durationMs: null,
        attempt: 1,
        round: 1,
        inputSummary: "",
        outputSummary: "",
        type: "progress",
        data: {},
      } as unknown as AnswerRunEvent
      throw new Error("stream exploded before terminal")
    },
    accessMiddleware: identity({ scopes: ["chat"] }),
    conversationHistory: history,
  })
  const { base, close } = await listen(app)
  try {
    const response = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "问题", sessionId: "sess-http-2" }),
    })
    // The request itself still terminates cleanly (the transport logs the error).
    assert.ok([200, 500].includes(response.status))
    const turns = history.getTurns("sess-http-2", "t1", "u1")
    const assistantTurns = turns.filter((t) => t.role === "assistant")
    assert.ok(assistantTurns.length >= 1)
    assert.equal(assistantTurns.at(-1)?.terminalStatus, "provider_error")
  } finally {
    await close()
  }
})

test("the first message locks the assistant version and knowledge subset", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationHistoryStore(db)
  // The transport ensures the directory when the first message arrives; the
  // lock itself only ever applies to a directory its caller already owns.
  store.ensureDirectory("sess-lock", "t1", "alice", "第一问")

  const first = store.lockSession(
    "sess-lock",
    "t1",
    "alice",
    { assistantId: "ast-1", assistantVersion: 2, knowledgeBaseIds: ["kb-a", "kb-b"] }
  )
  assert.deepEqual(first, {
    assistantId: "ast-1",
    assistantVersion: 2,
    knowledgeBaseIds: ["kb-a", "kb-b"],
  })

  // A later message naming a newer assistant version and a different knowledge
  // selection cannot move the lock.
  const again = store.lockSession(
    "sess-lock",
    "t1",
    "alice",
    { assistantId: "ast-1", assistantVersion: 9, knowledgeBaseIds: ["kb-other"] }
  )
  assert.deepEqual(again, first)

  // Another user cannot read or overwrite the lock.
  assert.equal(store.getSessionLock("sess-lock", "t1", "bob"), null)
  assert.throws(
    () =>
      store.lockSession("sess-lock", "t1", "bob", {
        assistantId: "ast-x",
        assistantVersion: 1,
        knowledgeBaseIds: ["kb-x"],
      }),
    /conversation not found/
  )
})

test("editing an earlier question truncates later validated memory", () => {
  const db = openDb(":memory:")
  const history = new SqliteConversationHistoryStore(db)
  const memory = new SqliteConversationStore(db)
  history.ensureDirectory("sess-edit", "t1", "alice", "第一问")

  const writePair = (runId: string, user: string, assistant: string, at: string) => {
    memory.saveValidatedTurn({
      sessionId: "sess-edit", tenantId: "t1", role: "user", content: user, runId, createdAt: at,
    })
    memory.saveValidatedTurn({
      sessionId: "sess-edit", tenantId: "t1", role: "assistant", content: assistant, runId,
      createdAt: new Date(Date.parse(at) + 5).toISOString(),
    })
  }
  writePair("run-1", "第一问", "第一答", "2026-01-01T00:00:01.000Z")
  writePair("run-2", "第二问", "第二答", "2026-01-01T00:00:02.000Z")
  writePair("run-3", "第三问", "第三答", "2026-01-01T00:00:03.000Z")
  // A refusal after run-2 must go too — truncated history cannot linger.
  history.recordUnvalidatedRun("sess-edit", "t1", "alice", "插话", "不行", "run-x", "cancelled")

  const removed = history.truncateAfterRun("sess-edit", "t1", "alice", "run-1")
  assert.ok(removed.validated >= 4)
  assert.ok(removed.history >= 2)

  const remaining = memory.loadRecentTurns("sess-edit", "t1", 20)
  assert.deepEqual(remaining.map((turn) => turn.content), ["第一问", "第一答"])
  assert.deepEqual(
    history.getTurns("sess-edit", "t1", "alice").map((turn) => turn.content),
    ["第一问", "第一答"]
  )

  // An unknown anchor removes nothing.
  const none = history.truncateAfterRun("sess-edit", "t1", "alice", "run-missing")
  assert.deepEqual(none, { validated: 0, history: 0 })
  assert.throws(
    () => history.truncateAfterRun("sess-edit", "t1", "bob", "run-1"),
    /conversation not found/
  )
})
