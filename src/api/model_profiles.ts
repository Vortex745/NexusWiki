/**
 * Ticket 16 (MODEL-01A) — model-profile HTTP API (admin only).
 *
 *   GET  /api/models/profiles        non-secret metadata for the three slots
 *   PATCH /api/models/profiles/:id   { enabled: boolean } — the only mutation
 *   POST /api/models/profiles/:id/test  protocol-specific connectivity test
 *
 * Security envelope (acceptance criteria 1 & 4):
 *   - the payload is derived from server config and contains NO keys and NO
 *     full provider URLs (host only);
 *   - a request can never inject a base URL, key or model — PATCH toggles the
 *     persisted flag, the test always probes the SERVER's configured slot;
 *   - the routes never write environment files (the toggle lives in SQLite).
 */

import { Router, type Request, type Response } from "express"
import type OpenAI from "openai"
import { singleTenantAccessContext, type AccessContext } from "../access/context"
import type { AppConfig } from "../config"
import { createDedicatedReranker } from "../retrieval/search/dedicated_reranker"
import type { RetrievalResult } from "../types/retrieval"
import {
  ModelProfileError,
  ModelProfileRegistry,
  type ModelProfileClients,
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
function redactFrom(config: AppConfig): string[] {
  return [config.openaiBaseUrl, config.embeddingBaseUrl, config.rerankBaseUrl]
}

/**
 * Chat protocol probe: one minimal completion (max_tokens 1). `models.list()`
 * is deliberately NOT used — several OpenAI-compatible providers don't expose
 * it, so a passing chat path would read as broken.
 */
async function testChatProfile(
  chatClient: OpenAI,
  config: AppConfig
): Promise<ProfileTestResult> {
  const result = await timeBoxed(async (signal) => {
    const completion = await chatClient.chat.completions.create(
      {
        model: config.openaiChatModel,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      },
      { signal }
    )
    if (!completion.choices || completion.choices.length === 0) {
      throw new Error("provider returned no choices")
    }
  })
  return result.error ? failedResult(result.error, redactFrom(config)) : okResult(result.ms)
}

/**
 * Embedding protocol probe: embed one short input and verify the vector
 * dimension matches the configured EMBEDDING_DIMENSIONS — a silent mismatch
 * would poison every future vector write, so it must fail loudly here.
 */
async function testEmbeddingProfile(
  embeddingClient: OpenAI,
  config: AppConfig
): Promise<ProfileTestResult> {
  const result = await timeBoxed(async (signal) => {
    const response = await embeddingClient.embeddings.create(
      { model: config.embeddingModel, input: "ping" },
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
  return result.error ? failedResult(result.error, redactFrom(config)) : okResult(result.ms)
}

/**
 * Rerank protocol probe: reuse the production DedicatedReranker adapter —
 * it IS the protocol (Edgefn `POST {base}/rerank`) with all its response
 * validation, so the test validates exactly what retrieval will call.
 */
async function testRerankProfile(config: AppConfig): Promise<ProfileTestResult> {
  const reranker = createDedicatedReranker({
    baseUrl: config.rerankBaseUrl,
    apiKey: config.rerankApiKey,
    model: config.rerankModel,
    timeoutMs: TEST_TIMEOUT_MS,
    maxDocumentChars: 1_000,
  })
  if (!reranker) {
    return {
      ok: false,
      latencyMs: null,
      error: "the rerank profile has no credentials configured",
      hint: "Set RERANK_API_KEY in the server environment and restart, then enable it.",
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

  router.post("/models/profiles/:id/test", async (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    const id = String(req.params.id)
    const profile = deps.registry.get(id)
    if (!profile) {
      res.status(404).json({ error: `unknown model profile "${id}"` })
      return
    }
    let result: ProfileTestResult
    if (id === "chat") {
      result = await testChatProfile(deps.clients.chatClient, deps.config)
    } else if (id === "embedding") {
      result = await testEmbeddingProfile(deps.clients.embeddingClient, deps.config)
    } else {
      result = await testRerankProfile(deps.config)
    }
    res.json({ id, checkedAt: new Date().toISOString(), ...result })
  })

  return router
}
