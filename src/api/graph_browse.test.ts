/**
 * Ticket 37 (GRAPH-01) — the knowledge-scoped graph browse HTTP contract.
 *
 * Acceptance criteria exercised here:
 *   1. Knowledge scope + server-side node limits (tenant from AccessContext;
 *      unknown/cross-tenant base is the same 404; page windows bounded).
 *   2. Shared same-name entities cannot reveal another knowledge base's
 *      relations — a relation exists for a caller only when its provenance
 *      authorizes THIS knowledge base (the retrieval channel's own filters).
 *   3. Every relation's provenance either resolves to an authorized chunk
 *      (title + version returned) or reports `{ available: false }`.
 *   4. Large neighborhoods truncate instead of freezing the interface.
 */

import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
import { openDb } from "../ingestion/tracking/db"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { KnowledgeBaseServiceImpl } from "../knowledge/knowledge_base_service"
import { createGraphBrowseRouter } from "./graph_browse"

const EMBEDDING_PROFILE = "text-embedding-3-small:1536"

function contextFor(tenantId: string): AccessContext {
  return { ...singleTenantAccessContext(), tenantId, scopes: ["chat"], groups: [] }
}

/** 6-element provenance record, exactly what Neo4jStore.storeWikilinks writes. */
function provenance(
  documentId: string,
  chunkId: string,
  tenantId: string,
  allowedGroups: string[],
  knowledgeBaseId: string
): string {
  return JSON.stringify([documentId, chunkId, tenantId, allowedGroups, 0.9, knowledgeBaseId])
}

interface Neo4jStubCall {
  cypher: string
  params: Record<string, unknown>
}

interface Neo4jRoute {
  match: string
  records: Array<Record<string, unknown>>
}

/**
 * A minimal driver stub: maps a Cypher fragment to canned records (wrapped in
 * the `record.get(key)` shape) and records every call so tests can assert the
 * server-side bounds.
 */
function neo4jStub(routes: Neo4jRoute[]): { driver: unknown; calls: Neo4jStubCall[] } {
  const calls: Neo4jStubCall[] = []
  return {
    calls,
    driver: {
      session: () => ({
        run: async (cypher: string, params: Record<string, unknown>) => {
          calls.push({ cypher, params })
          const route = routes.find((candidate) => cypher.includes(candidate.match))
          return {
            records: (route ? route.records : []).map((record) => ({
              get: (key: string) => record[key],
            })),
          }
        },
        close: async () => {},
      }),
    },
  }
}

/** ES stub: resolves exactly the (documentId, chunkId) pairs listed. */
function esStub(resolvable: Array<{ documentId: string; chunkId: string; title: string; documentVersion?: number }>): {
  client: unknown
  searches: Array<Record<string, unknown>>
} {
  const searches: Array<Record<string, unknown>> = []
  return {
    searches,
    client: {
      search: async (params: Record<string, unknown>) => {
        searches.push(params)
        assert.equal(params.index, "selected-v2", "provenance hydration must use selected physical index")
        const query = (params.query as {
          bool: { should: Array<{ bool: { must: Array<{ term: Record<string, string> }> } }> }
        })
        const hits = query.bool.should
          .map((clause) => Object.assign({}, ...clause.bool.must.map((term) => term.term)))
          .filter((terms) =>
            resolvable.some(
              (pair) => pair.documentId === terms.documentId && pair.chunkId === terms.id
            )
          )
          .map((terms) => {
            const pair = resolvable.find(
              (candidate) =>
                candidate.documentId === terms.documentId && candidate.chunkId === terms.id
            )!
            return {
              _source: {
                documentId: pair.documentId,
                id: pair.chunkId,
                kind: "child",
                metadata: {
                  title: pair.title,
                  ...(pair.documentVersion !== undefined ? { documentVersion: pair.documentVersion } : {}),
                },
              },
            }
          })
        return { hits: { hits } }
      },
    },
  }
}

interface Setup {
  port: number
  kbA: { id: string }
  kbB: { id: string }
  driverCalls: Neo4jStubCall[]
  close: () => void
}

async function buildApp(setupOptions: {
  /**
   * Driver routes built AFTER the knowledge bases exist, so canned records
   * can carry the REAL knowledge-base ids in their provenance.
   */
  driverRoutes?: (kbAId: string, kbBId: string) => Neo4jRoute[]
  es?: unknown
  tenantId?: string
}): Promise<Setup> {
  const db = openDb(":memory:")
  const service = new KnowledgeBaseServiceImpl(new SqliteKnowledgeBaseRepo(db), EMBEDDING_PROFILE)
  const kbA = service.create("demo", "KB-A")
  const kbB = service.create("demo", "KB-B")
  const stub = setupOptions.driverRoutes
    ? neo4jStub(setupOptions.driverRoutes(kbA.id, kbB.id))
    : { driver: undefined as unknown, calls: [] as Neo4jStubCall[] }
  const app = express()
  app.use(express.json())
  app.use((_req, res, next) => {
    res.locals.accessContext = contextFor(setupOptions.tenantId ?? "demo")
    next()
  })
  app.use(
    "/api",
    createGraphBrowseRouter({
      knowledgeBaseService: service,
      indexName: "selected-v2",
      ...(stub.driver ? { neo4jDriver: stub.driver as never } : {}),
      ...(setupOptions.es ? { es: setupOptions.es as never } : {}),
    })
  )
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[graph-browse-test]", err)
    res.status(500).json({ error: "internal error" })
  })
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const port = (server.address() as AddressInfo).port
  return { port, kbA, kbB, driverCalls: stub.calls, close: () => server.close() }
}

async function request(
  port: number,
  path: string
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`)
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null }
}

test("an unknown or cross-tenant knowledge base is the same 404; an unwired deployment is 503", async () => {
  const noDriver = await buildApp({})
  try {
    const missing = await request(noDriver.port, `/knowledge-bases/${noDriver.kbA.id}/graph/entities`)
    assert.equal(missing.status, 503, "no Neo4j wired → 503 before anything else")
  } finally {
    noDriver.close()
  }

  const wired = await buildApp({ driverRoutes: () => [] })
  try {
    const unknown = await request(wired.port, "/knowledge-bases/nope/graph/entities")
    assert.equal(unknown.status, 404)
    const crossTenant = await buildApp({ driverRoutes: () => [], tenantId: "other" })
    try {
      const other = await request(crossTenant.port, `/knowledge-bases/${wired.kbA.id}/graph/entities`)
      assert.equal(other.status, 404, "another tenant's base is the same 404")
    } finally {
      crossTenant.close()
    }
  } finally {
    wired.close()
  }
})

test("a shared same-name entity shows only the relations of the browsed knowledge base", async () => {
  const setup = await buildApp({
    driverRoutes: (kbAId, kbBId) => [
      {
        match: "MATCH (e:Entity)",
        records: [
          {
            name: "报销系统",
            type: "系统",
            aliases: ["Reimburse"],
            relations: [
              // In-scope: KB-A provenance.
              {
                related: "财务平台",
                fact: "ent-a->ent-b:对接",
                weight: 0.9,
                provenance: [provenance("doc-a", "chunk-a1", "demo", [], kbAId)],
              },
              // Out-of-scope: KB-B provenance must not surface.
              {
                related: "外部系统",
                fact: "ent-a->ent-c:同步",
                weight: 0.8,
                provenance: [provenance("doc-b", "chunk-b1", "demo", [], kbBId)],
              },
            ],
          },
        ],
      },
    ],
  })
  try {
    const res = await request(setup.port, `/knowledge-bases/${setup.kbA.id}/graph/entities`)
    assert.equal(res.status, 200)
    const entities = res.json?.entities as Array<{ name: string; relationCount: number }>
    assert.equal(entities.length, 1)
    assert.equal(entities[0].relationCount, 1, "only the in-scope relation counts")
    // The entity page is bounded server-side (SKIP/LIMIT driver integers).
    const page = setup.driverCalls[0].params as { pageLimit: { toString(): string } }
    assert.ok(page.pageLimit, "the entity query carries a server-side page limit")
  } finally {
    setup.close()
  }
})

test("relation provenance resolves to authorized chunks or reports available: false", async () => {
  const es = esStub([{ documentId: "doc-a", chunkId: "chunk-a1", title: "报销制度 v3", documentVersion: 3 }])
  const setup = await buildApp({
    es: es.client,
    driverRoutes: (kbAId) => [
      {
        match: "WHERE toLower(e.name) = toLower($entity)",
        records: [
          {
            entityId: "ent-a",
            name: "报销系统",
            type: "系统",
            aliases: [],
            relatedId: "ent-b",
            relatedName: "财务平台",
            fact: "ent-a->ent-b:对接",
            weight: 0.9,
            provenance: [
              provenance("doc-a", "chunk-a1", "demo", [], kbAId),
              provenance("doc-missing", "chunk-x", "demo", [], kbAId),
            ],
          },
        ],
      },
    ],
  })
  try {
    const res = await request(
      setup.port,
      `/knowledge-bases/${setup.kbA.id}/graph/relations?entity=${encodeURIComponent("报销系统")}`
    )
    assert.equal(res.status, 200)
    const body = res.json as {
      entity: { name: string }
      relations: Array<{
        sourceName: string
        targetName: string
        relation: string
        provenance: Array<{ documentId: string; available: boolean; title?: string; documentVersion?: number }>
      }>
    }
    assert.equal(body.entity.name, "报销系统")
    assert.equal(body.relations.length, 1)
    const relation = body.relations[0]
    assert.equal(relation.sourceName, "报销系统")
    assert.equal(relation.targetName, "财务平台")
    assert.equal(relation.relation, "对接")
    assert.equal(relation.provenance.length, 2)
    assert.equal(relation.provenance[0].available, true)
    assert.equal(relation.provenance[0].title, "报销制度 v3")
    assert.equal(relation.provenance[0].documentVersion, 3)
    assert.equal(relation.provenance[1].available, false, "unresolvable provenance reports unavailable")
  } finally {
    setup.close()
  }
})

test("cross-tenant provenance is filtered before hydration and cannot leak", async () => {
  const es = esStub([{ documentId: "doc-foreign", chunkId: "chunk-foreign", title: "不该看到" }])
  const setup = await buildApp({
    es: es.client,
    driverRoutes: (kbAId) => [
      {
        match: "WHERE toLower(e.name) = toLower($entity)",
        records: [
          {
            entityId: "ent-a",
            name: "共享实体",
            type: "系统",
            aliases: [],
            relatedId: "ent-b",
            relatedName: "别的库的伙伴",
            fact: "ent-a->ent-b:秘密关系",
            weight: 0.9,
            // All provenance belongs to another tenant → nothing in scope.
            provenance: [provenance("doc-foreign", "chunk-foreign", "other-tenant", [], kbAId)],
          },
        ],
      },
    ],
  })
  try {
    const res = await request(
      setup.port,
      `/knowledge-bases/${setup.kbA.id}/graph/relations?entity=${encodeURIComponent("共享实体")}`
    )
    assert.equal(res.status, 200)
    const body = res.json as { relations: unknown[]; page: { outOfScopeRows: number } }
    assert.deepEqual(body.relations, [], "another tenant's relation never surfaces")
    assert.equal(body.page.outOfScopeRows, 1, "the filtered row is reported honestly")
    assert.equal(es.searches.length, 0, "nothing unauthorized ever reaches the chunk index")
  } finally {
    setup.close()
  }
})

test("large neighborhoods truncate through the server-side page window", async () => {
  const setup = await buildApp({
    driverRoutes: (kbAId) => [
      {
        match: "WHERE toLower(e.name) = toLower($entity)",
        records: Array.from({ length: 21 }, (_, i) => ({
          entityId: "ent-a",
          name: "中心实体",
          type: "系统",
          aliases: [],
          relatedId: `ent-${i}`,
          relatedName: `邻居${i}`,
          fact: `ent-a->ent-${i}:关联${i}`,
          weight: 0.5,
          provenance: [provenance("doc-a", `chunk-${i}`, "demo", [], kbAId)],
        })),
      },
    ],
  })
  try {
    const res = await request(
      setup.port,
      `/knowledge-bases/${setup.kbA.id}/graph/relations?entity=${encodeURIComponent("中心实体")}&limit=5`
    )
    assert.equal(res.status, 200)
    const body = res.json as { relations: unknown[]; page: { truncated: boolean } }
    assert.equal(body.relations.length, 5)
    assert.equal(body.page.truncated, true, "more rows existed than the page window")
    // The Neo4j query itself was bounded: pageRows = limit + 1.
    const params = setup.driverCalls[0].params as { pageRows: { toNumber(): number } }
    assert.equal(typeof params.pageRows.toNumber(), "number")
  } finally {
    setup.close()
  }
})
