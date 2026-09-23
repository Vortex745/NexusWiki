import "dotenv/config"
import { createAnswerRuntime } from "./answer/runtime"
import { startConversationGc } from "./answer/conversation_gc"
import { SqliteConversationStore } from "./answer/conversation_store"
import { loadConfig } from "./config"
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
import { SqliteKnowledgeBaseRepo } from "./knowledge/knowledge_base_repo"
import { KnowledgeBaseServiceImpl } from "./knowledge/knowledge_base_service"
import { knowledgeBaseEmbeddingProfile } from "./types/knowledge_base"
import { startServer } from "./api"
import { startWorker } from "./api/worker"
import { closeDriver } from "./graph"
import { createShutdownController, installSignalHandlers } from "./shutdown"
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

async function main() {
  const cfg = loadConfig()
  console.log("[kefu-RAG] Config loaded", { esNode: cfg.esNode, neo4jUri: cfg.neo4jUri })

  // Ticket 05: build the OIDC config + concrete IdentityAdapter from the
  // environment. In single_tenant mode loadOidcConfig returns a noop config
  // and the adapter is never constructed (the middleware short-circuits to
  // singleTenantAccessContext). In enforced mode the JoseIdentityAdapter
  // uses jose's jwtVerify + createRemoteJWKS for standards-based signature,
  // issuer, audience, algorithm, expiry, and not-before validation in one
  // trust boundary. Remote JWKS caching, cooldown, and key rotation are
  // handled by jose internally — no manual cache warming needed.
  //
  // Ticket 01 (IAM-01): when DEMO_OIDC=1 the local demo issuer takes over.
  // It starts on loopback, mints the three demo accounts, and the adapter
  // verifies against ITS JWKS. `loadConfig` already reports the demo as
  // enforced access mode (the demo flag wins over ACCESS_MODE on purpose: a
  // demo that silently fell back to single-tenant would defeat the security
  // flow), so the enforced identity path is what the server mounts.
  let demoIssuer: DemoOidcIssuerHandle | undefined
  let demoAuth: { tokenEndpoint: string; password: string; tokenAuth: string } | undefined
  let oidcConfig = loadOidcConfig(process.env, cfg.accessMode)
  if (cfg.demoOidc) {
    demoIssuer = await startDemoOidcIssuer({
      port: cfg.demoOidcPort,
      audience: cfg.demoOidcAudience,
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
      password: cfg.demoOidcPassword,
      tokenAuth: demoIssuer.tokenAuth,
    }
    console.log(
      `[kefu-RAG] Demo OIDC issuer listening on ${demoIssuer.issuer} — sign-in requires DEMO_OIDC_PASSWORD`
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

  const runtimeMode = readMastraRuntimeMode()
  assertRuntimeModeStartupAllowed(
    runtimeMode,
    process.env[MASTRA_PROMOTION_ARTIFACT_ENV]
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
  )

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
  // single-publisher invariant). Evaluation will reuse the same entry with
  // injected isolated repositories and observers.
  // Ticket 22 (ATT-01): ONE attachment service for the whole process — the
  // upload routes write it and the answer runs read it. Session-scoped, so a
  // run can only ever retrieve the attachments of its own conversation.
  const attachments = createSessionAttachmentService(answerRuntime.processRuntime.db)

  // Ticket 31 (FAQ-01B): ONE FAQ service for the answer path — exact matches
  // answer directly, fuzzy matches join retrieval as evidence. Shares the
  // process db with the management routes' own instance; both read the same
  // versioned rows.
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
    // The retrieval channel that reads this session's temporary attachments.
    attachments,
    // Ticket 31 (FAQ-01B): the FAQ standard-answer channel.
    faq: faqService,
    // Ticket 33 (MEM-01B): scoped memory recall + suggestion extraction.
    memories: memoryStore,
    suggestions: suggestionStore,
  })
  console.log("[kefu-RAG] Mastra runner wired — direct + ambiguous + simple + complex knowledge routes enabled with Conversation Memory + Handoff + Observer fanout")

  const mastraBoundary = createMastraRuntimeBoundary({
    mastraSource: sharedAnswerEntry.eventsSource,
    modeReader: () => runtimeMode,
  })

  const { server, processRuntime, evaluationService } = await startServer(
    3001,
    mastraBoundary.eventsSource,
    identityAdapter,
    {
      ...(demoAuth ? demoAuth : {}),
      // Ticket 14 (RET-01): the retrieval-debug endpoint shares chat's search
      // operations (same clients + reranker) — no second retrieval config.
      searchOperations: sharedAnswerEntry.searchOperations,
      // Ticket 22 (ATT-01): the routes and the runs share ONE instance.
      attachments,
      // Ticket 35 (TOOL-01B): the MCP capability invocation seam.
      ...(sharedAnswerEntry.mcp ? { mcpCapabilities: sharedAnswerEntry.mcp } : {}),
    }
  )
  const worker = startWorker({ db: processRuntime.db })

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
    // Ticket 14: release evaluation scopes (dedicated index + graph
    // provenance) before the shared ES/Neo4j clients close. Honest about
    // leftovers: the log names what was released and whether the wait ran out,
    // and points at the scoped residue tool for a hard kill.
    evaluations: {
      shutdown: async () => {
        const report = await evaluationService.shutdown()
        console.log(
          `[shutdown] evaluation tasks cancelled: ${report.cancelledTaskIds.length}, cleanup budget exhausted: ${report.timedOut}`
        )
        for (const release of report.releases) {
          console.log(
            `[shutdown]   ${release.taskId} stage=${release.stage} cleanup=${JSON.stringify(release.cleanup)}`
          )
        }
        if (report.timedOut) {
          console.warn(
            "[shutdown] evaluation cleanup did not finish in time — residue may remain; after restart run: npm run eval:residue -- --delete"
          )
        }
      },
    },
  })
  installSignalHandlers(shutdownController)
}

main().catch((err) => {
  console.error("[kefu-RAG] Startup failed:", err)
  process.exit(1)
})
