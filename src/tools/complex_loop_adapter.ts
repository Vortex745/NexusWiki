/**
 * Ticket 34 (TOOL-01A) — binds the tool-invocation boundary to a complex
 * loop run: the loop declares WHAT it wants (tool + raw LLM args), this
 * adapter validates, allowlists, times out and executes against the RUN's
 * own searcher — the same authorized searcher the run retrieves with, so a
 * tool call can never see a wider scope than the run itself.
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
export const READ_ONLY_TOOL_ALLOWLIST = ["knowledge_search", "document_lookup"] as const

export interface ComplexLoopToolInvokerOptions {
  registry: ToolRegistry
  /** The run's explicit allowlist (derived from the assistant policy). */
  allowedTools: readonly string[]
  /** Per-call deadline in ms. */
  timeoutMs?: number
  accessContext?: AccessContext
  retrievalScope?: RetrievalScope
  signal?: AbortSignal
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
    const invocation = await service.invoke(tool, args, {
      ...(options.accessContext ? { accessContext: options.accessContext } : {}),
      ...(options.retrievalScope ? { retrievalScope: options.retrievalScope } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.searcher ? { searcher: options.searcher } : {}),
    })
    if (invocation.outcome === "ok") {
      const result = invocation.result as {
        results: RetrievalResult[]
        unavailableChannels: RetrievalChannel[]
      }
      return {
        outcome: "ok" as const,
        results: result.results,
        unavailableChannels: result.unavailableChannels,
      }
    }
    return {
      outcome: invocation.outcome,
      ...(invocation.trace.error ? { error: invocation.trace.error } : {}),
    }
  }
}
