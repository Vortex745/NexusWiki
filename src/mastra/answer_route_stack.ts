/**
 * Ticket 51 (ARCH-01D) — the Answer route stack.
 *
 * `createSharedAnswerEntry` is the one composition seam chat and evaluation
 * share. This module owns the part of it that answers "how does a run decide
 * and produce its answer": the router, the direct/simple/complex/ambiguous
 * runners, the single dispatch that publishes one authoritative route
 * decision, and the three wrappers that give that dispatch its boundary
 * behavior — the FAQ exact-match gate, the owner-scoped memory recall runner
 * and the Mastra workflow that makes cancellation real.
 *
 * Like the retrieval stack, it takes a narrow context of already-resolved
 * collaborators rather than the entry's options object, and it is async only
 * because the production direct-reply agent is constructed here. The entry
 * keeps everything a caller observes: observer fanout, budgets, cancellation,
 * the frozen model snapshot and the terminal-event stamping. Which components
 * answer a query is invisible behind one value — `runner`.
 *
 * Ordering inside this module is load-bearing and deliberate (T06 §5.3,
 * tickets 31 and 33): the workflow wraps the FAQ gate, and the FAQ gate wraps
 * memory recall, which wraps dispatch. A unique normalized FAQ match therefore
 * answers without a model call and without recalling or extracting memory;
 * everything else runs the ordinary routes with memory in the system prompt.
 *
 * Boundary (T02 #5): lives in src/mastra/* and MUST NOT import `src/api/*`,
 * `src/evaluation/*` or `src/index`.
 */

import type OpenAI from "openai"
import type { AppConfig } from "../config"
import { OpenAIAnswerModel } from "../answer/generation"
import type { ConversationStore } from "../answer/conversation_store"
import type { HandoffStore } from "../answer/handoff_store"
import { ContextualizerImpl } from "../answer/contextualizer"
import { SummarizerImpl } from "../answer/summarizer"
import { ContextCompressorImpl } from "../answer/context_compressor"
import { RouterImpl } from "../retrieval/router/router"
import type { SearcherImpl } from "../retrieval/search/searcher"
import { ContextAssemblerImpl } from "../retrieval/context/assembler"
import { PlannerImpl } from "../retrieval/planner/planner"
import { ComplexLoopControllerImpl } from "../retrieval/complex_loop"
import { ToolSelectorImpl } from "../retrieval/tool_selector"
import { ValidatorImpl } from "../critic/validator/validator"
import { RePlannerImpl } from "../critic/replanner/replanner"
import type { AccessContext } from "../access/context"
import type { AgentMessage } from "../types"
import type { AssistantRunSnapshot } from "../assistants/assistant_service"
import type { FaqEntryService } from "../faq/faq_entry_service"
import type { LongTermMemoryStore } from "../memory/long_term_memory_store"
import type { MemorySuggestionStore } from "../memory/memory_suggestion_store"
import type { ToolRegistry } from "../tools/invocation"
import type { MastraRunner } from "./chat_event_adapter"
import { createFaqExactMatchRunner } from "./faq_exact_runner"
import { createMemoryRecallRunner } from "./memory_recall_runner"
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
 * The tool boundary the complex route executes through. Ticket 51 keeps its
 * construction in the entry; ticket 52 (ARCH-01E) moves it behind this stack.
 */
export interface AnswerRouteStackTooling {
  toolRegistry: ToolRegistry
  /** Discovered MCP tool names, when the capability bridge composed. */
  mcpToolNames?: string[]
}

export interface AnswerRouteStackContext {
  /** Read for the chat model and the direct-reply agent's credentials only. */
  config: AppConfig
  /** The shared chat client every router, planner, critic and generator uses. */
  answerModelClient: OpenAI
  /**
   * The retrieval stack's searcher factory — the only thing a knowledge route
   * needs to know about retrieval.
   */
  createSearcher: (assistant?: AssistantRunSnapshot) => SearcherImpl
  conversationStore: ConversationStore
  handoffStore: HandoffStore
  /**
   * Direct-route LLM stream seam. Default: the production
   * `createDirectReplyStream` agent (model from config).
   */
  streamDirectReply?: DirectReplyStream
  /** Ticket 31 (FAQ-01B): the exact-match gate in front of ordinary routing. */
  faq?: FaqEntryService
  /** Ticket 33 (MEM-01B): the owner-scoped recall and suggestion stores. */
  memories?: LongTermMemoryStore
  suggestions?: MemorySuggestionStore
  tooling: AnswerRouteStackTooling
}

export interface AnswerRouteStack {
  /**
   * The dispatch runner with its boundary behavior already composed: workflow
   * outside the FAQ gate, FAQ gate outside memory recall, memory recall
   * outside dispatch. This is the only runner the shared entry adapts.
   */
  runner: MastraRunner
}

export async function createAnswerRouteStack(
  context: AnswerRouteStackContext
): Promise<AnswerRouteStack> {
  const { config: cfg, answerModelClient: chatClient } = context
  const { conversationStore, handoffStore, createSearcher, tooling } = context
  const resolveTenantId = (accessContext: AccessContext) =>
    accessContext.tenantId

  const router = new RouterImpl(chatClient, cfg.openaiChatModel)
  const streamDirectReply =
    context.streamDirectReply ??
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
    createSearcher,
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
    createSearcher,
    assembler: new ContextAssemblerImpl(),
    validator: new ValidatorImpl(chatClient, cfg.openaiChatModel),
    replanner: new RePlannerImpl(),
    streamAnswerDraft: (messages: AgentMessage[], signal: AbortSignal) =>
      answerModel.stream(messages, signal),
    planner,
    complexLoopController,
    // Ticket 34 (TOOL-01A): the schema-validated tool boundary.
    toolRegistry: tooling.toolRegistry,
    // Ticket 35 (TOOL-01B): discovered MCP tools join the read-only allowlist.
    ...(tooling.mcpToolNames ? { mcpToolNames: tooling.mcpToolNames } : {}),
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
        ...(context.faq ? { faq: context.faq } : {}),
        conversationStore,
        resolveTenantId,
      },
      createMemoryRecallRunner(
        {
          ...(context.memories ? { memories: context.memories } : {}),
          ...(context.suggestions
            ? { suggestions: context.suggestions }
            : {}),
          resolveTenantId,
        },
        dispatchRunner
      )
    )
  )

  return { runner }
}
