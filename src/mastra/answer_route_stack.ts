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
 * It also owns the read-only capability layer (tickets 34/35, moved here by
 * ARCH-01E): the built-in tool registry over the caller's db handle and the MCP
 * capability discovery that registers into the SAME registry, so a tool call
 * keeps its schema validation, allowlist, deadline, cancellation and trace
 * records wherever the run is composed. What leaves this module is two values:
 * `mcpStatus` (visibility — it rides a terminal even when nothing was
 * discovered) and `mcp` (the callable seam — only when a tool was discovered).
 * Discovery failure is a visible degradation, never a broken run.
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
import { ClefRouter } from "../retrieval/router/clef_router"
import { executeDecisionCall } from "../runtime/decision_call"
import type { SearcherImpl } from "../retrieval/search/searcher"
import { ContextAssemblerImpl } from "../retrieval/context/assembler"
import { PlannerImpl } from "../retrieval/planner/planner"
import { ComplexLoopControllerImpl } from "../retrieval/complex_loop"
import { ToolSelectorImpl } from "../retrieval/tool_selector"
import { ValidatorImpl } from "../critic/validator/validator"
import { RePlannerImpl } from "../critic/replanner/replanner"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
import type { AgentMessage } from "../types"
import type { AssistantRunSnapshot } from "../assistants/assistant_service"
import type { FaqEntryService } from "../faq/faq_entry_service"
import type { LongTermMemoryStore } from "../memory/long_term_memory_store"
import type { MemorySuggestionStore } from "../memory/memory_suggestion_store"
import type { DB } from "../ingestion/tracking/db"
import { PageIndexRepository } from "../ingestion/tracking/page_index_repo"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import {
  ToolRegistry,
  ToolInvocationService,
  type ToolInvocationResult,
} from "../tools/invocation"
import { registerBuiltinTools } from "../tools/knowledge_tools"
import { createMcpToolBridge, type McpToolBridge } from "../mcp/tool_bridge"
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

/** The safe discovery snapshot the bridge reports (no credentials, no URLs). */
export type AnswerMcpStatus = ReturnType<McpToolBridge["status"]>

/**
 * Ticket 35 (TOOL-01B): the product-level MCP capability invocation seam — the
 * SAME boundary the runs use (allowlist = the discovered tools, 30s deadline,
 * bounded trace records). Undefined means "no MCP tools", never a broken run.
 */
export interface AnswerMcpCapabilities {
  status(): AnswerMcpStatus
  invoke(name: string): Promise<ToolInvocationResult>
}

export interface AnswerRouteStackContext {
  /** Read for the chat model, the direct-reply agent and the MCP policy. */
  config: AppConfig
  /** Shared Chat client for generation and the optional Chat route provider. */
  answerModelClient: OpenAI
  /** Process db: the read-only document/PageIndex lookups behind the tools. */
  db: DB
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
}

export interface AnswerRouteStack {
  /**
   * The dispatch runner with its boundary behavior already composed: workflow
   * outside the FAQ gate, FAQ gate outside memory recall, memory recall
   * outside dispatch. This is the only runner the shared entry adapts.
   */
  runner: MastraRunner
  /**
   * MCP discovery state, present whenever a bridge composed — including a
   * connected bridge that discovered no tools. The entry stamps it onto every
   * terminal so trace readers see whether MCP tools were live.
   */
  mcpStatus?: () => AnswerMcpStatus
  /** The invocation seam, present only when the bridge discovered tools. */
  mcp?: AnswerMcpCapabilities
}

export async function createAnswerRouteStack(
  context: AnswerRouteStackContext
): Promise<AnswerRouteStack> {
  const { config: cfg, answerModelClient: chatClient } = context
  const { conversationStore, handoffStore, createSearcher, db } = context
  const resolveTenantId = (accessContext: AccessContext) =>
    accessContext.tenantId

  const router = cfg.decisionProvider === "clef"
    ? new ClefRouter({
      accountId: cfg.cloudflareAccountId ?? "",
      apiToken: cfg.cloudflareApiToken ?? "",
      timeoutMs: cfg.decisionRequestTimeoutMs ?? 10_000,
      execute: executeDecisionCall,
    })
    : new RouterImpl(chatClient, cfg.openaiChatModel)
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
  // Ticket 34 (TOOL-01A): the built-in read-only tool registry. Tool calls
  // of the complex route execute through the schema-validated invocation
  // boundary, allowlisted by the run's assistant tool policy; document
  // lookups check tenant, scope and group visibility against the run.
  //
  // This position is load-bearing, not stylistic: MCP discovery spawns a stdio
  // child, so it must stay AFTER the direct-reply agent construction that
  // precedes it in the pre-split entry. Hoisting it to the top of this function
  // would spawn that child on a composition that then aborts, with no handle to
  // close it.
  const toolRegistry = registerBuiltinTools(new ToolRegistry(), {
    db,
    documentRepo: new DocumentRepo(db),
    // Read-only lookups over the same db the retrieval stack searches.
    pageIndexRepo: new PageIndexRepository(db),
  })
  // Ticket 35 (TOOL-01B): discover the local read-only MCP capability server
  // and register its status tools through the SAME boundary. A failed
  // discovery leaves no MCP tools and chat unchanged — never a broken run.
  const mcpBridge: McpToolBridge | null = await createMcpToolBridge({
    registry: toolRegistry,
    config: cfg,
  }).catch((error: unknown) => {
    // Ticket 35: a broken bridge must be VISIBLE but never fatal — ordinary
    // knowledge-base chat runs without MCP tools.
    console.warn(
      "[mcp] capability bridge failed to compose (chat runs without MCP tools):",
      error instanceof Error ? error.message : String(error)
    )
    return null
  })
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
    toolRegistry,
    // Ticket 35 (TOOL-01B): discovered MCP tools join the read-only allowlist.
    ...(mcpBridge && mcpBridge.toolNames().length > 0
      ? { mcpToolNames: mcpBridge.toolNames() }
      : {}),
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

  // Ticket 35 (TOOL-01B): the invocation seam the capabilities router exposes.
  // It is the SAME ToolInvocationService boundary the complex loop runs tools
  // through — the same allowlist, deadline, trace records and budget — so a
  // tool caller gets no second Answer entry and no bypass around route,
  // observer or budget handling.
  const mcpCapabilityInvoker =
    mcpBridge && mcpBridge.toolNames().length > 0
      ? new ToolInvocationService({
          registry: toolRegistry,
          allowedTools: mcpBridge.toolNames(),
        })
      : undefined

  return {
    runner,
    ...(mcpBridge ? { mcpStatus: () => mcpBridge.status() } : {}),
    ...(mcpBridge && mcpCapabilityInvoker
      ? {
          mcp: {
            status: () => mcpBridge.status(),
            invoke: (name: string) =>
              mcpCapabilityInvoker.invoke(name, {}, {
                accessContext: singleTenantAccessContext(),
              }),
          },
        }
      : {}),
  }
}
