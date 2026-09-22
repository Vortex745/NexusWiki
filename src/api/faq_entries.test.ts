/**
 * Ticket 30 (FAQ-01A) — the FAQ management API.
 *
 * The knowledge base is resolved by the SAME resolver the chat path uses, so
 * the tests drive that seam with a fake that refuses unknown ids (404) and an
 * archived base (409). Everything else is the real router over the real
 * repository (in-memory SQLite).
 */
import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"
import type { Request, Response, NextFunction } from "express"
import { createFaqEntriesRouter } from "./faq_entries"
import { FaqEntryServiceImpl } from "../faq/faq_entry_service"
import { SqliteFaqEntryRepo } from "../faq/faq_entry_repo"
import { openDb } from "../ingestion/tracking/db"
import {
  InvalidKnowledgeBaseScopeError,
  KnowledgeBaseArchivedError,
  KnowledgeBaseNotFoundError,
} from "../knowledge/knowledge_base_service"
import type { RetrievalScopeResolver } from "../retrieval/scope"
import type { AccessContext, Scope } from "../access/context"

const ALL_SCOPES: Scope[] = ["chat", "ingest", "review", "admin"]
const READER_SCOPES: Scope[] = ["chat", "ingest"]

const scopeResolver: RetrievalScopeResolver = (_context, requested) => {
  const ids = Array.isArray(requested) ? requested.map(String) : []
  if (ids.length !== 1 || !ids[0]) {
    throw new InvalidKnowledgeBaseScopeError("exactly one knowledge base id is required")
  }
  if (ids[0] === "kb-archived") throw new KnowledgeBaseArchivedError(ids[0])
  if (ids[0] !== "kb-1") throw new KnowledgeBaseNotFoundError(ids[0])
  return { knowledgeBaseIds: [ids[0]] }
}

function buildApp(scopes: Scope[] = ALL_SCOPES) {
  const db = openDb(":memory:")
  const app = express()
  app.use(express.json())
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.locals.accessContext = {
      tenantId: "tenant-a",
      subjectId: "user-1",
      groups: [],
      scopes,
    } satisfies AccessContext
    next()
  })
  app.use(
    "/api",
    createFaqEntriesRouter({
      faqEntries: new FaqEntryServiceImpl({ repo: new SqliteFaqEntryRepo(db) }),
      scopeResolver,
    })
  )
  return { app, db }
}

async function listen(app: express.Express) {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

async function request(port: number, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as Record<string, any> | null,
  }
}

const faqsPath = (kb = "kb-1") => `/api/knowledge-bases/${kb}/faqs`

test("Ticket 30: FAQ management is an admin surface", async () => {
  const { app, db } = buildApp(READER_SCOPES)
  const { server, port } = await listen(app)
  try {
    assert.equal((await request(port, "GET", faqsPath())).status, 403)
    assert.equal(
      (await request(port, "POST", faqsPath(), { question: "q", answer: "a" })).status,
      403
    )
    assert.equal(
      (await request(port, "PATCH", `${faqsPath()}/faq-1`, { answer: "a" })).status,
      403
    )
    assert.equal(
      (await request(port, "POST", `${faqsPath()}/import`, { format: "json", content: "[]" })).status,
      403
    )
    assert.equal((await request(port, "GET", `${faqsPath()}/faq-1`)).status, 403)
    assert.equal((await request(port, "GET", `${faqsPath()}/faq-1/versions`)).status, 403)
    assert.equal((await request(port, "POST", `${faqsPath()}/faq-1/activate`)).status, 403)
    assert.equal((await request(port, "POST", `${faqsPath()}/faq-1/disable`)).status, 403)
    assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM faq_entries").get(), { n: 0 })
  } finally {
    server.close()
    db.close()
  }
})

test("Ticket 30: CRUD is knowledge-scoped and versioned", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const created = await request(port, "POST", faqsPath(), {
      question: "退款多久到账？",
      answer: "3 个工作日。",
      variants: ["退款几天到", "退款几天到"],
      source: { title: "财务手册", uri: "https://x.test/finance" },
    })
    assert.equal(created.status, 200)
    const id = created.json?.entry.id as string
    assert.equal(created.json?.entry.status, "active")
    assert.equal(created.json?.entry.currentVersion, 1)
    assert.deepEqual(
      created.json?.entry.version.variants,
      ["退款几天到"],
      "variants are deduplicated"
    )

    const listed = await request(port, "GET", faqsPath())
    assert.equal(listed.status, 200)
    assert.equal((listed.json?.entries as unknown[]).length, 1)

    const edited = await request(port, "PATCH", `${faqsPath()}/${id}`, {
      answer: "3 个工作日（节假日顺延）。",
    })
    assert.equal(edited.status, 200)
    assert.equal(edited.json?.entry.currentVersion, 2)
    assert.equal(
      edited.json?.entry.version.question,
      "退款多久到账？",
      "an omitted field keeps its current value"
    )

    const versions = await request(port, "GET", `${faqsPath()}/${id}/versions`)
    assert.equal(versions.status, 200)
    assert.deepEqual(
      (versions.json?.versions as Array<Record<string, unknown>>).map((item) => item.version),
      [1, 2]
    )
    assert.equal(
      (versions.json?.versions as Array<Record<string, unknown>>)[0].answer,
      "3 个工作日。",
      "version 1 is immutable"
    )

    // Knowledge scoping: another base id is refused by the resolver, not read.
    assert.equal((await request(port, "GET", faqsPath("kb-2"))).status, 404)
    assert.equal((await request(port, "GET", faqsPath("kb-archived"))).status, 409)
    assert.equal((await request(port, "GET", `${faqsPath()}/nope`)).status, 404)
  } finally {
    server.close()
    db.close()
  }
})

test("Ticket 30: a conflicting activation is a 409 with the offending entry", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const first = await request(port, "POST", faqsPath(), { question: "发票怎么开？", answer: "订单页申请。" })
    const second = await request(port, "POST", faqsPath(), {
      question: "物流多久到？",
      answer: "48 小时。",
    })
    const secondId = second.json?.entry.id as string
    assert.equal(second.status, 200)

    // A duplicate active question is refused at creation time.
    const duplicate = await request(port, "POST", faqsPath(), { question: "发票怎么开", answer: "x" })
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.json?.conflict.conflictingEntryId, first.json?.entry.id)

    // Disable it, collide it with the active question, then activation fails.
    assert.equal((await request(port, "POST", `${faqsPath()}/${secondId}/disable`)).status, 200)
    const collided = await request(port, "PATCH", `${faqsPath()}/${secondId}`, {
      question: "发票怎么开？",
      answer: "另一份答案",
    })
    assert.equal(collided.status, 200)
    assert.equal(collided.json?.entry.status, "disabled")

    const refused = await request(port, "POST", `${faqsPath()}/${secondId}/activate`)
    assert.equal(refused.status, 409)
    assert.equal(refused.json?.conflict.conflictingEntryId, first.json?.entry.id)
    assert.equal(refused.json?.conflict.normalizedQuestion, "发票怎么开")

    const listed = await request(port, "GET", `${faqsPath()}?status=disabled`)
    assert.deepEqual(
      (listed.json?.entries as Array<Record<string, unknown>>).map((item) => item.id),
      [secondId],
      "the disabled entry is still inspectable"
    )
    assert.equal((await request(port, "GET", `${faqsPath()}?status=bogus`)).status, 400)
  } finally {
    server.close()
    db.close()
  }
})

test("Ticket 30: imports report every rejected row and keep the accepted ones", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const json = await request(port, "POST", `${faqsPath()}/import`, {
      format: "json",
      content: JSON.stringify([
        { question: "支持哪些支付方式？", answer: "微信与银行卡。" },
        { question: "支持哪些支付方式？", answer: "重复行" },
        { question: "没有答案", answer: "" },
      ]),
    })
    assert.equal(json.status, 200)
    assert.equal(json.json?.result.imported, 1)
    assert.equal(json.json?.result.skipped, 2)
    assert.match((json.json?.result.issues as string[]).join("\n"), /row 2: duplicate question/)
    assert.match((json.json?.result.issues as string[]).join("\n"), /row 3: answer is required/)

    const csv = await request(port, "POST", `${faqsPath()}/import`, {
      format: "csv",
      content: 'question,answer\r\n"退款多久到账？","3 个工作日,原路退回。"',
    })
    assert.equal(csv.status, 200)
    assert.equal(csv.json?.result.imported, 1)

    const badFormat = await request(port, "POST", `${faqsPath()}/import`, {
      format: "xml",
      content: "<x/>",
    })
    assert.equal(badFormat.status, 400)
    assert.deepEqual(badFormat.json?.issues, ["format"])
    const badBody = await request(port, "POST", `${faqsPath()}/import`, { format: "json" })
    assert.equal(badBody.status, 400)

    const entries = await request(port, "GET", faqsPath())
    assert.equal((entries.json?.entries as unknown[]).length, 2)
    assert.equal((await request(port, "POST", `${faqsPath("kb-2")}/import`, { format: "json", content: "[]" })).status, 404)
  } finally {
    server.close()
    db.close()
  }
})
