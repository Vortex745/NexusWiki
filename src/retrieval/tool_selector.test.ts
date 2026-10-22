import assert from "node:assert/strict"
import { test } from "node:test"
import {
  RETRIEVAL_TOOLS,
  validateToolArgs,
  toolToSearchOptions,
  formatToolInputSummary,
  fallbackSelection,
  hasHierarchicalNavigationIntent,
  resolveToolApplicability,
  PAGEINDEX_INAPPLICABLE_REASON,
  ToolSelectorImpl,
  type RetrievalToolName,
  type RetrievalToolSelection,
} from "./tool_selector"
import type OpenAI from "openai"

// ---------------------------------------------------------------------------
// validateToolArgs (criterion #2: cannot supply Tenant, Principal, or
// unrestricted backend query fields)
// ---------------------------------------------------------------------------

test("validateToolArgs accepts valid query for semantic_lexical_hybrid", () => {
  const result = validateToolArgs("semantic_lexical_hybrid", { query: "什么是RAG?" })
  assert.deepEqual(result, { query: "什么是RAG?" })
})

test("validateToolArgs accepts valid query + seeds for graph_navigation", () => {
  const result = validateToolArgs("graph_navigation", { query: "谁是CEO?", seeds: ["公司", "管理层"] })
  assert.deepEqual(result, { query: "谁是CEO?", seeds: ["公司", "管理层"] })
})

test("validateToolArgs accepts valid query for pageindex_hierarchy", () => {
  const result = validateToolArgs("pageindex_hierarchy", { query: "目录第3页" })
  assert.deepEqual(result, { query: "目录第3页" })
})

test("validateToolArgs rejects forbidden tenantId field (criterion #2)", () => {
  assert.equal(validateToolArgs("semantic_lexical_hybrid", { query: "x", tenantId: "t1" }), null)
})

test("validateToolArgs rejects forbidden principal field (criterion #2)", () => {
  assert.equal(validateToolArgs("semantic_lexical_hybrid", { query: "x", principal: "p1" }), null)
})

test("validateToolArgs rejects forbidden sql field (criterion #2)", () => {
  assert.equal(validateToolArgs("semantic_lexical_hybrid", { query: "x", sql: "DROP TABLE" }), null)
})

test("validateToolArgs rejects forbidden cypher field (criterion #2)", () => {
  assert.equal(validateToolArgs("graph_navigation", { query: "x", cypher: "MATCH (n) DETACH DELETE n" }), null)
})

test("validateToolArgs rejects forbidden esQuery field (criterion #2)", () => {
  assert.equal(validateToolArgs("semantic_lexical_hybrid", { query: "x", esQuery: { match_all: {} } }), null)
})

test("validateToolArgs rejects forbidden accessToken field (criterion #2)", () => {
  assert.equal(validateToolArgs("semantic_lexical_hybrid", { query: "x", accessToken: "abc" }), null)
})

test("validateToolArgs rejects unknown arg key", () => {
  assert.equal(validateToolArgs("semantic_lexical_hybrid", { query: "x", unknownField: "y" }), null)
})

test("validateToolArgs rejects empty query", () => {
  assert.equal(validateToolArgs("semantic_lexical_hybrid", { query: "" }), null)
  assert.equal(validateToolArgs("semantic_lexical_hybrid", { query: "   " }), null)
})

test("validateToolArgs rejects non-string query", () => {
  assert.equal(validateToolArgs("semantic_lexical_hybrid", { query: 123 }), null)
  assert.equal(validateToolArgs("semantic_lexical_hybrid", { query: null }), null)
  assert.equal(validateToolArgs("semantic_lexical_hybrid", { query: undefined }), null)
})

test("validateToolArgs rejects seeds on non-graph tools", () => {
  assert.equal(validateToolArgs("semantic_lexical_hybrid", { query: "x", seeds: ["a"] }), null)
  assert.equal(validateToolArgs("pageindex_hierarchy", { query: "x", seeds: ["a"] }), null)
})

test("validateToolArgs rejects non-array seeds", () => {
  assert.equal(validateToolArgs("graph_navigation", { query: "x", seeds: "not-array" }), null)
  assert.equal(validateToolArgs("graph_navigation", { query: "x", seeds: 123 }), null)
})

test("validateToolArgs rejects too many seeds (>10)", () => {
  const seeds = Array(11).fill("seed")
  assert.equal(validateToolArgs("graph_navigation", { query: "x", seeds }), null)
})

test("validateToolArgs rejects non-string seed item", () => {
  assert.equal(validateToolArgs("graph_navigation", { query: "x", seeds: ["ok", 123] }), null)
})

test("validateToolArgs rejects seed exceeding max length (200 chars)", () => {
  const longSeed = "x".repeat(201)
  assert.equal(validateToolArgs("graph_navigation", { query: "x", seeds: [longSeed] }), null)
})

test("validateToolArgs accepts seed at max length boundary (200 chars)", () => {
  const maxSeed = "x".repeat(200)
  const result = validateToolArgs("graph_navigation", { query: "x", seeds: [maxSeed] })
  assert.deepEqual(result, { query: "x", seeds: [maxSeed] })
})

test("validateToolArgs rejects non-object args", () => {
  assert.equal(validateToolArgs("semantic_lexical_hybrid", null), null)
  assert.equal(validateToolArgs("semantic_lexical_hybrid", undefined), null)
  assert.equal(validateToolArgs("semantic_lexical_hybrid", "string"), null)
  assert.equal(validateToolArgs("semantic_lexical_hybrid", 123), null)
  assert.equal(validateToolArgs("semantic_lexical_hybrid", []), null)
})

// ---------------------------------------------------------------------------
// DR-12 — executor-side applicability gate
// ---------------------------------------------------------------------------

test("DR-12: hierarchical navigation intent covers page, section, TOC and English markers", () => {
  for (const query of [
    "第3页讲了什么？",
    "12 页的退货流程",
    "第二章的主要内容是什么？",
    "第3节的结论",
    "目录里有哪些章节？",
    "文档的层级结构是怎样的？",
    "which page describes refunds?",
    "see section 4",
  ]) {
    assert.equal(hasHierarchicalNavigationIntent(query), true, query)
  }
})

test("DR-12: definitions, concepts, general procedures and a bare 文档 mention are not navigation", () => {
  for (const query of [
    "四路结果融合之后还有什么处理？",
    "什么是检索增强生成？",
    "系统的定义是什么？",
    "部署的一般步骤有哪些？",
    "这份文档主要讲了什么？",
  ]) {
    assert.equal(hasHierarchicalNavigationIntent(query), false, query)
  }
})

test("DR-12: an inapplicable PageIndex selection is replaced with hybrid before execution", () => {
  const result = resolveToolApplicability({
    tool: "pageindex_hierarchy",
    args: { query: "四路结果融合之后还有什么处理？" },
  })
  assert.equal(result.selection.tool, "semantic_lexical_hybrid")
  assert.equal(result.selection.args.query, "四路结果融合之后还有什么处理？")
  assert.equal(result.selection.args.seeds, undefined)
  assert.equal(result.replacedFrom, "pageindex_hierarchy")
  assert.equal(result.reason, PAGEINDEX_INAPPLICABLE_REASON)
})

test("DR-12: a qualified PageIndex selection is left untouched", () => {
  const selection: RetrievalToolSelection = {
    tool: "pageindex_hierarchy",
    args: { query: "目录第3页" },
  }
  const result = resolveToolApplicability(selection)
  assert.equal(result.selection, selection)
  assert.equal(result.replacedFrom, undefined)
  assert.equal(result.reason, undefined)
})

test("DR-12: non-PageIndex selections are left untouched", () => {
  const selection: RetrievalToolSelection = {
    tool: "graph_navigation",
    args: { query: "什么是检索增强生成？", seeds: ["RAG"] },
  }
  const result = resolveToolApplicability(selection)
  assert.equal(result.selection, selection)
  assert.equal(result.reason, undefined)
})

test("DR-12: the PageIndex tool description states the hierarchical-only applicability", () => {
  const pageIndex = RETRIEVAL_TOOLS.find(
    (tool) => tool.function.name === "pageindex_hierarchy"
  )
  assert.ok(pageIndex)
  assert.match(pageIndex!.function.description, /ONLY when the question names a page, section, chapter, or table-of-contents/i)
  assert.match(pageIndex!.function.description, /semantic_lexical_hybrid/)
})

// ---------------------------------------------------------------------------
// toolToSearchOptions (criterion #1: model can choose from strict read-only tool schema)
// ---------------------------------------------------------------------------

test("toolToSearchOptions maps semantic_lexical_hybrid to vector+bm25 channels", () => {
  const selection: RetrievalToolSelection = { tool: "semantic_lexical_hybrid", args: { query: "x" } }
  assert.deepEqual(toolToSearchOptions(selection), { channels: ["vector", "bm25"] })
})

test("toolToSearchOptions maps graph_navigation to graph channel only", () => {
  const selection: RetrievalToolSelection = { tool: "graph_navigation", args: { query: "x" } }
  assert.deepEqual(toolToSearchOptions(selection), { channels: ["graph"] })
})

test("toolToSearchOptions maps graph_navigation with seeds to graph channel + graphSeeds", () => {
  const selection: RetrievalToolSelection = { tool: "graph_navigation", args: { query: "x", seeds: ["a", "b"] } }
  assert.deepEqual(toolToSearchOptions(selection), { channels: ["graph"], graphSeeds: ["a", "b"] })
})

test("toolToSearchOptions maps pageindex_hierarchy to pageIndex channel only", () => {
  const selection: RetrievalToolSelection = { tool: "pageindex_hierarchy", args: { query: "x" } }
  assert.deepEqual(toolToSearchOptions(selection), { channels: ["pageIndex"] })
})

test("RETRIEVAL_TOOLS exposes exactly 3 tools (criterion #1)", () => {
  assert.equal(RETRIEVAL_TOOLS.length, 3)
  const names = RETRIEVAL_TOOLS.map(t => t.function.name)
  assert.deepEqual(names, ["semantic_lexical_hybrid", "graph_navigation", "pageindex_hierarchy"])
})

test("RETRIEVAL_TOOLS all have additionalProperties: false (criterion #2 strict schema)", () => {
  for (const tool of RETRIEVAL_TOOLS) {
    assert.equal(tool.function.parameters.additionalProperties, false, `${tool.function.name} must have additionalProperties: false`)
  }
})

// ---------------------------------------------------------------------------
// formatToolInputSummary (criterion #7: safe input summary)
// ---------------------------------------------------------------------------

test("formatToolInputSummary includes tool name and query preview", () => {
  const selection: RetrievalToolSelection = { tool: "semantic_lexical_hybrid", args: { query: "什么是RAG?" } }
  const summary = formatToolInputSummary(selection)
  assert.ok(summary.includes("tool=semantic_lexical_hybrid"))
  assert.ok(summary.includes("什么是RAG?"))
})

test("formatToolInputSummary truncates long query at 80 chars", () => {
  const longQuery = "x".repeat(100)
  const selection: RetrievalToolSelection = { tool: "semantic_lexical_hybrid", args: { query: longQuery } }
  const summary = formatToolInputSummary(selection)
  assert.ok(summary.includes("..."))
  assert.ok(!summary.includes("x".repeat(100)))
})

test("formatToolInputSummary includes seed count for graph_navigation", () => {
  const selection: RetrievalToolSelection = { tool: "graph_navigation", args: { query: "x", seeds: ["a", "b", "c"] } }
  const summary = formatToolInputSummary(selection)
  assert.ok(summary.includes("seeds=3"))
})

test("formatToolInputSummary does NOT include seed values (only count — safe summary)", () => {
  const selection: RetrievalToolSelection = { tool: "graph_navigation", args: { query: "x", seeds: ["secret-seed"] } }
  const summary = formatToolInputSummary(selection)
  assert.ok(!summary.includes("secret-seed"))
})

// ---------------------------------------------------------------------------
// fallbackSelection (criterion #5: malformed/unsupported/absent → semantic_lexical_hybrid)
// ---------------------------------------------------------------------------

test("fallbackSelection returns semantic_lexical_hybrid with the query filled in", () => {
  const result = fallbackSelection("my query", "no_tool_call")
  assert.equal(result.selection.tool, "semantic_lexical_hybrid")
  assert.equal(result.selection.args.query, "my query")
  assert.equal(result.fallbackReason, "no_tool_call")
})

test("fallbackSelection does NOT carry seeds (clean fallback)", () => {
  const result = fallbackSelection("q", "test")
  assert.equal(result.selection.args.seeds, undefined)
})

// ---------------------------------------------------------------------------
// ToolSelectorImpl — LLM call with function-calling
// ---------------------------------------------------------------------------

/**
 * Build a mock OpenAI client that returns a controlled tool_calls response.
 */
function mockClientWithToolCall(
  toolName: string | null,
  argsJson: string,
  options?: { throwError?: Error }
): OpenAI {
  const mock: any = {
    chat: {
      completions: {
        create: async (_params: any, _opts?: any) => {
          if (options?.throwError) throw options.throwError
          return {
            choices: [{
              message: {
                tool_calls: toolName
                  ? [{ type: "function", function: { name: toolName, arguments: argsJson } }]
                  : undefined,
              },
            }],
          }
        },
      },
    },
  }
  return mock as unknown as OpenAI
}

test("ToolSelectorImpl returns LLM-selected tool on happy path (semantic_lexical_hybrid)", async () => {
  const client = mockClientWithToolCall("semantic_lexical_hybrid", JSON.stringify({ query: "什么是RAG?" }))
  const selector = new ToolSelectorImpl(client, "test-model")
  const result = await selector.selectTool({ text: "什么是RAG?" })
  assert.equal(result.selection.tool, "semantic_lexical_hybrid")
  assert.equal(result.selection.args.query, "什么是RAG?")
  assert.equal(result.fallbackReason, undefined)
})

test("ToolSelectorImpl returns LLM-selected graph_navigation with seeds", async () => {
  const client = mockClientWithToolCall("graph_navigation", JSON.stringify({ query: "谁是CEO?", seeds: ["公司"] }))
  const selector = new ToolSelectorImpl(client, "test-model")
  const result = await selector.selectTool({ text: "谁是CEO?" })
  assert.equal(result.selection.tool, "graph_navigation")
  assert.equal(result.selection.args.query, "谁是CEO?")
  assert.deepEqual(result.selection.args.seeds, ["公司"])
  assert.equal(result.fallbackReason, undefined)
})

test("ToolSelectorImpl returns LLM-selected pageindex_hierarchy", async () => {
  const client = mockClientWithToolCall("pageindex_hierarchy", JSON.stringify({ query: "目录第3页" }))
  const selector = new ToolSelectorImpl(client, "test-model")
  const result = await selector.selectTool({ text: "目录第3页" })
  assert.equal(result.selection.tool, "pageindex_hierarchy")
  assert.equal(result.fallbackReason, undefined)
})

test("ToolSelectorImpl falls back when LLM returns no tool call (criterion #5)", async () => {
  const client = mockClientWithToolCall(null, "{}")
  const selector = new ToolSelectorImpl(client, "test-model")
  const result = await selector.selectTool({ text: "q" })
  assert.equal(result.selection.tool, "semantic_lexical_hybrid")
  assert.equal(result.fallbackReason, "no_tool_call")
})

test("ToolSelectorImpl falls back when LLM returns unknown tool name (criterion #5)", async () => {
  const client = mockClientWithToolCall("unknown_tool", JSON.stringify({ query: "q" }))
  const selector = new ToolSelectorImpl(client, "test-model")
  const result = await selector.selectTool({ text: "q" })
  assert.equal(result.selection.tool, "semantic_lexical_hybrid")
  assert.ok(result.fallbackReason?.startsWith("unknown_tool:"))
})

test("ToolSelectorImpl falls back when tool arguments are malformed JSON (criterion #5)", async () => {
  const client = mockClientWithToolCall("semantic_lexical_hybrid", "{invalid json}")
  const selector = new ToolSelectorImpl(client, "test-model")
  const result = await selector.selectTool({ text: "q" })
  assert.equal(result.selection.tool, "semantic_lexical_hybrid")
  assert.ok(result.fallbackReason?.startsWith("malformed_arguments:"))
})

test("ToolSelectorImpl falls back when tool arguments contain forbidden tenantId (criterion #2 + #5)", async () => {
  const client = mockClientWithToolCall("semantic_lexical_hybrid", JSON.stringify({ query: "q", tenantId: "t1" }))
  const selector = new ToolSelectorImpl(client, "test-model")
  const result = await selector.selectTool({ text: "q" })
  assert.equal(result.selection.tool, "semantic_lexical_hybrid")
  assert.ok(result.fallbackReason?.startsWith("invalid_arguments:"))
})

test("ToolSelectorImpl falls back when tool arguments contain forbidden sql (criterion #2 + #5)", async () => {
  const client = mockClientWithToolCall("semantic_lexical_hybrid", JSON.stringify({ query: "q", sql: "DROP TABLE" }))
  const selector = new ToolSelectorImpl(client, "test-model")
  const result = await selector.selectTool({ text: "q" })
  assert.equal(result.selection.tool, "semantic_lexical_hybrid")
  assert.ok(result.fallbackReason?.startsWith("invalid_arguments:"))
})

test("ToolSelectorImpl falls back when tool arguments have empty query", async () => {
  const client = mockClientWithToolCall("semantic_lexical_hybrid", JSON.stringify({ query: "" }))
  const selector = new ToolSelectorImpl(client, "test-model")
  const result = await selector.selectTool({ text: "q" })
  assert.equal(result.selection.tool, "semantic_lexical_hybrid")
  assert.ok(result.fallbackReason?.startsWith("invalid_arguments:"))
})

test("ToolSelectorImpl falls back on non-Abort LLM error (criterion #5)", async () => {
  const client = mockClientWithToolCall(null, "{}", { throwError: new Error("API rate limit") })
  const selector = new ToolSelectorImpl(client, "test-model")
  const result = await selector.selectTool({ text: "q" })
  assert.equal(result.selection.tool, "semantic_lexical_hybrid")
  assert.ok(result.fallbackReason?.startsWith("tool_selector_error:"))
  assert.ok(result.fallbackReason?.includes("API rate limit"))
})

test("ToolSelectorImpl re-throws AbortError (preserves user-cancellation)", async () => {
  const abortError = new Error("aborted")
  abortError.name = "AbortError"
  const client = mockClientWithToolCall(null, "{}", { throwError: abortError })
  const selector = new ToolSelectorImpl(client, "test-model")
  await assert.rejects(
    selector.selectTool({ text: "q" }),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
    "AbortError must propagate"
  )
})

test("ToolSelectorImpl fallback fills the query from the input (not from LLM args)", async () => {
  const client = mockClientWithToolCall(null, "{}")
  const selector = new ToolSelectorImpl(client, "test-model")
  const result = await selector.selectTool({ text: "the original query" })
  assert.equal(result.selection.tool, "semantic_lexical_hybrid")
  assert.equal(result.selection.args.query, "the original query")
  assert.equal(result.fallbackReason, "no_tool_call")
})

test("ToolSelectorImpl passes the query text as the user message to the LLM", async () => {
  let capturedMessages: any[] = []
  const mock: any = {
    chat: {
      completions: {
        create: async (params: any) => {
          capturedMessages = params.messages
          return {
            choices: [{
              message: {
                tool_calls: [{
                  type: "function",
                  function: { name: "semantic_lexical_hybrid", arguments: JSON.stringify({ query: "x" }) },
                }],
              },
            }],
          }
        },
      },
    },
  }
  const selector = new ToolSelectorImpl(mock as unknown as OpenAI, "test-model")
  await selector.selectTool({ text: "用户的问题" })
  assert.equal(capturedMessages.length, 2)
  assert.equal(capturedMessages[0].role, "system")
  assert.equal(capturedMessages[1].role, "user")
  assert.equal(capturedMessages[1].content, "用户的问题")
})

test("DR-12: the selector prompt states the same PageIndex applicability as the executor gate", async () => {
  let capturedMessages: any[] = []
  const mock: any = {
    chat: {
      completions: {
        create: async (params: any) => {
          capturedMessages = params.messages
          return {
            choices: [{
              message: {
                tool_calls: [{
                  type: "function",
                  function: { name: "pageindex_hierarchy", arguments: JSON.stringify({ query: "四路融合之后" }) },
                }],
              },
            }],
          }
        },
      },
    },
  }
  const selector = new ToolSelectorImpl(mock as unknown as OpenAI, "test-model")
  await selector.selectTool({ text: "四路融合之后" })
  const system = capturedMessages.find((message) => message.role === "system").content
  assert.match(system, /pageindex_hierarchy is applicable ONLY when the query asks for a page, section, chapter, or table-of-contents location/)
  assert.match(system, /definitional, conceptual and general-procedure questions must use semantic_lexical_hybrid/)
})

test("ToolSelectorImpl passes tools and tool_choice=auto to the LLM (criterion #1)", async () => {
  let capturedParams: any = null
  const mock: any = {
    chat: {
      completions: {
        create: async (params: any) => {
          capturedParams = params
          return {
            choices: [{
              message: {
                tool_calls: [{
                  type: "function",
                  function: { name: "semantic_lexical_hybrid", arguments: JSON.stringify({ query: "x" }) },
                }],
              },
            }],
          }
        },
      },
    },
  }
  const selector = new ToolSelectorImpl(mock as unknown as OpenAI, "test-model")
  await selector.selectTool({ text: "x" })
  assert.equal(capturedParams.tool_choice, "auto")
  assert.equal(capturedParams.tools.length, 3)
  assert.deepEqual(
    capturedParams.tools.map((t: any) => t.function.name),
    ["semantic_lexical_hybrid", "graph_navigation", "pageindex_hierarchy"]
  )
})
