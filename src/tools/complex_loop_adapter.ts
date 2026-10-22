/**
 * Ticket 34 (TOOL-01A) — binds the tool-invocation boundary to a complex
 * loop run: the loop declares WHAT it wants (tool + raw LLM args), this
 * adapter validates, allowlists, times out and executes against the RUN's
 * own searcher — the same authorized searcher the run retrieves with, so a
 * tool call can never see a wider scope than the run itself.
 *
 * PT-02 / PT-03 — the binding also carries the run's identity fields the
 * searcher needs for its non-knowledge channels: the server-bound session
 * (attachments) and the run's explicit web opt-in. They travel in the tool
 * environment only, exactly like AccessContext and RetrievalScope, so a model
 * tool call can neither name another session nor opt itself into the Web.
 */

import type { AccessContext } from "../access/context"
import type { RetrievalScope } from "../types/retrieval_scope"
import type { RetrievalResult } from "../types"
import type { Searcher, RetrievalChannel } from "../retrieval/search/interface"
import type { ToolInvoker } from "../retrieval/complex_loop"
import {
  ToolInvocationService,
  type ToolRegistry,
} from "./invocation"

/** The read-only retrieval policy's explicit tool allowlist. */
export const READ_ONLY_TOOL_ALLOWLIST = ["knowledge_search", "document_lookup", "wiki_search", "wiki_read_page"] as const

/**
 * The loop's decision vocabulary names the RETRIEVAL TOOLS of tickets 07/08
 * (semantic_lexical_hybrid / graph_navigation / pageindex_hierarchy), while
 * the Ticket-34 registry unifies all three under `knowledge_search` with a
 * `mode` argument. Without this translation every loop call — including the
 * controller's deterministic fallback decision — was refused as unknown_tool,
 * so the complex route could never retrieve anything once the invocation
 * boundary was wired (production), while the legacy direct-search path kept
 * the tests green.
 */
const LOOP_TOOL_TO_REGISTRY_ARGS: Record<string, { registryTool: string; mode?: string }> = {
  semantic_lexical_hybrid: { registryTool: "knowledge_search", mode: "semantic_lexical_hybrid" },
  graph_navigation: { registryTool: "knowledge_search", mode: "graph_navigation" },
  pageindex_hierarchy: { registryTool: "knowledge_search", mode: "pageindex_hierarchy" },
}

export interface ComplexLoopToolInvokerOptions {
  registry: ToolRegistry
  /** The run's explicit allowlist (derived from the assistant policy). */
  allowedTools: readonly string[]
  /** Per-call deadline in ms. */
  timeoutMs?: number
  accessContext?: AccessContext
  retrievalScope?: RetrievalScope
  signal?: AbortSignal
  /**
   * PT-02: the run's server-bound session id — the ONLY session its tool calls
   * may read attachments from. Omitted → no attachment channel, never a
   * session taken from the model's tool arguments.
   */
  sessionId?: string
  /** PT-03: the run's explicit web-search opt-in (`useWeb`). Omitted/false →
   * the Web channel is never opened by a tool call on its own. */
  webRequested?: boolean
  /** The run's own searcher — the ONLY retrieval authority a tool gets. */
  searcher?: Searcher
}

export function createComplexLoopToolInvoker(
  options: ComplexLoopToolInvokerOptions
): ToolInvoker {
  const service = new ToolInvocationService({
    registry: options.registry,
    allowedTools: options.allowedTools,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  })
  return async ({ tool, args }) => {
    const alias = LOOP_TOOL_TO_REGISTRY_ARGS[tool]
    const callTool = alias ? alias.registryTool : tool
    const callArgs = alias
      ? {
          query: (args as { query: string }).query,
          mode: alias.mode,
          ...("seeds" in args ? { seeds: (args as { seeds?: string[] }).seeds } : {}),
        }
      : args
    const invocation = await service.invoke(callTool, callArgs, {
      ...(options.accessContext ? { accessContext: options.accessContext } : {}),
      ...(options.retrievalScope ? { retrievalScope: options.retrievalScope } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      // PT-02 / PT-03: the run's bound session and web intent join the
      // environment here — mapped into the searcher's own option shapes, so a
      // tool call reads exactly what its run is allowed to read and nothing
      // wider. The loop's args contribute neither field.
      ...(options.sessionId ? { attachments: { sessionId: options.sessionId } } : {}),
      ...(options.webRequested === true ? { webRequested: true } : {}),
      ...(options.searcher ? { searcher: options.searcher } : {}),
    })
    if (invocation.outcome === "ok") {
      const result = invocation.result as {
        results: RetrievalResult[]
        unavailableChannels: RetrievalChannel[]
        degradationReasons?: string[]
        pages?: Array<{ slug: string; title: string; summary: string }>
        page?: { slug: string; title: string; content: string }
      }
      const wiki = tool === "wiki_search" ? result.pages
        : tool === "wiki_read_page" ? result.page : undefined
      return {
        outcome: "ok" as const,
        results: result.results,
        unavailableChannels: result.unavailableChannels,
        ...(result.degradationReasons?.length
          ? { degradationReasons: result.degradationReasons }
          : {}),
        ...(wiki ? { observation: `Wiki navigation (use original evidence for citations):\n${JSON.stringify(wiki).slice(0, 4000)}` } : {}),
      }
    }
    return {
      outcome: invocation.outcome,
      ...(invocation.trace.error ? { error: invocation.trace.error } : {}),
    }
  }
}
