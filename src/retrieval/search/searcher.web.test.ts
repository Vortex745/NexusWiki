/**
 * Ticket 36 (WEB-01) — the web-evidence channel of retrieval.
 *
 * The searcher seam is where the ticket's promises become observable: a URL
 * pasted into the message joins retrieval as citable web evidence (merged
 * before fusion like the attachment/faq channels), a run that opts into web
 * search without a configured provider gets an honest unconfigured note, a
 * fully failed web attempt degrades to knowledge-only answering, and the
 * published citations carry URL + fetch time provenance distinct from
 * knowledge-base documents.
 */

import assert from "node:assert/strict"
import test from "node:test"

import { buildEvidence } from "../../answer/evidence"
import { ContextAssemblerImpl } from "../context/assembler"
import { createWebEvidenceOperations } from "../../web/web_evidence"
import type { AccessContext } from "../../access/context"
import type { RetrievalResult } from "../../types"
import { SearcherImpl, type SearchOperations } from "./searcher"

function operations(overrides: Partial<SearchOperations> = {}): SearchOperations {
  return {
    vectorSearch: async () => [],
    bm25Search: async () => [],
    graphSearch: async () => [],
    pageIndexSearch: async () => [],
    rerank: async (_query, results) => results,
    loadParents: async () => [],
    ...overrides,
  }
}

const context: AccessContext = {
  tenantId: "t1",
  subjectId: "alice",
  groups: [],
  scopes: ["chat"],
}

function knowledge(id: string): RetrievalResult {
  return {
    chunk: {
      id,
      documentId: "doc-kb",
      content: `knowledge-${id}`,
      childrenIds: [],
      metadata: { source: "kb", title: "知识库文档" },
    },
    score: 1,
    source: "bm25",
    wikilinks: [],
  }
}

function publicFetch(body: string): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(body, { status: 200, headers: { "content-type": "text/html" } })
    )
}

function publicOps(body = "<title>页</title><p>网页正文</p>"): ReturnType<typeof createWebEvidenceOperations> {
  return createWebEvidenceOperations({
    fetchOptions: {
      resolver: async () => ({ addresses: ["93.184.216.34"] }),
      fetchImpl: publicFetch(body),
    },
    now: () => new Date("2026-09-23T08:00:00Z"),
  })
}

test("a URL pasted into the message joins retrieval as web evidence — no opt-in flag needed", async () => {
  const searcher = new SearcherImpl(
    operations({ bm25Search: async () => [knowledge("kb-1")] }),
    undefined,
    undefined,
    publicOps()
  )
  const outcome = await searcher.search(
    { text: "总结 https://example.com/policy 的内容" },
    { accessContext: context }
  )
  assert.equal(outcome.unavailableChannels.length, 0)
  const webHits = outcome.results.filter((result) => result.source === "web")
  assert.equal(webHits.length, 1)
  assert.equal(webHits[0].chunk.metadata.origin, "web")
  assert.equal(webHits[0].chunk.metadata.webUrl, "https://example.com/policy")
  assert.equal(webHits[0].chunk.metadata.fetchedAt, "2026-09-23T08:00:00.000Z")
})

test("web search is opt-in: no URL and no useWeb → the channel never runs", async () => {
  let calls = 0
  const probe = createWebEvidenceOperations({
    fetchOptions: {
      resolver: async () => ({ addresses: ["93.184.216.34"] }),
      fetchImpl: (() => {
        calls += 1
        return Promise.resolve(new Response("x", { status: 200 }))
      }) as typeof fetch,
    },
  })
  const searcher = new SearcherImpl(
    operations({ bm25Search: async () => [knowledge("kb-1")] }),
    undefined,
    undefined,
    probe
  )
  await searcher.search({ text: "纯知识库问题" }, { accessContext: context })
  await searcher.search(
    { text: "带 useWeb 的问题" },
    { accessContext: context, webRequested: false }
  )
  assert.equal(calls, 0, "no URL in the message and no opt-in → no fetch, no search")
})

test("web search requested but unconfigured reports web_unconfigured without faking success", async () => {
  const searcher = new SearcherImpl(
    operations({ bm25Search: async () => [knowledge("kb-1")] }),
    undefined,
    undefined,
    createWebEvidenceOperations({})
  )
  const outcome = await searcher.search(
    { text: "今天外面的新闻" },
    { accessContext: context, webRequested: true }
  )
  assert.ok(outcome.degradationReasons?.includes("web_unconfigured"))
  assert.match(outcome.webDetail ?? "", /tavily unconfigured/)
  assert.equal(outcome.status, "degraded")
  // The knowledge channels are unaffected — the run proceeds knowledge-only.
  assert.equal(outcome.unavailableChannels.length, 0)
  assert.deepEqual(outcome.results.map((result) => result.source), ["bm25"])
})

test("a fully failed web attempt marks the channel unavailable; knowledge-only answering continues", async () => {
  const failing = createWebEvidenceOperations({
    fetchOptions: {
      resolver: async () => ({ addresses: ["10.0.0.9"] }),
    },
  })
  const searcher = new SearcherImpl(
    operations({ bm25Search: async () => [knowledge("kb-1")] }),
    undefined,
    undefined,
    failing
  )
  const outcome = await searcher.search(
    { text: "读 http://intranet.local/x" },
    { accessContext: context }
  )
  assert.ok(outcome.unavailableChannels.includes("web"))
  assert.deepEqual(outcome.results.map((result) => result.source), ["bm25"])
})

test("web citations carry origin + URL + fetch time and stay distinct from knowledge citations", async () => {
  const searcher = new SearcherImpl(
    operations({ bm25Search: async () => [knowledge("kb-1")] }),
    undefined,
    undefined,
    publicOps()
  )
  const outcome = await searcher.search(
    { text: "对照 https://example.com/policy" },
    { accessContext: context }
  )
  const evidence = buildEvidence(outcome.results)
  const webCitation = evidence.find((item) => item.origin === "web")
  const kbCitation = evidence.find((item) => item.source === "kb")
  assert.ok(webCitation, "web evidence is labelled")
  assert.equal(webCitation?.webUrl, "https://example.com/policy")
  assert.equal(webCitation?.webFetchedAt, "2026-09-23T08:00:00.000Z")
  assert.equal(kbCitation?.origin, undefined, "knowledge evidence is not relabelled")
})

test("an empty knowledge scope with only web evidence still answers; with no web evidence it stays fail-closed", async () => {
  const searcher = new SearcherImpl(operations(), undefined, undefined, publicOps())
  const withWeb = await searcher.search(
    { text: "看 https://example.com/policy" },
    { accessContext: context, retrievalScope: { knowledgeBaseIds: [] } }
  )
  assert.deepEqual(withWeb.results.map((result) => result.source), ["web"])

  const withoutWeb = await searcher.search(
    { text: "没有链接的问题" },
    { accessContext: context, retrievalScope: { knowledgeBaseIds: [] } }
  )
  assert.equal(withoutWeb.status, "insufficient")
  assert.deepEqual(withoutWeb.results, [])
})

// ---------------------------------------------------------------------------
// PT-03 — the opt-in alone (no URL anywhere in the query) is what the complex
// route must be able to carry. These pin the searcher side of that contract.
// ---------------------------------------------------------------------------

function tavilyOps(
  rows: Array<{ title?: string; url?: string; content?: string }>,
  behavior: { fail?: boolean } = {}
) {
  const calls: Array<{ body: string }> = []
  const ops = createWebEvidenceOperations({
    tavilyApiKey: "server-side-key",
    tavilyEndpoint: "https://tavily.test/search",
    tavilyFetchImpl: async (_input, init) => {
      calls.push({ body: String(init?.body ?? "") })
      if (behavior.fail) throw new Error("tavily 503")
      return new Response(JSON.stringify({ results: rows }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
    now: () => new Date("2026-10-08T08:00:00Z"),
  })
  return { ops, calls }
}

test("PT-03 AC01: an explicit opt-in with no URL still asks the configured provider", async () => {
  const { ops, calls } = tavilyOps([
    { title: "官网退款政策", url: "https://example.com/refund", content: "最新退款规则：30 天。" },
  ])
  const searcher = new SearcherImpl(
    operations({ bm25Search: async () => [knowledge("kb-web-1")] }),
    undefined,
    undefined,
    ops
  )
  const outcome = await searcher.search(
    { text: "最新退款规则是什么" },
    { accessContext: context, webRequested: true }
  )
  assert.equal(calls.length, 1, "webRequested alone opens the web channel")
  assert.match(calls[0].body, /最新退款规则是什么/, "the provider request carries the run's query")
  const webHits = outcome.results.filter((result) => result.source === "web")
  assert.equal(webHits.length, 1)
  assert.equal(webHits[0].chunk.metadata.origin, "web")
  assert.equal(webHits[0].chunk.metadata.webUrl, "https://example.com/refund")
  assert.equal(webHits[0].chunk.metadata.fetchedAt, "2026-10-08T08:00:00.000Z")
})

test("PT-03 AC02: opt-in web evidence is labelled web, never a knowledge-base document or an attachment", async () => {
  const { ops } = tavilyOps([
    { title: "官网退款政策", url: "https://example.com/refund", content: "最新退款规则：30 天。" },
  ])
  const searcher = new SearcherImpl(
    operations({
      bm25Search: async () => [knowledge("kb-web-2")],
      vectorSearch: async () => [],
    }),
    undefined,
    undefined,
    ops
  )
  const outcome = await searcher.search(
    { text: "最新退款规则" },
    { accessContext: context, webRequested: true }
  )
  const evidence = buildEvidence(outcome.results)
  const webCitation = evidence.find((item) => item.origin === "web")
  assert.ok(webCitation, "web evidence keeps its origin")
  assert.equal(webCitation?.webUrl, "https://example.com/refund")
  assert.equal(webCitation?.webFetchedAt, "2026-10-08T08:00:00.000Z")
  assert.equal(webCitation?.attachmentId, undefined, "it is not a session attachment")
  assert.equal(webCitation?.source, "https://example.com/refund")

  const assembled = await new ContextAssemblerImpl().assemble(outcome.results)
  assert.match(assembled, /\[来源: https:\/\/example\.com\/refund\]/)
  assert.doesNotMatch(assembled, /临时引用/, "web evidence is never presented as a temporary attachment")
})

test("PT-03 AC05: zero web results, a failed provider and a missing capability degrade distinctly", async () => {
  const emptyScope = { knowledgeBaseIds: [] }

  // 1. Provider answered with nothing → the channel is empty, nothing is faked.
  const zeroOps = tavilyOps([])
  const zeroSearcher = new SearcherImpl(operations(), undefined, undefined, zeroOps.ops)
  const zero = await zeroSearcher.search(
    { text: "外面的最新消息" },
    { accessContext: context, retrievalScope: emptyScope, webRequested: true }
  )
  assert.equal(zero.status, "insufficient")
  assert.deepEqual(zero.results, [])
  assert.deepEqual(zero.unavailableChannels, ["web"], "an attempted provider call that yielded nothing is named")

  // 2. Provider failed → the same honest insufficient, with the failure named.
  const failedOps = tavilyOps([], { fail: true })
  const failed = await new SearcherImpl(operations(), undefined, undefined, failedOps.ops).search(
    { text: "外面的最新消息" },
    { accessContext: context, retrievalScope: emptyScope, webRequested: true }
  )
  assert.equal(failed.status, "insufficient")
  assert.deepEqual(failed.unavailableChannels, ["web"])

  // 3. No web capability wired at all → the opt-in changes nothing and no
  //    channel is blamed for an absent capability.
  const capabilityLess = await new SearcherImpl(operations()).search(
    { text: "外面的最新消息" },
    { accessContext: context, retrievalScope: emptyScope, webRequested: true }
  )
  assert.equal(capabilityLess.status, "insufficient")
  assert.deepEqual(capabilityLess.unavailableChannels, [])
})

test("PT-03 AC03: an opt-out search never asks the provider, and a URL still follows the read policy", async () => {
  const { ops, calls } = tavilyOps([
    { title: "官网", url: "https://example.com/refund", content: "正文" },
  ])
  const searcher = new SearcherImpl(
    operations({ bm25Search: async () => [knowledge("kb-web-3")] }),
    undefined,
    undefined,
    ops
  )
  await searcher.search({ text: "纯知识库问题" }, { accessContext: context })
  await searcher.search(
    { text: "带 useWeb=false 的问题" },
    { accessContext: context, webRequested: false }
  )
  assert.deepEqual(calls, [], "useWeb=false and no URL → no opt-in Web call")
})
