/**
 * Ticket 42 (DEMO-01A) — preview and rebuild the FIXED demo namespace.
 *
 * This is the daily demo reset the one-time rebuild (demo_rebuild.ts)
 * deliberately does NOT provide: it touches ONLY one fixed namespace —
 * the demo tenant's rows, its Elasticsearch chunks and its Neo4j
 * provenance — and never any other tenant, any workspace file, any
 * database file or any table.
 *
 * The same three safety rules as the one-time rebuild apply, scoped down:
 *
 *   1. Inventory first, read-only. The preview lists the EXACT per-table
 *      row counts of the namespace, the Elasticsearch document count for
 *      the namespace's tenant filter and whether the namespace owns graph
 *      provenance. A layer that cannot be inventoried blocks a confirmed
 *      run — an incomplete listing would make the cleanup guess.
 *   2. Data-layer only. Rows, chunk documents and provenance. No file is
 *      ever unlinked, no table dropped.
 *   3. Explicit confirmation. Without `confirm` nothing is written.
 *
 * SQLite scoping is by tenant and by joins INTO the namespace (task queues
 * via documents, FAQ versions via entries, assistant versions via
 * assistants, run pages via sync runs, answer events and clarifications via
 * session bindings) — the join rows are removed BEFORE their parents so the
 * scoping subqueries still see their rows. Global workspace state that is
 * not namespace-owned (model profile toggles, the schema itself) is left
 * alone.
 */

import { resolveChunkIndexName, DEFAULT_ES_CHUNK_INDEX } from "../config"
import type { Client } from "@elastic/elasticsearch"
import type { DB } from "../ingestion/tracking/db"
import { EVAL_TENANT_PREFIX } from "../evaluation/isolated_resources"
import { DEMO_TENANT_ID as DEMO_NAMESPACE_TENANT } from "../identity/demo_accounts"

/** Bounded request budget for every Elasticsearch call here. */
const NAMESPACE_REQUEST_TIMEOUT_MS = 5_000

export interface DemoNamespaceEsClient {
  exists(request: { index: string }, meta?: unknown): Promise<boolean>
  count(request: { index: string; query?: unknown }, meta?: unknown): Promise<{ count: number }>
  deleteByQuery(
    request: {
      index: string
      query: unknown
      refresh?: boolean
      conflicts?: string
    },
    meta?: unknown
  ): Promise<{ deleted: number }>
}

/**
 * Same surface as the one-time rebuild's graph client — the namespace reset
 * reuses it so there is ONE strip rule implementation.
 */
export interface DemoNamespaceGraph {
  listProvenanceTenants(): Promise<string[]>
  stripProvenance(tenantId: string): Promise<void>
}

export interface DemoNamespaceClients {
  db: DB
  es: DemoNamespaceEsClient
  graph: DemoNamespaceGraph
  indexName?: string
}

export interface DemoNamespaceInventory {
  tenantId: string
  /** Per-table row counts FOR THIS NAMESPACE only (direct or joined). */
  sqliteTables: Array<{ table: string; rows: number }>
  /** The Elasticsearch index with the namespace's document count. */
  esIndex: { index: string; documents: number | null }
  /** True when the namespace owns WIKILINK provenance in Neo4j. */
  neo4jProvenanceOwned: boolean
  /** Read failures per layer. A non-empty list blocks a confirmed run. */
  errors: Array<{ layer: "sqlite" | "elasticsearch" | "neo4j"; message: string }>
}

export interface DemoNamespaceCleanup {
  sqliteTables: Array<{ table: string; rowsDeleted: number; error?: string }>
  esIndex: { index: string; deleted: number; error?: string }
  neo4jProvenance: { tenantId: string; outcome: "cleaned" | "skipped" | "failed"; error?: string }
}

export interface DemoNamespaceReport {
  inventory: DemoNamespaceInventory
  executed: boolean
  refusedReason?: string
  cleanup?: DemoNamespaceCleanup
}

export const DEMO_NAMESPACE_ES_INDEX = DEFAULT_ES_CHUNK_INDEX

/**
 * The namespace-scoped SQLite targets, in DEPENDENCY ORDER. Each entry is
 * either a direct `tenant_id` delete or a join into a namespace table that
 * still exists when the entry runs (joins are listed before their parents).
 * The interpolated identifier is always a literal from this file.
 */
const DEMO_NAMESPACE_SQLITE_TARGETS: ReadonlyArray<{
  table: string
  scopeSql: string
}> = [
  // Queue/state rows scoped by documents — must run BEFORE documents.
  {
    table: "task_pending_ops",
    scopeSql: `doc_id IN (SELECT doc_id FROM documents WHERE tenant_id = @tenant)`,
  },
  {
    table: "task_dead_letters",
    scopeSql: `doc_id IN (SELECT doc_id FROM documents WHERE tenant_id = @tenant)`,
  },
  {
    table: "processing_spans",
    scopeSql: `doc_id IN (SELECT doc_id FROM documents WHERE tenant_id = @tenant)`,
  },
  {
    table: "cleanup_image_assets",
    scopeSql: `document_id IN (SELECT doc_id FROM documents WHERE tenant_id = @tenant)`,
  },
  // Answer events and clarifications are scoped by session — run BEFORE
  // session_bindings loses the (tenant, session) mapping.
  {
    table: "answer_run_events",
    scopeSql: `session_id IN (SELECT session_id FROM session_bindings WHERE tenant_id = @tenant)`,
  },
  {
    table: "clarification_pending",
    scopeSql: `session_id IN (SELECT session_id FROM session_bindings WHERE tenant_id = @tenant)`,
  },
  // Versions scoped by their parents — before the parent rows.
  {
    table: "faq_entry_versions",
    scopeSql: `faq_entry_id IN (SELECT id FROM faq_entries WHERE tenant_id = @tenant)`,
  },
  {
    table: "assistant_versions",
    scopeSql: `assistant_id IN (SELECT id FROM assistants WHERE tenant_id = @tenant)`,
  },
  {
    table: "wiki_revisions",
    scopeSql: `page_id IN (SELECT id FROM wiki_pages WHERE tenant_id = @tenant)`,
  },
  {
    table: "wiki_contributions",
    scopeSql: `page_id IN (SELECT id FROM wiki_pages WHERE tenant_id = @tenant)`,
  },
  {
    table: "wiki_proposals",
    scopeSql: `page_id IN (SELECT id FROM wiki_pages WHERE tenant_id = @tenant)`,
  },
  // Sync run pages scope through the tenant's runs — before sync_runs.
  {
    table: "sync_run_pages",
    scopeSql: `run_id IN (SELECT id FROM sync_runs WHERE tenant_id = @tenant)`,
  },
  // Direct tenant rows.
  { table: "page_index_nodes", scopeSql: `tenant_id = @tenant` },
  { table: "wiki_settings", scopeSql: `tenant_id = @tenant` },
  { table: "wiki_pages", scopeSql: `tenant_id = @tenant` },
  { table: "wiki_folders", scopeSql: `tenant_id = @tenant` },
  { table: "wiki_issues", scopeSql: `tenant_id = @tenant` },
  { table: "wiki_jobs", scopeSql: `tenant_id = @tenant` },
  { table: "documents", scopeSql: `tenant_id = @tenant` },
  { table: "sources", scopeSql: `tenant_id = @tenant` },
  { table: "source_tombstones", scopeSql: `tenant_id = @tenant` },
  { table: "session_attachment_chunks", scopeSql: `tenant_id = @tenant` },
  { table: "session_attachments", scopeSql: `tenant_id = @tenant` },
  { table: "conversation_turns", scopeSql: `tenant_id = @tenant` },
  { table: "conversation_rolling_summaries", scopeSql: `tenant_id = @tenant` },
  { table: "conversation_directories", scopeSql: `tenant_id = @tenant` },
  { table: "conversation_history_turns", scopeSql: `tenant_id = @tenant` },
  { table: "feedback", scopeSql: `tenant_id = @tenant` },
  { table: "handoff_cases", scopeSql: `tenant_id = @tenant` },
  { table: "long_term_memories", scopeSql: `tenant_id = @tenant` },
  { table: "memory_suggestions", scopeSql: `tenant_id = @tenant` },
  { table: "sync_data_sources", scopeSql: `tenant_id = @tenant` },
  { table: "sync_runs", scopeSql: `tenant_id = @tenant` },
  { table: "sync_source_pages", scopeSql: `tenant_id = @tenant` },
  { table: "faq_entries", scopeSql: `tenant_id = @tenant` },
  { table: "assistants", scopeSql: `tenant_id = @tenant` },
  { table: "session_bindings", scopeSql: `tenant_id = @tenant` },
  // The tenant's knowledge bases (including the seeded fixed ones).
  { table: "knowledge_bases", scopeSql: `tenant_id = @tenant` },
]

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read-only inventory of exactly what the namespace owns. */
export async function inventoryDemoNamespace(
  clients: DemoNamespaceClients,
  tenantId: string
): Promise<DemoNamespaceInventory> {
  const errors: DemoNamespaceInventory["errors"] = []

  if (tenantId !== DEMO_NAMESPACE_TENANT) {
    // The reset is the FIXED demo namespace's tool — accepting an arbitrary
    // tenant id would let a caller mistake it for a generic tenant cleaner.
    throw new Error(
      `the demo namespace reset only manages tenant "${DEMO_NAMESPACE_TENANT}", not "${tenantId}"`
    )
  }

  const sqliteTables: DemoNamespaceInventory["sqliteTables"] = []
  try {
    const present = new Set(
      (
        clients.db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
          .all() as Array<{ name: string }>
      ).map((row) => row.name)
    )
    for (const target of DEMO_NAMESPACE_SQLITE_TARGETS) {
      if (!present.has(target.table)) {
        continue
      }
      const row = clients.db
        .prepare(`SELECT COUNT(*) AS n FROM "${target.table}" WHERE ${target.scopeSql}`)
        .get({ tenant: tenantId }) as { n: number }
      sqliteTables.push({ table: target.table, rows: row.n })
    }
  } catch (error) {
    errors.push({ layer: "sqlite", message: messageOf(error) })
  }

  let esDocuments: number | null = null
  try {
    // The shared index is created lazily by the first ingestion — a missing
    // index means the namespace owns ZERO chunk documents, not an error.
    const indexExists = await clients.es.exists(
      { index: resolveChunkIndexName(clients.indexName) },
      { requestTimeout: NAMESPACE_REQUEST_TIMEOUT_MS, maxRetries: 0 }
    )
    if (!indexExists) {
      esDocuments = 0
    } else {
      const counted = await clients.es.count(
        { index: resolveChunkIndexName(clients.indexName), query: { term: { tenantId } } },
        { requestTimeout: NAMESPACE_REQUEST_TIMEOUT_MS, maxRetries: 0 }
      )
      esDocuments = typeof counted.count === "number" ? counted.count : null
    }
  } catch (error) {
    errors.push({ layer: "elasticsearch", message: messageOf(error) })
  }

  let neo4jProvenanceOwned = false
  try {
    // Legacy evaluation scopes are never namespace-reset targets — mirror the
    // one-time rebuild's guard.
    const owners = (await clients.graph.listProvenanceTenants()).filter(
      (owner) => !owner.startsWith(EVAL_TENANT_PREFIX)
    )
    neo4jProvenanceOwned = owners.includes(tenantId)
  } catch (error) {
    errors.push({ layer: "neo4j", message: messageOf(error) })
  }

  return {
    tenantId,
    sqliteTables,
    esIndex: { index: resolveChunkIndexName(clients.indexName), documents: esDocuments },
    neo4jProvenanceOwned,
    errors,
  }
}

/**
 * Preview (confirm: false) or rebuild (confirm: true) the namespace.
 * Without confirmation nothing is written; with confirmation the cleanup
 * consumes exactly the inventory that was listed — a namespace-scoped
 * Elasticsearch delete_by_query (never an index deletion), the tenant's
 * provenance strip, and the joined tenant row deletes.
 */
export async function resetDemoNamespace(
  clients: DemoNamespaceClients,
  tenantId: string,
  options: { confirm: boolean }
): Promise<DemoNamespaceReport> {
  const inventory = await inventoryDemoNamespace(clients, tenantId)
  if (!options.confirm) return { inventory, executed: false }
  if (inventory.errors.length > 0) {
    return {
      inventory,
      executed: false,
      refusedReason: `namespace inventory incomplete: ${inventory.errors
        .map((error) => `${error.layer}: ${error.message}`)
        .join("; ")}`,
    }
  }

  const sqliteTables: DemoNamespaceCleanup["sqliteTables"] = []
  for (const target of DEMO_NAMESPACE_SQLITE_TARGETS) {
    const listed = inventory.sqliteTables.find((entry) => entry.table === target.table)
    // Only tables that exist in this database are deleted — the inventory
    // named them, the cleanup never guesses.
    if (!listed) continue
    try {
      const result = clients.db
        .prepare(`DELETE FROM "${target.table}" WHERE ${target.scopeSql}`)
        .run({ tenant: tenantId })
      sqliteTables.push({ table: target.table, rowsDeleted: result.changes })
    } catch (error) {
      sqliteTables.push({ table: target.table, rowsDeleted: 0, error: messageOf(error) })
    }
  }

  let esIndex: DemoNamespaceCleanup["esIndex"]
  try {
    const indexExists = await clients.es.exists(
      { index: resolveChunkIndexName(clients.indexName) },
      { requestTimeout: NAMESPACE_REQUEST_TIMEOUT_MS, maxRetries: 0 }
    )
    if (!indexExists) {
      esIndex = { index: resolveChunkIndexName(clients.indexName), deleted: 0 }
    } else {
      const result = await clients.es.deleteByQuery(
        {
          index: resolveChunkIndexName(clients.indexName),
          // The tenant term IS the namespace boundary — other tenants'
          // documents in the same index are untouched.
          query: { term: { tenantId } },
          refresh: true,
          conflicts: "proceed",
        },
        { requestTimeout: NAMESPACE_REQUEST_TIMEOUT_MS, maxRetries: 0 }
      )
      esIndex = { index: resolveChunkIndexName(clients.indexName), deleted: result.deleted ?? 0 }
    }
  } catch (error) {
    esIndex = { index: resolveChunkIndexName(clients.indexName), deleted: 0, error: messageOf(error) }
  }

  let neo4jProvenance: DemoNamespaceCleanup["neo4jProvenance"]
  try {
    if (inventory.neo4jProvenanceOwned) {
      await clients.graph.stripProvenance(tenantId)
      neo4jProvenance = { tenantId, outcome: "cleaned" }
    } else {
      neo4jProvenance = { tenantId, outcome: "skipped" }
    }
  } catch (error) {
    neo4jProvenance = { tenantId, outcome: "failed", error: messageOf(error) }
  }

  return {
    inventory,
    executed: true,
    cleanup: { sqliteTables, esIndex, neo4jProvenance },
  }
}
