/**
 * DR-19 — the memory read/recall contract over real HTTP.
 *
 * Covered rules:
 *   - the owner's explicit memory view returns their own records;
 *   - memory arrives in the answer as non-citable background, never as a
 *     knowledge reference;
 *   - disabling memory (per request or on the assistant version) and
 *     switching owner or tenant makes memory unreadable;
 *   - an answer with a document fact is still validated against that
 *     document even when memory was recalled.
 *
 * Every assertion goes through a real Express app, the real identity
 * middleware, the real memory/assistant stores on isolated in-memory SQLite,
 * and the real memory-recall runner wrapping the real simple knowledge
 * runner. Retrieval/model/validation collaborators are controlled fakes, so
 * no provider is called.
 */

import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import type { Request } from "express"

import { createApp } from "./server"
import { createAccessMiddleware } from "./access_middleware"
import type { AccessContext, IdentityAdapter } from "../access/context"
import { openDb, type DB } from "../ingestion/tracking/db"
import { SqliteSessionBinder } from "../access/session_binder"
import { SqliteConversationHistoryStore } from "../answer/conversation_history_store"
import { AnswerTraceRepository } from "../answer/trace_repository"
import { LongTermMemoryStore } from "../memory/long_term_memory_store"
import { MemorySuggestionStore } from "../memory/memory_suggestion_store"
import { KnowledgeBaseServiceImpl } from "../knowledge/knowledge_base_service"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { AssistantService } from "../assistants/assistant_service"
import { createRetrievalScopeResolver } from "../retrieval/scope"
import { createMemoryRecallRunner } from "../mastra/memory_recall_runner"
import { createSimpleKnowledgeMastraRunner } from "../mastra/simple_knowledge_runner"
import { createMastraChatEventAdapter, type MastraRunnerInput } from "../mastra/chat_event_adapter"
import { buildEvidence } from "../answer/evidence"
import type { AgentMessage, RetrievalResult } from "../types"

const TENANT_A = "tenant-a"
const TENANT_B = "tenant-b"

const identities: Record<string, AccessContext> = {
  alice: { tenantId: TENANT_A, subjectId: "u-alice", groups: [], scopes: ["chat"] },
  bob: { tenantId: TENANT_A, subjectId: "u-bob", groups: [], scopes: ["chat"] },
  eve: { tenantId: TENANT_B, subjectId: "u-eve", groups: [], scopes: ["chat"] },
}

const adapter: IdentityAdapter = {
  resolve: async (req) => {
    const raw = (req as Request).headers["x-test-identity"]
    return typeof raw === "string" ? identities[raw] ?? null : null
  },
}

const ALICE_GLOBAL = "alice 全局偏好：结论先行"
const ALICE_PINNED = "alice 助手偏好：附代码示例"
const BOB_PRIVATE = "bob 私有偏好：不要提退款"
const EVE_PRIVATE = "eve 私有偏好：只用英文"

const retrievalResult: RetrievalResult = {
  chunk: {
    id: "chunk-refund",
    documentId: "doc-refund",
    content: "退款期限为 30 天。",
    childrenIds: [],
    metadata: {
      title: "退款政策",
      source: "refund.txt",
      documentVersion: 1,
    },
  },
  score: 0.9,
  source: "bm25",
  wikilinks: [],
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

interface Harness {
  base: string
  memories: LongTermMemoryStore
  assistants: AssistantService
  assistantMemoryOn: string
  assistantMemoryOff: string
  assistantOther: string
  /** Every runner input the recall wrapper produced, in call order. */
  runnerInputs: MastraRunnerInput[]
  /** Every draft system prompt the knowledge route rendered. */
  prompts: string[]
  validatorCalls: () => number
  close: () => Promise<void>
}

async function buildHarness(): Promise<Harness> {
  const db: DB = openDb(":memory:")
  const knowledgeBases = new KnowledgeBaseServiceImpl(new SqliteKnowledgeBaseRepo(db), "test:1536")
  const kbA = knowledgeBases.ensureDefault(TENANT_A)
  knowledgeBases.ensureDefault(TENANT_B)
  const assistants = new AssistantService(db, knowledgeBases)
  const memories = new LongTermMemoryStore({ db })
  const suggestions = new MemorySuggestionStore({ db })
  const conversationHistory = new SqliteConversationHistoryStore(db)
  const sessionBinder = new SqliteSessionBinder(db)
  const trace = new AnswerTraceRepository(db)

  const assistantConfig = (memoryEnabled: boolean) => ({
    systemPrompt: "",
    knowledgeBaseIds: [kbA.id],
    chatModelProfileId: "chat",
    rerankModelProfileId: null,
    toolPolicy: "read_only_retrieval",
    memoryEnabled,
  })
  const assistantMemoryOn = assistants.create(TENANT_A, "admin", {
    name: "记忆开启",
    config: assistantConfig(true),
  }).id
  const assistantMemoryOff = assistants.create(TENANT_A, "admin", {
    name: "记忆关闭",
    config: assistantConfig(false),
  }).id
  const assistantOther = assistants.create(TENANT_A, "admin", {
    name: "另一助手",
    config: assistantConfig(true),
  }).id

  memories.create({ tenantId: TENANT_A, subjectId: "u-alice", content: ALICE_GLOBAL })
  memories.create({
    tenantId: TENANT_A,
    subjectId: "u-alice",
    assistantId: assistantMemoryOn,
    content: ALICE_PINNED,
  })
  memories.create({ tenantId: TENANT_A, subjectId: "u-bob", content: BOB_PRIVATE })
  memories.create({ tenantId: TENANT_B, subjectId: "u-eve", content: EVE_PRIVATE })

  const evidence = buildEvidence([retrievalResult])
  const runnerInputs: MastraRunnerInput[] = []
  const prompts: string[] = []
  let validatorCalls = 0

  const knowledgeRunner = createSimpleKnowledgeMastraRunner({
    router: { async decide() { return "simple" as const } },
    createSearcher: () => ({
      async search() {
        return { status: "ok" as const, results: [retrievalResult], unavailableChannels: [] }
      },
    }),
    assembler: { async assemble() { return "退款期限为 30 天。" } },
    validator: {
      async validate() {
        validatorCalls += 1
        return { passed: true, hallucination: false, completeness: true }
      },
    },
    replanner: { async replan() { return [] } },
    streamAnswerDraft: async function* (messages: AgentMessage[]) {
      prompts.push(messages.map(({ content }) => content).join("\n"))
      yield `退款期限为 30 天 [cite:${evidence[0].id}]`
    },
  })

  const inner = async (input: MastraRunnerInput) => {
    runnerInputs.push(input)
    return knowledgeRunner(input)
  }
  const recallRunner = createMemoryRecallRunner(
    { memories, resolveTenantId: (ctx) => ctx.tenantId },
    inner
  )
  const eventsSource = createMastraChatEventAdapter({
    runner: recallRunner,
    traceObserver: trace,
  })

  const app = createApp({
    db,
    eventsSource,
    accessMiddleware: createAccessMiddleware({ mode: "enforced", adapter, requiredScope: "chat" }),
    managementAccessMiddleware: createAccessMiddleware({ mode: "enforced", adapter }),
    sessionBinder,
    retrievalScopeResolver: createRetrievalScopeResolver(knowledgeBases),
    knowledgeBaseService: knowledgeBases,
    conversationHistory,
    assistants,
    memories,
    suggestions,
  })
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    memories,
    assistants,
    assistantMemoryOn,
    assistantMemoryOff,
    assistantOther,
    runnerInputs,
    prompts,
    validatorCalls: () => validatorCalls,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      db.close()
    },
  }
}

function chat(
  harness: Harness,
  identity: keyof typeof identities,
  body: Record<string, unknown>
): Promise<Reply> {
  return call(harness.base, "/chat", identity, {
    method: "POST",
    body: JSON.stringify({ stream: false, ...body }),
  })
}

function doneResult(reply: Reply): Record<string, unknown> {
  const events = reply.json?.events as Array<Record<string, unknown>> | undefined
  const done = events?.find((event) => event.type === "done")
  assert.ok(done, "the answer must publish a terminal event")
  return done.result as Record<string, unknown>
}

test("DR-19: owner sees own memory; the answer keeps the document citation and still validates it", async () => {
  const harness = await buildHarness()
  try {
    const listed = await call(harness.base, "/memories", "alice")
    assert.equal(listed.status, 200)
    const listedIds = (listed.json?.memories as Array<{ id: string }>).map(({ id }) => id)
    assert.equal(listed.text.includes(ALICE_GLOBAL), true)
    assert.equal(listed.text.includes(ALICE_PINNED), true)
    assert.equal(listed.text.includes(BOB_PRIVATE), false)
    assert.equal(listed.text.includes(EVE_PRIVATE), false)

    const answer = await chat(harness, "alice", {
      message: "退款期限是多久？",
      assistantId: harness.assistantMemoryOn,
      sessionId: "sess-alice",
      runId: "run-alice",
    })
    assert.equal(answer.status, 200)
    assert.equal(answer.json?.status, "completed")
    assert.equal(answer.text.includes("30 天"), true)

    // Memory really was recalled into the owner's run, as background only.
    const done = doneResult(answer)
    const memoryUsed = done.memoryUsed as { ids: string[]; count: number }
    assert.equal(memoryUsed.count, 2)
    assert.deepEqual(
      memoryUsed.ids.sort(),
      harness.memories
        .recall(TENANT_A, "u-alice", harness.assistantMemoryOn)
        .map(({ id }) => id)
        .sort()
    )
    assert.equal(harness.prompts.length, 1)
    assert.equal(harness.prompts[0].includes(ALICE_GLOBAL), true)
    assert.equal(harness.prompts[0].includes(ALICE_PINNED), true)
    assert.equal(harness.prompts[0].includes("禁止作为事实引用"), true)

    // AC03: the document path still ran its validation and kept the citation.
    assert.equal(harness.validatorCalls() > 0, true, "grounding validation must still run")
    const references = answer.json?.references as Array<Record<string, unknown>>
    assert.equal(references.length, 1)
    assert.equal(references[0].documentId, "doc-refund")
    assert.equal(references[0].chunkId, "chunk-refund")
    for (const memory of harness.memories.recall(TENANT_A, "u-alice", harness.assistantMemoryOn)) {
      assert.equal(JSON.stringify(references).includes(memory.id), false)
      assert.equal(JSON.stringify(references).includes(memory.content), false)
    }

    // The persisted run reads back the same citation and no memory record.
    const persisted = await call(harness.base, "/chat/runs/run-alice", "alice")
    assert.equal(persisted.status, 200)
    assert.equal(persisted.text.includes("chunk-refund"), true)
    assert.equal(persisted.text.includes(ALICE_GLOBAL), false)
    assert.equal(persisted.text.includes(ALICE_PINNED), false)
  } finally {
    await harness.close()
  }
})

test("DR-19: another owner and another tenant recall only their own memories", async () => {
  const harness = await buildHarness()
  try {
    const bob = await chat(harness, "bob", {
      message: "退款期限是多久？",
      assistantId: harness.assistantMemoryOn,
      sessionId: "sess-bob",
      runId: "run-bob",
    })
    assert.equal(bob.status, 200)
    const bobUsed = doneResult(bob).memoryUsed as { count: number }
    assert.equal(bobUsed.count, 1, "bob recalls only his own memory")
    assert.equal(harness.runnerInputs.at(-1)?.longTermMemories?.length, 1)
    assert.equal(harness.runnerInputs.at(-1)?.longTermMemories?.[0].content, BOB_PRIVATE)
    assert.equal(bob.text.includes(ALICE_GLOBAL), false)
    assert.equal(bob.text.includes(ALICE_PINNED), false)

    // Eve is in another tenant: no assistant (cross-tenant would be 404), but
    // her run still reads only tenant-b identities.
    const eve = await chat(harness, "eve", {
      message: "退款期限是多久？",
      sessionId: "sess-eve",
      runId: "run-eve",
    })
    assert.equal(eve.status, 200)
    const eveUsed = doneResult(eve).memoryUsed as { count: number }
    assert.equal(eveUsed.count, 1)
    assert.equal(harness.runnerInputs.at(-1)?.longTermMemories?.[0].content, EVE_PRIVATE)
    assert.equal(eve.text.includes(ALICE_GLOBAL), false)
    assert.equal(eve.text.includes(ALICE_PINNED), false)
  } finally {
    await harness.close()
  }
})

test("DR-19: disabling memory by request or by assistant version recalls nothing", async () => {
  const harness = await buildHarness()
  try {
    const requested = await chat(harness, "alice", {
      message: "退款期限是多久？",
      assistantId: harness.assistantMemoryOn,
      useMemory: false,
      sessionId: "sess-no-memory",
      runId: "run-no-memory",
    })
    assert.equal(requested.status, 200)
    assert.equal(requested.json?.status, "completed")
    assert.equal(doneResult(requested).memoryUsed, undefined)
    assert.equal(harness.runnerInputs.at(-1)?.longTermMemories, undefined)
    assert.equal(requested.text.includes(ALICE_GLOBAL), false)
    assert.equal(requested.text.includes(ALICE_PINNED), false)

    // The assistant version itself disables memory: its run must read none,
    // even though the owner has records and the request did not opt out.
    const assistantOff = await chat(harness, "alice", {
      message: "退款期限是多久？",
      assistantId: harness.assistantMemoryOff,
      sessionId: "sess-assistant-off",
      runId: "run-assistant-off",
    })
    assert.equal(assistantOff.status, 200)
    assert.equal(assistantOff.json?.status, "completed")
    assert.equal(doneResult(assistantOff).memoryUsed, undefined)
    assert.equal(harness.runnerInputs.at(-1)?.longTermMemories, undefined)
    assert.equal(assistantOff.text.includes(ALICE_GLOBAL), false)
    assert.equal(assistantOff.text.includes(ALICE_PINNED), false)
    assert.equal(harness.prompts.at(-1)?.includes(ALICE_GLOBAL), false)
  } finally {
    await harness.close()
  }
})

test("DR-19: assistant-pinned memory is read only by that assistant", async () => {
  const harness = await buildHarness()
  try {
    const other = await chat(harness, "alice", {
      message: "退款期限是多久？",
      assistantId: harness.assistantOther,
      sessionId: "sess-other-assistant",
      runId: "run-other-assistant",
    })
    assert.equal(other.status, 200)
    const used = doneResult(other).memoryUsed as { count: number }
    assert.equal(used.count, 1)
    assert.deepEqual(
      harness.runnerInputs.at(-1)?.longTermMemories?.map(({ content }) => content),
      [ALICE_GLOBAL]
    )
    assert.equal(other.text.includes(ALICE_PINNED), false)
  } finally {
    await harness.close()
  }
})
