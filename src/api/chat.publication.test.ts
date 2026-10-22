/**
 * DR-16 — publication parity and unpublished-draft containment over real HTTP.
 *
 * Each scenario is consumed twice — JSON transport and SSE transport — through
 * a real Express app (`app.listen(0)`), the real Chat router, the real Mastra
 * event adapter, the real simple/FAQ knowledge runners and an isolated
 * in-memory SQLite database. The same run is then read back from
 * `/api/chat/runs/:runId` (persisted trace) and from the effective
 * conversation history (validated memory + history-only turns).
 *
 * The draft stream is controlled and carries a distinctive marker. For a
 * cancelled or validation-rejected run that marker must appear in NO public
 * surface: reply, references, events, persisted trace or effective history.
 *
 * No provider is needed: every collaborator is a controlled stand-in and no
 * external service is contacted.
 */
import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

import { createChatRouter } from "./chat"
import { AnswerTraceRepository } from "../answer/trace_repository"
import { openDb, type DB } from "../ingestion/tracking/db"
import {
  createMastraChatEventAdapter,
  type MastraRunner,
} from "../mastra/chat_event_adapter"
import {
  createSimpleKnowledgeMastraRunner,
  type KnowledgeAnswerDraftStream,
} from "../mastra/simple_knowledge_runner"
import { createFaqExactMatchRunner } from "../mastra/faq_exact_runner"
import { FaqEntryServiceImpl } from "../faq/faq_entry_service"
import { SqliteFaqEntryRepo } from "../faq/faq_entry_repo"
import {
  SqliteConversationStore,
  type ConversationStore,
} from "../answer/conversation_store"
import { SqliteConversationHistoryStore } from "../answer/conversation_history_store"
import { buildEvidence } from "../answer/evidence"
import {
  CANCELLED_MESSAGE,
  INSUFFICIENT_EVIDENCE_MESSAGE,
  PROVIDER_ERROR_MESSAGE,
} from "../answer/terminal_copy"
import {
  ConversationImpl,
  InMemoryConversationStorage,
  type CompleteReplyData,
  type Message,
  type TraceEvent,
} from "../frontend/conversation"
import type { Router } from "../retrieval/router/interface"
import type { Searcher, SearchOptions, SearchOutcome } from "../retrieval/search/interface"
import type { ContextAssembler } from "../retrieval/context/interface"
import type { Validator } from "../critic/validator/interface"
import type { RePlanner } from "../critic/replanner/interface"
import type {
  AnswerRunEvent,
  AnswerRunResult,
  AnswerTerminalStatus,
  CriticVerdict,
  Query,
  RetrievalResult,
  RouterDecision,
} from "../types"

// ---------------------------------------------------------------------------
// Controlled sample material. The draft marker is deliberately absent from the
// policy source, so any occurrence in a public surface is a real leak.
// ---------------------------------------------------------------------------

const POLICY_SOURCE = "退货申请须在七日内提出，逾期不支持退款。"
const DRAFT_MARKER = "无条件永久退款（未通过草稿标记）"
const KNOWLEDGE_QUESTION = "退款政策是什么？"
const FAQ_QUESTION = "退货期限是多久？"
const FAQ_ANSWER = "标准答案：退货须在自签收之日起七日内申请。"
const TENANT_ID = "tenant-dr16"
const SUBJECT_ID = "user-dr16"

function policyResult(): RetrievalResult {
  return {
    chunk: {
      id: "chunk-dr16",
      documentId: "doc-dr16",
      content: POLICY_SOURCE,
      childrenIds: [],
      metadata: {},
    },
    score: 0.9,
    source: "vector",
    wikilinks: [],
  }
}

function makeRouter(decision: RouterDecision): Router {
  return { async decide(): Promise<RouterDecision> { return decision } }
}

function makeSearcher(
  outcome: SearchOutcome | (() => Promise<SearchOutcome>)
): Searcher {
  return {
    async search(_query: Query, _options?: SearchOptions): Promise<SearchOutcome> {
      return typeof outcome === "function" ? outcome() : outcome
    },
  }
}

const okOutcome = (result: RetrievalResult): SearchOutcome => ({
  status: "ok",
  results: [result],
  unavailableChannels: [],
})

function makeAssembler(): ContextAssembler {
  return { async assemble(): Promise<string> { return POLICY_SOURCE } }
}

function makeValidator(verdict: CriticVerdict): Validator {
  return { async validate(): Promise<CriticVerdict> { return verdict } } as unknown as Validator
}

function makeRePlanner(queries: Query[]): RePlanner {
  return { async replan(): Promise<Query[]> { return queries } }
}

function makeDraftStream(tokens: string[]): KnowledgeAnswerDraftStream {
  return async function* stream(): AsyncGenerator<string> {
    for (const token of tokens) yield token
  }
}

function cancellingDraftStream(tokens: string[]): KnowledgeAnswerDraftStream {
  return async function* stream(): AsyncGenerator<string> {
    for (const token of tokens) yield token
    const error = new Error("synthetic cancel")
    error.name = "AbortError"
    throw error
  }
}

// ---------------------------------------------------------------------------
// Real HTTP harness: real router + real adapter + isolated SQLite.
// ---------------------------------------------------------------------------

interface Harness {
  db: DB
  memory: SqliteConversationStore
  history: SqliteConversationHistoryStore
  base: string
  close: () => Promise<void>
}

async function startHarness(
  createRunner: (context: { db: DB; memory: SqliteConversationStore }) => MastraRunner
): Promise<Harness> {
  const db = openDb(":memory:")
  const memory = new SqliteConversationStore(db)
  const history = new SqliteConversationHistoryStore(db)
  const repository = new AnswerTraceRepository(db)
  const source = createMastraChatEventAdapter({
    runner: createRunner({ db, memory }),
    traceObserver: repository,
  })
  const app = express()
  app.use(express.json())
  app.use((_req, res, next) => {
    res.locals.accessContext = {
      tenantId: TENANT_ID,
      subjectId: SUBJECT_ID,
      groups: [],
      scopes: ["chat"],
    }
    next()
  })
  app.use("/api", createChatRouter(
    repository,
    source,
    undefined,
    (_context, requested) => ({
      knowledgeBaseIds: Array.isArray(requested) ? requested.map(String) : ["kb-1"],
    }),
    undefined,
    history
  ))
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const { port } = server.address() as AddressInfo
  return {
    db,
    memory,
    history,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      db.close()
    },
  }
}

// ---------------------------------------------------------------------------
// Transport consumption. Both branches return the same normalized shape; the
// assertions below never read the raw internal runner object.
// ---------------------------------------------------------------------------

interface SsePayload {
  sessionId: string
  runId: string
  event: AnswerRunEvent
  token?: string
  done?: boolean
  status?: string
  references?: unknown[]
  degradation?: unknown
}

interface TransportView {
  events: AnswerRunEvent[]
  reply: string
  status: AnswerTerminalStatus
  references: AnswerRunResult["references"]
  deltas: string
  clientContent: string
  clientStatus: string
  clientTraceStatus?: string
  clientReferenceIds: string[]
  historyEvents: AnswerRunEvent[]
  raw: string
}

async function runJson(
  harness: Harness,
  request: { message: string; runId: string; sessionId: string }
): Promise<TransportView> {
  const response = await fetch(`${harness.base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...request, stream: false }),
  })
  assert.equal(response.status, 200)
  const raw = await response.text()
  const body = JSON.parse(raw) as {
    reply: string
    status: AnswerTerminalStatus
    references: AnswerRunResult["references"]
    events: AnswerRunEvent[]
  }
  const conversation = new ConversationImpl({ storage: new InMemoryConversationStorage() })
  const message = startMessage(conversation)
  conversation.applyCompleteReply(
    message,
    {
      runId: request.runId,
      sessionId: request.sessionId,
      status: body.status,
      reply: body.reply,
      references: body.references as unknown as CompleteReplyData["references"],
      events: body.events as TraceEvent[],
    },
    true
  )
  const historyResponse = await fetch(`${harness.base}/api/chat/runs/${request.runId}`)
  assert.equal(historyResponse.status, 200)
  const history = await historyResponse.json() as { events: AnswerRunEvent[] }
  return {
    events: body.events,
    reply: body.reply,
    status: body.status,
    references: body.references,
    deltas: deltaText(body.events),
    clientContent: message.content,
    clientStatus: message.status,
    clientTraceStatus: message.traceStatus,
    clientReferenceIds: message.references.map(({ id }) => id),
    historyEvents: history.events,
    raw,
  }
}

async function runSse(
  harness: Harness,
  request: { message: string; runId: string; sessionId: string }
): Promise<TransportView> {
  const response = await fetch(`${harness.base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...request, stream: true }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("content-type"), "text/event-stream")
  const raw = await response.text()
  const payloads = raw.split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as SsePayload)
  const events = payloads.map(({ event }) => event)
  const done = assertSingleTerminal(events)
  const result = done.result
  const last = payloads.at(-1)
  assert.equal(last?.done, true, "the last SSE payload is the done envelope")
  assert.equal(last?.status, result.status)
  assert.deepEqual(last?.references, result.references)
  const conversation = new ConversationImpl({ storage: new InMemoryConversationStorage() })
  const message = startMessage(conversation)
  for (const payload of payloads) {
    conversation.processSseEvent(message, payload as never)
  }
  conversation.finalizeStreamRun(message)
  const historyResponse = await fetch(`${harness.base}/api/chat/runs/${request.runId}`)
  assert.equal(historyResponse.status, 200)
  const history = await historyResponse.json() as { events: AnswerRunEvent[] }
  return {
    events,
    reply: result.reply,
    status: result.status,
    references: result.references,
    deltas: deltaText(events),
    clientContent: message.content,
    clientStatus: message.status,
    clientTraceStatus: message.traceStatus,
    clientReferenceIds: message.references.map(({ id }) => id),
    historyEvents: history.events,
    raw,
  }
}

function startMessage(conversation: ConversationImpl): Message {
  const thread = conversation.getActiveThread()!
  return conversation.startAssistantRun(thread.id, { runId: "pending" })
}

function deltaText(events: AnswerRunEvent[]): string {
  return events
    .filter((event): event is Extract<AnswerRunEvent, { type: "answer_delta" }> =>
      event.type === "answer_delta"
    )
    .map(({ token }) => token)
    .join("")
}

function assertSingleTerminal(events: AnswerRunEvent[]): Extract<AnswerRunEvent, { type: "done" }> {
  const dones = events.filter((event): event is Extract<AnswerRunEvent, { type: "done" }> =>
    event.type === "done"
  )
  assert.equal(dones.length, 1, "exactly one terminal done event")
  assert.equal(events.at(-1)?.type, "done", "the terminal event must be last")
  return dones[0]
}

function citationIds(reply: string): string[] {
  return [...reply.matchAll(/\[cite:([^\]]+)\]/g)].map((match) => match[1])
}

/**
 * Consume one scenario over both transports and assert the DR-16-AC01
 * invariants: identical facts, citations and terminal state, one done event,
 * matching persisted trace and matching client display.
 */
async function assertParityAcrossTransports(
  harness: Harness,
  sample: { name: string; message: string; terminal: AnswerTerminalStatus }
): Promise<{ json: TransportView; sse: TransportView }> {
  const json = await runJson(harness, {
    message: sample.message,
    runId: `dr16-${sample.name}-json`,
    sessionId: `dr16-${sample.name}-json`,
  })
  const sse = await runSse(harness, {
    message: sample.message,
    runId: `dr16-${sample.name}-sse`,
    sessionId: `dr16-${sample.name}-sse`,
  })

  const jsonDone = assertSingleTerminal(json.events)
  const sseDone = assertSingleTerminal(sse.events)
  assert.equal(jsonDone.result.status, sample.terminal)
  assert.equal(sseDone.result.status, sample.terminal)

  assert.equal(sse.reply, json.reply, `${sample.name}: replies must match`)
  assert.equal(sse.status, json.status, `${sample.name}: terminal states must match`)
  assert.deepEqual(sse.references, json.references, `${sample.name}: references must match`)
  assert.deepEqual(citationIds(sse.reply), citationIds(json.reply))
  assert.deepEqual(
    sse.references.map(({ id }) => id),
    citationIds(sse.reply),
    `${sample.name}: each inline citation resolves to a reference`
  )

  // Each transport proves its own persisted trace is the stream it showed.
  assert.deepEqual(json.historyEvents, json.events)
  assert.deepEqual(sse.historyEvents, sse.events)

  // The client display follows the same facts/references/terminal state.
  assert.equal(sse.clientContent, json.clientContent, `${sample.name}: display body must match`)
  assert.equal(sse.clientStatus, json.clientStatus, `${sample.name}: display status must match`)
  assert.deepEqual(sse.clientReferenceIds, json.clientReferenceIds)
  assert.deepEqual(sse.clientReferenceIds, citationIds(json.reply))

  return { json, sse }
}

function effectiveHistory(harness: Harness, sessionId: string) {
  return {
    turns: harness.history.getTurns(sessionId, TENANT_ID, SUBJECT_ID),
    validated: harness.memory.loadRecentTurns(sessionId, TENANT_ID, 20),
  }
}

function assertNoDraftMarker(
  label: string,
  view: Pick<TransportView, "raw" | "events" | "historyEvents">
): void {
  for (const [surface, value] of [
    ["response bytes", view.raw],
    ["events", JSON.stringify(view.events)],
    ["persisted trace", JSON.stringify(view.historyEvents)],
    ["reply", view.raw],
  ] as const) {
    assert.equal(value.includes(DRAFT_MARKER), false, `${label}: draft leaked into ${surface}`)
  }
}

// ---------------------------------------------------------------------------
// Runner builders — the real product runners with controlled collaborators.
// ---------------------------------------------------------------------------

function simpleRunner(options: {
  conversationStore: ConversationStore
  draft: KnowledgeAnswerDraftStream
  validator?: CriticVerdict
  replanner?: Query[]
  search?: SearchOutcome | (() => Promise<SearchOutcome>)
}): MastraRunner {
  return createSimpleKnowledgeMastraRunner({
    router: makeRouter("simple"),
    createSearcher: () => makeSearcher(options.search ?? okOutcome(policyResult())),
    assembler: makeAssembler(),
    validator: makeValidator(options.validator ?? { passed: true, hallucination: false, completeness: true }),
    replanner: makeRePlanner(options.replanner ?? []),
    streamAnswerDraft: options.draft,
    conversationStore: options.conversationStore,
    resolveTenantId: () => TENANT_ID,
  } as never)
}

// ---------------------------------------------------------------------------
// DR-16-AC01 / DR-16-AC03 — the same golden sample shows the same facts,
// citations and terminal state in JSON and SSE, with exactly one done.
// ---------------------------------------------------------------------------

test("DR-16-AC01 approved knowledge sample is identical over JSON and SSE", async () => {
  const evidenceId = buildEvidence([policyResult()])[0].id
  const approved = `退款须在七日内申请 [cite:${evidenceId}]。`
  const harness = await startHarness(({ memory }) => simpleRunner({
    conversationStore: memory,
    draft: makeDraftStream([approved]),
  }))
  try {
    const { json, sse } = await assertParityAcrossTransports(harness, {
      name: "knowledge-approved",
      message: KNOWLEDGE_QUESTION,
      terminal: "completed",
    })
    assert.equal(json.reply, approved)
    assert.deepEqual(json.references.map(({ id }) => id), [evidenceId])
    assert.equal(json.deltas, approved)
    assert.equal(sse.deltas, approved)
    assert.equal(json.clientStatus, "complete")
    assert.equal(sse.clientStatus, "complete")

    const history = effectiveHistory(harness, "dr16-knowledge-approved-json")
    assert.equal(history.validated.length, 2, "an approved pair reaches validated memory")
    assert.equal(history.validated[1].content, approved)
    const assistant = history.turns.filter(({ role }) => role === "assistant")
    assert.equal(assistant.length, 1)
    assert.equal(assistant[0].terminalStatus, "completed")
    assert.equal(JSON.stringify(history.turns).includes(DRAFT_MARKER), false)
  } finally {
    await harness.close()
  }
})

test("DR-16-AC03 the FAQ standard answer keeps the same fact and citation over JSON and SSE", async () => {
  let innerCalls = 0
  const harness = await startHarness(({ db, memory }) => {
    const faq = new FaqEntryServiceImpl({
      repo: new SqliteFaqEntryRepo(db),
      now: () => new Date("2026-10-22T00:00:00.000Z"),
      generateId: () => "faq-dr16-1",
    })
    faq.create(TENANT_ID, "kb-1", {
      question: FAQ_QUESTION,
      answer: FAQ_ANSWER,
      variants: [],
    }, "admin")
    const inner: MastraRunner = async () => {
      innerCalls += 1
      return {
        reply: "不应到达的普通路径回答",
        status: "completed",
        references: [],
        degradation: { status: "none", unavailableChannels: [] },
        tokens: ["不应到达的普通路径回答"],
        routeTrace: {},
        retrievalTrace: {},
        contextTrace: {},
        validationTrace: {},
      }
    }
    return createFaqExactMatchRunner(
      { faq, conversationStore: memory, resolveTenantId: () => TENANT_ID },
      inner
    )
  })
  try {
    const { json, sse } = await assertParityAcrossTransports(harness, {
      name: "faq-approved",
      message: FAQ_QUESTION,
      terminal: "completed",
    })
    assert.equal(innerCalls, 0, "a unique exact FAQ hit never reaches the normal path")
    for (const view of [json, sse]) {
      assert.equal(view.reply.startsWith(FAQ_ANSWER), true)
      assert.equal(citationIds(view.reply).length, 1)
      assert.equal(view.references.length, 1)
      assert.equal(view.references[0].origin, "faq")
    }
    const history = effectiveHistory(harness, "dr16-faq-approved-json")
    assert.equal(history.validated.length, 2)
    assert.equal(history.validated[1].content, json.reply)
  } finally {
    await harness.close()
  }
})

// ---------------------------------------------------------------------------
// DR-16-AC02 / DR-16-AC03 — a rejected or cancelled draft never appears in
// the body, the events or the effective history over either transport.
// ---------------------------------------------------------------------------

test("DR-16-AC02 validation-rejected draft stays out of JSON, SSE, trace and history", async () => {
  const evidenceId = buildEvidence([policyResult()])[0].id
  const rejected = `${DRAFT_MARKER} [cite:${evidenceId}]。`
  const harness = await startHarness(({ memory }) => simpleRunner({
    conversationStore: memory,
    draft: makeDraftStream([rejected]),
    validator: {
      passed: false,
      hallucination: true,
      completeness: false,
      missingGap: "是否有永久退款例外",
    },
    replanner: [],
  }))
  try {
    const { json, sse } = await assertParityAcrossTransports(harness, {
      name: "validation-rejected",
      message: KNOWLEDGE_QUESTION,
      terminal: "insufficient_evidence",
    })
    for (const [label, view] of [["json", json], ["sse", sse]] as const) {
      assert.equal(view.reply, INSUFFICIENT_EVIDENCE_MESSAGE)
      assert.deepEqual(view.references, [])
      assert.equal(view.deltas, "", `${label}: no answer_delta may publish the rejected draft`)
      assert.equal(view.clientContent, INSUFFICIENT_EVIDENCE_MESSAGE)
      assert.equal(view.clientStatus, "error")
      assertNoDraftMarker(label, view)
    }

    for (const sessionId of ["dr16-validation-rejected-json", "dr16-validation-rejected-sse"]) {
      const history = effectiveHistory(harness, sessionId)
      assert.equal(history.validated.length, 0, "a rejected draft never enters validated memory")
      assert.equal(history.turns.length, 2)
      assert.equal(history.turns[0].role, "user")
      assert.equal(history.turns[0].content, KNOWLEDGE_QUESTION)
      assert.equal(history.turns[1].role, "assistant")
      assert.equal(history.turns[1].terminalStatus, "insufficient_evidence")
      assert.equal(history.turns[1].content, INSUFFICIENT_EVIDENCE_MESSAGE)
      assert.equal(JSON.stringify(history).includes(DRAFT_MARKER), false, "draft leaked into history")
    }
  } finally {
    await harness.close()
  }
})

test("DR-16-AC02 cancelled draft stays out of JSON, SSE, trace and history", async () => {
  const evidenceId = buildEvidence([policyResult()])[0].id
  const partial = `${DRAFT_MARKER} [cite:${evidenceId}]`
  const harness = await startHarness(({ memory }) => simpleRunner({
    conversationStore: memory,
    draft: cancellingDraftStream([partial]),
  }))
  try {
    const { json, sse } = await assertParityAcrossTransports(harness, {
      name: "cancelled",
      message: KNOWLEDGE_QUESTION,
      terminal: "cancelled",
    })
    for (const [label, view] of [["json", json], ["sse", sse]] as const) {
      assert.equal(view.reply, CANCELLED_MESSAGE)
      assert.deepEqual(view.references, [])
      assert.equal(view.deltas, "", `${label}: a cancelled draft publishes no answer_delta`)
      assert.equal(view.clientContent, CANCELLED_MESSAGE)
      assert.equal(view.clientStatus, "error")
      assertNoDraftMarker(label, view)
    }

    for (const sessionId of ["dr16-cancelled-json", "dr16-cancelled-sse"]) {
      const history = effectiveHistory(harness, sessionId)
      assert.equal(history.validated.length, 0, "a cancelled draft never enters validated memory")
      assert.equal(history.turns.length, 2)
      assert.equal(history.turns[1].terminalStatus, "cancelled")
      assert.equal(history.turns[1].content, CANCELLED_MESSAGE)
      assert.equal(JSON.stringify(history).includes(DRAFT_MARKER), false)
    }
  } finally {
    await harness.close()
  }
})

test("DR-16-AC02 a rejected draft carried in runner tokens never reaches an event", async () => {
  // The adapter is the last publication gate. A runner that cannot retract its
  // already-generated draft must not be able to publish it as answer_delta
  // events when its terminal rejected the draft — the done event alone carries
  // the public terminal copy.
  const evidenceId = buildEvidence([policyResult()])[0].id
  const rejected = `${DRAFT_MARKER} [cite:${evidenceId}]。`
  const harness = await startHarness(() => async () => ({
    reply: INSUFFICIENT_EVIDENCE_MESSAGE,
    status: "insufficient_evidence",
    references: [],
    degradation: { status: "insufficient", unavailableChannels: [] },
    tokens: [rejected],
    routeTrace: { decision: "simple" },
    retrievalTrace: { resultCount: 1 },
    contextTrace: { evidenceCount: 1, contextLength: 1 },
    validationTrace: { round: 1, passed: false },
  }))
  try {
    const { json, sse } = await assertParityAcrossTransports(harness, {
      name: "runner-token-rejected",
      message: KNOWLEDGE_QUESTION,
      terminal: "insufficient_evidence",
    })
    for (const [label, view] of [["json", json], ["sse", sse]] as const) {
      assert.equal(view.reply, INSUFFICIENT_EVIDENCE_MESSAGE)
      assert.deepEqual(view.references, [])
      assert.equal(view.deltas, "", `${label}: a rejected draft must not become an answer_delta`)
      assert.equal(view.clientContent, INSUFFICIENT_EVIDENCE_MESSAGE)
      assert.equal(view.clientContent.split(INSUFFICIENT_EVIDENCE_MESSAGE).length - 1, 1)
      assert.equal(view.clientStatus, "error")
      assertNoDraftMarker(label, view)
    }
    for (const sessionId of ["dr16-runner-token-rejected-json", "dr16-runner-token-rejected-sse"]) {
      const history = effectiveHistory(harness, sessionId)
      assert.equal(history.validated.length, 0)
      assert.equal(history.turns[1].content, INSUFFICIENT_EVIDENCE_MESSAGE)
      assert.equal(history.turns[1].terminalStatus, "insufficient_evidence")
      assert.equal(JSON.stringify(history).includes(DRAFT_MARKER), false)
    }
  } finally {
    await harness.close()
  }
})

test("DR-16-AC03 provider failure publishes the same safe terminal over JSON and SSE", async () => {
  const harness = await startHarness(({ memory }) => simpleRunner({
    conversationStore: memory,
    draft: makeDraftStream([`${DRAFT_MARKER} [cite:ev_unused]`]),
    search: async () => {
      throw new Error("synthetic retrieval provider failure")
    },
  }))
  try {
    const { json, sse } = await assertParityAcrossTransports(harness, {
      name: "provider-failure",
      message: KNOWLEDGE_QUESTION,
      terminal: "provider_error",
    })
    for (const [label, view] of [["json", json], ["sse", sse]] as const) {
      assert.equal(view.reply, PROVIDER_ERROR_MESSAGE)
      assert.deepEqual(view.references, [])
      assert.equal(view.deltas, "")
      assert.equal(view.clientContent, PROVIDER_ERROR_MESSAGE)
      assert.equal(view.clientStatus, "error")
      assertNoDraftMarker(label, view)
    }

    for (const sessionId of ["dr16-provider-failure-json", "dr16-provider-failure-sse"]) {
      const history = effectiveHistory(harness, sessionId)
      assert.equal(history.validated.length, 0)
      assert.equal(history.turns.length, 2)
      assert.equal(history.turns[1].terminalStatus, "provider_error")
      assert.equal(history.turns[1].content, PROVIDER_ERROR_MESSAGE)
      assert.equal(JSON.stringify(history).includes(DRAFT_MARKER), false)
    }
  } finally {
    await harness.close()
  }
})
