import type { Client } from "@elastic/elasticsearch"
import type { Driver } from "neo4j-driver"
import type { DB } from "../ingestion/tracking/db"
import {
  EVAL_TENANT_PREFIX,
  findProvenanceTenants,
  stripProvenanceForTenant,
} from "../evaluation/isolated_resources"

/**
 * Ticket 02 (KB-01, spec §2.7 L96 + §9 L292): the approved one-time
 * demo-data rebuild.
 *
 * The user approved a full, unrecoverable rebuild of the current local demo
 * data — no backup, no migration of existing rows (spec §9 L296). That
 * approval does NOT authorize deleting workspace files, so this module:
 *
 *   - lists the EXACT targets first, read-only (SQLite tables, Elasticsearch
 *     indexes, Neo4j provenance owners) and makes that listing the input of
 *     the cleanup step, so cleanup cannot run against anything that was not
 *     enumerated (spec §2.7 "必须先只读列出精确目标，再执行数据层清理");
 *   - cleans at the data layer only — rows, documents and provenance. It never
 *     unlinks a file, never drops a table, never recreates the database;
 *   - refuses to run at all when a layer could not be inventoried, because an
 *     incomplete listing means the cleanup would be guessing.
 *
 * The daily demo reset is a SEPARATE, future ticket: it may only touch a fixed
 * demo namespace, must print a preview and requires an explicit `--confirm`.
 * It must not reuse this path (spec §2.7 L97) — this one is a one-shot.
 */

/**
 * Every SQLite table the one-time rebuild clears. Row deletion only: the
 * schema, the database file and the `-wal`/`-shm` siblings all stay.
 */
export const DEMO_REBUILD_SQLITE_TABLES = [
  "knowledge_bases",
  "sources",
  "documents",
  "task_pending_ops",
  "task_dead_letters",
  "processing_spans",
  "answer_run_events",
  "page_index_nodes",
  "clarification_pending",
  "session_bindings",
  "conversation_turns",
  "conversation_rolling_summaries",
  "handoff_cases",
  "feedback",
  "source_tombstones",
  // Ticket 16 (MODEL-01A): the profile toggles are workspace state — a rebuild
  // resets them so the next boot re-seeds from the credential slots.
  "model_profiles",
  // Ticket 18 (AST-01A): assistants and their immutable versions are workspace
  // state; a rebuild clears both (version rows first via order-independence —
  // DELETE has no FK constraints here).
  "assistants",
  "assistant_versions",
] as const

/**
 * The Elasticsearch target. Exactly one business chunk index — it is recreated
 * from code by `IngestionStoreImpl.ensureIndex()` on the next ingestion, so
 * deleting it is a data-layer action with no file loss. Dedicated evaluation
 * indices are NOT listed here: a crashed evaluation scope is released by its
 * own tool (`npm run eval:residue`), and this path must stay exact.
 */
export const DEMO_REBUILD_ES_INDEXES = ["kefu-rag-chunks"] as const

/** Every Elasticsearch call here is bounded — a hung cluster must not hang the
 * operator, and a delete must never be retried silently. */
const REBUILD_REQUEST_TIMEOUT_MS = 5_000

export type DemoRebuildLayer = "sqlite" | "elasticsearch" | "neo4j"

/**
 * The Neo4j side, narrowed to what this rebuild actually needs: which tenants
 * own provenance, and the strip rule for one tenant. Injected as an interface
 * because the driver's session/transaction surface is not worth faking — the
 * production implementation below is the only place a driver is touched, and
 * it reuses the SAME strip rule evaluation dispose uses (one implementation,
 * no drift).
 */
export interface DemoRebuildGraph {
  listProvenanceTenants(): Promise<string[]>
  stripProvenance(tenantId: string): Promise<void>
}

export function createNeo4jDemoRebuildGraph(driver: Driver): DemoRebuildGraph {
  return {
    async listProvenanceTenants(): Promise<string[]> {
      const session = driver.session()
      try {
        return await findProvenanceTenants(session)
      } finally {
        await session.close()
      }
    },
    async stripProvenance(tenantId: string): Promise<void> {
      const session = driver.session()
      try {
        await stripProvenanceForTenant(session, tenantId)
      } finally {
        await session.close()
      }
    },
  }
}

export interface DemoRebuildClients {
  db: DB
  es: Client
  graph: DemoRebuildGraph
}

export interface DemoRebuildInventory {
  /** Exact SQLite targets. `rows` is 0 when the table is absent. */
  sqliteTables: Array<{ table: string; exists: boolean; rows: number }>
  /** Exact Elasticsearch targets, with the document count when readable. */
  esIndexes: Array<{ index: string; exists: boolean; documents: number | null }>
  /** Exact Neo4j targets: every tenant that owns WIKILINK provenance. */
  neo4jProvenanceTenants: string[]
  /** Tenants that had a knowledge base before the rebuild — the default is
   * recreated for each of them afterwards. */
  knowledgeBaseTenants: string[]
  /** Read failures per layer. A non-empty list blocks a confirmed run. */
  errors: Array<{ layer: DemoRebuildLayer; message: string }>
}

export interface DemoRebuildCleanup {
  sqliteTables: Array<{ table: string; rowsDeleted: number; error?: string }>
  esIndexes: Array<{
    index: string
    outcome: "deleted" | "not_found" | "failed"
    error?: string
  }>
  neo4jProvenance: Array<{
    tenantId: string
    outcome: "cleaned" | "failed"
    error?: string
  }>
}

export interface DemoRebuildReport {
  inventory: DemoRebuildInventory
  executed: boolean
  /** Set when a confirmed run was refused — nothing was deleted. */
  refusedReason?: string
  cleanup?: DemoRebuildCleanup
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read-only. Nothing here writes to SQLite, Elasticsearch or Neo4j. */
export async function inventoryDemoRebuild(
  clients: DemoRebuildClients
): Promise<DemoRebuildInventory> {
  const errors: DemoRebuildInventory["errors"] = []

  const sqliteTables: DemoRebuildInventory["sqliteTables"] = []
  let knowledgeBaseTenants: string[] = []
  try {
    const present = new Set(
      (
        clients.db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
          .all() as Array<{ name: string }>
      ).map((row) => row.name)
    )
    for (const table of DEMO_REBUILD_SQLITE_TABLES) {
      const exists = present.has(table)
      const rows = exists
        ? (clients.db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as {
            n: number
          }).n
        : 0
      sqliteTables.push({ table, exists, rows })
    }
    if (present.has("knowledge_bases")) {
      knowledgeBaseTenants = (
        clients.db
          .prepare(`SELECT DISTINCT tenant_id FROM knowledge_bases ORDER BY tenant_id`)
          .all() as Array<{ tenant_id: string }>
      ).map((row) => row.tenant_id)
    }
  } catch (error) {
    errors.push({ layer: "sqlite", message: messageOf(error) })
  }

  const esIndexes: DemoRebuildInventory["esIndexes"] = []
  for (const index of DEMO_REBUILD_ES_INDEXES) {
    try {
      const exists = await clients.es.indices.exists(
        { index },
        { requestTimeout: REBUILD_REQUEST_TIMEOUT_MS, maxRetries: 0 }
      )
      if (!exists) {
        esIndexes.push({ index, exists: false, documents: null })
        continue
      }
      const counted = await clients.es.count(
        { index },
        { requestTimeout: REBUILD_REQUEST_TIMEOUT_MS, maxRetries: 0 }
      )
      esIndexes.push({
        index,
        exists: true,
        documents: typeof counted.count === "number" ? counted.count : null,
      })
    } catch (error) {
      errors.push({ layer: "elasticsearch", message: `${index}: ${messageOf(error)}` })
      esIndexes.push({ index, exists: false, documents: null })
    }
  }

  let neo4jProvenanceTenants: string[] = []
  try {
    // Evaluation scopes are deliberately NOT rebuild targets — their dedicated
    // ES index is not listed either, and a crashed scope is released by its own
    // tool (`npm run eval:residue`). Reaching into them here would strip a live
    // evaluation's provenance while leaving its index behind.
    neo4jProvenanceTenants = (await clients.graph.listProvenanceTenants()).filter(
      (tenantId) => !tenantId.startsWith(EVAL_TENANT_PREFIX)
    )
  } catch (error) {
    errors.push({ layer: "neo4j", message: messageOf(error) })
  }

  return {
    sqliteTables,
    esIndexes,
    neo4jProvenanceTenants,
    knowledgeBaseTenants,
    errors,
  }
}

/**
 * Run the one-time rebuild.
 *
 * Always inventories first. Without `confirm` it returns the listing and
 * touches nothing. With `confirm` it cleans exactly what the listing named —
 * and refuses (deleting nothing) when the listing was incomplete.
 */
export async function runDemoRebuild(
  clients: DemoRebuildClients,
  options: { confirm: boolean }
): Promise<DemoRebuildReport> {
  const inventory = await inventoryDemoRebuild(clients)
  if (!options.confirm) return { inventory, executed: false }
  if (inventory.errors.length > 0) {
    return {
      inventory,
      executed: false,
      refusedReason: `target inventory incomplete: ${inventory.errors
        .map((error) => `${error.layer}: ${error.message}`)
        .join("; ")}`,
    }
  }
  return {
    inventory,
    executed: true,
    cleanup: await cleanupDemoRebuild(clients, inventory),
  }
}

/** Data-layer cleanup of exactly the enumerated targets. Never touches files. */
async function cleanupDemoRebuild(
  clients: DemoRebuildClients,
  inventory: DemoRebuildInventory
): Promise<DemoRebuildCleanup> {
  const sqliteTables: DemoRebuildCleanup["sqliteTables"] = []
  // Row deletion only, and only for names from the constant list — the
  // interpolated identifier is always a literal from this file.
  for (const table of DEMO_REBUILD_SQLITE_TABLES) {
    const target = inventory.sqliteTables.find((entry) => entry.table === table)
    if (!target?.exists) continue
    try {
      const result = clients.db.prepare(`DELETE FROM "${table}"`).run()
      sqliteTables.push({ table, rowsDeleted: result.changes })
    } catch (error) {
      // One table failing must not abandon the rest of the rebuild: the other
      // targets still get their cleanup and the failure is reported per table.
      sqliteTables.push({ table, rowsDeleted: 0, error: messageOf(error) })
    }
  }

  const esIndexes: DemoRebuildCleanup["esIndexes"] = []
  for (const target of inventory.esIndexes) {
    if (!target.exists) continue
    try {
      await clients.es.indices.delete(
        { index: target.index },
        { requestTimeout: REBUILD_REQUEST_TIMEOUT_MS, maxRetries: 0 }
      )
      esIndexes.push({ index: target.index, outcome: "deleted" })
    } catch (error) {
      const status = (error as { meta?: { statusCode?: number } })?.meta?.statusCode
      if (status === 404) {
        esIndexes.push({ index: target.index, outcome: "not_found" })
      } else {
        esIndexes.push({
          index: target.index,
          outcome: "failed",
          error: messageOf(error),
        })
      }
    }
  }

  const neo4jProvenance: DemoRebuildCleanup["neo4jProvenance"] = []
  for (const tenantId of inventory.neo4jProvenanceTenants) {
    try {
      await clients.graph.stripProvenance(tenantId)
      neo4jProvenance.push({ tenantId, outcome: "cleaned" })
    } catch (error) {
      neo4jProvenance.push({ tenantId, outcome: "failed", error: messageOf(error) })
    }
  }

  return { sqliteTables, esIndexes, neo4jProvenance }
}
