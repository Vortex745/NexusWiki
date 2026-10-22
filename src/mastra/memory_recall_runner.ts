/**
 * Ticket 33 (MEM-01B) — bounded, traceable memory recall in front of the
 * route dispatch.
 *
 * Recall rules:
 *  - Scope: the caller's own (tenant, subject) via AccessContext, plus the
 *    assistant being run — global memories and that assistant's pinned
 *    memories, nothing else (the store's `recall` IS the scoping rule).
 *  - Disable: `useMemory === false` on the run, or `memoryEnabled === false`
 *    on the assistant version being run, skips recall entirely; ordinary
 *    answering is unaffected.
 *  - Trace: when memories were recalled, the output carries `memoryUsed`
 *    (ids + count). Memory never appears in references — it is not evidence.
 *  - Extraction: ONLY a COMPLETED answer produces extraction suggestions,
 *    and only PENDING ones. Failed/refused/cancelled/handoff answers never
 *    create suggestions or memories. Extraction failures are swallowed —
 *    they must never turn a good answer into a failed run.
 */

import type { MastraRunner } from "./chat_event_adapter"
import { MEMORY_RECALL_LIMIT, type RecalledMemory } from "./memory_prompt"
import type { LongTermMemoryStore } from "../memory/long_term_memory_store"
import { MemorySuggestionStore, extractMemorySuggestions } from "../memory/memory_suggestion_store"
import type { AccessContext } from "../access/context"

export interface MemoryRecallRunnerDeps {
  /** Absent → pure pass-through (evaluation scopes, probes, no deployment). */
  memories?: LongTermMemoryStore
  suggestions?: MemorySuggestionStore
  resolveTenantId: (accessContext: AccessContext) => string
  now?: () => Date
}

export function createMemoryRecallRunner(
  deps: MemoryRecallRunnerDeps,
  inner: MastraRunner
): MastraRunner {
  return async function memoryRecallRunner(input) {
    if (
      !deps.memories ||
      input.useMemory === false ||
      input.assistant?.memoryEnabled === false ||
      input.signal.aborted
    ) {
      return inner(input)
    }
    const tenantId = deps.resolveTenantId(input.accessContext)
    const assistantId = input.assistant?.id ?? null
    const recalled = deps.memories
      .recall(tenantId, input.accessContext.subjectId, assistantId)
      .slice(0, MEMORY_RECALL_LIMIT)
    const memories: RecalledMemory[] = recalled.map(({ id, content }) => ({ id, content }))

    const output = await inner(
      memories.length > 0 ? { ...input, longTermMemories: memories } : input
    )

    if (memories.length > 0) {
      output.memoryUsed = { ids: memories.map(({ id }) => id), count: memories.length }
    }

    // Extraction gate: completed answers only. Anything else (refusal,
    // invalid citation, provider error, cancellation, handoff) leaves no
    // suggestion behind.
    if (deps.suggestions && output.status === "completed") {
      try {
        for (const content of extractMemorySuggestions(input.message)) {
          deps.suggestions.createPending({
            tenantId,
            subjectId: input.accessContext.subjectId,
            assistantId,
            sourceRunId: input.runId,
            content,
          })
        }
      } catch (error) {
        console.warn(
          "[memory] suggestion extraction failed (answer unaffected):",
          error instanceof Error ? error.message : String(error)
        )
      }
    }
    return output
  }
}
