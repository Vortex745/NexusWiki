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
import { choice, TypeSafeClient } from "@typesafe-ai/sdk"
import { normalizeTypeSafeBaseUrl } from "../typesafe/base_url"
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
import {
  WorkspaceModelProfileStore,
  WorkspaceProfileError,
  type WorkspaceProfileView,
} from "../models/workspace_profiles"

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
  /** Embedding only: the vector length the provider actually returned. */
  dimensions?: number
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
  return [config.openaiBaseUrl, config.embeddingBaseUrl, config.rerankBaseUrl, config.typesafeBaseUrl ?? "", extra ?? ""]
}

function typeSafeClient(creds: ModelProfileCredentials): TypeSafeClient {
  return new TypeSafeClient({
    apiKey: creds.apiKey,
    baseURL: normalizeTypeSafeBaseUrl(creds.baseUrl || "https://api.typesafe.ai"),
    defaultModel: creds.model || "jev-latest",
    timeout: TEST_TIMEOUT_MS,
    retry: { maxRetries: 0 },
  })
}

async function testTypeSafeProfile(creds: ModelProfileCredentials): Promise<ProfileTestResult> {
  if (!creds.apiKey) {
    return {
      ok: false,
      latencyMs: null,
      error: "the TypeSafe profile has no API key configured",
      hint: "Save an API key on this card (or set TYPESAFE_API_KEY), then test again.",
    }
  }
  const result = await timeBoxed(async (signal) => {
    const client = typeSafeClient(creds)
    const response = await client.systemOne(
      {
        state: "ping",
        questions: { reachable: choice("Return the reachable label.", { reachable: null }) },
      },
      { signal, timeout: TEST_TIMEOUT_MS, retry: { maxRetries: 0 } },
    )
    if (!response.answers?.reachable || response.answers.reachable.type !== "choice") {
      throw new Error("TypeSafe returned no typed answer")
    }
  })
  return result.error
    ? failedResult(result.error, [creds.baseUrl])
    : okResult(result.ms)
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
  expectedDimensions?: number,
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
  let observed: number | null = null
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
    observed = embedding.length
    if (expectedDimensions !== undefined && embedding.length !== expectedDimensions) {
      throw new Error(
        `embedding dimension mismatch: provider returned ${embedding.length}, configured ${expectedDimensions}`
      )
    }
  })
  if (result.error) {
    return {
      ...failedResult(result.error, redactFrom(config, creds.baseUrl)),
      ...(observed !== null ? { dimensions: observed } : {}),
    }
  }
  return {
    ...okResult(result.ms),
    ...(observed !== null ? { dimensions: observed } : {}),
  }
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

/**
 * The slice of `WorkspaceModelProfileStore` the HTTP layer needs. Tests that
 * only exercise the server path omit it and get a read-only server adapter.
 */
export interface ModelSettingsStore {
  isWorkspace(tenantId: string): boolean
  requiresEmbeddingSetup(tenantId: string): boolean
  list(tenantId: string): WorkspaceProfileView[]
  configView(tenantId: string, id: ModelProfileId): import("../models/workspace_profiles").WorkspaceConfigView
  credentials(
    tenantId: string,
    id: ModelProfileId
  ): ModelProfileCredentials & { dimensions: number | null }
  save(
    tenantId: string,
    id: string,
    save: import("../models/workspace_profiles").WorkspaceProfileSave
  ): import("../models/workspace_profiles").WorkspaceConfigView
  setEnabled(tenantId: string, id: string, enabled: boolean): WorkspaceProfileView
}

export interface ModelProfilesRouterDeps {
  registry: ModelProfileRegistry
  /** Per-workspace settings; omitted in bare server-path tests. */
  workspace?: ModelSettingsStore
  config: AppConfig
  clients: ModelProfileClients
  /** LO-12: observe the real rerank probe like any other provider call. */
  tracing?: TracingRuntime
  /** Create the workspace's default knowledge base after its embedding save. */
  ensureWorkspaceKnowledgeBase?: (tenantId: string) => void
}

function serverOnlyWorkspace(
  registry: ModelProfileRegistry,
  config: AppConfig
): ModelSettingsStore {
  const reject = (): never => {
    throw new WorkspaceProfileError(
      "the server configuration is managed by the environment file",
      403,
      "Only private workspaces can save model settings here."
    )
  }
  return {
    isWorkspace: () => false,
    requiresEmbeddingSetup: () => false,
    list: () => serverProfiles(registry),
    configView: (_tenantId, id) => ({
      ...registry.configView(id),
      editable: false,
      source: "server",
    }),
    credentials: (_tenantId, id) => ({
      ...registry.credentials(id),
      dimensions: id === "embedding" ? config.embeddingDimensions : null,
    }),
    save: reject,
    setEnabled: reject,
  }
}

function serverProfiles(registry: ModelProfileRegistry): WorkspaceProfileView[] {
  return registry.list().map((profile) => ({ ...profile, source: "server" as const }))
}

function sendProfileError(res: Response, error: unknown): boolean {
  if (error instanceof ModelProfileError || error instanceof WorkspaceProfileError) {
    res.status(error.status).json({
      error: error.message,
      ...(error.hint ? { hint: error.hint } : {}),
    })
    return true
  }
  return false
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
  const workspace = deps.workspace ?? serverOnlyWorkspace(deps.registry, deps.config)

  const isWorkspace = (tenantId: string) => workspace.isWorkspace(tenantId)

  const credentialsFor = (tenantId: string, id: ModelProfileId): ModelProfileCredentials => {
    const resolved = workspace.credentials(tenantId, id)
    return { apiKey: resolved.apiKey, baseUrl: resolved.baseUrl, model: resolved.model }
  }

  const profileExists = (tenantId: string, id: string): boolean =>
    isWorkspace(tenantId)
      ? workspace.list(tenantId).some((profile) => profile.id === id)
      : deps.registry.get(id) !== undefined

  const dimensionsOf = (tenantId: string, id: ModelProfileId): number | undefined => {
    if (id !== "embedding") return undefined
    return workspace.credentials(tenantId, id).dimensions ?? undefined
  }

  router.get("/models/profiles", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    res.json({
      profiles: isWorkspace(ctx.tenantId)
        ? workspace.list(ctx.tenantId)
        : serverProfiles(deps.registry),
      requiresEmbeddingSetup: workspace.requiresEmbeddingSetup(ctx.tenantId),
    })
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
      const profile = isWorkspace(ctx.tenantId)
        ? workspace.setEnabled(ctx.tenantId, String(req.params.id), body.enabled)
        : deps.registry.setEnabled(String(req.params.id), body.enabled)
      res.json({ profile })
    } catch (error) {
      if (sendProfileError(res, error)) return
      throw error
    }
  })

  router.get("/models/profiles/:id/config", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    const id = String(req.params.id)
    if (!profileExists(ctx.tenantId, id)) {
      res.status(404).json({ error: `unknown model profile "${id}"` })
      return
    }
    if (isWorkspace(ctx.tenantId)) {
      res.json({ config: workspace.configView(ctx.tenantId, id as ModelProfileId) })
      return
    }
    const view = deps.registry.configView(id as ModelProfileId)
    res.json({ config: { ...view, editable: false } })
  })

  /**
   * Persist one slot. Private workspaces write their own SQLite row; the
   * demo/single tenant keeps writing the server environment file. A blank key
   * keeps the stored one — the form never receives the key back.
   */
  router.put("/models/profiles/:id/config", async (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    const id = String(req.params.id)
    if (!profileExists(ctx.tenantId, id)) {
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
    let dimensions: number | undefined
    if (body.dimensions !== undefined && body.dimensions !== null) {
      if (
        typeof body.dimensions !== "number" ||
        !Number.isInteger(body.dimensions) ||
        body.dimensions <= 0 ||
        body.dimensions > 100_000
      ) {
        res.status(400).json({ error: "body.dimensions must be a positive integer" })
        return
      }
      dimensions = body.dimensions
    }
    try {
      if (isWorkspace(ctx.tenantId)) {
        const config = workspace.save(ctx.tenantId, id, {
          baseUrl,
          model,
          ...(apiKey !== undefined ? { apiKey } : {}),
          ...(dimensions !== undefined ? { dimensions } : {}),
        })
        // Only the embedding save defines this workspace's vector space; a
        // Chat save before Embedding must not try to create a knowledge base
        // it cannot stamp yet.
        if (id === "embedding") deps.ensureWorkspaceKnowledgeBase?.(ctx.tenantId)
        res.json({ config })
        return
      }
      const config = await deps.registry.saveConfig(id, {
        baseUrl,
        model,
        ...(apiKey !== undefined ? { apiKey } : {}),
      })
      res.json({ config })
    } catch (error) {
      if (sendProfileError(res, error)) return
      throw error
    }
  })

  /**
   * Ask the configured provider which models the credentials may use.
   * Values in the body let the form probe BEFORE saving; omitted fields fall
   * back to the slot's resolved credentials. The rerank slot speaks a
   * dedicated protocol, so its answer is narrowed to ids the provider
   * publishes as rerankers — an empty list is a valid answer there.
   */
  router.post("/models/profiles/:id/discover", async (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    const id = String(req.params.id)
    if (!profileExists(ctx.tenantId, id)) {
      res.status(404).json({ error: `unknown model profile "${id}"` })
      return
    }
    const creds = credentialsFor(ctx.tenantId, id as ModelProfileId)
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
    if (id === "typesafe") {
      const typeSafeCreds: ModelProfileCredentials = {
        apiKey,
        baseUrl,
        model: typeof body.model === "string" && body.model.trim() ? body.model.trim() : creds.model,
      }
      const result = await timeBoxed(async (signal) => {
        const page = await typeSafeClient(typeSafeCreds).models.list({
          signal,
          timeout: TEST_TIMEOUT_MS,
          retry: { maxRetries: 0 },
        })
        return page
      })
      if (result.error) {
        const { error, hint } = classifyProviderError(result.error, [baseUrl])
        res.json({ ok: false, models: [], error, hint })
        return
      }
      const models = Array.from(new Set((result.value ?? []).map((model) => model.name).filter(Boolean))).sort()
      res.json({ ok: true, models: models.slice(0, 500) })
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
      id === "rerank"
        ? models.filter((model) => /rerank/i.test(model))
        : models
    res.json({ ok: true, models: discovered.slice(0, 500) })
  })

  router.post("/models/profiles/:id/test", async (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return
    const id = String(req.params.id)
    if (!profileExists(ctx.tenantId, id)) {
      res.status(404).json({ error: `unknown model profile "${id}"` })
      return
    }
    const saved = credentialsFor(ctx.tenantId, id as ModelProfileId)
    const body = (req.body ?? {}) as Record<string, unknown>
    const creds: ModelProfileCredentials = {
      apiKey:
        typeof body.apiKey === "string" && body.apiKey.trim()
          ? body.apiKey.trim()
          : saved.apiKey,
      baseUrl:
        typeof body.baseUrl === "string" && body.baseUrl.trim()
          ? body.baseUrl.trim()
          : saved.baseUrl,
      model:
        typeof body.model === "string" && body.model.trim()
          ? body.model.trim()
          : saved.model,
    }
    const expectedDimensions =
      typeof body.dimensions === "number" && Number.isInteger(body.dimensions) && body.dimensions > 0
        ? body.dimensions
        : dimensionsOf(ctx.tenantId, id as ModelProfileId)
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
        expectedDimensions,
        usesBootSlot(creds, deps.config, "embedding")
          ? deps.clients.embeddingClient
          : undefined
      )
    } else if (id === "rerank") {
      result = await testRerankProfile(creds, deps.config, deps.tracing)
    } else {
      result = await testTypeSafeProfile(creds)
    }
    res.json({ id, checkedAt: new Date().toISOString(), ...result })
  })

  return router
}
