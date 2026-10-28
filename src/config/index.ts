export interface AppConfig {
  esNode: string
  esApiKey: string
  /** Physical chunk index; explicit isolated scope targets take precedence. */
  esChunkIndexName?: string
  openaiApiKey: string
  openaiBaseUrl: string
  openaiChatModel: string
  /** Optional question-routing provider; omitted configurations use Chat. */
  decisionProvider?: "chat" | "clef"
  /** Server-side credentials for the Cloudflare Clef decision provider. */
  cloudflareAccountId?: string
  cloudflareApiToken?: string
  /** Per-decision request timeout in milliseconds; defaults to 10_000. */
  decisionRequestTimeoutMs?: number
  embeddingApiKey: string
  embeddingBaseUrl: string
  embeddingModel: string
  embeddingDimensions: number
  /**
   * Per-request timeout for all OpenAI-compatible client calls (chat +
   * embedding), in milliseconds. Default 200_000. The OpenAI SDK default is
   * 10 minutes; this bounds every LLM call in the Answer and ingestion
   * chains (router/planner/validator/rerank/wikify) so a hung provider
   * cannot occupy a connection/queue for minutes.
   */
  openaiRequestTimeoutMs: number
  /**
   * Per-request retry count for all OpenAI-compatible client calls.
   * Default 1 (SDK default is 2). Bounds worst-case hang time to
   * timeout * (1 + maxRetries) — e.g. 200s * 2 = ~400s instead of the
   * SDK default 10min * 3 = 30min.
   */
  openaiMaxRetries: number
  neo4jUri: string
  neo4jUser: string
  neo4jPassword: string
  sqlitePath: string
  pollIntervalMs: number
  claimedTimeoutMs: number
  markitdownCommand?: string
  /** Deprecated: only historical offline parser fixtures consume these. */
  markerCommand?: string
  mineruCommand?: string
  /** OCR credentials are server-only and independent from the Chat API key. */
  ocrAccessKeyId?: string
  ocrSecretAccessKey?: string
  ocrSessionToken?: string
  /** Python interpreter backing the repo-shipped builtin-pdf parser. */
  pythonCommand?: string
  parserTimeoutMs?: number
  parserInputLimitBytes?: number
  parserOutputLimitBytes?: number
  /** DocReader gRPC address; only used by the PDF adapter and probe. */
  docreaderAddr?: string
  /** Total DocReader + required-OCR budget for one PDF parse, in milliseconds. */
  docreaderTimeoutMs?: number
  /**
   * Ingestion speed: passages per embedding request (count bound) and per
   * request byte budget (UTF-8 bound). The byte cap is the safety net when a
   * provider rejects large batches — lower it instead of shipping a revert.
   */
  embeddingBatchMaxChunks?: number
  embeddingBatchMaxBytes?: number
  /** Ingestion speed: concurrent ingestion tasks the worker may run. */
  ingestionConcurrency?: number
  /**
   * PDF quality queue Ticket 04: the independent switch for the PDF
   * OCR-fallback + page-quality-gate ingestion workflow. Default OFF — unset,
   * blank or `0` keeps every PDF import on the existing
   * extraction → chunk → vectorize → index path.
   *
   * Optional in the type the way the other ingestion/decision settings are:
   * `loadConfig()` always populates it after validating
   * `PDF_OCR_FALLBACK_ENABLED`, and a config object that never went through
   * `loadConfig()` (isolated scopes, legacy stubs) reads as OFF — the
   * fail-safe direction, never an accidental gate.
   *
   * It is an INGESTION switch only. Question-answering Clef routing
   * (`decisionProvider` and its credentials/timeout), run budgets,
   * cancellation, prompts and classification never consult it, and the value is
   * never exported to the frontend or written into user content.
   */
  pdfOcrFallbackEnabled?: boolean
  imageAssetPath?: string
  accessMode: "single_tenant" | "enforced"
  /**
   * Ticket 01 (IAM-01): when true, `main()` starts the local demo OIDC issuer
   * on loopback and wires the identity adapter to it, so the demo runs through
   * the enforced identity path instead of the legacy single-tenant one.
   */
  demoOidc: boolean
  /** Ticket 01: loopback port for the demo issuer. */
  demoOidcPort: number
  /** Ticket 01: audience claim the demo issuer mints and the adapter expects. */
  demoOidcAudience: string
  /**
   * Ticket 01: the password every demo account signs in with. Verified
   * server-side only — it never reaches the browser. Defaults to a fixed
   * demo credential; `DEMO_OIDC_PASSWORD` overrides it.
   */
  demoOidcPassword: string
  /**
   * Eval refactor Ticket 03: dedicated rerank endpoint (Edgefn-compatible
   * `POST {base}/rerank`). Independent from the Chat/Embedding settings on
   * purpose — the reranker is its own provider and model. An empty key means
   * "no dedicated reranker configured": retrieval then publishes the fused
   * order and reports `rerank reason: not_configured` instead of silently
   * falling back to Chat per-fragment scoring (which no longer exists).
   */
  rerankApiKey: string
  rerankBaseUrl: string
  rerankModel: string
  /** Per-rerank hard ceiling (ms) independent of the run deadline. */
  rerankTimeoutMs: number
  /** Max characters of one candidate sent to the reranker. */
  rerankMaxDocumentChars: number
  /**
   * Ticket 35 (TOOL-01B): the local read-only MCP capability server. Enabled
   * by default; MCP_CAPABILITIES=0 disables discovery entirely (no child
   * process, no registry entries — ordinary chat is untouched).
   */
  mcpCapabilitiesEnabled: boolean
  /**
   * Ticket 36 (WEB-01): the server-side Tavily key for optional web search.
   * The key lives ONLY in server config — a request can never supply one.
   * Absent → a run that asks for web search gets an honest `unconfigured`
   * report; URL reads from the message keep working without it.
   */
  tavilyApiKey?: string
  /**
   * Ticket 11 P1 (spec §11 L1574): ACTIVATION_MODE controls whether completed
   * ingestion candidates become active immediately (`auto`, default) or
   * require explicit human review (`review`). `auto` is the default
   * compatibility behavior — existing flows behave unchanged. `review`
   * stores completed candidates as `pending_review` and does NOT change the
   * active version until approval (spec L1574).
   */
  activationMode: "auto" | "review"
  /**
   * Ticket 08 P6 (spec §7 L1535): conversation records expire after this many
   * days of session inactivity. The GC job deletes ALL turns (validated +
   * pending clarification) for sessions whose MAX(created_at) predates the
   * cutoff. Default 30. Answer run traces (answer_run_events table) are NOT
   * affected — they are preserved as long-lived audit history.
   */
  conversationTtlDays: number
  /**
   * Ticket 08 P6: interval between scheduled conversation GC sweeps, in
   * milliseconds. Default 86_400_000 (24h). An eager sweep fires once at
   * startConversationGc invocation so a freshly-booted process cleans stale
   * sessions without waiting for the first tick.
   */
  conversationGcIntervalMs: number
  /**
   * T11 (spec issue #11): Langfuse observability export. When both
   * `langfusePublicKey` and `langfuseSecretKey` are set, the runtime
   * constructs a `RealLangfuseExporter` (requires a Langfuse client to be
   * injected). When either is missing, the factory selects Noop (criterion
   * #1). When exactly one is set, the factory throws at composition time
   * (criterion #2 — fails clearly rather than silently exporting incomplete
   * traces). `langfuseBaseUrl` is optional (Langfuse cloud default applies).
   */
  langfusePublicKey?: string
  langfuseSecretKey?: string
  langfuseBaseUrl?: string
  /** Optional whole-Answer-run model call limit. */
  answerRunMaxModelCalls?: number
  /** Optional whole-run deadline budget in milliseconds; defaults to DEFAULT_RUN_BUDGET_MS. */
  answerRunBudgetMs?: number
  /** Optional whole-Answer-run aggregate token limit. */
  answerRunMaxTokens?: number
  /** Optional whole-Answer-run aggregate cost limit in integer micro-USD. */
  answerRunMaxCostMicros?: number
  /** Optional exact-model pricing table; no provider prices are hardcoded. */
  answerRunModelPricing?: Record<string, {
    inputCostMicrosPerMillionTokens: number
    outputCostMicrosPerMillionTokens: number
  }>
}

function required(key: string): string {
  const v = process.env[key]
  if (!v) throw new Error(`Missing required env var: ${key}`)
  return v
}

let _config: AppConfig | null = null

export const DEFAULT_ES_CHUNK_INDEX = "kefu-rag-chunks"

/** Validate a single physical index, never a wildcard or multi-index target. */
export function resolveChunkIndexName(indexName?: string, config?: Pick<AppConfig, "esChunkIndexName">): string {
  const name = indexName?.trim() || config?.esChunkIndexName?.trim() || DEFAULT_ES_CHUNK_INDEX
  if (name !== name.toLowerCase() || name === "." || name === ".." ||
    /^[\-+_]/.test(name) || /[\\/*?"<>|\s,#:]/.test(name) || Buffer.byteLength(name, "utf8") > 255) {
    throw new Error("ES_CHUNK_INDEX must be a valid single lowercase physical index name")
  }
  return name
}

/**
 * Shared integer env parser. Replaces the three former near-identical
 * validators (positiveInteger / nonNegativeInteger /
 * optionalNonNegativeInteger) with one parameterized helper:
 *   - kind "positive"      → value must be an integer > 0
 *   - kind "non-negative"  → value must be an integer >= 0
 *   - fallback omitted     → unset env yields undefined (optional field)
 */
function integerEnv(
  key: string,
  kind: "positive" | "non-negative",
  fallback: number
): number
function integerEnv(
  key: string,
  kind: "positive" | "non-negative"
): number | undefined
function integerEnv(
  key: string,
  kind: "positive" | "non-negative",
  fallback?: number
): number | undefined {
  if (!process.env[key]) return fallback
  const value = Number(process.env[key])
  if (!Number.isInteger(value) || (kind === "positive" ? value <= 0 : value < 0)) {
    throw new Error(`${key} must be a ${kind} integer`)
  }
  return value
}

/**
 * Shared boolean env parser for opt-in switches, the same shape as integerEnv:
 *   - unset / blank      → the documented default (off for PDF_OCR_FALLBACK_ENABLED)
 *   - 1 / true           → true (case-insensitive, trimmed)
 *   - 0 / false          → false
 *   - anything else      → fails at startup. A safety switch that an operator
 *     meant to turn on must never be silently read as "off" — the same
 *     fail-loudly rule DECISION_PROVIDER applies to an unknown provider.
 */
function booleanEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.trim()
  if (!raw) return fallback
  const value = raw.toLowerCase()
  if (value === "1" || value === "true") return true
  if (value === "0" || value === "false") return false
  // The setting is named in the message; the operator's value is not echoed.
  throw new Error(`${key} must be 1, 0, true or false`)
}

function optionalPricingTable(): AppConfig["answerRunModelPricing"] {
  const raw = process.env.ANSWER_RUN_MODEL_PRICING_JSON
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("ANSWER_RUN_MODEL_PRICING_JSON must be valid JSON")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ANSWER_RUN_MODEL_PRICING_JSON must be an object")
  }
  const table: NonNullable<AppConfig["answerRunModelPricing"]> = {}
  for (const [model, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`ANSWER_RUN_MODEL_PRICING_JSON.${model} must be an object`)
    }
    const input = (value as Record<string, unknown>).inputCostMicrosPerMillionTokens
    const output = (value as Record<string, unknown>).outputCostMicrosPerMillionTokens
    if (!Number.isInteger(input) || (input as number) < 0 ||
      !Number.isInteger(output) || (output as number) < 0) {
      throw new Error(
        `ANSWER_RUN_MODEL_PRICING_JSON.${model} rates must be non-negative integers`
      )
    }
    table[model] = {
      inputCostMicrosPerMillionTokens: input as number,
      outputCostMicrosPerMillionTokens: output as number,
    }
  }
  return table
}

export function loadConfig(): AppConfig {
  if (_config) return _config
  const openaiApiKey = required("OPENAI_API_KEY")
  const openaiBaseUrl = process.env.OPENAI_BASE_URL || ""
  const embeddingDimensions = process.env.EMBEDDING_DIMENSIONS
    ? Number(process.env.EMBEDDING_DIMENSIONS)
    : 1536
  if (!Number.isInteger(embeddingDimensions) || embeddingDimensions <= 0) {
    throw new Error("EMBEDDING_DIMENSIONS must be a positive integer")
  }
  // The demo gate is nominal: a fixed default keeps a fresh clone sign-in-able
  // without any .env setup; DEMO_OIDC_PASSWORD still overrides it.
  const demoOidc = process.env.DEMO_OIDC === "1"
  const demoOidcPassword = process.env.DEMO_OIDC_PASSWORD || "123456"
  const decisionProvider = process.env.DECISION_PROVIDER?.trim() || "chat"
  if (decisionProvider !== "chat" && decisionProvider !== "clef") {
    throw new Error("DECISION_PROVIDER must be chat or clef")
  }
  const cloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || ""
  const cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN?.trim() || ""
  if (decisionProvider === "clef" && (!cloudflareAccountId || !cloudflareApiToken)) {
    const missing = [
      !cloudflareAccountId && "CLOUDFLARE_ACCOUNT_ID",
      !cloudflareApiToken && "CLOUDFLARE_API_TOKEN",
    ].filter(Boolean).join(" and ")
    throw new Error(`${missing} required when DECISION_PROVIDER=clef; set them in .env`)
  }
  const rawDecisionTimeout = process.env.DECISION_REQUEST_TIMEOUT_MS?.trim()
  const decisionRequestTimeoutMs = rawDecisionTimeout ? Number(rawDecisionTimeout) : 10_000
  if (!Number.isSafeInteger(decisionRequestTimeoutMs) || decisionRequestTimeoutMs <= 0 ||
    decisionRequestTimeoutMs > 2_147_483_647) {
    throw new Error("DECISION_REQUEST_TIMEOUT_MS must be a positive integer no greater than 2147483647")
  }
  _config = {
    esNode: process.env.ES_NODE || "http://localhost:9200",
    esApiKey: process.env.ES_API_KEY || "",
    esChunkIndexName: resolveChunkIndexName(process.env.ES_CHUNK_INDEX),
    openaiApiKey,
    openaiBaseUrl,
    openaiChatModel: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
    decisionProvider,
    cloudflareAccountId,
    cloudflareApiToken,
    decisionRequestTimeoutMs,
    embeddingApiKey: process.env.EMBEDDING_API_KEY || openaiApiKey,
    embeddingBaseUrl: process.env.EMBEDDING_BASE_URL || openaiBaseUrl,
    embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
    embeddingDimensions,
    openaiRequestTimeoutMs: integerEnv("OPENAI_REQUEST_TIMEOUT_MS", "positive", 200_000),
    openaiMaxRetries: integerEnv("OPENAI_MAX_RETRIES", "non-negative", 1),
    neo4jUri: process.env.NEO4J_URI || "bolt://localhost:7687",
    neo4jUser: process.env.NEO4J_USER || "neo4j",
    neo4jPassword: process.env.NEO4J_PASSWORD || "",
    sqlitePath: process.env.SQLITE_PATH || "./data/kefu-rag.db",
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 2000,
    claimedTimeoutMs: Number(process.env.CLAIMED_TIMEOUT_MS) || 600000,
    markitdownCommand: process.env.MARKITDOWN_COMMAND || "markitdown",
    ocrAccessKeyId: process.env.VOLC_ACCESSKEY?.trim() || "",
    ocrSecretAccessKey: process.env.VOLC_SECRETKEY?.trim() || "",
    ocrSessionToken: process.env.VOLC_SESSION_TOKEN?.trim() || "",
    pythonCommand: process.env.PYTHON_COMMAND || "python",
    parserTimeoutMs: integerEnv("PARSER_TIMEOUT_MS", "positive", 120_000),
    parserInputLimitBytes: integerEnv("PARSER_INPUT_LIMIT_BYTES", "positive", 20 * 1024 * 1024),
    parserOutputLimitBytes: integerEnv("PARSER_OUTPUT_LIMIT_BYTES", "positive", 20 * 1024 * 1024),
    docreaderAddr: process.env.DOCREADER_ADDR?.trim() || "127.0.0.1:50051",
    docreaderTimeoutMs: integerEnv("DOCREADER_TIMEOUT_MS", "positive", 300_000),
    embeddingBatchMaxChunks: integerEnv("EMBEDDING_BATCH_MAX_CHUNKS", "positive", 64),
    embeddingBatchMaxBytes: integerEnv("EMBEDDING_BATCH_MAX_BYTES", "positive", 150 * 1024),
    ingestionConcurrency: integerEnv("INGESTION_CONCURRENCY", "positive", 2),
    // Ticket 04 (PDF quality): opt-in ingestion switch, off unless the
    // operator asks for it. Read only by the ingestion pipeline's PDF quality
    // gate; never part of a frontend settings payload or a log line.
    pdfOcrFallbackEnabled: booleanEnv("PDF_OCR_FALLBACK_ENABLED", false),
    imageAssetPath: process.env.IMAGE_ASSET_PATH || "./data/image-assets",
    // Ticket 01: DEMO_OIDC=1 forces the enforced identity path. The demo
    // issuer is then the only identity source, so falling back to the
    // token-less single-tenant context would hand every caller the local
    // admin scopes and the demo would never ask anyone to sign in.
    accessMode:
      demoOidc || process.env.ACCESS_MODE === "enforced" ? "enforced" : "single_tenant",
    demoOidc,
    demoOidcPort: integerEnv("DEMO_OIDC_PORT", "positive", 3900),
    demoOidcAudience: process.env.DEMO_OIDC_AUDIENCE || "nexusrag-demo",
    demoOidcPassword,
    // Ticket 03: dedicated rerank provider (defaults match the verified
    // Edgefn endpoint + bge-reranker-v2-m3 protocol; the key has no default
    // — an absent key disables dedicated rerank explicitly).
    rerankApiKey: process.env.RERANK_API_KEY || "",
    rerankBaseUrl: process.env.RERANK_BASE_URL || "https://api.edgefn.net/v1",
    rerankModel: process.env.RERANK_MODEL || "bge-reranker-v2-m3",
    rerankTimeoutMs: integerEnv("RERANK_TIMEOUT_MS", "positive", 30_000),
    rerankMaxDocumentChars: integerEnv("RERANK_MAX_DOCUMENT_CHARS", "positive", 4_000),
    mcpCapabilitiesEnabled: process.env.MCP_CAPABILITIES !== "0",
    // Ticket 36 (WEB-01): optional server-side Tavily key for web search.
    tavilyApiKey: process.env.TAVILY_API_KEY || undefined,
    // Ticket 11 P1 (spec §11 L1574): ACTIVATION_MODE=auto is default; only
    // the literal value "review" activates review mode. Any other value
    // (including unset) falls back to "auto" — same defensive pattern as
    // accessMode above.
    activationMode: process.env.ACTIVATION_MODE === "review" ? "review" : "auto",
    conversationTtlDays: integerEnv("CONVERSATION_TTL_DAYS", "positive", 30),
    conversationGcIntervalMs: integerEnv("CONVERSATION_GC_INTERVAL_MS", "positive", 86_400_000),
    // T11: Langfuse env vars. Both LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY
    // must be set to enable real export; either missing → Noop. The factory
    // (`createLangfuseExporter`) enforces the partial-config-throws rule.
    langfusePublicKey: process.env.LANGFUSE_PUBLIC_KEY || undefined,
    langfuseSecretKey: process.env.LANGFUSE_SECRET_KEY || undefined,
    langfuseBaseUrl: process.env.LANGFUSE_BASE_URL || undefined,
    answerRunMaxModelCalls: integerEnv("ANSWER_RUN_MAX_MODEL_CALLS", "non-negative"),
    answerRunBudgetMs: integerEnv("ANSWER_RUN_BUDGET_MS", "non-negative"),
    answerRunMaxTokens: integerEnv("ANSWER_RUN_MAX_TOKENS", "non-negative"),
    answerRunMaxCostMicros: integerEnv("ANSWER_RUN_MAX_COST_MICROS", "non-negative"),
    answerRunModelPricing: optionalPricingTable(),
  }
  return _config
}
