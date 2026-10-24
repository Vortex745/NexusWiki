/**
 * Ticket 34 (TOOL-01A) — the complex loop routes its tool calls through the
 * schema-validated invocation boundary: refusals are traced and bounded,
 * timeouts converge to the traceable provider-failure stop, and executed
 * calls behave exactly like the legacy direct-search path.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  runComplexLoop,
  type ComplexLoopController,
  type ComplexLoopDecision,
  type ComplexLoopAssembler,
  type ToolInvoker,
} from "../retrieval/complex_loop"
import type { Searcher, SearchOptions } from "../retrieval/search/interface"
import type { AccessContext } from "../access/context"
import type { RetrievalResult } from "../types"
import { ToolRegistry } from "./invocation"
import { registerBuiltinTools } from "./knowledge_tools"
import {
  createComplexLoopToolInvoker,
  READ_ONLY_TOOL_ALLOWLIST,
} from "./complex_loop_adapter"

const decision = (tool: ComplexLoopDecision["tool"], args: ComplexLoopDecision["args"]) =>
  ({ sufficient: false, tool, args }) as ComplexLoopDecision

const controller = (script: ComplexLoopDecision[]): ComplexLoopController => {
  let index = 0
  return {
    async decide() {
      const next = script[Math.min(index, script.length - 1)]
      index += 1
      return next
    },
  }
}

const assembler: ComplexLoopAssembler = { assemble: async () => "observation" }

const chunkResult = (id: string): RetrievalResult => ({
  chunk: { id, documentId: `doc-${id}`, content: `content ${id}`, childrenIds: [], metadata: {} },
  score: 1,
  source: "vector",
  wikilinks: [],
})

test("Ticket 34: a policy-refused call is traced and the loop continues to a terminal", async () => {
  const invocations: unknown[] = []
  const invoker: ToolInvoker = async (call) => {
    invocations.push(call)
    return { outcome: "policy_denied" as const, error: "tool is not on this run's allowlist" }
  }
  const result = await runComplexLoop(
    {
      controller: controller([
        decision("semantic_lexical_hybrid", { query: "退款多久到账" }),
        { sufficient: true },
      ]),
      searcher: { search: async () => { throw new Error("must not execute directly") } },
      assembler,
      toolInvoker: invoker,
    },
    { query: "退款多久到账", signal: new AbortController().signal }
  )
  assert.equal(invocations.length, 1, "the call went through the boundary, not the searcher")
  assert.equal(result.stopReason, "evidence-sufficient")
  assert.equal(result.toolCalls[0].toolOutcome, "policy_denied")
  assert.equal(result.toolCalls[0].resultCount, 0)
  assert.equal(result.toolCallsExecuted, 0)
})

test("Ticket 34: an executed call flows through the boundary as evidence", async () => {
  const invoker: ToolInvoker = async () => ({
    outcome: "ok" as const,
    results: [chunkResult("chunk-1")],
    unavailableChannels: [],
  })
  const result = await runComplexLoop(
    {
      controller: controller([
        decision("semantic_lexical_hybrid", { query: "退款多久到账" }),
        { sufficient: true },
      ]),
      searcher: { search: async () => { throw new Error("must not execute directly") } },
      assembler,
      toolInvoker: invoker,
    },
    { query: "退款多久到账", signal: new AbortController().signal }
  )
  assert.equal(result.stopReason, "evidence-sufficient")
  assert.equal(result.toolCalls[0].toolOutcome, undefined, "executed calls carry no refusal outcome")
  assert.equal(result.toolCalls[0].resultCount, 1)
  assert.equal(result.results.length, 1)
  assert.equal(result.toolCallsExecuted, 1)
})

test("Ticket 34: a timed-out tool call stops the loop with the traceable provider-failure terminal", async () => {
  const invoker: ToolInvoker = async () => ({
    outcome: "timeout" as const,
    error: "exceeded 100ms deadline",
  })
  const result = await runComplexLoop(
    {
      controller: controller([decision("semantic_lexical_hybrid", { query: "q" })]),
      searcher: { search: async () => { throw new Error("must not execute directly") } },
      assembler,
      toolInvoker: invoker,
    },
    { query: "q", signal: new AbortController().signal }
  )
  assert.equal(result.stopReason, "provider-failure")
  assert.equal(result.toolCalls[0].toolOutcome, "timeout")
  assert.equal(result.toolCalls[0].toolOutcomeError, "exceeded 100ms deadline")
})

// ---------------------------------------------------------------------------
// PT-02 / PT-03 — the invoker is where the complex route's tool calls inherit
// the run's server-bound session, web intent and locked scope.
// ---------------------------------------------------------------------------

const invokerAccessContext: AccessContext = {
  tenantId: "tenant-invoker",
  subjectId: "subject-invoker",
  groups: [],
  scopes: ["chat"],
}

function recordingSearcher(results: RetrievalResult[] = [chunkResult("chunk-1")]) {
  const calls: Array<{ query: string; options?: SearchOptions }> = []
  const searcher: Searcher = {
    async search(query, options) {
      calls.push({ query: query.text, options })
      return { status: "ok", results, unavailableChannels: [] }
    },
  }
  return { searcher, calls }
}

function loopThrough(
  invoker: ToolInvoker,
  args: Record<string, unknown> = { query: "附件退款规则" }
) {
  return runComplexLoop(
    {
      controller: controller([
        decision("semantic_lexical_hybrid", args as unknown as ComplexLoopDecision["args"]),
        { sufficient: true },
      ]),
      searcher: { search: async () => { throw new Error("must not execute directly") } },
      assembler,
      toolInvoker: invoker,
    },
    { query: "附件退款规则", signal: new AbortController().signal }
  )
}

test("PT-02 AC01 / PT-03 AC01: the loop invoker binds the run's session and web intent into every tool search", async () => {
  const { searcher, calls } = recordingSearcher()
  const signal = new AbortController().signal
  const invoker = createComplexLoopToolInvoker({
    registry: registerBuiltinTools(new ToolRegistry()),
    allowedTools: READ_ONLY_TOOL_ALLOWLIST,
    accessContext: invokerAccessContext,
    retrievalScope: { knowledgeBaseIds: [] },
    sessionId: "sess-bound",
    webRequested: true,
    signal,
    searcher,
  })

  const result = await loopThrough(invoker)

  assert.equal(calls.length, 1, "the tool call reached the run's searcher")
  const options = calls[0].options as SearchOptions
  assert.deepEqual(options.attachments, { sessionId: "sess-bound" })
  assert.equal(options.webRequested, true)
  assert.deepEqual(options.retrievalScope, { knowledgeBaseIds: [] })
  assert.deepEqual(options.accessContext, invokerAccessContext)
  assert.ok(options.signal, "the tool's search runs under a live cancellation signal")
  assert.equal(options.signal!.aborted, false)
  assert.equal(result.toolCalls[0].resultCount, 1)
})

test("PT-02 AC02: an unbound invoker opens no attachment channel and model args cannot add one", async () => {
  const { searcher, calls } = recordingSearcher()
  const invoker = createComplexLoopToolInvoker({
    registry: registerBuiltinTools(new ToolRegistry()),
    allowedTools: READ_ONLY_TOOL_ALLOWLIST,
    accessContext: invokerAccessContext,
    retrievalScope: { knowledgeBaseIds: ["kb-1"] },
    searcher,
  })

  // The controller (i.e. the model) tries to name another session. The adapter
  // maps loop args to the registry schema, so the extra key is dropped — and
  // the strict schema would refuse it outright had it survived.
  const result = await loopThrough(invoker, { query: "附件退款规则", sessionId: "sess-victim" })

  assert.equal(calls.length, 1)
  const options = calls[0].options as SearchOptions
  assert.equal(options.attachments, undefined, "no bound session → no attachment channel")
  assert.equal(options.webRequested, undefined, "no opt-in → no web channel")
  assert.deepEqual(options.retrievalScope, { knowledgeBaseIds: ["kb-1"] })
  assert.equal(result.toolCalls[0].resultCount, 1, "the legitimate call still executed")
})

test("PT-03 AC04: a web opt-in never widens the tool allowlist", async () => {
  const { searcher, calls } = recordingSearcher()
  const invoker = createComplexLoopToolInvoker({
    registry: registerBuiltinTools(new ToolRegistry()),
    allowedTools: ["wiki_search"],
    accessContext: invokerAccessContext,
    sessionId: "sess-bound",
    webRequested: true,
    searcher,
  })

  const result = await loopThrough(invoker)

  assert.deepEqual(calls, [], "a non-allowlisted tool never reaches retrieval")
  assert.equal(result.toolCalls[0].toolOutcome, "policy_denied")
  assert.equal(result.toolCallsExecuted, 0)
})

test("PT-02 AC05: the invoker's bounded failure stays a traceable provider-failure", async () => {
  const failingSearcher: Searcher = {
    async search() {
      throw new Error("attachment store unavailable")
    },
  }
  const invoker = createComplexLoopToolInvoker({
    registry: registerBuiltinTools(new ToolRegistry()),
    allowedTools: READ_ONLY_TOOL_ALLOWLIST,
    accessContext: invokerAccessContext,
    sessionId: "sess-bound",
    searcher: failingSearcher,
  })

  const result = await loopThrough(invoker)

  assert.equal(result.toolCalls[0].toolOutcome, "failed")
  assert.match(result.toolCalls[0].toolOutcomeError ?? "", /attachment store unavailable/)
  assert.equal(result.stopReason, "provider-failure")
})
