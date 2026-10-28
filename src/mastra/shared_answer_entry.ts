/**
 * Shared Answer run entry — the small public face of a three-file composition
 * root (ARCH-01, tickets 47-53).
 *
 * What lives where:
 *   - `answer_retrieval_stack.ts` — HOW a run reads the knowledge base: the
 *     dedicated reranker, the search operations, the optional attachment/FAQ/
 *     Web evidence channels and the per-assistant rerank-free searcher.
 *   - `answer_route_stack.ts` — HOW a run answers: the router, the four
 *     route runners, the single dispatch, the FAQ gate and memory wrappers,
 *     and the read-only tool registry plus MCP capability discovery.
 *   - this module — only what a caller observes: narrow-context resolution
 *     (which seams the caller injected), connecting the two stacks, observer
 *     fanout, run budget and cancellation, the frozen model snapshot, and
 *     terminal-event stamping.
 *
 * Two consumers, one implementation:
 *   - Normal chat: `src/index.ts` wires the returned `eventsSource` through
 *     the Mastra runtime boundary into the HTTP server.
 *   - Evaluation: `src/evaluation/isolated_resources.ts` calls the same
 *     factory with injected isolated repositories and observers. Neither sees
 *     the stacks; both get the same transport-agnostic events source, so chat
 *     and an isolated run cannot drift apart in routing, retrieval or
 *     terminal behavior.
 *
 * Boundary (T02 #5): this module MUST NOT import `src/api/*`,
 * `src/evaluation/*`, or `src/index`. It depends only on config, the answer
 * service layer, retrieval/critic services, and sibling `src/mastra/*`
 * runtime modules.
 */

import type { AppConfig } from "../config"
import type { AnswerRuntime } from "../answer/runtime"
import type {
  AnswerRunObserver,
  AnswerRunOptions,
} from "../answer/generation"
import type { ConversationStore } from "../answer/conversation_store"
import { SqliteConversationStore } from "../answer/conversation_store"
import type { HandoffStore } from "../answer/handoff_store"
import { SqliteHandoffStore } from "../answer/handoff_store"
import {
  langfuseObserver,
  NoopLangfuseExporter,
  type LangfuseExporter,
} from "../answer/langfuse_exporter"
import type { SearchOperations } from "../retrieval/search/searcher"
import type { Reranker } from "../retrieval/search/dedicated_reranker"
import {
  createModelCostEstimator,
  DEFAULT_RUN_BUDGET_MS,
  type RunResourceBudgetOptions,
} from "../runtime/run_context"
import type { AnswerRunEvent, AnswerRunResult, ReasoningCapability, ReasoningEffort } from "../types"
import type { AnswerModelProfileSnapshot } from "../types/answer"
import type { AttachmentSearchOperations } from "../types/retrieval"
import { knowledgeBaseEmbeddingProfile } from "../types/knowledge_base"
import { createMastraChatEventAdapter } from "./chat_event_adapter"
import { createAnswerRetrievalStack } from "./answer_retrieval_stack"
import {
  createAnswerRouteStack,
  type AnswerMcpCapabilities,
} from "./answer_route_stack"
import type { FaqEntryService } from "../faq/faq_entry_service"
import type { LongTermMemoryStore } from "../memory/long_term_memory_store"
import type { MemorySuggestionStore } from "../memory/memory_suggestion_store"
import type { WebEvidenceOperations } from "../types/retrieval"
import { type DirectReplyStream } from "./direct_ambiguous_runner"

/**
 * Transport-level event source signature — structurally identical to
 * `AnswerEventsSource` in src/api/chat.ts and `MastraChatEventSource` in
 * chat_event_adapter.ts. Inlined here to honor the dependency direction
 * (this module must not import src/api). TypeScript structural typing makes
 * the returned source assignable at every injection site.
 */
export type SharedAnswerEventsSource = (
  message: string,
  options: AnswerRunOptions
) => AsyncIterable<AnswerRunEvent>

export interface SharedAnswerEntryOptions {
  config: AppConfig
  answerRuntime: AnswerRuntime
  /**
   * Injection seams (evaluation / tests). Every seam defaults to the exact
   * production wiring previously inlined in `src/index.ts` — omitting all of
   * them reproduces the normal chat composition unchanged.
   */
  /** Conversation memory store. Default: SQLite on the shared process db. */
  conversationStore?: ConversationStore
  /**
   * Retrieval operations (ES + embedding + PageIndex/ActiveVersion repos).
   * Default: RuntimeSearchOperations on the shared clients.
   */
  searchOperations?: SearchOperations
  /**
   * Dedicated reranker (Ticket 03). Default: built from the RERANK_* config
   * (undefined when no key is configured). Injected by evaluation when a task
   * overrides the rerank model (Ticket 11).
   */
  reranker?: Reranker
  /** Handoff persistence. Default: SQLite on the shared process db. */
  handoffStore?: HandoffStore
  /**
   * Hard trace observer (failure stops publication — T06 §5.3 fanout order).
   * Default: answerRuntime.traceRepository.
   */
  traceObserver?: AnswerRunObserver
  /** Soft observers appended AFTER the (optional) Langfuse observer. */
  observers?: AnswerRunObserver[]
  /**
   * LO-06 (LG-05-AC10): once OTel takes over the Answer execution through the
   * HTTP root, the legacy Langfuse exporter must not publish a second trace or
   * synthesize Generations for the same run. Set to false when tracing is
   * enabled — SQLite consumption (`traceObserver`) is unaffected, so product
   * events keep being recorded exactly as before.
   */
  legacyLangfuseObserver?: boolean
  /**
   * Direct-route LLM stream seam. Default: the production
   * `createDirectReplyStream` agent (model from config).
   */
  streamDirectReply?: DirectReplyStream
  /** Whole-run deadline budget. Default: DEFAULT_RUN_BUDGET_MS / config. */
  budgetMs?: number
  /** Whole-run aggregate model call/token/cost limits. Default: from config. */
  resourceBudget?: RunResourceBudgetOptions
  /**
   * Ticket 22 (ATT-01): the session-scoped attachment channel. Default:
   * undefined — a composition without the attachment service simply never
   * reads temporary attachments (evaluation scopes, probes).
   */
  attachments?: AttachmentSearchOperations
  /**
   * Ticket 31 (FAQ-01B): the versioned FAQ service. Default: undefined — a
   * composition without it never matches FAQ entries (evaluation scopes,
   * probes). When wired, a UNIQUE normalized exact match answers directly
   * with the stored standard answer and fuzzy matches join retrieval as
   * ordinary citable evidence — always inside the run's knowledge scope.
   */
  faq?: FaqEntryService
  /**
   * Ticket 33 (MEM-01B): the user-owned long-term memory stores. Default:
   * undefined — a composition without them never recalls memory and never
   * extracts suggestions (evaluation scopes, probes). When wired, the run
   * recalls the owner's global + assistant-pinned memories into the system
   * prompt (traceable, disableable per run) and completed answers may create
   * PENDING extraction suggestions for the owner to review.
   */
  memories?: LongTermMemoryStore
  suggestions?: MemorySuggestionStore
  /**
   * Ticket 36 (WEB-01): the web-evidence adapter. Default: the production
   * adapter over the shared safe URL fetcher + config's server-side Tavily
   * key. Injected `undefined` (evaluation scopes, probes) removes the web
   * channel entirely — no URL fetch, no web search.
   */
  web?: WebEvidenceOperations
}

export interface SharedAnswerEntry {
  /** The single shared Answer run entry (transport-agnostic). */
  eventsSource: SharedAnswerEventsSource
  /**
   * The reasoning-effort capability of THIS composition's endpoint/model,
   * resolved once from the same config and frozen. The chat transport only
   * publishes this object — it never re-reads the environment.
   */
  reasoningCapability: ReasoningCapability
  /**
   * Ticket 14 (RET-01): the SAME search operations chat uses (same clients,
   * same dedicated reranker). Stateless beyond its clients; a new SearcherImpl
   * per run is exactly what the chat runners do.
   */
  searchOperations: SearchOperations
  /**
   * Ticket 35 (TOOL-01B): the product-level MCP capability invocation seam —
   * the SAME boundary the runs use (allowlist = the discovered tools, 30s
   * deadline, bounded trace records). Undefined when MCP is disabled or the
   * composition failed; undefined means "no MCP tools", never a broken run.
   * ARCH-01E: the route stack owns discovery and invocation; the entry only
   * publishes what it exposed before.
   */
  mcp?: AnswerMcpCapabilities
}

/**
 * Build the run resource budget from deployment config — exact logic
 * previously inlined in `src/index.ts`.
 */
function resourceBudgetFromConfig(
  config: AppConfig
): RunResourceBudgetOptions | undefined {
  const limits = {
    ...(config.answerRunMaxModelCalls !== undefined
      ? { maxModelCalls: config.answerRunMaxModelCalls }
      : {}),
    ...(config.answerRunMaxTokens !== undefined
      ? { maxTokens: config.answerRunMaxTokens }
      : {}),
    ...(config.answerRunMaxCostMicros !== undefined
      ? { maxCostMicros: config.answerRunMaxCostMicros }
      : {}),
  }
  if (Object.keys(limits).length === 0 && !config.answerRunModelPricing) {
    return undefined
  }
  return {
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
    ...(config.answerRunModelPricing
      ? {
          estimateCostMicros: createModelCostEstimator(
            config.answerRunModelPricing
          ),
        }
      : {}),
  }
}

/**
 * LO-06 (LG-05-AC10): decide whether the legacy Langfuse observer may publish
 * for this composition. False means "OTel owns the run" — the entry then keeps
 * only the SQLite trace observer, so a run is never recorded twice and no
 * synthetic Generation is produced alongside the OTel one.
 *
 * Exported pure so the cutover can be tested without building a full entry.
 */
export function shouldAttachLangfuseObserver(
  option: boolean | undefined,
  exporter: LangfuseExporter,
): boolean {
  const enabled = option ?? true
  return enabled && !(exporter instanceof NoopLangfuseExporter)
}

/**
 * The only endpoint/model pair this product declares reasoning-effort
 * compatible with (the China-region official GLM API). Anything else —
 * another host, a relay, an alias, another model, plain http — is NOT
 * declared compatible: the selector hides and old requests keep their
 * provider default. Guessing by prefix is deliberately not supported.
 */
const REASONING_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4"
const REASONING_MODEL = "glm-5.3-flash"
const REASONING_LEVELS: readonly ReasoningEffort[] = Object.freeze(["low", "high", "max"] as const)

/**
 * Resolve (and freeze) the reasoning-effort capability for one composition.
 * Pure: it reads the config it is handed and never the environment, a
 * provider, the database or the filesystem.
 */
export function resolveReasoningCapability(config: AppConfig): ReasoningCapability {
  const endpoint = (config.openaiBaseUrl ?? "").trim().replace(/\/+$/, "")
  const model = (config.openaiChatModel ?? "").trim()
  const supported = endpoint === REASONING_ENDPOINT && model === REASONING_MODEL
  return Object.freeze({
    supported,
    levels: supported ? REASONING_LEVELS : Object.freeze([] as ReasoningEffort[]),
    defaultEffort: supported ? "max" : null,
    model: model.length > 0 ? model : null,
  })
}

/**
 * Create the shared Answer run entry: resolve what the caller injected,
 * connect the retrieval stack's searcher factory to the route stack's runner,
 * and wrap that runner in the observer, budget, cancellation and model-
 * snapshot behavior one Answer run owes every consumer. The routing,
 * retrieval, Critic/Replan and single-terminal logic themselves run inside the
 * two stacks — this function never composes them directly.
 */
export async function createSharedAnswerEntry(
  options: SharedAnswerEntryOptions
): Promise<SharedAnswerEntry> {
  const { config: cfg, answerRuntime } = options

  const { chatClient, embeddingClient, elasticsearch, db } =
    answerRuntime.processRuntime
  const conversationStore =
    options.conversationStore ?? new SqliteConversationStore(db)
  // Ticket 49 (ARCH-01B): everything about HOW a run reads the knowledge base
  // — the dedicated reranker, the search operations, the optional evidence
  // channels and the per-assistant rerank-free variant — lives in the
  // retrieval stack. The entry keeps only what callers observe.
  const retrieval = createAnswerRetrievalStack({
    config: cfg,
    db,
    elasticsearch,
    embeddingClient,
    ...(options.searchOperations
      ? { searchOperations: options.searchOperations }
      : {}),
    ...(options.reranker ? { reranker: options.reranker } : {}),
    ...(options.attachments ? { attachments: options.attachments } : {}),
    ...(options.faq ? { faq: options.faq } : {}),
    ...(options.web ? { web: options.web } : {}),
    // LO-12: the same runtime instance observes rerank calls made by retrieval.
    ...(answerRuntime.tracing ? { tracing: answerRuntime.tracing } : {}),
  })
  const searchOperations = retrieval.searchOperations
  const handoffStore = options.handoffStore ?? new SqliteHandoffStore(db)

  // Ticket 51 (ARCH-01D): everything about HOW a run routes and produces its
  // answer — the router, the four runners, the single dispatch, the FAQ/memory/
  // workflow wrappers and (ticket 52, ARCH-01E) the tool registry and MCP
  // bridge — lives in the route stack. The entry keeps only what a caller
  // observes.
  const { runner, mcpStatus, mcp } = await createAnswerRouteStack({
    config: cfg,
    answerModelClient: chatClient,
    db,
    createSearcher: retrieval.createSearcher,
    conversationStore,
    handoffStore,
    ...(options.streamDirectReply
      ? { streamDirectReply: options.streamDirectReply }
      : {}),
    ...(options.faq ? { faq: options.faq } : {}),
    ...(options.memories ? { memories: options.memories } : {}),
    ...(options.suggestions ? { suggestions: options.suggestions } : {}),
  })

  // Observer fanout (T06 §5.3 order): traceObserver (hard) first, then the
  // Langfuse observer when Real, then any injected observers (evaluation).
  const observers: AnswerRunObserver[] = []
  if (shouldAttachLangfuseObserver(options.legacyLangfuseObserver, answerRuntime.langfuseExporter)) {
    observers.push(langfuseObserver(answerRuntime.langfuseExporter))
  }
  if (options.observers) {
    observers.push(...options.observers)
  }

  // Ticket 01: injectable seam only — normal chat keeps the exact HEAD
  // behavior (DEFAULT_RUN_BUDGET_MS). Reading cfg.answerRunBudgetMs here
  // would be an undeclared behavior change for this prefactor ticket.
  const budgetMs = options.budgetMs ?? DEFAULT_RUN_BUDGET_MS
  const resourceBudget =
    options.resourceBudget !== undefined
      ? options.resourceBudget
      : resourceBudgetFromConfig(cfg)

  // Ticket 17 (MODEL-01B): resolve this entry's model profile ONCE, from the
  // config/reranker it was composed with — never from a request, and never by
  // mutating the shared configuration. Every terminal event this entry emits
  // carries the same frozen snapshot, so a persisted run trace (and the
  // references it contains) stays traceable to the exact models that produced
  // it even when other entries with different profiles run concurrently
  // (evaluation tasks compose their own entries from per-task config copies).
  const modelProfile: AnswerModelProfileSnapshot = Object.freeze({
    chatModel: cfg.openaiChatModel,
    rerankModel: retrieval.rerankModel,
    embeddingProfile: knowledgeBaseEmbeddingProfile(
      cfg.embeddingModel,
      cfg.embeddingDimensions
    ),
  })
  // The adapter notifies the trace observer with the ORIGINAL event object
  // BEFORE yielding it, so the persistence path gets its own stamped copy:
  // wrap whichever hard observer was injected and stamp its done events too.
  const stampDoneResult = (result: AnswerRunResult): AnswerRunResult => ({
    ...result,
    modelProfile,
    // Ticket 35 (TOOL-01B): the MCP discovery state rides EVERY terminal —
    // both the persisted run trace and the transport copy — so trace readers
    // see whether MCP tools were live.
    ...(mcpStatus ? { mcp: mcpStatus() } : {}),
  })
  const baseTraceObserver = options.traceObserver ?? answerRuntime.traceRepository
  const traceObserver: AnswerRunObserver = {
    onEvent: (event) => {
      baseTraceObserver.onEvent(
        event.type === "done"
          ? { ...event, result: stampDoneResult(event.result) }
          : event
      )
    },
  }

  const eventsSource = createMastraChatEventAdapter({
    runner,
    traceObserver,
    observers,
    budgetMs,
    resourceBudget,
  })

  async function* stampedEventsSource(
    message: string,
    runOptions: AnswerRunOptions
  ): AsyncIterable<AnswerRunEvent> {
    for await (const event of eventsSource(message, runOptions)) {
      yield event.type === "done"
        ? { ...event, result: stampDoneResult(event.result) }
        : event
    }
  }

  return {
    eventsSource: stampedEventsSource,
    reasoningCapability: resolveReasoningCapability(cfg),
    searchOperations,
    ...(mcp ? { mcp } : {}),
  }
}
