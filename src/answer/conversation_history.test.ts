/**
 * Ticket 20 (CONV-01A) — server-owned conversation history.
 *
 * Focus: user isolation (another user = 404), terminal statuses that keep
 * success / refusal / failure / cancellation distinguishable after reload,
 * the one-time idempotent browser import (never destructive), and the
 * transport write path (user turn at start, assistant turn from the terminal
 * event — including a forced provider_error when the stream dies).
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
  const store = new SqliteConversationHistoryStore(openDb(":memory:"))

  store.ensureDirectory("sess-1", "t1", "alice", "退款政策是什么？")
  store.appendUserTurn("sess-1", "t1", "alice", "退款政策是什么？", "run-1")
  store.appendAssistantTurn("sess-1", "t1", "alice", "退款在 3 个工作日内到账。", "run-1", "completed")
  // A refusal, a cancellation and a failure are all visible, all distinct.
  store.ensureDirectory("sess-2", "t1", "alice", "能帮我操作退款吗")
  store.appendUserTurn("sess-2", "t1", "alice", "能帮我操作退款吗", "run-2")
  store.appendAssistantTurn("sess-2", "t1", "alice", "需要您补充订单号。", "run-2", "clarification_required")
  store.appendAssistantTurn("sess-2", "t1", "alice", "退款在 3 个工", "run-3", "cancelled")
  store.appendAssistantTurn("sess-2", "t1", "alice", "", "run-4", "provider_error")

  const directories = store.listDirectories("t1", "alice")
  assert.equal(directories.length, 2)
  assert.equal(directories[0].id, "sess-2", "most recently active first")
  assert.equal(directories[1].title, "退款政策是什么？", "title derives from the first user message")

  const turns = store.getTurns("sess-2", "t1", "alice")
  assert.deepEqual(
    turns.map((t) => t.terminalStatus),
    [null, "clarification_required", "cancelled", "provider_error"]
  )

  // Another user's directory: 404-equivalent, both for reads and appends.
  assert.throws(() => store.getTurns("sess-1", "t1", "bob"), /conversation not found/)
  assert.throws(
    () => store.appendUserTurn("sess-1", "t1", "bob", "hi", "run-x"),
    /conversation not found/
  )
  assert.throws(() => store.getTurns("sess-1", "other-tenant", "alice"), /conversation not found/)
  // listDirectories never leaks other users' directories.
  assert.equal(store.listDirectories("t1", "bob").length, 0)
})

test("the one-time browser import is idempotent and never destructive", () => {
  const store = new SqliteConversationHistoryStore(openDb(":memory:"))
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

  // Imported threads belong to the importing user only.
  assert.throws(() => store.getTurns("local-thread-1", "t1", "bob"), /conversation not found/)
})

test("the chat transport records the user turn and the assistant terminal turn", async () => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  const db = openDb(":memory:")
  const history = new SqliteConversationHistoryStore(db)
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

    const turns = history.getTurns("sess-http-1", "t1", "u1")
    assert.equal(turns.length, 2)
    assert.equal(turns[0].role, "user")
    assert.equal(turns[1].role, "assistant")
    assert.equal(turns[1].terminalStatus, "clarification_required", "a refusal stays a refusal")
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
