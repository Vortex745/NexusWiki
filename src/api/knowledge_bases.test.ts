import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
import { openDb, type DB } from "../ingestion/tracking/db"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { KnowledgeBaseServiceImpl } from "../knowledge/knowledge_base_service"
import type { KnowledgeBase } from "../types/knowledge_base"
import { defaultKnowledgeBaseId } from "../types/knowledge_base"
import { createKnowledgeBaseRouter } from "./knowledge_bases"

/**
 * Ticket 08 (KB-04) — the knowledge-base workspace HTTP contract.
 *
 * Acceptance criteria exercised here:
 *   1. Commands and queries use validated public contracts and enforce
 *      tenant ownership: every route resolves its tenant from the
 *      server-computed AccessContext, a reader can browse ACTIVE bases only,
 *      and admin commands answer 403 without a side effect.
 *   2. Archived bases stay inspectable (list still returns them for admins)
 *      and the command errors map to explicit statuses (400/404/409).
 */

const EMBEDDING_PROFILE = "text-embedding-3-small:1536"

function contextFor(tenantId: string, scopes: AccessContext["scopes"] = ["chat"]): AccessContext {
  return { ...singleTenantAccessContext(), tenantId, scopes }
}

function buildApp(options: {
  tenantId?: string
  scopes?: AccessContext["scopes"]
} = {}): { app: express.Express; db: DB; service: KnowledgeBaseServiceImpl } {
  const db = openDb(":memory:")
  const service = new KnowledgeBaseServiceImpl(
    new SqliteKnowledgeBaseRepo(db),
    EMBEDDING_PROFILE
  )
  const app = express()
  app.use(express.json())
  app.use((_req, res, next) => {
    res.locals.accessContext = contextFor(options.tenantId ?? "demo", options.scopes)
    next()
  })
  app.use("/api", createKnowledgeBaseRouter({ service }))
  return { app, db, service }
}

async function listen(app: express.Express) {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

type Json = Record<string, unknown>

async function request(
  port: number,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown
): Promise<{ status: number; json: Json | null }> {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as Json | null }
}

test("Ticket 08: a reader browses only ACTIVE knowledge bases of its own tenant", async () => {
  const { app, db, service } = buildApp({ scopes: ["chat"] })
  try {
    service.ensureDefault("demo")
    const archived = service.create("demo", "Policies")
    service.archive(archived.id, "demo")
    const foreign = service.create("other", "Foreign")

    const { server, port } = await listen(app)
    try {
      const { status, json } = await request(port, "GET", "/knowledge-bases")

      assert.equal(status, 200)
      const bases = (json?.knowledgeBases ?? []) as Array<Record<string, unknown>>
      const ids = bases.map((base) => base.id)
      assert.ok(ids.includes(defaultKnowledgeBaseId("demo")), "the active default is listed")
      assert.ok(!ids.includes(archived.id), "an archived base is not listed for a reader")
      assert.ok(!ids.includes(foreign.id), "another tenant's base is never listed")
      for (const base of bases) {
        assert.equal(base.status, "active")
      }
    } finally {
      server.close()
    }
  } finally {
    db.close()
  }
})

test("Ticket 08: an admin sees archived bases too (inspectable, never hidden)", async () => {
  const { app, db, service } = buildApp({ scopes: ["chat", "admin"] })
  try {
    service.ensureDefault("demo")
    const archived = service.create("demo", "Policies")
    service.archive(archived.id, "demo")

    const { server, port } = await listen(app)
    try {
      const { status, json } = await request(port, "GET", "/knowledge-bases")

      assert.equal(status, 200)
      const statuses = new Map(
        ((json?.knowledgeBases ?? []) as KnowledgeBase[]).map(({ id, status }) => [id, status])
      )
      assert.equal(statuses.get(archived.id), "archived")
      assert.equal(statuses.get(defaultKnowledgeBaseId("demo")), "active")
    } finally {
      server.close()
    }
  } finally {
    db.close()
  }
})

test("Ticket 08: a reader cannot create, rename, archive or restore — 403 with no side effect", async () => {
  const { app, db, service } = buildApp({ scopes: ["chat"] })
  try {
    service.ensureDefault("demo")
    const created = service.create("demo", "Policies")

    const { server, port } = await listen(app)
    try {
      const create = await request(port, "POST", "/knowledge-bases", { name: "Nope" })
      assert.equal(create.status, 403)
      const rename = await request(port, "PATCH", `/knowledge-bases/${created.id}`, { name: "Nope" })
      assert.equal(rename.status, 403)
      const archive = await request(port, "POST", `/knowledge-bases/${created.id}/archive`)
      assert.equal(archive.status, 403)
      const restore = await request(port, "POST", `/knowledge-bases/${created.id}/restore`)
      assert.equal(restore.status, 403)

      assert.equal(service.list("demo").length, 2, "no side effect on any rejection")
      assert.equal(service.getById(created.id, "demo")?.name, "Policies")
    } finally {
      server.close()
    }
  } finally {
    db.close()
  }
})

test("Ticket 08: an admin creates a knowledge base through the validated contract", async () => {
  const { app, db, service } = buildApp({ scopes: ["chat", "admin"] })
  try {
    service.ensureDefault("demo")

    const { server, port } = await listen(app)
    try {
      const bad = await request(port, "POST", "/knowledge-bases", { name: "   " })
      assert.equal(bad.status, 400, "a blank name violates the contract")

      const ok = await request(port, "POST", "/knowledge-bases", {
        name: "  Policies  ",
        description: "HR rules",
      })
      assert.equal(ok.status, 201)
      const base = ok.json?.knowledgeBase as Record<string, unknown>
      assert.equal(base.name, "Policies", "the name is trimmed")
      assert.equal(base.tenantId, "demo")
      assert.equal(base.status, "active")
      assert.equal(base.embeddingProfile, EMBEDDING_PROFILE)
      assert.ok(service.getById(String(base.id), "demo"), "the row exists")
    } finally {
      server.close()
    }
  } finally {
    db.close()
  }
})

test("Ticket 08: an admin renames, archives and restores through the routes", async () => {
  const { app, db, service } = buildApp({ scopes: ["chat", "admin"] })
  try {
    service.ensureDefault("demo")
    const created = service.create("demo", "Policies")

    const { server, port } = await listen(app)
    try {
      const renamed = await request(port, "PATCH", `/knowledge-bases/${created.id}`, { name: "Policies v2" })
      assert.equal(renamed.status, 200)
      assert.equal((renamed.json?.knowledgeBase as Record<string, unknown>).name, "Policies v2")

      const archived = await request(port, "POST", `/knowledge-bases/${created.id}/archive`)
      assert.equal(archived.status, 200)
      assert.equal((archived.json?.knowledgeBase as Record<string, unknown>).status, "archived")

      // The archived base is now refused by the chat selection contract (409).
      const reselect = await request(port, "POST", "/knowledge-bases", { name: "Probe" })
      assert.equal(reselect.status, 201)

      const restored = await request(port, "POST", `/knowledge-bases/${created.id}/restore`)
      assert.equal(restored.status, 200)
      assert.equal((restored.json?.knowledgeBase as Record<string, unknown>).status, "active")

      const unknown = await request(port, "PATCH", "/knowledge-bases/kb-missing", { name: "Nope" })
      assert.equal(unknown.status, 404, "an unknown id is a 404, never a widening")
    } finally {
      server.close()
    }
  } finally {
    db.close()
  }
})

test("Ticket 08: archiving the default knowledge base fails with 400", async () => {
  const { app, db, service } = buildApp({ scopes: ["chat", "admin"] })
  try {
    service.ensureDefault("demo")

    const { server, port } = await listen(app)
    try {
      const res = await request(port, "POST", `/knowledge-bases/${defaultKnowledgeBaseId("demo")}/archive`)
      assert.equal(res.status, 400)
      assert.equal(
        service.getById(defaultKnowledgeBaseId("demo"), "demo")?.status,
        "active",
        "the default stays active"
      )
    } finally {
      server.close()
    }
  } finally {
    db.close()
  }
})
