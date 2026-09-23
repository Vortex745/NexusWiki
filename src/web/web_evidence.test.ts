/**
 * Ticket 36 (WEB-01) — web-evidence adapter tests.
 *
 * The adapter is held to the same URL security contract as ingestion: it
 * REUSES fetchSingleUrl, so a synthetic resolver + fetch (same style as
 * url_fetcher.test.ts) proves the private-network / redirect / size
 * protections carry over. Tavily is proven against the server-side key
 * contract: configured → real request with the key; unconfigured → honest
 * `unconfigured`, never fake success.
 */

import assert from "node:assert/strict"
import test from "node:test"
import {
  createWebEvidenceOperations,
  extractUrls,
  containsWebUrl,
  htmlToText,
  webChunkIdentity,
  MAX_URLS_PER_MESSAGE,
} from "./web_evidence"
import type { HostResolver } from "../ingestion/url_policy"

const PUBLIC_IP = "93.184.216.34"

function publicResolver(): HostResolver {
  return async () => ({ addresses: [PUBLIC_IP] })
}

function staticFetch(
  body: string,
  contentType = "text/html; charset=utf-8"
): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(body, { status: 200, headers: { "content-type": contentType } })
    )
}

// --- URL 提取 ---

test("extractUrls extracts only http(s) URLs from the message, deduplicated and bounded", () => {
  const urls = extractUrls(
    "看下 https://example.com/a 和 https://example.com/a?q=1 与 ftp://intranet/x 还有 javascript:alert(1)"
  )
  assert.equal(urls.length, 2)
  assert.equal(urls[0].hostname, "example.com")
  assert.equal(urls[1].search, "?q=1")
})

test("extractUrls never reads more than the bounded count", () => {
  const message = Array.from(
    { length: MAX_URLS_PER_MESSAGE + 3 },
    (_, i) => `https://example.com/page${i}`
  ).join(" ")
  assert.equal(extractUrls(message).length, MAX_URLS_PER_MESSAGE)
})

test("containsWebUrl is a cheap predicate without allocating URLs", () => {
  assert.equal(containsWebUrl("总结这个 https://example.com/a"), true)
  assert.equal(containsWebUrl("没有链接的问题"), false)
})

// --- HTML → 文本 ---

test("htmlToText strips tags/scripts and bounds the excerpt", () => {
  const html = `<html><head><title>政策页</title></head><body>
    <script>steal()</script><style>.x{}</style>
    <h1>报销政策</h1><p>上限 100 元 &amp; 需要发票</p></body></html>`
  const text = htmlToText(html)
  assert.equal(text.includes("steal()"), false)
  assert.equal(text.includes("报销政策"), true)
  assert.equal(text.includes("100 元 &"), true)
})

// --- 适配器行为 ---

test("a user-supplied URL becomes web evidence with url + fetch time metadata", async () => {
  const ops = createWebEvidenceOperations({
    fetchOptions: { resolver: publicResolver(), fetchImpl: staticFetch("<title>政策</title><p>正文内容</p>") },
    now: () => new Date("2026-09-23T08:00:00Z"),
  })
  const outcome = await ops.search({
    message: "帮我读 https://example.com/policy",
    query: "帮我读 https://example.com/policy",
    requested: false,
  })
  assert.equal(outcome.status, "ok")
  assert.equal(outcome.results.length, 1)
  const result = outcome.results[0]
  assert.equal(result.source, "web")
  assert.equal(result.chunk.metadata.origin, "web")
  assert.equal(result.chunk.metadata.webUrl, "https://example.com/policy")
  assert.equal(result.chunk.metadata.fetchedAt, "2026-09-23T08:00:00.000Z")
  // Stable synthetic identity for the citation layer.
  const identity = webChunkIdentity("https://example.com/policy")
  assert.equal(result.chunk.documentId, identity.documentId)
  assert.equal(result.chunk.id, identity.chunkId)
})

test("a private-network URL is policy-denied and a fully failed attempt throws (honest unavailability)", async () => {
  const resolver: HostResolver = async () => ({ addresses: ["10.0.0.5"] })
  const ops = createWebEvidenceOperations({
    fetchOptions: { resolver },
  })
  await assert.rejects(
    ops.search({
      message: "读一下 http://intranet.local/secret",
      query: "读一下",
      requested: false,
    }),
    /web evidence unavailable/
  )
})

test("web search without a configured key reports unconfigured — no fake results, no failure", async () => {
  const ops = createWebEvidenceOperations({})
  const outcome = await ops.search({
    message: "今天的天气怎么样",
    query: "今天的天气怎么样",
    requested: true,
  })
  assert.equal(outcome.status, "unconfigured")
  assert.equal(outcome.results.length, 0)
  assert.match(outcome.detail ?? "", /tavily unconfigured/)
})

test("configured Tavily search uses the server-side key and returns traceable web results", async () => {
  let capturedBody = ""
  const tavilyFetch: typeof fetch = ((_input, init) => {
    capturedBody = String(init?.body ?? "")
    return Promise.resolve(
      new Response(
        JSON.stringify({
          results: [
            { title: "Tavily 命中", url: "https://example.com/hit", content: "外部内容" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    )
  }) as typeof fetch
  const ops = createWebEvidenceOperations({
    tavilyApiKey: "tvly-server-side-key",
    tavilyFetchImpl: tavilyFetch,
    now: () => new Date("2026-09-23T08:00:00Z"),
  })
  const outcome = await ops.search({
    message: "查一下外部资料",
    query: "外部资料",
    requested: true,
  })
  assert.equal(outcome.status, "ok")
  assert.equal(outcome.results.length, 1)
  const result = outcome.results[0]
  assert.equal(result.chunk.metadata.origin, "web")
  assert.equal(result.chunk.metadata.webUrl, "https://example.com/hit")
  assert.equal(result.chunk.metadata.fetchedAt, "2026-09-23T08:00:00.000Z")
  assert.match(capturedBody, /tvly-server-side-key/)
})

test("no URLs and no opt-in means the channel is skipped without touching the network", async () => {
  let fetched = false
  const ops = createWebEvidenceOperations({
    tavilyApiKey: "tvly-server-side-key",
    tavilyFetchImpl: (() => {
      fetched = true
      return Promise.resolve(new Response("{}", { status: 200 }))
    }) as typeof fetch,
  })
  const outcome = await ops.search({
    message: "知识库里的报销流程是什么",
    query: "知识库里的报销流程是什么",
    requested: false,
  })
  assert.equal(outcome.status, "ok")
  assert.equal(outcome.results.length, 0)
  assert.equal(fetched, false)
})

test("a URL fetch failure with a successful Tavily search still yields web evidence", async () => {
  const ops = createWebEvidenceOperations({
    fetchOptions: {
      resolver: publicResolver(),
      fetchImpl: (() => Promise.reject(new Error("boom"))) as typeof fetch,
    },
    tavilyApiKey: "tvly-server-side-key",
    tavilyFetchImpl: (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ results: [{ url: "https://example.com/fallback", content: "兜底" }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )) as typeof fetch,
  })
  const outcome = await ops.search({
    message: "读 https://down.example.com/x",
    query: "x",
    requested: true,
  })
  assert.equal(outcome.status, "ok")
  assert.equal(outcome.results.length, 1)
  assert.match(outcome.detail ?? "", /fetch failed/)
})
