import assert from "node:assert/strict"
import test from "node:test"
import { openDb, type DB } from "./db"
import { ActiveVersionRepository } from "./active_version_repo"
import { PageIndexRepository, type PageIndexNodeEligibility } from "./page_index_repo"
import type { PageIndexNode } from "../../types"

/**
 * Ticket 06 P3: page_index_nodes carries access metadata (tenantId/allowedGroups)
 * inherited from the Document. SQLite columns are NOT NULL DEFAULT so legacy
 * callers that omit the fields still get 'default' / '[]'; the pipeline passes
 * real values from document.tenantId/allowedGroups.
 */

function makeRepo() {
  const db = openDb(":memory:")
  return { db, repo: new PageIndexRepository(db) }
}

function sampleNode(documentId: string, nodeId = "node-1"): PageIndexNode {
  return {
    documentId,
    nodeId,
    title: `Section ${nodeId}`,
    sectionPath: ["root", nodeId],
    pageStart: 1,
    pageEnd: 2,
    summary: "summary",
    parentId: null,
    childIds: [],
    linkedChunkIds: ["chunk-1"],
  }
}

test("Ticket 06 P3: openDb migration adds tenant_id/allowed_groups columns to page_index_nodes with correct DEFAULTs", () => {
  const db = openDb(":memory:")
  try {
    const columns = db.pragma("table_info(page_index_nodes)") as Array<{
      name: string
      notnull: number
      dflt_value: string | null
    }>
    const tenantCol = columns.find((col) => col.name === "tenant_id")
    const groupsCol = columns.find((col) => col.name === "allowed_groups")
    assert.ok(tenantCol, "tenant_id column must exist after openDb migration")
    assert.ok(groupsCol, "allowed_groups column must exist after openDb migration")
    assert.equal(tenantCol!.notnull, 1, "tenant_id must be NOT NULL")
    assert.equal(groupsCol!.notnull, 1, "allowed_groups must be NOT NULL")
    assert.equal(tenantCol!.dflt_value, "'default'", "tenant_id DEFAULT must be 'default'")
    assert.equal(groupsCol!.dflt_value, "'[]'", "allowed_groups DEFAULT must be '[]'")
  } finally {
    db.close()
  }
})

test("Ticket 06 P3: replaceNodes() without accessMetadata falls back to DEFAULT 'default' / '[]'", () => {
  const { db, repo } = makeRepo()
  try {
    repo.replaceNodes("doc-p3-defaults", [sampleNode("doc-p3-defaults")])
    const row = db.prepare(
      `SELECT tenant_id, allowed_groups FROM page_index_nodes WHERE document_id = ?`
    ).get("doc-p3-defaults") as { tenant_id: string; allowed_groups: string }
    assert.equal(row.tenant_id, "default")
    assert.equal(row.allowed_groups, "[]")
  } finally {
    db.close()
  }
})

test("Ticket 06 P3: replaceNodes() with accessMetadata writes the provided tenantId/allowedGroups", () => {
  const { db, repo } = makeRepo()
  try {
    repo.replaceNodes("doc-p3-explicit", [sampleNode("doc-p3-explicit")], {
      tenantId: "tenant-acme",
      allowedGroups: ["ops", "support"],
    })
    const row = db.prepare(
      `SELECT tenant_id, allowed_groups FROM page_index_nodes WHERE document_id = ?`
    ).get("doc-p3-explicit") as { tenant_id: string; allowed_groups: string }
    assert.equal(row.tenant_id, "tenant-acme")
    assert.deepEqual(JSON.parse(row.allowed_groups), ["ops", "support"])
  } finally {
    db.close()
  }
})

test("Ticket 06 P3: replaceNodes() applies accessMetadata to every node in the batch", () => {
  const { db, repo } = makeRepo()
  try {
    repo.replaceNodes(
      "doc-p3-batch",
      [
        sampleNode("doc-p3-batch", "node-a"),
        sampleNode("doc-p3-batch", "node-b"),
        sampleNode("doc-p3-batch", "node-c"),
      ],
      { tenantId: "tenant-batch", allowedGroups: ["readers"] }
    )
    const rows = db.prepare(
      `SELECT tenant_id, allowed_groups FROM page_index_nodes WHERE document_id = ? ORDER BY node_id`
    ).all("doc-p3-batch") as Array<{ tenant_id: string; allowed_groups: string }>
    assert.equal(rows.length, 3)
    for (const row of rows) {
      assert.equal(row.tenant_id, "tenant-batch")
      assert.deepEqual(JSON.parse(row.allowed_groups), ["readers"])
    }
  } finally {
    db.close()
  }
})

test("Ticket 06 P3: getNodesByDocument() returns PageIndexNode with tenantId/allowedGroups populated", () => {
  const { repo, db } = makeRepo()
  try {
    repo.replaceNodes("doc-p3-get", [sampleNode("doc-p3-get")], {
      tenantId: "tenant-beta",
      allowedGroups: ["readers", "writers"],
    })
    const nodes = repo.getNodesByDocument("doc-p3-get")
    assert.equal(nodes.length, 1)
    assert.equal(nodes[0].tenantId, "tenant-beta")
    assert.deepEqual(nodes[0].allowedGroups, ["readers", "writers"])
  } finally {
    db.close()
  }
})

test("Ticket 06 P3: getNodesByDocument() returns DEFAULT access metadata when replaceNodes omitted it", () => {
  const { repo, db } = makeRepo()
  try {
    repo.replaceNodes("doc-p3-get-defaults", [sampleNode("doc-p3-get-defaults")])
    const nodes = repo.getNodesByDocument("doc-p3-get-defaults")
    assert.equal(nodes.length, 1)
    assert.equal(nodes[0].tenantId, "default")
    assert.deepEqual(nodes[0].allowedGroups, [])
  } finally {
    db.close()
  }
})

test("Ticket 06 P3: searchNodes() returns PageIndexNode with access metadata populated", () => {
  const { repo, db } = makeRepo()
  try {
    repo.replaceNodes("doc-p3-search", [sampleNode("doc-p3-search")], {
      tenantId: "tenant-gamma",
      allowedGroups: ["searchers"],
    })
    const nodes = repo.searchNodes("Section", 10)
    assert.ok(nodes.length >= 1, "search must find the seeded node")
    const found = nodes.find((n) => n.documentId === "doc-p3-search")
    assert.ok(found, "seeded node must be in search results")
    assert.equal(found!.tenantId, "tenant-gamma")
    assert.deepEqual(found!.allowedGroups, ["searchers"])
  } finally {
    db.close()
  }
})

test("Ticket 06 P3: replaceNodes() overwrites previous access metadata on re-replace (immutability = no UPDATE, but DELETE+INSERT is allowed)", () => {
  const { repo, db } = makeRepo()
  try {
    repo.replaceNodes("doc-p3-replace", [sampleNode("doc-p3-replace")], {
      tenantId: "tenant-old",
      allowedGroups: ["old"],
    })
    repo.replaceNodes("doc-p3-replace", [sampleNode("doc-p3-replace", "node-2")], {
      tenantId: "tenant-new",
      allowedGroups: ["new"],
    })
    const nodes = repo.getNodesByDocument("doc-p3-replace")
    assert.equal(nodes.length, 1)
    assert.equal(nodes[0].nodeId, "node-2")
    assert.equal(nodes[0].tenantId, "tenant-new")
    assert.deepEqual(nodes[0].allowedGroups, ["new"])
  } finally {
    db.close()
  }
})

/**
 * Ticket PT-10 (audit finding F1) — eligibility is resolved BEFORE the bounded
 * selection, in the query itself.
 *
 * The audited defect: `searchNodes()` matched only `title`/`summary`, so
 * `ORDER BY document_id, node_id LIMIT 5` handed its five slots to whatever
 * matched FIRST — including rows from another tenant, another knowledge base, an
 * invisible group or a non-active document version — while the caller's eligible
 * target, filtered only afterwards by `RuntimeSearchOperations`, lost its slot.
 * `.scratch/pipeline-structure-audit-2026-10-08/reproduce.cjs` case
 * `F1_pageindex_scope_after_limit` recorded that broken baseline as its evidence
 * (1 hit → 0 hits after five foreign nodes were added). The fixtures below reuse
 * exactly that idea and pin the OPPOSITE behavior: the eligible target keeps its
 * hit, and the ceiling stays five.
 */

const PT10_QUERY = "退款规则"
const PT10_TENANT = "tenant-pt10"
const PT10_TARGET_KB = "kb-pt10-target"
const PT10_FOREIGN_KB = "kb-pt10-foreign"

/** Five documents that sort AHEAD of the target, exactly like the audit fixture. */
function foreignDocumentIds(count = 5): string[] {
  return Array.from({ length: count }, (_, index) => `a-foreign-${index}`)
}

interface Pt10Seed {
  documentId: string
  nodeId?: string
  title?: string
  summary?: string
  tenantId?: string
  allowedGroups?: string[]
  knowledgeBaseId?: string
  linkedChunkIds?: string[]
}

function pt10Node(seed: Pt10Seed): PageIndexNode {
  return {
    documentId: seed.documentId,
    nodeId: seed.nodeId ?? "node-1",
    title: seed.title ?? `${PT10_QUERY}（${seed.documentId}）`,
    sectionPath: [PT10_QUERY],
    pageStart: 1,
    pageEnd: 1,
    summary: seed.summary ?? "退款条件与例外",
    parentId: null,
    childIds: [],
    linkedChunkIds: seed.linkedChunkIds ?? [`chunk-${seed.documentId}`],
  }
}

function seedNode(repo: PageIndexRepository, seed: Pt10Seed): void {
  repo.replaceNodes(seed.documentId, [pt10Node(seed)], {
    ...(seed.tenantId !== undefined ? { tenantId: seed.tenantId } : {}),
    ...(seed.allowedGroups !== undefined ? { allowedGroups: seed.allowedGroups } : {}),
    ...(seed.knowledgeBaseId !== undefined ? { knowledgeBaseId: seed.knowledgeBaseId } : {}),
  })
}

/** The active identity of a document — the same `sources.active_doc_id` column
 *  `ActiveVersionRepository.getActiveDocIds()` reads. */
function markDocumentActive(db: DB, documentId: string): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO sources (
       source_id, source_key, source_kind, source_uri, namespace,
       active_doc_id, created_at, updated_at
     ) VALUES (?, ?, 'file', ?, 'pt10', ?, ?, ?)`
  ).run(
    `src-${documentId}`,
    `key-${documentId}`,
    `file://${documentId}`,
    documentId,
    now,
    now
  )
}

/**
 * PT-10 AC08 seam: a Database stand-in that records every row set the repository
 * materialises. A "read all matching rows into memory, filter afterwards"
 * implementation would report the FULL match count here even though the caller
 * asked for five nodes; a query-side filter reports at most five.
 */
interface StatementRead {
  sql: string
  rowsReturned: number
  boundParams: number
}

function recordingDb(db: DB): { proxy: DB; reads: StatementRead[] } {
  const reads: StatementRead[] = []
  const proxy = {
    prepare(sql: string) {
      const statement = db.prepare(sql) as unknown as Record<string, unknown>
      return new Proxy(statement, {
        get(target, property) {
          if (property === "all") {
            return (...args: unknown[]) => {
              const rows = (target.all as (...values: unknown[]) => unknown[])(...args)
              reads.push({
                sql,
                rowsReturned: Array.isArray(rows) ? rows.length : 0,
                boundParams: args.length,
              })
              return rows
            }
          }
          const value = Reflect.get(target, property)
          return typeof value === "function" ? value.bind(target) : value
        },
      })
    },
  } as unknown as DB
  return { proxy, reads }
}

test("PT-10 AC01: five higher-sorted foreign-knowledge-base nodes leave the target's bounded slot intact", () => {
  const { db, repo } = makeRepo()
  try {
    seedNode(repo, { documentId: "z-target", knowledgeBaseId: PT10_TARGET_KB, tenantId: PT10_TENANT })
    const eligibility: PageIndexNodeEligibility = {
      tenantId: PT10_TENANT,
      knowledgeBaseIds: [PT10_TARGET_KB],
    }
    const baseline = repo.searchNodes(PT10_QUERY, 5, eligibility)
    assert.deepEqual(
      baseline.map(({ documentId }) => documentId),
      ["z-target"],
      "baseline: the target is the only eligible match"
    )

    for (const documentId of foreignDocumentIds()) {
      seedNode(repo, { documentId, knowledgeBaseId: PT10_FOREIGN_KB, tenantId: PT10_TENANT })
    }
    assert.deepEqual(
      repo.searchNodes(PT10_QUERY, 5, eligibility).map(({ documentId }) => documentId),
      ["z-target"],
      "another knowledge base's nodes must never consume the caller's five slots"
    )

    // Same fixture without the scope: the audited starvation, reproduced. This is
    // the legacy unscoped caller, NOT the retrieval path (which always scopes).
    assert.deepEqual(
      repo.searchNodes(PT10_QUERY, 5).map(({ documentId }) => documentId),
      foreignDocumentIds(),
      "an unscoped legacy read keeps the pre-existing bounded shape (the defect the scope fixes)"
    )
    assert.equal(repo.searchNodes(PT10_QUERY, 5, eligibility).length, 1)
  } finally {
    db.close()
  }
})

test("PT-10 AC02: cross-tenant matches sorting ahead of the target never consume its slot", () => {
  const { db, repo } = makeRepo()
  try {
    seedNode(repo, { documentId: "z-target", tenantId: PT10_TENANT, knowledgeBaseId: PT10_TARGET_KB })
    for (const documentId of foreignDocumentIds()) {
      seedNode(repo, { documentId, tenantId: "tenant-other", knowledgeBaseId: PT10_TARGET_KB })
    }
    const nodes = repo.searchNodes(PT10_QUERY, 5, { tenantId: PT10_TENANT })
    assert.deepEqual(nodes.map(({ documentId }) => documentId), ["z-target"])
    // Admin (same tenant, every scope) gains no cross-tenant reach either.
    assert.deepEqual(
      repo
        .searchNodes(PT10_QUERY, 5, { tenantId: PT10_TENANT, knowledgeBaseIds: [PT10_TARGET_KB] })
        .map(({ documentId }) => documentId),
      ["z-target"]
    )
  } finally {
    db.close()
  }
})

test("PT-10 AC02: an invisible group's nodes never consume a group-restricted caller's slots", () => {
  const { db, repo } = makeRepo()
  try {
    seedNode(repo, {
      documentId: "z-target",
      tenantId: PT10_TENANT,
      knowledgeBaseId: PT10_TARGET_KB,
      allowedGroups: [],
    })
    for (const documentId of foreignDocumentIds()) {
      seedNode(repo, {
        documentId,
        tenantId: PT10_TENANT,
        knowledgeBaseId: PT10_TARGET_KB,
        allowedGroups: ["secret-team"],
      })
    }
    // Tenant-wide node plus group-matching node stay selectable; the five
    // "secret-team" nodes are invisible to an "ops" caller.
    seedNode(repo, {
      documentId: "m-visible-to-ops",
      nodeId: "node-1",
      tenantId: PT10_TENANT,
      knowledgeBaseId: PT10_TARGET_KB,
      allowedGroups: ["ops"],
    })
    const restricted = repo.searchNodes(PT10_QUERY, 5, {
      tenantId: PT10_TENANT,
      callerGroups: ["ops"],
      knowledgeBaseIds: [PT10_TARGET_KB],
    })
    assert.deepEqual(
      restricted.map(({ documentId }) => documentId),
      ["m-visible-to-ops", "z-target"]
    )
    // A zero-group caller IS tenant-wide (the exact filterNodesByAccessContext
    // semantics): the same rows an "ops" caller cannot see are selectable for it,
    // so the group axis is derived from the caller and is never a blanket rule.
    const tenantWide = repo.searchNodes(PT10_QUERY, 7, {
      tenantId: PT10_TENANT,
      callerGroups: [],
      knowledgeBaseIds: [PT10_TARGET_KB],
    })
    assert.deepEqual(
      tenantWide.map(({ documentId }) => documentId),
      [...foreignDocumentIds(), "m-visible-to-ops", "z-target"]
    )
  } finally {
    db.close()
  }
})

test("PT-10 AC02: non-active document versions never consume the active caller's slots", () => {
  const { db, repo } = makeRepo()
  try {
    seedNode(repo, { documentId: "z-target", tenantId: PT10_TENANT, knowledgeBaseId: PT10_TARGET_KB })
    for (const documentId of foreignDocumentIds()) {
      seedNode(repo, { documentId, tenantId: PT10_TENANT, knowledgeBaseId: PT10_TARGET_KB })
      // Each foreign document has a source whose ACTIVE pointer is elsewhere:
      // the node exists, but its version is not the active one.
      markDocumentActive(db, documentId)
      db.prepare("UPDATE sources SET active_doc_id = ? WHERE source_id = ?").run(
        `${documentId}-superseded`,
        `src-${documentId}`
      )
    }
    markDocumentActive(db, "z-target")

    const nodes = repo.searchNodes(PT10_QUERY, 5, {
      tenantId: PT10_TENANT,
      knowledgeBaseIds: [PT10_TARGET_KB],
      restrictToActiveDocumentVersions: true,
    })
    assert.deepEqual(
      nodes.map(({ documentId }) => documentId),
      ["z-target"],
      "only the active version's node may take a slot"
    )
    // Without the axis the same fixture starves the target — the pre-fix shape.
    assert.deepEqual(
      repo.searchNodes(PT10_QUERY, 5, { tenantId: PT10_TENANT }).map(({ documentId }) => documentId),
      foreignDocumentIds()
    )
  } finally {
    db.close()
  }
})

test("PT-10 AC03: a configured-but-empty active set selects nothing while an unconfigured axis keeps the default behavior", () => {
  const { db, repo } = makeRepo()
  try {
    seedNode(repo, { documentId: "z-target", tenantId: PT10_TENANT, knowledgeBaseId: PT10_TARGET_KB })
    seedNode(repo, { documentId: "a-other", tenantId: PT10_TENANT, knowledgeBaseId: PT10_TARGET_KB })

    // Active-version repository configured, active set EMPTY → no eligible node.
    const gated = repo.searchNodes(PT10_QUERY, 5, {
      tenantId: PT10_TENANT,
      restrictToActiveDocumentVersions: true,
    })
    assert.deepEqual(gated, [], "a configured-empty active set must hide everything")

    // Active-version repository NOT configured → the pre-existing default read.
    const ungated = repo.searchNodes(PT10_QUERY, 5, { tenantId: PT10_TENANT })
    assert.deepEqual(ungated.map(({ documentId }) => documentId), ["a-other", "z-target"])

    // And the two states are distinguishable on the SAME data, so the caller can
    // never confuse "nothing is active" with "activation is not wired".
    assert.notDeepEqual(gated.map(({ documentId }) => documentId), ungated.map(({ documentId }) => documentId))
  } finally {
    db.close()
  }
})

test("PT-10 AC03: the SQL active axis is exactly ActiveVersionRepository.getActiveDocIds()", () => {
  const { db, repo } = makeRepo()
  try {
    const activeVersionRepo = new ActiveVersionRepository(db)
    const documents = ["z-target", "a-foreign-0", "b-foreign-1", "c-inactive-2"]
    for (const documentId of documents) {
      seedNode(repo, {
        documentId,
        tenantId: PT10_TENANT,
        knowledgeBaseId: PT10_TARGET_KB,
      })
    }
    assert.deepEqual(activeVersionRepo.getActiveDocIds(), [])
    assert.deepEqual(repo.searchNodes(PT10_QUERY, 5, { restrictToActiveDocumentVersions: true }), [])

    markDocumentActive(db, "z-target")
    markDocumentActive(db, "b-foreign-1")
    db.prepare(
      `INSERT INTO sources (source_id, source_key, source_kind, source_uri, namespace, active_doc_id, created_at, updated_at)
       VALUES ('src-null', 'key-null', 'file', 'file://null', 'pt10', NULL, ?, ?)`
    ).run(new Date().toISOString(), new Date().toISOString())

    const expected = new Set(activeVersionRepo.getActiveDocIds())
    assert.deepEqual([...expected].sort(), ["b-foreign-1", "z-target"])
    const gated = repo.searchNodes(PT10_QUERY, 5, { restrictToActiveDocumentVersions: true })
    assert.deepEqual(
      gated.map(({ documentId }) => documentId).sort(),
      [...expected].sort(),
      "the query-side active axis and the repository's active set must agree"
    )
  } finally {
    db.close()
  }
})

test("PT-10 AC04: an untagged legacy row stays refused under an explicit scope and selectable without one", () => {
  const { db, repo } = makeRepo()
  try {
    seedNode(repo, { documentId: "z-target", tenantId: PT10_TENANT, knowledgeBaseId: PT10_TARGET_KB })
    // A row with no knowledge-base tag at all (empty column, the pre-KB-02A shape).
    db.prepare(
      `INSERT INTO page_index_nodes (
         document_id, node_id, title, section_path, page_start, page_end, summary,
         parent_id, child_ids, linked_chunk_ids, tenant_id, allowed_groups, knowledge_base_id
       ) VALUES ('a-untagged', 'node-1', ?, '[]', 1, 1, ?, NULL, '[]', '[]', ?, '[]', '')`
    ).run(`${PT10_QUERY}（a-untagged）`, "退款条件与例外", PT10_TENANT)

    assert.deepEqual(
      repo
        .searchNodes(PT10_QUERY, 5, {
          tenantId: PT10_TENANT,
          knowledgeBaseIds: [PT10_TARGET_KB],
        })
        .map(({ documentId }) => documentId),
      ["z-target"],
      "an untagged row cannot be authorized under an explicit scope (fail closed)"
    )
    assert.deepEqual(
      repo.searchNodes(PT10_QUERY, 5, { tenantId: PT10_TENANT }).map(({ documentId }) => documentId),
      ["a-untagged", "z-target"],
      "without an explicit scope the legacy read is unchanged"
    )
    // An explicit scope with ZERO knowledge bases is "no knowledge context", and
    // must select nothing rather than degrade into an unfiltered read.
    assert.deepEqual(repo.searchNodes(PT10_QUERY, 5, { knowledgeBaseIds: [] }), [])
  } finally {
    db.close()
  }
})

test("PT-10 AC04: a multi-knowledge-base scope returns the union of the named bases only", () => {
  const { db, repo } = makeRepo()
  try {
    seedNode(repo, { documentId: "a-kb-a", knowledgeBaseId: "kb-a", tenantId: PT10_TENANT })
    seedNode(repo, { documentId: "b-kb-b", knowledgeBaseId: "kb-b", tenantId: PT10_TENANT })
    seedNode(repo, { documentId: "c-kb-c", knowledgeBaseId: "kb-c", tenantId: PT10_TENANT })
    const nodes = repo.searchNodes(PT10_QUERY, 5, {
      tenantId: PT10_TENANT,
      knowledgeBaseIds: ["kb-a", "kb-b"],
    })
    assert.deepEqual(nodes.map(({ documentId }) => documentId), ["a-kb-a", "b-kb-b"])
    assert.deepEqual(nodes.map(({ knowledgeBaseId }) => knowledgeBaseId), ["kb-a", "kb-b"])
  } finally {
    db.close()
  }
})

test("PT-10 AC05: eight eligible nodes return the first five in the stable (document_id, node_id) order", () => {
  const { db, repo } = makeRepo()
  try {
    // Eight eligible rows across two knowledge bases, plus three ineligible rows
    // (other tenant / other base / invisible group) that all sort AHEAD of them —
    // the fixture that starved the target before PT-10.
    for (const documentId of ["d0", "d1", "d3", "d4", "d5", "d6"]) {
      seedNode(repo, {
        documentId,
        tenantId: PT10_TENANT,
        knowledgeBaseId: documentId >= "d4" ? "kb-b" : "kb-a",
      })
    }
    repo.replaceNodes(
      "d2",
      [
        pt10Node({ documentId: "d2", nodeId: "node-b" }),
        pt10Node({ documentId: "d2", nodeId: "node-a" }),
      ],
      { tenantId: PT10_TENANT, knowledgeBaseId: "kb-a" }
    )
    seedNode(repo, { documentId: "a0", tenantId: "tenant-other", knowledgeBaseId: "kb-a" })
    seedNode(repo, { documentId: "a1", tenantId: PT10_TENANT, knowledgeBaseId: "kb-c" })
    seedNode(repo, {
      documentId: "a2",
      tenantId: PT10_TENANT,
      knowledgeBaseId: "kb-a",
      allowedGroups: ["secret-team"],
    })

    const nodes = repo.searchNodes(PT10_QUERY, 5, {
      tenantId: PT10_TENANT,
      callerGroups: ["ops"],
      knowledgeBaseIds: ["kb-a", "kb-b"],
    })
    assert.deepEqual(
      nodes.map(({ documentId, nodeId }) => `${documentId}/${nodeId}`),
      ["d0/node-1", "d1/node-1", "d2/node-a", "d2/node-b", "d3/node-1"],
      "the ceiling stays five, the order stays (document_id, node_id), and ineligible rows never take a slot"
    )
    // The three ineligible rows would have filled all five slots unfiltered.
    assert.deepEqual(
      repo.searchNodes(PT10_QUERY, 3).map(({ documentId }) => documentId),
      ["a0", "a1", "a2"]
    )
  } finally {
    db.close()
  }
})

test("PT-10 AC07: LIKE wildcards stay literal, zero hits stay empty, and metadata still comes back", () => {
  const { db, repo } = makeRepo()
  try {
    seedNode(repo, { documentId: "a-literal", title: "覆盖率 100% 说明", knowledgeBaseId: PT10_TARGET_KB })
    seedNode(repo, { documentId: "b-wildcard", title: "覆盖率 100x 说明", knowledgeBaseId: PT10_TARGET_KB })
    seedNode(repo, { documentId: "c-under", title: "退款_A 章节", knowledgeBaseId: PT10_TARGET_KB })
    seedNode(repo, { documentId: "d-under", title: "退款XA 章节", knowledgeBaseId: PT10_TARGET_KB })

    const percent = repo.searchNodes("100%", 5)
    assert.deepEqual(percent.map(({ documentId }) => documentId), ["a-literal"])
    const underscore = repo.searchNodes("退款_A", 5)
    assert.deepEqual(underscore.map(({ documentId }) => documentId), ["c-under"])
    assert.deepEqual(repo.searchNodes("no-such-text", 5), [])
    // Escaping holds with an eligibility scope too — the LIKE clause and the
    // scope clauses are ANDed, not replaced.
    const scoped = repo.searchNodes("100%", 5, { knowledgeBaseIds: [PT10_TARGET_KB] })
    assert.deepEqual(scoped.map(({ documentId }) => documentId), ["a-literal"])
    assert.equal(scoped[0].tenantId, "default")
    assert.deepEqual(scoped[0].allowedGroups, [])
    assert.equal(scoped[0].knowledgeBaseId, PT10_TARGET_KB)
  } finally {
    db.close()
  }
})

test("PT-10 AC07: a malformed access-metadata row degrades exactly like the application-layer filter", () => {
  const { db, repo } = makeRepo()
  try {
    seedNode(repo, { documentId: "z-target", tenantId: PT10_TENANT, knowledgeBaseId: PT10_TARGET_KB })
    // `filterNodesByAccessContext` reads an unparsable allowed_groups as [] —
    // i.e. tenant-wide — so the query-side predicate must not reject the row or
    // fail the whole statement over it.
    db.prepare(
      `INSERT INTO page_index_nodes (
         document_id, node_id, title, section_path, page_start, page_end, summary,
         parent_id, child_ids, linked_chunk_ids, tenant_id, allowed_groups, knowledge_base_id
       ) VALUES ('a-malformed', 'node-1', ?, '[]', 1, 1, ?, NULL, '[]', '[]', ?, 'not-json', ?)`
    ).run(`${PT10_QUERY}（a-malformed）`, "退款条件与例外", PT10_TENANT, PT10_TARGET_KB)

    const nodes = repo.searchNodes(PT10_QUERY, 5, {
      tenantId: PT10_TENANT,
      callerGroups: ["ops"],
      knowledgeBaseIds: [PT10_TARGET_KB],
    })
    assert.deepEqual(nodes.map(({ documentId }) => documentId), ["a-malformed", "z-target"])
    assert.deepEqual(nodes[0].allowedGroups, [])
  } finally {
    db.close()
  }
})

test("PT-10 AC08: eligibility is resolved in the query — ineligible matches are never materialised", () => {
  const { db } = makeRepo()
  try {
    const repo = new PageIndexRepository(db)
    seedNode(repo, { documentId: "z-target", tenantId: PT10_TENANT, knowledgeBaseId: PT10_TARGET_KB })
    // 400 ineligible matches that all sort ahead of the target.
    for (let index = 0; index < 400; index += 1) {
      seedNode(repo, {
        documentId: `a-foreign-${String(index).padStart(3, "0")}`,
        tenantId: PT10_TENANT,
        knowledgeBaseId: PT10_FOREIGN_KB,
      })
    }

    const { proxy, reads } = recordingDb(db)
    const scopedRepo = new PageIndexRepository(proxy)
    const nodes = scopedRepo.searchNodes(PT10_QUERY, 5, {
      tenantId: PT10_TENANT,
      knowledgeBaseIds: [PT10_TARGET_KB],
    })

    assert.deepEqual(nodes.map(({ documentId }) => documentId), ["z-target"])
    const nodeReads = reads.filter(({ sql }) => sql.includes("page_index_nodes"))
    assert.equal(nodeReads.length, 1, "exactly one statement reads the node table")
    assert.equal(reads.length, 1, "the bounded lookup materialises that statement once")
    for (const read of nodeReads) {
      assert.ok(
        read.rowsReturned <= 5,
        `the bounded selection must not materialise the ${read.rowsReturned} matching rows`
      )
      assert.match(read.sql, /LIMIT/, "the ceiling is part of the same statement as the filter")
      const limitPosition = read.sql.lastIndexOf("LIMIT")
      for (const axis of ["tenant_id", "knowledge_base_id", "LIKE"]) {
        assert.ok(
          read.sql.indexOf(axis) < limitPosition,
          `the ${axis} predicate must be resolved before LIMIT`
        )
      }
    }
  } finally {
    db.close()
  }
})

test("PT-10 AC08: a 2,000-document active set adds no bound parameters to the node query", () => {
  const { db } = makeRepo()
  try {
    const repo = new PageIndexRepository(db)
    seedNode(repo, { documentId: "z-target", tenantId: PT10_TENANT, knowledgeBaseId: PT10_TARGET_KB })
    // The active set is resolved by the query, so its size must not leak into the
    // bound-parameter count the way an `IN (?,?,…)` allowlist would.
    db.exec(
      `INSERT INTO sources (
         source_id, source_key, source_kind, source_uri, namespace,
         active_doc_id, created_at, updated_at
       )
       WITH RECURSIVE counter(value) AS (
         SELECT 1 UNION ALL SELECT value + 1 FROM counter WHERE value < 2000
       )
       SELECT 'src-' || value, 'key-' || value, 'file', 'file://bulk', 'pt10',
              printf('a-nonnode-%04d', value), 'now', 'now'
       FROM counter`
    )
    markDocumentActive(db, "z-target")

    const { proxy, reads } = recordingDb(db)
    const scopedRepo = new PageIndexRepository(proxy)
    const nodes = scopedRepo.searchNodes(PT10_QUERY, 5, {
      tenantId: PT10_TENANT,
      callerGroups: ["ops"],
      knowledgeBaseIds: [PT10_TARGET_KB],
      restrictToActiveDocumentVersions: true,
    })

    assert.deepEqual(nodes.map(({ documentId }) => documentId), ["z-target"])
    assert.equal(reads.length, 1)
    // 2 LIKE patterns + tenant + group + knowledge base + LIMIT, whatever the
    // active set size.
    assert.equal(reads[0].boundParams, 6, `unexpected parameter count: ${reads[0].sql}`)
    assert.deepEqual(new ActiveVersionRepository(db).getActiveDocIds().length, 2001)
  } finally {
    db.close()
  }
})
