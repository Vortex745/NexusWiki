import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test, { type TestContext } from "node:test"
import type OpenAI from "openai"
import type { Request } from "express"
import type { AccessContext } from "../access/context"
import { SqliteSessionBinder } from "../access/session_binder"
import { SqliteConversationHistoryStore } from "../answer/conversation_history_store"
import { SqliteConversationStore } from "../answer/conversation_store"
import { AnswerTraceRepository } from "../answer/trace_repository"
import { openDb } from "../ingestion/tracking/db"
import { createMastraChatEventAdapter } from "../mastra/chat_event_adapter"
import { createDirectAmbiguousMastraRunner } from "../mastra/direct_ambiguous_runner"
import { createMastraMemoryAdapter } from "../mastra/memory_adapter"
import { createRouteDispatchRunner } from "../mastra/route_dispatch_runner"
import { RouterImpl } from "../retrieval/router/router"
import { createAccessMiddleware } from "./access_middleware"
import { createApp } from "./server"

const oldQuestion = "旧问题：帮我查退款"
const newQuestion = "新问题：介绍产品"
const identities: Record<string, AccessContext> = {
  "Bearer owner": { tenantId: "default", subjectId: "local", groups: [], scopes: ["chat"] },
  "Bearer other-subject": { tenantId: "default", subjectId: "other", groups: [], scopes: ["chat"] },
  "Bearer other-tenant": { tenantId: "t2", subjectId: "local", groups: [], scopes: ["chat"] },
}

async function branchApp(t: TestContext) {
  const db = openDb(":memory:")
  const history = new SqliteConversationHistoryStore(db)
  const memory = new SqliteConversationStore(db)
  const classifiedInputs: string[] = []
  const answerInputs: string[] = []
  // The real router calls a synthetic external chat-completion client.
  const client = {
    chat: { completions: { create: async (request: { messages: Array<{ role: string; content: string }> }) => {
      const message = request.messages.find((entry) => entry.role === "user")!.content
      classifiedInputs.push(message)
      return { choices: [{ message: { content: message === oldQuestion ? "ambiguous" : "direct" } }] }
    } } },
  } as unknown as OpenAI
  const router = new RouterImpl(client, "synthetic-router")
  const directRunner = createDirectAmbiguousMastraRunner({
    router, conversationStore: memory, resolveTenantId: (context) => context.tenantId,
    memoryAdapter: createMastraMemoryAdapter({ conversationStore: memory }),
    streamDirectReply: async function* (message) {
      answerInputs.push(message)
      yield "合成新回答"
    },
  })
  const runner = createRouteDispatchRunner({
    router, conversationStore: memory, resolveTenantId: (context) => context.tenantId,
    directAmbiguousRunner: directRunner, simpleRunner: directRunner,
  })
  const app = createApp({
    db, conversationHistory: history, sessionBinder: new SqliteSessionBinder(db),
    eventsSource: createMastraChatEventAdapter({ runner, traceObserver: new AnswerTraceRepository(db) }),
    accessMiddleware: createAccessMiddleware({
      mode: "enforced", requiredScope: "chat",
      adapter: { resolve: async (request) => identities[(request as Request).get("authorization") ?? ""] ?? null },
    }),
  })
  const server = app.listen(0)
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
  })
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, classifiedInputs, answerInputs }
}

async function chat(base: string, message: string, runId: string, truncateFromRunId?: string, token = "Bearer owner") {
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: token },
    body: JSON.stringify({ message, runId, sessionId: "pending-session", stream: false, truncateFromRunId }),
  })
  return { status: response.status, body: await response.json() as { status?: string; reply?: string } }
}

async function turns(base: string) {
  const response = await fetch(`${base}/api/conversations/pending-session`, {
    headers: { authorization: "Bearer owner" },
  })
  assert.equal(response.status, 200)
  return (await response.json() as { turns: Array<{ runId: string; role: string; content: string }> }).turns
}

test("editing a clarification branch sends only the replacement question to real dispatch", async (t) => {
  const app = await branchApp(t)
  const first = await chat(app.base, oldQuestion, "old-run")
  assert.equal(first.body.status, "clarification_required")
  assert.equal((await turns(app.base)).length, 2)

  const edited = await chat(app.base, newQuestion, "edited-run", "old-run")
  assert.equal(edited.status, 200)
  assert.equal(edited.body.status, "completed")
  const displayed = await turns(app.base)
  assert.deepEqual(displayed.map((turn) => turn.runId), ["edited-run", "edited-run"])
  assert.equal(app.classifiedInputs.at(-1), newQuestion)
  assert.equal(app.answerInputs.at(-1), newQuestion)
  assert.deepEqual(displayed.map((turn) => turn.content), [newQuestion, "合成新回答"])
})

test("regenerating a clarification replaces display history without doubling the pending question", async (t) => {
  const app = await branchApp(t)
  await chat(app.base, oldQuestion, "old-run")
  const regenerated = await chat(app.base, oldQuestion, "regenerated-run", "old-run")
  assert.equal(regenerated.status, 200)
  assert.equal(regenerated.body.status, "clarification_required")
  assert.equal(app.classifiedInputs.at(-1), oldQuestion)
  const displayed = await turns(app.base)
  assert.deepEqual(displayed.map((turn) => turn.runId), ["regenerated-run", "regenerated-run"])
  assert.equal(displayed[0].content, oldQuestion)
})

test("an ordinary clarification answer still combines the pending question with its supplement", async (t) => {
  const app = await branchApp(t)
  await chat(app.base, oldQuestion, "old-run")
  const continued = await chat(app.base, "订单 42", "continued-run")
  assert.equal(continued.status, 200)
  assert.equal(continued.body.status, "completed")
  assert.equal(app.classifiedInputs.at(-1), "旧问题：帮我查退款 订单 42")
  assert.equal(app.answerInputs.at(-1), "旧问题：帮我查退款 订单 42")
  assert.deepEqual((await turns(app.base)).map((turn) => turn.runId), [
    "old-run", "old-run", "continued-run", "continued-run",
  ])
})

for (const token of ["Bearer other-subject", "Bearer other-tenant"]) {
  test(`${token} cannot truncate another owner's pending branch`, async (t) => {
    const app = await branchApp(t)
    await chat(app.base, oldQuestion, "old-run")
    const refused = await chat(app.base, newQuestion, "foreign-run", "old-run", token)
    assert.equal(refused.status, 409)
    assert.deepEqual((await turns(app.base)).map((turn) => turn.runId), ["old-run", "old-run"])
    const continued = await chat(app.base, "订单 42", "owner-continued-run")
    assert.equal(continued.body.status, "completed")
    assert.equal(app.classifiedInputs.at(-1), "旧问题：帮我查退款 订单 42")
  })
}
