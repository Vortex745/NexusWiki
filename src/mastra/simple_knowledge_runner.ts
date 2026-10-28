/**
 * Ticket 11 — Simple knowledge route Mastra runner.
 *
 * Implements the `MastraRunner` seam (defined in Ticket 05) for the simple
 * knowledge route: retrieval → Evidence → Context → answer Draft → Citation
 * check → Critic validation loop (≤3 rounds with correction retrieval) →
 * publish / handoff.
 *
 * This runner reuses the existing authorized retrieval stack (Searcher with
 * AccessContext), Evidence builder, ContextAssembler, ContextCompressor,
 * Validator, RePlanner, ToolSelector, ConversationStore, Contextualizer,
 * Summarizer, and HandoffStore — it does NOT re-implement their behavior.
 * The only abstraction is `streamAnswerDraft` (the LLM call seam), mirroring
 * the T09 `streamDirectReply` pattern so the runner can be tested without the
 * real @mastra/core Agent.
 *
 * Boundary (T02 #5): this module MUST NOT import `src/api/*` or `src/index`.
 * It depends only on:
 *   - `src/mastra/chat_event_adapter.ts` (MastraRunner seam + types)
 *   - `src/retrieval/router/interface.ts` (Router interface)
 *   - `src/retrieval/search/interface.ts` (Searcher, SearchOptions)
 *   - `src/retrieval/context/interface.ts` (ContextAssembler)
 *   - `src/retrieval/tool_selector.ts` (ToolSelector, RetrievalToolName)
 *   - `src/critic/validator/interface.ts` (Validator)
 *   - `src/critic/replanner/interface.ts` (RePlanner)
 *   - `src/answer/conversation_store.ts` (ConversationStore)
 *   - `src/answer/contextualizer.ts` (Contextualizer)
 *   - `src/answer/context_compressor.ts` (ContextCompressor)
 *   - `src/answer/summarizer.ts` (Summarizer)
 *   - `src/answer/handoff_store.ts` (HandoffStore)
 *   - `src/answer/evidence.ts` (buildEvidence, citationIdsByChunk, referencesForReply)
 *   - `src/answer/terminal_copy.ts` (public terminal copy + publishability)
 *   - `src/answer/context_pipeline.ts` (shared material/budget/compression decision)
 *   - `src/answer/generation_snapshot.ts` (generation-context-v1 describer)
 *   - `src/retrieval/context/correction_selection.ts` (shared gap-first selection)
 *   - `src/access/context.ts` (AccessContext)
 *   - `src/types` (AgentMessage, AnswerRunResult, Evidence, Query, RetrievalResult, ...)
 *
 * @mastra/core decoupling: the LLM stream is injected via `streamAnswerDraft`
 * so the runner can be tested in isolation. T11's production wiring (in
 * `src/index.ts`) constructs a real @mastra/core Agent and adapts its
 * `stream()` output to the `AsyncIterable<string>` signature.
 *
 * Cancellation contract (T11 #5): the runner respects `input.signal.aborted`
 * at every await point via the `abortable()` helper. Mid-stream abort surfaces
 * as AbortError from `streamAnswerDraft` and propagates out of the runner.
 *
 * Trace data aggregation: the runner returns a single MastraRunnerOutput with
 * aggregated trace data for the 4 progress stages (route/retrieval/context/
 * validation). The T05 chat_event_adapter emits the 6 AnswerRunEvent types
 * using this trace data; intermediate events within the runner (e.g. multiple
 * retrieval rounds) are folded into the final trace. T14 owns the
 * shadow-parity audit that compares Mastra vs legacy event streams.
 */

import type {
  MastraRunner,
  MastraRunnerInput,
  MastraRunnerOutput,
} from "./chat_event_adapter"
import type { Router } from "../retrieval/router/interface"
import type {
  RetrievalOrdering,
  Searcher,
  SearchOptions,
} from "../retrieval/search/interface"
import { SYSTEM_PROMPT } from "./system_prompt"
import { renderMemoryPromptSuffix } from "./memory_prompt"
import type { ContextAssembler } from "../retrieval/context/interface"
import {
  findUncoveredGapFacts,
  selectCorrectionCandidates,
} from "../retrieval/context/correction_selection"
import type {
  ToolSelector,
  RetrievalToolName,
} from "../retrieval/tool_selector"
import {
  formatToolInputSummary,
  toolToSearchOptions,
} from "../retrieval/tool_selector"
import type { Validator } from "../critic/validator/interface"
import { bindAnswerBasis } from "./answer_basis"
import type { RePlanner } from "../critic/replanner/interface"
import type { ConversationStore, ConversationTurn } from "../answer/conversation_store"
import type { Contextualizer } from "../answer/contextualizer"
import type {
  ContextCompressor,
  ContextCompressionResult,
} from "../answer/context_compressor"
// PT-06 / PT-07 — the ONE material-backed context preparation both knowledge
// routes run, and PT-08 — the one description of what the generator actually
// received. Importing them here is the ticket: no route may keep its own copy
// of the material-selection or the generation-snapshot rule.
import {
  compressionTraceFields,
  prepareGenerationContext,
} from "../answer/context_pipeline"
import { describeActualGenerationContext } from "../answer/generation_snapshot"
import type { ContextMaterial } from "../retrieval/context/assembler"
import type { Summarizer } from "../answer/summarizer"
import type { HandoffStore } from "../answer/handoff_store"
import {
  buildEvidence,
  citationIdsByChunk,
  referencesForReply,
} from "../answer/evidence"
import { toRankedCandidateObservations } from "./runner_observation"
import type { AccessContext } from "../access/context"
import type {
  AgentMessage,
  AnswerDegradation,
  AnswerDegradationReason,
  AnswerRunResult,
  AnswerBasis,
  Evidence,
  Query,
  RetrievalResult,
  RetrievalTraceData,
  RouteTraceData,
  ContextTraceData,
  ValidationTraceData,
  TokenUsage,
} from "../types"
import type { AnswerModelStreamOptions } from "../answer/generation"

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * Streamed LLM answer draft for the simple knowledge route. Receives the
 * full AgentMessage[] (system prompt + user-with-context) and returns an
 * async iterable of token strings, mirroring `model.stream()` in legacy
 * `src/answer/generation.ts`.
 *
 * The runner iterates this to collect tokens for `MastraRunnerOutput.tokens`
 * + `reply`. Mid-stream abort MUST surface as an AbortError thrown from the
 * iterable (the runner does not install its own abort listener on the stream
 * — the iterable is expected to honor the signal, matching the T09 pattern).
 */
export type KnowledgeAnswerDraftStream = (
  messages: AgentMessage[],
  signal: AbortSignal,
  /** Generation parameters for THIS draft (the run's frozen reasoning
   * effort). Omitted for runs that never asked — the call stays unchanged. */
  options?: AnswerModelStreamOptions
) => AsyncIterable<string>

/**
 * Resolve tenantId from AccessContext. The runner needs tenantId for
 * ConversationStore operations (load memory, save validated turns, consume
 * pending clarification, handoff). Extracted as a dependency so the runner
 * doesn't hardcode AccessContext field assumptions (single-tenant vs enforced
 * mode). Mirrors the T09 pattern.
 */
export type TenantIdResolver = (accessContext: AccessContext) => string

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Error thrown when the route decision is not "simple". T11 owns only the
 * simple knowledge route; direct/ambiguous routes are owned by T09 and
 * complex route is owned by T12. The T08 runtime boundary catches this
 * error and falls back to the legacy orchestrator (T09 #5 route-level
 * fallback without data conversion).
 *
 * Note: T09's `RouteNotSupportedError` throws for both "simple" and
 * "complex". T11's `RouteNotSimpleError` is a distinct error so the T11
 * runner can be composed with the T09 runner in a route-dispatch layer
 * (T11 Step 3) without ambiguity. The dispatch layer routes "simple" to
 * this runner and lets T09's RouteNotSupportedError handle the rest.
 */
export class RouteNotSimpleError extends Error {
  constructor(public readonly decision: "direct" | "ambiguous" | "complex") {
    super(
      `Route "${decision}" is not supported by SimpleKnowledgeMastraRunner (T11). ` +
      `Supported route: simple. The route-dispatch layer should have routed this ` +
      `decision to the T09 DirectAmbiguousMastraRunner (direct/ambiguous) or the ` +
      `legacy orchestrator (complex, until T12).`
    )
    this.name = "RouteNotSimpleError"
  }
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface SimpleKnowledgeMastraRunnerDeps {
  /** Legacy Router — called once per run to get the route decision (GATE 0). */
  router: Router
  /** Factory for the authorized Searcher (called once per run, may be called again for correction retrieval). */
  /** Ticket 19: the assistant snapshot decides which searcher variant runs
   *  (e.g. a `rerankModelProfileId: null` binding runs without the reranker). */
  createSearcher: (assistant?: import("../assistants/assistant_service").AssistantRunSnapshot) => Searcher
  /** Legacy ContextAssembler — builds bounded Context from selected RetrievalResults. */
  assembler: ContextAssembler
  /** Legacy Validator (Critic) — checks answer coverage against context. */
  validator: Validator
  /** Legacy RePlanner — produces gap queries when validation fails. */
  replanner: RePlanner
  /** Streamed LLM answer draft (abstracts @mastra/core Agent). */
  streamAnswerDraft: KnowledgeAnswerDraftStream
  /**
   * Ticket 07 (spec §12): LLM-backed single-round retrieval tool selector.
   * Optional — when absent, the default Searcher channels run (backward
   * compat with pre-Ticket 07 callers).
   */
  toolSelector?: ToolSelector
  /**
   * Ticket 61/04: LLM-backed Evidence-Context compressor. Optional — when
   * absent, the deterministic assembler output is used as-is.
   */
  compressor?: ContextCompressor
  /**
   * ConversationStore for memory loading, pending-clarification consumption,
   * validated turn persistence, and rolling-summary triggers. Optional for
   * single_turn backward compat.
   */
  conversationStore?: ConversationStore
  /**
   * Ticket 08 P3: rewrites a follow-up into a standalone query using
   * recentTurns before Router classification. Optional — omitting yields
   * single_turn backward compat.
   */
  contextualizer?: Contextualizer
  /**
   * Ticket 61/02: LLM-backed rolling-summary provider. Optional — when
   * absent, no summarization is triggered.
   */
  summarizer?: Summarizer
  /**
   * Ticket 09 P4: HandoffStore persistence. When present AND accessContext
   * is available, correction exhaustion (gap queries exhausted OR 3 rounds
   * exhausted without approval) terminates the run with `handoff_required`
   * instead of `insufficient_evidence`. Absent → single_tenant backward
   * compat (no handoff).
   */
  handoffStore?: HandoffStore
  /**
   * Resolve tenantId from AccessContext. Required when conversationStore or
   * handoffStore is wired.
   */
  resolveTenantId?: TenantIdResolver
  /**
   * Clock for `createdAt` timestamps on saved validated turns. Injected for
   * testability; defaults to `() => new Date()` in production.
   */
  now?: () => Date
}

// ---------------------------------------------------------------------------
// Helpers (mirrors of legacy generation.ts internals)
// ---------------------------------------------------------------------------

import {
  INSUFFICIENT_EVIDENCE_MESSAGE,
  INSUFFICIENT_RETRIEVAL_MESSAGE,
  publicTerminalCopy,
} from "../answer/terminal_copy"

function abortError(checkpoint: string): Error {
  const error = new Error(`Answer run cancelled at ${checkpoint}`)
  error.name = "AbortError"
  return error
}

function checkAbort(signal: AbortSignal, checkpoint: string): void {
  if (signal.aborted) throw abortError(checkpoint)
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError("abortable guard"))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError("abortable race"))
    signal.addEventListener("abort", onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener("abort", onAbort)
        reject(err)
      }
    )
  })
}

async function* abortableStream<T>(
  stream: AsyncIterable<T>,
  signal: AbortSignal
): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]()
  try {
    while (true) {
      const next = await abortable(iterator.next(), signal)
      if (next.done) return
      yield next.value
    }
  } finally {
    if (signal.aborted && iterator.return) void iterator.return()
  }
}

function diversifySelect(
  groups: RetrievalResult[][],
  limit: number
): RetrievalResult[] {
  const seen = new Set<string>()
  const selected: RetrievalResult[] = []
  const queues = groups.map((g) => [...g])
  let added = true
  while (selected.length < limit && added) {
    added = false
    for (const queue of queues) {
      while (queue.length > 0) {
        const result = queue.shift()!
        const key = `${result.chunk.documentId}\0${result.chunk.id}`
        if (seen.has(key)) continue
        seen.add(key)
        selected.push(result)
        added = true
        break
      }
    }
  }
  return selected
}

// PT-04: the correction-round identity dedup + gap-first ordering used to live
// here as a local `uniqueResults(accumulatedResults)` call, which kept the
// OLDEST hit of a repeated identity and left the fresh 补检 material at the
// tail of the assembler's queue. The rule now has one owner —
// `selectCorrectionCandidates` in `../retrieval/context/correction_selection` —
// shared by the simple and the complex runner so the two routes cannot drift.

function normalizeGapQuery(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ")
}

function summarizeConversationForHandoff(
  turns: ConversationTurn[],
  summary?: string | null
): string {
  const parts: string[] = []
  if (summary) parts.push(`[较早摘要] ${summary}`)
  parts.push(turns.map((t) => `${t.role}: ${t.content}`).join("\n"))
  return parts.join("\n")
}

/** Ticket 33/31: the validated turn pair every completed answer records. */
export function saveValidatedTurnPair(
  conversationStore: ConversationStore,
  sessionId: string,
  tenantId: string,
  runId: string,
  userMessage: string,
  assistantReply: string,
  clock: () => Date
): void {
  const now = clock().toISOString()
  conversationStore.saveValidatedTurn({
    sessionId, tenantId, role: "user",
    content: userMessage, runId, createdAt: now,
  })
  conversationStore.saveValidatedTurn({
    sessionId, tenantId, role: "assistant",
    content: assistantReply, runId, createdAt: now,
  })
}

interface SummarizationOutcome {
  usage?: TokenUsage
  durationMs?: number
  checkpoint?: number
  outcome: "success" | "skipped" | "failed"
}

async function triggerSummarization(
  conversationStore: ConversationStore,
  summarizer: Summarizer | undefined,
  sessionId: string,
  tenantId: string,
  signal: AbortSignal
): Promise<SummarizationOutcome> {
  if (!summarizer) return { outcome: "skipped" }
  const start = Date.now()
  try {
    const memory = conversationStore.loadConversationMemory(sessionId, tenantId)
    if (memory.totalValidatedTurnCount <= 12) return { outcome: "skipped" }
    if (memory.oldestRecentTurnId === null) return { outcome: "skipped" }
    const newCheckpoint = memory.oldestRecentTurnId - 1
    const previousCheckpoint = memory.summarizedThroughTurnId ?? 0
    if (newCheckpoint <= previousCheckpoint) return { outcome: "skipped" }
    const olderTurns = conversationStore.loadOlderTurnsForSummarization(
      sessionId, tenantId, previousCheckpoint, newCheckpoint
    )
    if (olderTurns.length === 0 && memory.summary) return { outcome: "skipped" }
    const result = await summarizer.summarize(olderTurns, memory.summary, signal)
    if (signal.aborted || !result.summary) {
      return { outcome: "failed", durationMs: Date.now() - start }
    }
    conversationStore.saveRollingSummary(
      sessionId, tenantId, result.summary, newCheckpoint, 1
    )
    return {
      outcome: "success",
      usage: result.usage,
      durationMs: Date.now() - start,
      checkpoint: newCheckpoint,
    }
  } catch {
    return { outcome: "failed", durationMs: Date.now() - start }
  }
}

// ---------------------------------------------------------------------------
// Runner factory
// ---------------------------------------------------------------------------

/**
 * Create a MastraRunner that handles the simple knowledge route.
 *
 * Throws `RouteNotSimpleError` for direct/ambiguous/complex routes so the
 * route-dispatch layer (T11 Step 3) can route them appropriately. T11 owns
 * only the simple route; direct/ambiguous are owned by T09 and complex is
 * owned by T12.
 */
export function createSimpleKnowledgeMastraRunner(
  deps: SimpleKnowledgeMastraRunnerDeps
): MastraRunner {
  const {
    router,
    createSearcher,
    assembler,
    validator,
    replanner,
    streamAnswerDraft,
    toolSelector,
    compressor,
    conversationStore,
    contextualizer,
    summarizer,
    handoffStore,
    resolveTenantId,
  } = deps
  const clock = deps.now ?? (() => new Date())

  return async function simpleKnowledgeMastraRunner(
    input: MastraRunnerInput
  ): Promise<MastraRunnerOutput> {
    // T11 #5 cancellation checkpoint 1: before Router call (pre-route abort).
    if (input.signal.aborted) {
      throw abortError("GATE 0 (before route)")
    }

    const { signal, accessContext, sessionId, runId, retrievalScope, assistant } = input
    const tenantId = resolveTenantId ? resolveTenantId(accessContext) : "default"
    const preparedRoute = input.preparedRoute

    // -------------------------------------------------------------------------
    // Memory loading + pending clarification consumption (mirrors legacy
    // generation.ts L437-L458).
    // -------------------------------------------------------------------------
    let effectiveMessage = preparedRoute?.effectiveMessage ?? input.message
    let recentTurns: ConversationTurn[] = []
    let conversationSummary: string | null = null
    if (conversationStore) {
      if (!preparedRoute) {
        const pendingMessage = conversationStore.peekPendingClarification?.(
          sessionId,
          tenantId
        )
        if (pendingMessage) {
          effectiveMessage = `${pendingMessage} ${input.message}`
        }
      }
      const memory = conversationStore.loadConversationMemory(sessionId, tenantId)
      recentTurns = memory?.recentTurns ?? []
      conversationSummary = memory?.summary ?? null
    }

    // -------------------------------------------------------------------------
    // Contextualization (mirrors legacy generation.ts L472-L502). Rewrites the
    // follow-up into a standalone query using recentTurns before Router
    // classification. Failures degrade to effectiveMessage (safe); AbortError
    // propagates.
    // -------------------------------------------------------------------------
    let contextualizedQuery = preparedRoute?.contextualizedQuery ?? effectiveMessage
    let contextualizationFailure = preparedRoute?.routeTrace.contextualizationFailure
    let contextualizationUsage = preparedRoute?.routeTrace.contextualizationUsage
    let contextualizationDurationMs = preparedRoute?.routeTrace.contextualizationDurationMs
    let contextualizationOutcome = preparedRoute?.routeTrace.contextualizationOutcome
    if (!preparedRoute && contextualizer && recentTurns.length > 0) {
      const ctxStart = Date.now()
      try {
        const result = await abortable(
          contextualizer.contextualize(
            effectiveMessage,
            recentTurns,
            conversationSummary
          ),
          signal
        )
        contextualizationDurationMs = Date.now() - ctxStart
        contextualizationUsage = result.usage
        if (result.query.trim()) {
          contextualizedQuery = result.query
          contextualizationOutcome = "success"
        } else {
          contextualizationFailure = "contextualize returned empty query"
          contextualizationOutcome = "failed"
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err
        contextualizationFailure = err instanceof Error ? err.message : String(err)
        contextualizationDurationMs = Date.now() - ctxStart
        contextualizationOutcome = "failed"
      }
    } else if (!preparedRoute) {
      contextualizationOutcome = "skipped"
    }

    // -------------------------------------------------------------------------
    // GATE 0: route decision (T03 §2.3 hybrid topology — deterministic gate).
    // -------------------------------------------------------------------------
    const decision = preparedRoute?.decision ?? await abortable(
      router.decide({ text: contextualizedQuery }),
      signal
    )

    if (decision !== "simple") {
      // T11 owns only the simple route. Throw RouteNotSimpleError so the
      // route-dispatch layer can route direct/ambiguous to the T09 runner
      // and complex to the legacy orchestrator (until T12).
      throw new RouteNotSimpleError(decision)
    }
    if (!preparedRoute) input.onStageProgress?.("route", { status: "completed", data: { decision } })
    input.onStageProgress?.("retrieval", { round: 1 })

    // Destructive state change belongs to the selected route owner only.
    if (conversationStore && !preparedRoute) {
      checkAbort(signal, "GATE 0 (before pending clarification consume)")
      if (conversationStore.claimPendingClarification) {
        conversationStore.claimPendingClarification(sessionId, tenantId)
      } else {
        conversationStore.consumePendingClarification(sessionId, tenantId)
      }
    }

    // -------------------------------------------------------------------------
    // Tool selection (Ticket 07, optional). Ask the LLM which read-only
    // retrieval tool best fits the standalone query, then map the selection
    // to SearchOptions.channels.
    // -------------------------------------------------------------------------
    let selectedTool: RetrievalToolName | undefined
    let toolInputSummary: string | undefined
    let toolFallbackReason: string | undefined
    let perQueryOptions: SearchOptions = {}
    const buildRouteTrace = (): RouteTraceData => ({
      ...(preparedRoute?.routeTrace ?? {}),
      decision: "simple",
      ...(selectedTool ? { selectedTool } : {}),
      ...(toolFallbackReason ? { toolFallbackReason } : {}),
      ...(contextualizationOutcome ? { contextualizationOutcome } : {}),
      ...(contextualizationFailure ? { contextualizationFailure } : {}),
      ...(contextualizationUsage ? { contextualizationUsage } : {}),
      ...(contextualizationDurationMs != null ? { contextualizationDurationMs } : {}),
    })
    if (toolSelector) {
      const toolResult = await abortable(
        toolSelector.selectTool({ text: contextualizedQuery }, signal),
        signal
      )
      selectedTool = toolResult.selection.tool
      toolInputSummary = formatToolInputSummary(toolResult.selection)
      toolFallbackReason = toolResult.fallbackReason
      perQueryOptions = { ...perQueryOptions, ...toolToSearchOptions(toolResult.selection) }
    }

    // -------------------------------------------------------------------------
    // GATE 1: retrieval (single query for simple route).
    // -------------------------------------------------------------------------
    const searcher = createSearcher(assistant)
    const query: Query = { text: contextualizedQuery }
    const unavailableChannels = new Set<RetrievalResult["source"]>()
    let retrievalAttempted = false
    let retrievalAvailable = false
    const resultGroups: RetrievalResult[][] = []

    retrievalAttempted = true
    const outcome = await abortable(
      searcher.search(query, {
        ...perQueryOptions,
        accessContext,
        // Ticket 05 (KB-03A): carry the server-computed knowledge scope into
        // the retrieval channels.
        ...(retrievalScope ? { retrievalScope } : {}),
        // Ticket 22 (ATT-01): this run may also read its OWN session's
        // temporary attachments — never another session's.
        ...(sessionId ? { attachments: { sessionId } } : {}),
        // Ticket 36 (WEB-01): the run's explicit web-search opt-in. URL reads
        // of links pasted into the message never need the flag.
        ...(input.useWeb === true ? { webRequested: true } : {}),
        signal,
      }),
      signal
    )
    outcome.unavailableChannels.forEach((channel) => unavailableChannels.add(channel))
    if (outcome.status !== "insufficient") retrievalAvailable = true
    resultGroups.push(outcome.results)
    // Ticket 06: the initial context comes from this single search, so its
    // ordering label is the one that will describe the scored ranking.
    let initialOrdering = outcome.ordering

    // Tool-selection zero-result fallback: the tool selector deliberately
    // narrows the search to ONE channel family (pageindex_hierarchy →
    // ["pageIndex"], graph_navigation → ["graph"]). When that channel has no
    // match — the pageIndex node lookup is a whole-query title/summary LIKE
    // and graph entities exist only for wikified KBs — the narrowed search
    // legitimately returns nothing while the unselected channels (vector,
    // bm25) would have hits, turning one bad LLM pick into a hard
    // insufficient_evidence terminal for ordinary questions. Retry once with
    // the default (un-narrowed) channels and keep the fallback traceable.
    if (resultGroups[0].length === 0 && selectedTool) {
      toolFallbackReason = `${toolFallbackReason ? toolFallbackReason + "; " : ""}selected tool ${selectedTool} returned 0 results; retried with default channels`
      const fallbackOutcome = await abortable(
        searcher.search(query, {
          accessContext,
          ...(retrievalScope ? { retrievalScope } : {}),
          ...(sessionId ? { attachments: { sessionId } } : {}),
          ...(input.useWeb === true ? { webRequested: true } : {}),
          signal,
        }),
        signal
      )
      fallbackOutcome.unavailableChannels.forEach((channel) => unavailableChannels.add(channel))
      if (fallbackOutcome.status !== "insufficient") retrievalAvailable = true
      resultGroups.push(fallbackOutcome.results)
      if (fallbackOutcome.results.length > 0) initialOrdering = fallbackOutcome.ordering
    }

    // Build the initial retrieval trace data (aggregated; final state).
    const channelStatuses = Object.fromEntries(
      (["vector", "bm25", "graph", "web"] as const).map((channel) => [
        channel,
        unavailableChannels.has(channel) ? "unavailable" : "completed",
      ])
    )
    let retrievalTrace: RetrievalTraceData = {
      channelStatuses,
      resultCount: resultGroups.reduce((sum, group) => sum + group.length, 0),
      selectedEvidenceIds: [],
      degradedReasons: [
        ...outcome.unavailableChannels.map((channel) => `${channel} unavailable`),
        // Ticket 36 (WEB-01): honest web notes (e.g. web_unconfigured).
        ...(outcome.degradationReasons ?? []),
      ],
      ...(selectedTool ? { selectedTool } : {}),
      ...(toolInputSummary ? { toolInputSummary } : {}),
      ...(toolFallbackReason ? { toolFallbackReason } : {}),
      ...(outcome.unselectedChannels && outcome.unselectedChannels.length > 0
        ? { unselectedChannels: outcome.unselectedChannels }
        : {}),
    }
    input.onStageProgress?.("retrieval", { status: "completed", round: 1, data: { resultCount: retrievalTrace.resultCount } })

    // Insufficient retrieval check (T11 #5: terminal insufficient_retrieval).
    if (retrievalAttempted && !retrievalAvailable) {
      return {
        reply: INSUFFICIENT_RETRIEVAL_MESSAGE,
        status: "insufficient_retrieval",
        references: [],
        degradation: {
          status: "insufficient",
          unavailableChannels: [...unavailableChannels],
        },
        tokens: [INSUFFICIENT_RETRIEVAL_MESSAGE],
        routeTrace: buildRouteTrace(),
        retrievalTrace,
        contextTrace: {},
        validationTrace: {},
      }
    }

    // -------------------------------------------------------------------------
    // Evidence building (T11 #2: stable Evidence identities).
    // -------------------------------------------------------------------------
    const allResults = resultGroups.flat()
    const selectedResults = diversifySelect(resultGroups, 10)
    const selectedKeys = new Set(selectedResults.map(({ chunk }) =>
      `${chunk.documentId}\0${chunk.id}`
    ))
    // PT-04: reassigned on every correction round to the gap-first ordered
    // list (newest 补检 material in front), never to a tail-append.
    let accumulatedResults = allResults.filter(({ chunk }) =>
      selectedKeys.has(`${chunk.documentId}\0${chunk.id}`)
    )
    let evidence: Evidence[] = buildEvidence(accumulatedResults)
    retrievalTrace = {
      ...retrievalTrace,
      selectedEvidenceIds: evidence.map(({ id }) => id),
    }

    // Empty Evidence check (T11 #3: cannot complete without usable Evidence).
    if (evidence.length === 0) {
      const evidenceReason: AnswerDegradationReason =
        allResults.length === 0 ? "no_results" : "no_context_evidence"
      return {
        reply: INSUFFICIENT_EVIDENCE_MESSAGE,
        status: "insufficient_evidence",
        references: [],
        degradation: {
          status: "insufficient",
          unavailableChannels: [...unavailableChannels],
          reason: evidenceReason,
        },
        tokens: [INSUFFICIENT_EVIDENCE_MESSAGE],
        routeTrace: buildRouteTrace(),
        retrievalTrace,
        contextTrace: {},
        validationTrace: {},
      }
    }

    // -------------------------------------------------------------------------
    // GATE 2: context assembly (T11 #2: bounded Context representation).
    // -------------------------------------------------------------------------
    // Eval refactor Ticket 01: observation of the FINAL actual generation
    // context. Committed only when the draft generated from that context is
    // accepted (citation check passed), so the observed candidates always
    // correspond to the round that produced the published reply — never to a
    // context whose draft was rejected. Round numbers are 1-based generation
    // rounds (1 = initial draft, +1 per correction regeneration).
    let finalContextRound = 0
    /**
     * Ticket 06: the committed round also carries HOW its ranking was
     * produced. One contributing search keeps its own label (dedicated rerank
     * or the honest fused reason); several merged searches are reported as an
     * aggregation, never as a dedicated-rerank success.
     *
     * PT-04: `mergedAcrossRounds` is the correction case. That candidate list
     * is this round's gap hits merged in front of the earlier retrievals, so NO
     * single search ordering produced it — even when exactly one contributing
     * gap search carried `dedicated_rerank`, the honest label is the
     * aggregation. Selection here is an ordering rule, never a reranker.
     */
    const commitFinalContext = (
      candidates: RetrievalResult[],
      citationIds: Map<string, string>,
      orderings: RetrievalOrdering[],
      mergedAcrossRounds = false
    ): void => {
      finalContextRound += 1
      retrievalTrace = {
        ...retrievalTrace,
        finalContextCandidates: toRankedCandidateObservations(candidates, citationIds),
        finalContextRound,
        ...(mergedAcrossRounds
          ? {
              finalContextOrdering: {
                source: "fused" as const,
                reason: "multi_query_aggregation" as const,
              },
            }
          : orderings.length > 0
            ? {
                finalContextOrdering:
                  orderings.length === 1
                    ? orderings[0]
                    : { source: "fused" as const, reason: "multi_query_aggregation" as const },
              }
            : {}),
      }
    }
    const initialCitationIds = citationIdsByChunk(evidence)
    // PT-06:AC01/AC07 + PT-08:AC01 — the state of the context that is currently
    // going to the generator: the material behind it, the compression actually
    // adopted for it, and the trace describing both. Reassigned every round, so
    // a refused compression can never leave the records pointing at compressed
    // ids that were not used.
    let context = ""
    let material: ContextMaterial | null = null
    let compression: ContextCompressionResult | null = null
    let contextTrace: ContextTraceData = {}
    // PL-05 / PT-08 — ONE `generation-context-v1` snapshot per ACTUAL generation
    // call. It is attached only after a draft really completed, so a 补检 that
    // never regenerated adds nothing, a cancelled or provider-failed call leaves
    // no phantom round, and the LAST attached snapshot is the final one because
    // the trace the adapter publishes is this aggregated object.
    let generationRound = 0
    const describeGenerationContext = (): void => {
      generationRound += 1
      contextTrace = {
        ...contextTrace,
        generationContext: describeActualGenerationContext({
          generationRound,
          context,
          material,
          compression,
          evidence,
        }),
      }
    }
    input.onStageProgress?.("context", { round: 1, data: { phase: "assembly", evidenceCount: evidence.length } })
    // PT-06:AC01/AC07 — the COMPLETE authorized material, assembled once and
    // consumed by the budget decision, the compressor and the generator prompt.
    const initial = await abortable(
      prepareGenerationContext({
        assembler,
        results: selectedResults,
        citationIds: initialCitationIds,
        evidence,
        query: effectiveMessage,
        ...(compressor ? { compressor } : {}),
        ...(signal ? { signal } : {}),
      }),
      signal
    )
    context = initial.context
    material = initial.material
    compression = initial.compression
    contextTrace = {
      evidenceCount: evidence.length,
      contextLength: context.length,
      ...compressionTraceFields(initial),
    }
    input.onStageProgress?.("context", { status: "completed", round: 1, data: { phase: "assembly", evidenceCount: evidence.length, contextLength: context.length } })
    input.onStageProgress?.("context", { round: 1, data: { phase: "draft", evidenceCount: evidence.length } })

    // -------------------------------------------------------------------------
    // GATE 3: answer draft (LLM stream). Draft tokens are withheld until the
    // Critic approves (T03 §5 single-shot; the runner does NOT publish tokens
    // directly — the adapter publishes them from MastraRunnerOutput.tokens).
    // -------------------------------------------------------------------------
    // Ticket 33 (MEM-01B): recalled long-term memories ride the system prompt
    // as clearly-labeled background — never evidence, never citations.
    const memorySuffix = renderMemoryPromptSuffix(input.longTermMemories)
    const initialMessages: AgentMessage[] = [
      // Ticket 19 (AST-01B): the assistant's own prompt leads, ahead of the
      // platform instructions — it is part of the immutable version snapshot.
      ...(assistant?.systemPrompt
        ? [{ role: "system" as const, content: assistant.systemPrompt }]
        : []),
      { role: "system", content: SYSTEM_PROMPT + memorySuffix },
      { role: "user", content: `${context}\n\n用户问题：${effectiveMessage}` },
    ]
    const initialTokens: string[] = []
    for await (const token of abortableStream(
      streamAnswerDraft(
        initialMessages,
        signal,
        input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : undefined
      ),
      signal
    )) {
      initialTokens.push(token)
    }
    const initialAnswer = initialTokens.join("")
    // PT-08:AC01/AC05 — this draft really was generated: record the context it
    // was generated from, on whichever branch produced it (deterministic full,
    // deterministic partial, compressed, or the compression-failure fallback).
    describeGenerationContext()
    contextTrace.phase = "draft"
    input.onStageProgress?.("context", { status: "completed", round: 1, data: { phase: "draft", evidenceCount: evidence.length } })

    // Citation check (T11 #4: unknown Citations rejected before publication).
    try {
      referencesForReply(initialAnswer, evidence)
    } catch {
      return {
        reply: publicTerminalCopy("invalid_citation"),
        status: "invalid_citation",
        references: [],
        degradation: {
          status: "insufficient",
          unavailableChannels: [...unavailableChannels],
          reason: "no_cited_claims",
        },
        tokens: [],
        routeTrace: buildRouteTrace(),
        retrievalTrace,
        contextTrace,
        validationTrace: {},
      }
    }
    // Ticket 01: the initial draft was accepted — its context is the current
    // final generation context.
    commitFinalContext(
      selectedResults,
      initialCitationIds,
      initialOrdering ? [initialOrdering] : []
    )
    let fullAnswer = initialAnswer
    let draftTokens: string[] = [...initialTokens]
    let validationTrace: ValidationTraceData = {}

    // -------------------------------------------------------------------------
    // GATE 4: validation loop (≤3 rounds, with correction retrieval).
    // -------------------------------------------------------------------------
    const seenGapQueries = new Set<string>()
    let approved = false
    let approvedBasis: AnswerBasis | undefined
    let terminalStatus: AnswerRunResult["status"] | null = null
    let terminalReply = ""
    let terminalReferences: AnswerRunResult["references"] = []
    // PL-01: an unapproved draft is never the published reply. The public text
    // and the citation set follow the BUSINESS terminal, so a rejected draft
    // cannot reappear through done.reply, JSON reply or references.
    const setTerminal = (status: AnswerRunResult["status"]): void => {
      terminalStatus = status
      terminalReply = publicTerminalCopy(status)
      terminalReferences = []
    }
    let terminalDegradation: AnswerDegradation = {
      status: unavailableChannels.size > 0 ? "partial" : "none",
      unavailableChannels: [...unavailableChannels],
    }

    for (let round = 0; round < 3; round += 1) {
      input.onStageProgress?.("validation", { round: round + 1, data: { round: round + 1 } })
      const verdict = await abortable(
        validator.validate(
          fullAnswer,
          [
            { role: "user", content: effectiveMessage },
            { role: "system", content: context },
          ],
          undefined,
          signal
        ),
        signal
      )
      validationTrace = { round: round + 1, passed: verdict.passed }
      input.onStageProgress?.("validation", { status: "completed", round: round + 1, data: validationTrace })

      if (verdict.passed) {
        approved = true
        approvedBasis = verdict.answerBasis
        break
      }

      // Replan: produce gap queries for correction retrieval.
      const rawGapQueries = await abortable(replanner.replan(verdict), signal)
      const gapQueries = rawGapQueries.filter((q) => {
        const normalized = normalizeGapQuery(q.text)
        if (seenGapQueries.has(normalized)) return false
        seenGapQueries.add(normalized)
        return true
      })

      if (gapQueries.length === 0) {
        // Gap queries exhausted → handoff_required (if enabled) or insufficient_evidence.
        if (handoffStore && resolveTenantId) {
          checkAbort(signal, "GATE 6 (before handoff persistence)")
          const handoffCase = handoffStore.create({
            runId,
            tenantId,
            subjectId: accessContext.subjectId,
            sessionId,
            reasonCode: "insufficient_evidence",
            userRequest: effectiveMessage,
            conversationSummary: summarizeConversationForHandoff(
              recentTurns,
              conversationSummary
            ),
            evidenceIds: evidence.map(({ id }) => id),
            traceReference: runId,
          })
          // PL-01 AC04: "已转交人工" is only publishable when the case exists;
          // a refused persistence stays honest as 证据不足.
          setTerminal(handoffCase ? "handoff_required" : "insufficient_evidence")
          terminalDegradation = {
            status: unavailableChannels.size > 0 ? "partial" : "none",
            unavailableChannels: [...unavailableChannels],
            reason: "coverage_not_met",
          }
        } else {
          setTerminal("insufficient_evidence")
          terminalDegradation = {
            status: unavailableChannels.size > 0 ? "partial" : "none",
            unavailableChannels: [...unavailableChannels],
            reason: "coverage_not_met",
          }
        }
        break
      }

      // Correction retrieval: run searcher.search for each gap query.
      let anyNewResults = false
      let correctionInsufficient = false
      // Ticket 06: orderings of the searches whose results were kept.
      const correctionOrderings: RetrievalOrdering[] = []
      // PT-04: this round's 补检 hits, kept SEPARATE from the older material
      // until the gap-first selection below. They used to be appended to the
      // tail of `accumulatedResults`, where the assembler's insertion-order
      // budget walk left them no tokens at all.
      const gapResultsForRound: RetrievalResult[] = []
      input.onStageProgress?.("retrieval", { round: round + 2, data: { correction: true } })
      for (const gapQuery of gapQueries) {
        const correctionOutcome = await abortable(
          searcher.search(gapQuery, {
            accessContext,
            // Ticket 05 (KB-03A): a correction gap query stays inside the run's
            // server-computed knowledge scope — a retry never widens the read.
            ...(retrievalScope ? { retrievalScope } : {}),
            // Ticket 22 (ATT-01): a retry reads the same session's attachments.
            ...(sessionId ? { attachments: { sessionId } } : {}),
            // PL-02 / PT-03 AC06: the gap re-check carries the SAME web intent
            // as the first retrieval — an opt-in must not lapse mid-correction.
            ...(input.useWeb === true ? { webRequested: true } : {}),
            signal,
          }),
          signal
        )
        correctionOutcome.unavailableChannels.forEach((channel) =>
          unavailableChannels.add(channel)
        )
        if (correctionOutcome.status === "insufficient") {
          correctionInsufficient = true
          break
        }
        if (correctionOutcome.results.length === 0) continue
        if (correctionOutcome.ordering) correctionOrderings.push(correctionOutcome.ordering)
        gapResultsForRound.push(...correctionOutcome.results)
        anyNewResults = true
      }
      input.onStageProgress?.("retrieval", { status: "completed", round: round + 2, data: { correction: true, resultCount: gapResultsForRound.length } })

      if (correctionInsufficient) {
        setTerminal("insufficient_retrieval")
        terminalDegradation = {
          status: "insufficient",
          unavailableChannels: [...unavailableChannels],
        }
        break
      }

      if (!anyNewResults) {
        // No new evidence from any gap query → exhausted.
        if (handoffStore && resolveTenantId) {
          checkAbort(signal, "GATE 6 (before handoff persistence)")
          const handoffCase = handoffStore.create({
            runId,
            tenantId,
            subjectId: accessContext.subjectId,
            sessionId,
            reasonCode: "insufficient_evidence",
            userRequest: effectiveMessage,
            conversationSummary: summarizeConversationForHandoff(
              recentTurns,
              conversationSummary
            ),
            evidenceIds: evidence.map(({ id }) => id),
            traceReference: runId,
          })
          // PL-01 AC04: "已转交人工" is only publishable when the case exists;
          // a refused persistence stays honest as 证据不足.
          setTerminal(handoffCase ? "handoff_required" : "insufficient_evidence")
          terminalDegradation = {
            status: unavailableChannels.size > 0 ? "partial" : "none",
            unavailableChannels: [...unavailableChannels],
            reason: "coverage_not_met",
          }
        } else {
          setTerminal("insufficient_evidence")
          terminalDegradation = {
            status: unavailableChannels.size > 0 ? "partial" : "none",
            unavailableChannels: [...unavailableChannels],
            reason: "coverage_not_met",
          }
        }
        break
      }

      // Rebuild Evidence + Context from the accumulated results, then
      // regenerate the draft.
      // PT-04: this round's 补检 hits are selected BEFORE the older material
      // (the shared gap-first rule in retrieval/context/correction_selection),
      // so the new facts take first claim on the unchanged 6,000-token budget
      // instead of queueing behind the old top-10 parent chunks that used to
      // consume it all. No rerank step, no larger budget, no extra round.
      const selection = selectCorrectionCandidates({
        gapResults: gapResultsForRound,
        olderResults: accumulatedResults,
      })
      accumulatedResults = selection.orderedResults
      evidence = buildEvidence(accumulatedResults)
      const correctionCandidates = selection.candidates
      const correctionCitationIds = citationIdsByChunk(evidence)
      input.onStageProgress?.("context", { round: round + 2, data: { phase: "assembly", evidenceCount: evidence.length } })
      // PT-04 AC06: even selected-first, a gap item longer than the whole
      // budget cannot be admitted. Record it as an explicit omission so no
      // layer can present the correction as covered — the existing validation
      // rules still decide whether the run degrades.
      //
      // PT-06:AC07 — one material-backed preparation for the round: the
      // deterministic context, the budget decision on the REAL candidate
      // counts, and the compression attempt are all described by the same
      // shared pipeline, so the fallback and the source records can never
      // disagree about which context is going to generate.
      const prepared = await abortable(
        prepareGenerationContext({
          assembler,
          results: correctionCandidates,
          citationIds: correctionCitationIds,
          evidence,
          query: effectiveMessage,
          ...(compressor ? { compressor } : {}),
          ...(signal ? { signal } : {}),
          // PT-04 AC07: compression only closes the correction round when its
          // output still carries every selected new fact. A compressed context
          // that dropped one is not adopted — the round generates from the
          // deterministic context instead, and the loss stays visible on the
          // trace rather than becoming a fake "covered".
          ...(compressor
            ? {
                shouldAdoptCompression: (
                  compressionResult: ContextCompressionResult
                ): boolean =>
                  findUncoveredGapFacts({
                    gapCandidates: selection.gapCandidates,
                    citationIds: correctionCitationIds,
                    context: compressionResult.context,
                    mode: "citation",
                    reason: "compression",
                  }).length === 0,
              }
            : {}),
        }),
        signal
      )
      context = prepared.context
      material = prepared.material
      compression = prepared.compression
      const budgetOmissions = findUncoveredGapFacts({
        gapCandidates: selection.gapCandidates,
        citationIds: correctionCitationIds,
        // PT-06:AC07 — the coverage question is asked against the context that
        // really generates: the deterministic one, never a rejected compressed
        // output. `deterministicContext` is that text either way.
        context: prepared.deterministicContext,
        mode: "verbatim",
        reason: "context_budget",
      })
      // PT-04 AC06 + PT-06 AC07: the 补检 lands only when the adopted context
      // carries it. A compression that was adopted kept every selected fact (the
      // adoption rule above proved it), so the round has nothing to report;
      // every other outcome generates from the deterministic context and the
      // facts that did not fit stay recorded as omissions.
      // PT-04 AC07 / PT-06 AC07: an adopted compression proved its citation
      // lineage, not that a reworded fact survived. Ask the verbatim question
      // against the text that really generates too, so the trajectory can never
      // be read as "the correction is covered" when the summarizer reworded a
      // selected fact away.
      const gapFactOmissions = prepared.compression
        ? findUncoveredGapFacts({
            gapCandidates: selection.gapCandidates,
            citationIds: correctionCitationIds,
            context: prepared.context,
            mode: "verbatim",
            reason: "compression",
          })
        : budgetOmissions
      contextTrace = {
        evidenceCount: evidence.length,
        contextLength: context.length,
        ...compressionTraceFields(prepared),
        ...(gapFactOmissions.length > 0 ? { gapFactOmissions } : {}),
      }
      input.onStageProgress?.("context", { status: "completed", round: round + 2, data: { phase: "assembly", evidenceCount: evidence.length, contextLength: context.length } })
      input.onStageProgress?.("context", { round: round + 2, data: { phase: "draft", evidenceCount: evidence.length } })

      // Regenerate draft from the rebuilt context.
      const regenMessages: AgentMessage[] = [
        ...(assistant?.systemPrompt
          ? [{ role: "system" as const, content: assistant.systemPrompt }]
          : []),
        { role: "system", content: SYSTEM_PROMPT + memorySuffix },
        { role: "user", content: `${context}\n\n用户问题：${effectiveMessage}` },
      ]
      const regenTokens: string[] = []
      for await (const token of abortableStream(
        streamAnswerDraft(
        regenMessages,
        signal,
        input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : undefined
      ),
        signal
      )) {
        regenTokens.push(token)
      }
      const regenAnswer = regenTokens.join("")
      // PT-08:AC04 — a second (or third) REAL generation call gets its own
      // snapshot and overwrites the previous one: the last actual round is the
      // final snapshot, and earlier rounds' evidence is never merged into it.
      describeGenerationContext()
      contextTrace.phase = "draft"
      input.onStageProgress?.("context", { status: "completed", round: round + 2, data: { phase: "draft", evidenceCount: evidence.length } })
      // Citation check on regenerated draft (T11 #4).
      try {
        referencesForReply(regenAnswer, evidence)
      } catch {
        setTerminal("invalid_citation")
        terminalDegradation = {
          status: "insufficient",
          unavailableChannels: [...unavailableChannels],
          reason: "no_cited_claims",
        }
        break
      }
      fullAnswer = regenAnswer
      draftTokens = [...regenTokens]
      // Ticket 01: the regenerated draft was accepted — commit its context as
      // the final generation context (overwrites the previous round).
      // PT-04: this list is the gap-first merge of two retrievals, so its
      // ordering label is the honest aggregation, never a dedicated rerank.
      commitFinalContext(correctionCandidates, correctionCitationIds, correctionOrderings, true)
    }

    // -------------------------------------------------------------------------
    // GATE 5/6: publish or handoff.
    // -------------------------------------------------------------------------
    if (!approved && terminalStatus === null) {
      // 3 rounds expired without approval and without gap-query exhaustion.
      if (handoffStore && resolveTenantId) {
        checkAbort(signal, "GATE 6 (before handoff persistence)")
        const handoffCase = handoffStore.create({
          runId,
          tenantId,
          subjectId: accessContext.subjectId,
          sessionId,
          reasonCode: "insufficient_evidence",
          userRequest: effectiveMessage,
          conversationSummary: summarizeConversationForHandoff(
            recentTurns,
            conversationSummary
          ),
          evidenceIds: evidence.map(({ id }) => id),
          traceReference: runId,
        })
        setTerminal(handoffCase ? "handoff_required" : "insufficient_evidence")
        terminalDegradation = {
          status: unavailableChannels.size > 0 ? "partial" : "none",
          unavailableChannels: [...unavailableChannels],
          reason: "coverage_not_met",
        }
      } else {
        setTerminal("insufficient_evidence")
        terminalDegradation = {
          status: unavailableChannels.size > 0 ? "partial" : "none",
          unavailableChannels: [...unavailableChannels],
          reason: "coverage_not_met",
        }
      }
    }

    if (!approved) {
      // Terminal non-completed path: do NOT save validated turns (T10 #2 invariant).
      return {
        reply: terminalReply,
        status: terminalStatus!,
        references: terminalReferences,
        degradation: terminalDegradation,
        tokens: [],
        routeTrace: buildRouteTrace(),
        retrievalTrace,
        contextTrace,
        validationTrace,
      }
    }

    // Approved: final citation check (T11 #3: at least one valid Citation).
    const finalReferences = referencesForReply(fullAnswer, evidence)
    if (finalReferences.length === 0) {
      return {
        reply: publicTerminalCopy("insufficient_evidence"),
        status: "insufficient_evidence",
        references: finalReferences,
        degradation: {
          status: "insufficient",
          unavailableChannels: [...unavailableChannels],
          reason: "no_cited_claims",
        },
        tokens: [],
        routeTrace: buildRouteTrace(),
        retrievalTrace,
        contextTrace,
        validationTrace,
      }
    }

    // Save validated turns + trigger summarization (T10 #2: only completed turns).
    let summarization: SummarizationOutcome = { outcome: "skipped" }
    if (conversationStore) {
      checkAbort(signal, "GATE 5 (before validated turn persistence)")
      saveValidatedTurnPair(
        conversationStore,
        sessionId,
        tenantId,
        runId,
        effectiveMessage,
        fullAnswer,
        clock
      )
      summarization = await triggerSummarization(
        conversationStore,
        summarizer,
        sessionId,
        tenantId,
        signal
      )
    }

    const answerBasis = bindAnswerBasis(approvedBasis, finalReferences)
    if (answerBasis) validationTrace = { ...validationTrace, answerBasis }

    return {
      reply: fullAnswer,
      status: "completed",
      references: finalReferences,
      degradation: {
        status: unavailableChannels.size > 0 ? "partial" : "none",
        unavailableChannels: [...unavailableChannels],
      },
      tokens: draftTokens,
      routeTrace: buildRouteTrace(),
      retrievalTrace,
      contextTrace,
      validationTrace,
      summarizationOutcome: summarization.outcome,
      summarizationUsage: summarization.usage,
      summarizationDurationMs: summarization.durationMs,
      summarizationCheckpoint: summarization.checkpoint,
    }
  }
}
