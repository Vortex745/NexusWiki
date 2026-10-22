/**
 * Ticket 12 — Complex knowledge route Mastra runner.
 *
 * Implements the `MastraRunner` seam (defined in Ticket 05) for the complex
 * knowledge route. Mirrors the T11 simple knowledge runner structure but
 * swaps GATE 1 (retrieval) for a dual-path flow and the correction round
 * for a budget-reuse flow:
 *
 *   GATE 0 route (must be "complex") →
 *   GATE 1 retrieval (dual-path):
 *     - ComplexLoopController wired → `runComplexLoop` (bounded LLM-driven
 *       retrieval-tool loop, ≤3 iterations / ≤4 tool calls, dedup, fallback)
 *     - else Planner wired → `planner.decompose` multi-query flow
 *       (decompose → rewrite → navigate → generateHypothesis per sub-query,
 *        then `searcher.search` per rewritten sub-query)
 *     - else → terminal `provider_error` (cannot run complex route)
 *   → Evidence → Context (+compression) →
 *   GATE 3 answer Draft (LLM stream) → Citation check →
 *   GATE 4 validation loop (≤3 rounds with correction retrieval). Correction
 *     rounds reuse the SAME bounded tool-selection mechanism with budgets
 *     SHARED across the initial run + all correction rounds (T09 §13
 *     correction-round reuse pattern). `priorToolCalls` carries dedup state
 *     so a tool call made in the initial run is not repeated in correction.
 *     Provider failure or budget exhaustion with 0 new results falls back to
 *     deterministic `searcher.search` (criterion #5).
 *   GATE 5/6 publish / handoff.
 *
 * This runner reuses the existing authorized retrieval stack (Searcher with
 * AccessContext), Evidence builder, ContextAssembler, ContextCompressor,
 * Validator, RePlanner, Planner, ComplexLoopController, ConversationStore,
 * Contextualizer, Summarizer, and HandoffStore — it does NOT re-implement
 * their behavior. The only abstraction is `streamAnswerDraft` (the LLM call
 * seam), mirroring the T09/T11 pattern so the runner can be tested without
 * the real @mastra/core Agent.
 *
 * Boundary (T02 #5): this module MUST NOT import `src/api/*` or `src/index`.
 * It depends only on:
 *   - `src/mastra/chat_event_adapter.ts` (MastraRunner seam + types)
 *   - `src/retrieval/router/interface.ts` (Router interface)
 *   - `src/retrieval/search/interface.ts` (Searcher, SearchOptions)
 *   - `src/retrieval/context/interface.ts` (ContextAssembler)
 *   - `src/retrieval/tool_selector.ts` (formatToolInputSummary — for trace)
 *   - `src/retrieval/planner/interface.ts` (Planner interface)
 *   - `src/retrieval/planner/planner.ts` (PlannerError)
 *   - `src/retrieval/complex_loop.ts` (runComplexLoop, ComplexLoopController,
 *     ComplexLoopResult, COMPLEX_LOOP_MAX_ITERATIONS, COMPLEX_LOOP_MAX_TOOL_CALLS,
 *     NormalizedToolCall)
 *   - `src/critic/validator/interface.ts` (Validator)
 *   - `src/critic/replanner/interface.ts` (RePlanner)
 *   - `src/answer/conversation_store.ts` (ConversationStore)
 *   - `src/answer/contextualizer.ts` (Contextualizer)
 *   - `src/answer/context_compressor.ts` (ContextCompressor)
 *   - `src/answer/context_pipeline.ts` (prepareGenerationContext,
 *     compressionTraceFields — PT-06/PT-07's ONE material-backed context
 *     decision, shared with the simple route)
 *   - `src/answer/generation_snapshot.ts` (describeActualGenerationContext —
 *     the one description of the context a generation call actually received)
 *   - `src/retrieval/complex_loop.ts` (runComplexLoop, ComplexLoopController,
 *     ComplexLoopResult, COMPLEX_LOOP_MAX_ITERATIONS, COMPLEX_LOOP_MAX_TOOL_CALLS,
 *     NormalizedToolCall, createComplexLoopObservationCompressor)
 *   - `src/answer/summarizer.ts` (Summarizer)
 *   - `src/answer/handoff_store.ts` (HandoffStore)
 *   - `src/answer/evidence.ts` (buildEvidence, citationIdsByChunk, referencesForReply)
 *   - `src/access/context.ts` (AccessContext)
 *   - `src/types` (AgentMessage, AnswerRunResult, Evidence, Query, RetrievalResult, ...)
 *
 * @mastra/core decoupling: the LLM stream is injected via `streamAnswerDraft`
 * so the runner can be tested in isolation. T12's production wiring (in
 * `src/index.ts`) constructs a real @mastra/core Agent and adapts its
 * `stream()` output to the `AsyncIterable<string>` signature.
 *
 * Cancellation contract (T12 #6): the runner respects `input.signal.aborted`
 * at every await point via the `abortable()` helper. Mid-stream abort surfaces
 * as AbortError from `streamAnswerDraft` and propagates out of the runner.
 *
 * Trace data aggregation: the runner returns a single MastraRunnerOutput with
 * aggregated trace data for the 4 progress stages (route/retrieval/context/
 * validation). Per-tool-call retrieval events from the complex loop are
 * folded into the final retrievalTrace (complexLoop summary + channel
 * statuses + aggregated result count). T14 owns the shadow-parity audit
 * that compares Mastra vs legacy event streams including per-tool-call
 * retrieval events.
 *
 * Helper duplication note: the helpers below (abortError, abortable,
 * abortableStream, diversifySelect, normalizeGapQuery,
 * summarizeConversationForHandoff, saveValidatedTurnPair, triggerSummarization)
 * are duplicated from `src/mastra/simple_knowledge_runner.ts`. This is
 * intentional: T11 and T12 are sibling runners, and keeping them
 * self-contained avoids coupling between sibling modules. The helpers are
 * stable utility code (no expected changes); if duplication becomes a
 * maintenance burden, T13+ may extract them to a shared `_runner_helpers.ts`
 * module. See Karpathy guideline #3 (Surgical Changes).
 *
 * PT-05 exception: the correction-round selection is NOT duplicated. The
 * gap-first (补检优先) rule lives once in
 * `src/retrieval/context/correction_selection.ts` and both runners call it —
 * two divergent copies is exactly how the simple and complex routes each
 * starved the new facts.
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
import { formatToolInputSummary } from "../retrieval/tool_selector"
import type { Planner, DecomposeResult } from "../retrieval/planner/interface"
import { PlannerError } from "../retrieval/planner/planner"
import {
  runComplexLoop,
  createComplexLoopObservationCompressor,
  COMPLEX_LOOP_MAX_ITERATIONS,
  COMPLEX_LOOP_MAX_TOOL_CALLS,
  type ComplexLoopController,
  type ComplexLoopResult,
  type NormalizedToolCall,
} from "../retrieval/complex_loop"
import { createComplexLoopToolInvoker, READ_ONLY_TOOL_ALLOWLIST } from "../tools/complex_loop_adapter"
import { degradationWasObserved } from "./answer_degradation"
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
// routes run, and PT-08 — the ONE description of what the generator actually
// received. The complex route importing them IS this ticket: AC09 forbids a
// second material-selection or body-selection implementation, so the initial
// assembly, the correction rebuild and the loop's observation compression all
// go through these two entry points and nothing else.
import {
  DEFAULT_MAX_CONTEXT_TOKENS,
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
  RouteSubQuery,
  ContextTraceData,
  ValidationTraceData,
  TokenUsage,
} from "../types"
import type { AnswerModelStreamOptions } from "../answer/generation"

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * Streamed LLM answer draft for the complex knowledge route. Receives the
 * full AgentMessage[] (system prompt + user-with-context) and returns an
 * async iterable of token strings, mirroring `model.stream()` in legacy
 * `src/answer/generation.ts`. Same signature as T11's seam.
 */
export type KnowledgeAnswerDraftStream = (
  messages: AgentMessage[],
  signal: AbortSignal,
  /** Generation parameters for THIS draft (the run's frozen reasoning
   * effort). Omitted for runs that never asked — the call stays unchanged. */
  options?: AnswerModelStreamOptions
) => AsyncIterable<string>

/**
 * Resolve tenantId from AccessContext. Same semantics as T11's resolver.
 */
export type TenantIdResolver = (accessContext: AccessContext) => string

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Error thrown when the route decision is not "complex". T12 owns only the
 * complex knowledge route; direct/ambiguous routes are owned by T09 and
 * simple route is owned by T11. The route-dispatch layer (T11 Step 3,
 * extended by T12 Step 3) catches this error and routes direct/ambiguous/
 * simple to their respective runners.
 *
 * Note: T09's `RouteNotSupportedError` throws for "complex". T11's
 * `RouteNotSimpleError` throws for "direct"/"ambiguous"/"complex". T12's
 * `RouteNotComplexError` throws for "direct"/"ambiguous"/"simple". The
 * three errors are distinct so the dispatch layer can compose all three
 * runners without ambiguity.
 */
export class RouteNotComplexError extends Error {
  constructor(public readonly decision: "direct" | "ambiguous" | "simple") {
    super(
      `Route "${decision}" is not supported by ComplexKnowledgeMastraRunner (T12). ` +
      `Supported route: complex. The route-dispatch layer should have routed this ` +
      `decision to the T09 DirectAmbiguousMastraRunner (direct/ambiguous) or the ` +
      `T11 SimpleKnowledgeMastraRunner (simple).`
    )
    this.name = "RouteNotComplexError"
  }
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ComplexKnowledgeMastraRunnerDeps {
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
   * Legacy Planner — used for the multi-query fallback path when
   * `complexLoopController` is absent. When both are absent, the runner
   * cannot run the complex route and terminates with `provider_error`.
   * Optional for backward compat with callers that only wire the loop.
   */
  planner?: Planner
  /**
   * Ticket 08 — LLM-backed bounded retrieval loop controller. When present,
   * `runComplexLoop` runs instead of `planner.decompose`. When absent, the
   * runner falls back to the legacy multi-query planner flow.
   */
  complexLoopController?: ComplexLoopController
  /**
   * Ticket 34 (TOOL-01A): the tool registry. When present, the complex
   * loop's tool calls execute through the schema-validated invocation
   * boundary, allowlisted by the run's assistant tool policy (the legacy /
   * default assistant keeps the read-only allowlist). Absent → the loop's
   * legacy direct search path.
   */
  toolRegistry?: import("../tools/invocation").ToolRegistry
  /** Ticket 34: per-tool-call deadline. Default 30s. */
  toolTimeoutMs?: number
  /**
   * Ticket 35 (TOOL-01B): names of discovered MCP tools. They join the
   * read-only allowlist — an assistant with "read_only_retrieval" may call
   * them; toolPolicy "none" still means no tools at all.
   */
  mcpToolNames?: readonly string[]
  /**
   * Ticket 61/04: LLM-backed Evidence-Context compressor. Optional — when
   * absent, the deterministic assembler output is used as-is. Also used as
   * the loop's observation compressor (when complexLoopController is wired).
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
   * recentTurns before Router classification. Optional.
   */
  contextualizer?: Contextualizer
  /**
   * Ticket 61/02: LLM-backed rolling-summary provider. Optional.
   */
  summarizer?: Summarizer
  /**
   * Ticket 09 P4: HandoffStore persistence. When present AND accessContext
   * is available, correction exhaustion terminates with `handoff_required`
   * instead of `insufficient_evidence`.
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
// Helpers (mirrors of T11 + legacy generation.ts internals)
// ---------------------------------------------------------------------------

import {
  INSUFFICIENT_EVIDENCE_MESSAGE,
  INSUFFICIENT_RETRIEVAL_MESSAGE,
  PROVIDER_ERROR_MESSAGE,
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

// PT-05: the correction-round identity dedup + gap-first ordering used to live
// here as a local `uniqueResults(accumulatedResults)` call, which kept the
// OLDEST hit of a repeated identity and left the fresh 补检 material at the
// tail of the assembler's queue. The rule now has one owner shared with the
// simple route — `selectCorrectionCandidates` in
// `../retrieval/context/correction_selection` — so the two runners cannot
// drift apart.

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

function saveValidatedTurnPair(
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
 * Create a MastraRunner that handles the complex knowledge route.
 *
 * Throws `RouteNotComplexError` for direct/ambiguous/simple routes so the
 * route-dispatch layer (T11 Step 3, extended by T12 Step 3) can route them
 * to their respective runners. T12 owns only the complex route.
 *
 * Dual-path retrieval (GATE 1):
 *   - `complexLoopController` wired → `runComplexLoop` (bounded LLM loop)
 *   - else `planner` wired → `planner.decompose` multi-query flow
 *   - else → terminal `provider_error` (cannot run complex route)
 *
 * Correction round (T09 §13 reuse):
 *   - Initial run used complex loop AND controller still wired →
 *     `runComplexLoop` with reduced budgets + prior tool calls
 *   - Else → legacy single `searcher.search(gapQuery)` per gap query
 */
export function createComplexKnowledgeMastraRunner(
  deps: ComplexKnowledgeMastraRunnerDeps
): MastraRunner {
  const {
    router,
    createSearcher,
    assembler,
    validator,
    replanner,
    streamAnswerDraft,
    planner,
    complexLoopController,
    compressor,
    conversationStore,
    contextualizer,
    summarizer,
    handoffStore,
    resolveTenantId,
  } = deps
  const clock = deps.now ?? (() => new Date())

  return async function complexKnowledgeMastraRunner(
    input: MastraRunnerInput
  ): Promise<MastraRunnerOutput> {
    // T12 #6 cancellation checkpoint 1: before Router call (pre-route abort).
    if (input.signal.aborted) {
      throw abortError("GATE 0 (before route)")
    }

    const { signal, accessContext, sessionId, runId, retrievalScope, assistant } = input
    const tenantId = resolveTenantId ? resolveTenantId(accessContext) : "default"
    const preparedRoute = input.preparedRoute

    // -------------------------------------------------------------------------
    // Memory loading + pending clarification consumption (mirrors T11 +
    // legacy generation.ts L437-L458).
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
    // Contextualization (mirrors T11 + legacy generation.ts L472-L502).
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

    if (decision !== "complex") {
      // T12 owns only the complex route. Throw RouteNotComplexError so the
      // route-dispatch layer can route direct/ambiguous to the T09 runner
      // and simple to the T11 runner.
      throw new RouteNotComplexError(decision)
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
    // GATE 1: retrieval (dual-path — complex loop OR planner.decompose).
    // -------------------------------------------------------------------------
    const searcher = createSearcher(assistant)
    // Ticket 34 (TOOL-01A): tool calls run through the invocation boundary,
    // allowlisted by the run's own policy snapshot (legacy/default assistant
    // = read-only allowlist; "none" = no tools at all).
    const allowedTools =
      assistant?.toolPolicy === "none"
        ? []
        : [...READ_ONLY_TOOL_ALLOWLIST, ...(deps.mcpToolNames ?? [])]
    const toolInvoker =
      deps.toolRegistry && allowedTools.length > 0
        ? createComplexLoopToolInvoker({
            registry: deps.toolRegistry,
            allowedTools,
            ...(deps.toolTimeoutMs !== undefined ? { timeoutMs: deps.toolTimeoutMs } : {}),
            ...(accessContext ? { accessContext } : {}),
            ...(retrievalScope ? { retrievalScope } : {}),
            signal,
            // Ticket 22 (ATT-01) / PT-02: the tool environment binds the
            // run's OWN session, so a loop tool call reads this session's
            // temporary attachments — and never another session's. The
            // server-bound id is the only carrier; tool args cannot set one.
            ...(sessionId ? { sessionId } : {}),
            // Ticket 36 (WEB-01) / PT-03: the run's explicit web opt-in
            // travels the same way. A URL in a query still follows the
            // existing read/reject policy with or without this flag.
            ...(input.useWeb === true ? { webRequested: true } : {}),
            searcher,
          })
        : undefined
    const unavailableChannels = new Set<RetrievalResult["source"]>()
    // DR-22: reasons reported by a real search that are not channel failures
    // (e.g. `reranker_unavailable`). The simple route already keeps these on
    // the trace; the complex route must classify them the same way.
    const retrievalDegradedReasons = new Set<string>()
    let retrievalAttempted = false
    let retrievalAvailable = false
    const resultGroups: RetrievalResult[][] = []
    /**
     * Ticket 06: ordering labels of the searches whose results were kept. The
     * complex loop's own merged results contribute no label (no single rerank
     * produced them), which is exactly why the merge is reported as an
     * aggregation rather than a dedicated rerank.
     */
    const orderings: RetrievalOrdering[] = []
    let coverageCriteria: string[] | undefined
    let complexLoopResult: ComplexLoopResult | undefined
    let complexLoopDurationMs: number | undefined
    let plannerModelCalls: number | undefined
    let plannerTokens: number | undefined
    let subQueryTrace: RouteSubQuery[] | undefined
    let plannerQueryCount: number | undefined
    const buildRouteTrace = (): RouteTraceData => ({
      ...(preparedRoute?.routeTrace ?? {}),
      decision: "complex",
      ...(complexLoopResult
        ? {
            complexLoopStopReason: complexLoopResult.stopReason,
            complexLoopIterations: complexLoopResult.iterationsExecuted,
            complexLoopToolCalls: complexLoopResult.toolCallsExecuted,
          }
        : {}),
      ...(plannerQueryCount !== undefined ? { queryCount: plannerQueryCount } : {}),
      ...(subQueryTrace ? { subQueries: subQueryTrace } : {}),
      ...(plannerModelCalls !== undefined ? { modelCalls: plannerModelCalls } : {}),
      ...(plannerTokens !== undefined ? { tokens: plannerTokens } : {}),
      ...(contextualizationOutcome ? { contextualizationOutcome } : {}),
      ...(contextualizationFailure ? { contextualizationFailure } : {}),
      ...(contextualizationUsage ? { contextualizationUsage } : {}),
      ...(contextualizationDurationMs != null ? { contextualizationDurationMs } : {}),
    })

    retrievalAttempted = true

    if (complexLoopController) {
      // ---------------------------------------------------------------------
      // Path A: bounded LLM-driven complex retrieval loop (T08 spec §13).
      // ---------------------------------------------------------------------
      const loopStartedAt = Date.now()
      // PT-07 AC09 — the loop's observation compressor is the shared
      // material-backed adapter (see `createComplexLoopObservationCompressor`):
      // the same assembler material, the same budget, the same refusals. It
      // replaces the old inline bridge that forwarded to
      // `compressor.compress(evidence, …)`, which decided on the 600-character
      // preview sum (finding F4) and therefore never compressed an oversized
      // parent whose preview looked cheap.
      const loopCompressor = compressor
        ? createComplexLoopObservationCompressor({ assembler, compressor })
        : undefined
      try {
        complexLoopResult = await abortable(
          runComplexLoop(
            {
              controller: complexLoopController,
              searcher,
              assembler,
              ...(loopCompressor ? { compressor: loopCompressor } : {}),
              ...(toolInvoker ? { toolInvoker } : {}),
            },
            {
              query: contextualizedQuery,
              ...(accessContext ? { accessContext } : {}),
              // Ticket 05 (KB-03A): the initial complex retrieval stays inside
              // the run's server-computed knowledge scope.
              ...(retrievalScope ? { retrievalScope } : {}),
              // Ticket 22 (ATT-01) / PT-02: the loop's first retrieval and
              // every tool iteration read the run's OWN session attachments.
              ...(sessionId ? { attachments: { sessionId } } : {}),
              // Ticket 36 (WEB-01) / PT-03: and carry the run's web intent.
              ...(input.useWeb === true ? { webRequested: true } : {}),
              signal,
            }
          ),
          signal
        )
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err
        // Non-Abort loop error → terminal provider_error (mirrors legacy L773-780).
        input.onStageProgress?.("retrieval", { status: "failed", round: 1 })
        // PL-04 review fix: the exception TEXT is never a public field. It can
        // carry a backend URL, an index name or a document id, and until now
        // only the event adapter's guard stopped it from being published — the
        // runner itself returned it as `reply`, which every non-SSE consumer
        // (JSON callers, replayed traces) read directly. The terminal copy is
        // the shared, route-independent text; the failure stays fully reported
        // through `status`, `degradation` and the unavailable-channel list.
        return {
          reply: PROVIDER_ERROR_MESSAGE,
          status: "provider_error",
          references: [],
          degradation: {
            status: "insufficient",
            unavailableChannels: [...unavailableChannels],
          },
          tokens: [],
          routeTrace: buildRouteTrace(),
          retrievalTrace: {
            complexLoop: true,
            resultCount: 0,
            selectedEvidenceIds: [],
            degradedReasons: ["complex loop unavailable"],
          },
          contextTrace: {},
          validationTrace: {},
        }
      }
      complexLoopDurationMs = Date.now() - loopStartedAt

      // Populate retrieval tracking from loop result. The loop already
      // deduplicated results by chunk ID (criterion #4), so this is a
      // single group.
      retrievalAvailable = complexLoopResult.results.length > 0
      resultGroups.push(complexLoopResult.results)
      complexLoopResult.toolCalls.forEach((call) => {
        call.unavailableChannels.forEach((ch) => unavailableChannels.add(ch))
      })

      // T08: provider-failure means the searcher backend threw a non-Abort
      // error mid-loop. Terminate with provider_error (mirrors legacy L865).
      if (complexLoopResult.stopReason === "provider-failure") {
        input.onStageProgress?.("retrieval", { status: "failed", round: 1 })
        return {
          reply: PROVIDER_ERROR_MESSAGE,
          status: "provider_error",
          references: [],
          degradation: {
            status: "insufficient",
            unavailableChannels: [...unavailableChannels],
          },
          tokens: [],
          routeTrace: buildRouteTrace(),
          retrievalTrace: {
            complexLoop: true,
            resultCount: complexLoopResult.results.length,
            selectedEvidenceIds: [],
            ...(unavailableChannels.size > 0
              ? { degradedReasons: [...unavailableChannels].map((ch) => `${ch} unavailable`) }
              : {}),
          },
          contextTrace: {},
          validationTrace: {},
        }
      }
    } else if (planner) {
      // ---------------------------------------------------------------------
      // Path B: legacy planner.decompose multi-query flow (backward compat
      // when complexLoopController is absent). Mirrors legacy L870-L953.
      // ---------------------------------------------------------------------
      let decomposeResult: DecomposeResult
      try {
        decomposeResult = await abortable(
          planner.decompose({ text: contextualizedQuery }),
          signal
        )
      } catch (err) {
        if (err instanceof PlannerError) {
          input.onStageProgress?.("retrieval", { status: "failed", round: 1 })
          // PL-04 review fix (same rule as the loop failure above): a
          // `provider_error` terminal publishes the shared terminal copy, never
          // the planner's exception text.
          return {
            reply: PROVIDER_ERROR_MESSAGE,
            status: "provider_error",
            references: [],
            degradation: {
              status: "insufficient",
              unavailableChannels: [...unavailableChannels],
            },
            tokens: [],
            routeTrace: buildRouteTrace(),
            retrievalTrace: {},
            contextTrace: {},
            validationTrace: {},
          }
        }
        throw err
      }

      subQueryTrace = []
      const rewrittenQueries: Query[] = []
      const complexOptions: SearchOptions[] = []
      plannerModelCalls = 1
      plannerTokens = decomposeResult.usage?.totalTokens ?? 0
      for (const subQuery of decomposeResult.queries) {
        const rewriteResult = await abortable(planner.rewrite(subQuery), signal)
        plannerModelCalls += 1
        plannerTokens += rewriteResult.usage?.totalTokens ?? 0
        const rewrittenQuery = rewriteResult.query
        let seeds: string[] = []
        try {
          seeds = await abortable(planner.navigate(rewrittenQuery), signal)
          plannerModelCalls += 1
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") throw err
        }
        let hypothesis: string | undefined
        try {
          const hypothesisResult = await abortable(
            planner.generateHypothesis(rewrittenQuery),
            signal
          )
          plannerModelCalls += 1
          plannerTokens += hypothesisResult.usage?.totalTokens ?? 0
          hypothesis = hypothesisResult.text
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") throw err
        }
        subQueryTrace.push({
          original: subQuery.text,
          rewritten: rewrittenQuery.text,
          ...(subQuery.coverageCriteria
            ? { coverageCriteria: subQuery.coverageCriteria }
            : {}),
        })
        rewrittenQueries.push(rewrittenQuery)
        const options: SearchOptions = {}
        if (hypothesis && hypothesis.trim() && hypothesis !== rewrittenQuery.text) {
          options.hypothesis = hypothesis
        }
        if (seeds.length > 0) {
          options.graphSeeds = seeds
        }
        complexOptions.push(options)
      }
      plannerQueryCount = rewrittenQueries.length
      input.onStageProgress?.("route", { status: "completed", data: { decision: "complex", queryCount: plannerQueryCount } })

      // Execute retrieval per rewritten sub-query.
      for (let i = 0; i < rewrittenQueries.length; i += 1) {
        const outcome = await abortable(
          searcher.search(rewrittenQueries[i], {
            ...complexOptions[i],
            accessContext,
            // Ticket 05 (KB-03A): every decomposed sub-query shares the run's
            // server-computed knowledge scope.
            ...(retrievalScope ? { retrievalScope } : {}),
            // Ticket 22 (ATT-01): sub-queries share the run's session, so the
            // temporary attachments stay available to all of them.
            ...(sessionId ? { attachments: { sessionId } } : {}),
            // Ticket 36 (WEB-01): the run's explicit web-search opt-in; a URL
            // pasted into the message is fetched regardless of the flag.
            ...(input.useWeb === true ? { webRequested: true } : {}),
            signal,
          }),
          signal
        )
        outcome.unavailableChannels.forEach((ch) => unavailableChannels.add(ch))
        for (const reason of outcome.degradationReasons ?? []) {
          retrievalDegradedReasons.add(reason)
        }
        if (outcome.status !== "insufficient") retrievalAvailable = true
        resultGroups.push(outcome.results)
        if (outcome.ordering) orderings.push(outcome.ordering)
      }

      // Collect coverage criteria from all sub-queries.
      const collectedCriteria = decomposeResult.queries
        .flatMap((q) => q.coverageCriteria ?? [])
      if (collectedCriteria.length > 0) {
        coverageCriteria = collectedCriteria
      }
    } else {
      // ---------------------------------------------------------------------
      // No planner AND no complexLoopController — cannot run complex route.
      // Terminal provider_error (mirrors the "missing dependency" case).
      // ---------------------------------------------------------------------
      return {
        reply: "复杂问答组件配置缺失（需要 planner 或 complexLoopController），无法完成该请求。",
        status: "provider_error",
        references: [],
        degradation: {
          status: "insufficient",
          unavailableChannels: [...unavailableChannels],
        },
        tokens: [],
        routeTrace: buildRouteTrace(),
        retrievalTrace: {},
        contextTrace: {},
        validationTrace: {},
      }
    }

    // -------------------------------------------------------------------------
    // Build the initial retrieval trace data (aggregated; final state).
    // -------------------------------------------------------------------------
    const channelStatuses = Object.fromEntries(
      (["vector", "bm25", "graph"] as const).map((channel) => [
        channel,
        unavailableChannels.has(channel) ? "unavailable" : "completed",
      ])
    )
    let retrievalTrace: RetrievalTraceData = {
      channelStatuses,
      resultCount: resultGroups.flat().length,
      selectedEvidenceIds: [],
      ...(unavailableChannels.size > 0 || retrievalDegradedReasons.size > 0
        ? {
            degradedReasons: [
              ...new Set([
                ...[...unavailableChannels].map((ch) => `${ch} unavailable`),
                ...retrievalDegradedReasons,
              ]),
            ],
          }
        : {}),
      ...(complexLoopResult
        ? {
            complexLoop: true,
            ...(complexLoopResult.toolCalls[0]?.tool
              ? { selectedTool: complexLoopResult.toolCalls[0].tool }
              : {}),
            ...(complexLoopResult.toolCalls[0]?.args
              ? {
                  toolInputSummary: formatToolInputSummary({
                    tool: complexLoopResult.toolCalls[0].tool,
                    args: complexLoopResult.toolCalls[0].args,
                  }),
                }
              : {}),
            // DR-12: when the loop's first pick was replaced before execution
            // (inapplicable PageIndex), the route trace says so explicitly.
            ...(complexLoopResult.toolCalls[0]?.fallbackReason
              ? { toolFallbackReason: complexLoopResult.toolCalls[0].fallbackReason }
              : {}),
          }
        : {}),
    }
    input.onStageProgress?.("retrieval", { status: "completed", round: 1, data: { resultCount: retrievalTrace.resultCount } })

    // Insufficient retrieval check (T12 #7: terminal insufficient_retrieval).
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
    // Evidence building (T12 #4: rebuild from accumulated authorized Evidence).
    // -------------------------------------------------------------------------
    const allResults = resultGroups.flat()
    const selectedResults = diversifySelect(resultGroups, 10)
    const selectedKeys = new Set(selectedResults.map(({ chunk }) =>
      `${chunk.documentId}\0${chunk.id}`
    ))
    // PT-05: reassigned on every correction round to the gap-first ordered
    // list (newest 补检 material in front), never to a tail-append.
    let accumulatedResults = allResults.filter(({ chunk }) =>
      selectedKeys.has(`${chunk.documentId}\0${chunk.id}`)
    )
    let evidence: Evidence[] = buildEvidence(accumulatedResults)
    retrievalTrace = {
      ...retrievalTrace,
      selectedEvidenceIds: evidence.map(({ id }) => id),
    }

    // Empty Evidence check (T12 #7: cannot complete without usable Evidence).
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
    // GATE 2: context assembly (T12 #4: bounded Context representation).
    // -------------------------------------------------------------------------
    // Eval refactor Ticket 01: observation of the FINAL actual generation
    // context (mirrors T11). Committed only when the draft generated from
    // that context is accepted (citation check passed). For complex routes
    // the candidates are the runner's ordered aggregation across tool
    // retrievals (diversifySelect over result groups), not a single tool
    // call's output.
    let finalContextRound = 0
    /**
     * Ticket 06: the committed round also carries HOW its ranking was
     * produced. This route merges several retrievals (planner sub-queries,
     * loop tool calls, correction retrievals), so a single contributing search
     * keeps its own label and anything merged is reported as an aggregation —
     * never as a dedicated-rerank success.
     *
     * PT-05: `mergedAcrossRounds` is the correction case. That candidate list
     * is this round's gap hits (from the tool loop, the deterministic searcher
     * fallback or the legacy path) merged in front of the earlier retrievals,
     * so no single search ordering produced it — even when exactly one
     * contributing retrieval carried `dedicated_rerank`.
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
        ...(unavailableChannels.size > 0 || retrievalDegradedReasons.size > 0
          ? {
              degradedReasons: [
                ...new Set([
                  ...[...unavailableChannels].map((ch) => `${ch} unavailable`),
                  ...retrievalDegradedReasons,
                ]),
              ],
            }
          : {}),
        // PL-04 review fix — the ONE rule, byte-identical to the simple route:
        //   merged rounds report an aggregation;
        //   exactly one contributing search keeps its own label;
        //   several merged searches report an aggregation;
        //   NO recorded ordering makes NO ordering claim.
        // The old code fabricated `fused / multi_query_aggregation` whenever
        // there was no ordering, which labelled a single dedicated-rerank tool
        // call as an aggregation and — worse — asserted an aggregation the loop
        // never performed, because Path A collects no ordering at all.
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
                    : {
                        source: "fused" as const,
                        reason: "multi_query_aggregation" as const,
                      },
              }
            : {}),
      }
    }
    const initialCitationIds = citationIdsByChunk(evidence)
    // PT-07:AC01/AC02/AC07 — the state of the context that is currently going
    // to the generator: the COMPLETE authorized material behind it, the
    // compression actually adopted for it, and the trace describing both.
    // Reassigned every round, so a refused compression can never leave the
    // source records pointing at compressed ids that were not used.
    let context = ""
    let material: ContextMaterial | null = null
    let compression: ContextCompressionResult | null = null
    let contextTrace: ContextTraceData = {}
    // PT-08:AC01/AC04 — ONE `generation-context-v1` snapshot per ACTUAL
    // generation call, recorded through the same shared builder the simple
    // route uses. Attached only after a draft really completed.
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
    // Assembly and generation are separate real boundaries within context.
    input.onStageProgress?.("context", { round: 1, data: { phase: "assembly", evidenceCount: evidence.length } })
    // PT-07:AC01-AC04 — the same single shared entry point as the simple route
    // (PT-06): assemble the complete authorized material from this round's
    // ordered candidates, decide compression from its REAL counts against the
    // unchanged 6,000-token budget, and fall back to the in-budget
    // deterministic text on every refusal. This replaces the old inline pair
    // (`assembler.assemble` + an unconditional `compressor.compress`, which
    // bypassed on the 600-character preview sum — finding F4).
    const initial = await abortable(
      prepareGenerationContext({
        assembler,
        results: selectedResults,
        citationIds: initialCitationIds,
        evidence,
        query: effectiveMessage,
        ...(compressor ? { compressor } : {}),
        maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
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
    // GATE 3: answer draft (LLM stream). Mirrors T11.
    // -------------------------------------------------------------------------
    // Ticket 33 (MEM-01B): recalled long-term memories ride the system prompt
    // as clearly-labeled background — never evidence, never citations.
    // -------------------------------------------------------------------------
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
    // PT-08:AC01/AC05 (mirrors the simple route): this draft really was
    // generated, so the round is described from the context that was handed
    // over — deterministic full, deterministic partial, compressed, or the
    // compression-failure fallback.
    describeGenerationContext()
    contextTrace.phase = "draft"
    input.onStageProgress?.("context", { status: "completed", round: 1, data: { phase: "draft", evidenceCount: evidence.length } })

    // Citation check (T12 #5: unknown Citations rejected before publication).
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
    commitFinalContext(selectedResults, initialCitationIds, orderings)
    let fullAnswer = initialAnswer
    let draftTokens: string[] = [...initialTokens]
    let validationTrace: ValidationTraceData = {}

    // -------------------------------------------------------------------------
    // GATE 4: validation loop (≤3 rounds, with correction retrieval).
    //
    // Dual-path correction (T09 §13 correction-round reuse):
    //   - Initial run used complex loop AND controller still wired →
    //     `runComplexLoop` with reduced budgets + prior tool calls
    //   - Else → legacy single `searcher.search(gapQuery)` per gap query
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
      status: degradationWasObserved(unavailableChannels, [...retrievalDegradedReasons]) ? "partial" : "none",
      unavailableChannels: [...unavailableChannels],
    }

    // Shared budgets for correction-round reuse (T09 §13). Only populated
    // when the initial run used the complex loop AND the controller is
    // still available for correction. Mirrors legacy L1239-L1256.
    let sharedRemainingIterations: number | undefined
    let sharedRemainingToolCalls: number | undefined
    let sharedPriorToolCalls: NormalizedToolCall[] | undefined
    if (complexLoopResult && complexLoopController) {
      sharedRemainingIterations = Math.max(
        0,
        COMPLEX_LOOP_MAX_ITERATIONS - complexLoopResult.iterationsExecuted
      )
      sharedRemainingToolCalls = Math.max(
        0,
        COMPLEX_LOOP_MAX_TOOL_CALLS - complexLoopResult.toolCallsExecuted
      )
      sharedPriorToolCalls = complexLoopResult.toolCalls.map((c) => ({
        tool: c.tool,
        argsKey: c.argsKey,
      }))
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
          coverageCriteria,
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
        // Gap queries exhausted → handoff_required (if enabled) or
        // insufficient_evidence. Mirrors T11 + legacy L1313-L1346.
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
            status: degradationWasObserved(unavailableChannels, [...retrievalDegradedReasons]) ? "partial" : "none",
            unavailableChannels: [...unavailableChannels],
            reason: "coverage_not_met",
          }
        } else {
          setTerminal("insufficient_evidence")
          terminalDegradation = {
            status: degradationWasObserved(unavailableChannels, [...retrievalDegradedReasons]) ? "partial" : "none",
            unavailableChannels: [...unavailableChannels],
            reason: "coverage_not_met",
          }
        }
        break
      }

      // Correction retrieval: dual-path per gap query.
      let anyNewResults = false
      let correctionInsufficient = false
      // Ticket 06: ordering labels of the correction searches that were kept.
      const correctionOrderings: RetrievalOrdering[] = []
      // PT-05: this round's 补检 hits — from the loop, the deterministic
      // searcher fallback or the legacy path — kept SEPARATE from the older
      // material until the shared gap-first selection below. They used to be
      // appended to the tail of `accumulatedResults`, where the assembler's
      // insertion-order budget walk left them no tokens at all.
      const gapResultsForRound: RetrievalResult[] = []
      input.onStageProgress?.("retrieval", { round: round + 2, data: { correction: true } })
      for (const gapQuery of gapQueries) {
        if (
          complexLoopController &&
          sharedRemainingIterations !== undefined &&
          sharedRemainingToolCalls !== undefined &&
          sharedPriorToolCalls
        ) {
          // ---------------------------------------------------------------
          // Path A: complex loop reuse with shared budgets + prior tool
          // calls (T09 §13 correction-round reuse). Mirrors legacy
          // L1358-L1579.
          // ---------------------------------------------------------------
          // PT-07 AC09 — the SAME material-backed observation adapter as the
          // initial run, so a correction round's observations are measured
          // against the same material and the same budget.
          const loopCompressor = compressor
            ? createComplexLoopObservationCompressor({ assembler, compressor })
            : undefined
          let correctionLoopResult: ComplexLoopResult
          try {
            correctionLoopResult = await abortable(
              runComplexLoop(
                {
                  controller: complexLoopController,
                  searcher,
                  assembler,
                  ...(loopCompressor ? { compressor: loopCompressor } : {}),
                },
                {
                  query: gapQuery.text,
                  ...(accessContext ? { accessContext } : {}),
                  // Ticket 05 (KB-03A): the correction loop's tool searches
                  // stay inside the run's server-computed knowledge scope —
                  // same contract as the initial loop above.
                  ...(retrievalScope ? { retrievalScope } : {}),
                  // PT-02 AC04 / PT-03 AC06: the gap re-check uses the SAME
                  // bound session and web intent as the initial retrieval —
                  // the identity is never rebuilt wider for a correction.
                  ...(sessionId ? { attachments: { sessionId } } : {}),
                  ...(input.useWeb === true ? { webRequested: true } : {}),
                  signal,
                  remainingIterations: sharedRemainingIterations,
                  remainingToolCalls: sharedRemainingToolCalls,
                  priorToolCalls: sharedPriorToolCalls,
                }
              ),
              signal
            )
          } catch (err) {
            if (err instanceof Error && err.name === "AbortError") throw err
            // Non-Abort loop error → deterministic fallback (criterion #5).
            // Mirrors legacy L1400-L1410.
            correctionLoopResult = {
              results: [],
              toolCalls: [],
              stopReason: "provider-failure",
              iterationsExecuted: 0,
              toolCallsExecuted: 0,
              finalObservation: "",
            }
          }

          // Update shared budgets for subsequent correction rounds
          // (criterion #2). Skip when the loop call threw (sentinel).
          // Mirrors legacy L1434-L1453.
          if (
            correctionLoopResult.iterationsExecuted > 0 ||
            correctionLoopResult.toolCallsExecuted > 0
          ) {
            sharedRemainingIterations = Math.max(
              0,
              sharedRemainingIterations - correctionLoopResult.iterationsExecuted
            )
            sharedRemainingToolCalls = Math.max(
              0,
              sharedRemainingToolCalls - correctionLoopResult.toolCallsExecuted
            )
            sharedPriorToolCalls = [
              ...sharedPriorToolCalls,
              ...correctionLoopResult.toolCalls.map((c) => ({
                tool: c.tool,
                argsKey: c.argsKey,
              })),
            ]
          }

          // Criterion #5: loop produced 0 new results + non-evidence-
          // sufficient → fall back to deterministic `searcher.search`.
          // Mirrors legacy L1514-L1572.
          const needsDeterministicFallback =
            correctionLoopResult.results.length === 0 &&
            correctionLoopResult.stopReason !== "evidence-sufficient"
          if (needsDeterministicFallback) {
            const fallbackOutcome = await abortable(
              searcher.search(gapQuery, {
                accessContext,
                // Ticket 05 (KB-03A): the deterministic fallback stays inside
                // the run's server-computed knowledge scope.
                ...(retrievalScope ? { retrievalScope } : {}),
                // Ticket 22 (ATT-01): the fallback reads the same session.
                ...(sessionId ? { attachments: { sessionId } } : {}),
                // Ticket 36 (WEB-01) / PT-03 AC06: same web intent, too.
                ...(input.useWeb === true ? { webRequested: true } : {}),
                signal,
              }),
              signal
            )
            fallbackOutcome.unavailableChannels.forEach((ch) =>
              unavailableChannels.add(ch)
            )
            for (const reason of fallbackOutcome.degradationReasons ?? []) {
              retrievalDegradedReasons.add(reason)
            }
            if (fallbackOutcome.status === "insufficient") {
              correctionInsufficient = true
              break
            }
            if (fallbackOutcome.results.length === 0) continue
            if (fallbackOutcome.ordering) correctionOrderings.push(fallbackOutcome.ordering)
            gapResultsForRound.push(...fallbackOutcome.results)
            anyNewResults = true
          } else {
            // Loop produced results (or declared evidence-sufficient with 0
            // new results — treat as no new evidence for this gap query).
            if (correctionLoopResult.results.length === 0) continue
            gapResultsForRound.push(...correctionLoopResult.results)
            anyNewResults = true
          }
        } else {
          // ---------------------------------------------------------------
          // Path B: legacy single searcher.search per gap query. Mirrors
          // T11 correction retrieval + legacy L1580-L1648.
          // ---------------------------------------------------------------
          const correctionOutcome = await abortable(
            searcher.search(gapQuery, {
              accessContext,
              // Ticket 05 (KB-03A): a legacy correction search stays inside
              // the run's server-computed knowledge scope.
              ...(retrievalScope ? { retrievalScope } : {}),
              // Ticket 22 (ATT-01): a legacy correction reads the same session.
              ...(sessionId ? { attachments: { sessionId } } : {}),
              // Ticket 36 (WEB-01) / PT-03 AC06: and the same web intent.
              ...(input.useWeb === true ? { webRequested: true } : {}),
              signal,
            }),
            signal
          )
          correctionOutcome.unavailableChannels.forEach((ch) =>
            unavailableChannels.add(ch)
          )
          for (const reason of correctionOutcome.degradationReasons ?? []) {
            retrievalDegradedReasons.add(reason)
          }
          if (correctionOutcome.status === "insufficient") {
            correctionInsufficient = true
            break
          }
          if (correctionOutcome.results.length === 0) continue
          if (correctionOutcome.ordering) correctionOrderings.push(correctionOutcome.ordering)
          gapResultsForRound.push(...correctionOutcome.results)
          anyNewResults = true
        }
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
        // No new evidence from any gap query → exhausted. Mirrors T11.
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
            status: degradationWasObserved(unavailableChannels, [...retrievalDegradedReasons]) ? "partial" : "none",
            unavailableChannels: [...unavailableChannels],
            reason: "coverage_not_met",
          }
        } else {
          setTerminal("insufficient_evidence")
          terminalDegradation = {
            status: degradationWasObserved(unavailableChannels, [...retrievalDegradedReasons]) ? "partial" : "none",
            unavailableChannels: [...unavailableChannels],
            reason: "coverage_not_met",
          }
        }
        break
      }

      // Rebuild Evidence + Context from the accumulated results, then
      // regenerate the draft. Mirrors T11.
      // PT-05: whatever produced the new hits this round — the bounded tool
      // loop, the deterministic searcher fallback or the legacy per-gap-query
      // search — they are selected BEFORE the older material through the same
      // shared gap-first rule the simple route uses
      // (`../retrieval/context/correction_selection`), so the fresh facts take
      // first claim on the unchanged 6,000-token budget instead of queueing
      // behind the old top-10 parent chunks. No rerank step, no larger budget,
      // no extra round.
      const selection = selectCorrectionCandidates({
        gapResults: gapResultsForRound,
        olderResults: accumulatedResults,
      })
      accumulatedResults = selection.orderedResults
      evidence = buildEvidence(accumulatedResults)
      const correctionCandidates = selection.candidates
      const correctionCitationIds = citationIdsByChunk(evidence)
      input.onStageProgress?.("context", { round: round + 2, data: { phase: "assembly", evidenceCount: evidence.length } })
      // PT-07:AC07/AC09 — one material-backed preparation for this round, the
      // SAME shared entry point the initial round and the simple route use: the
      // deterministic context, the budget decision on the real candidate
      // counts and the compression attempt all come from one place, so the
      // fallback and the source records can never disagree about which context
      // is going to generate.
      const prepared = await abortable(
        prepareGenerationContext({
          assembler,
          results: correctionCandidates,
          citationIds: correctionCitationIds,
          evidence,
          query: effectiveMessage,
          ...(compressor ? { compressor } : {}),
          maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
          ...(signal ? { signal } : {}),
          // PT-05 AC07: compression only closes the correction round when its
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
      // PT-05 AC06: even selected-first, a gap item longer than the whole
      // budget cannot be admitted. Record it as an explicit omission so no
      // layer can present the correction as covered — the existing validation
      // rules still decide whether the run degrades.
      const budgetOmissions = findUncoveredGapFacts({
        gapCandidates: selection.gapCandidates,
        citationIds: correctionCitationIds,
        // PT-06:AC07 — the coverage question is asked against the context that
        // really generates: the deterministic one, never a rejected compressed
        // output.
        context: prepared.deterministicContext,
        mode: "verbatim",
        reason: "context_budget",
      })
      // PT-05 AC07 / PT-06 AC07: an adopted compression proved its citation
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
      // snapshot and overwrites the previous one, described from the context
      // this round actually handed over (deterministic fallback or adopted
      // compression).
      describeGenerationContext()
      contextTrace.phase = "draft"
      input.onStageProgress?.("context", { status: "completed", round: round + 2, data: { phase: "draft", evidenceCount: evidence.length } })
      // Citation check on regenerated draft (T12 #5).
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
      // PT-05: this list is the gap-first merge of this round's 补检 hits with
      // the earlier retrievals, so its ordering label is the honest
      // aggregation, never a dedicated rerank.
      commitFinalContext(correctionCandidates, correctionCitationIds, correctionOrderings, true)
    }

    // -------------------------------------------------------------------------
    // GATE 5/6: publish or handoff. Mirrors T11.
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
          status: degradationWasObserved(unavailableChannels, [...retrievalDegradedReasons]) ? "partial" : "none",
          unavailableChannels: [...unavailableChannels],
          reason: "coverage_not_met",
        }
      } else {
        setTerminal("insufficient_evidence")
        terminalDegradation = {
          status: degradationWasObserved(unavailableChannels, [...retrievalDegradedReasons]) ? "partial" : "none",
          unavailableChannels: [...unavailableChannels],
          reason: "coverage_not_met",
        }
      }
    }

    if (!approved) {
      // Terminal non-completed path: do NOT save validated turns (T10 #2).
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

    // Approved: final citation check (T12 #5: at least one valid Citation).
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

    // Save validated turns + trigger summarization (T10 #2: only completed).
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
        status: degradationWasObserved(unavailableChannels, [...retrievalDegradedReasons]) ? "partial" : "none",
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
