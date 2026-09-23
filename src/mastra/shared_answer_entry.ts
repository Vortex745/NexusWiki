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
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import {
  createModelCostEstimator,
  DEFAULT_RUN_BUDGET_MS,
  type RunResourceBudgetOptions,
} from "../runtime/run_context"
import type { AccessContext } from "../access/context"
import type { AgentMessage, AnswerRunEvent } from "../types"
import type { AnswerModelProfileSnapshot } from "../types/answer"
import type { AttachmentSearchOperations } from "../types/retrieval"
import { knowledgeBaseEmbeddingProfile } from "../types/knowledge_base"
import { createMastraChatEventAdapter } from "./chat_event_adapter"
import type { AssistantRunSnapshot } from "../assistants/assistant_service"
import type { FaqEntryService } from "../faq/faq_entry_service"
import { createFaqEvidenceOperations } from "../faq/faq_evidence"
import { createFaqExactMatchRunner } from "./faq_exact_runner"
import type { LongTermMemoryStore } from "../memory/long_term_memory_store"
import type { MemorySuggestionStore } from "../memory/memory_suggestion_store"
import { createMemoryRecallRunner } from "./memory_recall_runner"
import { ToolRegistry } from "../tools/invocation"
import { registerBuiltinTools } from "../tools/knowledge_tools"
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
}

export interface SharedAnswerEntry {
  /** The single shared Answer run entry (transport-agnostic). */
  eventsSource: SharedAnswerEventsSource
  /**
   * Ticket 14 (RET-01): the SAME search operations chat uses (same clients,
   * same dedicated reranker) — the retrieval-debug endpoint builds its
   * Searcher from this so debug and chat share configuration and
   * implementation. Stateless beyond its clients; a new SearcherImpl per run
   * is exactly what the chat runners do.
   */
  searchOperations: SearchOperations
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
  const pageIndexRepo = new PageIndexRepository(db)
  const activeVersionRepo = new ActiveVersionRepository(db)
  const searchOperations =
    options.searchOperations ??
    new RuntimeSearchOperations({
      es: elasticsearch,
      embeddingClient,
      embeddingModel: cfg.embeddingModel,
      pageIndexRepo,
      activeVersionRepo,
      ...(reranker ? { reranker } : {}),
    })
  // Ticket 19 (AST-01B): the rerank-free variant — an assistant whose
  // immutable snapshot pins `rerankModelProfileId: null` runs WITHOUT the
  // dedicated reranker (fused order + explicit reason), never with it. Only
  // derivable when this entry built its own operations; injected operations
  // (evaluation scopes) never carry assistant overlays.
  // Ticket 31 (FAQ-01B): both searcher variants share the FAQ evidence
  // channel; optional params accept undefined explicitly.
  const faqEvidence = options.faq
    ? createFaqEvidenceOperations(options.faq)
    : undefined
  const buildSearcher = (operations: SearchOperations) =>
    new SearcherImpl(operations, options.attachments, faqEvidence)
  const searchOperationsWithoutRerank = options.searchOperations
    ? undefined
    : new RuntimeSearchOperations({
        es: elasticsearch,
        embeddingClient,
        embeddingModel: cfg.embeddingModel,
        pageIndexRepo,
        activeVersionRepo,
      })
  const searcherOperationsFor = (assistant?: AssistantRunSnapshot) =>
    assistant?.rerankModelProfileId === null && searchOperationsWithoutRerank
      ? searchOperationsWithoutRerank
      : searchOperations
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
    createSearcher: (assistant) =>
      buildSearcher(searcherOperationsFor(assistant)),
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
  // Ticket 34 (TOOL-01A): the built-in read-only tool registry. Tool calls
  // of the complex route execute through the schema-validated invocation
  // boundary, allowlisted by the run's assistant tool policy; document
  // lookups check tenant, scope and group visibility against the run.
  const toolRegistry = registerBuiltinTools(new ToolRegistry(), {
    documentRepo: new DocumentRepo(db),
    pageIndexRepo,
  })
  const complexRunner = createComplexKnowledgeMastraRunner({
    router,
    createSearcher: (assistant) =>
      buildSearcher(searcherOperationsFor(assistant)),
    assembler: new ContextAssemblerImpl(),
    validator: new ValidatorImpl(chatClient, cfg.openaiChatModel),
    replanner: new RePlannerImpl(),
    streamAnswerDraft: (messages: AgentMessage[], signal: AbortSignal) =>
      answerModel.stream(messages, signal),
    planner,
    complexLoopController,
    // Ticket 34 (TOOL-01A): the schema-validated tool boundary.
    toolRegistry,
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
  // Ticket 31 (FAQ-01B): the exact-FAQ gate sits in front of routing — a
  // unique normalized match publishes the stored standard answer without a
  // model call, while everything else runs the normal routes unchanged.
  // Ticket 33 (MEM-01B): memory recall + suggestion extraction wrap the
  // routes INSIDE the FAQ gate — a direct standard answer needs neither.
  const runner = await createMastraWorkflowRunner(
    createFaqExactMatchRunner(
      {
        ...(options.faq ? { faq: options.faq } : {}),
        conversationStore,
        resolveTenantId,
      },
      createMemoryRecallRunner(
        {
          ...(options.memories ? { memories: options.memories } : {}),
          ...(options.suggestions ? { suggestions: options.suggestions } : {}),
          resolveTenantId,
        },
        dispatchRunner
      )
    )
  )

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

  // Ticket 17 (MODEL-01B): resolve this entry's model profile ONCE, from the
  // config/reranker it was composed with — never from a request, and never by
  // mutating the shared configuration. Every terminal event this entry emits
  // carries the same frozen snapshot, so a persisted run trace (and the
  // references it contains) stays traceable to the exact models that produced
  // it even when other entries with different profiles run concurrently
  // (evaluation tasks compose their own entries from per-task config copies).
  const modelProfile: AnswerModelProfileSnapshot = Object.freeze({
    chatModel: cfg.openaiChatModel,
    rerankModel: reranker?.model ?? null,
    embeddingProfile: knowledgeBaseEmbeddingProfile(
      cfg.embeddingModel,
      cfg.embeddingDimensions
    ),
  })
  // The adapter notifies the trace observer with the ORIGINAL event object
  // BEFORE yielding it, so the persistence path gets its own stamped copy:
  // wrap whichever hard observer was injected and stamp its done events too.
  const baseTraceObserver = options.traceObserver ?? answerRuntime.traceRepository
  const traceObserver: AnswerRunObserver = {
    onEvent: (event) => {
      baseTraceObserver.onEvent(
        event.type === "done"
          ? { ...event, result: { ...event.result, modelProfile } }
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
        ? { ...event, result: { ...event.result, modelProfile } }
        : event
    }
  }

  return { eventsSource: stampedEventsSource, searchOperations }
}
