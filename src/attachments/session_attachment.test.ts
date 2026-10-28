/**
 * Ticket 22 (ATT-01) — temporary, session-isolated attachments.
 *
 * The proof lives at the service seam (the highest seam that owns the rules):
 * limits are reported per file, one session cannot see another's attachments
 * even for the same user, the retrieval channel returns only this session's
 * chunks with attachment provenance, promotion is explicit and obeys the
 * normal same-name/version rules, and cleanup cannot touch a promoted
 * document or another session's rows.
 */

import assert from "node:assert/strict"
import test from "node:test"

import { openDb } from "../ingestion/tracking/db"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import { createIngestionLifecycle } from "../ingestion/pipeline"
import {
  SameNameIntentRequiredError,
  type IngestionLifecycle,
  type IngestionStageRunner,
} from "../ingestion/lifecycle"
import {
  AttachmentNotPromotableError,
  MAX_ATTACHMENTS_PER_SESSION,
  MAX_ATTACHMENT_BYTES,
  MAX_SESSION_ATTACHMENT_BYTES,
  SessionAttachmentNotFoundError,
  SessionAttachmentService,
} from "./session_attachment_service"

/** The stage runner seam stands in for the external parsers/ES in tests. */
function fakeStageRunner(): IngestionStageRunner {
  return {
    run: async () => ({}),
    close: async () => {},
  }
}

function buildService(db = openDb(":memory:")) {
  const lifecycle = createIngestionLifecycle(db, { stageRunner: fakeStageRunner(), activationMode: "auto" })
  return { db, lifecycle, service: new SessionAttachmentService(db, { lifecycle }) }
}

const file = (name: string, content: string | Buffer, mimeType?: string) => ({
  name,
  ...(mimeType ? { mimeType } : {}),
  content: Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"),
})

/** Background extraction settles after the upload; poll the row like a client. */
async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("condition was not met in time")
}

test("limits: five files, 20 MB each and 50 MB per session, reported per file", async () => {
  const { service } = buildService()

  // Six files in one batch: the fifth is accepted, the sixth is refused by
  // count — and the batch still reports every accepted file.
  const batch = await service.submit("sess-limits", "t1", "alice", [
    file("a.txt", "甲"),
    file("b.txt", "乙"),
    file("c.txt", "丙"),
    file("d.txt", "丁"),
    file("e.txt", "戊"),
    file("f.txt", "己"),
  ])
  assert.deepEqual(batch.map((outcome) => outcome.ok), [true, true, true, true, true, false])
  const refusedByCount = batch[5]
  assert.equal(refusedByCount.ok, false)
  assert.equal(!refusedByCount.ok && refusedByCount.error.kind, "count")
  assert.equal(service.list("sess-limits", "t1", "alice").length, MAX_ATTACHMENTS_PER_SESSION)

  // A per-file size overflow is one rejected file, not a failed batch.
  const oversized = await service.submit("sess-size", "t1", "alice", [
    file("ok.txt", "正常内容"),
    file("huge.txt", Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x61)),
  ])
  assert.equal(oversized[0].ok, true)
  assert.equal(!oversized[1].ok && oversized[1].error.kind, "file_size")

  // The session total is checked against what the session already holds.
  const third = Math.floor(MAX_SESSION_ATTACHMENT_BYTES / 3) + 1
  const first = await service.submit("sess-total", "t1", "alice", [
    file("one.txt", Buffer.alloc(third, 0x62)),
    file("two.txt", Buffer.alloc(third, 0x62)),
  ])
  assert.deepEqual(first.map((outcome) => outcome.ok), [true, true])
  const over = await service.submit("sess-total", "t1", "alice", [
    file("three.txt", Buffer.alloc(third, 0x62)),
  ])
  assert.equal(!over[0].ok && over[0].error.kind, "session_size")
  assert.equal(service.list("sess-total", "t1", "alice").length, 2)

  // Unsupported types and empty files are refused with their own reason.
  const types = await service.submit("sess-types", "t1", "alice", [
    file("archive.zip", Buffer.from("PK\u0003\u0004")),
    file("empty.txt", ""),
  ])
  assert.equal(!types[0].ok && types[0].error.kind, "unsupported_type")
  assert.equal(!types[1].ok && types[1].error.kind, "empty")
})

test("a binary document is extracted through the import parser in the background", async () => {
  const db = openDb(":memory:")
  const lifecycle = createIngestionLifecycle(db, { stageRunner: fakeStageRunner(), activationMode: "auto" })
  const service = new SessionAttachmentService(db, {
    lifecycle,
    // The same seam the import pipeline injects — no external executable runs.
    parserFor: () => ({
      type: "builtin-pdf" as const,
      parse: async () => [
        {
          id: "block-1",
          index: 0,
          type: "paragraph" as const,
          text: "扫描件正文：退款将在三个工作日内原路退回。",
          sectionPath: [],
          metadata: {},
          provenance: { parser: "builtin-pdf" as const, adapter: "script" as const },
        },
      ],
    }),
  })

  const [outcome] = await service.submit("sess-pdf", "t1", "alice", [
    file("scan.pdf", Buffer.from("%PDF-1.4")),
  ])
  assert.equal(outcome.ok, true)
  // The upload does not wait for the parser; the row is observable as parsing.
  assert.equal(outcome.ok && outcome.attachment.status, "parsing")
  const attachmentId = outcome.ok ? outcome.attachment.id : ""
  await waitFor(() => service.get(attachmentId, "sess-pdf", "t1", "alice")?.status === "ready")

  const hits = await service.search({
    sessionId: "sess-pdf", tenantId: "t1", subjectId: "alice", query: "退款", limit: 20,
  })
  assert.ok(hits.length >= 1)
  assert.match(hits[0].chunk.content, /退款/)
})

test("isolation: a session only ever sees its own attachments", async () => {
  const { service } = buildService()
  await service.submit("sess-a", "t1", "alice", [file("secret.md", "# 秘密\n仅属于会话 A 的内容")])
  await service.submit("sess-b", "t1", "alice", [file("other.md", "# 别的\n会话 B 自己的内容")])

  const fromA = service.list("sess-a", "t1", "alice")
  const fromB = service.list("sess-b", "t1", "alice")
  assert.equal(fromA.length, 1)
  assert.equal(fromB.length, 1)
  assert.notEqual(fromA[0].id, fromB[0].id)

  // Same user, other session: the id is invisible and unpromotable.
  assert.equal(service.get(fromA[0].id, "sess-b", "t1", "alice"), null)
  assert.equal(service.get(fromA[0].id, "sess-a", "t1", "bob"), null)
  assert.throws(
    () => service.promote(fromA[0].id, "sess-b", "t1", "alice", { knowledgeBaseId: "kb-a" }, "alice"),
    SessionAttachmentNotFoundError
  )

  // Retrieval is session-scoped too: B's question cannot reach A's chunk.
  const inA = await service.search({
    sessionId: "sess-a", tenantId: "t1", subjectId: "alice", query: "秘密", limit: 20,
  })
  const inB = await service.search({
    sessionId: "sess-b", tenantId: "t1", subjectId: "alice", query: "秘密", limit: 20,
  })
  assert.equal(inA.length, 1)
  assert.equal(inA[0].chunk.metadata.attachmentName, "secret.md")
  assert.deepEqual(inB, [])
})

test("retrieval carries attachment provenance, never public knowledge membership", async () => {
  const { service } = buildService()
  await service.submit("sess-cite", "t1", "alice", [
    file("policy.md", "# 退款政策\n退款将在三个工作日内原路退回。"),
    file("unrelated.md", "# 配送\n默认使用顺丰快递。"),
  ])

  const results = await service.search({
    sessionId: "sess-cite",
    tenantId: "t1",
    subjectId: "alice",
    query: "退款 政策",
    limit: 20,
  })
  assert.ok(results.length >= 1)
  const top = results[0]
  assert.equal(top.source, "attachment")
  assert.equal(top.chunk.metadata.origin, "attachment")
  assert.equal(top.chunk.metadata.attachmentName, "policy.md")
  assert.match(top.chunk.content, /退款/)
  // The chunk is neither a knowledge-base document nor owned by one.
  assert.equal("knowledgeBaseId" in top.chunk.metadata, false)
  assert.equal(top.chunk.tenantId, "t1")
})

test("promotion is explicit, follows the same-name/version rules and is one-way", async () => {
  const { db, service, lifecycle } = buildService()
  const first = await service.submit("sess-promote", "t1", "alice", [file("policy.txt", "第一版政策")])
  assert.equal(first[0].ok, true)
  const attachmentId = first[0].ok ? first[0].attachment.id : ""

  const promotion = service.promote(
    attachmentId,
    "sess-promote",
    "t1",
    "alice",
    { knowledgeBaseId: "kb-target" },
    "alice"
  )
  assert.equal(promotion.submission.knowledgeBaseId, "kb-target")
  assert.equal(promotion.submission.version, 1)
  assert.equal(promotion.attachment.status, "promoted")
  assert.equal(promotion.attachment.promotedDocumentId, promotion.submission.docId)
  assert.equal(promotion.attachment.promotedKnowledgeBaseId, "kb-target")

  // A promoted attachment cannot be promoted twice (nor retired).
  assert.throws(
    () => service.promote(attachmentId, "sess-promote", "t1", "alice", { knowledgeBaseId: "kb-target" }, "alice"),
    AttachmentNotPromotableError
  )

  // Same name + DIFFERENT content in the same session: the normal same-name
  // intent rule applies, and only an explicit intent creates version 2. The
  // rule only fires against an ACTIVE version, so the first promotion is
  // activated the way the pipeline would activate it.
  new DocumentRepo(db).activate(promotion.submission.docId)
  const secondUpload = await service.submit("sess-promote", "t1", "alice", [file("policy.txt", "第二版政策")])
  const secondId = secondUpload[0].ok ? secondUpload[0].attachment.id : ""
  assert.throws(
    () => service.promote(secondId, "sess-promote", "t1", "alice", { knowledgeBaseId: "kb-target" }, "alice"),
    SameNameIntentRequiredError
  )
  const versioned = service.promote(
    secondId,
    "sess-promote",
    "t1",
    "alice",
    { knowledgeBaseId: "kb-target", versionIntent: "new_version" },
    "alice"
  )
  assert.equal(versioned.submission.version, 2)
  assert.notEqual(versioned.submission.docId, promotion.submission.docId)

  // The promoted documents are real rows of the target knowledge base.
  const rows = db
    .prepare(`SELECT doc_id, knowledge_base_id FROM documents WHERE doc_id IN (?, ?)`)
    .all(promotion.submission.docId, versioned.submission.docId) as Array<{
      doc_id: string
      knowledge_base_id: string
    }>
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((row) => row.knowledge_base_id), ["kb-target", "kb-target"])
})

test("cleanup retires only this session's unpromoted attachments", async () => {
  const { service } = buildService()
  const sessionA = await service.submit("sess-clean-a", "t1", "alice", [
    file("keep.txt", "会被提升"),
    file("drop.txt", "会被清理"),
  ])
  const keepId = sessionA[0].ok ? sessionA[0].attachment.id : ""
  service.promote(keepId, "sess-clean-a", "t1", "alice", { knowledgeBaseId: "kb-x" }, "alice")

  const sessionB = await service.submit("sess-clean-b", "t1", "alice", [file("other.txt", "别的会话")])
  const otherId = sessionB[0].ok ? sessionB[0].attachment.id : ""

  const report = service.retire("sess-clean-a", "t1", "alice")
  assert.deepEqual(report, { retired: 1, kept: 1 })

  const afterA = service.list("sess-clean-a", "t1", "alice")
  assert.equal(afterA.find((item) => item.id === keepId)?.status, "promoted")
  assert.equal(afterA.find((item) => item.name === "drop.txt")?.status, "retired")
  // Another session is untouched, and the promoted document still exists.
  assert.equal(service.list("sess-clean-b", "t1", "alice")[0].id, otherId)
  assert.equal(service.list("sess-clean-b", "t1", "alice")[0].status, "ready")
  const retiredSearch = await service.search({
    sessionId: "sess-clean-a", tenantId: "t1", subjectId: "alice", query: "会被清理", limit: 20,
  })
  assert.deepEqual(retiredSearch, [], "a retired attachment is no longer retrievable")
})

test("promotion submits through the injected lifecycle seam with a session-scoped identity", async () => {
  const db = openDb(":memory:")
  const calls: Array<Record<string, unknown>> = []
  const fake = {
    submit: (input: Record<string, unknown>) => {
      calls.push(input)
      return { docId: "doc-1", taskId: 1, status: "pending", version: 1, knowledgeBaseId: "kb" }
    },
  } as unknown as IngestionLifecycle
  const service = new SessionAttachmentService(db, { lifecycle: fake })
  const uploaded = await service.submit("sess-seam", "t1", "alice", [file("memo.md", "内容")])
  const id = uploaded[0].ok ? uploaded[0].attachment.id : ""
  service.promote(id, "sess-seam", "t1", "alice", { knowledgeBaseId: "kb", versionIntent: "new_document" }, "alice")

  assert.equal(calls.length, 1)
  const input = calls[0] as {
    knowledgeBaseId: string
    versionIntent: string
    rawContent: Buffer
    sourceIdentity: { kind: string; uriOrExternalId: string; namespace: string; tenantId: string }
    metadata: { attachmentId: string; promotedBy: string }
  }
  assert.equal(input.knowledgeBaseId, "kb")
  assert.equal(input.versionIntent, "new_document")
  assert.equal(input.rawContent.toString("utf8"), "内容")
  // The identity is session-scoped: the same file name in two sessions is two
  // sources, and the tenant travels with it.
  assert.equal(input.sourceIdentity.kind, "attachment")
  assert.equal(input.sourceIdentity.uriOrExternalId, "sess-seam:memo.md")
  assert.equal(input.sourceIdentity.namespace, "session-attachment")
  assert.equal(input.sourceIdentity.tenantId, "t1")
  assert.equal(input.metadata.attachmentId, id)
  assert.equal(input.metadata.promotedBy, "alice")
})
