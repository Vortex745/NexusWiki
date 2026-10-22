/**
 * DR-17 — three concurrent sessions never share answer, citation or memory.
 *
 * The proof is the real HTTP transport over an in-memory SQLite database: three
 * distinct sessions are started together, all three Answer runs reach the
 * source before a shared barrier releases them, and every observable record is
 * then read back per run/session:
 *
 *   - the JSON reply, references and events of each response;
 *   - the persisted run trace behind GET /chat/runs/:runId;
 *   - validated conversation memory (only completed runs) and the server-owned
 *     history (a failed run stays visible with its terminal status);
 *   - the directory list, so no session disappears.
 *
 * The provider is a controlled collaborator: it answers by session, one run is
 * deliberately slow, one fails, and every content marker is unique. A separate
 * negative case replays another session's terminal into this run and asserts
 * that its content is neither published nor recorded.
 */

import assert from "node:assert/strict"
import test from "node:test"
import type { AddressInfo } from "node:net"
import type { RequestHandler } from "express"

import { openDb } from "../ingestion/tracking/db"
import { createApp } from "./server"
import type { AnswerRunOptions } from "../answer/generation"
import type { AnswerRunEvent } from "../types"
import { AnswerTraceRepository } from "../answer/trace_repository"
import { SqliteConversationHistoryStore } from "../answer/conversation_history_store"
import { SqliteConversationStore } from "../answer/conversation_store"
import { createMastraChatEventAdapter } from "../mastra/chat_event_adapter"
import { KnowledgeBaseServiceImpl } from "../knowledge/knowledge_base_service"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { createRetrievalScopeResolver } from "../retrieval/scope"
import type { AccessContext } from "../access/context"

function identity(): RequestHandler {
  return (_req, res, next) => {
    res.locals.accessContext = {
      tenantId: "t1",
      subjectId: "u1",
      groups: [],
      scopes: ["admin", "chat"],
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

interface SessionPlan {
  sessionId: string
  runId: string
  question: string
  answer: string
  referenceId: string
  /** Slow responses prove the barrier released real in-flight runs. */
  delayMs: number
  fail?: boolean
}

const PLANS: SessionPlan[] = [
  {
    sessionId: "iso-alpha-session",
    runId: "iso-alpha-run",
    question: "ALPHA-QUESTION 政策适用范围？",
    answer: "ALPHA-ANSWER 仅限试用期员工。",
    referenceId: "alpha-chunk",
    delayMs: 0,
  },
  {
    sessionId: "iso-bravo-session",
    runId: "iso-bravo-run",
    question: "BRAVO-QUESTION 报销时限？",
    answer: "BRAVO-ANSWER 三十个自然日内提交。",
    referenceId: "bravo-chunk",
    delayMs: 120,
  },
  {
    sessionId: "iso-charlie-session",
    runId: "iso-charlie-run",
    question: "CHARLIE-QUESTION 设备归还流程？",
    answer: "CHARLIE-ANSWER 离职当日交回资产。",
    referenceId: "charlie-chunk",
    delayMs: 40,
    fail: true,
  },
]

function referenceFor(plan: SessionPlan) {
  return {
    id: plan.referenceId,
    documentId: `${plan.sessionId}-doc`,
    documentVersionId: `${plan.sessionId}-version`,
    documentVersion: 1,
    chunkId: plan.referenceId,
    title: `${plan.sessionId} 手册`,
    source: "sample",
    excerpt: plan.answer,
    channels: ["vector" as const],
    score: 1,
    wikilinks: [],
  }
}

function waitFor(predicate: () => boolean, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let waited = 0
    const tick = () => {
      if (predicate()) return resolve()
      waited += 10
      if (waited >= 3000) return reject(new Error(`timed out waiting for ${label}`))
      setTimeout(tick, 10)
    }
    tick()
  })
}

function foreignDoneEvent(plan: SessionPlan): AnswerRunEvent {
  return {
    schemaVersion: 1,
    sessionId: plan.sessionId,
    runId: plan.runId,
    eventId: `${plan.runId}:9`,
    sequence: 9,
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
      runId: plan.runId,
      status: "completed",
      reply: plan.answer,
      references: [referenceFor(plan)],
      degradation: { status: "none" },
    },
  } as unknown as AnswerRunEvent
}

function markers(plan: SessionPlan): string[] {
  return [plan.question, plan.answer, plan.referenceId]
}

function assertForeignMarkersAbsent(serialized: string, own: SessionPlan): void {
  for (const other of PLANS) {
    if (other.sessionId === own.sessionId) continue
    for (const marker of markers(other)) {
      assert.equal(
        serialized.includes(marker),
        false,
        `session ${own.sessionId} observed ${other.sessionId}'s ${marker}`
      )
    }
  }
}

test("three sessions released behind a shared barrier keep answer, citation and memory apart", async () => {
  const db = openDb(":memory:")
  const trace = new AnswerTraceRepository(db)
  const memory = new SqliteConversationStore(db)
  const history = new SqliteConversationHistoryStore(db)
  const knowledgeBases = new KnowledgeBaseServiceImpl(new SqliteKnowledgeBaseRepo(db), "test-embedding:3")

  const arrived: string[] = []
  let release: () => void = () => {}
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })

  const source = createMastraChatEventAdapter({
    traceObserver: trace,
    runner: async (input) => {
      const plan = PLANS.find((candidate) => candidate.sessionId === input.sessionId)
      assert.ok(plan, `unexpected session ${input.sessionId}`)
      arrived.push(input.sessionId)
      // Releasing is the TEST's decision: every run must be observably
      // in flight before any of them may answer.
      await barrier
      await new Promise((resolve) => setTimeout(resolve, plan.delayMs))
      if (plan.fail) throw new Error("deterministic provider outage")
      for (const [role, content] of [
        ["user", plan.question],
        ["assistant", plan.answer],
      ] as const) {
        memory.saveValidatedTurn({
          sessionId: input.sessionId,
          tenantId: input.accessContext.tenantId,
          role,
          content,
          runId: input.runId,
          createdAt: new Date().toISOString(),
        })
      }
      return {
        reply: plan.answer,
        status: "completed",
        references: [referenceFor(plan)],
        degradation: { status: "none", unavailableChannels: [] },
        tokens: [plan.answer],
        routeTrace: { decision: "simple" },
        retrievalTrace: { resultCount: 1 },
        contextTrace: { evidenceCount: 1, phase: "draft" },
        validationTrace: { round: 1, passed: true },
      }
    },
  })

  const app = createApp({
    db,
    eventsSource: source,
    accessMiddleware: identity(),
    retrievalScopeResolver: createRetrievalScopeResolver(knowledgeBases),
    knowledgeBaseService: knowledgeBases,
    conversationHistory: history,
  })
  const { base, close } = await listen(app)
  try {
    let settled = 0
    const requests = PLANS.map((plan) =>
      fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: plan.question,
          sessionId: plan.sessionId,
          runId: plan.runId,
          stream: false,
        }),
      }).finally(() => {
        settled += 1
      })
    )

    await waitFor(() => arrived.length === PLANS.length, "all three runs to reach the source")
    assert.equal(settled, 0, "every run is still in flight while the barrier holds")
    assert.deepEqual(
      [...arrived].sort(),
      PLANS.map((plan) => plan.sessionId).sort(),
      "the three distinct sessions are the ones that met the barrier"
    )
    release()

    const responses = await Promise.all(requests)

    for (const [index, plan] of PLANS.entries()) {
      const response = responses[index]
      assert.equal(response.status, 200, `${plan.sessionId} answers over HTTP`)
      const body = await response.json() as {
        reply: string
        sessionId: string
        runId: string
        status: string
        references: Array<{ id: string }>
        events: AnswerRunEvent[]
      }
      assert.equal(body.sessionId, plan.sessionId)
      assert.equal(body.runId, plan.runId)
      if (plan.fail) {
        assert.equal(body.status, "provider_error")
        assert.deepEqual(body.references, [], "a failed run publishes no citation")
      } else {
        assert.equal(body.status, "completed")
        assert.equal(body.reply, plan.answer, "each session gets its own answer")
        assert.deepEqual(body.references.map(({ id }) => id), [plan.referenceId])
      }
      for (const event of body.events) {
        assert.equal(event.sessionId, plan.sessionId)
        assert.equal(event.runId, plan.runId)
      }
      assertForeignMarkersAbsent(JSON.stringify(body), plan)

      // Persisted run trace: same run, same session, its own terminal.
      const traceResponse = await fetch(`${base}/api/chat/runs/${plan.runId}`)
      assert.equal(traceResponse.status, 200, `${plan.runId} keeps a raw run record`)
      const run = await traceResponse.json() as { sessionId: string; events: AnswerRunEvent[] }
      assert.equal(run.sessionId, plan.sessionId)
      assert.ok(run.events.length > 0)
      for (const event of run.events) {
        assert.equal(event.sessionId, plan.sessionId)
        assert.equal(event.runId, plan.runId)
      }
      const terminal = run.events.find(
        (event): event is Extract<AnswerRunEvent, { type: "done" }> => event.type === "done"
      )
      assert.ok(terminal, `${plan.runId} keeps a terminal record`)
      assert.equal(terminal.result.runId, plan.runId)
      assert.equal(terminal.result.status, plan.fail ? "provider_error" : "completed")
      assertForeignMarkersAbsent(JSON.stringify(run), plan)

      // Conversation memory: completed runs only, always this session's pair.
      const turns = memory.loadRecentTurns(plan.sessionId, "t1", 20)
      if (plan.fail) {
        assert.deepEqual(turns, [], "a failed run never enters validated memory")
      } else {
        assert.deepEqual(
          turns.map(({ role, content }) => [role, content]),
          [
            ["user", plan.question],
            ["assistant", plan.answer],
          ]
        )
        for (const turn of turns) assert.equal(turn.runId, plan.runId)
      }
      assertForeignMarkersAbsent(JSON.stringify(turns), plan)

      // Server-owned history: completed runs read as validated pairs, the
      // failed run remains visible with its terminal status (not dropped).
      const historyTurns = history.getTurns(plan.sessionId, "t1", "u1")
      if (plan.fail) {
        assert.deepEqual(
          historyTurns.map(({ role, terminalStatus }) => [role, terminalStatus]),
          [
            ["user", null],
            ["assistant", "provider_error"],
          ],
          "the failed session keeps its own plan and terminal in history"
        )
        assert.equal(historyTurns[0].content, plan.question)
      } else {
        assert.deepEqual(
          historyTurns.map(({ role, content, terminalStatus }) => [role, content, terminalStatus]),
          [
            ["user", plan.question, null],
            ["assistant", plan.answer, "completed"],
          ]
        )
      }
      assertForeignMarkersAbsent(JSON.stringify(historyTurns), plan)
    }

    // The concurrent denominator: nothing disappeared, the failure included.
    const persistedRuns = db
      .prepare(`SELECT DISTINCT run_id FROM answer_run_events ORDER BY run_id`)
      .all() as Array<{ run_id: string }>
    assert.deepEqual(
      persistedRuns.map((row) => row.run_id),
      [...PLANS.map((plan) => plan.runId)].sort(),
      "all three planned runs persisted raw records"
    )
    assert.deepEqual(
      history.listDirectories("t1", "u1").map((directory) => directory.id).sort(),
      PLANS.map((plan) => plan.sessionId).sort(),
      "all three session directories remain"
    )
    assert.equal(arrived.length, PLANS.length, "attempted == planned == persisted")
  } finally {
    await close()
    db.close()
  }
})

test("a replayed terminal from another session is neither published nor recorded", async () => {
  const own = PLANS[0]
  const foreign = PLANS[1]
  const seen: AnswerRunOptions[] = []
  // Two replay shapes: the whole event belongs to another run/session, or the
  // envelope was re-stamped for this run while the terminal result still names
  // (and carries) the other run's answer.
  const replayed: Array<() => AnswerRunEvent> = [
    () => foreignDoneEvent(foreign),
    () => {
      const event = foreignDoneEvent(foreign) as unknown as {
        sessionId: string
        runId: string
      }
      event.sessionId = own.sessionId
      event.runId = own.runId
      return event as unknown as AnswerRunEvent
    },
  ]
  let shape = 0
  const source = async function* (message: string, options: AnswerRunOptions): AsyncIterable<AnswerRunEvent> {
    seen.push(options)
    yield replayed[shape]()
    shape = (shape + 1) % replayed.length
  }

  const db = openDb(":memory:")
  const history = new SqliteConversationHistoryStore(db)
  const memory = new SqliteConversationStore(db)
  const knowledgeBases = new KnowledgeBaseServiceImpl(new SqliteKnowledgeBaseRepo(db), "test-embedding:3")
  const app = createApp({
    db,
    eventsSource: source,
    accessMiddleware: identity(),
    retrievalScopeResolver: createRetrievalScopeResolver(knowledgeBases),
    knowledgeBaseService: knowledgeBases,
    conversationHistory: history,
  })
  const { base, close } = await listen(app)
  try {
    let request = 0
    for (const stream of [false, true]) {
      for (let replay = 0; replay < replayed.length; replay += 1) {
        const response = await fetch(`${base}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: own.question,
            sessionId: own.sessionId,
            runId: own.runId,
            stream,
          }),
        })
        request += 1
        const body = await response.text()
        assert.equal(
          body.includes(foreign.answer) || body.includes(foreign.referenceId),
          false,
          `request ${request} must not publish another session's answer or citation`
        )
        assert.equal(history.getTurns(own.sessionId, "t1", "u1").length, 0, "a foreign terminal is not recorded")
        assert.deepEqual(memory.loadRecentTurns(own.sessionId, "t1", 20), [])
      }
    }
    assert.equal(seen.length, 4)
    for (const options of seen) {
      assert.equal(options.sessionId, own.sessionId)
      assert.equal(options.runId, own.runId)
    }
  } finally {
    await close()
    db.close()
  }
})
