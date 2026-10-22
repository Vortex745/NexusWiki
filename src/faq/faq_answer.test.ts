/**
 * Ticket 31 (FAQ-01B) — exact FAQ answers and fuzzy FAQ evidence.
 *
 * Everything observable on the answer path:
 *  - a UNIQUE normalized exact match answers directly with the stored
 *    standard answer (no routing, no model, no validation) and cites the
 *    FAQ version it published;
 *  - ambiguous / missing matches, disabled entries, cross-knowledge entries
 *    and empty scopes never answer directly — they fall through to the
 *    normal runner;
 *  - fuzzy matches join retrieval as ordinary citable evidence (fusion, rerank,
 *    citation checks all apply) and stay distinguishable (`origin: "faq"`).
 */
import assert from "node:assert/strict"
import test from "node:test"

import { openDb } from "../ingestion/tracking/db"
import { SqliteFaqEntryRepo } from "./faq_entry_repo"
import { FaqEntryServiceImpl } from "./faq_entry_service"
import { matchExactFaq, matchFuzzyFaqs, FAQ_FUZZY_MIN_CHARS } from "./faq_matcher"
import {
  buildFaqEvidence,
  createFaqEvidenceOperations,
  faqChunkIdentity,
  faqRetrievalResult,
} from "./faq_evidence"
import { buildEvidence, referencesForReply } from "../answer/evidence"
import { SearcherImpl, type SearchOperations } from "../retrieval/search/searcher"
import {
  createFaqExactMatchRunner,
} from "../mastra/faq_exact_runner"
import type { MastraRunnerInput, MastraRunnerOutput } from "../mastra/chat_event_adapter"
import type { AccessContext } from "../access/context"
import type { RetrievalResult } from "../types"
import type { ConversationStore } from "../answer/conversation_store"

function buildFaqService() {
  const db = openDb(":memory:")
  let counter = 0
  const service = new FaqEntryServiceImpl({
    repo: new SqliteFaqEntryRepo(db),
    now: () => new Date("2026-09-23T00:00:00.000Z"),
    generateId: () => `faq-${++counter}`,
  })
  return { service, db }
}

const context: AccessContext = {
  tenantId: "tenant-a",
  subjectId: "alice",
  groups: [],
  scopes: ["chat"],
}

function runnerInput(overrides: Partial<MastraRunnerInput> = {}): MastraRunnerInput {
  return {
    message: "退款多久到账？",
    runId: "run-1",
    sessionId: "session-1",
    signal: new AbortController().signal,
    accessContext: context,
    ...overrides,
  }
}

const innerRecording = () => {
  const calls: MastraRunnerInput[] = []
  const inner = async (input: MastraRunnerInput): Promise<MastraRunnerOutput> => {
    calls.push(input)
    return {
      reply: "normal-path answer",
      status: "completed",
      references: [],
      degradation: { status: "none", unavailableChannels: [] },
      tokens: ["normal-path answer"],
      routeTrace: {},
      retrievalTrace: {},
      contextTrace: {},
      validationTrace: {},
    }
  }
  return { inner, calls }
}

function recordingMemoryStore() {
  const saved: Array<{ role: string; content: string; runId: string }> = []
  const store = {
    saveValidatedTurn(turn: { role: string; content: string; runId: string }) {
      saved.push({ role: turn.role, content: turn.content, runId: turn.runId })
    },
  } as unknown as ConversationStore
  return { store, saved }
}

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

// ---------------------------------------------------------------------------
// Exact matching
// ---------------------------------------------------------------------------

test("Ticket 31: a unique normalized exact match answers directly with the stored answer", () => {
  const { service } = buildFaqService()
  const entry = service.create("tenant-a", "kb-1", {
    question: "退款多久到账？",
    answer: "3 个工作日内原路退回。",
  }, "admin")

  // Whitespace padding, trailing punctuation and full-width forms normalize
  // to the same question (an INTERNAL extra space would be a different
  // normalized question by ticket 30's rule — it falls through instead).
  const match = matchExactFaq(service.listActive("tenant-a", ["kb-1"]), " 退款多久到账！ ")
  assert.ok(match)
  assert.equal(match.row.entryId, entry.id)
  assert.equal(match.row.answer, "3 个工作日内原路退回。")
  assert.equal(match.viaVariant, false)

  // A variant of the entry also matches exactly.
  service.edit("tenant-a", "kb-1", entry.id, { variants: ["退款几天能到"] }, "admin")
  const viaVariant = matchExactFaq(service.listActive("tenant-a", ["kb-1"]), "退款几天能到！")
  assert.ok(viaVariant)
  assert.equal(viaVariant.row.entryId, entry.id)
  assert.equal(viaVariant.viaVariant, true)
})

test("Ticket 31: ambiguous exact matches (same question in two in-scope knowledge bases) never answer directly", () => {
  const { service } = buildFaqService()
  service.create("tenant-a", "kb-1", {
    question: "退款多久到账？",
    answer: "3 个工作日。",
  }, "admin")
  service.create("tenant-a", "kb-2", {
    question: "退款多久到账",
    answer: "7 个工作日。",
  }, "admin")
  assert.equal(
    matchExactFaq(service.listActive("tenant-a", ["kb-1", "kb-2"]), "退款多久到账？"),
    null
  )
})

test("Ticket 31: disabled and cross-knowledge entries cannot match", () => {
  const { service } = buildFaqService()
  const entry = service.create("tenant-a", "kb-1", {
    question: "退款多久到账？",
    answer: "3 个工作日。",
  }, "admin")
  service.disable("tenant-a", "kb-1", entry.id)
  // listActive (the only answer-path surface) structurally excludes disabled.
  assert.equal(matchExactFaq(service.listActive("tenant-a", ["kb-1"]), "退款多久到账？"), null)

  service.create("tenant-a", "kb-2", {
    question: "发票怎么开？",
    answer: "在订单页申请。",
  }, "admin")
  // Another knowledge base's entry is invisible to kb-1's scope.
  assert.equal(matchExactFaq(service.listActive("tenant-a", ["kb-1"]), "发票怎么开？"), null)
})

test("Ticket 31: the exact-match runner publishes the cited standard answer without the normal path", async () => {
  const { service } = buildFaqService()
  const entry = service.create("tenant-a", "kb-1", {
    question: "退款多久到账？",
    answer: "3 个工作日内原路退回。",
  }, "admin")
  const row = service.listActive("tenant-a", ["kb-1"])[0]
  const expectedReply = `${row.answer} [cite:${buildFaqEvidence(row).id}]`
  const { inner, calls } = innerRecording()
  const { store, saved } = recordingMemoryStore()
  const runner = createFaqExactMatchRunner(
    { faq: service, conversationStore: store, resolveTenantId: (ctx) => ctx.tenantId },
    inner
  )

  const output = await runner(runnerInput({
    retrievalScope: { knowledgeBaseIds: ["kb-1"] },
  }))
  assert.equal(calls.length, 0, "the normal path must not run for a direct FAQ hit")
  assert.equal(output.status, "completed")
  assert.equal(output.reply, expectedReply)
  assert.equal(output.references.length, 1)
  assert.equal(output.references[0].origin, "faq")
  assert.equal(output.references[0].faqEntryId, entry.id)
  assert.equal(output.references[0].faqVersion, 1)
  assert.equal(output.references[0].title, "FAQ：退款多久到账？")
  assert.deepEqual(output.routeTrace.faqMatch, {
    entryId: entry.id,
    version: 1,
    question: "退款多久到账？",
    viaVariant: false,
  })
  // The exchange is a validated conversation turn like any completed answer.
  assert.deepEqual(
    saved.map(({ role }) => role),
    ["user", "assistant"]
  )
  assert.equal(saved[1].content, expectedReply)
  assert.equal(saved[1].runId, "run-1")
})

test("DR-10: a unique variant hit publishes the same cited standard answer", async () => {
  const { service } = buildFaqService()
  service.create("tenant-a", "kb-1", {
    question: "退款多久到账？",
    answer: "3 个工作日内原路退回。",
    variants: ["退款几天能到"],
  }, "admin")
  const row = service.listActive("tenant-a", ["kb-1"])[0]
  const { inner, calls } = innerRecording()
  const runner = createFaqExactMatchRunner(
    { faq: service, resolveTenantId: (ctx) => ctx.tenantId },
    inner
  )

  const output = await runner(runnerInput({
    message: "退款几天能到！",
    retrievalScope: { knowledgeBaseIds: ["kb-1"] },
  }))
  assert.equal(calls.length, 0)
  assert.equal(output.reply, `${row.answer} [cite:${buildFaqEvidence(row).id}]`)
  assert.equal(output.references.length, 1)
  assert.equal(output.references[0].faqEntryId, row.entryId)
  assert.equal(output.references[0].faqVersion, 1)
  assert.equal(output.routeTrace.faqMatch?.viaVariant, true)
})

test("Ticket 31: no match, ambiguous match or empty scope falls through to the normal runner", async () => {
  const { service } = buildFaqService()
  service.create("tenant-a", "kb-1", {
    question: "退款多久到账？",
    answer: "3 个工作日。",
  }, "admin")
  service.create("tenant-a", "kb-2", {
    question: "退款多久到账",
    answer: "7 个工作日。",
  }, "admin")
  const { inner, calls } = innerRecording()
  const runner = createFaqExactMatchRunner(
    { faq: service, resolveTenantId: (ctx) => ctx.tenantId },
    inner
  )

  // Ambiguous across the scope.
  await runner(runnerInput({ retrievalScope: { knowledgeBaseIds: ["kb-1", "kb-2"] } }))
  // Unrelated question.
  await runner(runnerInput({ message: "怎么开发票", retrievalScope: { knowledgeBaseIds: ["kb-1"] } }))
  // Empty scope: the FAQ service is not even consulted.
  await runner(runnerInput({ retrievalScope: { knowledgeBaseIds: [] } }))
  // No scope at all (legacy caller).
  await runner(runnerInput({}))

  assert.equal(calls.length, 4)
  assert.ok(calls.every((call) => call.message !== undefined))
})

// ---------------------------------------------------------------------------
// Fuzzy evidence
// ---------------------------------------------------------------------------

test("Ticket 31: fuzzy matching is containment with a length floor and a deterministic order", () => {
  const row = (entryId: string, question: string, variants: string[] = []) => ({
    entryId,
    version: 1,
    question,
    normalizedQuestion: question,
    variants,
    answer: "a",
    source: null,
  })
  const rows = [
    row("faq-b", "退货运费由谁承担呢"),
    row("faq-a", "退款政策是什么"),
    row("faq-short", "退货"),
  ]
  // Containment both ways counts above the floor.
  const matches = matchFuzzyFaqs(rows, "我想了解一下退款政策是什么方面的规定")
  assert.deepEqual(matches.map(({ entryId }) => entryId), ["faq-a"])
  // Below the floor a substring is ignored.
  const shortQuery = matchFuzzyFaqs(rows, "我想退货")
  assert.equal(shortQuery.length, 0)
  assert.ok(FAQ_FUZZY_MIN_CHARS > "退货".length)
  // Exact equality always counts even when short.
  const exactShort = matchFuzzyFaqs([row("faq-s", "退货")], "退货")
  assert.deepEqual(exactShort.map(({ entryId }) => entryId), ["faq-s"])
})

test("Ticket 31: fuzzy FAQ content joins retrieval as citable evidence through the searcher", async () => {
  const { service } = buildFaqService()
  service.create("tenant-a", "kb-1", {
    question: "退款政策是什么",
    answer: "签收后 7 天内可退款。",
    source: { title: "售后政策", uri: "https://example.com/faq" },
  }, "admin")

  let faqCalls = 0
  const faqEvidence = createFaqEvidenceOperations(service)
  const instrumented: typeof faqEvidence = {
    search: async (request) => {
      faqCalls += 1
      return faqEvidence.search(request)
    },
  }
  const searcher = new SearcherImpl(operations(), undefined, instrumented)

  const outcome = await searcher.search(
    { text: "我想了解一下退款政策是什么" },
    {
      accessContext: context,
      retrievalScope: { knowledgeBaseIds: ["kb-1"] },
    }
  )
  assert.equal(faqCalls, 1)
  assert.equal(outcome.results.length, 1)
  const faqResult: RetrievalResult = outcome.results[0]
  assert.equal(faqResult.source, "faq")
  assert.equal(faqResult.chunk.metadata.origin, "faq")
  assert.equal(faqResult.chunk.metadata.faqEntryId, "faq-1")
  assert.equal(faqResult.chunk.metadata.faqVersion, 1)

  // The evidence builder labels it, and the citation layer can cite it —
  // the fuzzy path never bypasses generation checks.
  const evidence = buildEvidence([faqResult])
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].origin, "faq")
  assert.equal(evidence[0].faqEntryId, "faq-1")
  assert.equal(evidence[0].faqVersion, 1)
  assert.equal(evidence[0].documentVersion, 1)
  assert.ok(evidence[0].excerpt.includes("标准答案"))
  const references = referencesForReply(`内容[cite:${evidence[0].id}]`, evidence)
  assert.equal(references.length, 1)
  assert.equal(references[0].origin, "faq")
})

test("Ticket 31: empty scope, no access context and no FAQ service never run the FAQ channel", async () => {
  const { service } = buildFaqService()
  let calls = 0
  const faqEvidence = createFaqEvidenceOperations(service)
  const spy: typeof faqEvidence = {
    search: async (request) => {
      calls += 1
      return faqEvidence.search(request)
    },
  }

  // Explicit empty scope → no FAQ channel (FAQ entries are knowledge).
  const emptyScope = new SearcherImpl(operations(), undefined, spy)
  const emptyOutcome = await emptyScope.search(
    { text: "退款政策是什么" },
    { accessContext: context, retrievalScope: { knowledgeBaseIds: [] } }
  )
  assert.equal(emptyOutcome.status, "insufficient")
  assert.equal(calls, 0)

  // No access context → the channel cannot resolve a tenant → not run.
  const noContext = new SearcherImpl(operations(), undefined, spy)
  await noContext.search({ text: "退款政策是什么" }, { retrievalScope: { knowledgeBaseIds: ["kb-1"] } })
  assert.equal(calls, 0)

  // No FAQ service wired → no channel at all.
  const plain = new SearcherImpl(operations())
  const plainOutcome = await plain.search(
    { text: "退款政策是什么" },
    { accessContext: context, retrievalScope: { knowledgeBaseIds: ["kb-1"] } }
  )
  assert.equal(plainOutcome.results.length, 0)
  assert.equal(calls, 0)
})

test("Ticket 31: both paths build the same stable evidence identity for one entry version", () => {
  const { service } = buildFaqService()
  const entry = service.create("tenant-a", "kb-1", {
    question: "退款多久到账？",
    answer: "3 个工作日。",
  }, "admin")
  const row = service.listActive("tenant-a", ["kb-1"]).find(({ entryId }) => entryId === entry.id)
  assert.ok(row)
  assert.deepEqual(faqChunkIdentity(row), {
    documentId: entry.id,
    chunkId: `faq:${entry.id}:v1`,
  })
  // The direct-answer reference and a fuzzy-path citation share the id.
  const direct = buildFaqEvidence(row)
  const viaFusion = buildEvidence([faqRetrievalResult(row)])[0]
  assert.equal(direct.id, viaFusion.id)
})
