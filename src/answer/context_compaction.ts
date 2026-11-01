/**
 * Conversation-context compaction (2026-10-31).
 *
 * When the session footprint reaches `budgetTokens`, the session is folded
 * into the account's long-term profile by the SAME summarizer the new-session
 * trigger uses, then the meter's checkpoint advances past the newest turn so
 * the gauge drops back to the summary size.
 *
 * Deliberately NOT here:
 *   - The rolling summary is not re-advanced. Every answer runner already
 *     folds older validated turns into it once the recent window slides, and
 *     forcing an earlier checkpoint would duplicate the last six pairs and
 *     race the next run's checkpoint.
 *   - Nothing is deleted: history stays readable, and the runtime keeps its
 *     bounded summary + six-pair window.
 *   - The fold reuses the new-session summarizer's own transcript bound
 *     (newest 12,000 characters). The checkpoint is the METER's reset, not a
 *     claim that every older character reached the profile — the existing
 *     summarizer is bounded by design, exactly as on a new session.
 *   - The run never waits for compaction. The call is best-effort, guarded
 *     per session, and a failure simply leaves the checkpoint untouched so
 *     the next answer retries.
 */

import type { AccessContext } from "../access/context"
import type { Logger } from "../logging/logger"
import type { SessionMemorySummarizer } from "../memory/session_memory_summarizer"
import {
  ConversationHistoryError,
  type SqliteConversationHistoryStore,
} from "./conversation_history_store"
import type { ConversationStore } from "./conversation_store"
import { computeContextUsage, type ContextUsageSnapshot } from "./context_usage"

export interface ContextUsageView extends ContextUsageSnapshot {
  /** True while this session's fold into long-term memory is in flight. */
  compacting: boolean
}

export interface ContextCompactionDeps {
  history: Pick<
    SqliteConversationHistoryStore,
    "getTurns" | "getContextCheckpoint" | "markContextCompacted"
  >
  conversationStore: Pick<ConversationStore, "getRollingSummary">
  memorySummarizer: Pick<SessionMemorySummarizer, "summarize">
  budgetTokens: number
  logger?: Logger
}

export interface ContextCompactionService {
  /** Current meter reading. Throws ConversationHistoryError for unknown/foreign sessions. */
  usage(context: AccessContext, sessionId: string): ContextUsageView
  /**
   * Fold the session into long-term memory when the budget is reached.
   * Resolves when the attempt settles; the chat transport calls it without
   * awaiting. Concurrent calls for one session are collapsed into the first
   * (per process; the checkpoint itself is forward-only in SQLite).
   */
  maybeCompact(context: AccessContext, sessionId: string): Promise<void>
}

interface SessionRead {
  turns: ReturnType<SqliteConversationHistoryStore["getTurns"]>
  summary: string | null
  compactedThroughAt: string | null
}

export function createContextCompactionService(
  deps: ContextCompactionDeps
): ContextCompactionService {
  const inFlight = new Set<string>()
  const keyOf = (context: AccessContext, sessionId: string) =>
    `${context.tenantId}\u0000${sessionId}`

  const read = (context: AccessContext, sessionId: string): SessionRead => ({
    turns: deps.history.getTurns(sessionId, context.tenantId, context.subjectId),
    summary:
      deps.conversationStore.getRollingSummary(sessionId, context.tenantId)?.summary ?? null,
    compactedThroughAt: deps.history.getContextCheckpoint(
      sessionId,
      context.tenantId,
      context.subjectId
    ),
  })

  const usageOf = (state: SessionRead) =>
    computeContextUsage({
      turns: state.turns,
      summary: state.summary,
      compactedThroughAt: state.compactedThroughAt,
      budgetTokens: deps.budgetTokens,
    })

  const toUsage = (context: AccessContext, sessionId: string, state: SessionRead): ContextUsageView => ({
    ...usageOf(state),
    compacting: inFlight.has(keyOf(context, sessionId)),
  })

  return {
    usage(context, sessionId) {
      return toUsage(context, sessionId, read(context, sessionId))
    },

    async maybeCompact(context, sessionId) {
      const key = keyOf(context, sessionId)
      if (inFlight.has(key)) return
      // Ownership / unknown sessions: the history read throws; a background
      // sweep must never crash the request that triggered it. A real read
      // failure is logged — an unknown session is not noise.
      let state: SessionRead
      try {
        state = read(context, sessionId)
      } catch (error) {
        if (!(error instanceof ConversationHistoryError)) {
          void deps.logger?.warn("context.compaction.read_failed", {
            sessionId,
            tenantId: context.tenantId,
            subjectId: context.subjectId,
            message: error instanceof Error ? error.message : String(error),
          })
        }
        return
      }
      const usage = usageOf(state)
      if (usage.usedTokens < usage.budgetTokens) return
      const newestTurnAt = state.turns[state.turns.length - 1]?.createdAt
      if (!newestTurnAt) return

      inFlight.add(key)
      try {
        await deps.memorySummarizer.summarize(context, sessionId)
        deps.history.markContextCompacted(
          sessionId,
          context.tenantId,
          context.subjectId,
          newestTurnAt
        )
        void deps.logger?.info("context.compaction.completed", {
          sessionId,
          tenantId: context.tenantId,
          subjectId: context.subjectId,
          usedTokens: usage.usedTokens,
          budgetTokens: usage.budgetTokens,
          compactedThroughAt: newestTurnAt,
        })
      } catch (error) {
        void deps.logger?.warn("context.compaction.failed", {
          sessionId,
          tenantId: context.tenantId,
          subjectId: context.subjectId,
          usedTokens: usage.usedTokens,
          budgetTokens: usage.budgetTokens,
          message: error instanceof Error ? error.message : String(error),
        })
      } finally {
        inFlight.delete(key)
      }
    },
  }
}
