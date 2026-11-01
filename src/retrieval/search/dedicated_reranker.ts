/**
 * Eval refactor Ticket 03 — Dedicated rerank adapter.
 *
 * Replaces the former Chat-per-fragment scoring (`reranker.ts`) with the
 * user-specified dedicated rerank service. The protocol below was verified
 * against the live endpoint (Edgefn, model `bge-reranker-v2-m3`) on
 * 2026-09-21 with a public short-text probe:
 *
 *   POST {baseUrl}/rerank
 *   { "model": "<model>", "query": "<query>", "documents": ["...", "..."] }
 *   → 200 { "id": "...", "results": [ { "index": 0, "document": null,
 *             "relevance_score": 0.9951 }, ... ],
 *           "meta": { "tokens": { "input_tokens": 102, "output_tokens": 0 } } }
 *
 * Notes from the probe:
 *   - `top_n` shortens the response (candidates would be silently dropped),
 *     so it is NOT sent: every candidate comes back ranked.
 *   - The nested `input` object form is rejected (400 "query is required").
 *   - `meta.tokens.input_tokens` is the billable usage reported by the
 *     provider; when absent, usage is recorded as UNKNOWN (never zeroed).
 *
 * Boundary rules (ticket 03 acceptance):
 *   - malformed responses (non-array results, illegal/duplicate index,
 *     non-finite score) reject explicitly instead of returning a silently
 *     reordered list;
 *   - cancellation is never swallowed — an aborted signal rejects;
 *   - the API key never appears in an error message;
 *   - provider calls reserve/settle the run resource budget exactly like the
 *     OpenAI surfaces do (kind "rerank").
 */

import type { RetrievalResult } from "../../types"
import {
  getCurrentRunContext,
  recordModelUsage,
  reserveModelCall,
  type ModelUsage,
} from "../../runtime/run_context"
import type { Reranker } from "./interface"
import type { TracingRuntime } from "../../tracing/contract"

export type { Reranker }

/** Provider/model defaults verified against the live endpoint. */
export const DEFAULT_RERANK_MODEL = "bge-reranker-v2-m3"

/** Per-call hard ceiling: a hung provider cannot hold retrieval open. */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Max characters per candidate sent to the reranker. Keeps one pathological
 * chunk from inflating the request; the provider itself scores the prefix.
 */
const DEFAULT_MAX_DOCUMENT_CHARS = 4_000

/** LO-12 content rules: previews, never the whole candidate set or score list. */
const RERANK_PREVIEW_DOCUMENTS = 8
const RERANK_PREVIEW_CHARS = 160
const RERANK_MAX_SCORES = 50

export interface DedicatedRerankerOptions {
  baseUrl: string
  apiKey: string
  model?: string
  timeoutMs?: number
  maxDocumentChars?: number
  /** Injectable transport for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /**
   * LO-12: model observation. One real provider call becomes one Generation
   * (query in full, top-8 document previews, at most 50 scores, provider
   * usage). No call → no record.
   */
  tracing?: TracingRuntime
}

/** A rerank failure with the provider's status (never the credential). */
export class DedicatedRerankError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = "DedicatedRerankError"
  }
}

interface RerankScore {
  index: number
  score: number
}

/**
 * Build the adapter from deployment config. Returns undefined when no key is
 * configured — callers must treat that as "no dedicated reranker" (fused
 * order + explicit reason), NOT as "use some other scorer".
 */
export function createDedicatedReranker(
  options: DedicatedRerankerOptions
): DedicatedReranker | undefined {
  if (!options.apiKey?.trim()) return undefined
  return new DedicatedReranker(options)
}

export class DedicatedReranker implements Reranker {
  readonly model: string
  private readonly endpoint: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly maxDocumentChars: number
  private readonly fetchImpl: typeof fetch
  private readonly tracing: TracingRuntime | undefined

  constructor(options: DedicatedRerankerOptions) {
    if (!options.apiKey?.trim()) {
      throw new Error("dedicated reranker requires a non-empty API key")
    }
    if (!options.baseUrl?.trim()) {
      throw new Error("dedicated reranker requires a base URL")
    }
    this.model = options.model?.trim() || DEFAULT_RERANK_MODEL
    this.endpoint = `${options.baseUrl.replace(/\/+$/, "")}/rerank`
    this.apiKey = options.apiKey
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxDocumentChars = options.maxDocumentChars ?? DEFAULT_MAX_DOCUMENT_CHARS
    this.fetchImpl = options.fetchImpl ?? fetch
    this.tracing = options.tracing
  }

  async rerank(
    query: string,
    results: RetrievalResult[],
    signal?: AbortSignal
  ): Promise<RetrievalResult[]> {
    if (results.length === 0) return results

    // The external cancel and the provider ceiling are combined: whichever
    // fires first aborts the request, and the rejection propagates (an
    // aborted signal must never look like a mere rerank degradation).
    const effectiveSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.timeout(this.timeoutMs)

    const ctx = getCurrentRunContext()
    const reservation = ctx
      ? reserveModelCall(ctx, { kind: "rerank", model: this.model })
      : undefined

    // The observation is created only after the budget reservation: a refusal
    // means no provider call happened, so no Generation may be recorded.
    const observation = this.tracing?.observeModel({
      name: "rerank",
      model: this.model,
      provider: "rerank",
      input: {
        query,
        // Full query, bounded previews: the request can carry 60 candidates
        // and the observation must not become the document store.
        documents: results.slice(0, RERANK_PREVIEW_DOCUMENTS).map((result) =>
          truncate(result.chunk.content, RERANK_PREVIEW_CHARS)
        ),
        documentCount: results.length,
      },
      stream: false,
    })

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          query,
          documents: results.map((result) =>
            truncate(result.chunk.content, this.maxDocumentChars)
          ),
        }),
        signal: effectiveSignal,
      })

      if (!response.ok) {
        const detail = await describeFailureBody(response)
        throw new DedicatedRerankError(
          `dedicated rerank failed with HTTP ${response.status}${detail}`,
          response.status
        )
      }

      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw new DedicatedRerankError("malformed rerank response: body is not JSON")
      }

      const scores = parseRerankScores(body, results.length)
      const usage = extractRerankUsage(body)
      if (ctx && reservation) {
        // Unknown usage stays unknown: with a token/cost budget configured the
        // budget layer fails closed instead of inventing zeros.
        recordModelUsage(ctx, reservation, usage)
      }
      observation?.end({
        status: "ok",
        output: { scores: scores.slice(0, RERANK_MAX_SCORES) },
        ...(usage ? { usage } : {}),
      })
      return applyRerankOrder(results, scores)
    } catch (error) {
      // Abort/timeout is a cancellation, not a provider failure; the caller's
      // error object is rethrown unchanged either way.
      const cancelled = error instanceof Error
        && (error.name === "AbortError" || error.name === "TimeoutError")
      observation?.end({
        status: cancelled ? "cancelled" : "error",
        message: error instanceof Error ? error.message : "rerank failed",
      })
      throw error
    }
  }
}

async function describeFailureBody(response: Response): Promise<string> {
  // Server diagnostics ("InvalidRequestBody" / "invalid api key") are useful
  // for the operator and never contain the request credential; they are
  // best-effort and bounded so an HTML error page cannot flood the log.
  try {
    const text = await response.text()
    if (!text) return ""
    let detail = text
    try {
      const parsed = JSON.parse(text) as { reason?: unknown; message?: unknown }
      const reason = typeof parsed.reason === "string" ? parsed.reason : undefined
      const message = typeof parsed.message === "string" ? parsed.message : undefined
      detail = [reason, message].filter(Boolean).join(": ") || text
    } catch {
      // Non-JSON body — use the raw text.
    }
    return ` (${truncate(detail, 200)})`
  } catch {
    return ""
  }
}

function truncate(value: string, maxChars: number): string {
  const text = value ?? ""
  return text.length > maxChars ? text.slice(0, maxChars) : text
}

/**
 * Validate the provider payload into `{index, score}` pairs. Every rule
 * fails loudly: an out-of-range or duplicated index means the provider's
 * identity mapping cannot be trusted, and a non-finite score would poison
 * both the ordering and the downstream metrics.
 */
function parseRerankScores(body: unknown, candidateCount: number): RerankScore[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new DedicatedRerankError("malformed rerank response: body must be an object")
  }
  const rawResults = (body as { results?: unknown }).results
  if (!Array.isArray(rawResults)) {
    throw new DedicatedRerankError("malformed rerank response: results must be an array")
  }
  const seen = new Set<number>()
  return rawResults.map((entry, position) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new DedicatedRerankError(
        `malformed rerank response: result ${position} must be an object`
      )
    }
    const { index, relevance_score: relevanceScore } = entry as {
      index?: unknown
      relevance_score?: unknown
    }
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= candidateCount) {
      throw new DedicatedRerankError(
        `malformed rerank response: result ${position} has illegal index ${String(index)} (candidates: ${candidateCount})`
      )
    }
    if (seen.has(index as number)) {
      throw new DedicatedRerankError(
        `malformed rerank response: duplicate index ${String(index)}`
      )
    }
    if (typeof relevanceScore !== "number" || !Number.isFinite(relevanceScore)) {
      throw new DedicatedRerankError(
        `malformed rerank response: result ${position} has non-finite score ${String(relevanceScore)}`
      )
    }
    seen.add(index as number)
    return { index: index as number, score: relevanceScore }
  })
}

/** Provider-reported usage, or undefined when the provider omits it. */
function extractRerankUsage(body: unknown): ModelUsage | undefined {
  const meta = (body as { meta?: unknown } | null)?.meta
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined
  const tokens = (meta as { tokens?: unknown }).tokens
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return undefined
  const input = (tokens as { input_tokens?: unknown }).input_tokens
  const output = (tokens as { output_tokens?: unknown }).output_tokens
  if (!Number.isInteger(input) || (input as number) < 0) return undefined
  const completionTokens =
    Number.isInteger(output) && (output as number) >= 0 ? (output as number) : 0
  return {
    promptTokens: input as number,
    completionTokens,
    totalTokens: (input as number) + completionTokens,
  }
}

/**
 * Publish the provider's ordering while keeping every candidate identity:
 * scored candidates first (descending score, ties keep the fused order),
 * then — if the provider scored only a prefix — the remaining candidates in
 * their fused order. Nothing is dropped, so evaluation never gains from a
 * truncated response.
 */
function applyRerankOrder(
  results: RetrievalResult[],
  scores: RerankScore[]
): RetrievalResult[] {
  const scoreByIndex = new Map(scores.map(({ index, score }) => [index, score]))
  const scored = results.flatMap((result, index) => {
    const score = scoreByIndex.get(index)
    return score === undefined ? [] : [{ index, result, score }]
  })
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  const unscored = results.filter((_result, index) => !scoreByIndex.has(index))
  return [
    ...scored.map(({ result, score }) => ({ ...result, score })),
    ...unscored,
  ]
}
