import "dotenv/config"
import { dirname, join } from "node:path"
import { createAnswerRuntime } from "./answer/runtime"
import { startConversationGc } from "./answer/conversation_gc"
import { SqliteConversationStore } from "./answer/conversation_store"
import { legacyIngestionEnvKeys, loadConfig } from "./config"
import { defaultEnvFilePath } from "./config/env_file"
import {
  validateAccessMode,
  SINGLE_TENANT_TENANT,
  type IdentityAdapter,
} from "./access/context"
import {
  loadOidcConfig,
  JoseIdentityAdapter,
  DEFAULT_CLAIM_MAPPING,
  DEFAULT_CLOCK_SKEW_SECONDS,
  DEMO_TENANT_ID,
  startDemoOidcIssuer,
  type DemoOidcIssuerHandle,
} from "./identity"
import { LocalAuthService, SqliteLocalUserStore } from "./identity/local_users"
import type { LocalAuthOptions } from "./api/session"
import { SqliteKnowledgeBaseRepo } from "./knowledge/knowledge_base_repo"
import { KnowledgeBaseServiceImpl } from "./knowledge/knowledge_base_service"
import { knowledgeBaseEmbeddingProfile } from "./types/knowledge_base"
import { startServer } from "./api"
import { startWorker } from "./api/worker"
import { closeDriver } from "./graph"
import { createShutdownController, installSignalHandlers } from "./shutdown"
import { createTracingRuntime } from "./tracing/composition"
import { configureIngestionTracing } from "./ingestion/storage"
import { configureDecisionTracing } from "./runtime/decision_call"
import { createMastraRuntimeBoundary } from "./mastra/runtime_boundary"
import { createSharedAnswerEntry } from "./mastra/shared_answer_entry"
import { createSessionAttachmentService } from "./attachments/session_attachment_service"
import { FaqEntryServiceImpl } from "./faq/faq_entry_service"
import { SqliteFaqEntryRepo } from "./faq/faq_entry_repo"
import { LongTermMemoryStore } from "./memory/long_term_memory_store"
import { MemorySuggestionStore } from "./memory/memory_suggestion_store"
import { readMastraRuntimeMode } from "./mastra/runtime_mode"
import {
  MASTRA_PROMOTION_ARTIFACT_ENV,
  assertRuntimeModeStartupAllowed,
} from "./mastra/promotion_gate"
import { createRealLangfuseClient } from "./answer/langfuse_client"
import { createWebEvidenceOperations } from "./web/web_evidence"
import { createProcessLoggers, type ProcessLoggers } from "./logging/composition"
import { installConsoleMirror } from "./logging/console_mirror"

/** LF-05: held at module scope so the startup-failure path can flush and close. */
let processLogs: ProcessLoggers | undefined

async function main() {
  // LF-05: the log runtime is built before config and before the first startup
  // message, so every `console.*` below (including a config failure) reaches
  // `system-YYYY-MM-DD.log`. stdout stays the existing single-line JSON.
  const logs = createProcessLoggers(process.env)
  processLogs = logs
  installConsoleMirror(console, logs.systemFile)

  // WD-05: one startup migration hint through the neutral logger; retired
  // ingestion env vars are ignored, never silently kept in review mode.
  const retiredIngestionEnv = legacyIngestionEnvKeys()
  if (retiredIngestionEnv.length > 0) {
    await logs.system.warn("config.legacy_env.retired", {
      keys: retiredIngestionEnv,
      replacement: "weknora-technical-v1",
    })
  }

  const cfg = loadConfig()
  console.log("[kefu-RAG] Config loaded", { esNode: cfg.esNode, neo4jUri: cfg.neo4jUri })

  const runtimeMode = readMastraRuntimeMode()
  assertRuntimeModeStartupAllowed(
    runtimeMode,
    process.env[MASTRA_PROMOTION_ARTIFACT_ENV]
  )

  // LO-05/LO-06: one tracing runtime for the whole process, built before the
  // model clients so their observation seam can use it.
  const { runtime: tracingRuntime, config: tracingConfig } = createTracingRuntime(process.env)
  // LO-11: the ingestion store builds its own embedding client; hand it the
  // same runtime so ingestion embeddings are observed too.
  configureIngestionTracing(tracingRuntime)
  configureDecisionTracing(tracingRuntime)
  console.log(
    tracingConfig.enabled
      ? `[kefu-RAG] tracing enabled (sampleRate=${tracingConfig.sampleRate}) → OTLP ${process.env.LANGFUSE_BASE_URL}`
      : `[kefu-RAG] tracing off (${tracingConfig.reason})`,
  )

  // createAnswerRuntime owns shared SQLite, ES, Neo4j and OpenAI adapters.
  // Langfuse export activates only when both LANGFUSE_* keys are set —
  // createRealLangfuseClient returns undefined otherwise (Noop disabled mode).
  const answerRuntime = createAnswerRuntime(
    cfg,
    undefined,
    createRealLangfuseClient({
      publicKey: cfg.langfusePublicKey,
      secretKey: cfg.langfuseSecretKey,
      ...(cfg.langfuseBaseUrl ? { baseUrl: cfg.langfuseBaseUrl } : {}),
    }),
    tracingRuntime,
  )

  // Ticket 05: build the OIDC config + concrete IdentityAdapter from the
  // environment. In single_tenant mode loadOidcConfig returns a noop config
  // and the adapter is never constructed (the middleware short-circuits to
  // singleTenantAccessContext). In enforced mode the JoseIdentityAdapter
  // uses jose's jwtVerify + createRemoteJWKS for standards-based signature,
  // issuer, audience, algorithm, expiry, and not-before validation in one
  // trust boundary. Remote JWKS caching, cooldown, and key rotation are
  // handled by jose internally — no manual cache warming needed.
  //
  // Ticket 01 (IAM-01): when DEMO_OIDC=1 the local issuer takes over. It
  // starts on loopback, mints tokens only for the administrator's special ID
  // and the users registered into this process's database, and the adapter
  // verifies against ITS JWKS. `loadConfig` already reports the demo as
  // enforced access mode (the demo flag wins over ACCESS_MODE on purpose: a
  // demo that silently fell back to single-tenant would defeat the security
  // flow), so the enforced identity path is what the server mounts. The auth
  // service is created here, next to the runtime, so the sign-in proxy and
  // the issuer share ONE user registry.
  let demoIssuer: DemoOidcIssuerHandle | undefined
  let demoAuth: LocalAuthOptions | undefined
  let oidcConfig = loadOidcConfig(process.env, cfg.accessMode)
  if (cfg.demoOidc) {
    const localAuth = new LocalAuthService(
      new SqliteLocalUserStore(answerRuntime.processRuntime.db),
      { adminId: cfg.adminLoginId, adminPassword: cfg.adminLoginPassword },
    )
    demoIssuer = await startDemoOidcIssuer({
      port: cfg.demoOidcPort,
      audience: cfg.demoOidcAudience,
      // Keep the signing key beside the process database: cached browser
      // sessions survive a backend restart instead of expiring every deploy.
      keyPath: join(dirname(cfg.sqlitePath), "local-oidc-key.json"),
      resolveClaims: (account) => localAuth.claimsForAccount(account),
    })
    oidcConfig = {
      kind: "active",
      issuer: demoIssuer.issuer,
      audience: cfg.demoOidcAudience,
      jwksEndpoint: demoIssuer.jwksEndpoint,
      claimMapping: DEFAULT_CLAIM_MAPPING,
      clockSkewSeconds: DEFAULT_CLOCK_SKEW_SECONDS,
    }
    demoAuth = {
      tokenEndpoint: demoIssuer.tokenEndpoint,
      tokenAuth: demoIssuer.tokenAuth,
      localAuth,
    }
    console.log(
      `[kefu-RAG] Local sign-in ready on ${demoIssuer.issuer} — admin ID: ${cfg.adminLoginId}, registered users can sign in with their own ID`
    )
  }
  let identityAdapter: IdentityAdapter | undefined
  if (cfg.accessMode === "enforced") {
    identityAdapter = new JoseIdentityAdapter({ config: oidcConfig })
  }

  // Ticket 05 P4 + P5.2: startup fail-closed gate. Enforced mode without a
  // wired identity adapter throws — main() rejects, top-level .catch() exits
  // with code 1, no server, no worker. With the P5.2 adapter wired, enforced
  // mode passes the startup gate; the runtime fail-closed still lives in
  // createAccessMiddleware (enforced + adapter.resolve()=null → 401).
  validateAccessMode({
    accessMode: cfg.accessMode,
    ...(identityAdapter ? { adapter: identityAdapter } : {}),
  })

  // Ticket 02 (KB-01, spec §8.1 L241): every tenant owns exactly one default
  // knowledge base, and startup creates it for the tenants this process serves.
  // Repeated startup inserts nothing — the default id is derived from the
  // tenant id, so this is a read on the second run. A tenant that only appears
  // later (an enforced deployment with arbitrary OIDC tenants) gets its default
  // on first use, through the same deterministic path.
  const knowledgeBases = new KnowledgeBaseServiceImpl(
    new SqliteKnowledgeBaseRepo(answerRuntime.processRuntime.db),
    knowledgeBaseEmbeddingProfile(cfg.embeddingModel, cfg.embeddingDimensions)
  )
  const startupTenants = cfg.demoOidc ? [DEMO_TENANT_ID] : [SINGLE_TENANT_TENANT]
  for (const tenantId of startupTenants) {
    const knowledgeBase = knowledgeBases.ensureDefault(tenantId)
    console.log(
      `[kefu-RAG] default knowledge base ready for tenant ${tenantId}: ${knowledgeBase.id}`
    )
  }

  // Eval refactor Ticket 01: the shared Answer run entry owns the full
  // production composition (direct/simple/complex/ambiguous routing,
  // retrieval, Critic/Replan, observer fanout, budgets). Normal chat wires
  // it through the Mastra runtime boundary into the HTTP server — the
  // single injection point passed to `startServer` (T07 §3.4
  // single-publisher invariant).
  // Ticket 22 (ATT-01): ONE attachment service for the whole process — the
  // upload routes write it and the answer runs read it. Session-scoped, so a
  // run can only ever retrieve the attachments of its own conversation.
  const attachments = createSessionAttachmentService(answerRuntime.processRuntime.db)

  // Ticket 31 (FAQ-01B): ONE FAQ service for the answer path — exact matches
  // answer directly, fuzzy matches join retrieval as evidence. Rows are
  // versioned in the process db and seeded with the demo dataset.
  const faqService = new FaqEntryServiceImpl({
    repo: new SqliteFaqEntryRepo(answerRuntime.processRuntime.db),
  })
  // Ticket 33 (MEM-01B): ONE memory pair for the answer path — recall reads
  // the owner's memories and completed runs may create pending suggestions.
  // Shares the process db with the management routes' own instances.
  const memoryStore = new LongTermMemoryStore({
    db: answerRuntime.processRuntime.db,
  })
  const suggestionStore = new MemorySuggestionStore({
    db: answerRuntime.processRuntime.db,
  })

  const sharedAnswerEntry = await createSharedAnswerEntry({
    config: cfg,
    answerRuntime,
    // LG-05-AC10: with the HTTP root owning the run, the legacy exporter must
    // not publish a second trace. SQLite consumption (traceObserver) is
    // untouched either way.
    legacyLangfuseObserver: !tracingConfig.enabled,
    // Whole-run deadline budget. ANSWER_RUN_BUDGET_MS existed as dead config
    // for normal chat: the entry's injectable seam was never fed from the
    // composition root, so every run kept the 30s DEFAULT_RUN_BUDGET_MS and
    // complex multi-tool loops were cancelled mid-flight (observed live: a
    // complex-routed question died at exactly 30.04s with status=cancelled).
    ...(cfg.answerRunBudgetMs !== undefined
      ? { budgetMs: cfg.answerRunBudgetMs }
      : {}),
    // The retrieval channel that reads this session's temporary attachments.
    attachments,
    // Ticket 31 (FAQ-01B): the FAQ standard-answer channel.
    faq: faqService,
    // Ticket 33 (MEM-01B): scoped memory recall + suggestion extraction.
    memories: memoryStore,
    suggestions: suggestionStore,
    // Ticket 36 (WEB-01): the web-evidence channel — safe URL reads of the
    // user's own pasted links + optional configured Tavily search (server-
    // side key). Runs only when the composition wires it, so probes never
    // touch the network.
    web: createWebEvidenceOperations({
      ...(cfg.tavilyApiKey ? { tavilyApiKey: cfg.tavilyApiKey } : {}),
    }),
  })
  console.log("[kefu-RAG] Mastra runner wired — direct + ambiguous + simple + complex knowledge routes enabled with Conversation Memory + Handoff + Observer fanout")

  const mastraBoundary = createMastraRuntimeBoundary({
    mastraSource: sharedAnswerEntry.eventsSource,
    modeReader: () => runtimeMode,
  })

  const {
    server,
    processRuntime,
    logger: runtimeLogger,
  } = await startServer(
    Number(process.env.API_PORT ?? 3001),
    mastraBoundary.eventsSource,
    identityAdapter,
    {
      // Ticket 01 wiring fix: the session router reads options.demoAuth — the
      // spread leaked the three fields as top-level options and the sign-in
      // flow never came up (the root cause recorded in TD-24-01).
      ...(demoAuth ? { demoAuth } : {}),
      // LF-05: the system logger built above is the process's only log runtime;
      // without this injection startServer would build a stdout-only logger.
      logger: logs.system,
      // LF-07: Answer run metadata goes to the Agent file only (never stdout).
      agentLogger: logs.agent,
      // Ticket 22 (ATT-01): the routes and the runs share ONE instance.
      attachments,
      // Ticket 35 (TOOL-01B): the MCP capability invocation seam.
      ...(sharedAnswerEntry.mcp ? { mcpCapabilities: sharedAnswerEntry.mcp } : {}),
      // The reasoning-effort capability THIS composition resolved — the
      // transport must publish this exact frozen object, never re-read .env.
      reasoningCapability: sharedAnswerEntry.reasoningCapability,
      // LO-06: the single tracing runtime built above.
      tracing: tracingRuntime,
      // Model settings saves write provider credentials here; detection and
      // probes read it immediately, the pipeline picks it up on next start.
      envFilePath: defaultEnvFilePath(),
    }
  )
  const worker = startWorker({
    db: processRuntime.db,
    wikiChatClient: processRuntime.chatClient,
    wikiElasticsearch: processRuntime.elasticsearch,
    // LO-13: the worker executes persistent tasks under the same runtime, so a
    // submitted task continues its trace instead of opening a second one.
    tracing: tracingRuntime,
  })

  // Ticket 08 P6 (spec §7 L1535): conversation GC — scheduled job that purges
  // sessions inactive for >conversationTtlDays. Uses the SAME db as the answer
  // ConversationStore (answerRuntime.processRuntime.db) so it cleans exactly
  // the data the answer pipeline reads/writes. Eager sweep fires on next tick;
  // periodic sweeps follow every conversationGcIntervalMs.
  const conversationGc = startConversationGc({
    store: new SqliteConversationStore(answerRuntime.processRuntime.db),
    ttlDays: cfg.conversationTtlDays,
    intervalMs: cfg.conversationGcIntervalMs,
  })

  // T46: Shutdown delegates resource close to ProcessRuntime.close() which
  // owns SQLite, ES, Neo4j lifetimes. worker.stop() and server.close()
  // remain separate because they own process-level handles (timer, socket).
  // conversationGc.stop() clears the GC interval timer before the db closes.
  // Both the Answer runtime's and the server's ProcessRuntime are closed.
  const shutdownController = createShutdownController({
    worker,
    conversationGc,
    server,
    ...(demoIssuer ? { demoIssuer } : {}),
    runtime: {
      close: async () => {
        // T12 (spec issue #12 criterion #6): flush pending Langfuse events
        // BEFORE closing ProcessRuntime resources. The exporter's close() is
        // idempotent (criterion #7) and does not close shared Answer/retrieval
        // resources — only Langfuse-specific state is flushed.
        await answerRuntime.langfuseExporter.close()
        await processRuntime.close()
        await answerRuntime.processRuntime.close()
        // Close the Mastra runtime boundary after ProcessRuntime so in-flight
        // streams have already been cancelled by the upstream close cascade.
        await mastraBoundary.close()
        // LO-05: flush spans within a bounded budget. A timed-out flush is
        // reported, not retried forever, and never blocks the closes below.
        const tracingShutdown = await tracingRuntime.shutdown(2_000)
        if (tracingShutdown.timedOut) {
          console.error(
            `[shutdown] tracing flush timed out; dropped ${tracingShutdown.droppedPending} pending spans`,
          )
        }
        // LO-03: flush the runtime logger LAST so the closes above still
        // produce diagnostics, then drain the pipe within its own budget.
        await runtimeLogger.close()
        // LF-05: after the HTTP server and background runtime have stopped,
        // close the file runtime last so every accepted line (including the
        // request terminals above) is flushed and both daily files are closed.
        await logs.close()
      },
    },
    // P8.2 (Debt #3 fix): close the legacy graph Neo4j driver singleton.
    // graph/index.ts holds a module-level _driver created lazily by
    // createDriver() (used by the ingestion pipeline via Neo4jStore.getDriver()).
    // Before P8.2 this dep was absent — the driver pool leaked on every server
    // shutdown. closeDriver() is idempotent (guards on _driver null) and is a
    // SEPARATE Driver instance from ProcessRuntime.neo4jDriver (closed above in
    // runtime.close). Shutdown order: runtime (ProcessRuntime's Neo4j) → driver
    // (graph singleton) → db. This is the single authoritative close path.
    driver: { close: closeDriver },
  })
  installSignalHandlers(shutdownController)
}

main().catch(async (err) => {
  console.error("[kefu-RAG] Startup failed:", err)
  // LF-05: the mirror already queued this failure for the system file; flush
  // it before exiting. A logging failure must not replace the startup error.
  try {
    await processLogs?.close()
  } catch {
    // stderr already carries the original failure.
  }
  process.exit(1)
})
