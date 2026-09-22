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
import { SqliteFeedbackStore } from "../answer/feedback_store"
import { SqliteSessionBinder } from "../access/session_binder"
import { createAccessMiddleware } from "./access_middleware"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import { TaskRepo } from "../ingestion/tracking/task_repo"
import { SqliteSourceLifecycleStore } from "../knowledge/source_lifecycle_store"
import { SqliteCandidateReviewStore } from "../knowledge/candidate_review_store"
import { RetirementServiceImpl } from "../knowledge/retirement"
import { createSourceGovernanceRouter } from "./source_governance"
import { createStatusRouter } from "./status"
import { createEvaluationsRouter } from "./evaluations"
import { createSessionRouter, type DemoAuthOptions } from "./session"
import { EvaluationService } from "../evaluation/service"
import { createDedicatedReranker } from "../retrieval/search/dedicated_reranker"
import {
  createRetrievalScopeResolver,
  type RetrievalScopeResolver,
} from "../retrieval/scope"
import { KnowledgeBaseServiceImpl } from "../knowledge/knowledge_base_service"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { knowledgeBaseEmbeddingProfile } from "../types/knowledge_base"

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
  eventsSource: AnswerEventsSource
  // Optional runtime surfaces for the /api/status endpoint.
  // When omitted (e.g. tests), the status route is not mounted.
  processRuntime?: import("../runtime/process_runtime").ProcessRuntime
  config?: import("../config").AppConfig
}) {
  const app = express()
  const db = options.db || openDb()
  const traceRepository = new AnswerTraceRepository(db)
  const handoffStore = new SqliteHandoffStore(db)
  const feedbackStore = new SqliteFeedbackStore(db)
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
  }
  app.use(
    "/api",
    createChatRouter(
      traceRepository,
      options.eventsSource,
      options.sessionBinder,
      options.retrievalScopeResolver
    )
  )
  if (options.managementAccessMiddleware) {
    app.use("/api/handoffs", options.managementAccessMiddleware)
    app.use("/api/sources", options.managementAccessMiddleware)
    // Ticket 04: evaluation tasks are identity-scoped like every other
    // management surface; the handler keeps its own admin check.
    app.use("/api/evaluations", options.managementAccessMiddleware)
    app.use("/api/evaluation-datasets", options.managementAccessMiddleware)
    // Ticket 01: reading your own identity needs identity but no particular
    // scope — a reader must be able to learn its navigation from the server.
    app.use("/api/session", options.managementAccessMiddleware)
  }
  // Ticket 01: identity session + demo sign-in. /api/auth/* is deliberately
  // outside the identity middleware — you cannot be required to authenticate
  // in order to authenticate.
  app.use("/api", createSessionRouter(options.demoAuth ? { demoAuth: options.demoAuth } : {}))
  if (options.evaluationService) {
    app.use("/api", createEvaluationsRouter(options.evaluationService))
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
  app.use("/api", createFeedbackRouter(feedbackStore))
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
  options: { demoAuth?: DemoAuthOptions } = {}
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
  // Ticket 05 (KB-03A): the production retrieval-scope resolver. The knowledge
  // selection a request may carry is intersected here with the AccessContext
  // the request's identity produced — the transport never filters storage
  // itself and the client never supplies a raw storage filter. Every chat
  // request therefore runs inside a server-computed knowledge scope; a request
  // without the field resolves to its tenant's default knowledge base, and an
  // unknown or cross-tenant id is refused (404) before any run starts.
  const retrievalScopeResolver = createRetrievalScopeResolver(
    new KnowledgeBaseServiceImpl(
      new SqliteKnowledgeBaseRepo(processRuntime.db),
      knowledgeBaseEmbeddingProfile(config.embeddingModel, config.embeddingDimensions)
    )
  )
  // Ticket 04: the evaluation service shares the production clients but owns
  // its per-task isolated scopes, in-memory task registry, and the dedicated
  // reranker built from RERANK_* config (the same adapter normal chat uses).
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
    eventsSource,
    processRuntime,
    config,
    evaluationService,
  })
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(port, () => {
      console.log(`[kefu-RAG] API server listening on http://localhost:${port}`)
      resolve(s)
    })
  })
  return { server, processRuntime, evaluationService }
}
