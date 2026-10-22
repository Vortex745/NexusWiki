import assert from "node:assert/strict"
import test from "node:test"
import type { Client } from "@elastic/elasticsearch"
import type OpenAI from "openai"
import type { Chunk, RetrievalResult } from "../../types"
import { RuntimeSearchOperations, SearcherImpl } from "./searcher"
import { RerankerNotConfiguredError, type Reranker } from "./interface"

function chunk(id: string): Chunk {
  return {
    documentId: "doc-1",
    id,
    content: `content-${id}`,
    childrenIds: [],
    metadata: { kind: "child" },
  }
}

function hit(id: string) {
  return { _source: chunk(id), _score: 1 }
}

/** ES stub: vector recall returns two ordered hits, other channels empty. */
function esStub(): Client {
  return {
    async search(request: { knn?: unknown }) {
      return { hits: { hits: request.knn ? [hit("a"), hit("b")] : [] } }
    },
  } as unknown as Client
}

function runtime(options: { reranker?: Reranker } = {}): RuntimeSearchOperations {
  return new RuntimeSearchOperations({
    es: esStub(),
    embeddingClient: {
      embeddings: { create: async () => ({ data: [{ embedding: [0.1] }] }) },
    } as unknown as OpenAI,
    embeddingModel: "embedding",
    ...options,
  })
}

test("without a configured reranker the seam reports not_configured", async () => {
  await assert.rejects(
    runtime().rerank("q", [
      {
        chunk: chunk("a"),
        score: 1,
        source: "vector",
        wikilinks: [],
      },
    ]),
    RerankerNotConfiguredError
  )
})

test("with a configured reranker the seam delegates query, candidates and signal", async () => {
  const calls: Array<{ query: string; ids: string[]; signal?: AbortSignal }> = []
  const reranker: Reranker = {
    model: "bge-reranker-v2-m3",
    async rerank(query, results, signal) {
      calls.push({ query, ids: results.map((r) => r.chunk.id), signal })
      return [...results].reverse()
    },
  }
  const controller = new AbortController()
  const results: RetrievalResult[] = [
    { chunk: chunk("a"), score: 1, source: "vector", wikilinks: [] },
    { chunk: chunk("b"), score: 1, source: "vector", wikilinks: [] },
  ]

  const out = await runtime({ reranker }).rerank("q", results, controller.signal)

  assert.deepEqual(calls, [{ query: "q", ids: ["a", "b"], signal: controller.signal }])
  assert.deepEqual(out.map((r) => r.chunk.id), ["b", "a"])
})

test("a search without a dedicated reranker publishes the fused order and says why", async () => {
  const outcome = await new SearcherImpl(runtime()).search(
    { text: "q" },
    { channels: ["vector"] }
  )

  assert.equal(outcome.status, "degraded")
  assert.deepEqual(outcome.unavailableChannels, [])
  // DR-22: a missing configuration is not a provider failure; the trace says
  // which of the two happened.
  assert.deepEqual(outcome.degradationReasons, ["reranker_not_configured"])
  assert.deepEqual(outcome.ordering, { source: "fused", reason: "not_configured" })
})

test("a successful dedicated rerank is labelled as the score source", async () => {
  const reranker: Reranker = {
    model: "bge-reranker-v2-m3",
    async rerank(_query, results) {
      return [...results].reverse()
    },
  }

  const outcome = await new SearcherImpl(runtime({ reranker })).search(
    { text: "q" },
    { channels: ["vector"] }
  )

  assert.equal(outcome.status, "ok")
  assert.deepEqual(outcome.ordering, { source: "dedicated_rerank" })
  assert.deepEqual(outcome.results.map((r) => r.chunk.id), ["b", "a"])
})

test("a single candidate is not sent to the provider and is labelled below_threshold", async () => {
  let called = false
  const reranker: Reranker = {
    model: "bge-reranker-v2-m3",
    async rerank(_query, results) {
      called = true
      return results
    },
  }
  const es = {
    async search(request: { knn?: unknown }) {
      return { hits: { hits: request.knn ? [hit("only")] : [] } }
    },
  } as unknown as Client

  const outcome = await new SearcherImpl(
    new RuntimeSearchOperations({
      es,
      embeddingClient: {
        embeddings: { create: async () => ({ data: [{ embedding: [0.1] }] }) },
      } as unknown as OpenAI,
      embeddingModel: "embedding",
      reranker,
    })
  ).search({ text: "q" }, { channels: ["vector"] })

  assert.equal(called, false)
  assert.equal(outcome.status, "ok")
  assert.deepEqual(outcome.ordering, { source: "fused", reason: "below_threshold" })
})

test("a provider failure degrades visibly to the fused order", async () => {
  const reranker: Reranker = {
    model: "bge-reranker-v2-m3",
    async rerank() {
      throw new Error("dedicated rerank failed with HTTP 503")
    },
  }

  const outcome = await new SearcherImpl(runtime({ reranker })).search(
    { text: "q" },
    { channels: ["vector"] }
  )

  assert.equal(outcome.status, "degraded")
  assert.deepEqual(outcome.unavailableChannels, [])
  assert.deepEqual(outcome.ordering, { source: "fused", reason: "unavailable" })
  assert.deepEqual(outcome.degradationReasons, ["reranker_unavailable"])
  assert.deepEqual(outcome.results.map((r) => r.chunk.id), ["a", "b"])
})
