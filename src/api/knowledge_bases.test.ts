import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
import { openDb, type DB } from "../ingestion/tracking/db"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import { KnowledgeBaseServiceImpl } from "../knowledge/knowledge_base_service"
import { RetirementServiceImpl } from "../knowledge/retirement"
import { SqliteSourceLifecycleStore } from "../knowledge/source_lifecycle_store"
import { TaskRepo } from "../ingestion/tracking/task_repo"
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
} = {}): {
  app: express.Express
  db: DB
  service: KnowledgeBaseServiceImpl
  retirement: RetirementServiceImpl
} {
  const db = openDb(":memory:")
  const service = new KnowledgeBaseServiceImpl(
    new SqliteKnowledgeBaseRepo(db),
    EMBEDDING_PROFILE
  )
  const retirement = new RetirementServiceImpl(
    db,
    new SqliteSourceLifecycleStore(db),
    new TaskRepo(db)
  )
  const app = express()
  app.use(express.json())
  app.use((_req, res, next) => {
    res.locals.accessContext = contextFor(options.tenantId ?? "demo", options.scopes)
    next()
  })
  app.use("/api", createKnowledgeBaseRouter({ service, retirement }))
  return { app, db, service, retirement }
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

// ---------------------------------------------------------------------------
// POST /knowledge-bases/:id/retire-contents — the knowledge-base-wide wipe.
// ---------------------------------------------------------------------------

/** Seed one source (with its documents) into an existing knowledge base. */
function seedSource(db: DB, args: {
  sourceId: string
  knowledgeBaseId: string
  tenantId: string
  docIds: string[]
}): void {
  const at = "2026-09-27T00:00:00.000Z"
  db.prepare(
    `INSERT INTO sources (source_id, source_key, source_kind, source_uri, namespace,
       created_at, updated_at, tenant_id, lifecycle_state, knowledge_base_id)
     VALUES (?, ?, 'file', ?, 'local', ?, ?, ?, 'active', ?)`
  ).run(
    args.sourceId, `key-${args.sourceId}`, `file:///tmp/${args.sourceId}.txt`,
    at, at, args.tenantId, args.knowledgeBaseId
  )
  args.docIds.forEach((docId, index) => {
    db.prepare(
      `INSERT INTO documents (doc_id, source_id, content_hash, version, activation_order,
         title, source, content, status, created_at, updated_at, tenant_id, knowledge_base_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`
    ).run(
      docId, args.sourceId, `hash-${docId}`, index + 1, index + 1, `Doc ${docId}`,
      `file:///tmp/${args.sourceId}.txt`, `content-${docId}`, at, at, args.tenantId,
      args.knowledgeBaseId
    )
  })
}

/** Read a source's lifecycle state straight from SQLite. */
function lifecycleState(db: DB, sourceId: string): string | undefined {
  return (
    db.prepare(`SELECT lifecycle_state FROM sources WHERE source_id = ?`).get(sourceId) as
      | { lifecycle_state: string }
      | undefined
  )?.lifecycle_state
}

test("a content wipe is admin-only, reason-mandatory and 404s on an unknown base", async () => {
  const { app, db, service } = buildApp({ scopes: ["chat"] })
  try {
    const base = service.create("demo", "Policies")
    seedSource(db, { sourceId: "src-1", knowledgeBaseId: base.id, tenantId: "demo", docIds: ["doc-1"] })

    const { server, port } = await listen(app)
    try {
      assert.equal((await request(port, "POST", `/knowledge-bases/${base.id}/retire-contents`, { reason: "x" })).status, 403)
      assert.equal(lifecycleState(db, "src-1"), "active", "a rejected call has no side effect")
    } finally {
      server.close()
    }

    const admin = buildApp({ scopes: ["chat", "admin"] })
    try {
      const adminBase = admin.service.create("demo", "Policies")
      seedSource(admin.db, { sourceId: "src-1", knowledgeBaseId: adminBase.id, tenantId: "demo", docIds: ["doc-1"] })
      const { server, port } = await listen(admin.app)
      try {
        assert.equal((await request(port, "POST", `/knowledge-bases/${adminBase.id}/retire-contents`, {})).status, 400)
        assert.equal((await request(port, "POST", `/knowledge-bases/${adminBase.id}/retire-contents`, { reason: "" })).status, 400)
        assert.equal((await request(port, "POST", "/knowledge-bases/kb-missing/retire-contents", { reason: "清理" })).status, 404)
        assert.equal(lifecycleState(admin.db, "src-1"), "active",
          "a rejected payload wiped nothing")
      } finally {
        server.close()
      }
    } finally {
      admin.db.close()
    }
  } finally {
    db.close()
  }
})

test("an admin wipes every source of a base, and the wipe is idempotent", async () => {
  const { app, db, service } = buildApp({ scopes: ["chat", "admin"] })
  try {
    const base = service.create("demo", "Policies")
    seedSource(db, { sourceId: "src-1", knowledgeBaseId: base.id, tenantId: "demo", docIds: ["doc-1a", "doc-1b"] })
    seedSource(db, { sourceId: "src-2", knowledgeBaseId: base.id, tenantId: "demo", docIds: ["doc-2a"] })
    // A second base that must survive the wipe untouched.
    const other = service.create("demo", "Keep me")
    seedSource(db, { sourceId: "src-3", knowledgeBaseId: other.id, tenantId: "demo", docIds: ["doc-3a"] })

    const { server, port } = await listen(app)
    try {
      const first = await request(port, "POST", `/knowledge-bases/${base.id}/retire-contents`, {
        reason: "重新导入前的清空",
      })
      assert.equal(first.status, 200)
      assert.deepEqual(first.json, {
        knowledgeBaseId: base.id,
        sources: 2,
        retired: 2,
        alreadyRetired: 0,
        // 3 documents x the 4 cleanup ops.
        cleanupTasksQueued: 12,
      })

      const second = await request(port, "POST", `/knowledge-bases/${base.id}/retire-contents`, {
        reason: "再点一次",
      })
      assert.equal(second.json?.retired, 0)
      assert.equal(second.json?.alreadyRetired, 2)
      assert.equal(second.json?.cleanupTasksQueued, 0, "a re-wipe queues nothing a second time")
    } finally {
      server.close()
    }

    const states = new Map(
      (db.prepare(
        `SELECT source_id, lifecycle_state FROM sources WHERE tenant_id = 'demo'`
      ).all() as Array<{ source_id: string; lifecycle_state: string }>).map(
        (row) => [row.source_id, row.lifecycle_state]
      )
    )
    assert.equal(states.get("src-1"), "retired")
    assert.equal(states.get("src-2"), "retired")
    assert.equal(states.get("src-3"), "active", "the other knowledge base is untouched")
    // Both bases still exist: a content wipe never removes a knowledge base.
    assert.equal(service.getById(base.id, "demo")?.status, "active")
    assert.equal(service.getById(other.id, "demo")?.status, "active")
  } finally {
    db.close()
  }
})

test("the default knowledge base can be emptied (it is only un-archivable)", async () => {
  const { app, db, service } = buildApp({ scopes: ["chat", "admin"] })
  try {
    const fallback = service.ensureDefault("demo")
    seedSource(db, { sourceId: "src-d", knowledgeBaseId: fallback.id, tenantId: "demo", docIds: ["doc-d"] })

    const { server, port } = await listen(app)
    try {
      const res = await request(port, "POST", `/knowledge-bases/${fallback.id}/retire-contents`, {
        reason: "清掉演示语料",
      })
      assert.equal(res.status, 200)
      assert.equal(res.json?.retired, 1)
    } finally {
      server.close()
    }
    assert.equal(service.getById(fallback.id, "demo")?.status, "active",
      "emptying the default base does not archive it")
  } finally {
    db.close()
  }
})
