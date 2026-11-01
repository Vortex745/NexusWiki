/**
 * Ticket 36 (WEB-01) — the web-evidence adapter.
 *
 * A run may read a safe user-supplied URL and, when explicitly requested and
 * configured, search Tavily. The adapter is the ONLY place web content enters
 * the answer path, and it enters as ordinary retrieval evidence:
 *
 *  - Safe fetching is REUSED from the ingestion URL pipeline
 *    (`fetchSingleUrl`), so private-network denies, redirect re-validation,
 *    per-hop timeouts and streamed response-size caps are the same code the
 *    import path is held to — never a second, weaker fetcher.
 *  - The user's message is the only source of URLs. Extraction happens
 *    server-side from the run's own query text; no caller field can widen
 *    what is fetched beyond the URLs the user actually pasted.
 *  - Tavily search uses the SERVER-side key from config. A run that asks for
 *    web search without a configured key gets an honest `unconfigured`
 *    outcome — never a fake success, never a fabricated result.
 *  - Failures degrade honestly: a URL that cannot be read is skipped, and a
 *    web attempt where nothing succeeds throws so the searcher records the
 *    channel as unavailable and the run answers knowledge-only — which the
 *    retrieval gates only publish when the remaining evidence is sufficient.
 *
 * Results carry `metadata.origin = "web"` plus `webUrl` and `fetchedAt`, so
 * citations stay distinct from knowledge-base documents (and from FAQ
 * standard answers and session attachments).
 */

import { createHash } from "node:crypto"
import type { RetrievalResult } from "../types"
import {
  fetchSingleUrl,
  UrlPolicyDenyError,
  type FetchOptions,
} from "../ingestion/url_fetcher"

/**
 * At most this many URLs are read from one message — a run is a question,
 * not a crawl.
 */
export const MAX_URLS_PER_MESSAGE = 3

/** Bounded excerpt of one fetched page that may join the evidence. */
export const MAX_WEB_CONTENT_CHARS = 4_000

/** Tavily results per search. */
export const TAVILY_MAX_RESULTS = 3

/**
 * Extract http(s) URLs from a message. Server-side extraction from the run's
 * own text: bounded count, deduplicated, order preserved. Anything else
 * (ftp:, javascript:, bare domains) is ignored.
 */
export function extractUrls(message: string): URL[] {
  const urls: URL[] = []
  const seen = new Set<string>()
  const pattern = /https?:\/\/[^\s<>"'`）)\]}，。；！？、]+/gi
  for (const match of message.matchAll(pattern)) {
    if (urls.length >= MAX_URLS_PER_MESSAGE) break
    let url: URL
    try {
      url = new URL(match[0])
    } catch {
      continue
    }
    const key = `${url.origin}${url.pathname}${url.search}`
    if (seen.has(key)) continue
    seen.add(key)
    urls.push(url)
  }
  return urls
}

/** Cheap predicate the searcher uses to decide whether the channel may run. */
export function containsWebUrl(message: string): boolean {
  return /https?:\/\/[^\s<>"'`）)\]}，。；！？、]+/i.test(message)
}

/** Strip script/style blocks, tags and entities into bounded plain text. */
export function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
  const withBreaks = withoutBlocks
    .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
  const text = withBreaks
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text.slice(0, MAX_WEB_CONTENT_CHARS)
}

function extractHtmlTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match) return undefined
  const title = htmlToText(match[1]).slice(0, 200)
  return title.length > 0 ? title : undefined
}

/** The stable synthetic identity of one web source. */
export function webChunkIdentity(url: string): { documentId: string; chunkId: string } {
  const digest = createHash("sha256").update(url, "utf8").digest("hex").slice(0, 16)
  return { documentId: `web:${digest}`, chunkId: `web:${digest}` }
}

function webRetrievalResult(args: {
  url: string
  title: string
  content: string
  fetchedAt: string
}): RetrievalResult {
  const { documentId, chunkId } = webChunkIdentity(args.url)
  return {
    chunk: {
      id: chunkId,
      documentId,
      content: args.content,
      childrenIds: [],
      metadata: {
        kind: "child",
        title: args.title.slice(0, 200),
        source: args.url,
        origin: "web",
        webUrl: args.url,
        fetchedAt: args.fetchedAt,
      },
    },
    score: 1,
    source: "web",
    channels: ["web"],
    wikilinks: [],
  }
}

/** One Tavily result row (only the fields the adapter reads). */
export interface TavilyResultRow {
  title?: string
  url?: string
  content?: string
}

export interface WebEvidenceRequest {
  /**
   * The run's own message text — the ONLY source of user-supplied URLs.
   */
  message: string
  /** The effective query text for Tavily search. */
  query: string
  /** True when the run explicitly opted into web search (`useWeb: true`). */
  requested: boolean
  signal?: AbortSignal
}

export type WebEvidenceStatus = "ok" | "unconfigured" | "skipped"

export interface WebEvidenceOutcome {
  status: WebEvidenceStatus
  results: RetrievalResult[]
  /**
   * Bounded reason present when status is "unconfigured" (or when a fetched
   * URL was policy-denied) so the run trace can report honestly WHAT part of
   * web capability is absent.
   */
  detail?: string
}

export interface WebEvidenceOperations {
  search(request: WebEvidenceRequest): Promise<WebEvidenceOutcome>
}

export interface WebEvidenceOptions {
  /** Server-side Tavily key. Absent → web search reports `unconfigured`. */
  tavilyApiKey?: string
  /** Overrides for the shared safe fetch (tests inject synthetic resolvers). */
  fetchOptions?: FetchOptions
  /** Tavily endpoint (overridable in tests). */
  tavilyEndpoint?: string
  /** Fetch used for the Tavily call (tests inject a synthetic). */
  tavilyFetchImpl?: typeof fetch
  now?: () => Date
}

const TAVILY_DEFAULT_ENDPOINT = "https://api.tavily.com/search"
const TAVILY_TIMEOUT_MS = 15_000

async function tavilySearch(
  query: string,
  apiKey: string,
  options: WebEvidenceOptions,
  signal?: AbortSignal
): Promise<TavilyResultRow[]> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), TAVILY_TIMEOUT_MS)
  try {
    const response = await (options.tavilyFetchImpl ?? fetch)(
      options.tavilyEndpoint ?? TAVILY_DEFAULT_ENDPOINT,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          api_key: apiKey,
          query: query.slice(0, 400),
          max_results: TAVILY_MAX_RESULTS,
          search_depth: "basic",
        }),
      }
    )
    if (!response.ok) {
      throw new Error(`tavily search failed with status ${response.status}`)
    }
    const parsed = (await response.json()) as { results?: unknown }
    if (!parsed || !Array.isArray(parsed.results)) return []
    return parsed.results.filter(
      (row): row is TavilyResultRow =>
        !!row && typeof row === "object" &&
        typeof (row as TavilyResultRow).url === "string"
    )
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

/**
 * Create the web-evidence operations. One instance serves every run of a
 * composition; per-run state lives in the request, not the adapter.
 */
export function createWebEvidenceOperations(
  options: WebEvidenceOptions = {}
): WebEvidenceOperations {
  const now = options.now ?? (() => new Date())
  return {
    async search(request) {
      if (request.signal?.aborted) {
        const err = new Error("web evidence cancelled")
        err.name = "AbortError"
        throw err
      }
      const urls = extractUrls(request.message)
      const notes: string[] = []
      const results: RetrievalResult[] = []
      let attempted = false

      // 1. User-supplied URLs — fetched through the SHARED safe fetcher.
      for (const url of urls) {
        attempted = true
        try {
          const fetched = await fetchSingleUrl(url, {
            timeoutMs: 12_000,
            maxBytes: 2 * 1024 * 1024,
            ...(options.fetchOptions ?? {}),
          })
          const fetchedAt = now().toISOString()
          const mimeType = fetched.mimeType.toLowerCase()
          const raw = fetched.buffer.toString("utf8")
          const isHtml = mimeType.includes("html") || mimeType.includes("xml")
          const content = isHtml ? htmlToText(raw) : raw.slice(0, MAX_WEB_CONTENT_CHARS)
          if (content.trim().length === 0) {
            notes.push(`empty content: ${url.hostname}`)
            continue
          }
          results.push(
            webRetrievalResult({
              url: fetched.url.toString(),
              title: fetched.title ?? (isHtml ? extractHtmlTitle(raw) ?? url.hostname : url.hostname),
              content,
              fetchedAt,
            })
          )
        } catch (error) {
          if (request.signal?.aborted) {
            const err = new Error("web evidence cancelled")
            err.name = "AbortError"
            throw err
          }
          notes.push(
            error instanceof UrlPolicyDenyError
              ? `policy denied: ${url.hostname}`
              : `fetch failed: ${url.hostname}`
          )
        }
      }

      // 2. Optional Tavily search — only on an explicit per-run opt-in, with
      // the server-side key. Missing configuration is an honest `unconfigured`,
      // never a fake success and never a channel failure.
      let unconfigured = false
      if (request.requested) {
        if (!options.tavilyApiKey) {
          unconfigured = true
          notes.push("tavily unconfigured")
        } else {
          attempted = true
          try {
            const rows = await tavilySearch(
              request.query,
              options.tavilyApiKey,
              options,
              request.signal
            )
            const fetchedAt = now().toISOString()
            for (const row of rows.slice(0, TAVILY_MAX_RESULTS)) {
              const url = typeof row.url === "string" ? row.url : ""
              if (!url) continue
              results.push(
                webRetrievalResult({
                  url,
                  title: typeof row.title === "string" && row.title.trim() ? row.title : url,
                  content:
                    typeof row.content === "string" && row.content.trim()
                      ? row.content.slice(0, MAX_WEB_CONTENT_CHARS)
                      : "",
                  fetchedAt,
                })
              )
            }
          } catch (error) {
            if (request.signal?.aborted) {
              const err = new Error("web evidence cancelled")
              err.name = "AbortError"
              throw err
            }
            notes.push(
              `tavily failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`
            )
          }
        }
      }

      // Honest failure: something was attempted, nothing survived. The
      // searcher records the channel as unavailable and the run falls back
      // to knowledge-only answering (published only when the remaining
      // evidence is sufficient).
      if (attempted && results.length === 0) {
        throw new Error(`web evidence unavailable: ${notes.join("; ").slice(0, 300)}`)
      }

      const status: WebEvidenceStatus = unconfigured ? "unconfigured" : "ok"
      return {
        status,
        results,
        ...(notes.length > 0 ? { detail: notes.join("; ").slice(0, 300) } : {}),
      }
    },
  }
}
