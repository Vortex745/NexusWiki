/**
 * Ticket 05 (KB-03A) — the server-computed RetrievalScope.
 *
 * Acceptance criteria exercised here:
 *   2. Missing scope selects the authorized default, explicit empty scope means
 *      no knowledge context, and invalid scope fails explicitly.
 *   3. The client cannot expand scope with raw storage filters or unauthorized
 *      identifiers.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { singleTenantAccessContext, type AccessContext } from "../access/context"
import { openDb } from "../ingestion/tracking/db"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import {
  InvalidKnowledgeBaseScopeError,
  KnowledgeBaseNotFoundError,
  KnowledgeBaseServiceImpl,
} from "../knowledge/knowledge_base_service"
import { defaultKnowledgeBaseId } from "../types/knowledge_base"
import { createRetrievalScopeResolver, type RetrievalScopeResolver } from "./scope"

const EMBEDDING_PROFILE = "text-embedding-3-small:1536"

function setup(): { resolve: RetrievalScopeResolver; service: KnowledgeBaseServiceImpl } {
  const db = openDb(":memory:")
  const service = new KnowledgeBaseServiceImpl(
    new SqliteKnowledgeBaseRepo(db),
    EMBEDDING_PROFILE
  )
  return { resolve: createRetrievalScopeResolver(service), service }
}

function contextFor(tenantId: string): AccessContext {
  return { ...singleTenantAccessContext(), tenantId }
}

test("a request without a knowledge selection resolves to the caller's default", () => {
  const { resolve } = setup()
  const accessContext = contextFor("demo")

  const scope = resolve(accessContext, undefined)

  assert.deepEqual(scope, { knowledgeBaseIds: [defaultKnowledgeBaseId("demo")] })
  // "Missing" is never "all knowledge bases": the scope names exactly one id.
  assert.equal(scope.knowledgeBaseIds.length, 1)
})

test("an explicit empty selection is no knowledge context, not every knowledge base", () => {
  const { resolve } = setup()

  const scope = resolve(contextFor("demo"), [])

  assert.deepEqual(scope, { knowledgeBaseIds: [] })
})

test("a selection is scoped to the caller's tenant and de-duplicated in order", () => {
  const db = openDb(":memory:")
  const service = new KnowledgeBaseServiceImpl(
    new SqliteKnowledgeBaseRepo(db),
    EMBEDDING_PROFILE
  )
  const resolve = createRetrievalScopeResolver(service)
  const accessContext = contextFor("demo")
  const first = service.ensureDefault("demo")
  const second = { ...first, id: "kb-policies", name: "Policies" }
  new SqliteKnowledgeBaseRepo(db).insertIfAbsent(second)

  const scope = resolve(accessContext, [second.id, first.id, second.id])

  assert.deepEqual(scope.knowledgeBaseIds, [second.id, first.id])
})

test("another tenant's knowledge base is not selectable — the id is not even confirmed", () => {
  const { resolve, service } = setup()
  const foreign = service.ensureDefault("other")

  assert.throws(
    () => resolve(contextFor("demo"), [foreign.id]),
    (error: unknown) => error instanceof KnowledgeBaseNotFoundError
  )
})

test("an unknown knowledge base fails explicitly rather than widening the scope", () => {
  const { resolve } = setup()

  assert.throws(
    () => resolve(contextFor("demo"), ["kb-does-not-exist"]),
    (error: unknown) => error instanceof KnowledgeBaseNotFoundError
  )
})

test("a malformed selection fails explicitly — a bare string is not iterated", () => {
  const { resolve } = setup()
  const accessContext = contextFor("demo")

  for (const malformed of ["kb-default-demo", 7, { knowledgeBaseIds: [] }, null]) {
    assert.throws(
      () => resolve(accessContext, malformed),
      (error: unknown) => error instanceof InvalidKnowledgeBaseScopeError,
      `expected ${JSON.stringify(malformed)} to be rejected`
    )
  }
})

test("a blank or non-string element fails explicitly", () => {
  const { resolve } = setup()
  const accessContext = contextFor("demo")
  const existing = resolve(accessContext, undefined).knowledgeBaseIds[0]

  assert.throws(
    () => resolve(accessContext, [existing, "   "]),
    (error: unknown) => error instanceof InvalidKnowledgeBaseScopeError
  )
  assert.throws(
    () => resolve(accessContext, [existing, 42 as unknown as string]),
    (error: unknown) => error instanceof InvalidKnowledgeBaseScopeError
  )
})
