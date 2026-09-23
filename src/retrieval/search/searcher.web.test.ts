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
