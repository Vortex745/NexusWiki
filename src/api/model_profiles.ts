/**
 * Ticket 16 (MODEL-01A) — model-profile HTTP API (admin only).
 *
 *   GET  /api/models/profiles              non-secret metadata for the three slots
 *   PATCH /api/models/profiles/:id         { enabled: boolean } — the persisted toggle
 *   GET  /api/models/profiles/:id/config   key-less view of one slot
 *   PUT  /api/models/profiles/:id/config   save Base URL / key / model into .env
 *   POST /api/models/profiles/:id/discover OpenAI-compatible model list
 *   POST /api/models/profiles/:id/test     protocol-specific connectivity test
 *
 * Security envelope:
 *   - list/config payloads NEVER contain a key; a stored key is only reported
 *     as present, and the form treats a blank key as "keep the stored one";
 *   - saves go to the server environment file through the registry, which
 *     preserves every other line (the toggle itself stays in SQLite);
 *   - probes bind to the resolved slot (environment file first), so a
 *     just-saved configuration is exactly what gets tested.
 */

import { Router, type Request, type Response } from "express"
import type OpenAI from "openai"
import { singleTenantAccessContext, type AccessContext } from "../access/context"
import type { AppConfig } from "../config"
import { createOpenAIClient, openaiClientOptions } from "../clients"
import type { TracingRuntime } from "../tracing/contract"
import { createDedicatedReranker } from "../retrieval/search/dedicated_reranker"
import type { RetrievalResult } from "../types/retrieval"
import {
  ModelProfileError,
  ModelProfileRegistry,
  type ModelProfileClients,
  type ModelProfileCredentials,
  type ModelProfileId,
} from "../models/profiles"

function resolveContext(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

function requireAdmin(ctx: AccessContext, res: Response): boolean {
  if (!ctx.scopes.includes("admin")) {
    res.status(403).json({ error: "missing scope: admin" })
    return false
  }
  return true
}

export interface ProfileTestResult {
  ok: boolean
  latencyMs: number | null
  error: string | null
  hint: string | null
}

/** Hard ceiling for one connectivity probe — a settings click never hangs. */
const TEST_TIMEOUT_MS = 15_000

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value
}

/**
 * Turn a provider failure into an actionable message WITHOUT ever echoing the
 * credential. The OpenAI SDK and DedicatedRerankError both keep the key out of
 * their messages; we still truncate and classify rather than pass raw text.
 * The unclassified fallback additionally strips any configured base URL — a
 * deployment that put a credential in its base URL must not leak it through
 * an unexpected provider message.
 */
function classifyProviderError(
  err: unknown,
  redactions: readonly string[] = []
): { error: string; hint: string } {
  const status = (err as { status?: unknown } | null)?.status
  if (status === 401 || status === 403) {
    return {
      error: `authentication failed (HTTP ${String(status)})`,
      hint: "The configured API key was rejected by the provider.",
    }
  }
  if (status === 404) {
    return {
      error: "model or endpoint not found (HTTP 404)",
      hint: "Check the model id and base URL configured in the server environment.",
    }
  }
  if (status === 429) {
    return {
      error: "rate limited (HTTP 429)",
      hint: "The provider is throttling requests; retry later.",
    }
  }
  let message = err instanceof Error ? err.message : String(err)
  for (const url of redactions) {
    if (url) message = message.split(url).join("(server endpoint)")
  }
  if (/timed?\s?out|ETIMEDOUT|timeout/i.test(message)) {
    return {
      error: "connection timed out",
      hint: "The provider did not respond in time; check network and provider status.",
    }
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|certificate/i.test(message)) {
    return {
      error: "could not reach the provider",
      hint: "Check the base URL configured in the server environment and the network.",
    }
  }
  return {
    error: truncate(message, 200),
    hint: "See the server logs for details.",
  }
}

async function timeBoxed<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<{ value?: T; ms: number; error?: unknown }> {
  const start = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
  try {
    const value = await fn(controller.signal)
    return { value, ms: Date.now() - start }
  } catch (error) {
    return { ms: Date.now() - start, error }
  } finally {
    clearTimeout(timer)
  }
}

function okResult(ms: number): ProfileTestResult {
  return { ok: true, latencyMs: ms, error: null, hint: null }
}

function failedResult(err: unknown, redactions: readonly string[] = []): ProfileTestResult {
  const { error, hint } = classifyProviderError(err, redactions)
  return { ok: false, latencyMs: null, error, hint }
}

/** Every configured provider URL — redacted from unexpected provider errors. */
function redactFrom(config: AppConfig, extra?: string): string[] {
  return [config.openaiBaseUrl, config.embeddingBaseUrl, config.rerankBaseUrl, extra ?? ""]
}

function openAiProbeClient(creds: ModelProfileCredentials, config: AppConfig): OpenAI {
  return createOpenAIClient({
    apiKey: creds.apiKey,
    ...(creds.baseUrl ? { baseURL: creds.baseUrl } : {}),
    ...openaiClientOptions(config),
  })
}

/**
 * Chat protocol probe: one minimal completion (max_tokens 1). `models.list()`
 * is deliberately NOT used — several OpenAI-compatible providers don't expose
 * it, so a passing chat path would read as broken.
 */
async function testChatProfile(
  creds: ModelProfileCredentials,
  config: AppConfig,
  bootClient?: OpenAI
): Promise<ProfileTestResult> {
  if (!creds.apiKey) {
    return {
      ok: false,
      latencyMs: null,
      error: "the chat profile has no API key configured",
      hint: "Save an API key on this card (or set OPENAI_API_KEY), then test again.",
    }
  }
  const client = bootClient ?? openAiProbeClient(creds, config)
  const result = await timeBoxed(async (signal) => {
    const completion = await client.chat.completions.create(
      {
        model: creds.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      },
      { signal }
    )
    if (!completion.choices || completion.choices.length === 0) {
      throw new Error("provider returned no choices")
    }
  })
  return result.error
    ? failedResult(result.error, redactFrom(config, creds.baseUrl))
    : okResult(result.ms)
}

/**
 * Embedding protocol probe: embed one short input and verify the vector
 * dimension matches the configured EMBEDDING_DIMENSIONS — a silent mismatch
 * would poison every future vector write, so it must fail loudly here.
 */
async function testEmbeddingProfile(
  creds: ModelProfileCredentials,
  config: AppConfig,
  bootClient?: OpenAI
): Promise<ProfileTestResult> {
  if (!creds.apiKey) {
    return {
      ok: false,
      latencyMs: null,
      error: "the embedding profile has no API key configured",
      hint: "Save an API key on this card (or set EMBEDDING_API_KEY), then test again.",
    }
  }
  const client = bootClient ?? openAiProbeClient(creds, config)
  const result = await timeBoxed(async (signal) => {
    const response = await client.embeddings.create(
      {
        model: creds.model,
        input: "ping",
        // Probe with the production encoding (float, not the SDK base64
        // default) so a provider-side truncation is caught here, not at
        // index time.
        encoding_format: "float",
      },
      { signal }
    )
    const embedding = response.data?.[0]?.embedding
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error("provider returned no embedding vector")
    }
    if (embedding.length !== config.embeddingDimensions) {
      throw new Error(
        `embedding dimension mismatch: provider returned ${embedding.length}, server expects ${config.embeddingDimensions}`
      )
    }
  })
  return result.error
    ? failedResult(result.error, redactFrom(config, creds.baseUrl))
    : okResult(result.ms)
}

/**
 * Rerank protocol probe: reuse the production DedicatedReranker adapter —
 * it IS the protocol (Edgefn `POST {base}/rerank`) with all its response
 * validation, so the test validates exactly what retrieval will call.
 */
async function testRerankProfile(
  creds: ModelProfileCredentials,
  config: AppConfig,
  tracing?: TracingRuntime
): Promise<ProfileTestResult> {
  const reranker = createDedicatedReranker({
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    model: creds.model,
    timeoutMs: TEST_TIMEOUT_MS,
    maxDocumentChars: 1_000,
    ...(tracing ? { tracing } : {}),
  })
  if (!reranker) {
    return {
      ok: false,
      latencyMs: null,
      error: "the rerank profile has no credentials configured",
      hint: "Save an API key on this card (or set RERANK_API_KEY), then test again.",
    }
  }
  // rerank() only reads chunk.content; the remaining fields are irrelevant to
  // the probe and filled with the cheapest legal shape.
  const probe = {
    chunk: { content: "ping" },
    score: 0,
    source: "vector",
    wikilinks: [],
  } as unknown as RetrievalResult
  try {
    const start = Date.now()
    await reranker.rerank("ping", [probe])
    return okResult(Date.now() - start)
  } catch (error) {
    return failedResult(error, redactFrom(config))
  }
}

export interface ModelProfilesRouterDeps {
  registry: ModelProfileRegistry
  config: AppConfig
  clients: ModelProfileClients
  /** LO-12: observe the real rerank probe like any other provider call. */
  tracing?: TracingRuntime
}

/**
 * True when the slot still resolves to the boot config, so the injected
 * runtime client (test seam, tracing/budget wrapper) is the right prober.
 * A saved slot builds a throwaway client from the new values instead.
 */
function usesBootSlot(
  creds: ModelProfileCredentials,
  config: AppConfig,
  kind: "chat" | "embedding"
): boolean {
  const env =
    kind === "chat"
      ? { apiKey: config.openaiApiKey, baseUrl: config.openaiBaseUrl }
      : { apiKey: config.embeddingApiKey, baseUrl: config.embeddingBaseUrl }
  return creds.apiKey === env.apiKey && creds.baseUrl === env.baseUrl
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url : null
  } catch {
    return null
  }
}

export function createModelProfilesRouter(deps: ModelProfilesRouterDeps): Router {
  const router = Router()

  router.get("/models/profiles", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    res.json({ profiles: deps.registry.list() })
  })

  router.patch("/models/profiles/:id", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    const body = (req.body ?? {}) as Record<string, unknown>
    if (typeof body.enabled !== "boolean") {
      res.status(400).json({ error: "body must be { enabled: boolean }" })
      return
    }
    try {
      const profile = deps.registry.setEnabled(String(req.params.id), body.enabled)
      res.json({ profile })
    } catch (error) {
      if (error instanceof ModelProfileError) {
        res.status(error.status).json({ error: error.message, ...(error.hint ? { hint: error.hint } : {}) })
        return
      }
      throw error
    }
  })

  router.get("/models/profiles/:id/config", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    const id = String(req.params.id)
    const profile = deps.registry.get(id)
    if (!profile) {
      res.status(404).json({ error: `unknown model profile "${id}"` })
      return
    }
    res.json({ config: deps.registry.configView(profile.id) })
  })

  /**
   * Persist one slot into the server environment file. A blank/missing API
   * key keeps the stored one — the form never receives the key back, so an
   * empty field cannot mean "erase the credential".
   */
  router.put("/models/profiles/:id/config", async (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    const id = String(req.params.id)
    const profile = deps.registry.get(id)
    if (!profile) {
      res.status(404).json({ error: `unknown model profile "${id}"` })
      return
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : ""
    const parsed = parseHttpUrl(baseUrl)
    if (!parsed || parsed.username || parsed.password) {
      res.status(400).json({
        error: "baseUrl must be an absolute http(s) URL without embedded credentials",
      })
      return
    }
    const model = typeof body.model === "string" ? body.model.trim() : ""
    if (!model) {
      res.status(400).json({ error: "body.model is required" })
      return
    }
    let apiKey: string | undefined
    if (body.apiKey !== undefined && body.apiKey !== null) {
      if (typeof body.apiKey !== "string") {
        res.status(400).json({ error: "body.apiKey must be a string" })
        return
      }
      const trimmed = body.apiKey.trim()
      if (trimmed.length > 512) {
        res.status(400).json({ error: "body.apiKey is too long" })
        return
      }
      if (trimmed) apiKey = trimmed
    }
    try {
      const config = await deps.registry.saveConfig(id, {
        baseUrl,
        model,
        ...(apiKey !== undefined ? { apiKey } : {}),
      })
      res.json({ config })
    } catch (error) {
      if (error instanceof ModelProfileError) {
        res
          .status(error.status)
          .json({ error: error.message, ...(error.hint ? { hint: error.hint } : {}) })
        return
      }
      throw error
    }
  })

  /**
   * Ask an OpenAI-compatible provider which models the credentials may use.
   * Values in the body let the form probe BEFORE saving; omitted fields fall
   * back to the slot's resolved credentials. The rerank slot speaks a
   * dedicated protocol, so its answer is narrowed to ids the provider
   * publishes as rerankers — an empty list is a valid answer there.
   */
  router.post("/models/profiles/:id/discover", async (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    const id = String(req.params.id)
    const profile = deps.registry.get(id)
    if (!profile) {
      res.status(404).json({ error: `unknown model profile "${id}"` })
      return
    }
    const creds = deps.registry.credentials(id as ModelProfileId)
    const body = (req.body ?? {}) as Record<string, unknown>
    const baseUrl =
      typeof body.baseUrl === "string" && body.baseUrl.trim()
        ? body.baseUrl.trim()
        : creds.baseUrl
    const apiKey =
      typeof body.apiKey === "string" && body.apiKey.trim()
        ? body.apiKey.trim()
        : creds.apiKey
    if (baseUrl && !parseHttpUrl(baseUrl)) {
      res.status(400).json({ error: "baseUrl must be an absolute http(s) URL" })
      return
    }
    if (!apiKey) {
      res.json({
        ok: false,
        models: [],
        error: "no API key available",
        hint: "填入 API key 后再检测模型。",
      })
      return
    }
    const client = createOpenAIClient({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
      ...openaiClientOptions(deps.config),
    })
    const result = await timeBoxed(async (signal) => {
      const page = await client.models.list({ signal })
      return page.data
    })
    if (result.error) {
      const { error, hint } = classifyProviderError(result.error, [baseUrl])
      res.json({ ok: false, models: [], error, hint })
      return
    }
    const models = Array.from(
      new Set((result.value ?? []).map((model) => model.id).filter(Boolean))
    ).sort()
    // A reranker can never be a chat or embedding id, so only promise the
    // form what the provider actually publishes as a reranker.
    const discovered =
      profile.kind === "rerank"
        ? models.filter((model) => /rerank/i.test(model))
        : models
    res.json({ ok: true, models: discovered.slice(0, 500) })
  })

  router.post("/models/profiles/:id/test", async (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    const id = String(req.params.id)
    const profile = deps.registry.get(id)
    if (!profile) {
      res.status(404).json({ error: `unknown model profile "${id}"` })
      return
    }
    const creds = deps.registry.credentials(profile.id)
    let result: ProfileTestResult
    if (id === "chat") {
      result = await testChatProfile(
        creds,
        deps.config,
        usesBootSlot(creds, deps.config, "chat") ? deps.clients.chatClient : undefined
      )
    } else if (id === "embedding") {
      result = await testEmbeddingProfile(
        creds,
        deps.config,
        usesBootSlot(creds, deps.config, "embedding")
          ? deps.clients.embeddingClient
          : undefined
      )
    } else {
      result = await testRerankProfile(creds, deps.config, deps.tracing)
    }
    res.json({ id, checkedAt: new Date().toISOString(), ...result })
  })

  return router
}
