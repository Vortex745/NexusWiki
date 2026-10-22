/**
 * Ticket 12 — Complex knowledge route Mastra runner tests.
 *
 * TDD test suite for `src/mastra/complex_knowledge_runner.ts`. Verifies the
 * MastraRunner contract for the complex knowledge route: dual-path retrieval
 * (runComplexLoop OR planner.decompose) → Evidence → Context → answer Draft →
 * Citation check → Critic validation loop (with correction-round budget
 * reuse) → publish / handoff.
 *
 * Coverage map (T12 acceptance criteria):
 *   #1 Complex requests preserve query decomposition, coverage criteria, and
 *      bounded retrieval-tool selection
 *      → planner path test (decompose + coverage criteria)
 *      → loop path test (bounded tool selection)
 *   #2 Tools delegate to existing authorized retrieval channels
 *      → accessContext propagation tests (loop + planner paths)
 *   #3 Iteration, tool-call, token, and duration budgets stop runaway loops
 *      → iteration budget test (loop stops at 3 iterations)
 *      → correction-round shared budget test
 *   #4 Correction rounds rebuild one coherent candidate from all accumulated
 *      authorized Evidence
 *      → correction accumulates results + rebuilds evidence + regenerates draft
 *   #5 Duplicate or malformed tool calls fail safely and use the approved
 *      deterministic fallback
 *      → duplicate tool call skipped without backend execution
 *      → correction loop 0 new results → deterministic searcher.search fallback
 *   #6 Cancellation stops active tools and prevents late observations/drafts
 *      → abort before route / during draft stream tests
 *   #7 Every path converges to one existing compatible terminal event
 *      → happy path (loop + planner) / insufficient_retrieval /
 *        invalid_citation / handoff_required / insufficient_evidence /
 *        provider_error / RouteNotComplexError / no-deps provider_error tests
 *
 * Boundary: this test file is owned by `src/mastra/*` and MUST NOT import
 * `src/api/*` or `src/index` (T02 #5 dependency direction).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createComplexKnowledgeMastraRunner,
  RouteNotComplexError,
} from "./complex_knowledge_runner"
// PT-05 shares its gap-first (补检优先) selection rule with the simple route, so
// one test asserts both routes apply the SAME rule.
import { createSimpleKnowledgeMastraRunner } from "./simple_knowledge_runner"
import { buildEvidence } from "../answer/evidence"
import { openDb } from "../ingestion/tracking/db"
import { createIngestionLifecycle } from "../ingestion/pipeline"
import { SessionAttachmentService } from "../attachments/session_attachment_service"
import { SqliteSessionAttachmentStore } from "../attachments/session_attachment_store"
// PT-07 — the shared material contract the complex route is being migrated onto.
import {
  CONTEXT_INTRO,
  ContextAssemblerImpl,
  TEMPORARY_CONTEXT_NOTE,
  modelTokenCount,
} from "../retrieval/context/assembler"
import { computeContextBudget } from "../retrieval/context/budget"
import { previewContextBudget } from "../answer/context_pipeline"
import { ContextCompressorImpl } from "../answer/context_compressor"
import { PROVIDER_ERROR_MESSAGE } from "../answer/terminal_copy"
import { RuntimeSearchOperations, SearcherImpl } from "../retrieval/search/searcher"
import { createWebEvidenceOperations } from "../web/web_evidence"
import { registerBuiltinTools } from "../tools/knowledge_tools"
import { ToolRegistry } from "../tools/invocation"
import type { MastraRunnerInput, ProgressStage, StageProgressDetails } from "./chat_event_adapter"
import type { Router } from "../retrieval/router/interface"
import type {
  Searcher,
  SearchOptions,
  SearchOutcome,
} from "../retrieval/search/interface"
import type { ContextAssembler } from "../retrieval/context/interface"
import type { Validator } from "../critic/validator/interface"
import type { RePlanner } from "../critic/replanner/interface"
import type {
  Planner,
  DecomposeResult,
  RewriteResult,
  HypothesisResult,
} from "../retrieval/planner/interface"
import { PlannerError } from "../retrieval/planner/planner"
import type {
  ComplexLoopController,
  ComplexLoopDecision,
  ComplexLoopState,
  ComplexLoopResult,
} from "../retrieval/complex_loop"
import type { ConversationStore, ConversationTurn, ConversationMemory } from "../answer/conversation_store"
import type { ContextCompressor, ContextCompressionResult } from "../answer/context_compressor"
import type { HandoffStore } from "../answer/handoff_store"
import type { AccessContext } from "../access/context"
import type {
  Evidence,
  Query,
  RetrievalResult,
  RouterDecision,
  CriticVerdict,
  AgentMessage,
  TokenUsage,
} from "../types"
import type { RetrievalToolName, RetrievalToolArgs } from "../retrieval/tool_selector"

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

function makeFakePlanner(
  decomposeResult: DecomposeResult,
  rewriteResults?: RewriteResult[],
  navigateResults?: string[][],
  hypothesisResults?: HypothesisResult[]
): Planner & { decomposeCalls: Query[]; rewriteCalls: Query[]; navigateCalls: Query[]; hypothesisCalls: Query[] } {
  const decomposeCalls: Query[] = []
  const rewriteCalls: Query[] = []
  const navigateCalls: Query[] = []
  const hypothesisCalls: Query[] = []
  const rewrites = rewriteResults ?? decomposeResult.queries.map((q) => ({ query: q, usage: undefined as TokenUsage | undefined }))
  const navigates = navigateResults ?? decomposeResult.queries.map(() => [] as string[])
  const hypotheses = hypothesisResults ?? decomposeResult.queries.map(() => ({ text: "", usage: undefined as TokenUsage | undefined }))
  let rewriteIndex = 0
  let navigateIndex = 0
  let hypothesisIndex = 0
  return {
    decomposeCalls,
    rewriteCalls,
    navigateCalls,
    hypothesisCalls,
    async decompose(query: Query): Promise<DecomposeResult> {
      decomposeCalls.push(query)
      return decomposeResult
    },
    async rewrite(query: Query): Promise<RewriteResult> {
      rewriteCalls.push(query)
      const result = rewrites[Math.min(rewriteIndex, rewrites.length - 1)]
      rewriteIndex += 1
      return result
    },
    async navigate(query: Query): Promise<string[]> {
      navigateCalls.push(query)
      const result = navigates[Math.min(navigateIndex, navigates.length - 1)]
      navigateIndex += 1
      return result
    },
    async generateHypothesis(query: Query): Promise<HypothesisResult> {
      hypothesisCalls.push(query)
      const result = hypotheses[Math.min(hypothesisIndex, hypotheses.length - 1)]
      hypothesisIndex += 1
      return result
    },
  } as Planner & {
    decomposeCalls: Query[]
    rewriteCalls: Query[]
    navigateCalls: Query[]
    hypothesisCalls: Query[]
  }
}

/**
 * Fake ComplexLoopController that returns scripted decisions in sequence.
 * The Nth call to `decide` returns the Nth scripted decision (last one
 * repeats if there are more calls than scripts).
 */
function makeFakeComplexLoopController(
  decisions: ComplexLoopDecision[]
): ComplexLoopController & { decideCalls: ComplexLoopState[] } {
  const decideCalls: ComplexLoopState[] = []
  let callIndex = 0
  return {
    decideCalls,
    async decide(state: ComplexLoopState, _signal?: AbortSignal): Promise<ComplexLoopDecision> {
      decideCalls.push(state)
      const decision = decisions[Math.min(callIndex, decisions.length - 1)]
      callIndex += 1
      return decision
    },
  } as ComplexLoopController & { decideCalls: ComplexLoopState[] }
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
    message: "What is the return policy for electronics and how does it differ from furniture?",
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

test("AP-02: complex runner reports real stages and publishes the final cited basis", async () => {
  const result = makeRetrievalResult()
  const evidence = buildEvidence([result])
  const progress: Array<{ stage: ProgressStage; details?: StageProgressDetails<ProgressStage> }> = []
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => ({ async search() {
      assert.ok(progress.some(({ stage, details }) => stage === "route" && (details?.data as { queryCount?: number })?.queryCount === 1))
      return { status: "ok", results: [result], unavailableChannels: [] }
    } }),
    planner: makeFakePlanner({ queries: [{ text: "policy", coverageCriteria: ["return window"] }] }),
    assembler: { async assemble() {
      assert.deepEqual(progress.at(-1), { stage: "context", details: { round: 1, data: { phase: "assembly", evidenceCount: 1 } } })
      return "actual evidence context"
    } },
    streamAnswerDraft: async function* () {
      assert.equal((progress.at(-1)?.details?.data as { phase?: string }).phase, "draft")
      yield buildCitedAnswer(evidence)
    },
    validator: { async validate() {
      assert.deepEqual(progress.at(-1), { stage: "validation", details: { round: 1, data: { round: 1 } } })
      return { passed: true, hallucination: false, completeness: true, answerBasis: { text: "  依据退货资料。  ", referenceIds: [evidence[0].id, evidence[0].id] } }
    } },
    replanner: makeFakeRePlanner([]),
  })
  const output = await runner(makeRunnerInput({ onStageProgress: (stage, details) => progress.push({ stage, details }) }))
  assert.equal(output.status, "completed")
  assert.ok(progress.some(({ stage, details }) => stage === "retrieval" && details?.status === "completed" && (details.data as { resultCount?: number }).resultCount === 1))
  assert.equal(output.contextTrace.phase, "draft")
  assert.deepEqual(output.validationTrace.answerBasis, { text: "依据退货资料。", referenceIds: [evidence[0].id] })
  assert.ok(progress.every(({ details }) => !details?.data || !("answerBasis" in details.data)))
})

test("AP-02: complex correction reports round two without leaking the rejected basis", async () => {
  const first = makeRetrievalResult()
  const gap = makeRetrievalResult({ chunk: { id: "gap", documentId: "gap-doc", content: "New evidence", childrenIds: [], metadata: {} } })
  const firstEvidence = buildEvidence([first])
  const gapEvidence = buildEvidence([gap])
  const progress: Array<{ stage: ProgressStage; details?: StageProgressDetails<ProgressStage> }> = []
  const searcher = makeFakeSearcher([
    { status: "ok", results: [first], unavailableChannels: [] },
    { status: "ok", results: [gap], unavailableChannels: [] },
  ])
  const validator = makeFakeValidator([
    { passed: false, hallucination: false, completeness: false, answerBasis: { text: "第一轮不能公开", referenceIds: [firstEvidence[0].id] } },
    { passed: true, hallucination: false, completeness: true, answerBasis: { text: "第二轮依据新增资料。", referenceIds: [gapEvidence[0].id] } },
  ])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"), createSearcher: () => searcher,
    planner: makeFakePlanner({ queries: [{ text: "policy" }] }),
    assembler: makeFakeAssembler(), validator, replanner: makeFakeRePlanner([{ text: "missing detail" }]),
    streamAnswerDraft: makeScriptedDraftStream([[buildCitedAnswer(firstEvidence)], [buildCitedAnswer(gapEvidence)]]),
  })
  const output = await runner(makeRunnerInput({ onStageProgress: (stage, details) => progress.push({ stage, details }) }))
  assert.equal(output.status, "completed")
  assert.deepEqual(output.validationTrace.answerBasis, { text: "第二轮依据新增资料。", referenceIds: [gapEvidence[0].id] })
  assert.equal(validator.calls, 2)
  assert.equal(searcher.calls.length, 2)
  const roundTwo = progress.filter(({ details }) => details?.round === 2)
  assert.deepEqual(roundTwo.map(({ stage }) => stage), ["retrieval", "retrieval", "context", "context", "context", "context", "validation", "validation"])
  assert.ok(progress.every(({ details }) => !details?.data || !("answerBasis" in details.data)))
})

// ---------------------------------------------------------------------------
// T12 #1 — Complex requests preserve query decomposition, coverage criteria,
// and bounded retrieval-tool selection
// ---------------------------------------------------------------------------

test("T12 #1a planner path: sub-queries with coverage criteria are decomposed and searched", async () => {
  const subQueries: Query[] = [
    { text: "return policy electronics", coverageCriteria: ["electronics", "30 days"] },
    { text: "return policy furniture", coverageCriteria: ["furniture", "14 days"] },
  ]
  const decomposeResult: DecomposeResult = {
    queries: subQueries,
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
  }
  const planner = makeFakePlanner(decomposeResult)
  const result1 = makeRetrievalResult({ chunk: { id: "c1", documentId: "d1", content: "electronics policy", childrenIds: [], metadata: {} } })
  const result2 = makeRetrievalResult({ chunk: { id: "c2", documentId: "d2", content: "furniture policy", childrenIds: [], metadata: {} } })
  const searcher = makeFakeSearcher([
    { status: "ok", results: [result1], unavailableChannels: [] },
    { status: "ok", results: [result2], unavailableChannels: [] },
  ])
  const evidence = buildEvidence([result1, result2])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    planner,
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed", "planner path must reach completed")
  assert.equal(output.routeTrace.decision, "complex")
  assert.equal(output.routeTrace.queryCount, 2, "queryCount must reflect decomposed sub-queries")
  assert.ok(output.routeTrace.subQueries, "subQueries must be populated")
  assert.equal(output.routeTrace.subQueries!.length, 2)
  assert.equal(planner.decomposeCalls.length, 1, "planner.decompose called once")
  assert.equal(planner.rewriteCalls.length, 2, "planner.rewrite called per sub-query")
  assert.equal(searcher.calls.length, 2, "searcher.search called per sub-query")
})

test("DR-22 review: a complex-path rerank failure is a partial answer, not none", async () => {
  const result = makeRetrievalResult()
  const evidence = buildEvidence([result])
  const build = (degradationReasons: string[]) =>
    createComplexKnowledgeMastraRunner({
      router: makeFakeRouter("complex"),
      createSearcher: () =>
        makeFakeSearcher({
          status: "degraded",
          results: [result],
          unavailableChannels: [],
          degradationReasons,
        }),
      planner: makeFakePlanner({ queries: [{ text: "policy" }] }),
      assembler: makeFakeAssembler(),
      validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
      replanner: makeFakeRePlanner([]),
      streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    })

  const failed = await build(["reranker_unavailable"])(makeRunnerInput())
  assert.equal(failed.status, "completed")
  assert.equal(failed.degradation.status, "partial")
  assert.ok(
    (failed.retrievalTrace.degradedReasons ?? []).includes("reranker_unavailable"),
    "the trace keeps the reason that caused the degradation",
  )

  // A missing rerank capability is a configuration fact, not answer degradation.
  const unconfigured = await build(["reranker_not_configured"])(makeRunnerInput())
  assert.equal(unconfigured.status, "completed")
  assert.equal(unconfigured.degradation.status, "none")
})

test("P1 regression: early complex terminal preserves prepared and planner route trace fields", async () => {
  const preparedTrace = {
    decision: "complex" as const,
    contextualizationOutcome: "failed" as const,
    contextualizationFailure: "context provider unavailable",
    contextualizationUsage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    contextualizationDurationMs: 23,
  }
  const planner = makeFakePlanner({
    queries: [{ text: "missing evidence", coverageCriteria: ["policy"] }],
    usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
  })
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => makeFakeSearcher({
      status: "ok",
      results: [],
      unavailableChannels: [],
    }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["unused"]),
    planner,
  })

  const output = await runner(makeRunnerInput({
    preparedRoute: {
      decision: "complex",
      effectiveMessage: "effective",
      contextualizedQuery: "contextualized",
      routeTrace: preparedTrace,
    },
  }))

  assert.equal(output.status, "insufficient_evidence")
  assert.equal(output.routeTrace.contextualizationFailure, preparedTrace.contextualizationFailure)
  assert.deepEqual(output.routeTrace.contextualizationUsage, preparedTrace.contextualizationUsage)
  assert.equal(output.routeTrace.contextualizationDurationMs, preparedTrace.contextualizationDurationMs)
  assert.equal(output.routeTrace.queryCount, 1)
  assert.equal(output.routeTrace.modelCalls, 4)
  assert.equal(output.routeTrace.tokens, 14)
})

test("T12 #1b loop path: bounded loop runs with tool selection (≤3 iter / ≤4 tools)", async () => {
  const result1 = makeRetrievalResult({ chunk: { id: "c1", documentId: "d1", content: "loop content", childrenIds: [], metadata: {} } })
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [result1],
    unavailableChannels: [],
  })
  const controller = makeFakeComplexLoopController([
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "first" } },
    { sufficient: true },
  ])
  const evidence = buildEvidence([result1])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    complexLoopController: controller,
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed", "loop path must reach completed")
  assert.equal(output.routeTrace.complexLoopStopReason, "evidence-sufficient")
  assert.equal(output.routeTrace.complexLoopIterations, 2, "2 iterations executed (decide + sufficient)")
  assert.equal(output.routeTrace.complexLoopToolCalls, 1, "1 tool call executed")
  assert.equal(searcher.calls.length, 1, "searcher.search called once by the loop")
  assert.ok(searcher.calls[0].options?.accessContext, "searcher must receive accessContext (T12 #2)")
})

// ---------------------------------------------------------------------------
// T12 #2 — Tools delegate to existing authorized retrieval channels
// ---------------------------------------------------------------------------

test("T12 #2a loop path: searcher.search receives accessContext", async () => {
  const accessContext = makeAccessContext("tenant-loop")
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [makeRetrievalResult()],
    unavailableChannels: [],
  })
  const controller = makeFakeComplexLoopController([{ sufficient: true }])
  const evidence = buildEvidence([makeRetrievalResult()])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    complexLoopController: controller,
  })
  // Need at least one result for the loop to be "available" — but with
  // sufficient=true on first iteration, no tool call is made. Provide a
  // result via the searcher anyway to avoid empty-evidence terminal.
  // Use a controller that calls a tool first, then stops.
  const controller2 = makeFakeComplexLoopController([
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "test" } },
    { sufficient: true },
  ])
  const runner2 = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    complexLoopController: controller2,
  })
  await runner2(makeRunnerInput({ accessContext }))
  assert.equal(
    searcher.calls[0].options?.accessContext,
    accessContext,
    "searcher.search must receive accessContext in loop path (T12 #2)"
  )
})

test("Ticket 05: every complex sub-query shares the run's knowledge scope", async () => {
  const retrievalScope = { knowledgeBaseIds: ["kb-policies"] }
  const subQueries: Query[] = [{ text: "sub-query-1" }, { text: "sub-query-2" }]
  const planner = makeFakePlanner({ queries: subQueries })
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [makeRetrievalResult()],
    unavailableChannels: [],
  })
  const evidence = buildEvidence([makeRetrievalResult()])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    planner,
  })

  await runner(makeRunnerInput({ retrievalScope }))

  assert.ok(searcher.calls.length >= 2, "the decomposed sub-queries must each retrieve")
  for (const call of searcher.calls) {
    assert.deepEqual(
      call.options?.retrievalScope,
      retrievalScope,
      "a decomposed sub-query must not widen the run's knowledge scope (Ticket 05, KB-03A)"
    )
  }
})

test("Ticket 05: the deterministic fallback search shares the run's knowledge scope", async () => {
  const retrievalScope = { knowledgeBaseIds: ["kb-policies"] }
  const initialResult = makeRetrievalResult({ chunk: { id: "c-init", documentId: "d-init", content: "initial", childrenIds: [], metadata: {} } })
  const fallbackResult = makeRetrievalResult({ chunk: { id: "c-fb", documentId: "d-fb", content: "fallback", childrenIds: [], metadata: {} } })
  const searcher = makeFakeSearcher([
    // call 0: initial loop tool call; call 1: deterministic fallback on the gap query
    { status: "ok", results: [initialResult], unavailableChannels: [] },
    { status: "ok", results: [fallbackResult], unavailableChannels: [] },
  ])
  // Correction loop stops on iteration budget with 0 results → the runner's
  // deterministic `searcher.search(gapQuery)` fallback fires.
  const controller = makeFakeComplexLoopController([
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "initial-q" } },
    { sufficient: true },
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "initial-q" } },
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "initial-q" } },
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "initial-q" } },
  ])
  const evidence = buildEvidence([initialResult, fallbackResult])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator([
      { passed: false, hallucination: false, completeness: false },
      { passed: true, hallucination: false, completeness: true },
    ]),
    replanner: makeFakeRePlanner([[{ text: "gap-query" }]]),
    streamAnswerDraft: makeScriptedDraftStream([
      buildCitedAnswer(buildEvidence([initialResult])),
      buildCitedAnswer(evidence),
    ]),
    complexLoopController: controller,
  })

  const output = await runner(makeRunnerInput({ retrievalScope }))

  assert.equal(output.status, "completed", "deterministic fallback must yield new evidence → completed")
  assert.ok(searcher.calls.length >= 2, "deterministic fallback must call searcher.search")
  for (const call of searcher.calls) {
    assert.deepEqual(
      call.options?.retrievalScope,
      retrievalScope,
      "the deterministic fallback must not escape the run's knowledge scope (Ticket 05, KB-03A)"
    )
  }
})

test("Ticket 05: legacy correction searches share the run's knowledge scope", async () => {
  const retrievalScope = { knowledgeBaseIds: ["kb-policies"] }
  const initialResult = makeRetrievalResult({ chunk: { id: "c-init", documentId: "d-init", content: "initial", childrenIds: [], metadata: {} } })
  const correctionResult = makeRetrievalResult({ chunk: { id: "c-corr", documentId: "d-corr", content: "correction", childrenIds: [], metadata: {} } })
  // No complexLoopController wired → Path B: legacy planner.decompose flow
  // with a single searcher.search per gap query.
  // calls: [0] initial sub-query retrieval, [1] correction gap query.
  const searcher = makeFakeSearcher([
    { status: "ok", results: [initialResult], unavailableChannels: [] },
    { status: "ok", results: [correctionResult], unavailableChannels: [] },
  ])
  const evidence = buildEvidence([initialResult, correctionResult])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator([
      { passed: false, hallucination: false, completeness: false },
      { passed: true, hallucination: false, completeness: true },
    ]),
    replanner: makeFakeRePlanner([[{ text: "gap-query" }]]),
    streamAnswerDraft: makeScriptedDraftStream([
      buildCitedAnswer(buildEvidence([initialResult])),
      buildCitedAnswer(evidence),
    ]),
    planner: makeFakePlanner({ queries: [{ text: "initial-query" }] }),
  })

  const output = await runner(makeRunnerInput({ retrievalScope }))

  assert.equal(output.status, "completed", "path-B correction + regeneration + pass → completed")
  assert.ok(searcher.calls.length >= 2, "the correction gap query must retrieve")
  for (const call of searcher.calls) {
    assert.deepEqual(
      call.options?.retrievalScope,
      retrievalScope,
      "a legacy correction search must not escape the run's knowledge scope (Ticket 05, KB-03A)"
    )
  }
})

test("Ticket 05: correction-loop tool searches share the run's knowledge scope", async () => {
  const retrievalScope = { knowledgeBaseIds: ["kb-policies"] }
  // Path A (complexLoopController wired — the production shape): the
  // correction round reuses runComplexLoop, so its tool searches must inherit
  // the run's scope too, not only the initial loop's.
  const searcher = makeFakeSearcher([
    // call 0: initial loop tool call
    { status: "ok", results: [makeRetrievalResult({ chunk: { id: "c-init", documentId: "d-init", content: "initial", childrenIds: [], metadata: {} } })], unavailableChannels: [] },
    // call 1: correction loop tool call (different query to avoid dedup)
    { status: "ok", results: [makeRetrievalResult({ chunk: { id: "c-corr", documentId: "d-corr", content: "correction", childrenIds: [], metadata: {} } })], unavailableChannels: [] },
  ])
  const controller = makeFakeComplexLoopController([
    // Initial run: 1 tool call then sufficient
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "initial-query" } },
    { sufficient: true },
    // Correction round: 1 tool call then sufficient
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "correction-query" } },
    { sufficient: true },
  ])
  const evidence = buildEvidence([
    makeRetrievalResult({ chunk: { id: "c-init", documentId: "d-init", content: "initial", childrenIds: [], metadata: {} } }),
    makeRetrievalResult({ chunk: { id: "c-corr", documentId: "d-corr", content: "correction", childrenIds: [], metadata: {} } }),
  ])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator([
      { passed: false, hallucination: false, completeness: false },
      { passed: true, hallucination: false, completeness: true },
    ]),
    replanner: makeFakeRePlanner([[{ text: "gap-query-1" }]]),
    streamAnswerDraft: makeScriptedDraftStream([
      buildCitedAnswer(buildEvidence([makeRetrievalResult({ chunk: { id: "c-init", documentId: "d-init", content: "initial", childrenIds: [], metadata: {} } })])),
      buildCitedAnswer(evidence),
    ]),
    complexLoopController: controller,
  })

  const output = await runner(makeRunnerInput({ retrievalScope }))

  assert.equal(output.status, "completed", "correction round must converge to completed")
  assert.ok(searcher.calls.length >= 2, "both the initial and the correction tool search must run")
  for (const call of searcher.calls) {
    assert.deepEqual(
      call.options?.retrievalScope,
      retrievalScope,
      "a correction-loop tool search must not escape the run's knowledge scope (Ticket 05, KB-03A)"
    )
  }
})

test("T12 #2b planner path: searcher.search receives accessContext", async () => {
  const accessContext = makeAccessContext("tenant-planner")
  const subQueries: Query[] = [{ text: "sub-query-1" }]
  const decomposeResult: DecomposeResult = { queries: subQueries }
  const planner = makeFakePlanner(decomposeResult)
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [makeRetrievalResult()],
    unavailableChannels: [],
  })
  const evidence = buildEvidence([makeRetrievalResult()])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    planner,
  })
  await runner(makeRunnerInput({ accessContext }))
  assert.equal(
    searcher.calls[0].options?.accessContext,
    accessContext,
    "searcher.search must receive accessContext in planner path (T12 #2)"
  )
})

// ---------------------------------------------------------------------------
// T12 #3 — Iteration, tool-call, token, and duration budgets stop runaway
// Agent loops
// ---------------------------------------------------------------------------

test("T12 #3a loop stops at COMPLEX_LOOP_MAX_ITERATIONS (3) when controller never declares sufficient", async () => {
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [makeRetrievalResult({ chunk: { id: "c-iter", documentId: "d-iter", content: `content`, childrenIds: [], metadata: {} } })],
    unavailableChannels: [],
  })
  // Controller always returns a non-duplicate tool call, never sufficient.
  // The loop runs 3 iterations (the ceiling), each with a unique query.
  const controller = makeFakeComplexLoopController([
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "iter-1" } },
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "iter-2" } },
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "iter-3" } },
  ])
  const evidence = buildEvidence([makeRetrievalResult()])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    complexLoopController: controller,
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.routeTrace.complexLoopIterations, 3, "loop must stop at 3 iterations")
  assert.equal(output.routeTrace.complexLoopStopReason, "iteration-budget", "stop reason must be iteration-budget")
  assert.equal(output.routeTrace.complexLoopToolCalls, 3, "3 tool calls (one per iteration, no duplicates)")
})

test("T12 #3b correction round shares budget with initial run (T09 §13 reuse)", async () => {
  // Initial run: 2 iterations, 1 tool call, evidence-sufficient.
  // Then validator fails, replanner produces 1 gap query.
  // Correction round: reuses runComplexLoop with remainingIterations=1,
  // remainingToolCalls=3, priorToolCalls=[initial call].
  const searcher = makeFakeSearcher([
    // Initial loop call (1 tool call)
    { status: "ok", results: [makeRetrievalResult({ chunk: { id: "c-init", documentId: "d-init", content: "initial", childrenIds: [], metadata: {} } })], unavailableChannels: [] },
    // Correction loop call (1 tool call — different query to avoid dedup)
    { status: "ok", results: [makeRetrievalResult({ chunk: { id: "c-corr", documentId: "d-corr", content: "correction", childrenIds: [], metadata: {} } })], unavailableChannels: [] },
  ])
  const controller = makeFakeComplexLoopController([
    // Initial run: 1 tool call then sufficient
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "initial-query" } },
    { sufficient: true },
    // Correction round: 1 tool call then sufficient (different query to avoid dedup)
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "correction-query" } },
    { sufficient: true },
  ])
  // Validator: round 0 fails → replan → round 1 passes
  const validator = makeFakeValidator([
    { passed: false, hallucination: false, completeness: false },
    { passed: true, hallucination: false, completeness: true },
  ])
  const replanner = makeFakeRePlanner([[{ text: "gap-query-1" }]])
  const evidence = buildEvidence([
    makeRetrievalResult({ chunk: { id: "c-init", documentId: "d-init", content: "initial", childrenIds: [], metadata: {} } }),
    makeRetrievalResult({ chunk: { id: "c-corr", documentId: "d-corr", content: "correction", childrenIds: [], metadata: {} } }),
  ])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator,
    replanner,
    streamAnswerDraft: makeScriptedDraftStream([
      buildCitedAnswer(buildEvidence([makeRetrievalResult({ chunk: { id: "c-init", documentId: "d-init", content: "initial", childrenIds: [], metadata: {} } })])),
      buildCitedAnswer(evidence),
    ]),
    complexLoopController: controller,
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed", "correction round must converge to completed")
  assert.equal(output.validationTrace.round, 2, "validation passed on round 2")
  // The correction round ran runComplexLoop with reduced budgets.
  // Initial loop: 2 decide calls (1 tool + sufficient) → iterationsExecuted=2.
  // sharedRemainingIterations = max(0, 3 - 2) = 1 → correction loop can make
  // only 1 decide call (the iteration budget is consumed before the second
  // `sufficient` decision would be requested). Total = 2 + 1 = 3.
  // The 3rd call proves correction used runComplexLoop (legacy path doesn't
  // call controller.decide at all).
  assert.equal(
    controller.decideCalls.length,
    3,
    "controller.decide called for initial (2) + correction (1) rounds — sharedRemainingIterations=1 caps correction to 1 decide call"
  )
})

// ---------------------------------------------------------------------------
// T12 #4 — Correction rounds rebuild one coherent candidate from all
// accumulated authorized Evidence
// ---------------------------------------------------------------------------

test("T12 #4 correction round accumulates results and regenerates draft from rebuilt context", async () => {
  const initialResult = makeRetrievalResult({ chunk: { id: "c-init", documentId: "d-init", content: "initial evidence", childrenIds: [], metadata: {} } })
  const correctionResult = makeRetrievalResult({ chunk: { id: "c-corr", documentId: "d-corr", content: "correction evidence", childrenIds: [], metadata: {} } })
  const searcher = makeFakeSearcher([
    // Initial retrieval (planner path: 1 sub-query)
    { status: "ok", results: [initialResult], unavailableChannels: [] },
    // Correction retrieval (1 gap query)
    { status: "ok", results: [correctionResult], unavailableChannels: [] },
  ])
  const subQueries: Query[] = [{ text: "initial sub-query" }]
  const planner = makeFakePlanner({ queries: subQueries })
  // Validator: round 0 fails → replan → round 1 passes
  const validator = makeFakeValidator([
    { passed: false, hallucination: false, completeness: false },
    { passed: true, hallucination: false, completeness: true },
  ])
  const replanner = makeFakeRePlanner([[{ text: "gap-query" }]])
  // Draft stream: initial draft (cites initial evidence) + regen draft (cites both)
  const initialEvidence = buildEvidence([initialResult])
  const bothEvidence = buildEvidence([initialResult, correctionResult])
  const draftStream = makeScriptedDraftStream([
    buildCitedAnswer(initialEvidence),
    buildCitedAnswer(bothEvidence),
  ])
  let draftCallCount = 0
  const wrappedDraftStream = (messages: AgentMessage[], signal: AbortSignal) => {
    draftCallCount += 1
    return draftStream(messages, signal)
  }
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator,
    replanner,
    streamAnswerDraft: wrappedDraftStream,
    planner,
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed", "correction must converge to completed")
  assert.equal(draftCallCount, 2, "draft stream called twice (initial + regen)")
  assert.equal(searcher.calls.length, 2, "searcher called twice (initial + correction)")
  // The final reply must cite evidence from the accumulated set.
  assert.ok(output.references.length > 0, "final references must be non-empty")
})

// ---------------------------------------------------------------------------
// T12 #5 — Duplicate or malformed tool calls fail safely and use the
// approved deterministic fallback
// ---------------------------------------------------------------------------

test("T12 #5a duplicate tool call is skipped without backend execution", async () => {
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [makeRetrievalResult({ chunk: { id: "c-dup", documentId: "d-dup", content: "content", childrenIds: [], metadata: {} } })],
    unavailableChannels: [],
  })
  // Controller returns the SAME tool+args on the second iteration → duplicate.
  // Third iteration declares sufficient.
  const controller = makeFakeComplexLoopController([
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "same-query" } },
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "same-query" } },
    { sufficient: true },
  ])
  const evidence = buildEvidence([makeRetrievalResult({ chunk: { id: "c-dup", documentId: "d-dup", content: "content", childrenIds: [], metadata: {} } })])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    complexLoopController: controller,
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed")
  assert.equal(output.routeTrace.complexLoopIterations, 3, "3 iterations (decide + dup-decide + sufficient)")
  assert.equal(output.routeTrace.complexLoopToolCalls, 1, "only 1 tool call executed (duplicate skipped)")
  assert.equal(searcher.calls.length, 1, "searcher.search called only once (duplicate not executed)")
})

test("T12 #5b correction loop 0 new results → deterministic searcher.search fallback", async () => {
  // Initial run: 1 tool call, evidence-sufficient.
  // Validator fails → replan → 1 gap query.
  // Correction loop: controller declares sufficient immediately (0 new results, non-fallback stop).
  // Wait — the runner's deterministic-fallback condition is:
  //   results.length === 0 && stopReason !== "evidence-sufficient"
  // So if the correction loop returns evidence-sufficient with 0 results,
  // NO deterministic fallback runs. We need a different stopReason.
  // Use iteration-budget with 0 results → deterministic fallback fires.
  const initialResult = makeRetrievalResult({ chunk: { id: "c-init", documentId: "d-init", content: "initial", childrenIds: [], metadata: {} } })
  const fallbackResult = makeRetrievalResult({ chunk: { id: "c-fb", documentId: "d-fb", content: "fallback", childrenIds: [], metadata: {} } })
  const searcher = makeFakeSearcher([
    // Initial loop call (1 tool call, returns initialResult)
    { status: "ok", results: [initialResult], unavailableChannels: [] },
    // Correction loop call: controller declares sufficient immediately,
    // so 0 tool calls, 0 results. Then deterministic fallback fires →
    // searcher.search(gapQuery) returns fallbackResult.
    { status: "ok", results: [fallbackResult], unavailableChannels: [] },
  ])
  // Controller: initial run (1 call + sufficient), correction (sufficient immediately).
  // Correction returns evidence-sufficient with 0 results → NOT a fallback case.
  // To trigger fallback, use iteration-budget stop with 0 results.
  // But iteration-budget requires 3 iterations with no sufficient. Let's do that.
  const controller = makeFakeComplexLoopController([
    // Initial: 1 call + sufficient
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "initial-q" } },
    { sufficient: true },
    // Correction: 3 iterations, no tool calls (all duplicates of initial)
    // → iteration-budget stop, 0 results → deterministic fallback fires.
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "initial-q" } }, // duplicate
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "initial-q" } }, // duplicate
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "initial-q" } }, // duplicate
  ])
  const validator = makeFakeValidator([
    { passed: false, hallucination: false, completeness: false },
    { passed: true, hallucination: false, completeness: true },
  ])
  const replanner = makeFakeRePlanner([[{ text: "gap-query" }]])
  const evidence = buildEvidence([initialResult, fallbackResult])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator,
    replanner,
    streamAnswerDraft: makeScriptedDraftStream([
      buildCitedAnswer(buildEvidence([initialResult])),
      buildCitedAnswer(evidence),
    ]),
    complexLoopController: controller,
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed", "deterministic fallback must yield new evidence → completed")
  // searcher.calls: [0]=initial loop, [1]=deterministic fallback
  assert.ok(searcher.calls.length >= 2, "deterministic fallback must call searcher.search")
})

// ---------------------------------------------------------------------------
// T12 #6 — Cancellation stops active tools and prevents late observations,
// drafts, or answers
// ---------------------------------------------------------------------------

test("T12 #6a abort before route → throws AbortError", async () => {
  const ac = new AbortController()
  ac.abort()
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => makeFakeSearcher({ status: "ok", results: [makeRetrievalResult()], unavailableChannels: [] }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
    complexLoopController: makeFakeComplexLoopController([{ sufficient: true }]),
  })
  await assert.rejects(
    () => runner(makeRunnerInput({ signal: ac.signal })),
    (err: unknown) => {
      assert.equal((err as Error).name, "AbortError", "pre-route abort must surface as AbortError")
      return true
    }
  )
})

test("T12 #6b abort during draft stream → throws AbortError", async () => {
  const ac = new AbortController()
  const result = makeRetrievalResult()
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [result],
    unavailableChannels: [],
  })
  // Abort right after the loop returns (before draft stream completes).
  // Use an aborting draft stream to simulate mid-stream abort.
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeAbortingDraftStream(0),
    complexLoopController: makeFakeComplexLoopController([
      { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "q" } },
      { sufficient: true },
    ]),
  })
  // The abort signal is not aborted upfront; the draft stream itself throws.
  await assert.rejects(
    () => runner(makeRunnerInput({ signal: ac.signal })),
    (err: unknown) => {
      assert.equal((err as Error).name, "AbortError", "mid-stream abort must surface as AbortError")
      return true
    }
  )
})

// ---------------------------------------------------------------------------
// T12 #7 — Every path converges to one existing compatible terminal event
// ---------------------------------------------------------------------------

test("T12 #7a happy path (loop) → completed", async () => {
  const result = makeRetrievalResult()
  const searcher = makeFakeSearcher({ status: "ok", results: [result], unavailableChannels: [] })
  const evidence = buildEvidence([result])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    complexLoopController: makeFakeComplexLoopController([
      { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "q" } },
      { sufficient: true },
    ]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed", "happy path (loop) must reach completed")
  assert.equal(output.routeTrace.decision, "complex")
  assert.ok(output.references.length > 0, "must have references")
  assert.ok(output.tokens.length > 0, "must collect tokens")
})

test("T12 #7b happy path (planner) → completed", async () => {
  const result = makeRetrievalResult()
  const searcher = makeFakeSearcher({ status: "ok", results: [result], unavailableChannels: [] })
  const evidence = buildEvidence([result])
  const planner = makeFakePlanner({ queries: [{ text: "sub-q" }] })
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    planner,
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed", "happy path (planner) must reach completed")
  assert.equal(output.routeTrace.decision, "complex")
  assert.equal(output.routeTrace.queryCount, 1, "planner path records queryCount")
})

test("T12 #7c insufficient retrieval (loop 0 results) → insufficient_retrieval", async () => {
  const searcher = makeFakeSearcher({ status: "ok", results: [], unavailableChannels: [] })
  // Controller: 1 tool call returning 0 results, then sufficient (loop ends with 0 results).
  // 0 results + evidence-sufficient → loop ends, but retrievalAvailable=false → insufficient_retrieval.
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
    complexLoopController: makeFakeComplexLoopController([
      { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "q" } },
      { sufficient: true },
    ]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "insufficient_retrieval", "0 results → insufficient_retrieval (T12 #7)")
})

test("T12 #7d unknown citation in initial draft → invalid_citation", async () => {
  const result = makeRetrievalResult()
  const searcher = makeFakeSearcher({ status: "ok", results: [result], unavailableChannels: [] })
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    // Draft with UNKNOWN citation → referencesForReply throws (evidence.ts L166)
    // → caught at complex_knowledge_runner.ts L977-1004 → invalid_citation.
    // Mirrors T11 #4 pattern. Note: a draft with NO [cite:xxx] markers does
    // NOT throw (returns empty references) → that case is handled by the
    // final citation check at L1454-1483 as insufficient_evidence.
    streamAnswerDraft: makeScriptedDraftStream(["answer with [cite:unknown-id]"]),
    complexLoopController: makeFakeComplexLoopController([
      { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "q" } },
      { sufficient: true },
    ]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "invalid_citation", "unknown citation → invalid_citation (T12 #7)")
  assert.equal(output.degradation.reason, "no_cited_claims")
  assert.deepEqual(output.tokens, [], "invalid-citation Draft tokens must be withheld")
})

test("T12 #7e validation exhausted with handoff → handoff_required", async () => {
  const result = makeRetrievalResult()
  const searcher = makeFakeSearcher({ status: "ok", results: [result], unavailableChannels: [] })
  const evidence = buildEvidence([result])
  const handoffStore = makeFakeHandoffStore()
  // Validator always fails → 3 rounds exhausted. Replanner returns gap queries
  // but correction retrieval returns 0 new results → handoff_required.
  const validator = makeFakeValidator({ passed: false, hallucination: false, completeness: false })
  const replanner = makeFakeRePlanner([[{ text: "gap-q-1" }]])
  const searcherWithEmptyCorrection = makeFakeSearcher([
    { status: "ok", results: [result], unavailableChannels: [] }, // initial
    { status: "ok", results: [], unavailableChannels: [] }, // correction (0 new)
  ])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcherWithEmptyCorrection,
    assembler: makeFakeAssembler(),
    validator,
    replanner,
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    handoffStore,
    resolveTenantId: (ctx) => ctx.tenantId,
    complexLoopController: makeFakeComplexLoopController([
      { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "q" } },
      { sufficient: true },
    ]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "handoff_required", "exhausted + handoffStore → handoff_required (T12 #7)")
  assert.equal(handoffStore.createdCases.length, 1, "handoff case must be created")
})

test("T12 #7f validation exhausted without handoff → insufficient_evidence", async () => {
  const result = makeRetrievalResult()
  const searcher = makeFakeSearcher([
    { status: "ok", results: [result], unavailableChannels: [] }, // initial
    { status: "ok", results: [], unavailableChannels: [] }, // correction (0 new)
  ])
  const evidence = buildEvidence([result])
  // No handoffStore → insufficient_evidence
  const validator = makeFakeValidator({ passed: false, hallucination: false, completeness: false })
  const replanner = makeFakeRePlanner([[{ text: "gap-q-1" }]])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator,
    replanner,
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    complexLoopController: makeFakeComplexLoopController([
      { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "q" } },
      { sufficient: true },
    ]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "insufficient_evidence", "exhausted without handoff → insufficient_evidence (T12 #7)")
  assert.equal(output.degradation.reason, "coverage_not_met")
})

test("T12 #7g provider failure in loop → provider_error", async () => {
  // searcher.search throws a non-Abort error → loop stops with provider-failure.
  const searcher: Searcher = {
    async search(): Promise<SearchOutcome> {
      throw new Error("Elasticsearch down")
    },
  }
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
    complexLoopController: makeFakeComplexLoopController([
      { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "q" } },
    ]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "provider_error", "loop provider failure → provider_error (T12 #7)")
  assert.equal(output.routeTrace.complexLoopStopReason, "provider-failure")
})

test("T12 #7h RouteNotComplexError for non-complex routes", async () => {
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => makeFakeSearcher({ status: "ok", results: [makeRetrievalResult()], unavailableChannels: [] }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
  })
  await assert.rejects(
    () => runner(makeRunnerInput()),
    (err: unknown) => {
      assert.ok(err instanceof RouteNotComplexError, "non-complex route → RouteNotComplexError")
      assert.equal((err as RouteNotComplexError).decision, "simple")
      return true
    }
  )
})

test("T12 #7i no planner AND no controller → provider_error", async () => {
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => makeFakeSearcher({ status: "ok", results: [makeRetrievalResult()], unavailableChannels: [] }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
    // Neither planner nor complexLoopController wired
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "provider_error", "no planner + no controller → provider_error (T12 #7)")
})

test("T12 #7j conversation memory: validated turns saved only on completed", async () => {
  const result = makeRetrievalResult()
  const searcher = makeFakeSearcher({ status: "ok", results: [result], unavailableChannels: [] })
  const evidence = buildEvidence([result])
  const conversationStore = makeFakeConversationStore()
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    conversationStore,
    resolveTenantId: (ctx) => ctx.tenantId,
    complexLoopController: makeFakeComplexLoopController([
      { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "q" } },
      { sufficient: true },
    ]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed")
  assert.equal(conversationStore.validatedTurns.length, 2, "user + assistant turn saved on completed (T10 #2)")
  assert.equal(conversationStore.validatedTurns[0].role, "user")
  assert.equal(conversationStore.validatedTurns[1].role, "assistant")
})

test("P1 regression: abort during post-persistence summarization keeps complex completion authoritative", async () => {
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
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => makeFakeSearcher({ status: "ok", results: [result], unavailableChannels: [] }),
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
    complexLoopController: makeFakeComplexLoopController([
      { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "q" } },
      { sufficient: true },
    ]),
  })

  const output = await runner(makeRunnerInput({ signal: controller.signal }))
  assert.equal(output.status, "completed")
  assert.equal(output.summarizationOutcome, "failed")
  assert.equal(conversationStore.validatedTurns.length, 2)
})

test("T12 #7k planner path: PlannerError → provider_error", async () => {
  const searcher = makeFakeSearcher({ status: "ok", results: [makeRetrievalResult()], unavailableChannels: [] })
  // Planner whose decompose throws a real PlannerError instance.
  // The runner catches `instanceof PlannerError` at L684 → provider_error.
  // Using a plain Error with name="PlannerError" would NOT match instanceof.
  const planner: Planner = {
    async decompose(): Promise<DecomposeResult> {
      throw new PlannerError("decompose failed", "decompose")
    },
    async rewrite(): Promise<RewriteResult> { return { query: { text: "q" } } },
    async navigate(): Promise<string[]> { return [] },
    async generateHypothesis(): Promise<HypothesisResult> { return { text: "" } },
  }
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
    planner,
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "provider_error", "PlannerError → provider_error (T12 #7)")
})

test("P1 regression: a non-complex runner does not consume pending clarification", async () => {
  const conversationStore = makeFakeConversationStore()
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => makeFakeSearcher({ status: "ok", results: [], unavailableChannels: [] }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["unused"]),
    conversationStore,
    resolveTenantId: (ctx) => ctx.tenantId,
  })

  await assert.rejects(() => runner(makeRunnerInput()), RouteNotComplexError)
  assert.equal(
    conversationStore.pendingClarificationConsumed.length,
    0,
    "route ownership must be confirmed before destructive clarification consumption"
  )
})

// ---------------------------------------------------------------------------
// Eval refactor Ticket 01 #4 — final context observation on the complex
// route (loop path): ordered candidates + evidence correlation at round 1.
// ---------------------------------------------------------------------------

test("Ticket 01 #4: complex loop path accepted draft → ordered finalContextCandidates at round 1", async () => {
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
  const searcher = makeFakeSearcher({ status: "ok", results: [result1, result2], unavailableChannels: [] })
  const evidence = buildEvidence([result1, result2])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    complexLoopController: makeFakeComplexLoopController([
      { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "q" } },
      { sufficient: true },
    ]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed")
  const candidates = output.retrievalTrace.finalContextCandidates
  assert.ok(candidates, "complex route must record finalContextCandidates")
  assert.deepEqual(
    candidates!.map((c) => `${c.rank}:${c.documentId}/${c.chunkId}`),
    ["1:d1/c1", "2:d2/c2"],
    "candidates follow the ordered aggregation fed to the assembler"
  )
  assert.equal(candidates![0].evidenceId, evidence[0].id)
  assert.equal(candidates![1].evidenceId, evidence[1].id)
  assert.equal(output.retrievalTrace.finalContextRound, 1)
})

// ---------------------------------------------------------------------------
// PT-02 / PT-03 — the complex route on the REAL retrieval stack.
//
// These are the positive regressions for the audited defect: the scratch
// reproduction `.scratch/pipeline-structure-audit-2026-10-08/reproduce.cjs`
// (`F2_complex_attachment_context_lost`, `F2_complex_web_opt_in_lost`) recorded
// simple = completed with one attachment/web call while complex = insufficient
// with zero calls, because the tool environment dropped the run's session and
// web intent. Here the SAME fixture must complete on the complex route through
// the production Path A (complexLoopController + tool registry + invocation
// boundary + SearcherImpl + RuntimeSearchOperations + real assembler), with
// every source keeping its own provenance.
// ---------------------------------------------------------------------------

type AttachmentChannelArg = ConstructorParameters<typeof SearcherImpl>[1]
type WebChannelArg = ConstructorParameters<typeof SearcherImpl>[3]

function makeAttachmentService() {
  const db = openDb(":memory:")
  const service = new SessionAttachmentService(db, {
    lifecycle: createIngestionLifecycle(db, {
      stageRunner: { run: async () => ({}), close: async () => {} },
      activationMode: "auto",
    }),
  })
  return { db, service }
}

const attachedFile = (name: string, content: string) => ({
  name,
  content: Buffer.from(content, "utf8"),
})

/** Real RuntimeSearchOperations over recording Elasticsearch/embedding stubs. */
function makeKnowledgeOperations() {
  const esRequests: Array<Record<string, unknown>> = []
  const embeddingInputs: string[] = []
  const es = {
    async search(request: Record<string, unknown>) {
      esRequests.push(request)
      return { hits: { hits: [] } }
    },
  }
  const embeddingClient = {
    embeddings: {
      async create(params: { input: string }) {
        embeddingInputs.push(String(params.input))
        return { data: [{ embedding: [0.1, 0.2] }] }
      },
    },
  }
  const operations = new RuntimeSearchOperations({
    es: es as never,
    embeddingClient: embeddingClient as never,
    embeddingModel: "embedding-test",
  })
  return { operations, esRequests, embeddingInputs }
}

/** The real SearcherImpl, wrapped so the options of every search are visible. */
function makeRealStack(extra: { attachments?: AttachmentChannelArg; web?: WebChannelArg } = {}) {
  const { operations, esRequests, embeddingInputs } = makeKnowledgeOperations()
  const searcher = new SearcherImpl(operations, extra.attachments, undefined, extra.web)
  const calls: Array<{ query: Query; options?: SearchOptions }> = []
  const recording: Searcher = {
    async search(query, options) {
      calls.push({ query, options })
      return searcher.search(query, options)
    },
  }
  return { recording, calls, esRequests, embeddingInputs }
}

/** Configured Tavily: an opt-in request with NO URL in any query. */
function makeTavilyWeb(
  rows: Array<{ title?: string; url?: string; content?: string }>,
  behavior: { fail?: boolean } = {}
) {
  const requests: string[] = []
  const web = createWebEvidenceOperations({
    tavilyApiKey: "server-side-key",
    tavilyEndpoint: "https://tavily.test/search",
    tavilyFetchImpl: async (_input, init) => {
      requests.push(String(init?.body ?? ""))
      if (behavior.fail) throw new Error("tavily 503")
      return new Response(JSON.stringify({ results: rows }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
    now: () => new Date("2026-10-08T08:00:00Z"),
  })
  return { web, requests }
}

/** Safe-fetch-backed URL reads (public host allowed, private host denied). */
function makeUrlReadWeb(body = "<title>官网</title><p>网页正文：7 天无理由退款。</p>") {
  const fetched: string[] = []
  const web = createWebEvidenceOperations({
    fetchOptions: {
      resolver: async () => ({ addresses: ["93.184.216.34"] }),
      fetchImpl: async (input) => {
        fetched.push(String(input))
        return new Response(body, { status: 200, headers: { "content-type": "text/html" } })
      },
    },
    now: () => new Date("2026-10-08T09:00:00Z"),
  })
  const deniedWeb = createWebEvidenceOperations({
    fetchOptions: {
      resolver: async () => ({ addresses: ["10.0.0.9"] }),
      fetchImpl: async (input) => {
        fetched.push(String(input))
        return new Response("<p>内网内容</p>", { status: 200 })
      },
    },
    now: () => new Date("2026-10-08T09:00:00Z"),
  })
  return { web, deniedWeb, fetched }
}

/** A draft that cites whatever the real assembler put into its own prompt. */
function makePromptCitingDraft(reply: string) {
  const prompts: string[] = []
  const stream = async function* citingDraft(
    messages: AgentMessage[],
    _signal: AbortSignal
  ): AsyncGenerator<string> {
    const prompt = messages[messages.length - 1].content
    prompts.push(prompt)
    const cited = [...prompt.matchAll(/\[cite:([^\]]+)\]/g)].map((match) => `[cite:${match[1]}]`)
    yield cited.length > 0 ? `${reply} ${cited.join(" ")}` : reply
  }
  return { prompts, stream }
}

function makeComplexRunner(deps: {
  searcher: Searcher
  draft: { prompts: string[]; stream: (messages: AgentMessage[], signal: AbortSignal) => AsyncIterable<string> }
  controller?: ComplexLoopController
  planner?: Planner
  toolRegistry?: ToolRegistry
  validator?: Validator
  replanner?: RePlanner
  toolTimeoutMs?: number
}) {
  return createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => deps.searcher,
    assembler: new ContextAssemblerImpl(),
    validator: deps.validator ?? makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: deps.replanner ?? makeFakeRePlanner([]),
    streamAnswerDraft: deps.draft.stream,
    ...(deps.controller ? { complexLoopController: deps.controller } : {}),
    ...(deps.planner ? { planner: deps.planner } : {}),
    ...(deps.toolRegistry ? { toolRegistry: deps.toolRegistry } : {}),
    ...(deps.toolTimeoutMs !== undefined ? { toolTimeoutMs: deps.toolTimeoutMs } : {}),
  })
}

const productionTools = () => registerBuiltinTools(new ToolRegistry())

const loopThenStop = (query: string, gapQuery?: string) =>
  makeFakeComplexLoopController(
    gapQuery
      ? [
          { sufficient: false, tool: "semantic_lexical_hybrid", args: { query } },
          { sufficient: true },
          { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: gapQuery } },
          { sufficient: true },
        ]
      : [
          { sufficient: false, tool: "semantic_lexical_hybrid", args: { query } },
          { sufficient: true },
        ]
  )

// ---------------------------------------------------------------------------
// PT-02 — session attachments on the complex route
// ---------------------------------------------------------------------------

test("PT-02 AC01/AC07: an empty knowledge scope still reads the run's own attachments through the production tool boundary", async () => {
  const { service } = makeAttachmentService()
  await service.submit("sess-complex", "tenant-test", "subject-test", [
    attachedFile("refund.md", "退款规则：附件资料为七日退款，特殊定制品除外。"),
  ])
  const stack = makeRealStack({ attachments: service })
  const draft = makePromptCitingDraft("按附件资料为七日退款")

  const runner = makeComplexRunner({
    searcher: stack.recording,
    controller: loopThenStop("退款 规则"),
    toolRegistry: productionTools(),
    draft,
  })
  const output = await runner(
    makeRunnerInput({ sessionId: "sess-complex", retrievalScope: { knowledgeBaseIds: [] } })
  )

  assert.equal(output.status, "completed", "the complex route must answer from the session's own attachment")
  assert.equal(stack.esRequests.length, 0, "an explicit empty knowledge scope issues no knowledge query")
  assert.equal(stack.embeddingInputs.length, 0, "not even an embedding call")
  assert.equal(stack.calls.length, 1, "the loop's one tool call reached retrieval")
  assert.deepEqual(stack.calls[0].options?.attachments, { sessionId: "sess-complex" })
  assert.ok(draft.prompts[0].includes("七日退款"), "the attachment fact reaches the generation payload")
  assert.match(draft.prompts[0], /临时引用: 附件 refund\.md/, "labelled as a temporary reference")

  const reference = output.references.find((item) => item.origin === "attachment")
  assert.ok(reference, "the published reference keeps the attachment origin")
  assert.equal(reference?.attachmentSessionId, "sess-complex")
  assert.equal(reference?.source, "附件:refund.md")
})

test("PT-02 AC03: with no attachment and no other permitted source the complex run stays honestly insufficient", async () => {
  const { service } = makeAttachmentService()
  const stack = makeRealStack({ attachments: service })
  const draft = makePromptCitingDraft("不该被使用")

  const runner = makeComplexRunner({
    searcher: stack.recording,
    controller: loopThenStop("退款 规则"),
    toolRegistry: productionTools(),
    draft,
  })
  const output = await runner(
    makeRunnerInput({ sessionId: "sess-with-no-files", retrievalScope: { knowledgeBaseIds: [] } })
  )

  assert.equal(output.status, "insufficient_retrieval")
  assert.equal(stack.esRequests.length, 0, "the empty scope still issues no knowledge query")
  assert.equal(stack.calls.length, 1, "the session was read once")
  assert.deepEqual(stack.calls[0].options?.attachments, { sessionId: "sess-with-no-files" })
  assert.deepEqual(output.references, [], "nothing is invented")
  assert.equal(output.retrievalTrace.degradedReasons, undefined, "an empty session blames no channel")
  assert.equal(draft.prompts.length, 0, "no generation runs over an insufficient retrieval")
})

test("PT-02 AC04: first retrieval, tool iterations and the gap re-check share one bound session, identity and locked scope", async () => {
  const { service } = makeAttachmentService()
  await service.submit("sess-shared", "tenant-test", "subject-test", [
    attachedFile("refund.md", "退款规则：标准商品七日退款。"),
    attachedFile("exceptions.md", "例外说明：特殊定制品不可退款，需下单时确认。"),
  ])
  const stack = makeRealStack({ attachments: service })
  const draft = makePromptCitingDraft("标准商品七日退款，特殊定制品除外")

  const runner = makeComplexRunner({
    searcher: stack.recording,
    controller: loopThenStop("退款 七日", "例外 定制"),
    toolRegistry: productionTools(),
    validator: makeFakeValidator([
      { passed: false, hallucination: false, completeness: false },
      { passed: true, hallucination: false, completeness: true },
    ]),
    replanner: makeFakeRePlanner([[{ text: "例外 定制" }]]),
    draft,
  })
  const retrievalScope = { knowledgeBaseIds: [] }
  const output = await runner(
    makeRunnerInput({ sessionId: "sess-shared", retrievalScope })
  )

  assert.equal(output.status, "completed")
  assert.equal(stack.calls[0].query.text, "退款 七日", "the loop's first/tool retrieval")
  assert.equal(stack.calls[1].query.text, "例外 定制", "and the gap re-check both went through retrieval")
  assert.ok(stack.calls.length >= 2, `initial + gap re-check, got ${stack.calls.length}`)
  for (const call of stack.calls) {
    assert.deepEqual(
      call.options?.attachments,
      { sessionId: "sess-shared" },
      "every search reads the SAME server-bound session"
    )
    assert.deepEqual(call.options?.retrievalScope, retrievalScope, "the locked scope is never rebuilt wider")
    assert.equal(call.options?.accessContext?.tenantId, "tenant-test")
    assert.equal(call.options?.accessContext?.subjectId, "subject-test")
    assert.ok(call.options?.signal, "every search is cancellable")
  }
  assert.ok(draft.prompts.some((prompt) => prompt.includes("不可退款")), "the gap re-check reached the payload")
})

test("PT-02 AC02: a model-named session, another session's file, an unreadable attachment, an unauthorized KB and a disallowed tool never introduce content", async () => {
  const { db, service } = makeAttachmentService()
  await service.submit("sess-victim", "tenant-test", "subject-test", [
    attachedFile("secret.md", "其他会话独有的机密内容：项目编号 Omega。"),
  ])
  await service.submit("sess-bound", "tenant-test", "subject-test", [
    attachedFile("refund.md", "退款规则：标准商品七日退款。"),
  ])
  const retrievalScope = { knowledgeBaseIds: ["kb-mine"] }

  // 1. The controller's args smuggle another session and another knowledge
  //    base. The bound identity must win and the schema must refuse the rest.
  const stack = makeRealStack({ attachments: service })
  const draft = makePromptCitingDraft("标准商品七日退款")
  const smugglingController = makeFakeComplexLoopController([
    {
      sufficient: false,
      tool: "semantic_lexical_hybrid",
      args: { query: "退款 规则", sessionId: "sess-victim", knowledgeBaseIds: ["kb-other"] } as RetrievalToolArgs,
    },
    { sufficient: true },
  ])
  const runner = makeComplexRunner({
    searcher: stack.recording,
    controller: smugglingController,
    toolRegistry: productionTools(),
    draft,
  })
  const output = await runner(makeRunnerInput({ sessionId: "sess-bound", retrievalScope }))

  assert.equal(output.status, "completed")
  assert.equal(stack.calls.length, 1)
  assert.deepEqual(stack.calls[0].options?.attachments, { sessionId: "sess-bound" })
  assert.deepEqual(stack.calls[0].options?.retrievalScope, retrievalScope)
  assert.equal(
    stack.calls[0].options?.channels?.includes("vector"),
    true,
    "the legitimate part of the call still executed"
  )
  assert.ok(draft.prompts[0].includes("七日退款"))
  assert.ok(!draft.prompts[0].includes("Omega"), "another session's attachment is unreachable")
  const esJson = JSON.stringify(stack.esRequests)
  assert.match(esJson, /kb-mine/, "the run reads only its locked knowledge base")
  assert.ok(!esJson.includes("kb-other"), "no argument widens the knowledge scope")

  // 2. An attachment that never became readable (still `parsing`, no chunks)
  //    contributes nothing even though it lives in the bound session.
  new SqliteSessionAttachmentStore(db).insert({
    id: "att-unreadable",
    sessionId: "sess-bound",
    tenantId: "tenant-test",
    subjectId: "subject-test",
    name: "broken.md",
    mimeType: null,
    bytes: 60,
    content: "损坏附件里的内容：编号 Zeta。",
    now: "2026-10-08T00:00:00.000Z",
  })
  const unreadableStack = makeRealStack({ attachments: service })
  const unreadableDraft = makePromptCitingDraft("标准商品七日退款")
  const unreadableRunner = makeComplexRunner({
    searcher: unreadableStack.recording,
    controller: loopThenStop("退款 规则"),
    toolRegistry: productionTools(),
    draft: unreadableDraft,
  })
  const unreadable = await unreadableRunner(
    makeRunnerInput({ sessionId: "sess-bound", retrievalScope: { knowledgeBaseIds: [] } })
  )
  assert.equal(unreadable.status, "completed", "the readable attachment still answers")
  assert.ok(!unreadableDraft.prompts[0].includes("Zeta"), "the unreadable row never enters the payload")
  assert.ok(unreadableDraft.prompts[0].includes("七日退款"))

  // 3. A tool the run does not allow is refused before it can read anything.
  const refusedStack = makeRealStack({ attachments: service })
  const refusedDraft = makePromptCitingDraft("不该出现")
  const refusedRunner = makeComplexRunner({
    searcher: refusedStack.recording,
    // An EMPTY registry: nothing on this run's allowlist exists to execute.
    toolRegistry: new ToolRegistry(),
    controller: loopThenStop("退款 规则"),
    draft: refusedDraft,
  })
  const refused = await refusedRunner(
    makeRunnerInput({ sessionId: "sess-bound", retrievalScope: { knowledgeBaseIds: [] } })
  )
  assert.equal(refusedStack.calls.length, 0, "a refused tool never reaches retrieval")
  assert.equal(refused.status, "insufficient_retrieval", "and the run degrades honestly")
  assert.equal(refusedDraft.prompts.length, 0)
})

test("PT-02 AC05: attachment capability missing, source failure and zero results degrade distinctly", async () => {
  const emptyScope = { knowledgeBaseIds: [] }

  // 1. No attachment capability in this composition at all.
  const capabilityLess = makeRealStack()
  const capabilityRunner = makeComplexRunner({
    searcher: capabilityLess.recording,
    controller: loopThenStop("退款 规则"),
    toolRegistry: productionTools(),
    draft: makePromptCitingDraft("不该出现"),
  })
  const capabilityOutput = await capabilityRunner(
    makeRunnerInput({ sessionId: "sess-complex", retrievalScope: emptyScope })
  )
  assert.equal(capabilityOutput.status, "insufficient_retrieval")
  assert.deepEqual(capabilityOutput.retrievalTrace.degradedReasons, undefined, "absent capability blames no channel")

  // 2. The attachment source itself fails — that is a named degradation.
  const failingAttachments: AttachmentChannelArg = {
    search: async () => {
      throw new Error("attachment store unavailable")
    },
  }
  const failingStack = makeRealStack({ attachments: failingAttachments })
  const failingRunner = makeComplexRunner({
    searcher: failingStack.recording,
    controller: loopThenStop("退款 规则"),
    toolRegistry: productionTools(),
    draft: makePromptCitingDraft("不该出现"),
  })
  const failingOutput = await failingRunner(
    makeRunnerInput({ sessionId: "sess-complex", retrievalScope: emptyScope })
  )
  assert.equal(failingOutput.status, "insufficient_retrieval")
  assert.ok(
    (failingOutput.retrievalTrace.degradedReasons ?? []).includes("attachment unavailable"),
    "a failed source is reported as what it is"
  )

  // 3. Zero results from a healthy source is the third, distinct answer.
  const { service } = makeAttachmentService()
  await service.submit("sess-complex", "tenant-test", "subject-test", [
    attachedFile("refund.md", "退款规则：标准商品七日退款。"),
  ])
  const emptyResultsStack = makeRealStack({ attachments: service })
  const emptyResultsRunner = makeComplexRunner({
    searcher: emptyResultsStack.recording,
    controller: loopThenStop("天气 飞机"),
    toolRegistry: productionTools(),
    draft: makePromptCitingDraft("不该出现"),
  })
  const emptyResults = await emptyResultsRunner(
    makeRunnerInput({ sessionId: "sess-complex", retrievalScope: emptyScope })
  )
  assert.equal(emptyResults.status, "insufficient_retrieval")
  assert.deepEqual(emptyResults.retrievalTrace.degradedReasons, undefined)
})

test("PT-02 AC05: cancellation, the per-tool deadline and the loop's budgets still bound the complex route", async () => {
  // Cancellation mid-tool-search surfaces as the run's single AbortError.
  const runController = new AbortController()
  const { service } = makeAttachmentService()
  await service.submit("sess-abort", "tenant-test", "subject-test", [
    attachedFile("refund.md", "退款规则：标准商品七日退款。"),
  ])
  const abortingStack = makeRealStack({ attachments: service })
  const abortingSearcher: Searcher = {
    async search(query, options) {
      runController.abort()
      return abortingStack.recording.search(query, options)
    },
  }
  const abortRunner = makeComplexRunner({
    searcher: abortingSearcher,
    controller: loopThenStop("退款 规则"),
    toolRegistry: productionTools(),
    draft: makePromptCitingDraft("不该出现"),
  })
  await assert.rejects(
    () => abortRunner(
      makeRunnerInput({ sessionId: "sess-abort", retrievalScope: { knowledgeBaseIds: [] }, signal: runController.signal })
    ),
    (error: Error) => error.name === "AbortError",
    "an abort during a tool search cancels the run"
  )

  // A tool that never answers converges to the bounded timeout terminal.
  const hangingSearcher: Searcher = {
    search: (_query, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          const error = new Error("cancelled")
          error.name = "AbortError"
          reject(error)
        })
      }),
  }
  const timeoutRunner = makeComplexRunner({
    searcher: hangingSearcher,
    controller: loopThenStop("退款 规则"),
    toolRegistry: productionTools(),
    toolTimeoutMs: 25,
    draft: makePromptCitingDraft("不该出现"),
  })
  const timedOut = await timeoutRunner(
    makeRunnerInput({ sessionId: "sess-timeout", retrievalScope: { knowledgeBaseIds: [] } })
  )
  assert.equal(timedOut.status, "provider_error", "the deadline bounds the run")
  assert.equal(timedOut.routeTrace.complexLoopStopReason, "provider-failure")

  // The loop's own tool/iteration budgets still cap the retrieval calls.
  const countingStack = makeRealStack({ attachments: service })
  const budgetController = makeFakeComplexLoopController([
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "退款 一" } },
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "退款 二" } },
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "退款 三" } },
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "退款 四" } },
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "退款 五" } },
  ])
  const budgetRunner = makeComplexRunner({
    searcher: countingStack.recording,
    controller: budgetController,
    toolRegistry: productionTools(),
    draft: makePromptCitingDraft("不该出现"),
  })
  const budgetOutput = await budgetRunner(
    makeRunnerInput({ sessionId: "sess-complex", retrievalScope: { knowledgeBaseIds: [] } })
  )
  assert.equal(budgetOutput.routeTrace.complexLoopIterations, 3, "at most 3 LLM decision iterations")
  assert.ok(countingStack.calls.length <= 3, "and no more searches than iterations")
})

test("PT-02 AC06: the compatibility paths read the same session and keep the temporary label", async () => {
  const { service } = makeAttachmentService()
  await service.submit("sess-compat", "tenant-test", "subject-test", [
    attachedFile("refund.md", "退款规则：标准商品七日退款。"),
  ])

  // 1. Loop WITHOUT the tool registry — the legacy direct-search path of the
  //    loop itself must carry the session.
  const loopStack = makeRealStack({ attachments: service })
  const loopDraft = makePromptCitingDraft("标准商品七日退款")
  const loopRunner = makeComplexRunner({
    searcher: loopStack.recording,
    controller: loopThenStop("退款 规则"),
    draft: loopDraft,
  })
  const loopOutput = await loopRunner(
    makeRunnerInput({ sessionId: "sess-compat", retrievalScope: { knowledgeBaseIds: [] } })
  )
  assert.equal(loopOutput.status, "completed", "the loop's own search must read the session")
  assert.deepEqual(loopStack.calls[0].options?.attachments, { sessionId: "sess-compat" })
  assert.match(loopDraft.prompts[0], /临时引用: 附件 refund\.md/)

  // 2. Planner Path B — the decomposed multi-query flow.
  const plannerStack = makeRealStack({ attachments: service })
  const plannerDraft = makePromptCitingDraft("标准商品七日退款")
  const plannerRunner = makeComplexRunner({
    searcher: plannerStack.recording,
    planner: makeFakePlanner({ queries: [{ text: "退款 规则" }] }),
    draft: plannerDraft,
  })
  const plannerOutput = await plannerRunner(
    makeRunnerInput({ sessionId: "sess-compat", retrievalScope: { knowledgeBaseIds: [] } })
  )
  assert.equal(plannerOutput.status, "completed", "the compatibility planner path reads the session too")
  assert.deepEqual(plannerStack.calls[0].options?.attachments, { sessionId: "sess-compat" })
  assert.ok(plannerDraft.prompts[0].includes("七日退款"))
  const reference = plannerOutput.references.find((item) => item.origin === "attachment")
  assert.ok(reference, "origin + attachment identity survive to the reference")
  assert.equal(reference?.attachmentName, "refund.md")
  assert.equal(reference?.attachmentSessionId, "sess-compat")
  assert.equal(reference?.documentId, reference?.attachmentId, "an attachment id is never presented as a document")
})

// ---------------------------------------------------------------------------
// PT-03 — the run's web-search intent on the complex route
// ---------------------------------------------------------------------------

test("PT-03 AC01/AC02/AC07: useWeb with no URL still requests allowed Web evidence on the complex route", async () => {
  const tavily = makeTavilyWeb([
    { title: "官网退款政策", url: "https://example.com/refund", content: "最新退款规则：30 天无理由。" },
  ])
  const stack = makeRealStack({ web: tavily.web })
  const draft = makePromptCitingDraft("最新规则为 30 天无理由")

  const runner = makeComplexRunner({
    searcher: stack.recording,
    controller: loopThenStop("最新 规则"),
    toolRegistry: productionTools(),
    draft,
  })
  const output = await runner(
    makeRunnerInput({
      sessionId: "sess-web",
      retrievalScope: { knowledgeBaseIds: [] },
      useWeb: true,
    })
  )

  assert.equal(output.status, "completed", "the complex route must be able to use allowed Web evidence")
  assert.equal(stack.calls.length, 1)
  assert.equal(stack.calls[0].options?.webRequested, true, "the run's opt-in reached the tool search")
  assert.equal(tavily.requests.length, 1, "and the configured provider was actually asked")
  assert.match(tavily.requests[0], /最新/, "with the run's own query")
  assert.equal(stack.esRequests.length, 0, "an explicit empty knowledge scope issues no knowledge query")
  assert.ok(draft.prompts[0].includes("30 天无理由"), "the obtained fact reaches the generation payload")

  const reference = output.references.find((item) => item.origin === "web")
  assert.ok(reference, "the reference keeps the Web origin")
  assert.equal(reference?.webUrl, "https://example.com/refund")
  assert.equal(reference?.webFetchedAt, "2026-10-08T08:00:00.000Z", "and the server-side fetch time")
  assert.equal(reference?.attachmentId, undefined, "Web evidence is never a session attachment")
  assert.equal(reference?.attachmentSessionId, undefined)
  assert.ok(!draft.prompts[0].includes("临时引用"), "and is never labelled as one")
  assert.match(draft.prompts[0], /\[来源: https:\/\/example\.com\/refund\]/)
})

test("PT-03 AC03: useWeb false makes no opt-in call, and a URL keeps the existing read/reject policy", async () => {
  // 1. Opt-out and no URL → the provider is never asked.
  const tavily = makeTavilyWeb([
    { title: "官网", url: "https://example.com/refund", content: "不该出现的内容" },
  ])
  const optOutStack = makeRealStack({ web: tavily.web })
  const optOutRunner = makeComplexRunner({
    searcher: optOutStack.recording,
    controller: loopThenStop("退款 规则"),
    toolRegistry: productionTools(),
    draft: makePromptCitingDraft("不该出现"),
  })
  const optOut = await optOutRunner(
    makeRunnerInput({
      sessionId: "sess-web-off",
      retrievalScope: { knowledgeBaseIds: [] },
      useWeb: false,
    })
  )
  assert.deepEqual(tavily.requests, [], "no opt-in and no URL → no Web call")
  assert.equal(optOutStack.calls[0].options?.webRequested, undefined)
  assert.equal(optOut.status, "insufficient_retrieval", "and the run stays honest")

  // 2. A permitted URL in the query is still read — `useWeb: false` is not a
  //    ban on reading what the user supplied.
  const urlRead = makeUrlReadWeb()
  const readStack = makeRealStack({ web: urlRead.web })
  const readDraft = makePromptCitingDraft("网页写明 7 天无理由退款")
  const readRunner = makeComplexRunner({
    searcher: readStack.recording,
    controller: loopThenStop("请看 https://example.com/policy 的 规则"),
    toolRegistry: productionTools(),
    draft: readDraft,
  })
  const read = await readRunner(
    makeRunnerInput({
      sessionId: "sess-url",
      retrievalScope: { knowledgeBaseIds: [] },
      useWeb: false,
    })
  )
  assert.equal(read.status, "completed", "an opt-out run may still read an allowed URL")
  assert.ok(urlRead.fetched.some((url) => url.includes("example.com/policy")))
  assert.ok(readDraft.prompts[0].includes("7 天无理由退款"))

  // 3. A policy-denied URL is refused by the SAME policy — no content, and the
  //    failure is reported instead of faked.
  const deniedStack = makeRealStack({ web: urlRead.deniedWeb })
  const deniedDraft = makePromptCitingDraft("不该出现")
  const deniedRunner = makeComplexRunner({
    searcher: deniedStack.recording,
    controller: loopThenStop("请看 http://intranet.local/policy 的 规则"),
    toolRegistry: productionTools(),
    draft: deniedDraft,
  })
  const denied = await deniedRunner(
    makeRunnerInput({
      sessionId: "sess-denied",
      retrievalScope: { knowledgeBaseIds: [] },
      useWeb: false,
    })
  )
  assert.equal(denied.status, "insufficient_retrieval")
  assert.ok(
    (denied.retrievalTrace.degradedReasons ?? []).includes("web unavailable"),
    "the denied read is reported as a failed source"
  )
  assert.equal(deniedDraft.prompts.length, 0, "no rejected content ever reaches generation")
})

test("PT-03 AC04: a web opt-in never widens the knowledge scope, the session binding or the tool allowlist", async () => {
  const { service } = makeAttachmentService()
  await service.submit("sess-victim", "tenant-test", "subject-test", [
    attachedFile("secret.md", "其他会话独有的机密内容：项目编号 Omega。"),
  ])

  // 1. Web intent does not make a non-allowlisted tool executable.
  const tavilyRefused = makeTavilyWeb([
    { title: "官网", url: "https://example.com/refund", content: "不该通过禁用工具进入" },
  ])
  const refusedStack = makeRealStack({ attachments: service, web: tavilyRefused.web })
  const refusedRunner = makeComplexRunner({
    searcher: refusedStack.recording,
    controller: loopThenStop("最新 规则"),
    toolRegistry: new ToolRegistry(),
    draft: makePromptCitingDraft("不该出现"),
  })
  const refused = await refusedRunner(
    makeRunnerInput({
      sessionId: "sess-web",
      retrievalScope: { knowledgeBaseIds: [] },
      useWeb: true,
    })
  )
  assert.equal(refusedStack.calls.length, 0, "a refused tool never reaches retrieval, web intent or not")
  assert.deepEqual(tavilyRefused.requests, [])
  assert.equal(refused.status, "insufficient_retrieval")

  // 2. With the production registry the intent changes only the Web channel.
  const tavily = makeTavilyWeb([
    { title: "官网退款政策", url: "https://example.com/refund", content: "最新退款规则：30 天。" },
  ])
  const stack = makeRealStack({ attachments: service, web: tavily.web })
  const draft = makePromptCitingDraft("最新退款规则为 30 天")
  const runner = makeComplexRunner({
    searcher: stack.recording,
    controller: loopThenStop("最新 规则"),
    toolRegistry: productionTools(),
    draft,
  })
  const retrievalScope = { knowledgeBaseIds: ["kb-mine"] }
  const output = await runner(
    makeRunnerInput({ sessionId: "sess-bound-web", retrievalScope, useWeb: true })
  )

  assert.equal(output.status, "completed")
  for (const call of stack.calls) {
    assert.deepEqual(call.options?.retrievalScope, retrievalScope, "the KB scope stays locked")
    assert.deepEqual(call.options?.attachments, { sessionId: "sess-bound-web" }, "and the session binding")
    assert.equal(call.options?.webRequested, true)
  }
  const esJson = JSON.stringify(stack.esRequests)
  assert.match(esJson, /kb-mine/, "the knowledge query is still scope-filtered")
  assert.ok(!draft.prompts[0].includes("Omega"), "another session's attachment stays unreachable")
})

test("PT-03 AC05: allowed Web answers an empty scope; missing capability, failure and zero results degrade distinctly", async () => {
  const emptyScope = { knowledgeBaseIds: [] }

  // 1. No Web capability wired → the opt-in changes nothing and blames nothing.
  const capabilityLess = makeRealStack()
  const capabilityRunner = makeComplexRunner({
    searcher: capabilityLess.recording,
    controller: loopThenStop("最新 规则"),
    toolRegistry: productionTools(),
    draft: makePromptCitingDraft("不该出现"),
  })
  const capabilityOutput = await capabilityRunner(
    makeRunnerInput({ sessionId: "sess-web", retrievalScope: emptyScope, useWeb: true })
  )
  assert.equal(capabilityOutput.status, "insufficient_retrieval")
  assert.deepEqual(capabilityOutput.retrievalTrace.degradedReasons, undefined)
  assert.deepEqual(capabilityOutput.references, [])

  // 2. Provider failure → the same honest terminal, with the source named.
  const failing = makeTavilyWeb([], { fail: true })
  const failingStack = makeRealStack({ web: failing.web })
  const failingRunner = makeComplexRunner({
    searcher: failingStack.recording,
    controller: loopThenStop("最新 规则"),
    toolRegistry: productionTools(),
    draft: makePromptCitingDraft("不该出现"),
  })
  const failingOutput = await failingRunner(
    makeRunnerInput({ sessionId: "sess-web", retrievalScope: emptyScope, useWeb: true })
  )
  assert.equal(failingOutput.status, "insufficient_retrieval")
  assert.equal(failing.requests.length, 1, "the run really asked the provider")
  assert.ok(
    (failingOutput.retrievalTrace.degradedReasons ?? []).includes("web unavailable"),
    "a failed provider is reported as a failed source"
  )

  // 3. Zero results → asked, answered, nothing usable.
  const zero = makeTavilyWeb([])
  const zeroStack = makeRealStack({ web: zero.web })
  const zeroRunner = makeComplexRunner({
    searcher: zeroStack.recording,
    controller: loopThenStop("最新 规则"),
    toolRegistry: productionTools(),
    draft: makePromptCitingDraft("不该出现"),
  })
  const zeroOutput = await zeroRunner(
    makeRunnerInput({ sessionId: "sess-web", retrievalScope: emptyScope, useWeb: true })
  )
  assert.equal(zeroOutput.status, "insufficient_retrieval")
  assert.equal(zero.requests.length, 1)
  assert.deepEqual(zeroOutput.references, [])

  // 4. Allowed Web evidence on an empty scope is enough to answer.
  const answered = makeTavilyWeb([
    { title: "官网", url: "https://example.com/refund", content: "最新退款规则：30 天无理由。" },
  ])
  const answeredStack = makeRealStack({ web: answered.web })
  const answeredDraft = makePromptCitingDraft("最新规则 30 天无理由")
  const answeredRunner = makeComplexRunner({
    searcher: answeredStack.recording,
    controller: loopThenStop("最新 规则"),
    toolRegistry: productionTools(),
    draft: answeredDraft,
  })
  const answeredOutput = await answeredRunner(
    makeRunnerInput({ sessionId: "sess-web", retrievalScope: emptyScope, useWeb: true })
  )
  assert.equal(answeredOutput.status, "completed")
  assert.equal(answeredStack.esRequests.length, 0, "and still no knowledge query was issued")
})

test("PT-03 AC06: initial retrieval, the loop and the gap re-check share one web intent, identity and locked scope", async () => {
  const { service } = makeAttachmentService()
  await service.submit("sess-intent", "tenant-test", "subject-test", [
    attachedFile("refund.md", "退款规则：标准商品七日退款。"),
  ])
  const tavily = makeTavilyWeb([
    { title: "官网例外说明", url: "https://example.com/exceptions", content: "例外说明：特殊定制品不可退款。" },
  ])
  const stack = makeRealStack({ attachments: service, web: tavily.web })
  const draft = makePromptCitingDraft("标准商品七日退款，特殊定制品除外")

  const runner = makeComplexRunner({
    searcher: stack.recording,
    controller: loopThenStop("退款 七日", "例外 定制"),
    toolRegistry: productionTools(),
    validator: makeFakeValidator([
      { passed: false, hallucination: false, completeness: false },
      { passed: true, hallucination: false, completeness: true },
    ]),
    replanner: makeFakeRePlanner([[{ text: "例外 定制" }]]),
    draft,
  })
  const retrievalScope = { knowledgeBaseIds: [] }
  const output = await runner(
    makeRunnerInput({ sessionId: "sess-intent", retrievalScope, useWeb: true })
  )

  assert.equal(output.status, "completed")
  assert.ok(stack.calls.length >= 2, `the initial loop and the gap re-check both retrieved (${stack.calls.length})`)
  for (const call of stack.calls) {
    assert.equal(call.options?.webRequested, true, "one intent across every search of the run")
    assert.deepEqual(call.options?.attachments, { sessionId: "sess-intent" })
    assert.deepEqual(call.options?.retrievalScope, retrievalScope)
    assert.ok(call.options?.signal, "and each is cancellable")
  }
  assert.ok(tavily.requests.length >= 1, "the provider was asked with the run's intent")
  assert.ok(output.references.some((item) => item.origin === "web"))
  assert.ok(output.references.some((item) => item.origin === "attachment"))

  // Cancellation still converges to the run's single AbortError.
  const runController = new AbortController()
  const abortStack = makeRealStack({ web: tavily.web })
  const abortingSearcher: Searcher = {
    async search(query, options) {
      runController.abort()
      return abortStack.recording.search(query, options)
    },
  }
  const abortRunner = makeComplexRunner({
    searcher: abortingSearcher,
    controller: loopThenStop("最新 规则"),
    toolRegistry: productionTools(),
    draft: makePromptCitingDraft("不该出现"),
  })
  await assert.rejects(
    () =>
      abortRunner(
        makeRunnerInput({
          sessionId: "sess-abort-web",
          retrievalScope,
          useWeb: true,
          signal: runController.signal,
        })
      ),
    (error: Error) => error.name === "AbortError"
  )
})

test("PT-03 AC07: the compatibility planner path carries the same web intent", async () => {
  const tavily = makeTavilyWeb([
    { title: "官网退款政策", url: "https://example.com/refund", content: "最新退款规则：30 天无理由。" },
  ])
  const stack = makeRealStack({ web: tavily.web })
  const draft = makePromptCitingDraft("最新规则 30 天无理由")
  const runner = makeComplexRunner({
    searcher: stack.recording,
    planner: makeFakePlanner({ queries: [{ text: "最新 退款 规则" }] }),
    draft,
  })
  const output = await runner(
    makeRunnerInput({
      sessionId: "sess-planner-web",
      retrievalScope: { knowledgeBaseIds: [] },
      useWeb: true,
    })
  )

  assert.equal(output.status, "completed", "the compatibility path must honour the intent too")
  assert.equal(stack.calls[0].options?.webRequested, true)
  assert.equal(tavily.requests.length, 1)
  assert.ok(output.references.some((item) => item.origin === "web"))
})

// ---------------------------------------------------------------------------
// PT-05 — the correction (补检) gap-first evidence selection on the complex route
//
// Same audited defect as PT-04 (reproduction `F3_correction_new_evidence_starved`,
// `.scratch/pipeline-structure-audit-2026-10-08/reproduce.cjs`) on the complex
// route: the gap re-check appended its hits to the TAIL of the accumulated
// array and the real `ContextAssemblerImpl` (default 6,000 / 4,500, real
// tokenizer) walks groups in insertion order with a shrinking budget, so the
// old top-10 parent chunks ate every token and the fresh exception never
// reached the second generation prompt. Every test below observes the ACTUAL
// `streamAnswerDraft(messages)` payload, and covers all three correction
// shapes: the production tool loop, its bounded deterministic-searcher
// fallback, and the legacy per-gap-query path.
// ---------------------------------------------------------------------------

const GAP_FRESH_FACT = "新增关键例外：特定商品不可退款。"
const GAP_SECOND_FACT = "新增时效例外：定制商品退款需人工审核。"
const GAP_OLD_SNIPPET = "旧规则：标准商品七日退款。"

function gapChild(id: string, content: string): RetrievalResult {
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

function gapOldParent(id: string, filler: string): RetrievalResult {
  const result = gapChild(id, "旧资料".repeat(40))
  result.parentChunk = {
    ...result.chunk,
    id: `parent-${id}`,
    content: `${result.chunk.content}${filler.repeat(5_000)}`,
    metadata: { kind: "parent", source: `old-parent-${id}` },
  }
  return result
}

function gapOldTop10(): RetrievalResult[] {
  return [
    gapOldParent("old", "甲"),
    ...Array.from({ length: 9 }, (_, index) => gapOldParent(`old-${index}`, "乙")),
  ]
}

/** What a real dedicated reranker reports for one search. */
function gapOk(results: RetrievalResult[]): SearchOutcome {
  return {
    status: "ok",
    results,
    unavailableChannels: [],
    ordering: { source: "dedicated_rerank" },
  }
}

function gapContextOf(prompt: string): string {
  const at = prompt.lastIndexOf("\n\n用户问题：")
  return at < 0 ? prompt : prompt.slice(0, at)
}

/** The loop path: one initial tool call, then the gap tool call in correction. */
function gapLoopController(gapQuery: string): ComplexLoopController {
  return makeFakeComplexLoopController([
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "退款 规则" } },
    { sufficient: true },
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: gapQuery } },
    { sufficient: true },
  ])
}

const gapCorrections: CriticVerdict[] = [
  { passed: false, hallucination: false, completeness: false, missingGap: "查询关键例外" },
  { passed: true, hallucination: false, completeness: true },
]

test("PT-05 AC01/AC02: the production tool loop's 补检 fact reaches the second generation prompt", async () => {
  const oldResults = gapOldTop10()
  const fresh = gapChild("new", GAP_FRESH_FACT)
  const searcher = makeFakeSearcher([gapOk(oldResults), gapOk([fresh])])
  const draft = makePromptCitingDraft("已按补检到的例外回答。")
  const runner = makeComplexRunner({
    searcher,
    controller: gapLoopController("特定商品 不可退款 例外"),
    validator: makeFakeValidator(gapCorrections),
    replanner: makeFakeRePlanner([[{ text: "特定商品 不可退款 例外" }]]),
    draft,
  })
  const output = await runner(makeRunnerInput())

  assert.equal(output.status, "completed")
  assert.equal(searcher.calls.length, 2, "one loop retrieval + one loop 补检: no extra correction round")
  assert.equal(draft.prompts.length, 2)
  assert.equal(
    draft.prompts[0].includes(GAP_FRESH_FACT),
    false,
    "the gap was real: round 1 had no way to know the exception"
  )
  assert.ok(
    draft.prompts[1].includes(GAP_FRESH_FACT),
    "PT-05: the loop's new fact must be in the actual second prompt, not only a candidate id"
  )
  assert.ok(draft.prompts[1].includes("旧资料"), "the remaining budget still fills with older material")
  const candidates = output.retrievalTrace.finalContextCandidates!
  assert.equal(candidates[0].chunkId, "new", "the gap hit leads the ordered candidate list")
  assert.equal(output.retrievalTrace.finalContextRound, 2)
})

test("PT-05 AC01/AC02: the bounded deterministic-searcher fallback also reaches the prompt gap-first", async () => {
  // The correction loop spends its single carried-over iteration on a duplicate
  // tool call, returns 0 results with a non-sufficient stop, and the runner's
  // bounded deterministic `searcher.search` fallback is what finds the fact.
  const oldResults = gapOldTop10()
  const fresh = gapChild("new", GAP_FRESH_FACT)
  const searcher = makeFakeSearcher([gapOk(oldResults), gapOk([fresh])])
  const draft = makePromptCitingDraft("已按回退检索的例外回答。")
  const controller = makeFakeComplexLoopController([
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "退款 规则" } },
    { sufficient: true },
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "退款 规则" } },
  ])
  const runner = makeComplexRunner({
    searcher,
    controller,
    validator: makeFakeValidator(gapCorrections),
    replanner: makeFakeRePlanner([[{ text: "特定商品 不可退款 例外" }]]),
    draft,
  })
  const output = await runner(makeRunnerInput())

  assert.equal(output.status, "completed")
  assert.equal(searcher.calls.length, 2, "loop retrieval + the single deterministic fallback search")
  assert.ok(draft.prompts[1].includes(GAP_FRESH_FACT), "fallback results are gap material too")
  assert.equal(output.retrievalTrace.finalContextCandidates![0].chunkId, "new")
})

test("PT-05 AC02: the legacy per-gap-query correction path applies the same gap-first rule", async () => {
  const oldResults = gapOldTop10()
  const fresh = gapChild("new", GAP_FRESH_FACT)
  const searcher = makeFakeSearcher([gapOk(oldResults), gapOk([fresh])])
  const planner = makeFakePlanner({ queries: [{ text: "退款 规则" }] })
  const draft = makePromptCitingDraft("已按补检到的例外回答。")
  const runner = makeComplexRunner({
    searcher,
    planner,
    validator: makeFakeValidator(gapCorrections),
    replanner: makeFakeRePlanner([[{ text: "特定商品 不可退款 例外" }]]),
    draft,
  })
  const output = await runner(makeRunnerInput())

  assert.equal(output.status, "completed")
  assert.ok(draft.prompts[1].includes(GAP_FRESH_FACT))
  assert.equal(output.retrievalTrace.finalContextCandidates![0].chunkId, "new")
})

test("PT-05 AC03: the corrected complex prompt stays inside the unchanged budget, framing counted", async () => {
  const searcher = makeFakeSearcher([gapOk(gapOldTop10()), gapOk([gapChild("new", GAP_FRESH_FACT)])])
  const draft = makePromptCitingDraft("已按补检到的例外回答。")
  const runner = makeComplexRunner({
    searcher,
    controller: gapLoopController("特定商品 不可退款 例外"),
    validator: makeFakeValidator(gapCorrections),
    replanner: makeFakeRePlanner([[{ text: "特定商品 不可退款 例外" }]]),
    draft,
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed")
  assert.equal(draft.prompts.length, 2)
  for (const [index, prompt] of draft.prompts.entries()) {
    const context = gapContextOf(prompt)
    assert.ok(
      modelTokenCount(context) <= 6_000,
      `complex generation round ${index + 1} must not exceed the configured 6,000 tokens`
    )
    assert.ok(context.includes("[来源:"), "per-group headers are inside the counted budget")
    assert.ok(context.includes("[cite:"), "citation markers are inside the counted budget")
  }
})

test("PT-05 AC04: a gap snippet sharing a parent keeps the new window and the parent is framed once", async () => {
  const sharedParentContent = `${"甲".repeat(3_000)}${GAP_OLD_SNIPPET}${"乙".repeat(3_000)}${GAP_FRESH_FACT}`
  const oldShared = gapChild("old-shared", GAP_OLD_SNIPPET)
  oldShared.chunk.documentId = "doc-shared"
  oldShared.parentChunk = {
    id: "parent-shared",
    documentId: "doc-shared",
    content: sharedParentContent,
    childrenIds: [],
    metadata: { kind: "parent", source: "shared-parent" },
  }
  const gapShared = gapChild("new-shared", GAP_FRESH_FACT)
  gapShared.chunk.documentId = "doc-shared"
  gapShared.parentChunk = oldShared.parentChunk

  const oldResults = [oldShared, ...gapOldTop10()]
  const searcher = makeFakeSearcher([gapOk(oldResults), gapOk([gapShared])])
  const draft = makePromptCitingDraft("已按补检到的例外回答。")
  const runner = makeComplexRunner({
    searcher,
    controller: gapLoopController("特定商品 不可退款 例外"),
    validator: makeFakeValidator(gapCorrections),
    replanner: makeFakeRePlanner([[{ text: "特定商品 不可退款 例外" }]]),
    draft,
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed")

  const secondPrompt = draft.prompts[1]
  assert.ok(secondPrompt.includes(GAP_FRESH_FACT), "the new gap snippet wins the shared parent window")
  assert.ok(secondPrompt.includes(`[cite:${buildEvidence([gapShared])[0].id}]`))
  assert.equal(
    secondPrompt.match(/来源: shared-parent/g)?.length,
    1,
    "one shared parent is framed once: a repeated identity never consumes budget twice"
  )
})

test("PT-05 AC05: repeated identities are chosen once, citations stay stable, multi-gap order replays", async () => {
  const oldResults = gapOldTop10()
  const freshA = gapChild("new-a", GAP_FRESH_FACT)
  const freshB = gapChild("new-b", GAP_SECOND_FACT)
  const duplicateOld = { ...oldResults[3], channels: ["bm25"] as RetrievalResult["source"][] }
  const searcher = makeFakeSearcher([
    gapOk(oldResults),
    gapOk([freshA]),
    gapOk([freshB, duplicateOld]),
  ])
  const planner = makeFakePlanner({ queries: [{ text: "退款 规则" }] })
  const draft = makePromptCitingDraft("已按两条补检例外回答。")
  const runner = makeComplexRunner({
    searcher,
    planner,
    validator: makeFakeValidator(gapCorrections),
    replanner: makeFakeRePlanner([[{ text: "特定商品 不可退款 例外" }, { text: "定制 商品 人工审核" }]]),
    draft,
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed")

  const candidates = output.retrievalTrace.finalContextCandidates!
  const identities = candidates.map((c) => `${c.documentId}\0${c.chunkId}`)
  assert.equal(new Set(identities).size, identities.length, "no identity is offered to the assembler twice")
  assert.equal(identities.length, 12, "10 older chunks + 2 new facts + the re-hit that collapses")
  assert.deepEqual(candidates.slice(0, 2).map((c) => c.chunkId), ["new-a", "new-b"], "gap facts lead in gap-query order")
  assert.equal(output.contextTrace.evidenceCount, 12)
  assert.equal(
    candidates[0].evidenceId,
    buildEvidence([freshA])[0].id,
    "the same identity keeps the same citation across rounds"
  )
  assert.ok(output.references.some((reference) => reference.id === candidates[0].evidenceId))

  // Replay: the same scripted run selects the same context byte for byte.
  const replaySearcher = makeFakeSearcher([
    gapOk(oldResults),
    gapOk([freshA]),
    gapOk([freshB, duplicateOld]),
  ])
  const replayDraft = makePromptCitingDraft("已按两条补检例外回答。")
  const replay = makeComplexRunner({
    searcher: replaySearcher,
    planner: makeFakePlanner({ queries: [{ text: "退款 规则" }] }),
    validator: makeFakeValidator(gapCorrections),
    replanner: makeFakeRePlanner([[{ text: "特定商品 不可退款 例外" }, { text: "定制 商品 人工审核" }]]),
    draft: replayDraft,
  })
  await replay(makeRunnerInput())
  assert.deepEqual(replayDraft.prompts, draft.prompts, "the selection is deterministic and replayable")
})

test("PT-05 AC06: an oversized gap fact is recorded as an omission and never claims coverage", async () => {
  const monster = gapChild("monster", "缺".repeat(8_000))
  const fresh = gapChild("new", GAP_FRESH_FACT)
  const searcher = makeFakeSearcher([gapOk(gapOldTop10()), gapOk([monster, fresh])])
  const planner = makeFakePlanner({ queries: [{ text: "退款 规则" }] })
  const draft = makePromptCitingDraft("补检后仍缺少关键例外。")
  const runner = makeComplexRunner({
    searcher,
    planner,
    validator: makeFakeValidator([
      { passed: false, hallucination: false, completeness: false, missingGap: "查询关键例外" },
      { passed: false, hallucination: false, completeness: false, missingGap: "查询关键例外" },
    ]),
    replanner: makeFakeRePlanner([[{ text: "特定商品 不可退款 例外" }], []]),
    draft,
  })
  const output = await runner(makeRunnerInput())

  assert.equal(output.status, "insufficient_evidence", "the existing validation rules still decide the terminal")
  assert.deepEqual(output.references, [], "no coverage claim survives")
  const omissions = output.contextTrace.gapFactOmissions
  assert.ok(omissions && omissions.length === 1, "the un-fittable gap fact is recorded explicitly")
  assert.equal(omissions![0].chunkId, "monster")
  assert.equal(omissions![0].reason, "context_budget")
  assert.equal(omissions![0].evidenceId, buildEvidence([monster])[0].id)
  assert.ok(
    draft.prompts[1].includes(GAP_FRESH_FACT),
    "an oversized gap hit does not displace the other new facts of the same round"
  )
})

test("PT-05 AC07: compression retains the new fact; a compressed context that lost it does not close the round", async () => {
  const oldResults = gapOldTop10()
  const fresh = gapChild("new", GAP_FRESH_FACT)
  const freshId = buildEvidence([fresh])[0].id
  const planner = makeFakePlanner({ queries: [{ text: "退款 规则" }] })

  const buildCompressed = (ids: string[], body: string) => ({
    context: ["以下是从知识库中找到的相关文档片段：", ...ids.map((id) => `[cite:${id}] [来源: compressed.md]`), body].join("\n"),
    tokenCount: 1_000,
    retainedEvidenceIds: ids,
    droppedEvidenceIds: ids.length === 0 ? [freshId] : [],
    inputTokens: 9_000,
    outputTokens: 400,
  })
  const makeCompressor = (
    build: (evidence: Evidence[]) => ContextCompressionResult | null
  ): ContextCompressor & { calls: number } => {
    let calls = 0
    return {
      get calls(): number {
        return calls
      },
      async compress(evidence: Evidence[]): Promise<ContextCompressionResult | null> {
        calls += 1
        return build(evidence)
      },
    }
  }

  const complexWithCompressor = (compressor: ContextCompressor, draft: { prompts: string[]; stream: (messages: AgentMessage[], signal: AbortSignal) => AsyncIterable<string> }) =>
    createComplexKnowledgeMastraRunner({
      router: makeFakeRouter("complex"),
      createSearcher: () => makeFakeSearcher([gapOk(oldResults), gapOk([fresh])]),
      // REAL default assembler: the deterministic fallback is what has to keep
      // the fact when compression loses it.
      assembler: new ContextAssemblerImpl(),
      validator: makeFakeValidator(gapCorrections),
      replanner: makeFakeRePlanner([[{ text: "特定商品 不可退款 例外" }]]),
      streamAnswerDraft: draft.stream,
      planner,
      compressor,
    })

  // (a) the compressed output carries the fact → adopted.
  const keptDraft = makePromptCitingDraft("压缩后的回答。")
  const kept = await complexWithCompressor(
    makeCompressor((evidence) => buildCompressed(evidence.map(({ id }) => id), "压缩摘要：七日退款与关键例外。")),
    keptDraft
  )(makeRunnerInput())
  assert.equal(kept.status, "completed")
  assert.equal(kept.contextTrace.compressionRan, true)
  assert.equal(kept.contextTrace.compressionRejectedForGapLoss, undefined)
  assert.ok(keptDraft.prompts[1].includes(`[cite:${freshId}]`), "the compressed prompt keeps the selected new fact's identity")
  assert.ok(keptDraft.prompts[1].includes("压缩摘要"))
  // Adoption only proves citation lineage. This compressed body keeps the
  // citation but not the fact's own wording, so the record must state the
  // coverage is unverified instead of letting it read as closed (PT-05 AC07).
  assert.ok(
    (kept.contextTrace.gapFactOmissions ?? []).some(
      (omission) =>
        omission.reason === "compression" &&
        (omission as { evidenceId?: string }).evidenceId === freshId
    ),
    `lineage-only adoption must record an unverified gap fact, got ${JSON.stringify(kept.contextTrace.gapFactOmissions)}`
  )

  // (b) the compressed output dropped it → not a closed correction round.
  const lossyDraft = makePromptCitingDraft("压缩后的回答。")
  const lossy = await complexWithCompressor(
    makeCompressor(() => buildCompressed([buildEvidence([oldResults[0]])[0].id], "压缩摘要：只有旧规则。")),
    lossyDraft
  )(makeRunnerInput())
  assert.equal(lossy.contextTrace.compressionRan, false, "a lossy compression is not a closed correction round")
  assert.equal(lossy.contextTrace.compressionRejectedForGapLoss, true)
  assert.ok(
    lossyDraft.prompts[1].includes(GAP_FRESH_FACT),
    "the fact survives through the deterministic context"
  )
  assert.equal(lossyDraft.prompts[1].includes("只有旧规则"), false)

  // (c) provider failure keeps the fact through the same fallback.
  const failedDraft = makePromptCitingDraft("压缩后的回答。")
  const failed = await complexWithCompressor(
    {
      async compress(): Promise<ContextCompressionResult | null> {
        throw new Error("compressor unavailable")
      },
    },
    failedDraft
  )(makeRunnerInput())
  assert.equal(failed.contextTrace.compressionRan, false)
  assert.ok(failedDraft.prompts[1].includes(GAP_FRESH_FACT), "the compression-failure fallback retains the new facts")
})

test("PT-05 AC08: no new evidence and provider failure stay bounded and never claim a correction", async () => {
  // (a) the loop and its deterministic fallback both find nothing new.
  const searcher = makeFakeSearcher([
    gapOk(gapOldTop10()),
    gapOk([]),
  ])
  const emptyDraft = makePromptCitingDraft("补检无果。")
  const emptyRunner = makeComplexRunner({
    searcher,
    controller: makeFakeComplexLoopController([
      { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "退款 规则" } },
      { sufficient: true },
      { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "退款 规则" } },
    ]),
    validator: makeFakeValidator(gapCorrections),
    replanner: makeFakeRePlanner([[{ text: "特定商品 不可退款 例外" }]]),
    draft: emptyDraft,
  })
  const emptyOutput = await emptyRunner(makeRunnerInput())
  assert.equal(emptyOutput.status, "insufficient_evidence")
  assert.equal(searcher.calls.length, 2, "the duplicate loop call executes no search; only the bounded deterministic fallback does")
  assert.equal(emptyDraft.prompts.length, 1, "a correction that produced nothing never regenerates")
  assert.equal(emptyOutput.contextTrace.gapFactOmissions, undefined, "an empty 补检 may not report gap coverage")
  assert.equal(emptyOutput.retrievalTrace.finalContextRound, 1, "the observation stays on the published round")
  assert.deepEqual(emptyOutput.references, [])

  // (b) the fallback search itself failed: the run stops bounded, the locked
  // scope of the run is what the 补检 reads, and nothing regenerates.
  const retrievalScope = { knowledgeBaseIds: ["kb-policies"] }
  const calls: Array<{ query: Query; options?: SearchOptions }> = []
  const failingSearcher: Searcher & { calls: typeof calls } = {
    calls,
    async search(query: Query, options?: SearchOptions): Promise<SearchOutcome> {
      calls.push({ query, options })
      if (calls.length > 1) throw new Error("provider unavailable")
      return gapOk(gapOldTop10())
    },
  }
  const failingDraft = makePromptCitingDraft("补检失败。")
  const failingRunner = makeComplexRunner({
    searcher: failingSearcher,
    planner: makeFakePlanner({ queries: [{ text: "退款 规则" }] }),
    validator: makeFakeValidator(gapCorrections),
    replanner: makeFakeRePlanner([[{ text: "特定商品 不可退款 例外" }]]),
    draft: failingDraft,
  })
  await assert.rejects(
    () => failingRunner(makeRunnerInput({ retrievalScope })),
    /provider unavailable/
  )
  assert.equal(calls.length, 2, "one initial search + one gap search, then the run stops")
  assert.equal(failingDraft.prompts.length, 1, "a failed 补检 never regenerates")
  for (const call of calls) {
    assert.equal(call.options?.retrievalScope, retrievalScope, "the gap-first retry never widens the read")
  }
})

test("PT-05 AC09: complex gap-first selection is labelled as an aggregation, never a dedicated rerank", async () => {
  const searcher = makeFakeSearcher([gapOk(gapOldTop10()), gapOk([gapChild("new", GAP_FRESH_FACT)])])
  const draft = makePromptCitingDraft("已按补检到的例外回答。")
  const runner = makeComplexRunner({
    searcher,
    planner: makeFakePlanner({ queries: [{ text: "退款 规则" }] }),
    validator: makeFakeValidator(gapCorrections),
    replanner: makeFakeRePlanner([[{ text: "特定商品 不可退款 例外" }]]),
    draft,
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed")
  // Every contributing search reported `dedicated_rerank`; the published order
  // is the runner's gap-first merge, so the label must not claim a reranker.
  assert.deepEqual(output.retrievalTrace.finalContextOrdering, {
    source: "fused",
    reason: "multi_query_aggregation",
  })
  assert.equal(output.retrievalTrace.finalContextCandidates![0].chunkId, "new")
})

test("PT-04 AC05/PT-05 AC02: both routes apply ONE gap-first rule, not two divergent copies", async () => {
  const oldResults = gapOldTop10()
  const fresh = gapChild("new", GAP_FRESH_FACT)
  const second = gapChild("new-b", GAP_SECOND_FACT)

  const complexSearcher = makeFakeSearcher([gapOk(oldResults), gapOk([fresh]), gapOk([second])])
  const complexDraft = makePromptCitingDraft("两条补检例外。")
  const complexOutput = await makeComplexRunner({
    searcher: complexSearcher,
    planner: makeFakePlanner({ queries: [{ text: "退款 规则" }] }),
    validator: makeFakeValidator(gapCorrections),
    replanner: makeFakeRePlanner([[{ text: "特定商品 不可退款 例外" }, { text: "定制 商品 人工审核" }]]),
    draft: complexDraft,
  })(makeRunnerInput())

  const simpleSearcher = makeFakeSearcher([gapOk(oldResults), gapOk([fresh]), gapOk([second])])
  const simpleDraft = makePromptCitingDraft("两条补检例外。")
  const simpleOutput = await createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => simpleSearcher,
    assembler: new ContextAssemblerImpl(),
    validator: makeFakeValidator(gapCorrections),
    replanner: makeFakeRePlanner([[{ text: "特定商品 不可退款 例外" }, { text: "定制 商品 人工审核" }]]),
    streamAnswerDraft: simpleDraft.stream,
  })(makeRunnerInput())

  assert.equal(complexOutput.status, "completed")
  assert.equal(simpleOutput.status, "completed")
  assert.deepEqual(
    complexOutput.retrievalTrace.finalContextCandidates!.map((c) => `${c.documentId}/${c.chunkId}`),
    simpleOutput.retrievalTrace.finalContextCandidates!.map((c) => `${c.documentId}/${c.chunkId}`),
    "the same gap-first selection must produce the same ordered candidates on both routes"
  )
  assert.deepEqual(
    gapContextOf(complexDraft.prompts[1]),
    gapContextOf(simpleDraft.prompts[1]),
    "and therefore the same actual generation context"
  )
  assert.ok(complexDraft.prompts[1].includes(GAP_FRESH_FACT))
  assert.ok(simpleDraft.prompts[1].includes(GAP_FRESH_FACT))
})

// ---------------------------------------------------------------------------
// PT-07 — the complex route on the COMPLETE authorized material and the REAL
// budget
//
// The audited defect (reproduction `F4_compression_budget_uses_preview`,
// `.scratch/pipeline-structure-audit-2026-10-08/reproduce.cjs`) was that the
// 600-character public display preview was the accounting unit: the audit
// measured a ~3,854-token preview against 30,000 tokens of parent material and
// recorded `compressionCalls: 0`, because an oversized parent looked cheap
// behind its preview. The complex runner reproduced exactly that: it assembled
// a string and then called `compressor.compress(evidence)` unconditionally, an
// entry point that bypasses on the preview sum — so neither the trigger nor the
// text the model was shown came from the material.
//
// Every test below drives the REAL `ContextAssemblerImpl` and, where a
// compressor is wired, the REAL `ContextCompressorImpl` over a recording fake
// client, and asserts on the ACTUAL `streamAnswerDraft(messages)` payload —
// never on a candidate id or a source-code match.
// ---------------------------------------------------------------------------

const PT07_TAIL_A = "尾部关键例外：特定商品不适用无理由退款。"
const PT07_TAIL_B = "尾部时效例外：定制商品退款需人工审核。"

function pt07Child(id: string, content: string, attachment = false): RetrievalResult {
  return {
    chunk: {
      id,
      documentId: `doc-${id}`,
      content,
      childrenIds: [],
      metadata: {
        kind: "child",
        source: `${id}.md`,
        ...(attachment ? { origin: "attachment" } : {}),
      },
    },
    source: "vector",
    score: 0.9,
    wikilinks: [],
  }
}

/** The real ingestion shape: the parent block carries its child snippet. */
function pt07UnderParent(
  result: RetrievalResult,
  head = "甲".repeat(3_000),
  foot = "乙".repeat(3_000)
): RetrievalResult {
  result.parentChunk = {
    id: `parent-${result.chunk.id}`,
    documentId: result.chunk.documentId,
    content: `${head}${result.chunk.content}${foot}`,
    childrenIds: [],
    metadata: { kind: "parent", source: `parent-${result.chunk.id}.md` },
  }
  return result
}

/**
 * Material whose per-parent candidate windows need ~9,200 tokens — over the
 * unchanged 6,000 budget — while the sum of the two 600-character public
 * previews is only ~3,800. This is the F4 shape at complex-route scale.
 */
function pt07OverBudgetMaterial(): RetrievalResult[] {
  return [
    pt07UnderParent(pt07Child("o1", `${"背景".repeat(350)}${PT07_TAIL_A}`)),
    pt07UnderParent(pt07Child("o2", `${"说明".repeat(350)}${PT07_TAIL_B}`)),
  ]
}

/** Byte-for-byte the audited reproduction fixture (parents that do NOT carry the child). */
function pt07F4Material(): RetrievalResult[] {
  const a = pt07Child("budget-a", `${"背景".repeat(350)}尾部关键例外甲`)
  a.parentChunk = {
    ...a.chunk,
    id: "parent-a",
    content: "甲".repeat(5_000),
    metadata: { kind: "parent", source: "parent-a" },
  }
  const b = pt07Child("budget-b", `${"说明".repeat(350)}尾部关键例外乙`)
  b.parentChunk = {
    ...b.chunk,
    id: "parent-b",
    content: "乙".repeat(5_000),
    metadata: { kind: "parent", source: "parent-b" },
  }
  return [a, b]
}

/** Material the deterministic assembler already fits: compression must cost nothing. */
function pt07FittingMaterial(): RetrievalResult[] {
  return [
    pt07Child("fit-1", "标准商品七日退款。"),
    pt07Child("fit-2", "定制商品需人工审核。"),
  ]
}

/** A `ContextCompressorImpl` over a client that records every compression prompt. */
function makeRecordingCompressor(
  behavior: {
    content?: (call: number) => string
    throwOnCall?: boolean
    abortOnCall?: boolean
  } = {}
) {
  const prompts: string[] = []
  let calls = 0
  const client = {
    chat: {
      completions: {
        create: async (request: any, init?: any): Promise<any> => {
          calls += 1
          if (behavior.abortOnCall || init?.signal?.aborted) {
            const err = new Error("compression cancelled")
            err.name = "AbortError"
            throw err
          }
          prompts.push(
            (request.messages ?? []).map((m: any) => String(m.content)).join("\n")
          )
          if (behavior.throwOnCall) throw new Error("compressor provider down")
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content:
                    behavior.content?.(calls) ??
                    `压缩摘要${calls}：不可退款（特定商品）；30 天内；仅当未拆封。`,
                },
                finish_reason: "stop",
                index: 0,
              },
            ],
            usage: { prompt_tokens: 1_200, completion_tokens: 40, total_tokens: 1_240 },
            id: `mock-${calls}`,
            model: "mock-model",
            object: "chat.completion",
            created: 0,
          }
        },
      },
    },
  }
  const compressor = new ContextCompressorImpl(client as never, "mock-model")
  return {
    compressor: compressor as ContextCompressor,
    prompts,
    get calls(): number {
      return calls
    },
  }
}

function pt07Runner(deps: {
  searcher: Searcher
  draft: { prompts: string[]; stream: (messages: AgentMessage[], signal: AbortSignal) => AsyncIterable<string> }
  compressor?: ContextCompressor
  assembler?: ContextAssembler
  controller?: ComplexLoopController
  planner?: Planner
  validator?: Validator
  replanner?: RePlanner
}) {
  return createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => deps.searcher,
    assembler: deps.assembler ?? new ContextAssemblerImpl(),
    validator:
      deps.validator ??
      makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: deps.replanner ?? makeFakeRePlanner([]),
    streamAnswerDraft: deps.draft.stream,
    ...(deps.compressor ? { compressor: deps.compressor } : {}),
    ...(deps.controller ? { complexLoopController: deps.controller } : {}),
    ...(deps.planner ? { planner: deps.planner } : {}),
  })
}

/** Path A with one retrieval; the loop stops as soon as it has the material. */
const pt07Loop = () => loopThenStop("退款 例外")
const pt07Planner = () => makeFakePlanner({ queries: [{ text: "退款 例外" }] })

function pt07AbortError(): Error {
  const err = new Error("Answer run cancelled")
  err.name = "AbortError"
  return err
}

test("PT-07 AC01: the 600-character tail exception reaches the complex prompt and the selected compression input", async () => {
  const results = pt07OverBudgetMaterial()

  // (a) deterministic branch, no compressor wired: the tail past character 600
  // is in the text the model is actually shown.
  const detDraft = makePromptCitingDraft("按尾部例外回答。")
  const det = await pt07Runner({
    searcher: makeFakeSearcher(gapOk(results)),
    draft: detDraft,
    controller: pt07Loop(),
  })(makeRunnerInput())
  assert.equal(det.status, "completed")
  const detContext = gapContextOf(detDraft.prompts[0])
  assert.ok(
    detContext.includes(PT07_TAIL_A),
    "PT-07: the fact after character 600 must be in the real complex prompt, not only a candidate id"
  )

  // (b) compressed branch: the compression INPUT is built from the complete
  // chosen snippet, so the tail is what the summarizer reads.
  const rec = makeRecordingCompressor()
  const compDraft = makePromptCitingDraft("压缩后回答。")
  const compressed = await pt07Runner({
    searcher: makeFakeSearcher(gapOk(results)),
    draft: compDraft,
    controller: pt07Loop(),
    compressor: rec.compressor,
  })(makeRunnerInput())
  assert.equal(compressed.status, "completed")
  assert.ok(rec.calls > 0, "the material exceeds the budget, so compression is attempted")
  assert.ok(
    rec.prompts.some((prompt) => prompt.includes(PT07_TAIL_A)),
    "the compressor saw the tail of group 1's chosen snippet"
  )
  assert.ok(
    rec.prompts.some((prompt) => prompt.includes(PT07_TAIL_B)),
    "and the tail of group 2's"
  )

  // (c) the PUBLIC reference preview stays a preview and gains no body.
  assert.ok(det.references.length > 0)
  for (const reference of det.references) {
    const previewText = JSON.stringify(reference)
    assert.equal(
      previewText.includes(PT07_TAIL_A),
      false,
      "the short public preview must not silently become the full body"
    )
  }
})

test("PT-07 AC02: raw parent, candidate window and final output are three separate counts and the preview is not the accounting unit", async () => {
  const results = pt07F4Material()
  const evidence = buildEvidence(results)
  const preview = computeContextBudget(evidence)
  const draft = makePromptCitingDraft("按尾部例外回答。")
  const output = await pt07Runner({
    searcher: makeFakeSearcher(gapOk(results)),
    draft,
    controller: pt07Loop(),
  })(makeRunnerInput())

  assert.equal(output.status, "completed")
  const decision = output.contextTrace.compressionDecision!
  // COUNT 1 — the complete authorized parent blocks: the audited 30,000.
  assert.equal(decision.rawTokens, 30_000)
  // COUNT 2 — the text left after the per-parent window, reported separately.
  assert.equal(typeof decision.candidateTokens, "number")
  assert.ok(decision.candidateTokens! > 0)
  assert.notEqual(
    decision.candidateTokens,
    decision.rawTokens,
    "the window and the raw parent are different numbers and must not collapse"
  )
  // COUNT 3 — the exact formatted output handed to the generator.
  assert.equal(decision.finalTokens, modelTokenCount(gapContextOf(draft.prompts[0])))
  assert.equal(output.contextTrace.contextTokenCount, decision.finalTokens)

  // The preview the old code measured against is a different, much smaller
  // number and is no longer what the run is decided on (finding F4).
  assert.ok(preview.uncompressedTokens < 6_000)
  assert.equal(preview.overBudget, false)
  assert.notEqual(decision.rawTokens, preview.uncompressedTokens)
  assert.ok(
    decision.rawTokens! > decision.finalTokens,
    "30,000 tokens of parent material behind an output the budget walk could admit"
  )
  // The tail of the material is in the real prompt.
  assert.ok(gapContextOf(draft.prompts[0]).includes("尾部关键例外甲"))
})

test("PT-07 AC03/F4 positive regression: compression is decided on the material, so the audited oversized parent now compresses instead of silently bypassing", async () => {
  const results = pt07OverBudgetMaterial()
  const evidence = buildEvidence(results)

  // The audited precondition: the preview sum says "fits" — which is exactly
  // why the reproduction recorded `compressionCalls: 0`.
  assert.equal(previewContextBudget(evidence).overBudget, false)
  assert.ok(previewContextBudget(evidence).uncompressedTokens < 6_000)

  // The defect must be gone on the COMPLEX route: the same material measured on
  // its candidate windows does exceed the same budget.
  const rec = makeRecordingCompressor()
  const draft = makePromptCitingDraft("压缩后回答。")
  const output = await pt07Runner({
    searcher: makeFakeSearcher(gapOk(results)),
    draft,
    controller: pt07Loop(),
    compressor: rec.compressor,
  })(makeRunnerInput())

  assert.equal(output.status, "completed")
  const decision = output.contextTrace.compressionDecision!
  assert.equal(decision.maxContextTokens, 6_000, "the SAME budget, never raised")
  assert.equal(decision.overBudget, true)
  assert.equal(decision.outcome, "compressed")
  assert.equal(decision.modelCallMade, true)
  assert.ok(rec.calls > 0, "F4 is gone: the oversized material is compressed, not bypassed")
  assert.equal(output.contextTrace.compressionRan, true)
  assert.ok(
    modelTokenCount(gapContextOf(draft.prompts[0])) <= 6_000,
    "the compressed context the generator received is inside the budget"
  )

  // And a material that genuinely fits still costs no model call at all.
  const fitting = makeRecordingCompressor()
  const fitDraft = makePromptCitingDraft("简短回答。")
  const fitOutput = await pt07Runner({
    searcher: makeFakeSearcher(gapOk(pt07FittingMaterial())),
    draft: fitDraft,
    controller: pt07Loop(),
    compressor: fitting.compressor,
  })(makeRunnerInput())
  assert.equal(fitOutput.status, "completed")
  assert.equal(fitting.calls, 0, "within budget ⇒ no compression call")
  assert.equal(fitOutput.contextTrace.compressionRan, false)
  assert.equal(fitOutput.contextTrace.compressionDecision!.outcome, "within_budget")
  assert.equal(fitOutput.contextTrace.compressionDecision!.modelCallMade, false)
  assert.equal(fitOutput.contextTrace.compressionDecision!.overBudget, false)
  assert.ok(gapContextOf(fitDraft.prompts[0]).includes("标准商品七日退款"))
})

test("PT-07 AC04: deterministic, compressed and fallback contexts stay inside the budget with headers, citations and the temporary-attachment note counted", async () => {
  const over = pt07OverBudgetMaterial()

  // (a) deterministic branch.
  const detDraft = makePromptCitingDraft("确定性回答。")
  const det = await pt07Runner({
    searcher: makeFakeSearcher(gapOk(over)),
    draft: detDraft,
    controller: pt07Loop(),
  })(makeRunnerInput())
  const detContext = gapContextOf(detDraft.prompts[0])
  assert.ok(detContext.startsWith(CONTEXT_INTRO))
  assert.ok(detContext.includes("[来源:"), "per-group headers are inside the counted budget")
  assert.ok(detContext.includes("[cite:"), "citation markers are inside the counted budget")
  assert.ok(modelTokenCount(detContext) <= 6_000)

  // (b) compressed branch.
  const rec = makeRecordingCompressor()
  const compDraft = makePromptCitingDraft("压缩后回答。")
  await pt07Runner({
    searcher: makeFakeSearcher(gapOk(over)),
    draft: compDraft,
    controller: pt07Loop(),
    compressor: rec.compressor,
  })(makeRunnerInput())
  const compContext = gapContextOf(compDraft.prompts[0])
  assert.ok(compContext.includes("[cite:"), "a compressed context keeps its citation headers")
  assert.ok(modelTokenCount(compContext) <= 6_000)

  // (c) fallback branch: the compressed output was refused, so the run falls
  // back to the deterministic text — still inside the budget.
  const huge = makeRecordingCompressor({ content: () => "长".repeat(4_000) })
  const fbDraft = makePromptCitingDraft("回退回答。")
  const fb = await pt07Runner({
    searcher: makeFakeSearcher(gapOk(over)),
    draft: fbDraft,
    controller: pt07Loop(),
    compressor: huge.compressor,
  })(makeRunnerInput())
  assert.equal(fb.contextTrace.compressionDecision!.outcome, "still_over_budget")
  assert.equal(fb.contextTrace.compressionRan, false)
  assert.ok(modelTokenCount(gapContextOf(fbDraft.prompts[0])) <= 6_000)

  // (d) a temporary attachment set: the honest note is part of EVERY
  // representation of the budget, and the walk still has to drop material.
  const attachments = Array.from({ length: 8 }, (_, index) =>
    pt07Child(`att-${index}`, `${"附件正文".repeat(150)}附件尾部条件${index}`, true)
  )
  const attDraft = makePromptCitingDraft("附件回答。")
  const att = await pt07Runner({
    searcher: makeFakeSearcher(gapOk(attachments)),
    draft: attDraft,
    controller: pt07Loop(),
  })(makeRunnerInput())
  const attContext = gapContextOf(attDraft.prompts[0])
  assert.ok(
    attContext.includes(TEMPORARY_CONTEXT_NOTE),
    "the temporary-attachment note is in the text that is being counted"
  )
  assert.ok(attContext.includes("[临时引用: 附件"), "and attachments are never labelled as knowledge")
  assert.ok(modelTokenCount(attContext) <= 6_000)
  assert.ok(
    (att.contextTrace.compressionDecision!.omittedCount ?? 0) >= 1,
    "the note's cost is part of the budget that pushed material out"
  )
  assert.equal(att.status, "completed")
})

test("PT-07 AC05: the source records carry the spans and order of the real output, and a window-dropped child is never an adopted entry", async () => {
  const results = pt07OverBudgetMaterial()
  const evidence = buildEvidence(results)
  const draft = makePromptCitingDraft("确定性回答。")
  const output = await pt07Runner({
    searcher: makeFakeSearcher(gapOk(results)),
    draft,
    controller: pt07Loop(),
  })(makeRunnerInput())

  const context = gapContextOf(draft.prompts[0])
  const snapshot = output.contextTrace.generationContext!
  assert.equal(snapshot.generationRound, 1, "one real generation call, one snapshot")

  // Spans and order match the actual string.
  assert.ok(snapshot.entries.length > 0)
  let previousStart = -1
  for (const entry of snapshot.entries) {
    assert.ok(entry.span, "a deterministic entry reports its span in the real output")
    const text = context.slice(entry.span!.start, entry.span!.end)
    assert.ok(text.length > 0, "an adopted entry carries text")
    assert.ok(entry.span!.end > entry.span!.start)
    assert.ok(entry.outputOrder >= 1)
    assert.ok(entry.span!.start >= previousStart, "entries are in real output order")
    previousStart = entry.span!.start
  }

  // A candidate whose snippet the window could not carry stays a candidate.
  const dropped = evidence.find((item) => item.chunkId === "o2")!
  assert.ok(
    output.retrievalTrace.finalContextCandidates!.some((c) => c.chunkId === "o2"),
    "the dropped child is still an ordered CANDIDATE of the round"
  )
  assert.equal(
    snapshot.entries.some((entry) => entry.evidenceId === dropped.id),
    false,
    "a window-dropped child is never listed as adopted just because a candidate carried its id"
  )
  assert.ok(
    snapshot.omissions.some((omission) => omission.evidenceId === dropped.id),
    "and its absence is recorded with a reason"
  )
  assert.equal(context.includes(PT07_TAIL_B), false, "the omission really reflects the text")
  assert.equal(snapshot.representation, "deterministic_partial")
})

test("PT-07 AC06: the compression input keeps the authorized identity and the complete chosen snippet, and the output records its non-empty blocks", async () => {
  const results = pt07OverBudgetMaterial()
  const evidence = buildEvidence(results)
  const rec = makeRecordingCompressor()
  const draft = makePromptCitingDraft("压缩后回答。")
  const output = await pt07Runner({
    searcher: makeFakeSearcher(gapOk(results)),
    draft,
    // Path B here: on Path A the loop's own observation compression adds a
    // second pass over the same groups, which would blur the exact
    // one-call-per-group count asserted below.
    planner: pt07Planner(),
    compressor: rec.compressor,
  })(makeRunnerInput())

  assert.equal(output.contextTrace.compressionDecision!.outcome, "compressed")
  // Authorized identity travels with every group's input, and the body the
  // model is shown is the complete snippet rather than the 600-character preview.
  assert.equal(rec.prompts.length, evidence.length)
  for (const prompt of rec.prompts) {
    const named = evidence.find((item) => prompt.includes(`证据ID:${item.id}`))
    assert.ok(named, "each compression prompt names the Evidence identity it compresses")
    assert.ok(prompt.includes("来源:"), "and the source identity it came from")
    const body = prompt.slice(prompt.indexOf("文档片段:") + "文档片段:".length)
    assert.ok(body.length > 600, "the model is shown more than the public preview")
  }
  // Negations, numbers, conditions and the key exception survive into the text
  // the generator is handed.
  const context = gapContextOf(draft.prompts[0])
  assert.ok(context.includes("不可退款"), "negation preserved")
  assert.ok(context.includes("30 天"), "number preserved")
  assert.ok(context.includes("仅当未拆封"), "condition preserved")

  // Every adopted entry names the non-empty output block it came from.
  const snapshot = output.contextTrace.generationContext!
  assert.equal(snapshot.representation, "compressed")
  assert.equal(snapshot.generationRound, 1)
  const indexes: number[] = []
  for (const entry of snapshot.entries) {
    assert.equal(entry.representation, "compressed")
    assert.ok(entry.compressedBlockIndex !== undefined, "a compressed entry must name its block")
    assert.ok(entry.tokens > 0, "and only a NON-EMPTY block is an adopted entry")
    indexes.push(entry.compressedBlockIndex!)
  }
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b), "blocks are recorded in output order")
  assert.deepEqual(
    [...output.contextTrace.compressionRetainedEvidenceIds!].sort(),
    evidence.map((item) => item.id).sort(),
    "both groups produced a non-empty retained block"
  )
})

test("PT-07 AC07: every refusal falls back to the in-budget deterministic result and switches the source records over", async () => {
  const baselineDraft = makePromptCitingDraft("基准确定性回答。")
  const baseline = await pt07Runner({
    searcher: makeFakeSearcher(gapOk(pt07OverBudgetMaterial())),
    draft: baselineDraft,
    controller: pt07Loop(),
  })(makeRunnerInput())
  const deterministicContext = gapContextOf(baselineDraft.prompts[0])
  assert.equal(baseline.status, "completed")

  const cases: Array<{ name: string; compressor: ContextCompressor; outcome: string }> = [
    {
      name: "empty compressed output",
      compressor: makeRecordingCompressor({ content: () => "" }).compressor,
      outcome: "all_groups_failed",
    },
    {
      name: "an output that invents a citation",
      compressor: makeRecordingCompressor({ content: () => "[cite:ev_bogus] 伪造引用内容" }).compressor,
      outcome: "all_groups_failed",
    },
    {
      name: "a compressed output still over the budget",
      compressor: makeRecordingCompressor({ content: () => "长".repeat(4_000) }).compressor,
      outcome: "still_over_budget",
    },
    {
      name: "a compressor provider failure",
      compressor: {
        async compress(): Promise<ContextCompressionResult | null> {
          throw new Error("compressor unavailable")
        },
        async compressMaterial(): Promise<never> {
          throw new Error("compressor unavailable")
        },
      },
      outcome: "provider_error",
    },
  ]

  for (const testCase of cases) {
    const draft = makePromptCitingDraft("回退回答。")
    const output = await pt07Runner({
      searcher: makeFakeSearcher(gapOk(pt07OverBudgetMaterial())),
      draft,
      controller: pt07Loop(),
      compressor: testCase.compressor,
    })(makeRunnerInput())
    const context = gapContextOf(draft.prompts[0])

    assert.equal(output.status, "completed", `${testCase.name}: the run still completes`)
    assert.equal(
      output.contextTrace.compressionRan,
      false,
      `${testCase.name}: a refused compression is not reported as run`
    )
    assert.equal(
      output.contextTrace.compressionDecision!.outcome,
      testCase.outcome,
      `${testCase.name}: the refusal reason is explicit`
    )
    assert.equal(
      context,
      deterministicContext,
      `${testCase.name}: falls back to the in-budget deterministic result`
    )
    assert.ok(modelTokenCount(context) <= 6_000, `${testCase.name}: the fallback is in budget`)
    assert.ok(
      context.includes(PT07_TAIL_A),
      `${testCase.name}: the fallback carries the real material`
    )
    // Source records switched over: nothing claims a compressed block.
    const snapshot = output.contextTrace.generationContext!
    assert.notEqual(
      snapshot.representation,
      "compressed",
      `${testCase.name}: the records describe the context that generated`
    )
    assert.equal(
      snapshot.entries.some((entry) => entry.compressedBlockIndex !== undefined),
      false,
      `${testCase.name}: no compressed block is claimed for a refused compression`
    )
    assert.equal(snapshot.tokenCount, modelTokenCount(context))
    assert.equal(snapshot.contextLength, context.length)
    assert.equal(context.includes("ev_bogus"), false, `${testCase.name}: an unknown citation never lands`)
  }
})

test("PT-07 AC08: parent merge, multi-citation and parent-less results work, and an unauthorized parent never enters the material", async () => {
  // (a) two children of one parent merge into one framed block carrying both.
  const sharedParentContent = `${"甲".repeat(1_200)}${GAP_OLD_SNIPPET}${"乙".repeat(1_200)}${GAP_FRESH_FACT}`
  const oldShared = pt07Child("merge-old", GAP_OLD_SNIPPET)
  oldShared.chunk.documentId = "doc-merge"
  const newShared = pt07Child("merge-new", GAP_FRESH_FACT)
  newShared.chunk.documentId = "doc-merge"
  const parent = {
    id: "parent-merge",
    documentId: "doc-merge",
    content: sharedParentContent,
    childrenIds: [] as string[],
    metadata: { kind: "parent", source: "merge-parent.md" },
  }
  oldShared.parentChunk = parent
  newShared.parentChunk = parent
  const mergeDraft = makePromptCitingDraft("合并父块回答。")
  const merged = await pt07Runner({
    searcher: makeFakeSearcher(gapOk([oldShared, newShared])),
    draft: mergeDraft,
    controller: pt07Loop(),
  })(makeRunnerInput())
  const mergeContext = gapContextOf(mergeDraft.prompts[0])
  assert.equal(merged.status, "completed")
  assert.equal(
    mergeContext.match(/来源: merge-parent\.md/g)?.length,
    1,
    "one shared parent is framed once, however many children cite it"
  )
  for (const item of buildEvidence([oldShared, newShared])) {
    assert.ok(mergeContext.includes(`[cite:${item.id}]`), "the merged header names both children")
  }

  // (b) results with no parent block at all still assemble and complete.
  const parentless = [pt07Child("np-1", "无父块内容一。"), pt07Child("np-2", "无父块内容二。")]
  const npDraft = makePromptCitingDraft("无父块回答。")
  const noParent = await pt07Runner({
    searcher: makeFakeSearcher(gapOk(parentless)),
    draft: npDraft,
    controller: pt07Loop(),
  })(makeRunnerInput())
  assert.equal(noParent.status, "completed")
  assert.ok(gapContextOf(npDraft.prompts[0]).includes("无父块内容一"))
  assert.ok(gapContextOf(npDraft.prompts[0]).includes("无父块内容二"))

  // (c) a parent from another document is not authorized material.
  const foreign = pt07Child("foreign-child", "本块正文：七日退款。")
  foreign.parentChunk = {
    id: "parent-of-another-document",
    documentId: "doc-someone-else",
    content: `越权父块机密${"丙".repeat(4_000)}`,
    childrenIds: [],
    metadata: { kind: "parent", source: "someone-else.md" },
  }
  const rec = makeRecordingCompressor()
  const guardDraft = makePromptCitingDraft("授权边界回答。")
  const guarded = await pt07Runner({
    searcher: makeFakeSearcher(gapOk([foreign])),
    draft: guardDraft,
    controller: pt07Loop(),
    compressor: rec.compressor,
  })(makeRunnerInput())
  const guardContext = gapContextOf(guardDraft.prompts[0])
  assert.equal(guarded.status, "completed")
  assert.equal(
    guardContext.includes("越权父块机密"),
    false,
    "an unauthorized parent cannot enter the shared material"
  )
  assert.ok(guardContext.includes("本块正文：七日退款"), "the authorized child still stands on its own")
  assert.ok(
    rec.prompts.every((prompt) => !prompt.includes("越权父块机密")),
    "and it never reaches the compression input either"
  )
  assert.ok(
    (guarded.contextTrace.compressionDecision!.omittedCount ?? 0) >= 1,
    "the refusal is recorded, not silently dropped"
  )

  // (d) PL-03's gap-first regression keeps passing on top of the material contract.
  const gapDraft = makePromptCitingDraft("已按补检到的例外回答。")
  const gapOutput = await pt07Runner({
    searcher: makeFakeSearcher([gapOk(gapOldTop10()), gapOk([gapChild("new", GAP_FRESH_FACT)])]),
    draft: gapDraft,
    controller: gapLoopController("特定商品 不可退款 例外"),
    validator: makeFakeValidator(gapCorrections),
    replanner: makeFakeRePlanner([[{ text: "特定商品 不可退款 例外" }]]),
  })(makeRunnerInput())
  assert.equal(gapOutput.status, "completed")
  assert.ok(gapDraft.prompts[1].includes(GAP_FRESH_FACT))
  assert.equal(gapOutput.retrievalTrace.finalContextCandidates![0].chunkId, "new")
  assert.ok(
    gapOutput.contextTrace.compressionDecision!.rawTokens !== undefined,
    "the correction round is measured on the material too, never on a preview"
  )
  assert.equal(
    gapOutput.contextTrace.generationContext!.generationRound,
    2,
    "the second real generation call gets its own snapshot on the correction path"
  )
})

test("PT-07 AC09: Path A, the compatibility Path B, the loop adapter and the correction path all read the material contract, and legacy string callers stay compatible", async () => {
  const results = pt07OverBudgetMaterial()

  // A compressor that ONLY implements the material entry point: if any part of
  // the complex route still ran its own preview-based selection, it would have
  // to call `compress`, and this run would blow up instead of compressing.
  const materialOnlyCalls: Array<{ hasMaterial: boolean; sawTail: boolean }> = []
  const materialOnly: ContextCompressor = {
    async compress(): Promise<ContextCompressionResult | null> {
      throw new Error("the complex route must not fall back to the preview entry point")
    },
    async compressMaterial(input: any): Promise<any> {
      materialOnlyCalls.push({
        hasMaterial: input.material !== undefined,
        sawTail: [...(input.material?.sources ?? [])].some((source: any) =>
          String(source.candidateText).includes(PT07_TAIL_A)
        ),
      })
      return { result: null, refusal: "within_budget" }
    },
  }

  // (a) Path A — the production tool loop, including its observation adapter.
  const pathA = await pt07Runner({
    searcher: makeFakeSearcher(gapOk(pt07OverBudgetMaterial())),
    draft: makePromptCitingDraft("Path A 回答。"),
    controller: pt07Loop(),
    compressor: materialOnly,
  })(makeRunnerInput())
  assert.equal(pathA.status, "completed")
  assert.ok(
    materialOnlyCalls.length > 1,
    "Path A reaches the shared material entry for the loop observation AND the final context"
  )
  assert.ok(materialOnlyCalls.every((call) => call.hasMaterial && call.sawTail))
  assert.equal(pathA.contextTrace.compressionDecision!.outcome, "within_budget")

  // (b) Path B — the compatibility planner flow.
  const beforeB = materialOnlyCalls.length
  const pathB = await pt07Runner({
    searcher: makeFakeSearcher(gapOk(pt07OverBudgetMaterial())),
    draft: makePromptCitingDraft("Path B 回答。"),
    planner: pt07Planner(),
    compressor: materialOnly,
  })(makeRunnerInput())
  assert.equal(pathB.status, "completed")
  assert.ok(materialOnlyCalls.length > beforeB, "Path B uses the same entry, not a second one")
  assert.ok(
    pathB.contextTrace.compressionDecision!.rawTokens! > 6_000,
    "and sees the same raw parent material"
  )

  // (c) a legacy string-only assembler keeps working and must say it has no
  //     material instead of inventing counts.
  const legacyEvidence = buildEvidence(results)
  const legacyPrompts: string[] = []
  const legacyOutput = await pt07Runner({
    searcher: makeFakeSearcher(gapOk(results)),
    draft: {
      prompts: legacyPrompts,
      stream: async function* (messages: AgentMessage[]): AsyncGenerator<string> {
        legacyPrompts.push(messages[messages.length - 1].content)
        yield buildCitedAnswer(legacyEvidence)
      },
    },
    assembler: makeFakeAssembler("legacy assembled context"),
    planner: pt07Planner(),
    compressor: makeRecordingCompressor().compressor,
  })(makeRunnerInput())
  assert.equal(legacyOutput.status, "completed", "the old string assembler still runs")
  assert.ok(
    legacyPrompts[0].startsWith("legacy assembled context"),
    "and its string output is still what the generator is handed"
  )
  assert.equal(legacyOutput.contextTrace.compressionDecision!.outcome, "preview_only")
  assert.equal(legacyOutput.contextTrace.compressionDecision!.rawTokens, undefined)
  assert.equal(legacyOutput.contextTrace.compressionDecision!.candidateTokens, undefined)
  assert.equal(legacyOutput.contextTrace.generationContext!.entries.length, 0)

  // (d) the simple route is untouched by this migration: the same entry point,
  //     the same material counts, the same no-call rule.
  const simpleDraft = makePromptCitingDraft("简单路由回答。")
  const simpleCompressor = makeRecordingCompressor()
  const simpleOutput = await createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => makeFakeSearcher(gapOk(pt07FittingMaterial())),
    assembler: new ContextAssemblerImpl(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: simpleDraft.stream,
    compressor: simpleCompressor.compressor,
  })(makeRunnerInput())
  assert.equal(simpleOutput.status, "completed")
  assert.equal(simpleOutput.contextTrace.compressionDecision!.outcome, "within_budget")
  assert.equal(simpleCompressor.calls, 0)
  assert.ok(simpleOutput.contextTrace.compressionDecision!.rawTokens !== undefined)
})

test("PT-07 AC10: the new compression calls honour cancellation and stay inside the run's model-call budget", async () => {
  const results = pt07OverBudgetMaterial()

  // (a) a compression call that is cancelled is NOT swallowed as a fallback —
  //     a cancelled run never publishes.
  const aborting = makeRecordingCompressor({ abortOnCall: true })
  await assert.rejects(
    () =>
      pt07Runner({
        searcher: makeFakeSearcher(gapOk(results)),
        draft: makePromptCitingDraft("不该出现"),
        planner: pt07Planner(),
        compressor: aborting.compressor,
      })(makeRunnerInput()),
    (err: unknown) => (err as Error).name === "AbortError",
    "cancellation inside the compression call propagates"
  )

  // (b) an abort raised while the compressor runs reaches the run's signal too.
  const controller = new AbortController()
  const cancelSoon: ContextCompressor = {
    async compress(): Promise<ContextCompressionResult | null> {
      throw pt07AbortError()
    },
    async compressMaterial(input: any): Promise<any> {
      controller.abort()
      if (!input.signal?.aborted) throw new Error("the run's signal never reached the compressor")
      throw pt07AbortError()
    },
  }
  await assert.rejects(
    () =>
      pt07Runner({
        searcher: makeFakeSearcher(gapOk(results)),
        draft: makePromptCitingDraft("不该出现"),
        planner: pt07Planner(),
        compressor: cancelSoon,
      })(makeRunnerInput({ signal: controller.signal })),
    (err: unknown) => (err as Error).name === "AbortError",
    "the run's AbortSignal travels into every new compression call"
  )

  // (c) the model-call count stays bounded: exactly one call per source group,
  //     no extra pass, and the usage the run paid for is reported.
  const counted = makeRecordingCompressor()
  const countedDraft = makePromptCitingDraft("压缩后回答。")
  const countedOutput = await pt07Runner({
    searcher: makeFakeSearcher(gapOk(pt07OverBudgetMaterial())),
    draft: countedDraft,
    planner: pt07Planner(),
    compressor: counted.compressor,
  })(makeRunnerInput())
  assert.equal(countedOutput.status, "completed")
  assert.equal(
    counted.calls,
    buildEvidence(results).length,
    "one compression call per source group — the complex route adds no second pass"
  )
  assert.ok(countedOutput.contextTrace.compressionUsage, "the calls the run paid for are reported")
  assert.equal(countedOutput.contextTrace.compressionDecision!.modelCallMade, true)
})

// ---------------------------------------------------------------------------
// PT-07 — the two review findings in these files
// ---------------------------------------------------------------------------

test("PT-07 review: a complex loop provider failure publishes the shared terminal copy, never the exception text", async () => {
  const searcher: Searcher = {
    async search(): Promise<SearchOutcome> {
      throw new Error("Elasticsearch down at internal-host:9200/kb-secret-index")
    },
  }
  const output = await pt07Runner({
    searcher,
    draft: makePromptCitingDraft("不该出现"),
    controller: makeFakeComplexLoopController([
      { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "q" } },
    ]),
  })(makeRunnerInput())

  assert.equal(output.status, "provider_error")
  assert.equal(
    output.reply,
    PROVIDER_ERROR_MESSAGE,
    "the runner itself must not put exception text in a public field"
  )
  assert.equal(output.reply.includes("Elasticsearch"), false)
  assert.equal(output.reply.includes("internal-host"), false)
  // The failure stays reported: nothing about the terminal or the degradation
  // signal was weakened to get there.
  assert.deepEqual(output.degradation, { status: "insufficient", unavailableChannels: [] })
  assert.deepEqual(output.references, [])
  assert.equal(output.retrievalTrace.complexLoop, true)

  // The same rule for the planner compatibility failure.
  const planner: Planner = {
    async decompose(): Promise<DecomposeResult> {
      throw new PlannerError("decompose failed against planning-host", "decompose")
    },
    async rewrite(): Promise<RewriteResult> {
      return { query: { text: "q" } }
    },
    async navigate(): Promise<string[]> {
      return []
    },
    async generateHypothesis(): Promise<HypothesisResult> {
      return { text: "" }
    },
  }
  const plannerOutput = await pt07Runner({
    searcher: makeFakeSearcher(gapOk([pt07Child("p", "内容")])),
    draft: makePromptCitingDraft("不该出现"),
    planner,
  })(makeRunnerInput())
  assert.equal(plannerOutput.status, "provider_error")
  assert.equal(plannerOutput.reply, PROVIDER_ERROR_MESSAGE)
  assert.equal(plannerOutput.reply.includes("planning-host"), false)
})

test("PT-07 review: commitFinalContext is honest — a lone search keeps its label, merged searches aggregate, no ordering makes no claim", async () => {
  const results = pt07FittingMaterial()

  // (a) Path A: the loop merges its own tool results and reports no ordering,
  //     so the round must make NO ordering claim — not even an aggregation.
  const loopOutput = await pt07Runner({
    searcher: makeFakeSearcher(gapOk(results)),
    draft: makePromptCitingDraft("循环回答。"),
    controller: pt07Loop(),
  })(makeRunnerInput())
  assert.equal(loopOutput.status, "completed")
  assert.equal(
    loopOutput.retrievalTrace.finalContextOrdering,
    undefined,
    "the loop never pushed an ordering, so the runner must not fabricate one"
  )

  // (b) Path B, one contributing search: it keeps its OWN label.
  const single = await pt07Runner({
    searcher: makeFakeSearcher(gapOk(results)),
    draft: makePromptCitingDraft("单查询回答。"),
    planner: pt07Planner(),
  })(makeRunnerInput())
  assert.equal(single.status, "completed")
  assert.deepEqual(single.retrievalTrace.finalContextOrdering, { source: "dedicated_rerank" })

  // (c) Path B, two merged searches: an aggregation, never a dedicated rerank.
  const mergedSearcher = makeFakeSearcher([
    {
      status: "ok",
      results: [results[0]!],
      unavailableChannels: [],
      ordering: { source: "dedicated_rerank" },
    },
    {
      status: "ok",
      results: [results[1]!],
      unavailableChannels: [],
      ordering: { source: "fused", reason: "not_configured" },
    },
  ])
  const merged = await pt07Runner({
    searcher: mergedSearcher,
    draft: makePromptCitingDraft("多查询回答。"),
    planner: makeFakePlanner({ queries: [{ text: "退款" }, { text: "例外" }] }),
  })(makeRunnerInput())
  assert.equal(merged.status, "completed")
  assert.deepEqual(merged.retrievalTrace.finalContextOrdering, {
    source: "fused",
    reason: "multi_query_aggregation",
  })

  // (d) searches that report no ordering at all: still no claim.
  const unlabelled = await pt07Runner({
    searcher: makeFakeSearcher({ status: "ok", results, unavailableChannels: [] }),
    draft: makePromptCitingDraft("无标签回答。"),
    planner: pt07Planner(),
  })(makeRunnerInput())
  assert.equal(unlabelled.status, "completed")
  assert.equal(unlabelled.retrievalTrace.finalContextOrdering, undefined)
})


// ---------------------------------------------------------------------------
// Reasoning effort: the frozen run choice must reach the initial complex draft
// and a forced correction rewrite; the loop's tool budget is untouched.
// ---------------------------------------------------------------------------

test("the reasoning effort reaches the complex draft and its correction rewrite unchanged", async () => {
  const makeController = () => makeFakeComplexLoopController([
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "initial-query" } },
    { sufficient: true },
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "correction-query" } },
    { sufficient: true },
  ])
  const makeSearcherDouble = () => makeFakeSearcher([
    { status: "ok", results: [makeRetrievalResult({ chunk: { id: "c-init", documentId: "d-init", content: "initial", childrenIds: [], metadata: {} } })], unavailableChannels: [] },
    { status: "ok", results: [makeRetrievalResult({ chunk: { id: "c-corr", documentId: "d-corr", content: "correction", childrenIds: [], metadata: {} } })], unavailableChannels: [] },
  ])

  async function run(effort?: "max") {
    const searcher = makeSearcherDouble()
    const received: unknown[] = []
    let call = 0
    const draft = async function* (
      _messages: AgentMessage[],
      _signal: AbortSignal,
      options?: { reasoningEffort?: "low" | "high" | "max" }
    ): AsyncGenerator<string> {
      received.push(options)
      const evidence = buildEvidence([
        makeRetrievalResult({
          chunk: {
            id: call === 0 ? "c-init" : "c-corr",
            documentId: call === 0 ? "d-init" : "d-corr",
            content: "evidence",
            childrenIds: [],
            metadata: {},
          },
        }),
      ])
      call += 1
      yield buildCitedAnswer(evidence)
    }
    const runner = createComplexKnowledgeMastraRunner({
      router: makeFakeRouter("complex"),
      createSearcher: () => searcher,
      assembler: makeFakeAssembler(),
      validator: makeFakeValidator([
        { passed: false, hallucination: false, completeness: false },
        { passed: true, hallucination: false, completeness: true },
      ]),
      replanner: makeFakeRePlanner([[{ text: "gap-query-1" }]]),
      streamAnswerDraft: draft,
      complexLoopController: makeController(),
    })
    const output = await runner(makeRunnerInput(effort ? { reasoningEffort: effort } : {}))
    assert.equal(output.status, "completed")
    return { received, searches: searcher.calls.length }
  }

  const withEffort = await run("max")
  assert.deepEqual(withEffort.received, [{ reasoningEffort: "max" }, { reasoningEffort: "max" }])
  const omitted = await run()
  assert.deepEqual(omitted.received, [undefined, undefined])
  assert.equal(omitted.searches, withEffort.searches, "the level never changes the loop's retrieval budget")
})
