/**
 * Ticket 11 — Simple knowledge route Mastra runner tests.
 *
 * TDD test suite for `src/mastra/simple_knowledge_runner.ts`. Verifies the
 * MastraRunner contract for the simple knowledge route: retrieval → Evidence
 * → Context → answer Draft → Citation check → Critic validation loop →
 * publish / handoff.
 *
 * Coverage map (T11 acceptance criteria):
 *   #1 Mastra delegates retrieval to existing Access Context-aware service
 *      → happy path test (searcher.search receives accessContext)
 *   #2 Retrieved results become same stable Evidence + bounded Context
 *      → happy path test (evidence built from results, context assembled)
 *   #3 Cannot complete without usable Evidence + valid Citation
 *      → empty evidence tests + no cited claims test
 *   #4 Unknown Citations + failed Critic rejected before publication
 *      → invalid_citation test + validation loop tests (replan exhausted,
 *         correction + regeneration, 3 rounds expired)
 *   #5 Retrieval/model/validation/cancellation failures → terminal statuses
 *      → insufficient_retrieval test + abort tests
 *   #6 Answer event/SSE/JSON/replay/Conversation/Handoff/Trace compatible
 *      → trace data test + save validated turns test + handoff creation test
 *   #7 Runtime rollback returns route to legacy orchestrator
 *      → RouteNotSimpleError test
 *
 * Boundary: this test file is owned by `src/mastra/*` and MUST NOT import
 * `src/api/*` or `src/index` (T02 #5 dependency direction).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createSimpleKnowledgeMastraRunner,
  RouteNotSimpleError,
} from "./simple_knowledge_runner"
import { buildEvidence, citationIdsByChunk } from "../answer/evidence"
import type { MastraRunnerInput, MastraRunnerOutput, ProgressStage, StageProgressDetails } from "./chat_event_adapter"
import type { Router } from "../retrieval/router/interface"
import type {
  Searcher,
  SearchOptions,
  SearchOutcome,
} from "../retrieval/search/interface"
import type { ContextAssembler } from "../retrieval/context/interface"
import {
  ContextAssemblerImpl,
  modelTokenCount,
} from "../retrieval/context/assembler"
import type {
  ContextCompressor,
  ContextCompressionResult,
} from "../answer/context_compressor"
import type { Validator } from "../critic/validator/interface"
import type { RePlanner } from "../critic/replanner/interface"
import type {
  ConversationStore,
  ConversationTurn,
  ConversationMemory,
} from "../answer/conversation_store"
import type { HandoffStore } from "../answer/handoff_store"
import type { AccessContext } from "../access/context"
import type {
  Evidence,
  Query,
  RetrievalResult,
  RouterDecision,
  CriticVerdict,
  AgentMessage,
} from "../types"

// ---------------------------------------------------------------------------
// Test fakes
// ---------------------------------------------------------------------------

function makeFakeRouter(decision: RouterDecision): Router {
  return {
    async decide(_query): Promise<RouterDecision> {
      return decision
    },
  }
}

function makeRetrievalResult(overrides: Partial<RetrievalResult> = {}): RetrievalResult {
  return {
    chunk: {
      id: overrides.chunk?.id ?? "chunk-1",
      documentId: overrides.chunk?.documentId ?? "doc-1",
      content: overrides.chunk?.content ?? "Sample content for testing.",
      childrenIds: overrides.chunk?.childrenIds ?? [],
      metadata: overrides.chunk?.metadata ?? {},
      ...overrides.chunk,
    },
    score: overrides.score ?? 0.9,
    source: overrides.source ?? "vector",
    wikilinks: overrides.wikilinks ?? [],
    ...overrides,
  }
}

function makeFakeSearcher(
  outcomes: SearchOutcome[] | SearchOutcome
): Searcher & { calls: Array<{ query: Query; options?: SearchOptions }> } {
  const calls: Array<{ query: Query; options?: SearchOptions }> = []
  const outcomeList = Array.isArray(outcomes) ? outcomes : [outcomes]
  let callIndex = 0
  return {
    calls,
    async search(query: Query, options?: SearchOptions): Promise<SearchOutcome> {
      calls.push({ query, options })
      const outcome = outcomeList[Math.min(callIndex, outcomeList.length - 1)]
      callIndex += 1
      return outcome
    },
  }
}

function makeFakeAssembler(context: string = "assembled context"): ContextAssembler {
  return {
    async assemble(_results, _citationIds?): Promise<string> {
      return context
    },
  }
}

function makeFakeValidator(
  verdicts: CriticVerdict[] | CriticVerdict
): Validator & { calls: number } {
  const verdictList = Array.isArray(verdicts) ? verdicts : [verdicts]
  let callIndex = 0
  let callsCount = 0
  const validator = {
    get calls(): number {
      return callsCount
    },
    async validate(
      _answer: string,
      _context: AgentMessage[],
      _coverageCriteria?: string[]
    ): Promise<CriticVerdict> {
      const verdict = verdictList[Math.min(callIndex, verdictList.length - 1)]
      callIndex += 1
      callsCount++
      return verdict
    },
  } as Validator & { calls: number }
  return validator
}

function makeFakeRePlanner(
  gapQueries: Query[][] | Query[]
): RePlanner & { calls: number } {
  const queryList = Array.isArray(gapQueries[0]) ? (gapQueries as Query[][]) : [gapQueries as Query[]]
  let callIndex = 0
  let callsCount = 0
  const replanner = {
    get calls(): number {
      return callsCount
    },
    async replan(_verdict: CriticVerdict): Promise<Query[]> {
      const queries = queryList[Math.min(callIndex, queryList.length - 1)]
      callIndex += 1
      callsCount++
      return queries
    },
  } as RePlanner & { calls: number }
  return replanner
}

function makeScriptedDraftStream(
  tokensByCall: string[][] | string[]
): (messages: AgentMessage[], signal: AbortSignal) => AsyncIterable<string> {
  const tokensList = Array.isArray(tokensByCall[0]) ? (tokensByCall as string[][]) : [tokensByCall as string[]]
  let callIndex = 0
  return async function* scriptedStream(
    _messages: AgentMessage[],
    _signal: AbortSignal
  ): AsyncGenerator<string> {
    const tokens = tokensList[Math.min(callIndex, tokensList.length - 1)]
    callIndex += 1
    for (const token of tokens) {
      yield token
    }
  }
}

function makeAbortingDraftStream(atCall: number = 0): (messages: AgentMessage[], signal: AbortSignal) => AsyncIterable<string> {
  let callIndex = 0
  return async function* abortingStream(_messages, _signal) {
    if (callIndex === atCall) {
      callIndex++
      const err = new Error("Draft stream aborted")
      err.name = "AbortError"
      throw err
    }
    callIndex++
    yield "token"
  }
}

function makeFakeConversationStore(
  memory?: Partial<ConversationMemory>
): ConversationStore & {
  validatedTurns: ConversationTurn[]
  pendingClarificationConsumed: Array<{ sessionId: string; tenantId: string }>
  loadMemoryCalls: Array<{ sessionId: string; tenantId: string }>
} {
  const validatedTurns: ConversationTurn[] = []
  const pendingClarificationConsumed: Array<{ sessionId: string; tenantId: string }> = []
  const loadMemoryCalls: Array<{ sessionId: string; tenantId: string }> = []
  const baseMemory: ConversationMemory = {
    totalValidatedTurnCount: memory?.totalValidatedTurnCount ?? 0,
    oldestRecentTurnId: memory?.oldestRecentTurnId ?? null,
    summary: memory?.summary ?? null,
    summarizedThroughTurnId: memory?.summarizedThroughTurnId ?? null,
    schemaVersion: memory?.schemaVersion ?? 1,
    recentTurns: memory?.recentTurns ?? [],
  }
  return {
    validatedTurns,
    pendingClarificationConsumed,
    loadMemoryCalls,
    saveValidatedTurn(turn: ConversationTurn): void {
      validatedTurns.push(turn)
    },
    savePendingClarification(): void { /* no-op */ },
    loadConversationMemory(sessionId: string, tenantId: string): ConversationMemory {
      loadMemoryCalls.push({ sessionId, tenantId })
      return baseMemory
    },
    loadOlderTurnsForSummarization(): ConversationTurn[] { return [] },
    saveRollingSummary(): void { /* no-op */ },
    consumePendingClarification(sessionId: string, tenantId: string): string | null {
      pendingClarificationConsumed.push({ sessionId, tenantId })
      return null
    },
  } as unknown as ConversationStore & {
    validatedTurns: ConversationTurn[]
    pendingClarificationConsumed: Array<{ sessionId: string; tenantId: string }>
    loadMemoryCalls: Array<{ sessionId: string; tenantId: string }>
  }
}

function makeFakeHandoffStore(): HandoffStore & {
  createdCases: Array<{
    runId: string
    tenantId: string
    subjectId: string
    sessionId: string
    reasonCode: string
    userRequest: string
    conversationSummary: string
    evidenceIds: string[]
    traceReference: string
  }>
} {
  const createdCases: Array<any> = []
  return {
    createdCases,
    create(args: any): unknown {
      createdCases.push(args)
      // PL-01 AC04: a successful persistence returns the established case.
      return { caseId: `case-${createdCases.length}` }
    },
  } as unknown as HandoffStore & { createdCases: Array<any> }
}

function makeAccessContext(tenantId: string = "tenant-test"): AccessContext {
  return {
    tenantId,
    subjectId: "subject-test",
    groups: [],
    scopes: ["chat"],
  }
}

function makeRunnerInput(overrides: Partial<MastraRunnerInput> = {}): MastraRunnerInput {
  return {
    message: "What is the return policy?",
    runId: "run-test-001",
    sessionId: "sess-test-001",
    signal: new AbortController().signal,
    accessContext: makeAccessContext(),
    ...overrides,
  }
}

/**
 * Build a valid answer with citations for the given evidence. Used to make
 * streamAnswerDraft return answers that pass referencesForReply checks.
 */
function buildCitedAnswer(evidence: ReturnType<typeof buildEvidence>): string {
  if (evidence.length === 0) return "No evidence available."
  const firstId = evidence[0].id
  return `According to the document [cite:${firstId}], the return policy is 30 days.`
}

test("AP-02: simple runner reports actual retrieval, assembly, draft and validation boundaries", async () => {
  const result = makeRetrievalResult()
  const evidence = buildEvidence([result])
  const progress: Array<{ stage: ProgressStage; details?: StageProgressDetails<ProgressStage> }> = []
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => makeFakeSearcher({ status: "ok", results: [result], unavailableChannels: [] }),
    assembler: { async assemble() {
      assert.deepEqual(progress.at(-1), { stage: "context", details: { round: 1, data: { phase: "assembly", evidenceCount: 1 } } })
      return "actual evidence context"
    } },
    streamAnswerDraft: async function* () {
      assert.equal(progress.at(-1)?.stage, "context")
      assert.equal((progress.at(-1)?.details?.data as { phase?: string }).phase, "draft")
      yield buildCitedAnswer(evidence)
    },
    validator: { async validate() {
      assert.deepEqual(progress.at(-1), { stage: "validation", details: { round: 1, data: { round: 1 } } })
      return { passed: true, hallucination: false, completeness: true, answerBasis: { text: "  依据已核对的退货资料。  ", referenceIds: [evidence[0].id, evidence[0].id] } }
    } },
    replanner: makeFakeRePlanner([]),
  })
  const output = await runner(makeRunnerInput({ onStageProgress: (stage, details) => progress.push({ stage, details }) }))
  assert.equal(output.status, "completed")
  assert.ok(progress.some(({ stage, details }) => stage === "retrieval" && details?.status === "completed" && (details.data as { resultCount?: number }).resultCount === 1))
  assert.equal(output.contextTrace.phase, "draft")
  assert.deepEqual(output.validationTrace.answerBasis, { text: "依据已核对的退货资料。", referenceIds: [evidence[0].id] })
  assert.ok(progress.every(({ details }) => !details?.data || !("answerBasis" in details.data)))
})

test("AP-02: simple correction shows round two and publishes only its passed basis", async () => {
  const oldResult = makeRetrievalResult()
  const gapResult = makeRetrievalResult({ chunk: { id: "gap", documentId: "gap-doc", content: "New evidence", childrenIds: [], metadata: {} } })
  const oldEvidence = buildEvidence([oldResult])
  const gapEvidence = buildEvidence([gapResult])
  const progress: Array<{ stage: ProgressStage; details?: StageProgressDetails<ProgressStage> }> = []
  const searcher = makeFakeSearcher([
    { status: "ok", results: [oldResult], unavailableChannels: [] },
    { status: "ok", results: [gapResult], unavailableChannels: [] },
  ])
  const validator = makeFakeValidator([
    { passed: false, hallucination: false, completeness: false, answerBasis: { text: "第一轮不能公开", referenceIds: [oldEvidence[0].id] } },
    { passed: true, hallucination: false, completeness: true, answerBasis: { text: "第二轮依据新增资料。", referenceIds: [gapEvidence[0].id] } },
  ])
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"), createSearcher: () => searcher,
    assembler: makeFakeAssembler(), validator, replanner: makeFakeRePlanner([{ text: "missing detail" }]),
    streamAnswerDraft: makeScriptedDraftStream([[buildCitedAnswer(oldEvidence)], [buildCitedAnswer(gapEvidence)]]),
  })
  const output = await runner(makeRunnerInput({ onStageProgress: (stage, details) => progress.push({ stage, details }) }))
  assert.equal(output.status, "completed")
  assert.deepEqual(output.validationTrace.answerBasis, { text: "第二轮依据新增资料。", referenceIds: [gapEvidence[0].id] })
  assert.equal(validator.calls, 2)
  assert.equal(searcher.calls.length, 2)
  const roundTwo = progress.filter(({ details }) => details?.round === 2)
  assert.deepEqual(roundTwo.map(({ stage }) => stage), ["retrieval", "retrieval", "context", "context", "context", "context", "validation", "validation"])
  assert.equal((roundTwo[1].details?.data as { resultCount?: number }).resultCount, 1)
  assert.ok(progress.every(({ details }) => !details?.data || !("answerBasis" in details.data)))
})

// ---------------------------------------------------------------------------
// T11 #1 — Mastra delegates retrieval to existing Access Context-aware service
// ---------------------------------------------------------------------------

test("T11 #1 happy path: retrieval success + validation pass → completed", async () => {
  const result = makeRetrievalResult()
  const evidence = buildEvidence([result])
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [result],
    unavailableChannels: [],
  })
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed", "happy path must reach completed")
  assert.equal(output.routeTrace.decision, "simple")
  assert.ok(output.reply.length > 0, "reply must be non-empty")
  assert.ok(output.references.length > 0, "must have at least one reference (T11 #3)")
  assert.ok(output.tokens.length > 0, "tokens must be collected from draft stream")
})

test("P1 regression: early simple terminal preserves the complete prepared route trace", async () => {
  const preparedTrace = {
    decision: "simple" as const,
    contextualizationOutcome: "failed" as const,
    contextualizationFailure: "context provider unavailable",
    contextualizationUsage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
    contextualizationDurationMs: 17,
  }
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => makeFakeSearcher({
      status: "ok",
      results: [],
      unavailableChannels: [],
    }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["unused"]),
  })

  const output = await runner(makeRunnerInput({
    preparedRoute: {
      decision: "simple",
      effectiveMessage: "effective",
      contextualizedQuery: "contextualized",
      routeTrace: preparedTrace,
    },
  }))

  assert.equal(output.status, "insufficient_evidence")
  assert.deepEqual(output.routeTrace, preparedTrace)
})

test("P1 regression: abort observed immediately before persistence writes no validated turns", async () => {
  const result = makeRetrievalResult()
  const evidence = buildEvidence([result])
  const conversationStore = makeFakeConversationStore()
  let armed = false
  let aborted = false
  const listeners = new Set<unknown>()
  const signal = {
    get aborted() { return aborted },
    addEventListener(_type: string, listener: unknown) {
      listeners.add(listener)
    },
    removeEventListener(_type: string, listener: unknown) {
      listeners.delete(listener)
      if (armed) aborted = true
    },
  } as unknown as AbortSignal
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => makeFakeSearcher({
      status: "ok",
      results: [result],
      unavailableChannels: [],
    }),
    assembler: makeFakeAssembler(),
    validator: {
      async validate(): Promise<CriticVerdict> {
        armed = true
        return { passed: true, hallucination: false, completeness: true }
      },
    },
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    conversationStore,
  })

  await assert.rejects(
    () => runner(makeRunnerInput({ signal })),
    (error: unknown) => {
      assert.equal((error as Error).name, "AbortError")
      return true
    }
  )
  assert.equal(conversationStore.validatedTurns.length, 0)
})

test("P1 regression: abort during post-persistence summarization keeps simple completion authoritative", async () => {
  const result = makeRetrievalResult()
  const evidence = buildEvidence([result])
  const conversationStore = makeFakeConversationStore({
    totalValidatedTurnCount: 13,
    oldestRecentTurnId: 14,
  })
  conversationStore.loadOlderTurnsForSummarization = () => [{
    sessionId: "sess-test-001",
    tenantId: "tenant-test",
    role: "user",
    content: "older fact",
    runId: "older-run",
    createdAt: "2026-07-01T00:00:00.000Z",
  }]
  const controller = new AbortController()
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => makeFakeSearcher({
      status: "ok",
      results: [result],
      unavailableChannels: [],
    }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    conversationStore,
    resolveTenantId: (ctx) => ctx.tenantId,
    summarizer: {
      async summarize() {
        controller.abort()
        const error = new Error("summary aborted")
        error.name = "AbortError"
        throw error
      },
    },
  })

  const output = await runner(makeRunnerInput({ signal: controller.signal }))
  assert.equal(output.status, "completed")
  assert.equal(output.summarizationOutcome, "failed")
  assert.equal(conversationStore.validatedTurns.length, 2)
})

test("T11 #1 accessContext propagated to searcher.search", async () => {
  const accessContext = makeAccessContext("tenant-xyz")
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [makeRetrievalResult()],
    unavailableChannels: [],
  })
  const evidence = buildEvidence([makeRetrievalResult()])
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
  })
  await runner(makeRunnerInput({ accessContext }))
  assert.equal(
    searcher.calls[0].options?.accessContext,
    accessContext,
    "searcher.search must receive accessContext (T11 #1)"
  )
})

test("Ticket 05: the run's server-computed knowledge scope reaches searcher.search", async () => {
  const retrievalScope = { knowledgeBaseIds: ["kb-policies"] }
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [makeRetrievalResult()],
    unavailableChannels: [],
  })
  const evidence = buildEvidence([makeRetrievalResult()])
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
  })

  await runner(makeRunnerInput({ retrievalScope }))

  assert.deepEqual(
    searcher.calls[0].options?.retrievalScope,
    retrievalScope,
    "retrievalScope must be forwarded verbatim (Ticket 05, KB-03A)"
  )
})

test("Ticket 05: a run without a knowledge scope leaves searcher.search unscoped", async () => {
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [makeRetrievalResult()],
    unavailableChannels: [],
  })
  const evidence = buildEvidence([makeRetrievalResult()])
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
  })

  await runner(makeRunnerInput())

  assert.equal(
    searcher.calls[0].options?.retrievalScope,
    undefined,
    "a scope-less run must not invent one (backward compat)"
  )
})

test("Ticket 05: correction retrieval shares the run's knowledge scope", async () => {
  const retrievalScope = { knowledgeBaseIds: ["kb-policies"] }
  const result1 = makeRetrievalResult({ chunk: { id: "c1", documentId: "d1", content: "content1", childrenIds: [], metadata: {} } })
  const result2 = makeRetrievalResult({ chunk: { id: "c2", documentId: "d2", content: "content2", childrenIds: [], metadata: {} } })
  const evidence1 = buildEvidence([result1])
  const evidence2 = buildEvidence([result1, result2])
  // call 0 (initial): [result1]; call 1 (correction gap query): [result2]
  const searcher = makeFakeSearcher([
    { status: "ok", results: [result1], unavailableChannels: [] },
    { status: "ok", results: [result2], unavailableChannels: [] },
  ])
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator([
      { passed: false, hallucination: false, completeness: false, missingGap: "gap1" },
      { passed: true, hallucination: false, completeness: true },
    ]),
    replanner: makeFakeRePlanner([{ text: "gap query 1" }]),
    streamAnswerDraft: makeScriptedDraftStream([
      buildCitedAnswer(evidence1),
      buildCitedAnswer(evidence2),
    ]),
  })

  const output = await runner(makeRunnerInput({ retrievalScope }))

  assert.equal(output.status, "completed", "correction + regeneration + pass → completed")
  assert.ok(searcher.calls.length >= 2, "correction retrieval must run")
  for (const call of searcher.calls) {
    assert.deepEqual(
      call.options?.retrievalScope,
      retrievalScope,
      "a correction gap query must not escape the run's knowledge scope (Ticket 05, KB-03A)"
    )
  }
})

test("Ticket 07: correction retrieval reuses the locked scope object, never a recomputed one", async () => {
  const retrievalScope = { knowledgeBaseIds: ["kb-policies"] }
  const result1 = makeRetrievalResult({ chunk: { id: "c1", documentId: "d1", content: "content1", childrenIds: [], metadata: {} } })
  const result2 = makeRetrievalResult({ chunk: { id: "c2", documentId: "d2", content: "content2", childrenIds: [], metadata: {} } })
  const evidence1 = buildEvidence([result1])
  const evidence2 = buildEvidence([result1, result2])
  const searcher = makeFakeSearcher([
    { status: "ok", results: [result1], unavailableChannels: [] },
    { status: "ok", results: [result2], unavailableChannels: [] },
  ])
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator([
      { passed: false, hallucination: false, completeness: false, missingGap: "gap1" },
      { passed: true, hallucination: false, completeness: true },
    ]),
    replanner: makeFakeRePlanner([{ text: "gap query 1" }]),
    streamAnswerDraft: makeScriptedDraftStream([
      buildCitedAnswer(evidence1),
      buildCitedAnswer(evidence2),
    ]),
  })

  await runner(makeRunnerInput({ retrievalScope }))

  assert.ok(searcher.calls.length >= 2, "correction retrieval must run")
  for (const call of searcher.calls) {
    assert.equal(
      call.options?.retrievalScope,
      retrievalScope,
      "every search of the run must reference the ONE scope object resolved at the transport (Ticket 07, KB-03C)"
    )
  }
})

test("T11 #2 stable Evidence + bounded Context: evidence built + context assembled", async () => {
  const result1 = makeRetrievalResult({ chunk: { id: "c1", documentId: "d1", content: "content1", childrenIds: [], metadata: {} } })
  const result2 = makeRetrievalResult({ chunk: { id: "c2", documentId: "d2", content: "content2", childrenIds: [], metadata: {} }, source: "bm25" })
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [result1, result2],
    unavailableChannels: [],
  })
  let assembledResults: RetrievalResult[] | null = null
  const assembler: ContextAssembler = {
    async assemble(results: RetrievalResult[]): Promise<string> {
      assembledResults = results
      return "assembled context"
    },
  }
  const evidence = buildEvidence([result1, result2])
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler,
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
  })
  const output = await runner(makeRunnerInput())
  assert.ok(assembledResults !== null, "assembler.assemble must be called")
  assert.ok((assembledResults as RetrievalResult[] | null)!.length > 0, "assembler must receive results")
  assert.equal(output.contextTrace.evidenceCount, evidence.length, "contextTrace records evidence count")
  assert.equal(output.contextTrace.contextLength, "assembled context".length, "contextTrace records context length")
  assert.equal(output.retrievalTrace.selectedEvidenceIds?.length, evidence.length, "retrievalTrace records evidence ids")
})

// ---------------------------------------------------------------------------
// T11 #3 — Cannot complete without usable Evidence + valid Citation
// ---------------------------------------------------------------------------

test("T11 #3 empty retrieval results → insufficient_evidence (no_results)", async () => {
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [],
    unavailableChannels: [],
  })
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "insufficient_evidence", "empty results → insufficient_evidence (T11 #3)")
  assert.equal(output.degradation.reason, "no_results", "degradation reason must be no_results")
  assert.deepEqual(output.references, [], "no references without evidence")
})

test("T11 #3 validation passes but no cited claims → insufficient_evidence (no_cited_claims)", async () => {
  const result = makeRetrievalResult()
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [result],
    unavailableChannels: [],
  })
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    // Answer with NO citations → referencesForReply returns []
    streamAnswerDraft: makeScriptedDraftStream(["This is an answer without any citations."]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "insufficient_evidence", "no cited claims → insufficient_evidence (T11 #3)")
  assert.equal(output.degradation.reason, "no_cited_claims", "degradation reason must be no_cited_claims")
  assert.deepEqual(output.tokens, [], "rejected Draft tokens must never be publishable")
})

// ---------------------------------------------------------------------------
// T11 #4 — Unknown Citations + failed Critic rejected before publication
// ---------------------------------------------------------------------------

test("T11 #4 unknown citation in initial draft → invalid_citation", async () => {
  const result = makeRetrievalResult()
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [result],
    unavailableChannels: [],
  })
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    // Answer with UNKNOWN citation → referencesForReply throws
    streamAnswerDraft: makeScriptedDraftStream(["Answer with [cite:ev_unknown_id] citation."]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "invalid_citation", "unknown citation → invalid_citation (T11 #4)")
  // PL-01 AC04: 引用无效 publishes its own safe terminal text — the draft that
  // failed the citation check is never published, not even as an empty body.
  assert.equal(output.reply, "回答引用无法验证，请重试。")
  assert.ok(!output.reply.includes("[cite:"), "no citation marker may survive")
  assert.deepEqual(output.tokens, [], "invalid-citation Draft tokens must be withheld")
})

test("T11 #4 validation fail + replan exhausted → insufficient_evidence", async () => {
  const result = makeRetrievalResult()
  const evidence = buildEvidence([result])
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [result],
    unavailableChannels: [],
  })
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    // Validator fails on first round, passes never
    validator: makeFakeValidator([{ passed: false, hallucination: false, completeness: false, missingGap: "gap1" }]),
    // RePlanner returns empty gap queries → exhausted
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "insufficient_evidence", "validation fail + replan exhausted → insufficient_evidence (T11 #4)")
  assert.equal(output.degradation.reason, "coverage_not_met", "degradation reason must be coverage_not_met")
  assert.equal(output.validationTrace.passed, false, "validationTrace records failure")
  assert.deepEqual(output.tokens, [], "failed-validation Draft tokens must be withheld")
})

test("T11 #4 validation fail + replan exhausted + handoffStore → handoff_required", async () => {
  const result = makeRetrievalResult()
  const evidence = buildEvidence([result])
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [result],
    unavailableChannels: [],
  })
  const handoffStore = makeFakeHandoffStore()
  const conversationStore = makeFakeConversationStore()
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator([{ passed: false, hallucination: false, completeness: false, missingGap: "gap1" }]),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    conversationStore,
    handoffStore,
    resolveTenantId: (ctx) => ctx.tenantId,
  })
  const input = makeRunnerInput()
  const output = await runner(input)
  assert.equal(output.status, "handoff_required", "handoff enabled + exhausted → handoff_required (T11 #4/#6)")
  assert.equal(handoffStore.createdCases.length, 1, "handoffStore.create must be called once")
  assert.equal(handoffStore.createdCases[0].runId, input.runId, "handoff case records runId")
  assert.equal(handoffStore.createdCases[0].tenantId, input.accessContext.tenantId, "handoff case records tenantId")
  assert.equal(handoffStore.createdCases[0].subjectId, input.accessContext.subjectId, "handoff case records subjectId")
  assert.equal(handoffStore.createdCases[0].reasonCode, "insufficient_evidence", "handoff reason must be insufficient_evidence")
  assert.ok(handoffStore.createdCases[0].evidenceIds.length > 0, "handoff case records evidence ids")
})

test("T11 #4 validation fail + correction retrieval + regeneration + pass → completed", async () => {
  const result1 = makeRetrievalResult({ chunk: { id: "c1", documentId: "d1", content: "content1", childrenIds: [], metadata: {} } })
  const result2 = makeRetrievalResult({ chunk: { id: "c2", documentId: "d2", content: "content2", childrenIds: [], metadata: {} } })
  const evidence1 = buildEvidence([result1])
  const evidence2 = buildEvidence([result1, result2])
  // searcher returns different results on each call:
  // call 0 (initial): [result1]
  // call 1 (correction): [result2]
  const searcher = makeFakeSearcher([
    { status: "ok", results: [result1], unavailableChannels: [] },
    { status: "ok", results: [result2], unavailableChannels: [] },
  ])
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    // Validator fails on round 1, passes on round 2
    validator: makeFakeValidator([
      { passed: false, hallucination: false, completeness: false, missingGap: "gap1" },
      { passed: true, hallucination: false, completeness: true },
    ]),
    // RePlanner returns one gap query
    replanner: makeFakeRePlanner([{ text: "gap query 1" }]),
    // Draft stream: call 0 returns answer citing evidence1, call 1 returns answer citing evidence2
    streamAnswerDraft: makeScriptedDraftStream([
      buildCitedAnswer(evidence1),
      buildCitedAnswer(evidence2),
    ]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed", "correction + regeneration + pass → completed (T11 #4)")
  assert.equal(output.validationTrace.round, 2, "must reach round 2")
  assert.equal(output.validationTrace.passed, true, "round 2 must pass")
  assert.equal(searcher.calls.length, 2, "searcher called twice (initial + correction)")
})

test("T11 #4 3 rounds expired without approval → insufficient_evidence", async () => {
  const result = makeRetrievalResult()
  const evidence = buildEvidence([result])
  const searcher = makeFakeSearcher([
    { status: "ok", results: [result], unavailableChannels: [] },
    { status: "ok", results: [makeRetrievalResult({ chunk: { id: "c2", documentId: "d2", content: "c2", childrenIds: [], metadata: {} } })], unavailableChannels: [] },
    { status: "ok", results: [makeRetrievalResult({ chunk: { id: "c3", documentId: "d3", content: "c3", childrenIds: [], metadata: {} } })], unavailableChannels: [] },
  ])
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    // Validator always fails
    validator: makeFakeValidator([{ passed: false, hallucination: false, completeness: false, missingGap: "gap" }]),
    // RePlanner returns distinct gap queries for rounds 0+1, then a repeat on
    // round 2. Round 2 fail → replan returns the repeat → dedupe filters it
    // out → gapQueries exhausted → break with validationTrace.round = 3
    // (round index 2 + 1). This exercises the "3 rounds expired" path.
    replanner: makeFakeRePlanner([
      [{ text: "gap query 1" }],
      [{ text: "gap query 2" }],
      [{ text: "gap query 1" }],
    ]),
    streamAnswerDraft: makeScriptedDraftStream([
      buildCitedAnswer(evidence),
      buildCitedAnswer(evidence),
      buildCitedAnswer(evidence),
    ]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "insufficient_evidence", "3 rounds expired → insufficient_evidence (T11 #4)")
  assert.equal(output.validationTrace.round, 3, "must reach round 3")
  assert.equal(output.validationTrace.passed, false, "round 3 must fail")
})

// ---------------------------------------------------------------------------
// T11 #5 — Retrieval/model/validation/cancellation failures → terminal statuses
// ---------------------------------------------------------------------------

test("T11 #5 insufficient retrieval (all channels unavailable) → insufficient_retrieval", async () => {
  const searcher = makeFakeSearcher({
    status: "insufficient",
    results: [],
    unavailableChannels: ["vector", "bm25", "graph"],
  })
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "insufficient_retrieval", "all channels unavailable → insufficient_retrieval (T11 #5)")
  assert.ok(output.reply.includes("未检索到足够的可用资料"), "reply must contain insufficient retrieval message")
})

test("T11 #5 abort before route → AbortError", async () => {
  const abortController = new AbortController()
  abortController.abort()
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => makeFakeSearcher({ status: "ok", results: [], unavailableChannels: [] }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
  })
  await assert.rejects(
    () => runner(makeRunnerInput({ signal: abortController.signal })),
    (err: Error) => err.name === "AbortError",
    "pre-route abort must throw AbortError (T11 #5)"
  )
})

test("T11 #5 abort during retrieval → AbortError", async () => {
  const abortingSearcher: Searcher = {
    async search(): Promise<SearchOutcome> {
      const err = new Error("Retrieval aborted")
      err.name = "AbortError"
      throw err
    },
  }
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => abortingSearcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
  })
  await assert.rejects(
    () => runner(makeRunnerInput()),
    (err: Error) => err.name === "AbortError",
    "retrieval abort must throw AbortError (T11 #5)"
  )
})

test("T11 #5 abort during draft stream → AbortError", async () => {
  const result = makeRetrievalResult()
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [result],
    unavailableChannels: [],
  })
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeAbortingDraftStream(0),
  })
  await assert.rejects(
    () => runner(makeRunnerInput()),
    (err: Error) => err.name === "AbortError",
    "draft stream abort must throw AbortError (T11 #5)"
  )
})

// ---------------------------------------------------------------------------
// T11 #6 — Answer event/SSE/JSON/replay/Conversation/Handoff/Trace compatible
// ---------------------------------------------------------------------------

test("T11 #6 trace data populated: routeTrace/retrievalTrace/contextTrace/validationTrace", async () => {
  const result = makeRetrievalResult()
  const evidence = buildEvidence([result])
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [result],
    unavailableChannels: [],
  })
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler("context content here"),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.routeTrace.decision, "simple", "routeTrace.decision must be simple")
  assert.ok(output.retrievalTrace.resultCount !== undefined, "retrievalTrace.resultCount must be set")
  assert.ok(output.retrievalTrace.channelStatuses !== undefined, "retrievalTrace.channelStatuses must be set")
  assert.ok(output.retrievalTrace.selectedEvidenceIds !== undefined, "retrievalTrace.selectedEvidenceIds must be set")
  assert.equal(output.contextTrace.evidenceCount, evidence.length, "contextTrace.evidenceCount must be set")
  assert.equal(output.contextTrace.contextLength, "context content here".length, "contextTrace.contextLength must be set")
  assert.equal(output.validationTrace.round, 1, "validationTrace.round must be 1 (first round passed)")
  assert.equal(output.validationTrace.passed, true, "validationTrace.passed must be true")
})

test("T11 #6 save validated turns on completed (T10 #2 invariant)", async () => {
  const result = makeRetrievalResult()
  const evidence = buildEvidence([result])
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [result],
    unavailableChannels: [],
  })
  const conversationStore = makeFakeConversationStore()
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    conversationStore,
    resolveTenantId: (ctx) => ctx.tenantId,
  })
  const input = makeRunnerInput({ message: "What is the return policy?" })
  await runner(input)
  assert.equal(conversationStore.validatedTurns.length, 2, "must save user + assistant turns (T10 #2)")
  assert.equal(conversationStore.validatedTurns[0].role, "user", "first turn is user")
  assert.equal(conversationStore.validatedTurns[0].content, input.message, "user turn content is raw input.message")
  assert.equal(conversationStore.validatedTurns[1].role, "assistant", "second turn is assistant")
  assert.ok(conversationStore.validatedTurns[1].content.length > 0, "assistant turn content is the reply")
  assert.equal(conversationStore.validatedTurns[0].runId, input.runId, "turns record runId")
  assert.equal(conversationStore.validatedTurns[0].sessionId, input.sessionId, "turns record sessionId")
  assert.equal(conversationStore.validatedTurns[0].tenantId, input.accessContext.tenantId, "turns record tenantId")
})

test("T11 #6 NO save validated turns on non-completed (T10 #2 invariant)", async () => {
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [],
    unavailableChannels: [],
  })
  const conversationStore = makeFakeConversationStore()
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
    conversationStore,
    resolveTenantId: (ctx) => ctx.tenantId,
  })
  await runner(makeRunnerInput())
  assert.equal(conversationStore.validatedTurns.length, 0, "must NOT save turns on insufficient_evidence (T10 #2)")
})

test("T11 #6 memory loading + pending clarification consumption", async () => {
  const result = makeRetrievalResult()
  const evidence = buildEvidence([result])
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [result],
    unavailableChannels: [],
  })
  const conversationStore = makeFakeConversationStore({
    recentTurns: [
      { sessionId: "s1", tenantId: "t1", role: "user", content: "previous question", runId: "r1", createdAt: "2026-01-01T00:00:00Z" },
      { sessionId: "s1", tenantId: "t1", role: "assistant", content: "previous answer", runId: "r1", createdAt: "2026-01-01T00:00:00Z" },
    ],
  })
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    conversationStore,
    resolveTenantId: (ctx) => ctx.tenantId,
  })
  const input = makeRunnerInput()
  await runner(input)
  assert.ok(conversationStore.loadMemoryCalls.length > 0, "loadConversationMemory must be called")
  assert.equal(conversationStore.loadMemoryCalls[0].sessionId, input.sessionId, "loadMemory called with correct sessionId")
  assert.equal(conversationStore.loadMemoryCalls[0].tenantId, input.accessContext.tenantId, "loadMemory called with correct tenantId")
  assert.ok(conversationStore.pendingClarificationConsumed.length > 0, "consumePendingClarification must be called")
})

// ---------------------------------------------------------------------------
// T11 #7 — Runtime rollback returns route to legacy orchestrator
// ---------------------------------------------------------------------------

test("T11 #7 route not simple (direct) → RouteNotSimpleError", async () => {
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("direct"),
    createSearcher: () => makeFakeSearcher({ status: "ok", results: [], unavailableChannels: [] }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
  })
  await assert.rejects(
    () => runner(makeRunnerInput()),
    (err) => err instanceof RouteNotSimpleError,
    "direct route must throw RouteNotSimpleError (T11 #7)"
  )
})

test("T11 #7 route not simple (complex) → RouteNotSimpleError", async () => {
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => makeFakeSearcher({ status: "ok", results: [], unavailableChannels: [] }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
  })
  await assert.rejects(
    () => runner(makeRunnerInput()),
    (err) => err instanceof RouteNotSimpleError,
    "complex route must throw RouteNotSimpleError (T11 #7)"
  )
})

test("T11 #7 RouteNotSimpleError carries decision for dispatch layer", async () => {
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("ambiguous"),
    createSearcher: () => makeFakeSearcher({ status: "ok", results: [], unavailableChannels: [] }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
  })
  try {
    await runner(makeRunnerInput())
    assert.fail("should have thrown")
  } catch (err) {
    assert.ok(err instanceof RouteNotSimpleError)
    assert.equal((err as RouteNotSimpleError).decision, "ambiguous", "error carries decision for dispatch")
  }
})

test("P1 regression: a non-simple runner does not consume pending clarification", async () => {
  const conversationStore = makeFakeConversationStore()
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("direct"),
    createSearcher: () => makeFakeSearcher({ status: "ok", results: [], unavailableChannels: [] }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["unused"]),
    conversationStore,
    resolveTenantId: (ctx) => ctx.tenantId,
  })

  await assert.rejects(() => runner(makeRunnerInput()), RouteNotSimpleError)
  assert.equal(
    conversationStore.pendingClarificationConsumed.length,
    0,
    "route ownership must be confirmed before destructive clarification consumption"
  )
})

test("T11 #7 RouteNotSimpleError has correct name for boundary detection", async () => {
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("direct"),
    createSearcher: () => makeFakeSearcher({ status: "ok", results: [], unavailableChannels: [] }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
  })
  try {
    await runner(makeRunnerInput())
    assert.fail("should have thrown")
  } catch (err) {
    assert.equal((err as Error).name, "RouteNotSimpleError", "error name must be RouteNotSimpleError")
  }
})

// ---------------------------------------------------------------------------
// Eval refactor Ticket 01 #4 — final context observation. The retrieval trace
// must carry the ordered candidates of the FINAL actual generation context
// (committed only when that round's draft passes the citation check), with
// 1-based generation round numbers and evidence identity correlation.
// ---------------------------------------------------------------------------

test("Ticket 01 #4: initial draft accepted → finalContextCandidates ordered with evidence correlation at round 1", async () => {
  const result1 = makeRetrievalResult({
    chunk: { id: "c1", documentId: "d1", content: "content1", childrenIds: [], metadata: {} },
    score: 0.9,
    source: "vector",
  })
  const result2 = makeRetrievalResult({
    chunk: { id: "c2", documentId: "d2", content: "content2", childrenIds: [], metadata: {} },
    score: 0.7,
    source: "bm25",
  })
  const evidence = buildEvidence([result1, result2])
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => makeFakeSearcher({
      status: "ok",
      results: [result1, result2],
      unavailableChannels: [],
    }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed")
  const candidates = output.retrievalTrace.finalContextCandidates
  assert.ok(candidates, "finalContextCandidates must be recorded")
  assert.equal(candidates!.length, 2)
  // Rank is 1-based and follows the final context's ordered candidate list.
  assert.equal(candidates![0].rank, 1)
  assert.equal(candidates![0].documentId, "d1")
  assert.equal(candidates![0].chunkId, "c1")
  assert.equal(candidates![0].score, 0.9)
  assert.deepEqual(candidates![0].channels, ["vector"])
  assert.equal(candidates![1].rank, 2)
  assert.equal(candidates![1].documentId, "d2")
  assert.deepEqual(candidates![1].channels, ["bm25"])
  // Each observed candidate correlates its stable evidence identity.
  assert.equal(candidates![0].evidenceId, evidence[0].id)
  assert.equal(candidates![1].evidenceId, evidence[1].id)
  // 1-based generation round: 1 = the initial accepted draft.
  assert.equal(output.retrievalTrace.finalContextRound, 1)
})

test("Ticket 01 #4: correction round accepted → finalContextCandidates reflect the merged correction context at round 2", async () => {
  const result1 = makeRetrievalResult({
    chunk: { id: "c1", documentId: "d1", content: "content1", childrenIds: [], metadata: {} },
  })
  const result2 = makeRetrievalResult({
    chunk: { id: "c2", documentId: "d2", content: "content2", childrenIds: [], metadata: {} },
  })
  const evidence1 = buildEvidence([result1])
  const evidence2 = buildEvidence([result1, result2])
  const searcher = makeFakeSearcher([
    { status: "ok", results: [result1], unavailableChannels: [] },
    { status: "ok", results: [result2], unavailableChannels: [] },
  ])
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator([
      { passed: false, hallucination: false, completeness: false, missingGap: "gap1" },
      { passed: true, hallucination: false, completeness: true },
    ]),
    replanner: makeFakeRePlanner([{ text: "gap query 1" }]),
    // One draft per stream call: call 0 (initial) cites evidence1's chunk;
    // call 1 (regen) cites the rebuilt merged evidence's first chunk.
    streamAnswerDraft: makeScriptedDraftStream([
      [buildCitedAnswer(evidence1)],
      [buildCitedAnswer(evidence2)],
    ]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed")
  // The published reply came from the round-2 (correction) context: the
  // observed candidates must be that round's merged, deduplicated list —
  // NOT the round-1 initial selection and NOT the reference list of the
  // reply (which contains only the cited subset).
  assert.equal(output.retrievalTrace.finalContextRound, 2)
  const candidates = output.retrievalTrace.finalContextCandidates
  assert.ok(candidates)
  assert.deepEqual(
    candidates!.map((c) => `${c.rank}:${c.documentId}/${c.chunkId}`),
    ["1:d2/c2", "2:d1/c1"],
    "correction round candidates must be the gap-first merged context (PT-04: this round's 补检 hit leads, the older result fills the rest), not the reply reference list"
  )
  // PT-04 AC09: the merged list is a runner-side selection across two
  // retrievals, so it is reported as an aggregation — never as a
  // dedicated-rerank success (see the dedicated PT-04:AC09 regression below,
  // which wires a `dedicated_rerank` correction outcome to prove the point).
  assert.deepEqual(output.retrievalTrace.finalContextOrdering, {
    source: "fused",
    reason: "multi_query_aggregation",
  })
})

test("Ticket 01 #4: correction regen citation fails → observation stays on the published (initial) round", async () => {
  const result1 = makeRetrievalResult({
    chunk: { id: "c1", documentId: "d1", content: "content1", childrenIds: [], metadata: {} },
  })
  const result2 = makeRetrievalResult({
    chunk: { id: "c2", documentId: "d2", content: "content2", childrenIds: [], metadata: {} },
  })
  const evidence1 = buildEvidence([result1])
  const searcher = makeFakeSearcher([
    { status: "ok", results: [result1], unavailableChannels: [] },
    { status: "ok", results: [result2], unavailableChannels: [] },
  ])
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    // Initial validation fails → correction round runs; the regenerated draft
    // cites an UNKNOWN evidence id → citation check fails → the runner
    // degrades to publishing the initial (already-cited) draft.
    validator: makeFakeValidator([
      { passed: false, hallucination: false, completeness: false, missingGap: "gap1" },
    ]),
    replanner: makeFakeRePlanner([{ text: "gap query 1" }]),
    // Draft stream: call 0 (initial) returns the valid answer citing
    // evidence1; call 1 (regen) cites an UNKNOWN evidence id.
    streamAnswerDraft: makeScriptedDraftStream([
      [buildCitedAnswer(evidence1)],
      ["broken regen [cite:ev_unknown_deadbeef0000]"],
    ]),
  })
  const output = await runner(makeRunnerInput())
  // PL-01: an invalid-citation terminal publishes neither the rejected regen
  // draft nor the previously cited initial draft — no facts, no citations.
  assert.equal(output.status, "invalid_citation")
  assert.equal(output.reply, "回答引用无法验证，请重试。")
  assert.ok(!output.reply.includes("[cite:"), "published reply must carry no draft citations")
  assert.deepEqual(output.references, [], "no references may survive a rejected draft")
  // The published reply came from the INITIAL context — the observation must
  // stay on round 1's candidates and must NOT point at the correction round
  // context whose draft was rejected.
  assert.equal(output.retrievalTrace.finalContextRound, 1)
  const candidates = output.retrievalTrace.finalContextCandidates
  assert.ok(candidates)
  assert.deepEqual(
    candidates!.map((c) => `${c.rank}:${c.documentId}/${c.chunkId}`),
    ["1:d1/c1"],
    "observation must reflect the published round, not the rejected correction context"
  )
})

// ---------------------------------------------------------------------------
// PT-04 — the correction (补检) gap-first evidence selection on the simple route
//
// Shared fixture, converted from the audited reproduction
// `F3_correction_new_evidence_starved` in
// `.scratch/pipeline-structure-audit-2026-10-08/reproduce.cjs`. That script
// asserted the defect (the fresh fact absent from EVERY generation prompt while
// still present in `finalContextCandidates`); these tests assert the opposite,
// with the REAL default `ContextAssemblerImpl` (6,000 / 4,500) and the REAL
// tokenizer, because the fake assembler cannot show what actually reached the
// model. Before PT-04 the gap results were appended to the TAIL of the
// accumulated array, the assembler walked its groups in insertion order with a
// shrinking budget, and the old top-10 parent chunks ate all 6,000 tokens.
// ---------------------------------------------------------------------------

const FRESH_GAP_FACT = "新增关键例外：特定商品不可退款。"
const OLD_SNIPPET = "旧规则：标准商品七日退款。"

function makeGapChild(id: string, content: string): RetrievalResult {
  return {
    chunk: {
      id,
      documentId: `doc-${id}`,
      content,
      childrenIds: [],
      metadata: { kind: "child", source: `source-${id}`, title: id },
    },
    source: "vector",
    score: 0.9,
    wikilinks: [],
  }
}

/** One old top-10 member: a small child inside a parent far larger than the budget. */
function makeOldParentResult(id: string, filler: string): RetrievalResult {
  const result = makeGapChild(id, "旧资料".repeat(40))
  result.parentChunk = {
    ...result.chunk,
    id: `parent-${id}`,
    content: `${result.chunk.content}${filler.repeat(5_000)}`,
    metadata: { kind: "parent", source: `old-parent-${id}` },
  }
  return result
}

function makeOldTop10(): RetrievalResult[] {
  return [
    makeOldParentResult("old", "甲"),
    ...Array.from({ length: 9 }, (_, index) =>
      makeOldParentResult(`old-${index}`, "乙")
    ),
  ]
}

/**
 * The scripted searcher reports what a real dedicated reranker reports, so
 * AC09 can check the runner never launders that label through a gap-first merge.
 */
function makeRerankedOutcome(results: RetrievalResult[]): SearchOutcome {
  return {
    status: "ok",
    results,
    unavailableChannels: [],
    ordering: { source: "dedicated_rerank" },
  }
}

/** Captures the actual `streamAnswerDraft(messages)` payload of every round. */
function makePromptCapturingDraft(replies: string[]) {
  const prompts: string[] = []
  let callIndex = 0
  const stream = async function* capturingDraft(
    messages: AgentMessage[]
  ): AsyncGenerator<string> {
    const index = callIndex
    callIndex += 1
    prompts.push(messages[messages.length - 1].content)
    yield replies[Math.min(index, replies.length - 1)]
  }
  return { stream, prompts, get calls(): number { return callIndex } }
}

/** The context portion of a generation prompt (the `用户问题` tail is not context). */
function contextOf(prompt: string): string {
  const at = prompt.lastIndexOf("\n\n用户问题：")
  return at < 0 ? prompt : prompt.slice(0, at)
}

function makeFakeCompressor(
  build: (evidence: Evidence[]) => ContextCompressionResult | null
): ContextCompressor & { calls: number } {
  let callsCount = 0
  const compressor = {
    get calls(): number {
      return callsCount
    },
    async compress(
      evidence: Evidence[],
      _query: string,
      _budget: { maxContextTokens: number }
    ): Promise<ContextCompressionResult | null> {
      callsCount += 1
      return build(evidence)
    },
  }
  return compressor as unknown as ContextCompressor & { calls: number }
}

function compressedBlock(evidenceIds: string[], body: string): ContextCompressionResult {
  const context = ["以下是从知识库中找到的相关文档片段：", ...evidenceIds.map((id) => `[cite:${id}] [来源: compressed.md]`), body].join("\n")
  return {
    context,
    tokenCount: context.length,
    retainedEvidenceIds: evidenceIds,
    droppedEvidenceIds: [],
    inputTokens: 9_000,
    outputTokens: 400,
  }
}

interface GapFixture {
  searcher: ReturnType<typeof makeFakeSearcher>
  draft: ReturnType<typeof makePromptCapturingDraft>
  oldId: string
  freshId: string
  output: Promise<MastraRunnerOutput>
}

function runGapStarvationFixture(options: {
  gapOutcomes?: SearchOutcome[]
  oldResults?: RetrievalResult[]
  replies?: string[]
  compressor?: ContextCompressor
  verdicts?: CriticVerdict[]
  gapQueries?: Query[][]
} = {}): GapFixture {
  const oldResults = options.oldResults ?? makeOldTop10()
  const fresh = makeGapChild("new", FRESH_GAP_FACT)
  const gapOutcomes = options.gapOutcomes ?? [makeRerankedOutcome([fresh])]
  const searcher = makeFakeSearcher([
    makeRerankedOutcome(oldResults),
    ...gapOutcomes,
  ])
  const oldId = buildEvidence([oldResults[0]])[0].id
  const freshId = buildEvidence([fresh])[0].id
  const draft = makePromptCapturingDraft(
    options.replies ?? [
      `旧资料 [cite:${oldId}]`,
      `新增例外 [cite:${freshId}]，旧资料 [cite:${oldId}]`,
    ]
  )
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    // REAL default assembler + REAL tokenizer: the point of the ticket is what
    // the generated prompt contains, not what a stub returns.
    assembler: new ContextAssemblerImpl(),
    validator: makeFakeValidator(
      options.verdicts ?? [
        { passed: false, hallucination: false, completeness: false, missingGap: "查询关键例外" },
        { passed: true, hallucination: false, completeness: true },
      ]
    ),
    replanner: makeFakeRePlanner(
      options.gapQueries ?? [[{ text: "特定商品 不可退款 例外" }]]
    ),
    streamAnswerDraft: draft.stream,
    ...(options.compressor ? { compressor: options.compressor } : {}),
  })
  return {
    searcher,
    draft,
    oldId,
    freshId,
    output: runner(makeRunnerInput({ message: "比较资料中的退款规则与例外" })),
  }
}

test("PT-04 fixture guard: the audited tail-append order really does starve the new fact", async () => {
  // Why this regression had to change the ORDER and not the budget: with the
  // pre-PT-04 candidate order (old top-10 first, gap hit appended at the tail)
  // the unchanged 6,000-token budget leaves the fresh fact nothing at all, even
  // though a real reranker scored the gap search. Proves the positive tests
  // below are not vacuous.
  const oldResults = makeOldTop10()
  const fresh = makeGapChild("new", FRESH_GAP_FACT)
  const tailAppended = [...oldResults, fresh]
  const starved = await new ContextAssemblerImpl().assemble(
    tailAppended,
    citationIdsByChunk(buildEvidence(tailAppended))
  )
  assert.equal(starved.includes(FRESH_GAP_FACT), false, "old order must starve the gap fact")
  assert.ok(modelTokenCount(starved) <= 6_000, "the budget itself was never the problem")

  const gapFirst = [fresh, ...oldResults]
  const selected = await new ContextAssemblerImpl().assemble(
    gapFirst,
    citationIdsByChunk(buildEvidence(gapFirst))
  )
  assert.ok(selected.includes(FRESH_GAP_FACT), "gap-first selection admits the new fact")
  assert.ok(modelTokenCount(selected) <= 6_000, "without raising any budget")
})

test("PT-04 AC01/AC02: the 补检 exception reaches the second generation prompt", async () => {
  const fixture = runGapStarvationFixture()
  const output = await fixture.output

  assert.equal(output.status, "completed")
  assert.equal(fixture.searcher.calls.length, 2, "one initial search + one gap search: no extra correction round")
  assert.equal(fixture.draft.calls, 2, "no extra generation call and no model rerank step")
  assert.equal(fixture.draft.prompts.length, 2)
  assert.equal(
    fixture.draft.prompts[0].includes(FRESH_GAP_FACT),
    false,
    "the gap was real: round 1 could not already contain the exception"
  )
  // The behaviour, observed where it matters: the actual generation input.
  assert.ok(
    fixture.draft.prompts[1].includes(FRESH_GAP_FACT),
    "PT-04: the fresh fact must be in the second prompt, not only in finalContextCandidates"
  )
  assert.ok(
    fixture.draft.prompts[1].includes(`[cite:${fixture.freshId}]`),
    "the fresh fact arrives with its stable citation identity"
  )
  assert.ok(
    fixture.draft.prompts[1].includes("旧资料"),
    "the remaining budget still fills with the older material"
  )
  // AC01's other half: the candidates still report it, now at the front.
  const candidates = output.retrievalTrace.finalContextCandidates!
  assert.equal(candidates[0].chunkId, "new")
  assert.equal(candidates[0].evidenceId, fixture.freshId)
  assert.equal(output.retrievalTrace.finalContextRound, 2)
})

test("PT-04 AC03: the correction prompt stays inside the unchanged budget, headers and citations counted", async () => {
  const fixture = runGapStarvationFixture()
  const output = await fixture.output
  assert.equal(output.status, "completed")

  for (const [index, prompt] of fixture.draft.prompts.entries()) {
    const context = contextOf(prompt)
    assert.ok(
      modelTokenCount(context) <= 6_000,
      `generation round ${index + 1} must not exceed the configured 6,000-token total`
    )
    // Headers, citations and the fixed framing text are inside the counted
    // context, and the per-parent cap is what makes them fit.
    assert.ok(context.startsWith("以下是从知识库中找到的相关文档片段"), "fixed intro counted")
    assert.ok(context.includes("请基于以上文档片段回答用户的问题"), "fixed suffix counted")
    assert.ok(context.includes("[来源:"), "per-group headers counted")
    assert.ok(context.includes("[cite:"), "citation markers counted")
  }
})

test("PT-04 AC04: a gap snippet sharing a parent keeps the new window and the parent is framed once", async () => {
  // The gap hit and an older hit share ONE parent chunk. The shared group must
  // carry the new snippet (the gap match is seen first) and must not be framed
  // — or paid for — twice.
  const sharedParentContent = `${"甲".repeat(3_000)}${OLD_SNIPPET}${"乙".repeat(3_000)}${FRESH_GAP_FACT}`
  const oldShared = makeGapChild("old-shared", OLD_SNIPPET)
  oldShared.chunk.documentId = "doc-shared"
  oldShared.parentChunk = {
    id: "parent-shared",
    documentId: "doc-shared",
    content: sharedParentContent,
    childrenIds: [],
    metadata: { kind: "parent", source: "shared-parent" },
  }
  const gapShared = makeGapChild("new-shared", FRESH_GAP_FACT)
  gapShared.chunk.documentId = "doc-shared"
  gapShared.parentChunk = oldShared.parentChunk

  const oldResults = [oldShared, ...makeOldTop10()]
  const freshEvidenceId = buildEvidence([gapShared])[0].id
  const oldId = buildEvidence([oldResults[1]])[0].id
  const fixture = runGapStarvationFixture({
    oldResults,
    gapOutcomes: [makeRerankedOutcome([gapShared])],
    replies: [`旧资料 [cite:${oldId}]`, `新增例外 [cite:${freshEvidenceId}]`],
  })
  const output = await fixture.output

  assert.equal(output.status, "completed")
  const secondPrompt = fixture.draft.prompts[1]
  assert.ok(secondPrompt.includes(FRESH_GAP_FACT), "the new gap snippet survives in the shared parent window")
  assert.ok(secondPrompt.includes(`[cite:${freshEvidenceId}]`), "the shared group cites the new snippet")
  assert.equal(
    secondPrompt.match(/来源: shared-parent/g)?.length,
    1,
    "one shared parent is framed once: a repeated identity never consumes budget twice"
  )
})

test("PT-04 AC05: repeated identities are chosen once, citations stay stable, multi-gap order replays", async () => {
  const oldResults = makeOldTop10()
  const freshA = makeGapChild("new-a", FRESH_GAP_FACT)
  const freshB = makeGapChild("new-b", "新增时效例外：定制商品退款需人工审核。")
  // The second gap query re-hits an OLD chunk: same identity, different channel.
  const duplicateOld = { ...oldResults[3], channels: ["bm25"] as RetrievalResult["source"][] }
  const freshAId = buildEvidence([freshA])[0].id
  const freshBId = buildEvidence([freshB])[0].id
  const oldId = buildEvidence([oldResults[0]])[0].id
  const fixture = runGapStarvationFixture({
    gapOutcomes: [makeRerankedOutcome([freshA]), makeRerankedOutcome([freshB, duplicateOld])],
    gapQueries: [[{ text: "特定商品 不可退款 例外" }, { text: "定制 商品 人工审核" }]],
    replies: [
      `旧资料 [cite:${oldId}]`,
      `新增例外 [cite:${freshAId}] 与 [cite:${freshBId}]`,
    ],
  })
  const output = await fixture.output
  assert.equal(output.status, "completed")

  const candidates = output.retrievalTrace.finalContextCandidates!
  const identities = candidates.map((c) => `${c.documentId}\0${c.chunkId}`)
  assert.equal(new Set(identities).size, identities.length, "no identity is offered to the assembler twice")
  assert.equal(identities.length, 12, "10 older chunks + 2 new facts + the re-hit that collapses onto an existing identity")
  assert.deepEqual(
    candidates.slice(0, 2).map((c) => c.chunkId),
    ["new-a", "new-b"],
    "both gap facts lead, in gap-query order"
  )
  assert.equal(output.contextTrace.evidenceCount, 12, "Evidence dedups the same identity without double-counting it")
  // Stable identity → stable citation across rounds.
  const freshCandidate = candidates.find((c) => c.chunkId === "new-a")!
  assert.equal(freshCandidate.evidenceId, freshAId)
  assert.ok(
    output.references.some((reference) => reference.id === freshCandidate.evidenceId),
    "the published reference reuses the same evidence identity the round-1 candidates carry"
  )

  // Deterministic and replayable: the same inputs produce the same prompt.
  const replay = runGapStarvationFixture({
    gapOutcomes: [makeRerankedOutcome([freshA]), makeRerankedOutcome([freshB, duplicateOld])],
    gapQueries: [[{ text: "特定商品 不可退款 例外" }, { text: "定制 商品 人工审核" }]],
    replies: [
      `旧资料 [cite:${oldId}]`,
      `新增例外 [cite:${freshAId}] 与 [cite:${freshBId}]`,
    ],
  })
  await replay.output
  assert.deepEqual(replay.draft.prompts, fixture.draft.prompts, "the selection replays byte-for-byte")
})

test("PT-04 AC06: a gap fact too long for the budget is recorded as an omission and never claims coverage", async () => {
  const monster = makeGapChild("monster", "缺".repeat(8_000))
  const fresh = makeGapChild("new", FRESH_GAP_FACT)
  const oldId = buildEvidence([makeOldTop10()[0]])[0].id
  const fixture = runGapStarvationFixture({
    gapOutcomes: [makeRerankedOutcome([monster, fresh])],
    replies: [`旧资料 [cite:${oldId}]`, `旧资料 [cite:${oldId}]`],
    // The Critic still rejects the regenerated draft: the run degrades by the
    // EXISTING rules, the omission record does not gate it.
    verdicts: [
      { passed: false, hallucination: false, completeness: false, missingGap: "查询关键例外" },
      { passed: false, hallucination: false, completeness: false, missingGap: "查询关键例外" },
    ],
    gapQueries: [[{ text: "特定商品 不可退款 例外" }], []],
  })
  const output = await fixture.output

  assert.equal(output.status, "insufficient_evidence", "the existing validation rules still decide the terminal")
  assert.equal(output.validationTrace.passed, false)
  assert.deepEqual(output.references, [], "no coverage claim survives")
  const omissions = output.contextTrace.gapFactOmissions
  assert.ok(omissions && omissions.length === 1, "the un-fittable gap fact is recorded explicitly")
  assert.equal(omissions![0].chunkId, "monster")
  assert.equal(omissions![0].reason, "context_budget")
  assert.equal(
    omissions![0].evidenceId,
    buildEvidence([monster])[0].id,
    "the omission names the same stable identity a citation would"
  )
  assert.ok(
    fixture.draft.prompts[1].includes(FRESH_GAP_FACT),
    "an oversized gap hit does not displace the other new facts it shares the round with"
  )
})

test("PT-04 AC07: compression keeps the selected new fact; a compressed context that lost it does not close the round", async () => {
  const oldResults = makeOldTop10()
  const fresh = makeGapChild("new", FRESH_GAP_FACT)
  const freshId = buildEvidence([fresh])[0].id
  const oldId = buildEvidence([oldResults[0]])[0].id

  // (a) the compression carried the selected fact's own wording → adopted with
  // nothing to report.
  const retained = runGapStarvationFixture({
    compressor: makeFakeCompressor((evidence) =>
      compressedBlock(
        evidence.map(({ id }) => id),
        `压缩摘要：七日退款规则如下。${FRESH_GAP_FACT}`
      )
    ),
  })
  const retainedOutput = await retained.output
  assert.equal(retainedOutput.status, "completed")
  assert.equal(retainedOutput.contextTrace.compressionRan, true)
  assert.equal(retainedOutput.contextTrace.compressionRejectedForGapLoss, undefined)
  assert.equal(retainedOutput.contextTrace.gapFactOmissions, undefined)
  assert.ok(
    retained.draft.prompts[1].includes(`[cite:${freshId}]`),
    "the compressed context carries the selected new fact's identity into the prompt"
  )
  assert.ok(retained.draft.prompts[1].includes("压缩摘要"), "compressed output is what generated")

  // (a2) an adopted compression that keeps only the citation identity is
  // lineage, not proof of wording. The adoption rule cannot tell the two apart,
  // so the record must say the selected fact is not literally present rather
  // than let anyone read the correction as closed.
  const reworded = runGapStarvationFixture({
    compressor: makeFakeCompressor((evidence) =>
      compressedBlock(evidence.map(({ id }) => id), "压缩摘要：七日退款与例外。")
    ),
  })
  const rewordedOutput = await reworded.output
  assert.equal(rewordedOutput.contextTrace.compressionRan, true)
  const compressionOmissions = rewordedOutput.contextTrace.gapFactOmissions ?? []
  assert.ok(
    compressionOmissions.some(
      (omission) =>
        omission.reason === "compression" &&
        (omission as { evidenceId?: string }).evidenceId === freshId
    ),
    `lineage-only adoption must be recorded as unverified coverage, got ${JSON.stringify(compressionOmissions)}`
  )
  assert.ok(
    reworded.draft.prompts[1].includes(`[cite:${freshId}]`),
    "and the run still generated from the adopted compressed context"
  )

  // (b) compression dropped the fact → the round generates from the
  // deterministic context instead, and the loss is recorded.
  const dropper = runGapStarvationFixture({
    compressor: makeFakeCompressor(() =>
      compressedBlock([oldId], "压缩摘要：只有旧规则。")
    ),
  })
  const droppedOutput = await dropper.output
  assert.equal(droppedOutput.contextTrace.compressionRan, false, "a lossy compression is not a closed correction round")
  assert.equal(droppedOutput.contextTrace.compressionRejectedForGapLoss, true)
  assert.ok(
    dropper.draft.prompts[1].includes(FRESH_GAP_FACT),
    "the selected new fact still reaches the prompt through the deterministic context"
  )
  assert.equal(dropper.draft.prompts[1].includes("只有旧规则"), false, "the lossy compressed output is not used")

  // (c) compression failure fallback keeps the fact too.
  const throwing = runGapStarvationFixture({
    compressor: {
      async compress(): Promise<ContextCompressionResult | null> {
        throw new Error("provider blew up")
      },
    },
  })
  const fallbackOutput = await throwing.output
  assert.equal(fallbackOutput.contextTrace.compressionRan, false)
  assert.ok(
    throwing.draft.prompts[1].includes(FRESH_GAP_FACT),
    "the compression-failure fallback retains the selected new facts"
  )
})

test("PT-04 AC08: no new evidence, provider failure and scope stay bounded; nothing claims a correction", async () => {
  // (a) the gap search found nothing new.
  const empty = runGapStarvationFixture({ gapOutcomes: [makeRerankedOutcome([])] })
  const emptyOutput = await empty.output
  assert.equal(emptyOutput.status, "insufficient_evidence")
  assert.equal(empty.searcher.calls.length, 2, "no further correction searches after the empty gap")
  assert.equal(empty.draft.calls, 1, "no regeneration was claimed for a correction that produced nothing")
  assert.equal(emptyOutput.contextTrace.gapFactOmissions, undefined, "an empty 补检 may not report gap coverage")
  assert.equal(emptyOutput.retrievalTrace.finalContextRound, 1)
  assert.deepEqual(emptyOutput.references, [])

  // (b) the gap search itself failed: still bounded, and the locked scope of
  // the run is what the 补检 reads — a retry never widens it.
  const retrievalScope = { knowledgeBaseIds: ["kb-policies"] }
  const calls: Array<{ query: Query; options?: SearchOptions }> = []
  const failingSearcher: Searcher & { calls: typeof calls } = {
    calls,
    async search(query: Query, options?: SearchOptions): Promise<SearchOutcome> {
      calls.push({ query, options })
      if (calls.length > 1) throw new Error("provider unavailable")
      return makeRerankedOutcome(makeOldTop10())
    },
  }
  const oldId = buildEvidence([makeOldTop10()[0]])[0].id
  const draft = makePromptCapturingDraft([`旧资料 [cite:${oldId}]`])
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => failingSearcher,
    assembler: new ContextAssemblerImpl(),
    validator: makeFakeValidator({ passed: false, hallucination: false, completeness: false, missingGap: "查询关键例外" }),
    replanner: makeFakeRePlanner([[{ text: "特定商品 不可退款 例外" }]]),
    streamAnswerDraft: draft.stream,
  })
  await assert.rejects(
    () => runner(makeRunnerInput({ message: "比较资料中的退款规则与例外", retrievalScope })),
    /provider unavailable/
  )
  assert.equal(failingSearcher.calls.length, 2, "one initial search + one gap search, then the run stops")
  assert.equal(draft.calls, 1, "a failed 补检 never regenerates")
  for (const call of failingSearcher.calls) {
    assert.equal(call.options?.retrievalScope, retrievalScope, "the gap-first retry never widens the read")
  }
})

test("PT-04 AC09: gap-first selection is labelled as an aggregation, a lone search keeps its own honest label", async () => {
  const merged = runGapStarvationFixture()
  const mergedOutput = await merged.output
  assert.equal(mergedOutput.status, "completed")
  // Both contributing searches reported `dedicated_rerank`, but the published
  // order is the runner's gap-first merge — so it must not be labelled one.
  assert.notEqual(mergedOutput.retrievalTrace.finalContextOrdering?.source, "dedicated_rerank")
  assert.deepEqual(mergedOutput.retrievalTrace.finalContextOrdering, {
    source: "fused",
    reason: "multi_query_aggregation",
  })

  // The untouched case: a single accepted search keeps its own label.
  const oldResults = makeOldTop10()
  const oldId = buildEvidence([oldResults[0]])[0].id
  const passthrough = runGapStarvationFixture({
    gapOutcomes: [makeRerankedOutcome([])],
    replies: [`旧资料 [cite:${oldId}]`],
    verdicts: [{ passed: true, hallucination: false, completeness: true }],
    gapQueries: [[]],
  })
  const passthroughOutput = await passthrough.output
  assert.equal(passthroughOutput.status, "completed")
  assert.deepEqual(passthroughOutput.retrievalTrace.finalContextOrdering, {
    source: "dedicated_rerank",
  })
})

// ---------------------------------------------------------------------------
// Reasoning effort: the frozen run choice must reach the initial draft AND a
// forced correction rewrite; retrieval rounds never change with the level.
// ---------------------------------------------------------------------------

test("the reasoning effort reaches the simple draft and its correction rewrite unchanged", async () => {
  async function run(effort?: "high") {
    const oldResult = makeRetrievalResult()
    const gapResult = makeRetrievalResult({
      chunk: { id: "gap", documentId: "gap-doc", content: "New evidence", childrenIds: [], metadata: {} },
    })
    const oldEvidence = buildEvidence([oldResult])
    const gapEvidence = buildEvidence([gapResult])
    const searcher = makeFakeSearcher([
      { status: "ok", results: [oldResult], unavailableChannels: [] },
      { status: "ok", results: [gapResult], unavailableChannels: [] },
    ])
    const validator = makeFakeValidator([
      { passed: false, hallucination: false, completeness: false, answerBasis: { text: "第一轮不能公开", referenceIds: [oldEvidence[0].id] } },
      { passed: true, hallucination: false, completeness: true, answerBasis: { text: "第二轮依据新增资料。", referenceIds: [gapEvidence[0].id] } },
    ])
    const received: unknown[] = []
    let call = 0
    const draft = async function* (
      _messages: AgentMessage[],
      _signal: AbortSignal,
      options?: { reasoningEffort?: "low" | "high" | "max" }
    ): AsyncGenerator<string> {
      received.push(options)
      const evidence = call === 0 ? oldEvidence : gapEvidence
      call += 1
      yield buildCitedAnswer(evidence)
    }
    const runner = createSimpleKnowledgeMastraRunner({
      router: makeFakeRouter("simple"),
      createSearcher: () => searcher,
      assembler: makeFakeAssembler(),
      validator,
      replanner: makeFakeRePlanner([{ text: "missing detail" }]),
      streamAnswerDraft: draft,
    })
    const output = await runner(makeRunnerInput(effort ? { reasoningEffort: effort } : {}))
    assert.equal(output.status, "completed")
    return { received, searches: searcher.calls.length }
  }

  const withEffort = await run("high")
  assert.deepEqual(withEffort.received, [{ reasoningEffort: "high" }, { reasoningEffort: "high" }])
  assert.equal(withEffort.searches, 2, "one initial retrieval and one correction retrieval")

  const omitted = await run()
  assert.deepEqual(omitted.received, [undefined, undefined])
  assert.equal(omitted.searches, withEffort.searches, "the level never changes retrieval rounds")
})
