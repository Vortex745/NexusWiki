/**
 * Ticket 02 (KB-01, spec §2.7 L96 + §9 L292): the approved one-time demo-data
 * rebuild.
 *
 * Usage (same .env as the service):
 *   npm run demo:rebuild              # dry run: list the exact targets
 *   npm run demo:rebuild -- --confirm # delete exactly those targets
 *
 * The user approved a full, unrecoverable rebuild of the local demo data: no
 * backup, no migration. What that approval does NOT cover is workspace files,
 * so this command only ever deletes rows, documents and graph provenance — it
 * never removes a file, drops a table or recreates the database.
 *
 * Order is the safety property: the exact SQLite tables, Elasticsearch indexes
 * and Neo4j provenance owners are listed read-only first, and that listing is
 * what the cleanup consumes. If any layer cannot be inventoried, a confirmed
 * run refuses instead of guessing.
 *
 * Exit codes: 0 ok, 1 a layer failed / the run was refused, 2 invalid usage.
 */

import "dotenv/config"
import neo4j from "neo4j-driver"
import { createElasticsearchClient } from "../src/clients"
import { loadConfig } from "../src/config"
import { closeDb, openDb } from "../src/ingestion/tracking/db"
import {
  createNeo4jDemoRebuildGraph,
  runDemoRebuild,
  type DemoRebuildClients,
  type DemoRebuildInventory,
  type DemoRebuildReport,
} from "../src/knowledge/demo_rebuild"
import { SqliteKnowledgeBaseRepo } from "../src/knowledge/knowledge_base_repo"
import { KnowledgeBaseServiceImpl } from "../src/knowledge/knowledge_base_service"
import { knowledgeBaseEmbeddingProfile } from "../src/types/knowledge_base"

function usage(): void {
  console.log(
    [
      "Usage: npm run demo:rebuild [-- --confirm]",
      "",
      "  (no flags)   dry run — list the exact SQLite tables, Elasticsearch",
      "               indexes and Neo4j provenance owners that would be cleared",
      "  --confirm    clear exactly those targets, then recreate the default",
      "               knowledge base of every tenant that had one",
      "",
      "Data-layer cleanup only: no workspace file, database file or table is",
      "removed. This is the one-time rebuild — it is unrecoverable by design",
      "and the daily demo reset must not reuse it.",
    ].join("\n")
  )
}

function printInventory(inventory: DemoRebuildInventory): void {
  console.log("target inventory (read-only — nothing deleted by this step)")
  console.log(`  SQLite tables: ${inventory.sqliteTables.length}`)
  for (const target of inventory.sqliteTables) {
    const state = target.exists ? `${target.rows} row(s)` : "absent"
    console.log(`    ${target.table}: ${state}`)
  }
  console.log(`  Elasticsearch indexes: ${inventory.esIndexes.length}`)
  for (const target of inventory.esIndexes) {
    const state = target.exists
      ? `${target.documents ?? "unknown"} document(s)`
      : "absent"
    console.log(`    ${target.index}: ${state}`)
  }
  console.log(`  Neo4j provenance owners: ${inventory.neo4jProvenanceTenants.length}`)
  for (const tenantId of inventory.neo4jProvenanceTenants) {
    console.log(`    ${tenantId}`)
  }
  console.log(`  tenants with a knowledge base: ${inventory.knowledgeBaseTenants.length}`)
  for (const tenantId of inventory.knowledgeBaseTenants) {
    console.log(`    ${tenantId}`)
  }
  for (const error of inventory.errors) {
    console.error(`  inventory error [${error.layer}]: ${error.message}`)
  }
}

function printCleanup(report: DemoRebuildReport): boolean {
  const cleanup = report.cleanup
  if (!cleanup) return true
  let failed = false
  for (const table of cleanup.sqliteTables) {
    console.log(
      `  cleared ${table.table}: ${table.rowsDeleted} row(s)${table.error ? ` (${table.error})` : ""}`
    )
    if (table.error) failed = true
  }
  for (const index of cleanup.esIndexes) {
    console.log(`  index ${index.index}: ${index.outcome}${index.error ? ` (${index.error})` : ""}`)
    if (index.outcome === "failed") failed = true
  }
  for (const tenant of cleanup.neo4jProvenance) {
    console.log(
      `  provenance ${tenant.tenantId}: ${tenant.outcome}${tenant.error ? ` (${tenant.error})` : ""}`
    )
    if (tenant.outcome === "failed") failed = true
  }
  return !failed
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  let confirm = false
  for (const arg of args) {
    if (arg === "--confirm") {
      confirm = true
      continue
    }
    if (arg === "--help" || arg === "-h") {
      usage()
      return 0
    }
    console.error(`unknown argument: ${arg}`)
    usage()
    return 2
  }

  const config = loadConfig()
  const db = openDb()
  const es = createElasticsearchClient({
    node: config.esNode,
    ...(config.esApiKey ? { apiKey: config.esApiKey } : {}),
  })
  const graphDriver = neo4j.driver(
    config.neo4jUri,
    neo4j.auth.basic(config.neo4jUser, config.neo4jPassword)
  )
  const clients: DemoRebuildClients = {
    db,
    indexName: config.esChunkIndexName,
    es,
    graph: createNeo4jDemoRebuildGraph(graphDriver),
  }

  try {
    const report = await runDemoRebuild(clients, { confirm })
    printInventory(report.inventory)

    if (!report.executed) {
      if (report.refusedReason) {
        console.error(`refused — nothing was deleted: ${report.refusedReason}`)
        return 1
      }
      if (report.inventory.errors.length > 0) {
        console.error(
          "dry run incomplete — some targets could not be listed; nothing was deleted"
        )
        return 1
      }
      console.log("dry run complete — nothing was deleted")
      console.log("rerun with `-- --confirm` to clear exactly these targets.")
      return 0
    }

    const clean = printCleanup(report)

    // Recreate the deterministic default knowledge base for every tenant that
    // had one, so the rebuilt database is immediately usable (spec §9 L292
    // "保留 API/CLI 的默认库兼容").
    const knowledgeBases = new KnowledgeBaseServiceImpl(
      new SqliteKnowledgeBaseRepo(db),
      knowledgeBaseEmbeddingProfile(config.embeddingModel, config.embeddingDimensions)
    )
    for (const tenantId of report.inventory.knowledgeBaseTenants) {
      const knowledgeBase = knowledgeBases.ensureDefault(tenantId)
      console.log(`  default knowledge base for tenant ${tenantId}: ${knowledgeBase.id}`)
    }

    console.log(
      clean
        ? "rebuild complete — no workspace file, database file or table was removed"
        : "rebuild finished with failures — see the errors above"
    )
    return clean ? 0 : 1
  } finally {
    await graphDriver.close()
    await es.close()
    closeDb()
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    console.error(
      "[demo-rebuild] failed:",
      error instanceof Error ? error.message : String(error)
    )
    process.exitCode = 1
  })
