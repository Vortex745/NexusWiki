/**
 * Ticket 31 (FAQ-01B) — the exact-FAQ gate in front of the route dispatch.
 *
 * A UNIQUE normalized match of the user's message against the ACTIVE FAQ
 * entries of the run's knowledge scope answers DIRECTLY with the stored
 * standard answer: no routing, no retrieval, no generation, no validation —
 * the answer is not generated text, it is the curated content of an
 * immutable FAQ version. Everything else (no match, ambiguous matches, no
 * scope, no FAQ service) falls through to the normal runner untouched.
 *
 * The wrapper stays BELOW the event adapter on purpose: the run keeps its
 * runId, trace persistence, observers, budgets and terminal-exactly-once
 * semantics. The FAQ reference carries `origin: "faq"` so the UI can label
 * the answer as a standard answer, and the validated conversation memory
 * records the exchange like any completed turn.
 */

import type {
  MastraRunner,
  MastraRunnerOutput,
} from "./chat_event_adapter"
import type { FaqEntryService } from "../faq/faq_entry_service"
import type { FaqActiveIdentityRow } from "../faq/faq_entry_repo"
import { matchExactFaq } from "../faq/faq_matcher"
import { buildFaqEvidence } from "../faq/faq_evidence"
import type { ConversationStore } from "../answer/conversation_store"
import type { AccessContext } from "../access/context"

export interface FaqExactMatchRunnerDeps {
  /** Absent → the wrapper is a pure pass-through (evaluation scopes, probes). */
  faq?: FaqEntryService
  /** Completed FAQ answers are conversation turns too. */
  conversationStore?: ConversationStore
  resolveTenantId?: (accessContext: AccessContext) => string
  now?: () => Date
}

function faqOutput(
  input: Parameters<MastraRunner>[0],
  row: FaqActiveIdentityRow,
  viaVariant: boolean
): MastraRunnerOutput {
  return {
    reply: row.answer,
    status: "completed",
    references: [buildFaqEvidence(row)],
    degradation: { status: "none", unavailableChannels: [] },
    tokens: [row.answer],
    routeTrace: {
      faqMatch: {
        entryId: row.entryId,
        version: row.version,
        question: row.question,
        viaVariant,
      },
    },
    retrievalTrace: {},
    contextTrace: {},
    validationTrace: {},
  }
}

export function createFaqExactMatchRunner(
  deps: FaqExactMatchRunnerDeps,
  inner: MastraRunner
): MastraRunner {
  return async function faqExactMatchRunner(input) {
    const scope = input.retrievalScope
    if (
      !deps.faq ||
      !scope ||
      scope.knowledgeBaseIds.length === 0 ||
      input.signal.aborted
    ) {
      return inner(input)
    }
    const tenantId = deps.resolveTenantId
      ? deps.resolveTenantId(input.accessContext)
      : "default"
    const match = matchExactFaq(
      deps.faq.listActive(tenantId, scope.knowledgeBaseIds),
      input.message
    )
    if (!match) return inner(input)

    if (deps.conversationStore && deps.resolveTenantId) {
      const now = (deps.now ?? (() => new Date()))().toISOString()
      deps.conversationStore.saveValidatedTurn({
        sessionId: input.sessionId,
        tenantId,
        role: "user",
        content: input.message,
        runId: input.runId,
        createdAt: now,
      })
      deps.conversationStore.saveValidatedTurn({
        sessionId: input.sessionId,
        tenantId,
        role: "assistant",
        content: match.row.answer,
        runId: input.runId,
        createdAt: now,
      })
    }
    return faqOutput(input, match.row, match.viaVariant)
  }
}
