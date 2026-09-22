/**
 * Ticket 30 (FAQ-01A) — versioned FAQ entries, conflict rules and imports.
 *
 * Everything runs against the real repository on an in-memory database: the
 * acceptance criteria are about stored state (versions, statuses, scoping) and
 * about precisely reported import rows, not about the SQL itself.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { openDb } from "../ingestion/tracking/db"
import { SqliteFaqEntryRepo } from "./faq_entry_repo"
import {
  FaqConflictError,
  FaqEntryNotFoundError,
  FaqEntryServiceImpl,
  InvalidFaqCommandError,
} from "./faq_entry_service"
import { normalizeFaqQuestion } from "../types/faq"

function build() {
  const db = openDb(":memory:")
  let counter = 0
  const service = new FaqEntryServiceImpl({
    repo: new SqliteFaqEntryRepo(db),
    now: () => new Date("2026-09-23T00:00:00.000Z"),
    generateId: () => `faq-${++counter}`,
  })
  return { service, db }
}

const draft = (extra: Record<string, unknown> = {}) => ({
  question: "退款多久到账？",
  answer: "3 个工作日内原路退回。",
  ...extra,
})

test("Ticket 30: an entry is created active at version 1 and edits add versions", () => {
  const { service } = build()
  const created = service.create("tenant-a", "kb-1", draft(), "admin")
  assert.equal(created.status, "active")
  assert.equal(created.currentVersion, 1)
  assert.equal(created.version.question, "退款多久到账？")
  assert.equal(created.version.normalizedQuestion, normalizeFaqQuestion("退款多久到账？"))
  assert.equal(created.version.createdBy, "admin")

  const edited = service.edit(
    "tenant-a",
    "kb-1",
    created.id,
    draft({ answer: "3 个工作日（节假日顺延）。" }),
    "admin"
  )
  assert.equal(edited.currentVersion, 2)
  assert.equal(edited.version.answer, "3 个工作日（节假日顺延）。")

  const versions = service.listVersions("tenant-a", "kb-1", created.id)
  assert.deepEqual(
    versions.map((item) => item.version),
    [1, 2],
    "history is kept, never rewritten"
  )
  assert.equal(versions[0].answer, "3 个工作日内原路退回。", "version 1 still holds its own text")

  // An edit that changes nothing adds no version.
  const unchanged = service.edit(
    "tenant-a",
    "kb-1",
    created.id,
    draft({ answer: "3 个工作日（节假日顺延）。" }),
    "admin"
  )
  assert.equal(unchanged.currentVersion, 2)
  assert.equal(service.listVersions("tenant-a", "kb-1", created.id).length, 2)
})

test("Ticket 30: an edit merges omitted fields with the version it reads", () => {
  const { service } = build()
  const created = service.create(
    "tenant-a",
    "kb-1",
    {
      question: "退款多久到账？",
      variants: ["退款几天到"],
      answer: "3 个工作日。",
      source: { title: "财务手册", uri: "https://x.test/finance" },
    },
    "admin"
  )
  const edited = service.edit("tenant-a", "kb-1", created.id, { answer: "5 个工作日。" }, "admin")
  assert.equal(edited.version.question, "退款多久到账？", "an omitted question keeps its value")
  assert.deepEqual(edited.version.variants, ["退款几天到"])
  assert.deepEqual(edited.version.source, { title: "财务手册", uri: "https://x.test/finance" })

  const cleared = service.edit("tenant-a", "kb-1", created.id, { source: null }, "admin")
  assert.equal(cleared.version.source, null, "an explicit null clears the source")
  assert.equal(cleared.version.answer, "5 个工作日。", "and the other fields stay")
})

test("Ticket 30: entries are knowledge-scoped and tenant-scoped", () => {
  const { service } = build()
  const created = service.create("tenant-a", "kb-1", draft(), "admin")
  assert.equal(service.get("tenant-a", "kb-2", created.id), null, "another base is not a read")
  assert.equal(service.get("tenant-b", "kb-1", created.id), null, "another tenant is not a read")
  assert.deepEqual(service.list("tenant-a", "kb-2"), [])
  assert.throws(
    () => service.edit("tenant-a", "kb-2", created.id, draft(), "admin"),
    FaqEntryNotFoundError
  )
  assert.throws(
    () => service.activate("tenant-b", "kb-1", created.id),
    FaqEntryNotFoundError
  )
})

test("Ticket 30: an active entry cannot be duplicated, normalization included", () => {
  const { service } = build()
  const first = service.create("tenant-a", "kb-1", draft(), "admin")

  // Width/case/punctuation/spacing differences are the same question.
  for (const question of ["退款多久到账", "  退款多久到账?  ", "退款多久到账？？"]) {
    try {
      service.create("tenant-a", "kb-1", draft({ question }), "admin")
      assert.fail(`expected a conflict for ${question}`)
    } catch (error) {
      assert.ok(error instanceof FaqConflictError)
      assert.equal(error.detail.conflictingEntryId, first.id)
      assert.equal(error.detail.viaVariant, false)
      assert.equal(error.detail.normalizedQuestion, normalizeFaqQuestion("退款多久到账"))
    }
  }

  // The rule covers variants in both directions.
  const withVariant = service.create(
    "tenant-a",
    "kb-1",
    { question: "发票怎么开？", variants: ["开发票"], answer: "在订单页申请。" },
    "admin"
  )
  assert.throws(
    () => service.create("tenant-a", "kb-1", { question: "开发票", answer: "x" }, "admin"),
    FaqConflictError,
    "a new question that matches another entry's variant conflicts"
  )
  try {
    service.create("tenant-a", "kb-1", { question: "怎么开发票", variants: ["发票怎么开"], answer: "x" }, "admin")
    assert.fail("expected a conflict through the new entry's variant")
  } catch (error) {
    assert.ok(error instanceof FaqConflictError)
    assert.equal(error.detail.conflictingEntryId, withVariant.id)
  }

  // A different knowledge base is a different question space.
  assert.doesNotThrow(() => service.create("tenant-a", "kb-2", draft(), "admin"))
})

test("Ticket 30: a disabled entry may collide but cannot be activated", () => {
  const { service } = build()
  const active = service.create("tenant-a", "kb-1", draft(), "admin")
  const other = service.create(
    "tenant-a",
    "kb-1",
    { question: "物流多久到？", answer: "48 小时。" },
    "admin"
  )
  service.disable("tenant-a", "kb-1", other.id)

  // A disabled entry may be edited into a colliding question — the rule is
  // about what retrieval could serve, and this one serves nothing.
  const collided = service.edit(
    "tenant-a",
    "kb-1",
    other.id,
    draft({ answer: "另一份答案" }),
    "admin"
  )
  assert.equal(collided.status, "disabled")
  assert.equal(collided.currentVersion, 2)
  assert.equal(collided.version.normalizedQuestion, normalizeFaqQuestion("退款多久到账？"))
  assert.equal(service.list("tenant-a", "kb-1").length, 2, "both rows still exist, one disabled")

  // Activating it would put two active answers on one normalized question →
  // refused, and the entry keeps its disabled status.
  assert.throws(
    () => service.activate("tenant-a", "kb-1", other.id),
    FaqConflictError,
    "two active answers for one normalized question are refused"
  )
  assert.equal(service.get("tenant-a", "kb-1", other.id)?.status, "disabled")

  // Once the other answer is disabled the activation succeeds — the rule is
  // about the ACTIVE set, not about history.
  service.disable("tenant-a", "kb-1", active.id)
  assert.equal(service.activate("tenant-a", "kb-1", other.id).status, "active")
})

test("Ticket 30: a disabled entry stays inspectable but is unavailable to retrieval", () => {
  const { service } = build()
  const keep = service.create("tenant-a", "kb-1", draft(), "admin")
  const retired = service.create(
    "tenant-a",
    "kb-1",
    { question: "支持哪些支付方式？", answer: "微信与银行卡。" },
    "admin"
  )
  service.disable("tenant-a", "kb-1", retired.id)

  const all = service.list("tenant-a", "kb-1")
  assert.equal(all.length, 2, "a disabled entry is still listed")
  assert.equal(all.find((item) => item.id === retired.id)?.status, "disabled")
  assert.equal(service.get("tenant-a", "kb-1", retired.id)?.status, "disabled", "and still readable")
  assert.equal(service.listVersions("tenant-a", "kb-1", retired.id).length, 1)
  assert.deepEqual(
    service.list("tenant-a", "kb-1", { status: "disabled" }).map((item) => item.id),
    [retired.id]
  )

  // Ticket 31 seam: retrieval only sees active entries of the given scope.
  const active = service.listActive("tenant-a", ["kb-1"])
  assert.deepEqual(active.map((row) => row.entryId), [keep.id])
  assert.deepEqual(service.listActive("tenant-a", []), [], "an empty scope matches nothing")
  assert.deepEqual(service.listActive("tenant-a", ["kb-2"]), [])
  assert.deepEqual(service.listActive("tenant-b", ["kb-1"]), [])
})

test("Ticket 30: an invalid entry is refused with every issue named", () => {
  const { service } = build()
  try {
    service.create("tenant-a", "kb-1", { question: "", answer: "", variants: "nope" }, "admin")
    assert.fail("expected a rejection")
  } catch (error) {
    assert.ok(error instanceof InvalidFaqCommandError)
    assert.deepEqual(error.issues, [
      "question is required",
      "answer is required",
      "variants must be an array of strings",
    ])
  }
  assert.deepEqual(service.list("tenant-a", "kb-1"), [], "nothing was written")
})

test("Ticket 30: a JSON import applies valid rows and reports the rest by row", () => {
  const { service } = build()
  const existing = service.create("tenant-a", "kb-1", draft(), "admin")
  const result = service.importEntries(
    "tenant-a",
    "kb-1",
    {
      format: "json",
      content: JSON.stringify([
        { question: "退款多久到账？", answer: "5 个工作日。" },
        { question: "可以开专票吗？", answer: "可以。", variants: ["专票"], source: { title: "财务手册", uri: "https://x.test/finance" } },
        { question: "可以开专票吗？  ", answer: "重复行" },
        { question: "缺少答案？" },
        "not an object",
      ]),
    },
    "admin"
  )
  assert.equal(result.versioned, 1, "an existing normalized question becomes a new version")
  assert.equal(result.imported, 1)
  assert.equal(result.skipped, 2)
  assert.match(result.issues.join("\n"), /row 3: duplicate question "可以开专票吗？"/)
  assert.match(result.issues.join("\n"), /row 4: answer is required/)
  // A row that is not an object never becomes a row: it is reported as an issue
  // and does not inflate the skip count.
  assert.match(result.issues.join("\n"), /row 5: each entry must be an object/)

  const versions = service.listVersions("tenant-a", "kb-1", existing.id)
  assert.equal(versions.length, 2)
  assert.equal(versions[1].answer, "5 个工作日。")
  assert.equal(versions[1].createdBy, "admin")

  const imported = service.list("tenant-a", "kb-1").find((item) => item.version.question === "可以开专票吗？")
  assert.deepEqual(imported?.version.variants, ["专票"])
  assert.deepEqual(imported?.version.source, { title: "财务手册", uri: "https://x.test/finance" })

  // Re-importing the same file changes the answer again (it differs from the
  // current version) but never inflates a version per row.
  const again = service.importEntries(
    "tenant-a",
    "kb-1",
    { format: "json", content: JSON.stringify([{ question: "退款多久到账？", answer: "5 个工作日。" }]) },
    "admin"
  )
  assert.equal(again.skipped, 1)
  assert.match(again.issues.join("\n"), /row 1: identical to the current version/)
})

test("Ticket 30: a CSV import handles quoting and reports structural problems", () => {
  const { service } = build()
  const csv = [
    "question,answer,variants,source_title,source_uri",
    '"退款多久到账？","3 个工作日,\n原路退回。",,"财务手册",',
    // A truly empty line and a line of empty fields are both "not a row", and
    // neither may shift the numbers below.
    "",
    ",,,,",
    "可以开专票吗？,可以。,专票|增值税发票,,",
    "只有问题？,,",
  ].join("\r\n")
  const result = service.importEntries("tenant-a", "kb-1", { format: "csv", content: csv }, "admin")
  assert.equal(result.imported, 2, "the blank lines are not rows and quoting is preserved")
  assert.equal(result.skipped, 1)
  assert.match(
    result.issues.join("\n"),
    /row 6: answer is required/,
    "the reported line number is the row's real position in the file"
  )

  const entries = service.list("tenant-a", "kb-1")
  const refund = entries.find((item) => item.version.normalizedQuestion === normalizeFaqQuestion("退款多久到账？"))
  assert.equal(refund?.version.answer, "3 个工作日,\n原路退回。", "a comma and a newline stay inside the field")
  const invoice = entries.find((item) => item.version.question === "可以开专票吗？")
  assert.deepEqual(invoice?.version.variants, ["专票", "增值税发票"])

  const missingColumns = service.importEntries(
    "tenant-a",
    "kb-1",
    { format: "csv", content: "question,variants\r\nx,y" },
    "admin"
  )
  assert.equal(missingColumns.imported, 0)
  assert.match(missingColumns.issues.join("\n"), /header must include "question" and "answer"/)
})

test("Ticket 30: an import cannot create two answers for one question", () => {
  const { service } = build()
  const active = service.create(
    "tenant-a",
    "kb-1",
    { question: "发票怎么开？", variants: ["开发票"], answer: "订单页申请。" },
    "admin"
  )
  const result = service.importEntries(
    "tenant-a",
    "kb-1",
    {
      format: "json",
      content: JSON.stringify([{ question: "开发票", answer: "另一份答案" }]),
    },
    "admin"
  )
  assert.equal(result.imported, 0)
  assert.equal(result.skipped, 1)
  assert.match(result.issues.join("\n"), new RegExp(`active entry ${active.id}`))
  assert.match(result.issues.join("\n"), /matched via variant/)
})
