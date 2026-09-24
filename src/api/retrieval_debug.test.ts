import assert from "node:assert/strict"
import test from "node:test"
import express from "express"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
import type { Chunk, RetrievalResult, Query } from "../types"
import { KnowledgeBaseNotFoundError } from "../knowledge/knowledge_base_service"
import { SearcherImpl, type SearchOperations } from "../retrieval/search/searcher"
import type { RetrievalScope } from "../types/retrieval_scope"
import { createRetrievalDebugRouter } from "./retrieval_debug"

/**
 * Ticket 14 (RET-01) — the read-only retrieval-debug run.
 *
 *   1. Debug and chat share retrieval configuration and implementation (the
 *      route runs SearcherImpl over the caller-supplied SearchOperations with
 *      debug: true — the same search() the Answer path runs).
 *   2. The output distinguishes raw channel ranks, the fused order (RRF =
 *      fusion + dedup), the reranked order and elapsed times.
 *   3. The operation does not generate an answer or mutate anything.
 *   4. Unauthorized candidates are absent from the payloads (parent chunks'
 *      full content never leaves the process; channel ACLs do the filtering).
 */

function contextFor(
  options: { tenantId?: string; groups?: string[] } = {}
): AccessContext {
  return {
    ...singleTenantAccessContext(),
    tenantId: options.tenantId ?? "demo",
    groups: options.groups ?? ["demo-tech"],
  }
}

function result(
  chunkId: string,
  score: number,
  options: {
    documentId?: string
    title?: string
    content?: string
    parent?: Chunk
  } = {}
): RetrievalResult {
  return {
    source: "vector",
    score,
    chunk: {
      id: chunkId,
      documentId: options.documentId ?? "doc-1",
      content: options.content ?? `TEXT-OF-${chunkId}`,
      childrenIds: [],
      metadata: { kind: "child", title: options.title ?? `Title ${chunkId}` },
      ...(options.parent ? { parentId: options.parent.id } : {}),
    },
    wikilinks: [],
    ...(options.parent ? { parentChunk: options.parent } : {}),
  }
}

const PARENT_CHUNK: Chunk = {
  id: "parent-1",
  documentId: "doc-1",
  content: "PARENT-CONTENT-MUST-NOT-LEAK",
  childrenIds: ["c1"],
  metadata: { kind: "parent", title: "Parent" },
}

/** Stub operations: vector finds c1+c2, bm25 re-finds c1 (dedup case). */
function stubOperations(): SearchOperations {
  return {
    async vectorSearch(_query: Query) {
      return [result("c1", 0.9, { parent: PARENT_CHUNK }), result("c2", 0.8)]
    },
    async bm25Search(_query: Query) {
      return [result("c1", 12)]
    },
    async graphSearch() {
      return []
    },
    async pageIndexSearch() {
      return []
    },
    // A real reranker reorders; the trace must show the reranked order.
    async rerank(_query: string, results: RetrievalResult[]) {
      return [...results].reverse()
    },
    async loadParents() {
      return [PARENT_CHUNK]
    },
  }
}

function buildApp(
  options: {
    searchOperations?: SearchOperations
    resolver?: (context: AccessContext, ids?: unknown) => RetrievalScope
  } = {}
) {
  const app = express()
  app.use(express.json())
  app.use((_req, res, next) => {
    res.locals.accessContext = contextFor()
    next()
  })
  app.use("/api", createRetrievalDebugRouter({
    searchOperations: options.searchOperations,
    retrievalScopeResolver: options.resolver,
  }))
  return app
}

async function listen(app: express.Express) {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const port = (server.address() as { port: number }).port
  return { server, port }
}

test("Ticket 14 RET-01: the debug run distinguishes raw ranks, fusion/dedup, rerank and times", async () => {
  const app = buildApp({ searchOperations: stubOperations() })
  const { server, port } = await listen(app)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/retrieval-debug`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "退货政策" }),
    })
    assert.equal(response.status, 200)
    const body = await response.json() as Record<string, any>

    assert.equal(body.status, "ok")
    assert.equal(body.ordering.source, "dedicated_rerank", "the reranked order is labeled")

    // Raw channel ranks — with the honest per-channel scores.
    const channels = body.debug.channels as Array<Record<string, any>>
    assert.equal(channels.length, 4)
    const vector = channels.find((c) => c.channel === "vector")!
    assert.deepEqual(vector.candidates.map((c: any) => c.chunkId), ["c1", "c2"])
    assert.equal(vector.candidates[0].score, 0.9)
    assert.equal(vector.candidates[0].rank, 1)
    const bm25 = channels.find((c) => c.channel === "bm25")!
    assert.deepEqual(bm25.candidates.map((c: any) => c.chunkId), ["c1"])

    // Fusion is the dedup point: raw 3 candidates → 2 distinct.
    assert.equal(body.debug.fused.rawCandidateCount, 3)
    assert.equal(body.debug.fused.distinctCount, 2)
    assert.ok(body.debug.fused.elapsedMs >= 0)

    // Rerank stage applied and its order distinguished from fusion.
    assert.equal(body.debug.rerank.applied, true)
    assert.deepEqual(
      (body.debug.rerank.candidates as Array<Record<string, any>>).map((c) => c.chunkId),
      ["c2", "c1"],
    )
    assert.ok(body.debug.totalMs >= body.debug.rerank.elapsedMs)
    // Criterion 3: no answer generation anywhere in the payload.
    for (const key of ["answer", "reply", "runId", "sessionId", "message"]) {
      assert.equal(key in body, false, `no ${key} field — this is not an answer endpoint`)
    }

    // Criterion 4: the parent chunk's FULL content never appears anywhere.
    assert.ok(!JSON.stringify(body).includes("PARENT-CONTENT-MUST-NOT-LEAK"))
    // Excerpts are bounded.
    for (const candidate of body.debug.fused.candidates as Array<{ excerpt: string }>) {
      assert.ok(candidate.excerpt.length <= 300)
    }
  } finally {
    server.close()
  }
})

test("Ticket 14 RET-01: the same searcher runs with debug off and carries no trace", async () => {
  const searcher = new SearcherImpl(stubOperations())
  const outcome = await searcher.search({ text: "query" }, { debug: false })
  assert.equal(outcome.debug, undefined, "the Answer path gets no debug trace")
  const outcomeDefault = await searcher.search({ text: "query" })
  assert.equal(outcomeDefault.debug, undefined)
  assert.equal(outcome.status, "ok")
})

test("Ticket 14 RET-01: input validation and scope resolution reuse the chat contract", async () => {
  const resolverCalls: Array<string[] | undefined> = []
  const app = buildApp({
    searchOperations: stubOperations(),
    resolver: (context, ids) => {
      const idList = Array.isArray(ids) ? ids.map(String) : undefined
      resolverCalls.push(idList ? [...idList] : undefined)
      if (idList?.includes("kb-foreign")) throw new KnowledgeBaseNotFoundError("nope")
      return { knowledgeBaseIds: idList ?? ["kb-default-demo"] } as unknown as RetrievalScope
    },
  })
  const { server, port } = await listen(app)
  try {
    const call = (body: unknown) =>
      fetch(`http://127.0.0.1:${port}/api/retrieval-debug`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })

    assert.equal((await call({ query: "" })).status, 400, "an empty query is rejected")
    assert.equal((await call({ query: "x".repeat(2001) })).status, 400)
    assert.equal((await call({ query: "q", channels: [] })).status, 400)
    assert.equal((await call({ query: "q", channels: ["psychic"] })).status, 400)

    const foreign = await call({ query: "q", knowledgeBaseIds: ["kb-foreign"] })
    assert.equal(foreign.status, 404, "unknown/cross-tenant ids are the chat 404")

    const scoped = await call({ query: "q", knowledgeBaseIds: ["kb-mine"] })
    assert.equal(scoped.status, 200)
    assert.deepEqual(resolverCalls.at(-1), ["kb-mine"])
    const unscoped = await call({ query: "q" })
    assert.equal(unscoped.status, 200)
    assert.equal(resolverCalls.at(-1), undefined, "a missing selection resolves like chat")
  } finally {
    server.close()
  }
})

test("Ticket 14 RET-01: no operations wired → the deployment reports 503", async () => {
  const app = buildApp()
  const { server, port } = await listen(app)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/retrieval-debug`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "q" }),
    })
    assert.equal(response.status, 503)
  } finally {
    server.close()
  }
})

/**
 * Ticket 50 (ARCH-01C) #2 — the debug run and chat share ONE search
 * configuration, and the debug run's evidence set stays the smaller one.
 *
 * "Same search operations" is the wiring asserted in
 * `answer_composition_boundaries.test.ts` (src/index.ts passes
 * `sharedAnswerEntry.searchOperations`); what this pins is what that shared
 * object does and does not run: the router builds `new SearcherImpl(operations)`
 * with the operations alone, so even a query that carries a URL — the exact
 * input that fires the Web channel on the chat path — traces only the four
 * knowledge channels here. That divergence is deliberate and established;
 * closing it would change this endpoint's output, which ticket 47 excludes.
 */
test("Ticket 50 ARCH-01C #2: the debug run reads the shared operations and traces no optional evidence channel", async () => {
  const reads: string[] = []
  const operations: SearchOperations = {
    async vectorSearch() {
      reads.push("vector")
      return [result("c1", 0.9), result("c2", 0.8)]
    },
    async bm25Search() {
      reads.push("bm25")
      return []
    },
    async graphSearch() {
      reads.push("graph")
      return []
    },
    async pageIndexSearch() {
      reads.push("pageIndex")
      return []
    },
    async rerank(_query, results) {
      reads.push("rerank")
      return results
    },
    async loadParents() {
      return []
    },
  }
  const app = buildApp({
    searchOperations: operations,
    resolver: () => ({ knowledgeBaseIds: ["kb-1"] }) as unknown as RetrievalScope,
  })
  const { server, port } = await listen(app)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/retrieval-debug`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "请核对 https://example.com/returns 上的退货窗口" }),
    })
    assert.equal(response.status, 200)
    const body = (await response.json()) as Record<string, any>

    assert.deepEqual(
      [...new Set(reads)].sort(),
      ["bm25", "graph", "pageIndex", "rerank", "vector"],
      "the run went through the operations object the caller supplied"
    )
    assert.deepEqual(
      (body.debug.channels as Array<Record<string, any>>).map((c) => c.channel).sort(),
      ["bm25", "graph", "pageIndex", "vector"],
      "a URL-bearing query stays answer-free here: no Web, attachment or FAQ stage is recorded"
    )
    assert.equal(body.unavailableChannels.length, 0, "nothing failed — nothing was wired")
    assert.equal(body.debug.fused.rawCandidateCount, 2)
    assert.equal(body.debug.rerank.applied, true, "two candidates is the rerank threshold")
    for (const key of ["answer", "reply", "runId", "sessionId"]) {
      assert.equal(key in body, false, `no ${key} field`)
    }
  } finally {
    server.close()
  }
})
