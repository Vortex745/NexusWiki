import assert from "node:assert/strict"
import test from "node:test"
import type { RetrievalResult } from "../../types"
import {
  createRunContext,
  getRunResourceBudgetSnapshot,
  runWithRunContext,
} from "../../runtime/run_context"
import {
  createDedicatedReranker,
  DedicatedReranker,
  DedicatedRerankError,
} from "./dedicated_reranker"

const API_KEY = "secret-rerank-key"

function candidate(id: string, content = `content-${id}`): RetrievalResult {
  return {
    chunk: {
      documentId: "doc-1",
      id,
      content,
      childrenIds: [],
      metadata: { kind: "child" },
    },
    score: 1,
    source: "vector",
    wikilinks: [],
  }
}

interface CapturedRequest {
  url: string
  init: RequestInit
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function reranker(
  respond: (request: CapturedRequest) => Response | Promise<Response>,
  captured: CapturedRequest[] = [],
  options: { timeoutMs?: number; maxDocumentChars?: number } = {}
): DedicatedReranker {
  return new DedicatedReranker({
    baseUrl: "https://rerank.test/v1/",
    apiKey: API_KEY,
    model: "bge-reranker-v2-m3",
    fetchImpl: (async (url: string, init: RequestInit) => {
      const request = { url: String(url), init }
      captured.push(request)
      return respond(request)
    }) as unknown as typeof fetch,
    ...options,
  })
}

test("sends the verified rerank protocol and publishes provider order by index", async () => {
  const captured: CapturedRequest[] = []
  const adapter = reranker(
    () =>
      jsonResponse({
        id: "req-1",
        results: [
          { index: 2, document: null, relevance_score: 0.91 },
          { index: 0, document: null, relevance_score: 0.4 },
          { index: 1, document: null, relevance_score: 0.05 },
        ],
        meta: { tokens: { input_tokens: 42, output_tokens: 0 } },
      }),
    captured
  )

  const out = await adapter.rerank("what is vector retrieval?", [
    candidate("a"),
    candidate("b"),
    candidate("c"),
  ])

  assert.equal(captured.length, 1)
  assert.equal(captured[0].url, "https://rerank.test/v1/rerank")
  const headers = captured[0].init.headers as Record<string, string>
  assert.equal(headers.authorization, `Bearer ${API_KEY}`)
  assert.equal(headers["content-type"], "application/json")
  assert.deepEqual(JSON.parse(String(captured[0].init.body)), {
    model: "bge-reranker-v2-m3",
    query: "what is vector retrieval?",
    documents: ["content-a", "content-b", "content-c"],
  })
  assert.deepEqual(out.map((r) => r.chunk.id), ["c", "a", "b"])
  assert.deepEqual(out.map((r) => r.score), [0.91, 0.4, 0.05])
})

test("keeps every candidate when the provider ranks only a prefix", async () => {
  const adapter = reranker(() =>
    jsonResponse({
      results: [
        { index: 1, relevance_score: 0.8 },
        { index: 0, relevance_score: 0.2 },
      ],
    })
  )

  const out = await adapter.rerank("q", [
    candidate("a"),
    candidate("b"),
    candidate("c"),
  ])

  assert.deepEqual(
    out.map((r) => r.chunk.id),
    ["b", "a", "c"],
    "unscored candidates keep their fused order after the scored ones"
  )
  assert.equal(out[2].score, 1, "unscored candidate keeps its incoming score")
})

test("rejects an out-of-range or duplicated provider index instead of reordering", async () => {
  const outOfRange = reranker(() =>
    jsonResponse({ results: [{ index: 5, relevance_score: 0.5 }] })
  )
  await assert.rejects(
    outOfRange.rerank("q", [candidate("a")]),
    /illegal index 5/
  )

  const duplicated = reranker(() =>
    jsonResponse({
      results: [
        { index: 0, relevance_score: 0.5 },
        { index: 0, relevance_score: 0.9 },
      ],
    })
  )
  await assert.rejects(
    duplicated.rerank("q", [candidate("a"), candidate("b")]),
    /duplicate index 0/
  )
})

test("rejects non-finite scores and malformed bodies explicitly", async () => {
  const nonFinite = reranker(() =>
    jsonResponse({ results: [{ index: 0, relevance_score: Number.NaN }] })
  )
  await assert.rejects(nonFinite.rerank("q", [candidate("a")]), /non-finite score/)

  const missing = reranker(() => jsonResponse({ id: "x" }))
  await assert.rejects(missing.rerank("q", [candidate("a")]), /results must be an array/)

  const notJson = reranker(
    () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("not json")
        },
      }) as unknown as Response
  )
  await assert.rejects(notJson.rerank("q", [candidate("a")]), /body is not JSON/)
})

test("surfaces provider status and reason without leaking the credential", async () => {
  const adapter = reranker(() =>
    jsonResponse(
      { code: 401, reason: "Unauthorized", message: "invalid api key" },
      401
    )
  )

  await assert.rejects(adapter.rerank("q", [candidate("a")]), (error: unknown) => {
    assert.ok(error instanceof DedicatedRerankError)
    assert.equal(error.status, 401)
    assert.match(error.message, /HTTP 401/)
    assert.match(error.message, /Unauthorized: invalid api key/)
    assert.equal(error.message.includes(API_KEY), false, "no credential in errors")
    return true
  })
})

test("cancellation is never swallowed: aborted signal rejects with the abort reason", async () => {
  const controller = new AbortController()
  const adapter = new DedicatedReranker({
    baseUrl: "https://rerank.test/v1",
    apiKey: API_KEY,
    fetchImpl: ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal
        const fail = () => {
          const error = new Error("Request was aborted")
          error.name = "AbortError"
          reject(error)
        }
        if (signal.aborted) return fail()
        signal.addEventListener("abort", fail, { once: true })
      })) as unknown as typeof fetch,
  })

  const pending = adapter.rerank("q", [candidate("a")], controller.signal)
  controller.abort()
  await assert.rejects(pending, /aborted|Abort/i)
})

test("a hung provider is bounded by the per-call ceiling", async () => {
  const adapter = new DedicatedReranker({
    baseUrl: "https://rerank.test/v1",
    apiKey: API_KEY,
    timeoutMs: 20,
    fetchImpl: ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal
        signal.addEventListener(
          "abort",
          () => {
            const error = new Error("The operation was aborted due to timeout")
            error.name = "TimeoutError"
            reject(error)
          },
          { once: true }
        )
      })) as unknown as typeof fetch,
  })

  await assert.rejects(adapter.rerank("q", [candidate("a")]), /timeout|aborted/i)
})

test("truncates over-long candidate text to the configured cap", async () => {
  const captured: CapturedRequest[] = []
  const adapter = reranker(
    () => jsonResponse({ results: [{ index: 0, relevance_score: 0.5 }] }),
    captured,
    { maxDocumentChars: 5 }
  )

  await adapter.rerank("q", [candidate("a", "0123456789")])

  assert.deepEqual(JSON.parse(String(captured[0].init.body)).documents, ["01234"])
})

test("reserves and settles the run budget with provider-reported usage", async () => {
  const adapter = reranker(() =>
    jsonResponse({
      results: [{ index: 0, relevance_score: 0.5 }],
      meta: { tokens: { input_tokens: 102, output_tokens: 0 } },
    })
  )
  const ctx = createRunContext({ resourceBudget: { limits: {} } })

  await runWithRunContext(ctx, () => adapter.rerank("q", [candidate("a")]))

  assert.deepEqual(getRunResourceBudgetSnapshot(ctx), {
    modelCalls: 1,
    promptTokens: 102,
    completionTokens: 0,
    totalTokens: 102,
    costMicros: 0,
    limits: {},
  })
})

test("unknown provider usage fails closed when a token budget is configured", async () => {
  const adapter = reranker(() =>
    jsonResponse({ results: [{ index: 0, relevance_score: 0.5 }] })
  )
  const ctx = createRunContext({ resourceBudget: { limits: { maxTokens: 1_000 } } })

  await assert.rejects(
    runWithRunContext(ctx, () => adapter.rerank("q", [candidate("a")])),
    /usage is required/i
  )
})

test("outside a run context the adapter performs no budget accounting", async () => {
  const adapter = reranker(() =>
    jsonResponse({ results: [{ index: 0, relevance_score: 0.5 }] })
  )

  const out = await adapter.rerank("q", [candidate("a")])

  assert.deepEqual(out.map((r) => r.chunk.id), ["a"])
})

test("createDedicatedReranker returns undefined when no key is configured", () => {
  assert.equal(
    createDedicatedReranker({
      baseUrl: "https://api.edgefn.net/v1",
      apiKey: "",
      model: "bge-reranker-v2-m3",
    }),
    undefined
  )
  assert.ok(
    createDedicatedReranker({
      baseUrl: "https://api.edgefn.net/v1",
      apiKey: API_KEY,
      model: "bge-reranker-v2-m3",
    }) instanceof DedicatedReranker
  )
})
