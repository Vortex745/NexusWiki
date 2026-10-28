/**
 * Ticket 22 (ATT-01) — the attachment routes.
 *
 * Transport-level proof of the four acceptance rules: the limits answer with
 * the right status per file, a session cannot read (or promote) another
 * session's attachment, promotion needs the ingest capability and a real,
 * active target base, and cleanup retires only unpromoted rows.
 */

import assert from "node:assert/strict"
import test from "node:test"
import type { AddressInfo } from "node:net"
import type { RequestHandler } from "express"

import { openDb } from "../ingestion/tracking/db"
import { createApp } from "../api/server"
import { KnowledgeBaseServiceImpl } from "../knowledge/knowledge_base_service"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { SqliteSessionBinder } from "../access/session_binder"
import { SessionAttachmentService } from "../attachments/session_attachment_service"
import type { AnswerRunEvent } from "../types"
import type { AccessContext } from "../access/context"

function identity(ctx: Partial<AccessContext> & { scopes: AccessContext["scopes"] }): RequestHandler {
  return (_req, res, next) => {
    res.locals.accessContext = {
      tenantId: "t1",
      subjectId: "alice",
      groups: [],
      ...ctx,
    } as AccessContext
    next()
  }
}

async function listen(app: import("express").Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function buildHarness(scopes: AccessContext["scopes"] = ["chat", "ingest", "admin"]) {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  const db = openDb(":memory:")
  const knowledgeBases = new KnowledgeBaseServiceImpl(new SqliteKnowledgeBaseRepo(db), "test-embedding:3")
  const attachments = new SessionAttachmentService(db)
  const app = createApp({
    db,
    eventsSource: async function* (): AsyncIterable<AnswerRunEvent> {
      yield {} as AnswerRunEvent
    },
    accessMiddleware: identity({ scopes }),
    knowledgeBaseService: knowledgeBases,
    sessionBinder: new SqliteSessionBinder(db),
    attachments,
  })
  return { db, knowledgeBases, attachments, app }
}

async function upload(
  base: string,
  sessionId: string,
  name: string,
  content: string | Buffer
): Promise<{ status: number; body: { attachment?: { id: string; status: string }; error?: unknown } }> {
  const response = await fetch(`${base}/api/chat/sessions/${sessionId}/attachments`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-file-name": name },
    body: Buffer.isBuffer(content) ? new Uint8Array(content) : content,
  })
  return { status: response.status, body: (await response.json()) as never }
}

async function list(base: string, sessionId: string) {
  const response = await fetch(`${base}/api/chat/sessions/${sessionId}/attachments`)
  return { status: response.status, body: (await response.json()) as never }
}

test("an upload is listed with its parse status, usage and the session limits", async () => {
  const harness = buildHarness()
  const { base, close } = await listen(harness.app)
  try {
    const created = await upload(base, "sess-1", "policy.md", "# 政策\n退款三个工作日")
    assert.equal(created.status, 201)
    assert.equal(created.body.attachment?.status, "ready")

    const listed = await list(base, "sess-1")
    assert.equal(listed.status, 200)
    const payload = listed.body as unknown as {
      attachments: Array<{ name: string; status: string }>
      limits: { maxFiles: number; maxFileBytes: number; maxSessionBytes: number }
      usage: { live: number; bytes: number }
    }
    assert.deepEqual(payload.attachments.map((item) => [item.name, item.status]), [["policy.md", "ready"]])
    assert.deepEqual(payload.limits, {
      maxFiles: 5,
      maxFileBytes: 20 * 1024 * 1024,
      maxSessionBytes: 50 * 1024 * 1024,
      supportedExtensions: [
        ".pdf",
        ".csv",
        ".doc",
        ".docx",
        ".epub",
        ".htm",
        ".html",
        ".json",
        ".md",
        ".markdown",
        ".ppt",
        ".pptx",
        ".rtf",
        ".txt",
        ".xls",
        ".xlsx",
        ".xml",
        ".bmp",
        ".heic",
        ".jpeg",
        ".jpg",
        ".png",
        ".tif",
        ".tiff",
      ],
    } as never)
    assert.equal(payload.usage.live, 1)
    assert.equal(payload.usage.bytes, Buffer.byteLength("# 政策\n退款三个工作日"))
  } finally {
    await close()
  }
})

test("a percent-encoded UTF-8 attachment name round-trips through the header", async () => {
  // Browser clients percent-encode x-file-name (the Headers constructor
  // throws on non-Latin-1 values); the route decodes it back to the name.
  const harness = buildHarness()
  const { base, close } = await listen(harness.app)
  try {
    const created = await upload(base, "sess-utf8", encodeURIComponent("会议纪要.md"), "# 纪要")
    assert.equal(created.status, 201)
    const listed = await list(base, "sess-utf8")
    const payload = listed.body as unknown as { attachments: Array<{ name: string }> }
    assert.deepEqual(payload.attachments.map((item) => item.name), ["会议纪要.md"])
  } finally {
    await close()
  }
})

test("an unsupported x-parser override is refused with 400 before anything is stored", async () => {
  const harness = buildHarness()
  const { base, close } = await listen(harness.app)
  try {
    const response = await fetch(`${base}/api/chat/sessions/sess-parser/attachments`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": "policy.pdf",
        "x-parser": "definitely-not-a-parser",
      },
      body: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]),
    })
    assert.equal(response.status, 400)
    const body = (await response.json()) as { error?: string }
    assert.match(body.error ?? "", /x-parser must be one of:/)

    const listed = await list(base, "sess-parser")
    assert.deepEqual(
      (listed.body as unknown as { attachments: unknown[] }).attachments,
      [],
    )
  } finally {
    await close()
  }
})

test("limits and unsupported types answer per file, not as a failed batch", async () => {
  const harness = buildHarness()
  const { base, close } = await listen(harness.app)
  try {
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]) {
      const ok = await upload(base, "sess-limits", name, `内容 ${name}`)
      assert.equal(ok.status, 201, `${name} must be accepted`)
    }
    const sixth = await upload(base, "sess-limits", "f.txt", "内容 f.txt")
    assert.equal(sixth.status, 400)
    assert.equal((sixth.body.error as { kind?: string }).kind, "count")

    const unsupported = await upload(base, "sess-limits", "archive.zip", "PK")
    assert.equal(unsupported.status, 415)
    assert.equal((unsupported.body.error as { kind?: string }).kind, "unsupported_type")

    const empty = await upload(base, "sess-other", "empty.txt", "")
    assert.equal(empty.status, 400)
    assert.equal((empty.body.error as { kind?: string }).kind, "empty")

    const missingName = await fetch(`${base}/api/chat/sessions/sess-other/attachments`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: "内容",
    })
    assert.equal(missingName.status, 400)
  } finally {
    await close()
  }
})

test("one session cannot read or promote another session's attachment", async () => {
  const harness = buildHarness()
  const { base, close } = await listen(harness.app)
  try {
    const created = await upload(base, "sess-a", "a.txt", "甲会话的内容")
    const attachmentId = created.body.attachment?.id as string
    await upload(base, "sess-b", "b.txt", "乙会话的内容")

    const fromB = await list(base, "sess-b")
    assert.deepEqual(
      (fromB.body as unknown as { attachments: Array<{ name: string }> }).attachments.map((item) => item.name),
      ["b.txt"]
    )
    // The same user cannot promote a file that belongs to another session.
    const promoted = await fetch(
      `${base}/api/chat/sessions/sess-b/attachments/${attachmentId}/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ knowledgeBaseId: harness.knowledgeBases.ensureDefault("t1").id }),
      }
    )
    assert.equal(promoted.status, 404)
  } finally {
    await close()
  }
})

test("promotion needs the ingest capability and an active target base", async () => {
  const withoutIngest = buildHarness(["chat"])
  const first = await listen(withoutIngest.app)
  try {
    const created = await upload(first.base, "sess-auth", "memo.txt", "内容")
    const attachmentId = created.body.attachment?.id as string
    const denied = await fetch(
      `${first.base}/api/chat/sessions/sess-auth/attachments/${attachmentId}/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ knowledgeBaseId: "kb-anything" }),
      }
    )
    assert.equal(denied.status, 403)
  } finally {
    await first.close()
  }

  const harness = buildHarness()
  const { base, close } = await listen(harness.app)
  try {
    const created = await upload(base, "sess-promote", "memo.txt", "内容")
    const attachmentId = created.body.attachment?.id as string
    const unknown = await fetch(
      `${base}/api/chat/sessions/sess-promote/attachments/${attachmentId}/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ knowledgeBaseId: "kb-nope" }),
      }
    )
    assert.equal(unknown.status, 404)

    const target = harness.knowledgeBases.create("t1", "目标库")
    harness.knowledgeBases.archive(target.id, "t1")
    const archived = await fetch(
      `${base}/api/chat/sessions/sess-promote/attachments/${attachmentId}/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ knowledgeBaseId: target.id }),
      }
    )
    assert.equal(archived.status, 409)

    const active = harness.knowledgeBases.create("t1", "活跃库")
    const promoted = await fetch(
      `${base}/api/chat/sessions/sess-promote/attachments/${attachmentId}/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ knowledgeBaseId: active.id }),
      }
    )
    assert.equal(promoted.status, 201)
    const payload = (await promoted.json()) as {
      attachment: { status: string; promotedDocumentId: string }
      submission: { knowledgeBaseId: string; version: number }
    }
    assert.equal(payload.attachment.status, "promoted")
    assert.equal(payload.submission.knowledgeBaseId, active.id)
    assert.equal(payload.submission.version, 1)
    assert.equal(payload.attachment.promotedDocumentId, (
      payload as unknown as { submission: { docId: string } }
    ).submission.docId)
  } finally {
    await close()
  }
})

test("an unpromoted attachment can be removed, a promoted one cannot", async () => {
  const harness = buildHarness()
  const { base, close } = await listen(harness.app)
  try {
    const drop = await upload(base, "sess-remove", "drop.txt", "临时内容")
    const keep = await upload(base, "sess-remove", "keep.txt", "会被提升")
    const target = harness.knowledgeBases.create("t1", "目标库")
    await fetch(
      `${base}/api/chat/sessions/sess-remove/attachments/${keep.body.attachment?.id}/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ knowledgeBaseId: target.id }),
      }
    )

    const removed = await fetch(
      `${base}/api/chat/sessions/sess-remove/attachments/${drop.body.attachment?.id}`,
      { method: "DELETE" }
    )
    assert.equal(removed.status, 204)
    const refused = await fetch(
      `${base}/api/chat/sessions/sess-remove/attachments/${keep.body.attachment?.id}`,
      { method: "DELETE" }
    )
    assert.equal(refused.status, 409, "a promoted attachment belongs to the knowledge base now")

    const listed = await list(base, "sess-remove")
    const statuses = new Map(
      (listed.body as unknown as { attachments: Array<{ name: string; status: string }> }).attachments.map(
        (item) => [item.name, item.status]
      )
    )
    assert.equal(statuses.get("drop.txt"), "retired")
    assert.equal(statuses.get("keep.txt"), "promoted")
  } finally {
    await close()
  }
})

test("cleanup retires unpromoted rows and keeps promoted ones", async () => {
  const harness = buildHarness()
  const { base, close } = await listen(harness.app)
  try {
    const kept = await upload(base, "sess-clean", "keep.txt", "会被提升")
    await upload(base, "sess-clean", "drop.txt", "会被清理")
    const target = harness.knowledgeBases.create("t1", "目标库")
    const promotion = await fetch(
      `${base}/api/chat/sessions/sess-clean/attachments/${kept.body.attachment?.id}/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ knowledgeBaseId: target.id }),
      }
    )
    assert.equal(promotion.status, 201)

    const cleaned = await fetch(`${base}/api/chat/sessions/sess-clean/attachments`, { method: "DELETE" })
    assert.equal(cleaned.status, 200)
    assert.deepEqual((await cleaned.json()) as object, { retired: 1, kept: 1 })

    const listed = await list(base, "sess-clean")
    const byName = new Map(
      (listed.body as unknown as { attachments: Array<{ name: string; status: string }> }).attachments.map(
        (item) => [item.name, item.status]
      )
    )
    assert.equal(byName.get("keep.txt"), "promoted")
    assert.equal(byName.get("drop.txt"), "retired")
  } finally {
    await close()
  }
})
