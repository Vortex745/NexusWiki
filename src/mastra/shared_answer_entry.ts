/**
 * Eval refactor Ticket 01 — Shared Answer run entry.
 *
 * Extracts the composition that `src/index.ts` (the process composition
 * root) previously performed inline: production routing (direct / simple /
 * complex / ambiguous), retrieval, Critic/Replan, single-terminal logic,
 * observer fanout, and run budgets — assembled into ONE callable event
 * source.
 *
 * Two consumers, one implementation:
 *   - Normal chat: `src/index.ts` wires the returned `eventsSource` through
 *     the Mastra runtime boundary into the HTTP server — behavior identical
 *     to the previous inline composition.
 *   - Evaluation (later tickets): calls the same factory with injected
 *     isolated repositories (conversation store, search operations, handoff
 *     store, trace observer) and additional observers — WITHOUT duplicating
 *     the QA implementation and WITHOUT any HTTP handler dependency.
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
import { OpenAIAnswerModel } from "../answer/generation"
import type { ConversationStore } from "../answer/conversation_store"
import { SqliteConversationStore } from "../answer/conversation_store"
import type { HandoffStore } from "../answer/handoff_store"
import { SqliteHandoffStore } from "../answer/handoff_store"
import { ContextualizerImpl } from "../answer/contextualizer"
import { SummarizerImpl } from "../answer/summarizer"
import { ContextCompressorImpl } from "../answer/context_compressor"
import {
  langfuseObserver,
  NoopLangfuseExporter,
} from "../answer/langfuse_exporter"
import { RouterImpl } from "../retrieval/router/router"
import {
  RuntimeSearchOperations,
  SearcherImpl,
  type SearchOperations,
} from "../retrieval/search/searcher"
import {
  createDedicatedReranker,
  type Reranker,
} from "../retrieval/search/dedicated_reranker"
import { ContextAssemblerImpl } from "../retrieval/context/assembler"
import { PlannerImpl } from "../retrieval/planner/planner"
import { ComplexLoopControllerImpl } from "../retrieval/complex_loop"
import { ToolSelectorImpl } from "../retrieval/tool_selector"
import { ValidatorImpl } from "../critic/validator/validator"
import { RePlannerImpl } from "../critic/replanner/replanner"
import { PageIndexRepository } from "../ingestion/tracking/page_index_repo"
import { ActiveVersionRepository } from "../ingestion/tracking/active_version_repo"
import {
  createModelCostEstimator,
  DEFAULT_RUN_BUDGET_MS,
  type RunResourceBudgetOptions,
} from "../runtime/run_context"
import type { AccessContext } from "../access/context"
import type { AgentMessage, AnswerRunEvent } from "../types"
import { createMastraChatEventAdapter } from "./chat_event_adapter"
import {
  createDirectAmbiguousMastraRunner,
  type DirectReplyStream,
} from "./direct_ambiguous_runner"
import { createDirectReplyStream } from "./direct_reply_stream"
import { createMastraMemoryAdapter } from "./memory_adapter"
import { createSimpleKnowledgeMastraRunner } from "./simple_knowledge_runner"
import { createComplexKnowledgeMastraRunner } from "./complex_knowledge_runner"
import { createRouteDispatchRunner } from "./route_dispatch_runner"
import { createMastraWorkflowRunner } from "./workflow_runner"

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
   * Direct-route LLM stream seam. Default: the production
   * `createDirectReplyStream` agent (model from config).
   */
  streamDirectReply?: DirectReplyStream
  /** Whole-run deadline budget. Default: DEFAULT_RUN_BUDGET_MS / config. */
  budgetMs?: number
  /** Whole-run aggregate model call/token/cost limits. Default: from config. */
  resourceBudget?: RunResourceBudgetOptions
}

export interface SharedAnswerEntry {
  /** The single shared Answer run entry (transport-agnostic). */
  eventsSource: SharedAnswerEventsSource
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
 * Create the shared Answer run entry. The composition executes the
 * production direct/simple/complex/ambiguous routing, retrieval,
 * Critic/Replan, and single-terminal logic via the route-dispatch runner,
 * wrapped by the Mastra workflow runner and the chat event adapter
 * (observer fanout + budgets + cancellation).
 */
export async function createSharedAnswerEntry(
  options: SharedAnswerEntryOptions
): Promise<SharedAnswerEntry> {
  const { config: cfg, answerRuntime } = options

  const { chatClient, embeddingClient, elasticsearch, db } =
    answerRuntime.processRuntime
  const conversationStore =
    options.conversationStore ?? new SqliteConversationStore(db)
  // Ticket 03: the dedicated reranker is shared by normal chat and evaluation.
  // No key configured → undefined → retrieval degrades visibly
  // (`rerank.reason = "not_configured"`), never a different scorer.
  const reranker =
    options.reranker ??
    createDedicatedReranker({
      baseUrl: cfg.rerankBaseUrl,
      apiKey: cfg.rerankApiKey,
      model: cfg.rerankModel,
      timeoutMs: cfg.rerankTimeoutMs,
      maxDocumentChars: cfg.rerankMaxDocumentChars,
    })
  const searchOperations =
    options.searchOperations ??
    new RuntimeSearchOperations({
      es: elasticsearch,
      embeddingClient,
      embeddingModel: cfg.embeddingModel,
      pageIndexRepo: new PageIndexRepository(db),
      activeVersionRepo: new ActiveVersionRepository(db),
      ...(reranker ? { reranker } : {}),
    })
  const handoffStore = options.handoffStore ?? new SqliteHandoffStore(db)
  const resolveTenantId = (accessContext: AccessContext) =>
    accessContext.tenantId

  const router = new RouterImpl(chatClient, cfg.openaiChatModel)
  const streamDirectReply =
    options.streamDirectReply ??
    (await createDirectReplyStream({
      model: cfg.openaiChatModel,
      apiKey: cfg.openaiApiKey,
      ...(cfg.openaiBaseUrl ? { baseURL: cfg.openaiBaseUrl } : {}),
      timeout: cfg.openaiRequestTimeoutMs,
      maxRetries: cfg.openaiMaxRetries,
    }))
  // Ticket 10 — Conversation Memory adapter (pass-through to the injected
  // ConversationStore).
  const memoryAdapter = createMastraMemoryAdapter({ conversationStore })
  const summarizer = new SummarizerImpl(chatClient, cfg.openaiChatModel)

  // Ticket 09 — direct + ambiguous route runner (no Handoff by design).
  const directAmbiguousRunner = createDirectAmbiguousMastraRunner({
    router,
    streamDirectReply,
    conversationStore,
    resolveTenantId,
    memoryAdapter,
    summarizer,
  })

  // The Mastra runners reuse the existing retrieval, validation, memory,
  // handoff, and summarization components (production implementations).
  const answerModel = new OpenAIAnswerModel(chatClient, cfg.openaiChatModel)
  const contextualizer = new ContextualizerImpl(chatClient, cfg.openaiChatModel)
  const simpleRunner = createSimpleKnowledgeMastraRunner({
    router,
    createSearcher: () => new SearcherImpl(searchOperations),
    assembler: new ContextAssemblerImpl(),
    validator: new ValidatorImpl(chatClient, cfg.openaiChatModel),
    replanner: new RePlannerImpl(),
    streamAnswerDraft: (messages: AgentMessage[], signal: AbortSignal) =>
      answerModel.stream(messages, signal),
    toolSelector: new ToolSelectorImpl(chatClient, cfg.openaiChatModel),
    conversationStore,
    contextualizer,
    summarizer,
    compressor: new ContextCompressorImpl(chatClient, cfg.openaiChatModel),
    handoffStore,
    resolveTenantId,
  })

  // Ticket 12 — complex knowledge route runner (bounded LLM retrieval loop
  // with planner fallback).
  const complexLoopController = new ComplexLoopControllerImpl(
    chatClient,
    cfg.openaiChatModel
  )
  const planner = new PlannerImpl(chatClient, cfg.openaiChatModel)
  const complexRunner = createComplexKnowledgeMastraRunner({
    router,
    createSearcher: () => new SearcherImpl(searchOperations),
    assembler: new ContextAssemblerImpl(),
    validator: new ValidatorImpl(chatClient, cfg.openaiChatModel),
    replanner: new RePlannerImpl(),
    streamAnswerDraft: (messages: AgentMessage[], signal: AbortSignal) =>
      answerModel.stream(messages, signal),
    planner,
    complexLoopController,
    conversationStore,
    contextualizer,
    summarizer,
    compressor: new ContextCompressorImpl(chatClient, cfg.openaiChatModel),
    handoffStore,
    resolveTenantId,
  })

  // Ticket 11 + Ticket 12 — route dispatch composes all four routes into a
  // single route-aware MastraRunner with one authoritative route decision.
  const dispatchRunner = createRouteDispatchRunner({
    router,
    simpleRunner,
    directAmbiguousRunner,
    complexRunner,
    conversationStore,
    contextualizer,
    resolveTenantId,
  })
  const runner = await createMastraWorkflowRunner(dispatchRunner)

  // Observer fanout (T06 §5.3 order): traceObserver (hard) first, then the
  // Langfuse observer when Real, then any injected observers (evaluation).
  const observers: AnswerRunObserver[] = []
  if (!(answerRuntime.langfuseExporter instanceof NoopLangfuseExporter)) {
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

  const eventsSource = createMastraChatEventAdapter({
    runner,
    traceObserver: options.traceObserver ?? answerRuntime.traceRepository,
    observers,
    budgetMs,
    resourceBudget,
  })

  return { eventsSource }
}
