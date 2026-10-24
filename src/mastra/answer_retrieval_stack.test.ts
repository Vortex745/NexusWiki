/**
 * Ticket 50 (ARCH-01C) — the retrieval stack keeps the isolated and optional
 * retrieval paths.
 *
 * Ticket 49 moved the shared entry's retrieval assembly into
 * `AnswerRetrievalStack`. This suite pins the branches that only an isolated
 * evaluation scope, a retrieval-debug caller or an optional evidence channel
 * exercises, so a later ticket cannot quietly drop a seam while the ordinary
 * chat path stays green:
 *
 *   #1 an injected scope retrieves through the injected operations, and the
 *      stack never composes a second retrieval path behind it
 *   #3 attachments, FAQ and Web evidence still reach the searcher, scoped to
 *      the run that carries them, with their existing citation origins
 *   #4 a capability the deployment did not configure stays an honest absence
 *      rather than becoming a new failure mode
 *   #5 an injected scope never receives the rerank-free assistant overlay
 *
 * The rerank-free VARIANT itself — the stack building a second, reranker-less
 * `RuntimeSearchOperations` — is frozen behaviorally through the shared entry
 * in `shared_answer_entry.contract.test.ts` #5, which is the stronger seam;
 * duplicating it here would only re-test `SearcherImpl`.
 *
 * Boundary: lives in src/mastra/* and MUST NOT import src/api/*,
 * src/evaluation/* or src/index (T02 #5).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import type OpenAI from "openai"
import type { Client as ElasticsearchClient } from "@elastic/elasticsearch"
import type { AppConfig } from "../config"
import { openDb } from "../ingestion/tracking/db"
import type { Chunk, RetrievalResult } from "../types"
import { singleTenantAccessContext } from "../access/context"
import type {
  AttachmentSearchOperations,
  WebEvidenceOperations,
} from "../types/retrieval"
import type { SearchOperations } from "../retrieval/search/searcher"
import type { Reranker } from "../retrieval/search/dedicated_reranker"
import type { FaqEntryService } from "../faq/faq_entry_service"
import type { FaqActiveIdentityRow } from "../faq/faq_entry_repo"
import type { AssistantRunSnapshot } from "../assistants/assistant_service"
import {
  createAnswerRetrievalStack,
  type AnswerRetrievalStackContext,
} from "./answer_retrieval_stack"

const db = openDb(":memory:")

/** RERANK_API_KEY unset: the shape of every deployment without a reranker. */
const config: AppConfig = {
  esNode: "http://elasticsearch.test",
  esApiKey: "",
  openaiApiKey: "chat-key",
  openaiBaseUrl: "http://chat.test",
  openaiChatModel: "configured-chat-model",
  embeddingApiKey: "embedding-key",
  embeddingBaseUrl: "http://embedding.test",
  embeddingModel: "configured-embedding-model",
  embeddingDimensions: 3,
  openaiRequestTimeoutMs: 200_000,
  openaiMaxRetries: 1,
  neo4jUri: "bolt://neo4j.test",
  neo4jUser: "neo4j",
  neo4jPassword: "password",
  sqlitePath: ":memory:",
  pollIntervalMs: 1,
  claimedTimeoutMs: 1,
  accessMode: "single_tenant",
  demoOidc: false,
  demoOidcPort: 3900,
  demoOidcAudience: "nexusrag-demo",
  demoOidcPassword: "",
  activationMode: "auto",
  conversationTtlDays: 30,
  conversationGcIntervalMs: 86_400_000,
  rerankApiKey: "",
  rerankBaseUrl: "https://api.edgefn.net/v1",
  rerankModel: "bge-reranker-v2-m3",
  rerankTimeoutMs: 30_000,
  rerankMaxDocumentChars: 4_000,
  mcpCapabilitiesEnabled: false,
}

const accessContext = singleTenantAccessContext()
const knowledgeScope = { knowledgeBaseIds: ["kb-1"] }

const ASSISTANT_WITH_RERANK: AssistantRunSnapshot = {
  id: "ast-1",
  version: 1,
  systemPrompt: "你是智能客服助手",
  rerankModelProfileId: "rerank",
  toolPolicy: "none",
}

const ASSISTANT_RERANK_FREE: AssistantRunSnapshot = {
  id: "ast-2",
  version: 1,
  systemPrompt: "你是智能客服助手",
  rerankModelProfileId: null,
  toolPolicy: "none",
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function chunk(id: string, content: string, metadata: Chunk["metadata"] = {}): Chunk {
  return { id, documentId: `doc-${id}`, content, childrenIds: [], metadata }
}

/** A childless result, so parent expansion never enters the picture. */
function result(
  id: string,
  content: string,
  source: RetrievalResult["source"],
  metadata: Chunk["metadata"] = {}
): RetrievalResult {
  return {
    chunk: chunk(id, content, metadata),
    score: 1,
    wikilinks: [],
    source,
    ...(source === "faq" ? { channels: ["faq" as const] } : {}),
  }
}

/** Two candidates is the minimum that reaches the rerank stage. */
function knowledgeCorpus(): RetrievalResult[] {
  return [
    result("chunk-1", "客户在购买后 14 天内可以发起退货。", "vector"),
    result("chunk-2", "换货窗口为 30 天，需保留原始包装。", "vector"),
  ]
}

/**
 * The operations object an isolated evaluation scope (or a probe) injects:
 * recording every channel read plus its own rerank step.
 */
function recordingOperations(overrides: Partial<SearchOperations> = {}) {
  const calls = {
    vector: 0,
    bm25: 0,
    graph: 0,
    pageIndex: 0,
    rerank: 0,
    loadParents: 0,
    seenRerankCandidates: 0,
  }
  const operations: SearchOperations = {
    vectorSearch: async () => {
      calls.vector += 1
      return knowledgeCorpus()
    },
    bm25Search: async () => {
      calls.bm25 += 1
      return []
    },
    graphSearch: async () => {
      calls.graph += 1
      return []
    },
    pageIndexSearch: async () => {
      calls.pageIndex += 1
      return []
    },
    rerank: async (_query, incoming) => {
      calls.rerank += 1
      calls.seenRerankCandidates = incoming.length
      return incoming
    },
    loadParents: async () => {
      calls.loadParents += 1
      return []
    },
    ...overrides,
  }
  return { operations, calls }
}

function recordingReranker(model = "task-scoped-rerank-model") {
  const reranker = {
    model,
    calls: 0,
    async rerank(_query: string, results: RetrievalResult[]) {
      reranker.calls += 1
      return results
    },
  }
  return reranker as typeof reranker & Reranker
}

function attachmentChannel(
  rows: RetrievalResult[] = [
    result(
      "att-1",
      "附件《以旧换新活动规则》第 2 条：补贴上限 500 元。",
      "attachment",
      { origin: "attachment", attachmentName: "以旧换新活动规则.pdf", attachmentSessionId: "sess-1" }
    ),
  ]
) {
  const seen: Array<{ sessionId: string; tenantId: string; subjectId: string }> = []
  const attachments: AttachmentSearchOperations = {
    async search(request) {
      seen.push({
        sessionId: request.sessionId,
        tenantId: request.tenantId,
        subjectId: request.subjectId,
      })
      return rows
    },
  }
  return { attachments, seen }
}

const FAQ_ROW: FaqActiveIdentityRow = {
  entryId: "faq-1",
  version: 3,
  question: "如何申请退货",
  normalizedQuestion: "如何申请退货",
  variants: [],
  answer: "在订单页点击申请退货，14 天内有效。",
  source: null,
}

/**
 * `createFaqEvidenceOperations` reads the service through `listActive` only,
 * so a stub that answers exactly that call is the whole dependency.
 */
function faqChannel(rows: FaqActiveIdentityRow[] = [FAQ_ROW]) {
  const seen: Array<{ tenantId: string; knowledgeBaseIds: readonly string[] }> = []
  const service = {
    listActive(tenantId: string, knowledgeBaseIds: readonly string[]) {
      seen.push({ tenantId, knowledgeBaseIds })
      return rows
    },
  }
  return { faq: service as unknown as FaqEntryService, seen }
}

function webChannel(
  outcome: Awaited<ReturnType<WebEvidenceOperations["search"]>> = {
    status: "ok",
    results: [
      result(
        "web-1",
        "官方页面：自 2026 年起退货窗口延长至 30 天。",
        "web",
        { origin: "web", webUrl: "https://example.com/returns", webFetchedAt: "2026-09-24T00:00:00.000Z" }
      ),
    ],
  }
) {
  const seen: Array<{ message: string; requested: boolean }> = []
  const web: WebEvidenceOperations = {
    async search(request) {
      seen.push({ message: request.message, requested: request.requested })
      return outcome
    },
  }
  return { web, seen }
}

function buildStack(overrides: Partial<AnswerRetrievalStackContext> = {}) {
  return createAnswerRetrievalStack({
    config,
    db,
    elasticsearch: {} as ElasticsearchClient,
    embeddingClient: {} as OpenAI,
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// #1 — an injected scope is retrieved through the injected operations only
// ---------------------------------------------------------------------------

test("ARCH-01C #1: an injected scope retrieves through its own operations, not a second composition", async () => {
  const { operations, calls } = recordingOperations()
  const taskReranker = recordingReranker()
  const stack = buildStack({ searchOperations: operations, reranker: taskReranker })

  // The SAME object is what the entry publishes to retrieval-debug (ticket 14).
  assert.equal(stack.searchOperations, operations)
  const outcome = await stack
    .createSearcher(ASSISTANT_WITH_RERANK)
    .search({ text: "退货窗口是多久" }, { accessContext, retrievalScope: knowledgeScope })

  assert.equal(outcome.status, "ok")
  assert.deepEqual(
    [calls.vector, calls.bm25, calls.graph, calls.pageIndex],
    [1, 1, 1, 1],
    "vector, BM25, graph and PageIndex all read through the injected scope"
  )
  assert.equal(calls.rerank, 1, "the scope's own rerank step is the one that ran")
  assert.equal(calls.seenRerankCandidates, 2, "the rerank step saw the fused candidate set")
  assert.equal(
    taskReranker.calls,
    0,
    "the stack did not compose a second retrieval path that could reach business resources"
  )
  assert.equal(
    stack.rerankModel,
    "task-scoped-rerank-model",
    "the frozen snapshot still names the reranker this composition resolved"
  )
})

test("ARCH-01C #1: without injected operations the stack composes the default ones", () => {
  const { operations } = recordingOperations()
  assert.equal(
    buildStack({ searchOperations: operations }).searchOperations,
    operations,
    "an injected scope's operations are used verbatim"
  )
  const defaulted = buildStack({})
  assert.ok(
    defaulted.searchOperations !== operations,
    "a run with no injection gets the stack's own operations"
  )
  assert.equal(typeof defaulted.createSearcher, "function")
})

// ---------------------------------------------------------------------------
// #5 — an injected scope never carries the assistant rerank overlay
// ---------------------------------------------------------------------------

test("ARCH-01C #5: an injected scope is not swapped by a rerank-free assistant snapshot", async () => {
  const { operations, calls } = recordingOperations()
  const stack = buildStack({ searchOperations: operations })

  const bound = stack.createSearcher(ASSISTANT_WITH_RERANK)
  const pinnedOff = stack.createSearcher(ASSISTANT_RERANK_FREE)
  assert.notEqual(bound, pinnedOff, "each run gets its own searcher")

  for (const [label, searcher] of [
    ["rerank-bound", bound],
    ["rerank-free", pinnedOff],
  ] as const) {
    const outcome = await searcher.search(
      { text: "退货窗口是多久" },
      { accessContext, retrievalScope: knowledgeScope }
    )
    assert.equal(outcome.status, "ok", `${label} retrieved`)
    assert.equal(
      calls.rerank,
      label === "rerank-bound" ? 1 : 2,
      `${label} ran the injected scope's rerank step`
    )
  }
  assert.equal(
    calls.vector,
    2,
    "both searches read the same injected operations — no hidden second index"
  )
})

// ---------------------------------------------------------------------------
// #3 — the optional evidence channels still reach the searcher
// ---------------------------------------------------------------------------

test("ARCH-01C #3: the attachment and FAQ channels reach retrieval through the stack with their provenance", async () => {
  const { operations } = recordingOperations()
  const { attachments, seen: attachmentCalls } = attachmentChannel()
  const { faq, seen: faqCalls } = faqChannel()
  const stack = buildStack({ searchOperations: operations, attachments, faq })

  const outcome = await stack.createSearcher(ASSISTANT_WITH_RERANK).search(
    { text: "如何申请退货" },
    {
      accessContext,
      retrievalScope: knowledgeScope,
      attachments: { sessionId: "sess-1" },
    }
  )

  assert.deepEqual(
    attachmentCalls,
    [{ sessionId: "sess-1", tenantId: accessContext.tenantId, subjectId: accessContext.subjectId }],
    "the attachment channel sees exactly this run's session and identity"
  )
  assert.deepEqual(
    faqCalls,
    [{ tenantId: accessContext.tenantId, knowledgeBaseIds: ["kb-1"] }],
    "the FAQ channel is confined to this run's knowledge scope"
  )

  const attachment = outcome.results.find((r) => r.source === "attachment")
  assert.ok(attachment, "the attachment joined the fused evidence set")
  assert.equal(attachment.chunk.metadata.origin, "attachment")
  assert.equal(attachment.chunk.metadata.attachmentName, "以旧换新活动规则.pdf")

  const faqEvidence = outcome.results.find((r) => r.source === "faq")
  assert.ok(faqEvidence, "the fuzzy FAQ match joined the fused evidence set")
  assert.equal(faqEvidence.chunk.metadata.origin, "faq")
  assert.equal(faqEvidence.chunk.metadata.faqEntryId, "faq-1")
  assert.equal(faqEvidence.chunk.metadata.faqVersion, 3)
  assert.ok(
    faqEvidence.chunk.content.includes("在订单页点击申请退货"),
    "the standard answer travels with the question so the generator can cite it"
  )
})

test("ARCH-01C #3: the Web channel runs for a run that carries a URL, through the stack", async () => {
  const { operations } = recordingOperations()
  const { web, seen } = webChannel()
  const stack = buildStack({ searchOperations: operations, web })

  const outcome = await stack.createSearcher(ASSISTANT_WITH_RERANK).search(
    { text: "请核对 https://example.com/returns 上的退货窗口" },
    { accessContext, retrievalScope: knowledgeScope }
  )

  assert.equal(seen.length, 1, "the adapter was consulted once")
  assert.equal(seen[0].requested, false, "a pasted URL is not an explicit web opt-in")
  const webEvidence = outcome.results.find((r) => r.source === "web")
  assert.ok(webEvidence, "the fetched page joined the fused evidence set")
  assert.equal(webEvidence.chunk.metadata.origin, "web")
  assert.equal(webEvidence.chunk.metadata.webUrl, "https://example.com/returns")
})

// ---------------------------------------------------------------------------
// #4 — a missing capability is an honest absence, never a new failure mode
// ---------------------------------------------------------------------------

test("ARCH-01C #4: a composition without FAQ, attachments, Web or a reranker behaves as it always did", async () => {
  const { operations, calls } = recordingOperations()
  const stack = buildStack({ searchOperations: operations })

  assert.equal(stack.rerankModel, null, "no RERANK_API_KEY → the snapshot names no model")

  // The same request shapes that fired the channels above, with none wired.
  const plain = await stack.createSearcher(ASSISTANT_WITH_RERANK).search(
    { text: "如何申请退货" },
    { accessContext, retrievalScope: knowledgeScope, attachments: { sessionId: "sess-1" } }
  )
  const urlBearing = await stack.createSearcher(ASSISTANT_WITH_RERANK).search(
    { text: "请核对 https://example.com/returns 上的退货窗口" },
    { accessContext, retrievalScope: knowledgeScope, webRequested: true }
  )

  for (const [label, outcome] of [
    ["session-scoped", plain],
    ["web-requested", urlBearing],
  ] as const) {
    assert.equal(outcome.status, "ok", `${label} still answered from the knowledge channels`)
    assert.deepEqual(
      outcome.results.map((r) => r.source),
      ["vector", "vector"],
      `${label} carries no invented evidence`
    )
  }
  assert.equal(calls.vector, 2, "both runs went through the injected knowledge channels")
})

test("ARCH-01C #4: an explicit empty knowledge scope keeps its fail-closed outcome", async () => {
  const { operations, calls } = recordingOperations()
  const { attachments } = attachmentChannel()
  const { faq, seen: faqCalls } = faqChannel()
  const stack = buildStack({ searchOperations: operations, attachments, faq })

  const outcome = await stack.createSearcher(ASSISTANT_WITH_RERANK).search(
    { text: "如何申请退货" },
    { accessContext, retrievalScope: { knowledgeBaseIds: [] } }
  )

  assert.equal(outcome.status, "insufficient", "no knowledge context means no evidence")
  assert.equal(calls.vector, 0, "nothing was queried at all")
  assert.equal(faqCalls.length, 0, "FAQ entries are knowledge, so an empty scope excludes them")
})

test("ARCH-01C #4: a session without attachments keeps the established knowledge-only evidence set", async () => {
  const { operations } = recordingOperations()
  const { attachments, seen } = attachmentChannel([])
  const stack = buildStack({ searchOperations: operations, attachments })

  const outcome = await stack.createSearcher(ASSISTANT_WITH_RERANK).search(
    { text: "退货窗口是多久" },
    { accessContext, retrievalScope: knowledgeScope, attachments: { sessionId: "sess-empty" } }
  )

  assert.equal(seen.length, 1, "the channel was consulted and reported honestly empty")
  assert.equal(outcome.status, "ok")
  assert.deepEqual(
    outcome.results.map((r) => r.source),
    ["vector", "vector"],
    "an empty session adds nothing rather than failing the run"
  )
})

test("configured physical index owns both ordinary and rerank-free assistant retrieval", async () => {
  const indices: string[] = []
  const stack = buildStack({
    config: {...config, esChunkIndexName: "selected-v2"},
    elasticsearch: { search: async ({index}: {index: string}) => {
      indices.push(index)
      return { hits: { hits: [{_score: 1, _source: chunk("selected", index === "selected-v2" ? "new content" : "old content")} ] } }
    }} as unknown as ElasticsearchClient,
    embeddingClient: {embeddings: {create: async () => ({data: [{embedding: [1, 0, 0]}]})}} as unknown as OpenAI,
  })
  for (const assistant of [ASSISTANT_WITH_RERANK, ASSISTANT_RERANK_FREE]) {
    const output = await stack.createSearcher(assistant).search({text: "query"})
    assert.ok(output.results.length > 0)
    assert.equal(output.results[0].chunk.content, "new content")
  }
  assert.ok(indices.length >= 4)
  assert.ok(indices.every(index => index === "selected-v2"))
})
