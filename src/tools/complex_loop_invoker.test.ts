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
import type { RetrievalResult } from "../types"

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
