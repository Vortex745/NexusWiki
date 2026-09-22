/**
 * Ticket 08 (KB-04) — knowledge-base workspace commands and queries.
 *
 * Acceptance criteria exercised here:
 *   1. Commands (create, rename, archive, restore) and queries use validated
 *      public contracts and enforce tenant ownership.
 *   2. Archived knowledge bases stop joining NEW retrieval while remaining
 *      inspectable (list still returns them; the service refuses to select
 *      them into a retrieval scope).
 */
import assert from "node:assert/strict"
import test from "node:test"
import { openDb, type DB } from "../ingestion/tracking/db"
import { defaultKnowledgeBaseId } from "../types/knowledge_base"
import { SqliteKnowledgeBaseRepo } from "./knowledge_base_repo"
import {
  InvalidKnowledgeBaseCommandError,
  KnowledgeBaseArchivedError,
  KnowledgeBaseServiceImpl,
} from "./knowledge_base_service"

const EMBEDDING_PROFILE = "text-embedding-3-small:1536"

function setup(): { db: DB; service: KnowledgeBaseServiceImpl } {
  const db = openDb(":memory:")
  const service = new KnowledgeBaseServiceImpl(
    new SqliteKnowledgeBaseRepo(db),
    EMBEDDING_PROFILE
  )
  return { db, service }
}

test("create adds an active knowledge base with a generated unique id per tenant", () => {
  const { service } = setup()
  service.ensureDefault("demo")

  const first = service.create("demo", "Policies", "HR policies")
  const second = service.create("demo", "Handbooks")

  assert.notEqual(first.id, second.id)
  assert.ok(
    !first.id.startsWith("kb-default-"),
    "a created base is never the deterministic default"
  )
  assert.equal(first.tenantId, "demo")
  assert.equal(first.name, "Policies")
  assert.equal(first.description, "HR policies")
  assert.equal(first.status, "active")
  assert.equal(first.embeddingProfile, EMBEDDING_PROFILE)
  assert.equal(second.description, "")
  const listed = service.list("demo").map(({ id }) => id)
  assert.ok(listed.includes(first.id) && listed.includes(second.id))
})

test("create validates the public contract — blank or oversized names are rejected", () => {
  const { service } = setup()

  for (const bad of ["   ", "", "x".repeat(201)]) {
    assert.throws(
      () => service.create("demo", bad),
      (error: unknown) => error instanceof InvalidKnowledgeBaseCommandError,
      `expected ${JSON.stringify(bad.slice(0, 12) + "…")} to be rejected`
    )
  }
  // An oversized description is rejected too.
  assert.throws(
    () => service.create("demo", "Policies", "d".repeat(2001)),
    (error: unknown) => error instanceof InvalidKnowledgeBaseCommandError
  )
})

test("rename updates the name and nothing else; unknown or cross-tenant is null", () => {
  const { service } = setup()
  const created = service.create("demo", "Policies")

  const renamed = service.rename(created.id, "demo", "Policies v2")
  assert.ok(renamed)
  assert.equal(renamed.name, "Policies v2")
  assert.equal(renamed.description, created.description)
  assert.equal(renamed.status, created.status)
  assert.ok(renamed.updatedAt >= created.updatedAt)

  assert.equal(service.rename(created.id, "other", "Nope"), null, "cross-tenant rename is null")
  assert.equal(service.rename("kb-missing", "demo", "Nope"), null, "unknown rename is null")

  assert.throws(
    () => service.rename(created.id, "demo", "   "),
    (error: unknown) => error instanceof InvalidKnowledgeBaseCommandError
  )
})

test("an archived knowledge base stops joining new retrieval — selection fails explicitly", () => {
  const { service } = setup()
  const created = service.create("demo", "Policies")
  service.archive(created.id, "demo")

  assert.throws(
    () => service.resolveScope("demo", [created.id]),
    (error: unknown) =>
      error instanceof KnowledgeBaseArchivedError &&
      error.knowledgeBaseId === created.id,
    "an archived base must be refused by the scope resolver, not silently skipped"
  )

  // Restoring makes it selectable again.
  service.activate(created.id, "demo")
  const scope = service.resolveScope("demo", [created.id])
  assert.deepEqual(scope.knowledgeBaseIds, [created.id])
})

test("the default knowledge base cannot be archived — omitted selections must keep working", () => {
  const { service } = setup()
  const defaultId = defaultKnowledgeBaseId("demo")
  service.ensureDefault("demo")

  assert.throws(
    () => service.archive(defaultId, "demo"),
    (error: unknown) => error instanceof InvalidKnowledgeBaseCommandError
  )
  assert.equal(service.getById(defaultId, "demo")?.status, "active")
  // And the legacy omitted-selection path still resolves.
  assert.deepEqual(service.resolveScope("demo").knowledgeBaseIds, [defaultId])
})

test("a legacy archived default is repaired on the next default resolution", () => {
  const { db, service } = setup()
  const defaultId = defaultKnowledgeBaseId("demo")
  service.ensureDefault("demo")
  // Force the state a normal archive can no longer produce (pre-KB-04 data).
  new SqliteKnowledgeBaseRepo(db).setStatus(defaultId, "demo", "archived", new Date().toISOString())

  // The default backs every omitted selection — it is repaired, never a 409.
  const scope = service.resolveScope("demo")
  assert.deepEqual(scope.knowledgeBaseIds, [defaultId])
  assert.equal(service.getById(defaultId, "demo")?.status, "active")
})

test("list keeps archived bases inspectable — queries never hide them from the caller", () => {
  const { service } = setup()
  service.ensureDefault("demo")
  const created = service.create("demo", "Policies")
  service.archive(created.id, "demo")

  const statuses = new Map(service.list("demo").map(({ id, status }) => [id, status]))
  assert.equal(statuses.get(created.id), "archived", "the row is still inspectable")
  assert.equal(statuses.get(defaultKnowledgeBaseId("demo")), "active")
})
