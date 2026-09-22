import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
import { SqliteSessionBinder } from "../access/session_binder"
import type { AnswerRunOptions } from "../answer/generation"
import { AnswerTraceRepository } from "../answer/trace_repository"
import { openDb, type DB } from "../ingestion/tracking/db"
import { KnowledgeBaseServiceImpl } from "../knowledge/knowledge_base_service"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { createRetrievalScopeResolver, type RetrievalScopeResolver } from "../retrieval/scope"
import type { AnswerRunEvent, AnswerRunResult } from "../types"
import { defaultKnowledgeBaseId } from "../types/knowledge_base"
import { createChatRouter, type AnswerEventsSource } from "./chat"
import { createApp } from "./server"

/**
 * Ticket 05 (KB-03A) — the POST /api/chat knowledge-selection contract.
 *
 * Acceptance criteria exercised here:
 *   2. Missing scope selects the authorized default; an explicit empty scope is
 *      "no knowledge context"; an invalid scope fails explicitly (400) and an
 *      unknown or cross-tenant scope fails explicitly (404).
 *   3. The client cannot expand its scope with raw storage filters or
 *      unauthorized identifiers — only the server-resolved scope reaches the run.
 *
 * A rejected scope must not start a run and must not bind a session.
 */

const EMBEDDING_PROFILE = "text-embedding-3-small:1536"
const FIXED_RUN_ID = "run-scope-0001"
const FIXED_SESSION_ID = "sess-scope-0001"

function makeTerminalResult(status: AnswerRunResult["status"], runId: string): AnswerRunResult {
  return {
    runId,
    status,
    reply: "hello world",
    references: [],
    degradation: { status: "none", unavailableChannels: [] },
  }
}

function makeEvents(runId: string, sessionId: string): AnswerRunEvent[] {
  const base = {
    schemaVersion: 1 as const,
    sessionId,
    runId,
    createdAt: "2026-09-22T00:00:00.000Z",
    status: "running" as const,
    durationMs: null,
    attempt: 1,
    round: 0,
    inputSummary: "",
    outputSummary: "",
  }
  return [
    {
      ...base,
      type: "progress",
      stage: "route",
      message: "",
      data: {},
      eventId: `${runId}:1`,
      sequence: 1,
    },
    {
      ...base,
      type: "done",
      stage: "done",
      result: makeTerminalResult("completed", runId),
      eventId: `${runId}:2`,
      sequence: 2,
      status: "completed",
      durationMs: 1,
    },
  ]
}

type Built = {
  app: express.Express
  db: DB
  runs: AnswerRunOptions[]
}

function buildRouter(options: {
  resolver?: RetrievalScopeResolver
  binder?: boolean
  accessContext?: AccessContext
}): Built {
  const db = openDb(":memory:")
  const runs: AnswerRunOptions[] = []
  const eventsSource: AnswerEventsSource = async function* (_message, runOptions) {
    runs.push(runOptions)
    for (const event of makeEvents(
      runOptions.runId ?? FIXED_RUN_ID,
      runOptions.sessionId ?? FIXED_SESSION_ID
    )) {
      yield event
    }
  }
  const app = express()
  app.use(express.json())
  if (options.accessContext) {
    const context = options.accessContext
    app.use((_req, res, next) => {
      res.locals.accessContext = context
      next()
    })
  }
  app.use(
    "/api",
    createChatRouter(
      new AnswerTraceRepository(db),
      eventsSource,
      options.binder ? new SqliteSessionBinder(db) : undefined,
      options.resolver
    )
  )
  return { app, db, runs }
}

/** A request-scope service plus the resolver built on the same database. */
function openScope() {
  const db = openDb(":memory:")
  const service = new KnowledgeBaseServiceImpl(new SqliteKnowledgeBaseRepo(db), EMBEDDING_PROFILE)
  return { db, service, resolver: createRetrievalScopeResolver(service) }
}

async function listen(app: express.Express) {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

async function postChat(port: number, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  return { status: res.status, json }
}

function bindingCount(db: DB): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM session_bindings").get() as { n: number }
  return row.n
}

function contextFor(tenantId: string): AccessContext {
  return { ...singleTenantAccessContext(), tenantId }
}

test("Ticket 05: a chat request without a knowledge selection runs inside the caller's default scope", async () => {
  const scope = openScope()
  scope.service.ensureDefault("demo")
  const built = buildRouter({ resolver: scope.resolver, accessContext: contextFor("demo") })
  const { server, port } = await listen(built.app)
  try {
    const res = await postChat(port, { message: "hi", stream: false })

    assert.equal(res.status, 200)
    assert.equal(built.runs.length, 1, "the run must start on a resolvable scope")
    assert.deepEqual(built.runs[0].retrievalScope, {
      knowledgeBaseIds: [defaultKnowledgeBaseId("demo")],
    })
  } finally {
    server.close()
    built.db.close()
    scope.db.close()
  }
})

test("Ticket 05: an explicit empty selection forwards an empty scope and still answers", async () => {
  const scope = openScope()
  scope.service.ensureDefault("demo")
  const built = buildRouter({ resolver: scope.resolver, accessContext: contextFor("demo") })
  const { server, port } = await listen(built.app)
  try {
    const res = await postChat(port, { message: "hi", stream: false, knowledgeBaseIds: [] })

    assert.equal(res.status, 200, "no knowledge context is a legal request, not an error")
    assert.deepEqual(built.runs[0].retrievalScope, { knowledgeBaseIds: [] })
  } finally {
    server.close()
    built.db.close()
    scope.db.close()
  }
})

test("Ticket 05: an unknown knowledge base is refused with 404 before any run or binding", async () => {
  const scope = openScope()
  scope.service.ensureDefault("demo")
  const built = buildRouter({
    resolver: scope.resolver,
    binder: true,
    accessContext: contextFor("demo"),
  })
  const { server, port } = await listen(built.app)
  try {
    const res = await postChat(port, {
      message: "hi",
      stream: false,
      sessionId: "sess-unknown-scope",
      knowledgeBaseIds: ["kb-does-not-exist"],
    })

    assert.equal(res.status, 404)
    assert.equal(built.runs.length, 0, "a rejected scope must not start a run")
    assert.equal(bindingCount(built.db), 0, "a rejected scope must not bind the session")
  } finally {
    server.close()
    built.db.close()
    scope.db.close()
  }
})

test("Ticket 05: another tenant's knowledge base is refused with 404", async () => {
  const scope = openScope()
  scope.service.ensureDefault("demo")
  const foreign = scope.service.ensureDefault("other")
  const built = buildRouter({ resolver: scope.resolver, accessContext: contextFor("demo") })
  const { server, port } = await listen(built.app)
  try {
    const res = await postChat(port, {
      message: "hi",
      stream: false,
      knowledgeBaseIds: [foreign.id],
    })

    assert.equal(res.status, 404)
    assert.equal(built.runs.length, 0, "a cross-tenant id must not start a run")
    assert.equal(
      JSON.stringify(res.json).includes(foreign.id),
      false,
      "the response must not confirm another tenant's id"
    )
  } finally {
    server.close()
    built.db.close()
    scope.db.close()
  }
})

test("Ticket 05: a malformed selection fails with 400 instead of being ignored", async () => {
  const scope = openScope()
  scope.service.ensureDefault("demo")
  const malformed: unknown[] = [
    "kb-default-demo",
    7,
    { knowledgeBaseIds: ["kb-default-demo"] },
    null,
    ["   "],
    [42],
  ]
  try {
    for (const selection of malformed) {
      const built = buildRouter({ resolver: scope.resolver, accessContext: contextFor("demo") })
      const { server, port } = await listen(built.app)
      try {
        const res = await postChat(port, {
          message: "hi",
          stream: false,
          knowledgeBaseIds: selection,
        })

        assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(selection)}`)
        assert.equal(
          built.runs.length,
          0,
          `a malformed selection must not start a run: ${JSON.stringify(selection)}`
        )
      } finally {
        server.close()
        built.db.close()
      }
    }
  } finally {
    scope.db.close()
  }
})

test("Ticket 05: raw storage filters and unauthorized identifiers cannot widen the scope", async () => {
  const scope = openScope()
  scope.service.ensureDefault("demo")
  const built = buildRouter({ resolver: scope.resolver, accessContext: contextFor("demo") })
  const { server, port } = await listen(built.app)
  try {
    const res = await postChat(port, {
      message: "hi",
      stream: false,
      // Everything a client could try to widen its read with. None of it is a
      // field of the chat contract, so none of it can reach a retrieval
      // channel: only the server-computed scope does.
      tenantId: "other",
      filters: { terms: { knowledgeBaseId: ["kb-default-other"] } },
      accessGroups: ["*"],
      topK: 100,
    })

    assert.equal(res.status, 200)
    assert.deepEqual(
      built.runs[0].retrievalScope,
      { knowledgeBaseIds: [defaultKnowledgeBaseId("demo")] },
      "the scope must be the caller's own default, never a client-supplied filter"
    )
  } finally {
    server.close()
    built.db.close()
    scope.db.close()
  }
})

test("Ticket 05: without a resolver a knowledge selection is refused, never silently ignored", async () => {
  const built = buildRouter({})
  const { server, port } = await listen(built.app)
  try {
    const res = await postChat(port, {
      message: "hi",
      stream: false,
      knowledgeBaseIds: ["kb-default-demo"],
    })

    assert.equal(res.status, 400)
    assert.equal(built.runs.length, 0)
  } finally {
    server.close()
    built.db.close()
  }
})

test("Ticket 05: without a resolver a request that carries no selection keeps working", async () => {
  const built = buildRouter({})
  const { server, port } = await listen(built.app)
  try {
    const res = await postChat(port, { message: "hi", stream: false })

    assert.equal(res.status, 200, "a legacy request must stay backward compatible")
    assert.equal(built.runs[0].retrievalScope, undefined)
  } finally {
    server.close()
    built.db.close()
  }
})

test("Ticket 05: createApp passes the injected resolver through to the chat route", async () => {
  const scope = openScope()
  scope.service.ensureDefault("default")
  const runs: AnswerRunOptions[] = []
  const db = openDb(":memory:")
  const app = createApp({
    db,
    retrievalScopeResolver: scope.resolver,
    eventsSource: async function* (_message, runOptions) {
      runs.push(runOptions)
      for (const event of makeEvents(
        runOptions.runId ?? FIXED_RUN_ID,
        runOptions.sessionId ?? FIXED_SESSION_ID
      )) {
        yield event
      }
    },
  })
  const { server, port } = await listen(app)
  try {
    const res = await postChat(port, { message: "hi", stream: false })

    assert.equal(res.status, 200)
    assert.deepEqual(runs[0].retrievalScope, {
      knowledgeBaseIds: [defaultKnowledgeBaseId("default")],
    })
  } finally {
    server.close()
    db.close()
    scope.db.close()
  }
})

test("Ticket 08: an archived knowledge base selection is refused with 409 before any run", async () => {
  const scope = openScope()
  scope.service.ensureDefault("demo")
  const created = scope.service.create("demo", "Policies")
  scope.service.archive(created.id, "demo")
  const built = buildRouter({ resolver: scope.resolver, accessContext: contextFor("demo") })
  const { server, port } = await listen(built.app)
  try {
    const res = await postChat(port, {
      message: "hi",
      stream: false,
      knowledgeBaseIds: [created.id],
    })

    assert.equal(res.status, 409, "archived is a state conflict, not a missing row")
    assert.equal(built.runs.length, 0, "a refused selection must not start a run")
  } finally {
    server.close()
    built.db.close()
    scope.db.close()
  }
})
