/**
 * Ticket 22 (ATT-01) — the session-scoped attachment channel of retrieval.
 *
 * The searcher seam is where "retrieve and cite them only inside that
 * session" becomes observable: the channel runs with the run's OWN session
 * triple, an empty knowledge selection no longer swallows a session's own
 * attachments, another session's attachment is unreachable even for the same
 * user, and the published evidence carries temporary provenance that the
 * assembler renders as such.
 */

import assert from "node:assert/strict"
import test from "node:test"

import { openDb } from "../../ingestion/tracking/db"
import { createIngestionLifecycle } from "../../ingestion/pipeline"
import { ContextAssemblerImpl } from "../context/assembler"
import { buildEvidence } from "../../answer/evidence"
import { SessionAttachmentService } from "../../attachments/session_attachment_service"
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

function buildAttachments() {
  const db = openDb(":memory:")
  const service = new SessionAttachmentService(db, {
    lifecycle: createIngestionLifecycle(db, {
      stageRunner: { run: async () => ({}), close: async () => {} },
      activationMode: "auto",
    }),
  })
  return { db, service }
}

const file = (name: string, content: string) => ({
  name,
  content: Buffer.from(content, "utf8"),
})

function knowledge(id: string, documentId = "doc-kb"): RetrievalResult {
  return {
    chunk: {
      id,
      documentId,
      content: `knowledge-${id}`,
      childrenIds: [],
      metadata: { source: "kb", title: "知识库文档" },
    },
    score: 1,
    source: "bm25",
    wikilinks: [],
  }
}

test("the attachment channel joins a search only when the run carries a session", async () => {
  const { service } = buildAttachments()
  await service.submit("sess-1", "t1", "alice", [file("policy.md", "退款将在三个工作日内到账")])

  const seen: Array<{ sessionId: string; tenantId: string; subjectId: string }> = []
  const searcher = new SearcherImpl(
    operations({ bm25Search: async () => [knowledge("kb-1")] }),
    {
      search: async (request) => {
        seen.push({
          sessionId: request.sessionId,
          tenantId: request.tenantId,
          subjectId: request.subjectId,
        })
        return service.search(request)
      },
    }
  )

  const withoutSession = await searcher.search({ text: "退款" }, { accessContext: context })
  assert.deepEqual(seen, [], "no session → the attachment channel is not consulted")
  assert.deepEqual(withoutSession.results.map((result) => result.source), ["bm25"])

  const withSession = await searcher.search(
    { text: "退款 三个工作日" },
    { accessContext: context, attachments: { sessionId: "sess-1" } }
  )
  assert.deepEqual(seen, [{ sessionId: "sess-1", tenantId: "t1", subjectId: "alice" }])
  const attachmentHits = withSession.results.filter((result) => result.source === "attachment")
  assert.equal(attachmentHits.length, 1)
  assert.equal(attachmentHits[0].chunk.metadata.attachmentName, "policy.md")
  assert.equal(attachmentHits[0].chunk.metadata.attachmentSessionId, "sess-1")
})

test("a session with no knowledge selection still answers from its own attachments", async () => {
  const { service } = buildAttachments()
  await service.submit("sess-2", "t1", "alice", [file("notes.txt", "会议纪要：预算审批截止周五")])
  const searcher = new SearcherImpl(operations(), service)

  // Without attachments the empty knowledge scope stays the fail-closed
  // "insufficient" it always was.
  const empty = await searcher.search(
    { text: "预算" },
    { accessContext: context, retrievalScope: { knowledgeBaseIds: [] } }
  )
  assert.equal(empty.status, "insufficient")
  assert.deepEqual(empty.results, [])

  // With attachments the same scope still yields the session's own file.
  const withSession = await searcher.search(
    { text: "预算 审批" },
    {
      accessContext: context,
      retrievalScope: { knowledgeBaseIds: [] },
      attachments: { sessionId: "sess-2" },
    }
  )
  assert.notEqual(withSession.status, "insufficient")
  assert.deepEqual(withSession.results.map((result) => result.source), ["attachment"])
  assert.match(withSession.results[0].chunk.content, /预算/)

  // The same empty scope with NO attachment evidence keeps ticket 05's
  // fail-closed answer instead of turning into a silent "ok".
  const noHits = await searcher.search(
    { text: "完全没有出现过的词" },
    {
      accessContext: context,
      retrievalScope: { knowledgeBaseIds: [] },
      attachments: { sessionId: "sess-2" },
    }
  )
  assert.equal(noHits.status, "insufficient")
  assert.deepEqual(noHits.results, [])
})

test("another session's attachment is unreachable, even for the same user", async () => {
  const { service } = buildAttachments()
  await service.submit("sess-a", "t1", "alice", [file("a.txt", "甲会话独有的机密内容")])
  await service.submit("sess-b", "t1", "alice", [file("b.txt", "乙会话自己的内容")])
  const searcher = new SearcherImpl(operations(), service)

  const inB = await searcher.search(
    { text: "机密" },
    { accessContext: context, attachments: { sessionId: "sess-b" } }
  )
  assert.deepEqual(
    inB.results.filter((result) => result.source === "attachment"),
    [],
    "the other session's chunk must not be retrievable"
  )
  const inA = await searcher.search(
    { text: "机密" },
    { accessContext: context, attachments: { sessionId: "sess-a" } }
  )
  assert.equal(inA.results.filter((result) => result.source === "attachment").length, 1)
})

test("temporary citations say attachment, never knowledge-base membership", async () => {
  const { service } = buildAttachments()
  await service.submit("sess-cite", "t1", "alice", [file("faq.md", "常见问题：如何申请退款")])
  const attachmentResults = await service.search({
    sessionId: "sess-cite",
    tenantId: "t1",
    subjectId: "alice",
    query: "退款",
    limit: 20,
  })
  const evidence = buildEvidence([...attachmentResults, knowledge("kb-2")])
  const temporary = evidence.find((item) => item.origin === "attachment")
  const fromKnowledge = evidence.find((item) => item.source === "kb")

  assert.ok(temporary, "attachment evidence is labelled")
  assert.equal(temporary?.attachmentName, "faq.md")
  assert.equal(temporary?.attachmentSessionId, "sess-cite")
  assert.equal(temporary?.source, "附件:faq.md")
  assert.equal(fromKnowledge?.origin, undefined, "knowledge evidence is not relabelled")

  const assembler = new ContextAssemblerImpl()
  const contextText = await assembler.assemble([...attachmentResults, knowledge("kb-2")])
  assert.match(contextText, /\[临时引用: 附件 faq\.md\]/)
  assert.match(contextText, /临时附件，不属于知识库/)
  assert.match(contextText, /\[来源: kb\]/)
})

test("a fresh session has nothing to retrieve until a file is attached", async () => {
  const { service } = buildAttachments()
  const searcher = new SearcherImpl(operations(), service)
  const outcome = await searcher.search(
    { text: "任意问题" },
    { accessContext: context, attachments: { sessionId: "sess-empty" } }
  )
  assert.deepEqual(outcome.results, [], "an empty session contributes no evidence")
  assert.equal(outcome.unavailableChannels.length, 0, "and no channel is blamed for it")
})

// ---------------------------------------------------------------------------
// PT-02 AC05 — the three attachment degradations stay distinguishable:
// missing capability, a failing source, and a session that simply is empty.
// ---------------------------------------------------------------------------

test("PT-02 AC05: a failing attachment source degrades the search and names the channel", async () => {
  const searcher = new SearcherImpl(
    operations({ bm25Search: async () => [knowledge("kb-fail")] }),
    {
      search: async () => {
        throw new Error("attachment store unavailable")
      },
    }
  )
  const outcome = await searcher.search(
    { text: "退款" },
    { accessContext: context, attachments: { sessionId: "sess-failing" } }
  )
  assert.equal(outcome.status, "degraded", "a failed source is a degradation, not an empty session")
  assert.deepEqual(outcome.unavailableChannels, ["attachment"])
  assert.deepEqual(outcome.results.map((result) => result.source), ["bm25"])
})

test("PT-02 AC05: an empty knowledge scope with a failing attachment source stays insufficient and says why", async () => {
  const searcher = new SearcherImpl(operations(), {
    search: async () => {
      throw new Error("attachment store unavailable")
    },
  })
  const failed = await searcher.search(
    { text: "预算" },
    {
      accessContext: context,
      retrievalScope: { knowledgeBaseIds: [] },
      attachments: { sessionId: "sess-failing" },
    }
  )
  assert.equal(failed.status, "insufficient")
  assert.deepEqual(failed.unavailableChannels, ["attachment"], "the failed source is named")

  // The same scope with a healthy but EMPTY session is the other honest
  // answer: nothing to read, and no channel blamed for it.
  const { service } = buildAttachments()
  const empty = await new SearcherImpl(operations(), service).search(
    { text: "预算" },
    {
      accessContext: context,
      retrievalScope: { knowledgeBaseIds: [] },
      attachments: { sessionId: "sess-with-no-files" },
    }
  )
  assert.equal(empty.status, "insufficient")
  assert.deepEqual(empty.unavailableChannels, [], "an empty session blames no channel")
})

test("PT-02 AC05: a composition without attachment capability keeps the fail-closed empty scope", async () => {
  const searcher = new SearcherImpl(operations(), undefined, undefined, undefined)
  const outcome = await searcher.search(
    { text: "预算" },
    {
      accessContext: context,
      retrievalScope: { knowledgeBaseIds: [] },
      attachments: { sessionId: "sess-1" },
    }
  )
  assert.equal(outcome.status, "insufficient", "missing capability is not a silent pass")
  assert.deepEqual(outcome.results, [])
  assert.deepEqual(outcome.unavailableChannels, [], "and no channel is blamed for absent capability")
})

test("PT-02 AC04: every search of one run reads the same bound session triple", async () => {
  const { service } = buildAttachments()
  await service.submit("sess-same", "t1", "alice", [file("policy.md", "退款将在三个工作日内到账")])
  const seen: Array<{ sessionId: string; tenantId: string; subjectId: string }> = []
  const searcher = new SearcherImpl(operations(), {
    search: async (request) => {
      seen.push({
        sessionId: request.sessionId,
        tenantId: request.tenantId,
        subjectId: request.subjectId,
      })
      return service.search(request)
    },
  })

  for (const text of ["退款 到账", "退款 例外", "三个工作日"]) {
    await searcher.search(
      { text },
      { accessContext: context, retrievalScope: { knowledgeBaseIds: [] }, attachments: { sessionId: "sess-same" } }
    )
  }
  assert.deepEqual(
    seen,
    [1, 2, 3].map(() => ({ sessionId: "sess-same", tenantId: "t1", subjectId: "alice" })),
    "the bound identity is never rebuilt wider between searches"
  )
})
