/**
 * Ticket 34 (TOOL-01A) — the built-in read-only tools.
 *
 * Server identity and scope flow from the RUN environment into every search
 * (never from args); document lookups are tenant-, scope- and group-scoped
 * with "not found" for everything the caller may not see.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { openDb } from "../ingestion/tracking/db"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import { PageIndexRepository } from "../ingestion/tracking/page_index_repo"
import { ToolRegistry, ToolInvocationService } from "./invocation"
import { READ_ONLY_TOOL_ALLOWLIST } from "./complex_loop_adapter"
import { registerBuiltinTools } from "./knowledge_tools"
import type { Searcher } from "../retrieval/search/interface"
import type { AccessContext } from "../access/context"

const context: AccessContext = {
  tenantId: "tenant-a",
  subjectId: "alice",
  groups: ["support"],
  scopes: ["chat"],
}

function recordingSearcher() {
  const calls: Array<{ query: string; accessContext?: unknown; retrievalScope?: unknown; channels?: unknown }> = []
  const searcher: Searcher = {
    async search(query, options) {
      calls.push({
        query: query.text,
        accessContext: options?.accessContext,
        retrievalScope: options?.retrievalScope,
        channels: options?.channels,
      })
      return {
        status: "ok",
        results: [
          {
            chunk: {
              id: "chunk-1",
              documentId: "doc-1",
              content: "退款在 3 个工作日内到账。",
              childrenIds: [],
              metadata: { title: "退款政策" },
            },
            score: 1,
            source: "vector",
            wikilinks: [],
          },
        ],
        unavailableChannels: [],
      }
    },
  }
  return { searcher, calls }
}

function serviceWith(registry: ToolRegistry) {
  return new ToolInvocationService({ registry, allowedTools: READ_ONLY_TOOL_ALLOWLIST })
}

test("Ticket 34: knowledge_search binds server identity and scope from the environment", async () => {
  const { searcher, calls } = recordingSearcher()
  const registry = registerBuiltinTools(new ToolRegistry())
  const service = serviceWith(registry)

  const outcome = await service.invoke(
    "knowledge_search",
    { query: "退款多久到账？" },
    { accessContext: context, retrievalScope: { knowledgeBaseIds: ["kb-1"] }, searcher }
  )
  assert.equal(outcome.outcome, "ok")
  const result = outcome.result as { resultCount: number; results: unknown[] }
  assert.equal(result.resultCount, 1)
  assert.equal(outcome.trace.argsSummary.includes("query=\"退款多久到账？\""), true)

  // The search received the SERVER identity + scope — not anything from args.
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].accessContext, context)
  assert.deepEqual(calls[0].retrievalScope, { knowledgeBaseIds: ["kb-1"] })
  assert.deepEqual(calls[0].channels, ["vector", "bm25"])

  // Extra/unknown args (including identity) are rejected by the strict schema.
  const smuggled = await service.invoke(
    "knowledge_search",
    { query: "x", accessContext: { tenantId: "evil" } },
    { accessContext: context, searcher }
  )
  assert.equal(smuggled.outcome, "invalid_args")
})

test("Ticket 34: document_lookup enforces tenant, knowledge scope and group visibility", async () => {
  const db = openDb(":memory:")
  const documentRepo = new DocumentRepo(db)
  const pageIndexRepo = new PageIndexRepository(db)
  const insert = (docId: string, tenantId: string, kbId: string, groups: string[], content: string) =>
    documentRepo.insert({
      docId,
      sourceId: `src-${docId}`,
      contentHash: `hash-${docId}`,
      version: 1,
      title: `政策 ${docId}`,
      source: "test",
      content,
      tenantId,
      allowedGroups: groups,
      knowledgeBaseId: kbId,
    })
  insert("doc-mine", "tenant-a", "kb-1", [], "租户 A 的退款政策全文")
  insert("doc-group", "tenant-a", "kb-1", ["finance"], "财务专属内容")
  insert("doc-other-kb", "tenant-a", "kb-2", [], "另一个知识库的内容")
  insert("doc-foreign", "tenant-b", "kb-3", [], "其他租户的内容")

  const registry = registerBuiltinTools(new ToolRegistry(), { documentRepo, pageIndexRepo })
  const service = serviceWith(registry)
  const env = {
    accessContext: context,
    retrievalScope: { knowledgeBaseIds: ["kb-1"] },
  }

  const found = await service.invoke("document_lookup", { documentId: "doc-mine" }, env)
  assert.equal(found.outcome, "ok")
  const foundResult = found.result as { found: boolean; document?: { id: string; excerpt: string } }
  assert.equal(foundResult.found, true)
  assert.equal(foundResult.document?.id, "doc-mine")

  // Group-restricted, out-of-scope, and foreign-tenant documents are all the
  // same "not found" — the tool cannot probe them.
  for (const documentId of ["doc-group", "doc-other-kb", "doc-foreign", "doc-unknown"]) {
    const refused = await service.invoke("document_lookup", { documentId }, env)
    assert.equal(refused.outcome, "ok")
    assert.equal((refused.result as { found: boolean }).found, false, documentId)
  }

  // Group-restricted content IS visible to a caller holding the group.
  const finance: AccessContext = { ...context, groups: ["finance"] }
  const allowed = await service.invoke(
    "document_lookup",
    { documentId: "doc-group" },
    { ...env, accessContext: finance }
  )
  assert.equal((allowed.result as { found: boolean }).found, true)

  // Strict schema: no extra fields.
  const smuggled = await service.invoke(
    "document_lookup",
    { documentId: "doc-mine", tenantId: "tenant-b" },
    env
  )
  assert.equal(smuggled.outcome, "invalid_args")
})
