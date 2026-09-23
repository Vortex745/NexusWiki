import express from "express"
import cors from "cors"
import type { Server } from "node:http"
import type { RequestHandler } from "express"
import { readFile } from "node:fs/promises"
import { extname, join, resolve } from "node:path"
import type { DB } from "../ingestion/tracking/db"
import { openDb } from "../ingestion/tracking/db"
import { AnswerTraceRepository } from "../answer/trace_repository"
import { loadConfig } from "../config"
import { createProcessRuntime, type ProcessRuntime } from "../runtime/process_runtime"
import { createChatRouter, type AnswerEventsSource } from "./chat"
import ingestRouter, { rawIngestRouter } from "./ingest"
import { createHandoffRouter } from "./handoff"
import { SqliteHandoffStore } from "../answer/handoff_store"
import { createFeedbackRouter } from "./feedback"
import { createFeedbackTargetResolver } from "../answer/feedback_target"
import { SqliteFeedbackStore } from "../answer/feedback_store"
import { SqliteSessionBinder } from "../access/session_binder"
import { createAccessMiddleware } from "./access_middleware"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import { PageIndexRepository } from "../ingestion/tracking/page_index_repo"
import { TaskRepo } from "../ingestion/tracking/task_repo"
import { SqliteSourceLifecycleStore } from "../knowledge/source_lifecycle_store"
import { SqliteCandidateReviewStore } from "../knowledge/candidate_review_store"
import { RetirementServiceImpl } from "../knowledge/retirement"
import { createSourceGovernanceRouter } from "./source_governance"
import { createStatusRouter } from "./status"
import { createEvaluationsRouter } from "./evaluations"
import type { AccessContext } from "../access/context"
import { evalAssistantConfigDigest } from "../evaluation/assistant_snapshots"
import { createSessionRouter, type DemoAuthOptions } from "./session"
import { EvaluationService } from "../evaluation/service"
import { createDedicatedReranker } from "../retrieval/search/dedicated_reranker"
import {
  createRetrievalScopeResolver,
  type RetrievalScopeResolver,
} from "../retrieval/scope"
import {
  KnowledgeBaseServiceImpl,
  type KnowledgeBaseService,
} from "../knowledge/knowledge_base_service"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { knowledgeBaseEmbeddingProfile } from "../types/knowledge_base"
import { createKnowledgeBaseRouter } from "./knowledge_bases"
import { createDocumentsRouter, createEsChunkReader } from "./documents"
import { createRetrievalDebugRouter } from "./retrieval_debug"
import { createModelProfilesRouter } from "./model_profiles"
import { createAssistantsRouter } from "./assistants"
import { createConversationsRouter } from "./conversations"
import { createMemoriesRouter } from "./memories"
import { LongTermMemoryStore } from "../memory/long_term_memory_store"
import { createFaqEntriesRouter } from "./faq_entries"
import { FaqEntryServiceImpl } from "../faq/faq_entry_service"
import { SqliteFaqEntryRepo } from "../faq/faq_entry_repo"
import { createAttachmentsRouter } from "./attachments"
import { SqliteConversationHistoryStore } from "../answer/conversation_history_store"
import {
  AssistantService,
  InvalidAssistantCommandError,
} from "../assistants/assistant_service"
import { ModelProfileRegistry } from "../models/profiles"

export function createApp(options: {
  db?: DB
  imageAssetPath?: string
  accessMiddleware?: RequestHandler
  /**
   * Eval refactor Ticket 04: in-process evaluation service. Mounted only when
   * provided (tests exercising unrelated routes do not need it).
   */
  evaluationService?: EvaluationService
  /**
   * P5.2: Ingestion access middleware. Mounted on /api/ingest routes so the
   * same identity context enforced at the chat gate is also enforced before
   * any ingestion handler runs (closes D-007 debt #3). Only provided in
   * enforced mode; without it, ingestion handlers derive the deterministic
   * single-tenant context before persisting trusted access metadata.
   */
  ingestAccessMiddleware?: RequestHandler
  managementAccessMiddleware?: RequestHandler
  /**
   * Ticket 01: when set, the local demo sign-in is available — the browser can
   * exchange a demo account + password for a token through the server. Absent
   * in every non-demo deployment, where /api/auth/login answers 404.
   */
  demoAuth?: DemoAuthOptions
  sessionBinder?: SqliteSessionBinder
  /**
   * Ticket 05 (KB-03A): the server-side retrieval-scope resolver. startServer
   * always wires the production one (KnowledgeBaseServiceImpl + the tenant
   * database), so every production chat request runs inside a server-computed
   * knowledge scope. It is absent in bare createApp() mounts only: a request
   * that carries `knowledgeBaseIds` is then rejected rather than silently
   * widened to an unfiltered read.
   */
  retrievalScopeResolver?: RetrievalScopeResolver
  /**
   * Ticket 08 (KB-04): the knowledge-base service behind the workspace routes.
   * startServer always wires the production one — the SAME instance the
   * retrieval-scope resolver uses, so a base an admin just archived is refused
   * by the very next chat selection. Bare createApp() mounts build a local one
   * from the tenant database when omitted.
   */
  knowledgeBaseService?: KnowledgeBaseService
  /**
   * Ticket 14 (RET-01): the shared SearchOperations behind the retrieval-debug
   * endpoint. startServer receives chat's own operations (single retrieval
   * configuration); absent in bare createApp() mounts → the endpoint 503s.
   */
  searchOperations?: import("../retrieval/search/searcher").SearchOperations
  eventsSource: AnswerEventsSource
  // Optional runtime surfaces for the /api/status endpoint.
  // When omitted (e.g. tests), the status route is not mounted.
  processRuntime?: import("../runtime/process_runtime").ProcessRuntime
  config?: import("../config").AppConfig
  /** Ticket 16 (MODEL-01A): built-in model profiles; omitted → routes not mounted. */
  modelProfiles?: import("../models/profiles").ModelProfileRegistry
  /** Ticket 18 (AST-01A): assistant workspace service; omitted → routes not mounted. */
  assistants?: import("../assistants/assistant_service").AssistantService
  /** Ticket 20 (CONV-01A): server-owned conversation history; omitted → routes not mounted. */
  conversationHistory?: import("../answer/conversation_history_store").SqliteConversationHistoryStore
  /**
   * Ticket 22 (ATT-01): temporary session attachments; omitted → routes not
   * mounted and no run can read attachment evidence.
   */
  attachments?: import("../attachments/session_attachment_service").SessionAttachmentService
  /**
   * Ticket 32 (MEM-01A): the user-owned long-term memory store; omitted →
   * routes not mounted (bare mounts, probes).
   */
  memories?: import("../memory/long_term_memory_store").LongTermMemoryStore
}) {
  const app = express()
  const db = options.db || openDb()
  const traceRepository = new AnswerTraceRepository(db)
  const handoffStore = new SqliteHandoffStore(db)
  const feedbackStore = new SqliteFeedbackStore(db)
  // Ticket 29 (EVAL-02B): feedback is only accepted for a run this caller owns
  // and that already produced a terminal answer. Ownership is read from the
  // conversation directory — the run's trace is the only owner of its session.
  const sessionDirectories = new SqliteConversationHistoryStore(db)
  const feedbackTargetResolver = createFeedbackTargetResolver({
    getRun: (runId) => traceRepository.getRun(runId),
    ownsSession: (sessionId, tenantId, subjectId) =>
      sessionDirectories.getSessionLock(sessionId, tenantId, subjectId) !== null,
  })
  // Ticket 11 P5: Source governance wiring — DocumentRepo + TaskRepo are
  // shared with the ingestion pipeline (DocumentRepo.activate is reused by
  // CandidateReviewStore; TaskRepo is reused by RetirementService for
  // idempotent cleanup enqueue per spec L1577).
  const documentRepo = new DocumentRepo(db)
  const taskRepo = new TaskRepo(db)
  const sourceLifecycleStore = new SqliteSourceLifecycleStore(db)
  const candidateReviewStore = new SqliteCandidateReviewStore(db, documentRepo)
  const retirementService = new RetirementServiceImpl(db, sourceLifecycleStore, taskRepo)
  const imageAssetPath = resolve(
    options.imageAssetPath ?? process.env.IMAGE_ASSET_PATH ?? "./data/image-assets"
  )
  app.use(cors())
  app.get("/api/assets/:assetPath", async (req, res, next) => {
    const assetPath = String(req.params.assetPath)
    if (!/^[a-f0-9]{64}\.[a-z0-9]{1,10}$/.test(assetPath)) {
      res.sendStatus(404)
      return
    }
    try {
      const bytes = await readFile(join(imageAssetPath, assetPath))
      res.set("Cache-Control", "public, max-age=31536000, immutable")
      res.type(extname(assetPath))
      res.send(bytes)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        res.sendStatus(404)
        return
      }
      next(error)
    }
  })
  // P5.2: mount the ingestion access middleware BEFORE rawIngestRouter +
  // ingestRouter so the identity gate runs for every /api/ingest* route
  // (file, json, url). The middleware reads only the Authorization header,
  // so it is safe before express.json() and before the raw octet-stream
  // body parser. It is mounted in enforced mode; single-tenant handlers use
  // their deterministic context fallback when persisting access metadata.
  if (options.ingestAccessMiddleware) {
    app.use("/api/ingest", options.ingestAccessMiddleware)
  }
  app.use("/api", rawIngestRouter)
  app.use(express.json())
  // Ticket 05 follow-up wiring: mount access middleware (if provided) BEFORE
  // createChatRouter so res.locals.accessContext is populated for the session
  // binder. Ingestion uses its separate identity gate and trusted ACL propagation.
  if (options.accessMiddleware) {
    app.use("/api/chat", options.accessMiddleware)
    // Ticket 08 (KB-04): the same chat-scope identity gate guards the
    // knowledge-base workspace — browsing is for every authenticated member,
    // and the admin commands re-check the admin scope in-handler.
    app.use("/api/knowledge-bases", options.accessMiddleware)
    // Ticket 14 (RET-01): the retrieval-debug run is an authorized read —
    // same chat scope, same identity that constrains the channels.
    app.use("/api/retrieval-debug", options.accessMiddleware)
    // Ticket 18 (AST-01A): the assistant workspace — browsing is for every
    // authenticated member (group visibility applies), admin commands
    // re-check the admin scope in-handler.
    app.use("/api/assistants", options.accessMiddleware)
  }
  app.use(
    "/api",
    createChatRouter(
      traceRepository,
      options.eventsSource,
      options.sessionBinder,
      options.retrievalScopeResolver,
      // Ticket 19 (AST-01B): the chat transport resolves the assistant overlay
      // (prompt / bound scope / rerank binding) server-side per run.
      options.assistants,
      // Ticket 20 (CONV-01A): the transport appends user turns and assistant
      // terminal turns to the caller's server-owned directory.
      options.conversationHistory
    )
  )

  // Ticket 14 (RET-01): the read-only retrieval-debug run. Built from the
  // SHARED search operations (same clients + reranker as chat) and the SAME
  // scope resolver; absent operations (bare mounts) → 503.
  app.use(
    "/api",
    createRetrievalDebugRouter({
      searchOperations: options.searchOperations,
      retrievalScopeResolver: options.retrievalScopeResolver,
    })
  )
  // Ticket 08 (KB-04) + Ticket 11 (DOC-01A): ONE knowledge-base service shared
  // by the workspace routes and the document catalog (and, in startServer, by
  // the retrieval-scope resolver).
  const workspaceKnowledgeBaseService =
    options.knowledgeBaseService ??
    new KnowledgeBaseServiceImpl(
      new SqliteKnowledgeBaseRepo(db),
      knowledgeBaseEmbeddingProfile(
        options.config?.embeddingModel ?? "unspecified",
        options.config?.embeddingDimensions ?? 0
      )
    )
  app.use(
    "/api",
    createKnowledgeBaseRouter({ service: workspaceKnowledgeBaseService })
  )
  // Ticket 22 (ATT-01): the session attachment routes. They live under
  // /api/chat so they inherit the chat identity gate; promotion re-checks the
  // ingest capability in-handler and resolves its target base through the SAME
  // knowledge-base service the workspace uses.
  if (options.attachments) {
    app.use(
      "/api",
      createAttachmentsRouter(options.attachments, options.sessionBinder, workspaceKnowledgeBaseService)
    )
  }
  // Ticket 11 (DOC-01A): the knowledge-base document catalog. The chat-scope
  // identity middleware mounted at the /api/knowledge-bases prefix above also
  // guards this route; reader/admin visibility is resolved in-handler.
  app.use(
    "/api",
    createDocumentsRouter({
      documentRepo,
      knowledgeBaseService: workspaceKnowledgeBaseService,
      pageIndexRepo: new PageIndexRepository(db),
      // Ticket 13 (DOC-02): chunk reads need the shared Elasticsearch client —
      // absent in bare createApp() mounts (tests), where chunk views answer 503.
      ...(options.processRuntime
        ? { chunkReader: createEsChunkReader(options.processRuntime.elasticsearch, "kefu-rag-chunks") }
        : {}),
    })
  )
  // Ticket 30 (FAQ-01A): the FAQ management surface. Mounted only when the
  // server wires a knowledge-base resolver — the SAME resolver the chat path
  // uses, so an unknown knowledge base is a 404 and an archived one a 409
  // before any entry is read or written.
  if (options.retrievalScopeResolver) {
    app.use(
      "/api",
      createFaqEntriesRouter({
        faqEntries: new FaqEntryServiceImpl({ repo: new SqliteFaqEntryRepo(db) }),
        scopeResolver: options.retrievalScopeResolver,
      })
    )
  }
  if (options.managementAccessMiddleware) {
    app.use("/api/handoffs", options.managementAccessMiddleware)
    app.use("/api/sources", options.managementAccessMiddleware)
    // Ticket 04: evaluation tasks are identity-scoped like every other
    // management surface; the handler keeps its own admin check.
    app.use("/api/evaluations", options.managementAccessMiddleware)
    app.use("/api/evaluation-datasets", options.managementAccessMiddleware)
    // Ticket 29 (EVAL-02B): the feedback review surface is identity-scoped; the
    // handler enforces review-or-admin (a reader must not browse it).
    app.use("/api/feedback", options.managementAccessMiddleware)
    // Ticket 01: reading your own identity needs identity but no particular
    // scope — a reader must be able to learn its navigation from the server.
    app.use("/api/session", options.managementAccessMiddleware)
  }
  // Ticket 01: identity session + demo sign-in. /api/auth/* is deliberately
  // outside the identity middleware — you cannot be required to authenticate
  // in order to authenticate.
  app.use("/api", createSessionRouter(options.demoAuth ? { demoAuth: options.demoAuth } : {}))
  if (options.evaluationService) {
    app.use(
      "/api",
      createEvaluationsRouter(options.evaluationService, {
        // Ticket 28 (EVAL-02A): a stored assistant version resolves into the
        // immutable snapshot an evaluation task runs with. It is the SAME
        // version the chat path runs (prompt + rerank binding, pinned by
        // version), and the digest covers exactly those execution fields.
        ...(options.assistants
          ? {
              resolveAssistant: (
                context: AccessContext,
                assistantId: string,
                version: unknown
              ) => {
                const service = options.assistants!
                const assistant = service.get(assistantId, context.tenantId)
                if (!assistant) return null
                if (assistant.status === "archived") return "archived"
                const wanted =
                  typeof version === "number" ? version : assistant.currentVersion
                const stored = service.getVersion(assistantId, context.tenantId, wanted)
                if (!stored) return null
                return {
                  assistantId,
                  version: stored.version,
                  name: assistant.name,
                  configDigest: evalAssistantConfigDigest({
                    systemPrompt: stored.config.systemPrompt,
                    rerankModelProfileId: stored.config.rerankModelProfileId,
                  }),
                  systemPrompt: stored.config.systemPrompt,
                  rerankModelProfileId: stored.config.rerankModelProfileId,
                }
              },
            }
          : {}),
      })
    )
  }
  // Ticket 09 P5: mount the Handoff HTTP API (spec §8 L1549-1552).
  // POST /chat/runs/:runId/handoff is covered by the /api/chat access middleware
  // mount above (chat scope) since the path starts with /chat. GET/PATCH /handoffs
  // authenticate through the identity-only management middleware in enforced
  // mode, then retain the in-handler review-or-admin scope check. Single-tenant
  // mode uses the deterministic local context, which includes both scopes.
  app.use("/api", createHandoffRouter(handoffStore))
  // Ticket 09 P6: mount the Feedback HTTP API (spec §8 L1551).
  // PUT /chat/runs/:runId/feedback is covered by the /api/chat access middleware
  // mount above (chat scope) since the path starts with /chat — same as POST
  // /chat/runs/:runId/handoff. No 404 cross-tenant case for PUT (upsert creates
  // if not exists; UNIQUE includes tenant_id+subject_id so each tenant gets its
  // own row). 400 for invalid rating or reason code (InvalidFeedbackReasonCodeError).
  // Ticket 29: /api/feedback (list/detail/review) is a reviewer surface and
  // authenticates through the identity-only management middleware in enforced
  // mode; the handler keeps its own review-or-admin check.
  app.use("/api", createFeedbackRouter(feedbackStore, { targetResolver: feedbackTargetResolver }))
  // Ticket 11 P5: mount the Source governance HTTP API (spec §11 L1580-1583).
  // Three endpoints:
  //   POST /api/ingest/:docId/review       (review scope — L1580)
  //   POST /api/sources/:sourceId/retire   (admin scope — L1581)
  //   GET  /api/sources/:sourceId/status   (admin scope — L1582)
  // /api/sources requests authenticate through the identity-only management
  // middleware in enforced mode. Handler-level requireReviewOrAdmin / requireAdmin
  // checks remain authoritative; single-tenant mode uses ALL_LOCAL_SCOPES.
  app.use(
    "/api",
    createSourceGovernanceRouter({
      db,
      candidateReviewStore,
      retirementService,
      lifecycleStore: sourceLifecycleStore,
    })
  )
  if (options.processRuntime && options.config) {
    const statusRouter = createStatusRouter({
      config: options.config,
      elasticsearch: options.processRuntime.elasticsearch,
      neo4jDriver: options.processRuntime.neo4jDriver,
      chatClient: options.processRuntime.chatClient,
    })
    app.use("/api", statusRouter)
    // The /api/models route is no longer mounted in production — the
    // deployment-configured model is the only model. The source file
    // (src/api/models.ts) is retained for potential future use.
  }
  // Ticket 16 (MODEL-01A): the admin model-profile workspace. Mounted whenever
  // a registry is provided (production wiring); the router itself enforces the
  // admin scope and only ever exposes non-secret metadata.
  if (options.modelProfiles && options.config && options.processRuntime) {
    app.use(
      "/api",
      createModelProfilesRouter({
        registry: options.modelProfiles,
        config: options.config,
        clients: {
          chatClient: options.processRuntime.chatClient,
          embeddingClient: options.processRuntime.embeddingClient,
        },
      })
    )
  }
  // Ticket 18 (AST-01A): the assistant workspace. Bindings are validated
  // against the SAME knowledge-base service and model-profile registry the
  // runtime enforces, so a stored assistant can never reference a knowledge
  // base or profile the server would refuse.
  if (options.assistants) {
    app.use("/api", createAssistantsRouter({ service: options.assistants }))
  }
  // Ticket 20 (CONV-01A): the user-owned conversation history API (directory
  // list, per-thread history, one-time browser import). Identity arrives via
  // the management middleware; ownership is enforced per (tenant, subject).
  if (options.conversationHistory) {
    app.use("/api", createConversationsRouter({ history: options.conversationHistory }))
  }
  // Ticket 32 (MEM-01A): the user-owned long-term memory API (add, edit,
  // forget, clear). Ownership is enforced per (tenant, subject) inside the
  // store; an assistant pin must resolve to an assistant the caller can see.
  if (options.memories) {
    app.use(
      "/api",
      createMemoriesRouter({
        memories: options.memories,
        ...(options.assistants ? { assistants: options.assistants } : {}),
      })
    )
  }
  app.use("/api", ingestRouter)
  return app
}

/**
 * T45: startServer creates a ProcessRuntime that owns shared resources.
 * The runtime is returned so the caller (index.ts) can delegate close()
 * to the shutdown controller (T46).
 *
 * The required `eventsSource` parameter is the single injection point for
 * the Mastra runtime boundary.
 *
 * P5.2: `identityAdapter` is the concrete `IdentityAdapter` built by the
 * composition root (index.ts) from the loaded `OidcConfig`. When provided,
 * the chat access middleware enforces identity + chat scope per request;
 * the ingest access middleware enforces identity + ingest scope. In
 * single_tenant mode the adapter is unused: chat middleware and ingestion
 * handlers derive `singleTenantAccessContext()` directly.
 */
export async function startServer(
  port: number,
  eventsSource: AnswerEventsSource,
  identityAdapter?: import("../access/context").IdentityAdapter,
  /** Ticket 01: enables the local demo sign-in when the demo issuer is running. */
  options: {
    demoAuth?: DemoAuthOptions
    /** Ticket 14 (RET-01): chat's shared search operations for the debug run. */
    searchOperations?: import("../retrieval/search/searcher").SearchOperations
    /**
     * Ticket 22 (ATT-01): the SAME session attachment service the shared
     * answer entry reads its attachment channel from — one instance, so a
     * file uploaded through these routes is immediately retrievable by the
     * next run of that session.
     */
    attachments?: import("../attachments/session_attachment_service").SessionAttachmentService
  } = {}
): Promise<{
  server: Server
  processRuntime: ProcessRuntime
  /** Ticket 14: exposed so the shutdown controller can release eval scopes. */
  evaluationService: EvaluationService
}> {
  const config = loadConfig()
  const processRuntime = createProcessRuntime(config)
  // Ticket 05 follow-up wiring + P5.2: in single_tenant mode (default), mount
  // the access middleware and session binder so every chat request gets a
  // deterministic AccessContext and sessionId → (tenantId, subjectId)
  // binding. In enforced mode (P5.2), the identity adapter resolves a
  // per-request AccessContext from the JWT; validateAccessMode() in
  // index.ts main() already confirmed an adapter is wired at startup.
  const accessMiddleware = createAccessMiddleware({
    mode: config.accessMode,
    ...(identityAdapter ? { adapter: identityAdapter } : {}),
    requiredScope: "chat",
  })
  // P5.2: ingestion gate — enforced mode resolves identity + ingest scope
  // before handlers persist trusted tenant/group metadata. Single-tenant
  // handlers use their deterministic AccessContext fallback.
  const ingestAccessMiddleware =
    config.accessMode === "enforced" && identityAdapter
      ? createAccessMiddleware({
          mode: "enforced",
          adapter: identityAdapter,
          requiredScope: "ingest",
        })
      : undefined
  const managementAccessMiddleware =
    config.accessMode === "enforced"
      ? createAccessMiddleware({
          mode: "enforced",
          ...(identityAdapter ? { adapter: identityAdapter } : {}),
        })
      : undefined
  const sessionBinder = new SqliteSessionBinder(processRuntime.db)
  // Ticket 08 (KB-04): ONE production knowledge-base service shared by the
  // retrieval-scope resolver and the workspace routes, so a base an admin just
  // archived is refused by the very next chat selection.
  const knowledgeBaseService = new KnowledgeBaseServiceImpl(
    new SqliteKnowledgeBaseRepo(processRuntime.db),
    knowledgeBaseEmbeddingProfile(config.embeddingModel, config.embeddingDimensions)
  )
  // Ticket 05 (KB-03A): the production retrieval-scope resolver. The knowledge
  // selection a request may carry is intersected here with the AccessContext
  // the request's identity produced — the transport never filters storage
  // itself and the client never supplies a raw storage filter. Every chat
  // request therefore runs inside a server-computed knowledge scope; a request
  // without the field resolves to its tenant's default knowledge base, and an
  // unknown or cross-tenant id is refused (404) before any run starts.
  const retrievalScopeResolver = createRetrievalScopeResolver(knowledgeBaseService)
  // Ticket 04: the evaluation service shares the production clients but owns
  // its per-task isolated scopes, in-memory task registry, and the dedicated
  // reranker built from RERANK_* config (the same adapter normal chat uses).
  // Ticket 16 (MODEL-01A): the built-in profile registry seeds its toggle rows
  // and gates raw model selections (evaluation overrides today).
  const modelProfiles = new ModelProfileRegistry(processRuntime.db, config)
  const reranker = createDedicatedReranker({
    baseUrl: config.rerankBaseUrl,
    apiKey: config.rerankApiKey,
    model: config.rerankModel,
    timeoutMs: config.rerankTimeoutMs,
    maxDocumentChars: config.rerankMaxDocumentChars,
  })
  const evaluationService = new EvaluationService({
    config,
    clients: {
      es: processRuntime.elasticsearch,
      chatClient: processRuntime.chatClient,
      embeddingClient: processRuntime.embeddingClient,
      graphDriver: processRuntime.neo4jDriver,
    },
    ...(reranker ? { reranker } : {}),
    // Ticket 11: a task may only pick models the operator listed; the rerank
    // override reuses the same dedicated adapter as normal chat.
    allowedChatModels: config.evalAllowedChatModels ?? [],
    allowedRerankModels: config.evalAllowedRerankModels ?? [],
    createReranker: (model) =>
      createDedicatedReranker({
        baseUrl: config.rerankBaseUrl,
        apiKey: config.rerankApiKey,
        model,
        timeoutMs: config.rerankTimeoutMs,
        maxDocumentChars: config.rerankMaxDocumentChars,
      }),
    // Ticket 16 (MODEL-01A): a disabled or unknown profile can never be
    // selected through raw request values, whatever the allowlists say.
    modelProfileGate: modelProfiles,
  })
  // Ticket 18 (AST-01A): the assistant workspace shares the production
  // knowledge-base service and profile registry for binding validation.
  const assistants = new AssistantService(processRuntime.db, knowledgeBaseService, {
    assertRerankProfileSelectable: () => {
      if (!modelProfiles.selectable("rerank")) {
        throw new InvalidAssistantCommandError(
          "the rerank model profile is disabled on this server"
        )
      }
    },
  })
  const app = createApp({
    db: processRuntime.db,
    imageAssetPath: config.imageAssetPath,
    accessMiddleware,
    ...(ingestAccessMiddleware ? { ingestAccessMiddleware } : {}),
    ...(managementAccessMiddleware ? { managementAccessMiddleware } : {}),
    ...(options.demoAuth ? { demoAuth: options.demoAuth } : {}),
    sessionBinder,
    retrievalScopeResolver,
    knowledgeBaseService,
    // Ticket 14 (RET-01): the debug run shares chat's retrieval configuration.
    ...(options.searchOperations ? { searchOperations: options.searchOperations } : {}),
    eventsSource,
    processRuntime,
    config,
    evaluationService,
    modelProfiles,
    assistants,
    // Ticket 20 (CONV-01A): server-owned conversation directories + history.
    conversationHistory: new SqliteConversationHistoryStore(processRuntime.db),
    // Ticket 32 (MEM-01A): user-owned long-term memories on the shared db.
    memories: new LongTermMemoryStore({ db: processRuntime.db }),
    // Ticket 22 (ATT-01): the session attachment routes (upload/list/promote/
    // cleanup). Absent when the composition did not build the service — the
    // routes then simply do not exist and no run reads attachments.
    ...(options.attachments ? { attachments: options.attachments } : {}),
  })
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(port, () => {
      console.log(`[kefu-RAG] API server listening on http://localhost:${port}`)
      resolve(s)
    })
  })
  return { server, processRuntime, evaluationService }
}
