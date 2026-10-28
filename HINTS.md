# HINTS — Service Configuration & Environment Conventions

> **Audience:** Operators and agents starting a new session.
> **Purpose:** One-stop reference for environment variables, commands, and runtime conventions.
> **Related:** `AGENTS.md` §1.1 (Session startup loads this file first).

---

## 1. Runtime Environment

| Property | Value |
|----------|-------|
| Node.js | ≥ 20 (uses native `node:test` runner, `AbortController`, `DOMException`) |
| Package manager | npm (lockfile: `package-lock.json`) |
| TypeScript | strict mode (`tsconfig.json`); frontend build: Vite (`npm run build:web`), typecheck: `tsconfig.web.json` |
| Module system | CommonJS (`"type": "commonjs"`) |
| OS | Windows (PowerShell); cross-platform compatible |
| Test runner | `node --import tsx --test src/**/*.test.ts` |

---

## 2. Environment Variables

Copy `.env.example` to `.env` and fill in values. All variables are optional unless marked **required**.

### 2.1 Elasticsearch

| Variable | Default | Required? | Notes |
|----------|---------|-----------|-------|
| `ES_NODE` | `http://localhost:9200` | Required for production | Elasticsearch node URL |
| `ES_API_KEY` | (empty) | Optional | API key for authenticated ES clusters |
| `ES_CHUNK_INDEX` | `kefu-rag-chunks` | Optional | Single lowercase physical chunk index shared by all business readers/writers and maintenance scripts. Trimmed; blank uses default; wildcards/multiple targets fail startup. Explicit isolated eval indices win. |

Retain the old index during a float-mapping migration. `ESStore.ensureIndex()` rejects incompatible numeric mappings before trying to mutate them. Verify full source IDs, contents, access fields and embeddings in the new index before switching `ES_CHUNK_INDEX` and restarting all backend/worker consumers. Once the new index accepts writes, freeze and reconcile increments before any rollback; returning directly to the old index loses updates. `demo:reset` and `demo:rebuild` target the configured index, so review their read-only previews before confirming maintenance.

### 2.2 OpenAI (Chat)

| Variable | Default | Required? | Notes |
|----------|---------|-----------|-------|
| `OPENAI_API_KEY` | — | Required | OpenAI-compatible API key |
| `OPENAI_BASE_URL` | (empty) | Optional | Override for DeepSeek/ModelScope/etc. |
| `OPENAI_CHAT_MODEL` | `gpt-4o-mini` | Required | Chat model ID (deployment-configured; request-level override removed in Ticket 02) |
| `OPENAI_REQUEST_TIMEOUT_MS` | `200000` | Optional | Per-request timeout for every OpenAI-compatible call (chat + embedding) across Answer + ingestion chains. Default 200s; the OpenAI SDK default is 10 minutes |
| `OPENAI_MAX_RETRIES` | `1` | Optional | Per-request retry count (SDK default is 2). Bounds worst-case hang to timeout × (1 + retries) |

### 2.3 Embeddings

| Variable | Default | Required? | Notes |
|----------|---------|-----------|-------|
| `EMBEDDING_API_KEY` | (falls back to `OPENAI_API_KEY`) | Optional | Separate embedding provider key |
| `EMBEDDING_BASE_URL` | (falls back to `OPENAI_BASE_URL`) | Optional | Separate embedding provider URL |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Required | Embedding model ID |
| `EMBEDDING_DIMENSIONS` | `1536` | Required | Embedding vector dimensions |
| `EMBEDDING_BATCH_MAX_CHUNKS` | `64` | Optional | Maximum passages per embedding request; lower if the provider rejects large batches |
| `EMBEDDING_BATCH_MAX_BYTES` | `153600` | Optional | UTF-8 request byte budget (150 KiB); lower if the provider has a smaller payload limit |

### 2.4 Ingestion worker

| Variable | Default | Required? | Notes |
|----------|---------|-----------|-------|
| `INGESTION_CONCURRENCY` | `2` | Optional | Number of documents the background worker may process concurrently; embedding calls remain serialized per shared store |

### 2.5 Answer Run Resource Budgets

| Variable | Default | Required? | Notes |
|----------|---------|-----------|-------|
| `ANSWER_RUN_MAX_MODEL_CALLS` | Unlimited | Optional | Maximum chat + embedding + decision provider calls in one Answer run; `0` rejects the first call |
| `ANSWER_RUN_MAX_TOKENS` | Unlimited | Optional | Maximum aggregate provider-reported tokens in one Answer run |
| `ANSWER_RUN_MAX_COST_MICROS` | Unlimited | Optional | Maximum aggregate cost in integer micro-USD |
| `ANSWER_RUN_MODEL_PRICING_JSON` | — | Required with a cost limit | Exact-model JSON map with `inputCostMicrosPerMillionTokens` and `outputCostMicrosPerMillionTokens`; no prices are built in |

All limits are opt-in. A configured token or cost limit fails closed if the provider does not report usage. A cost limit also fails closed when the exact model is absent from the pricing table.

### 2.6 Neo4j

| Variable | Default | Required? | Notes |
|----------|---------|-----------|-------|
| `NEO4J_URI` | `bolt://localhost:7687` | Required for production | Neo4j bolt URL |
| `NEO4J_USER` | `neo4j` | Required for production | Neo4j username |
| `NEO4J_PASSWORD` | — | Required for production | Neo4j password |

### 2.7 OIDC / Identity (Ticket 05)

| Variable | Default | Required? | Notes |
|----------|---------|-----------|-------|
| `OIDC_ISSUER` | — | Required for `enforced` mode | OIDC issuer URL |
| `OIDC_AUDIENCE` | — | Required for `enforced` mode | Expected token audience |
| `OIDC_JWKS_ENDPOINT` | — | Required for `enforced` mode | JWKS endpoint URL |
| `OIDC_TENANT_CLAIM` | `tenant_id` | Optional | Claim name for tenant ID |
| `OIDC_SUBJECT_CLAIM` | `sub` | Optional | Claim name for subject ID |
| `OIDC_GROUPS_CLAIM` | `groups` | Optional | Claim name for group list |
| `OIDC_SCOPES_CLAIM` | `scope` | Optional | Claim name for scope list |
| `ACCESS_MODE` | `single_tenant` | Optional | `single_tenant` or `enforced` |

When `ACCESS_MODE=single_tenant`, no token is required (backward compat). When `ACCESS_MODE=enforced`, all `/api/chat` and `/api/ingest` requests require a valid RS256 JWT verified by `jose.jwtVerify` against the remote JWKS.

### 2.8 Langfuse (Optional Observability)

| Variable | Default | Required? | Notes |
|----------|---------|-----------|-------|
| `LANGFUSE_PUBLIC_KEY` | — | Optional | When absent, `NoopLangfuseExporter` is used (disabled mode) |
| `LANGFUSE_SECRET_KEY` | — | Optional | When absent, disabled mode |
| `LANGFUSE_BASE_URL` | — | Optional | Self-hosted Langfuse URL |

Langfuse is a DI-seam — the `langfuse` npm package IS a project dependency now. `src/answer/langfuse_client.ts` builds the real client (+ REST fetchTrace read-back) when both keys are set; absent keys keep Noop mode with zero cost.

The op-stack now runs the **v3 line** (`langfuse/langfuse:3` + `langfuse-worker:3` + ClickHouse + Redis + MinIO) because v2 has no OTLP endpoint at all. OTLP is HTTP/protobuf only (no gRPC) at `http://localhost:3000/api/public/otel/v1/traces` with `Authorization: Basic base64(pk:sk)` and `x-langfuse-ingestion-version: 4` (without that header ingestion can lag ~10 min). The worker is mandatory: web writes events to MinIO + Redis and the worker lands them in ClickHouse, so running web alone gives an empty trace store.

Probes: `node --import tsx scripts/otel-otlp-probe.ts` (real OTel SDK → OTLP → readback; the one the compatibility gate depends on) and `node --import tsx scripts/langfuse-compat-probe.ts` (legacy SDK ingestion path, kept for comparison). Evidence: `.scratch/logging-observability-tickets/evidence/LO-01/`.

### 2.8b Runtime logs (LO-03)

| Variable | Default | Required? | Notes |
|----------|---------|-----------|-------|
| `LOG_LEVEL` | `info` | Optional | `debug` \| `info` \| `warn` \| `error` \| `off`. Structured JSON on **stdout only** (Pino, one record per line, 8 KiB ceiling with a `truncated` marker). `off` returns a silent logger — the same path as an un-injected logger, so it is a safe rollback. |

Business code depends on the neutral `Logger` in `src/logging/logger.ts`; only `src/logging/pino_logger.ts` may import `pino`. Credentials (auth headers, cookies, keys, passwords, private keys) are redacted before serialization. A full stdout pipe makes the producer wait for `drain` — the logger never buffers without bound.

### 2.8c Tracing (LO-05, OpenTelemetry → Langfuse OTLP)

| Variable | Default | Required? | Notes |
|----------|---------|-----------|-------|
| `TRACING_ENABLED` | off | Optional | Must be `1`/`true`. Off means a `NoopTracingRuntime` — no exporter, no queue, no samples. |
| `LANGFUSE_SAMPLE_RATE` | `1` | Optional | `0` → off; `1` → every root; in between → trace-id ratio. **Illegal values (`abc`, `1.5`, `-0.1`) turn tracing OFF with a diagnostic warning** rather than sampling unexpectedly. |
| `LANGFUSE_BASE_URL` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | — | Required when enabled | Auth is HTTP Basic `pk:sk`; the OTLP path is `/api/public/otel/v1/traces`. |

Business code depends on `src/tracing/contract.ts` only; `@opentelemetry/*` imports are confined to `src/tracing/{composition,otel_runtime,bounded_processor}.ts` (a test enforces this). Sampling happens once at the root (`ParentBasedSampler` + ratio) and children inherit; the exporter never samples again. The buffer is our own bounded processor: drop-newest on overflow, counters in `runtime.diagnostics()`, one in-flight export, per-batch timeout, bounded `flush`/`shutdown`. Attribute ceiling is 2 KiB per ordinary attribute; `langfuse.observation.input/output` use a 1 MiB content ceiling (Generation content is not a log line).

### 2.9 Mastra Promotion

| Variable | Default | Required? | Notes |
|----------|---------|-----------|-------|
| `MASTRA_PROMOTION_ARTIFACT` | — | Optional | Path to a release verification artifact JSON. When present, the Mastra runtime starts in `live` mode; otherwise `shadow` mode. |

### 2.10 Question-Routing Decision Provider

| Variable | Default | Required? | Notes |
|----------|---------|-----------|-------|
| `DECISION_PROVIDER` | `chat` | Optional | Accepts only `chat` or `clef`; selects the question router shared by normal chat and evaluation |
| `CLOUDFLARE_ACCOUNT_ID` | (empty) | Required for `clef` | Cloudflare account ID; server-side only |
| `CLOUDFLARE_API_TOKEN` | (empty) | Required for `clef` | Cloudflare Workers AI Bearer token; store only in local `.env` |
| `DECISION_REQUEST_TIMEOUT_MS` | `10000` | Optional | Per-decision ceiling in integer milliseconds, from `1` through `2147483647`; caller cancellation and the run deadline also apply |

Clef routes `direct / simple / ambiguous / complex` with the fixed model `@cf/cloudflare/clef`. Both credentials are required at startup when selected. Settings are trimmed; blank provider or timeout uses its default. Keep credential values out of templates, logs, frontend settings, and config exports. Answer generation continues to use the OpenAI Chat configuration.

Clef calls share the Answer run budgets. With a cost limit, add the exact `@cf/cloudflare/clef` key to `ANSWER_RUN_MODEL_PRICING_JSON`. Change `DECISION_PROVIDER` back to `chat` and restart the backend to restore the Chat router.

### 2.11 OCR (Volcengine OCRPdf)

| Variable | Required? | Notes |
|----------|-----------|-------|
| `VOLC_ACCESSKEY` | For OCR | Server-side Access Key ID |
| `VOLC_SECRETKEY` | For OCR | Server-side Secret Access Key; not an Ark/OpenAI API key |
| `VOLC_SESSION_TOKEN` | For STS only | Session token accompanying temporary AK/SK |

Enable intelligent document parsing on the Volcengine account, configure the credentials in local `.env`, and restart the backend. Images use `ocr-api`; scanned PDFs select **OCR API** in the import advanced options. Default PDF imports extract the text layer with `builtin-pdf`. Historical `marker/mineru` overrides map to `ocr-api`; production does not construct those CLI OCR runtimes.

OCR calls use `https://visual.volcengineapi.com`, Action `OCRPdf`, Version `2021-08-23`, body version `v3`, region `cn-north-1`, service `cv`. The adapter reads PDF page counts and splits at 16 pages and 8 MiB of encoded form data. A single oversized page/image fails explicitly. The existing `PARSER_TIMEOUT_MS` (120000) bounds the whole document; input/output limits default to 20 MiB each. No TOS bucket is required.

Raw responses, page IDs and coordinates are retained as extraction evidence. Header/footer/footnote filtering is disabled. OCR results carry `ocr_content_unverified` — transport success and page coverage never prove semantic accuracy. Under the `ocr-advisory-v1` activation policy, that sole generic warning is accepted as a non-blocking warning and the candidate may activate **only after every index, binding and search-visibility check passes**; the raw content proof stays `pending_review` and the acceptance fact is recorded separately in `candidate_evidence.activationAcceptance`. Any additional OCR warning (missing/empty pages, layout, table or image semantics, text corruption) keeps the candidate pending review, and a mixed/unknown/blank reason set is never accepted. Missing credentials/auth failures do not automatically retry or fall back to another OCR engine. Decision record: `.scratch/ocr-activation-relaxation-2026-10-26/plan.md`; supersedes the earlier "all OCR must block activation" rule in this section. `npm run release:smoke` includes a live OCR probe using a fixed synthetic PDF when credentials are configured.

---

## 3. Common Commands

```bash
# Development
npm run dev                    # Start backend in dev mode (tsx watch)
npm run dev:web                # Vite dev server for the frontend
npm run ingest                 # Run ingestion CLI

# Build
npm run build                  # TypeScript compile (tsc)
npm run build:web              # Vite production build (frontend + Tailwind)
npm run typecheck:web          # Frontend TypeScript check only
npm run preview:web            # Preview the built frontend

# Test
npm test                       # Full test suite (node:test + tsx)
node --import tsx --test <file># Focused test file

# `npm test` promotes ONLY the parser commands from .env (scripts/test-env.ts):
# PYTHON_COMMAND / MARKITDOWN_COMMAND / MARKER_COMMAND / MINERU_COMMAND.
# Without a Python that has PyMuPDF, the PDF tests fail with
# "PyMuPDF is required". Point PYTHON_COMMAND at one that does, e.g.
#   PYTHON_COMMAND=E:/miniconda3/python.exe
# Credentials and DEMO_OIDC are deliberately NOT loaded from .env in tests.
# Focused runs need the same promotion:
#   node --import tsx --import ./scripts/test-env.ts --test <file>

# `npm test` caps file concurrency at 8 (--test-concurrency=8). The parser
# suites spawn a Node process per fixture; at 12-way parallelism (one per CPU)
# those spawns starve and hit their own timeouts, which reads as flaky tests.

# Logging/tracing evidence (needs the local stack for the readback):
node --import tsx scripts/lo20-route-matrix.ts   # 113 routes: root vs excluded
node --import tsx scripts/lo19-readback.ts       # OTLP -> Langfuse readback

# Release verification (Tickets 03-04)
npm run release:verify:local   # Run 6 local release gates
npm run release:verify:production  # Run production release gates
npm run release:promotion-check    # Validate release artifact promotion contract
```

---

## 4. Database

- **Engine:** SQLite (`better-sqlite3`)
- **Files:** `data/kefu-rag.db` (main), `data/kefu-rag-acceptance.db` (acceptance tests)
- **Schema:** `src/ingestion/tracking/db.ts` — idempotent `CREATE TABLE IF NOT EXISTS` statements
- **Migrations:** Additive only; follow the `key without new attributes + DEFAULT fallback + ALTER idempotency` pattern (see `MEMORY.md`)

---

## 5. External Services

| Service | Purpose | When Required |
|---------|---------|---------------|
| Elasticsearch | Vector + BM25 retrieval, PageIndex | Production, acceptance tests |
| Neo4j | GraphRAG provenance | Production, acceptance tests |
| OpenAI-compatible API | Chat + embeddings | Always (dev + prod) |
| Cloudflare Workers AI | Clef question routing | When `DECISION_PROVIDER=clef` |
| MarkItDown | Document ingestion (raw file → normalized blocks) | Ingestion; Ticket 09 will repair ABI |
| Volcengine OCRPdf | PDF/image recognition and structured extraction | Images + PDF OCR override; server-side AK/SK required |
| Langfuse | Observability / trace export | Optional (disabled by default) |

---

## 6. Known Gotchas

- **Windows PowerShell:** `*>` captures all streams; `2>&1 > file` does NOT work (different from bash). Use `*> file` or `| Out-String`.
- **Node test runner:** `node --import tsx --test` outputs to TTY; PowerShell pipe `| Select-String` may miss lines. Use `| Out-String` first.
- **Elasticsearch client:** Multiple construction sites exist (`process_runtime.ts`, `ingestion/storage/index.ts`, `ingestion/storage/store.ts`) — known architectural debt (the historical `docs/dormant-surface-audit.md` audit was deleted; the debt is documented inline here and in `src/runtime/p8_3_runtime_integration.test.ts` for ProcessRuntime).
- **ProcessRuntime:** Two production construction sites (`api/server.ts`, `answer/runtime.ts`) — documented in `src/runtime/p8_3_runtime_integration.test.ts`.
- **CRLF warnings:** `git diff --check` on Windows emits CRLF warnings; these are NOT errors (exit code 0).

---

## 7. Repository Navigation

- **`src/frontend/` is the `@core` shared conversation core** — plain TypeScript consumed by the React app through the Vite alias `@core` (see `vite.config.ts`). It is live wiring, not a stale frontend copy.
- **Current ticket state** lives in untracked scratch: `.scratch/upload-integrity-tickets/README.md` (UT-series work); retro guardrail tickets in `.scratch/retro-guardrails/README.md`.
- **Contract assertions live in tests, not docs:** dependency contracts in `src/frontend/app.contract.test.ts`; dormant-surface policy (deliberately unwired modules, e.g. `src/api/models.ts`) in `src/release/dormant_surface_audit.test.ts`. Check both before deleting anything.
- **Push gate:** `githooks/pre-push` runs build + `typecheck:web` + the test suite. After a fresh clone run `git config core.hooksPath githooks` to arm it. Escape a single push deliberately with `git push --no-verify`; on POSIX clones re-arm the exec bit with `git update-index --chmod=+x githooks/pre-push`.
