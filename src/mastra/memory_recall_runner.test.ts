/**
 * Ticket 33 (MEM-01B) — the memory-recall wrapper: owner-scoped recall,
 * per-run disable, honest memoryUsed trace, and extraction that only fires
 * on COMPLETED answers.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { openDb } from "../ingestion/tracking/db"
import { LongTermMemoryStore } from "../memory/long_term_memory_store"
import { MemorySuggestionStore } from "../memory/memory_suggestion_store"
import {
  createMemoryRecallRunner,
  type MemoryRecallRunnerDeps,
} from "./memory_recall_runner"
import type { MastraRunnerInput, MastraRunnerOutput } from "./chat_event_adapter"
import { renderMemoryPromptSuffix } from "./memory_prompt"
import type { AccessContext } from "../access/context"

const context: AccessContext = {
  tenantId: "tenant-a",
  subjectId: "alice",
  groups: [],
  scopes: ["chat"],
}

function build() {
  const db = openDb(":memory:")
  const memories = new LongTermMemoryStore({ db })
  const suggestions = new MemorySuggestionStore({ db })
  memories.create({ tenantId: "tenant-a", subjectId: "alice", content: "全局偏好：结论先行" })
  memories.create({
    tenantId: "tenant-a",
    subjectId: "alice",
    assistantId: "ast-1",
    content: "助手偏好：附代码示例",
  })
  memories.create({
    tenantId: "tenant-a",
    subjectId: "bob",
    content: "bob 的私有偏好",
  })
  return { memories, suggestions }
}

function runnerInput(overrides: Partial<MastraRunnerInput> = {}): MastraRunnerInput {
  return {
    message: "退款政策是什么",
    runId: "run-1",
    sessionId: "session-1",
    signal: new AbortController().signal,
    accessContext: context,
    ...overrides,
  }
}

const innerStub = (status: MastraRunnerOutput["status"] = "completed") => {
  const calls: MastraRunnerInput[] = []
  const inner = async (input: MastraRunnerInput): Promise<MastraRunnerOutput> => {
    calls.push(input)
    return {
      reply: "answer",
      status,
      references: [],
      degradation: { status: "none", unavailableChannels: [] },
      tokens: ["answer"],
      routeTrace: {},
      retrievalTrace: {},
      contextTrace: {},
      validationTrace: {},
    }
  }
  return { inner, calls }
}

const deps = (stores: ReturnType<typeof build>, extra: Partial<MemoryRecallRunnerDeps> = {}) =>
  ({
    memories: stores.memories,
    suggestions: stores.suggestions,
    resolveTenantId: (ctx: AccessContext) => ctx.tenantId,
    ...extra,
  }) as MemoryRecallRunnerDeps

test("Ticket 33: recall respects user and assistant scope", async () => {
  const stores = build()
  const { inner, calls } = innerStub()
  const runner = createMemoryRecallRunner(deps(stores), inner)

  // Default (legacy) assistant: global memories only — never another user's.
  await runner(runnerInput())
  assert.deepEqual(calls[0].longTermMemories?.map(({ content }) => content), ["全局偏好：结论先行"])

  // An assistant-bound run also gets that assistant's pinned memories.
  await runner(runnerInput({ assistant: { id: "ast-1", version: 1 } } as Partial<MastraRunnerInput>))
  assert.deepEqual(
    calls[1].longTermMemories?.map(({ content }) => content).sort(),
    ["全局偏好：结论先行", "助手偏好：附代码示例"]
  )
})

test("Ticket 33: the run can disable recall, and ordinary answering is unaffected", async () => {
  const stores = build()
  const { inner, calls } = innerStub()
  const runner = createMemoryRecallRunner(deps(stores), inner)

  await runner(runnerInput({ useMemory: false }))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].longTermMemories, undefined)
  assert.equal(calls[0].message, "退款政策是什么")

  // No store wired at all (evaluation scopes): pass-through with no memory.
  const bare = innerRecordingBare()
  await createMemoryRecallRunner({ resolveTenantId: (ctx) => ctx.tenantId }, bare.inner)(
    runnerInput()
  )
  assert.equal(bare.calls.length, 1)
  assert.equal(bare.calls[0].longTermMemories, undefined)
})

function innerRecordingBare() {
  const calls: MastraRunnerInput[] = []
  return {
    calls,
    inner: async (input: MastraRunnerInput): Promise<MastraRunnerOutput> => {
      calls.push(input)
      return {
        reply: "answer",
        status: "completed",
        references: [],
        degradation: { status: "none", unavailableChannels: [] },
        tokens: ["answer"],
        routeTrace: {},
        retrievalTrace: {},
        contextTrace: {},
        validationTrace: {},
      }
    },
  }
}

test("Ticket 33: the trace identifies the memories used; they are not citations", async () => {
  const stores = build()
  const { inner, calls } = innerStub()
  const runner = createMemoryRecallRunner(deps(stores), inner)
  const output = await runner(runnerInput())
  assert.deepEqual(output.memoryUsed, {
    ids: calls[0].longTermMemories!.map(({ id }) => id),
    count: 1,
  })
  // The memory prompt suffix labels it as non-citable background.
  const suffix = renderMemoryPromptSuffix(calls[0].longTermMemories)
  assert.ok(suffix.includes("禁止作为事实引用"))
  // References are untouched — memory never enters the citation set.
  assert.deepEqual(output.references, [])
})

test("Ticket 33: completed answers create pending suggestions; failed answers create none", async () => {
  const stores = build()
  const completed = innerStub("completed")
  await createMemoryRecallRunner(deps(stores), completed.inner)(
    runnerInput({ message: "请记住我喜欢简洁的回答。知识库里怎么申请退款？" })
  )
  assert.equal(stores.suggestions.list("tenant-a", "alice").length, 1)
  assert.equal(stores.suggestions.list("tenant-a", "alice")[0].status, "pending")
  assert.equal(stores.suggestions.list("tenant-a", "alice")[0].sourceRunId, "run-1")
  // Extraction does not publish memory.
  assert.equal(stores.memories.list("tenant-a", "alice").length, 2)

  for (const status of ["insufficient_evidence", "clarification_required", "handoff_required", "provider_error", "cancelled", "invalid_citation"] as const) {
    const failed = innerStub(status)
    await createMemoryRecallRunner(deps(stores), failed.inner)(
      runnerInput({ message: "请记住我喜欢简洁的回答", runId: `run-${status}` })
    )
  }
  assert.equal(
    stores.suggestions.list("tenant-a", "alice").length,
    1,
    "no suggestion may come from a non-completed answer"
  )
})
