/**
 * Ticket 09 — Direct + ambiguous route Mastra runner.
 *
 * Implements the `MastraRunner` seam (defined in Ticket 05) for the two
 * simplest Answer routes:
 *   - `direct`   — LLM chat without retrieval/Evidence/Citation. Streams the
 *                  model reply and returns terminal `completed`.
 *   - `ambiguous`— Clarification-required. Saves a pending clarification to
 *                  ConversationStore (preserving legacy persistence) and
 *                  returns terminal `clarification_required`.
 *
 * Routes not owned by this runner (`simple`, `complex`) throw
 * `RouteNotSupportedError`. Production dispatch prevents that mismatch by
 * invoking this runner only for an authoritative direct/ambiguous decision.
 *
 * Boundary: this module is owned by `src/mastra/*` and MUST NOT import
 * `src/api/*` or `src/index` (T02 #5 dependency direction). It depends only
 * on:
 *   - `src/mastra/chat_event_adapter.ts` (MastraRunner seam + types)
 *   - `src/retrieval/router/interface.ts` (Router interface)
 *   - `src/answer/conversation_store.ts` (ConversationStore interface)
 *   - `src/access/context.ts` (AccessContext type)
 *
 * @mastra/core decoupling: the actual LLM stream is injected via
 * `streamDirectReply` so the runner can be tested without the real Mastra
 * Agent. Ticket 09's production wiring (in `src/index.ts`) constructs a real
 * @mastra/core Agent and adapts its `stream()` output to the
 * `AsyncIterable<string>` signature. This mirrors the T05 MastraRunner seam
 * pattern (prototype tested in isolation, production wiring in index.ts).
 *
 * Cancellation contract (T09 #4): the runner respects `input.signal.aborted`
 * at two checkpoints:
 *   1. Before invoking the Router (pre-route abort → AbortError)
 *   2. During `streamDirectReply` iteration (mid-stream abort → the stream
 *      throws AbortError, which propagates out of the runner)
 *
 * The runner does NOT emit AnswerRunEvents directly — that's the T05 adapter's
 * job. It returns a single `MastraRunnerOutput` per T03 §5 (single-shot,
 * maxSteps=1 + maxRetries=0 enforced by the Agent config, not by the runner).
 */

import type {
  MastraRunner,
  MastraRunnerInput,
  MastraRunnerOutput,
} from "./chat_event_adapter"
import type { Router } from "../retrieval/router/interface"
import type { ConversationStore } from "../answer/conversation_store"
import type { Summarizer } from "../answer/summarizer"
import type { AccessContext } from "../access/context"
import type { TokenUsage } from "../types"
import type { MastraMemoryAdapter } from "./memory_adapter"
import { formatMemoryAsContext } from "./memory_adapter"
import { renderMemoryPromptSuffix } from "./memory_prompt"

/**
 * Error thrown when the route decision is not supported by T09's
 * DirectAmbiguousMastraRunner.
 *
 * The `decision` field identifies the route-owner mismatch.
 */
export class RouteNotSupportedError extends Error {
  constructor(public readonly decision: "simple" | "complex") {
    super(
      `Route "${decision}" is not supported by DirectAmbiguousMastraRunner (T09). ` +
      `Supported routes: direct, ambiguous. ` +
      `T11 (simple knowledge route) and T12 (complex correction routes) own migration for these routes.`
    )
    this.name = "RouteNotSupportedError"
  }
}

/**
 * Streamed LLM reply for the direct route. Returns an async iterable of token
 * strings (mirroring `model.stream()` in legacy `src/answer/generation.ts`).
 *
 * The runner iterates this to collect tokens for `MastraRunnerOutput.tokens`
 * + `reply`. Mid-stream abort MUST surface as an AbortError thrown from the
 * iterable (the runner does not install its own abort listener on the stream
 * — the iterable is expected to honor the signal).
 */
export type DirectReplyStream = (
  message: string,
  signal: AbortSignal,
  /** Ticket 19 (AST-01B): the assistant's own prompt, prepended as a leading
   * system message when present (the snapshot is transport-resolved). */
  options?: { systemPrompt?: string }
) => AsyncIterable<string>

/**
 * Resolve tenantId from AccessContext. The runner needs tenantId for
 * `ConversationStore.savePendingClarification` (ambiguous route). Extracted
 * as a dependency so the runner doesn't hardcode AccessContext field
 * assumptions (single-tenant vs enforced mode).
 */
export type TenantIdResolver = (accessContext: AccessContext) => string

export interface DirectAmbiguousMastraRunnerDeps {
  /** Legacy Router — called once per run to get the route decision (GATE 0). */
  router: Router
  /** Streamed LLM reply for the direct route (abstracts @mastra/core Agent). */
  streamDirectReply: DirectReplyStream
  /** ConversationStore for pending-clarification persistence (ambiguous route). */
  conversationStore?: ConversationStore
  /** Resolve tenantId from AccessContext. Required when conversationStore is wired. */
  resolveTenantId?: TenantIdResolver
  /**
   * Ticket 10 — Conversation Memory adapter. When wired, the direct route
   * loads conversation memory before streaming (prepends a context prefix to
   * the user message) and saves the validated user + assistant turns after
   * the stream completes (terminal=completed). Ambiguous route does NOT use
   * the adapter (clarification is not a completed turn).
   *
   * Optional for backward compatibility with T09 tests (runner behaves
   * exactly as T09 when omitted — no memory loading, no turn saving).
   *
   * T04 section 3: the adapter is a pure pass-through to ConversationStore;
   * the runner extracts tenantId from AccessContext via resolveTenantId and
   * passes it as resourceId (T04 section 3 rule 1: no tenantId as free-form
   * arg).
   */
  memoryAdapter?: MastraMemoryAdapter
  /** Rolling conversation summarizer for completed direct turns. */
  summarizer?: Summarizer
  /**
   * Clock for `createdAt` timestamps on saved validated turns. Injected for
   * testability; defaults to `() => new Date()` in production. Matches the
   * legacy `generation.ts` pattern of stamping turns at save time.
   */
  now?: () => Date
}

/**
 * Clarification reply for the ambiguous route. Terminal behavior (clarification
 * state, persistence, expiry — T09 #2) is unchanged by the wording; the copy is
 * user-facing so it stays in Chinese per the product language policy.
 */
const AMBIGUOUS_CLARIFICATION_REPLY = "仅凭当前信息我还无法作答，请您补充更多问题细节。"

function checkAbort(signal: AbortSignal, checkpoint: string): void {
  if (!signal.aborted) return
  const error = new Error(`Answer run cancelled at ${checkpoint}`)
  error.name = "AbortError"
  throw error
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
      sessionId,
      tenantId,
      previousCheckpoint,
      newCheckpoint
    )
    if (olderTurns.length === 0 && memory.summary) return { outcome: "skipped" }
    const result = await summarizer.summarize(olderTurns, memory.summary, signal)
    if (signal.aborted || !result.summary) {
      return { outcome: "failed", durationMs: Date.now() - start }
    }
    conversationStore.saveRollingSummary(
      sessionId,
      tenantId,
      result.summary,
      newCheckpoint,
      1
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

/**
 * Create a MastraRunner that handles direct + ambiguous routes.
 *
 * Throws `RouteNotSupportedError` for simple/complex routes (T09 #5).
 */
export function createDirectAmbiguousMastraRunner(
  deps: DirectAmbiguousMastraRunnerDeps
): MastraRunner {
  const {
    router,
    streamDirectReply,
    conversationStore,
    resolveTenantId,
    memoryAdapter,
    summarizer,
    now,
  } = deps
  const clock = now ?? (() => new Date())

  return async function directAmbiguousMastraRunner(
    input: MastraRunnerInput
  ): Promise<MastraRunnerOutput> {
    // T09 #4 cancellation checkpoint 1: before Router call (pre-route abort).
    checkAbort(input.signal, "GATE 0 (before route)")

    const tenantId = resolveTenantId
      ? resolveTenantId(input.accessContext)
      : "default"
    let effectiveMessage = input.preparedRoute?.effectiveMessage ?? input.message
    if (!input.preparedRoute && conversationStore && resolveTenantId) {
      const pendingMessage = conversationStore.peekPendingClarification?.(
        input.sessionId,
        tenantId
      )
      if (pendingMessage) {
        effectiveMessage = `${pendingMessage} ${input.message}`
      }
    }

    // GATE 0: route decision (legacy Router — T03 §2.3 hybrid topology keeps
    // route classification as a deterministic gate, NOT an Agent decision).
    // `Router.decide` takes a `Query` ({ text: string, ... }); wrap the chat
    // message into a minimal Query object. Legacy generation.ts does the same
    // wrapping before calling the Router.
    const decision = input.preparedRoute?.decision ?? (
      input.memoryIntent
        ? "direct"
        : await router.decide({ text: effectiveMessage })
    )

    // Ownership guard (T09 #5): simple/complex routes are not owned here.
    if (decision === "simple" || decision === "complex") {
      throw new RouteNotSupportedError(decision)
    }

    if (conversationStore && resolveTenantId && !input.preparedRoute) {
      checkAbort(input.signal, "GATE 0 (before pending clarification consume)")
      if (conversationStore.claimPendingClarification) {
        conversationStore.claimPendingClarification(input.sessionId, tenantId)
      } else {
        conversationStore.consumePendingClarification(input.sessionId, tenantId)
      }
    }

    // Ambiguous route (T09 #2): clarification_required with pending
    // clarification persistence.
    if (decision === "ambiguous") {
      // Save pending clarification to ConversationStore — preserves legacy
      // persistence behavior (generation.ts:646-648).
      if (conversationStore && resolveTenantId) {
        checkAbort(input.signal, "GATE 6 (before pending clarification persistence)")
        conversationStore.savePendingClarification(
          input.sessionId,
          tenantId,
          effectiveMessage
        )
      }
      return {
        reply: AMBIGUOUS_CLARIFICATION_REPLY,
        status: "clarification_required",
        references: [],
        degradation: { status: "none", unavailableChannels: [] },
        tokens: [AMBIGUOUS_CLARIFICATION_REPLY],
        routeTrace: input.preparedRoute?.routeTrace ?? { decision: "ambiguous" },
        retrievalTrace: {},
        contextTrace: {},
        validationTrace: {},
      }
    }

    // Direct route (T09 #1 + T10): stream LLM reply, no retrieval/Evidence/
    // Citation. Tokens are collected during streaming; mid-stream abort
    // surfaces as AbortError from the stream (T09 #4 cancellation checkpoint 2).
    //
    // T10: when memoryAdapter + resolveTenantId are wired, load conversation
    // memory before streaming and prepend a context prefix to the user
    // message (so the Mastra Agent sees prior turns + rolling summary). After
    // the stream completes (terminal=completed), save the validated user +
    // assistant turns so future runs see this exchange in their memory window.
    // T10 #2: only completed turns are saved — mid-stream abort throws before
    // reaching the save block, so partial replies are NOT persisted.
    const memoryTenantId = memoryAdapter && resolveTenantId
      ? tenantId
      : null

    let contextPrefix = ""
    let summarization: SummarizationOutcome = { outcome: "skipped" }
    if (memoryAdapter && memoryTenantId !== null) {
      // T10 #5 safe-degradation: query() returns empty snapshot on store
      // error (never throws). formatMemoryAsContext("") → "" → no prefix.
      const snapshot = memoryAdapter.query(input.sessionId, memoryTenantId)
      contextPrefix = formatMemoryAsContext(snapshot)
    }

    const promptMessage = contextPrefix.length > 0
      ? `${contextPrefix}\n\n${effectiveMessage}`
      : effectiveMessage

    // Ticket 33 (MEM-01B): recalled long-term memories ride the system prompt
    // as clearly-labeled background — never evidence, never citations.
    const memorySuffix = renderMemoryPromptSuffix(input.longTermMemories)
    const memoryQueryPrompt = input.memoryIntent
      ? "\n\n[长期记忆查询约束] 用户正在询问已保存的长期记忆。只能根据下方长期记忆区块回答；如果区块为空，明确说明当前没有可用的长期记忆。不得根据常识猜测，也不得生成或展示任何引用。"
      : ""
    const systemPrompt = [input.assistant?.systemPrompt, memoryQueryPrompt, memorySuffix]
      .filter((part): part is string => Boolean(part))
      .join("")
    const tokens: string[] = []
    for await (const token of streamDirectReply(promptMessage, input.signal, {
      ...(systemPrompt ? { systemPrompt } : {}),
    })) {
      tokens.push(token)
      // Direct route has no critic gate before publication (T09 §13) — push
      // each token to the transport live so the answer streams in real time.
      input.onAnswerDelta?.(token)
    }
    const reply = tokens.join("")

    // T10 #2: save validated turns ONLY after the stream completes (terminal=
    // completed). Mid-stream abort throws AbortError from the stream above and
    // never reaches this block — partial replies are NOT persisted (existing
    // invariant: failed/cancelled content is NOT saved).
    if (memoryAdapter && memoryTenantId !== null) {
      checkAbort(input.signal, "GATE 5 (before validated turn persistence)")
      const createdAt = clock().toISOString()
      memoryAdapter.addValidatedTurn({
        threadId: input.sessionId,
        resourceId: memoryTenantId,
        role: "user",
        content: effectiveMessage,
        runId: input.runId,
        createdAt,
      })
      memoryAdapter.addValidatedTurn({
        threadId: input.sessionId,
        resourceId: memoryTenantId,
        role: "assistant",
        content: reply,
        runId: input.runId,
        createdAt,
      })
      if (conversationStore) {
        summarization = await triggerSummarization(
          conversationStore,
          summarizer,
          input.sessionId,
          memoryTenantId,
          input.signal
        )
      }
    }

    return {
      reply,
      status: "completed",
      references: [],
      degradation: { status: "none", unavailableChannels: [] },
      tokens,
      routeTrace: input.preparedRoute?.routeTrace ?? { decision: "direct" },
      retrievalTrace: {},
      contextTrace: {},
      validationTrace: {},
      summarizationOutcome: summarization.outcome,
      summarizationUsage: summarization.usage,
      summarizationDurationMs: summarization.durationMs,
      summarizationCheckpoint: summarization.checkpoint,
    }
  }
}
