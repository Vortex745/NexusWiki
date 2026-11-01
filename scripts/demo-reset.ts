/**
 * Ticket 42 (DEMO-01A) — reset the FIXED demo namespace.
 *
 * Usage (same .env as the service):
 *   npm run demo:reset              # preview: list exactly what would be cleared
 *   npm run demo:reset -- --confirm # clear exactly the demo namespace, then re-seed
 *
 * The reset touches ONLY the demo tenant: its SQLite rows (directly or
 * joined through documents/entries/assistants/runs/sessions), its chunk
 * documents in the shared Elasticsearch index (a tenant-scoped
 * delete_by_query — never an index deletion) and its Neo4j provenance.
 * Other tenants, workspace files and the schema are untouched. After a
 * confirmed reset the deterministic seed runs, so the namespace comes back
 * reproducible.
 *
 * Exit codes: 0 ok, 1 a layer failed / the run was refused, 2 invalid usage.
 */

import "dotenv/config"
import neo4j from "neo4j-driver"
import { createElasticsearchClient } from "../src/clients"
import { loadConfig } from "../src/config"
import { openDb, closeDb } from "../src/ingestion/tracking/db"
import { createIngestionLifecycle } from "../src/ingestion/pipeline"
import { createNeo4jDemoRebuildGraph } from "../src/knowledge/demo_rebuild"
import {
  resetDemoNamespace,
  type DemoNamespaceClients,
  type DemoNamespaceReport,
} from "../src/knowledge/demo_namespace"
import { seedDemoNamespace, DEMO_NAMESPACE_TENANT } from "../src/knowledge/demo_seed"
import { knowledgeBaseEmbeddingProfile } from "../src/types/knowledge_base"

function usage(): void {
  console.log(
    [
      "Usage: npm run demo:reset [-- --confirm]",
      "",
      "  (no flags)   preview — list exactly what the demo namespace owns",
      "  --confirm    clear exactly the demo namespace, then re-seed it",
      "",
      "Only the fixed demo namespace is touched: no other tenant, no",
      "workspace file, no database file, no table. Elasticsearch is cleaned",
      "with a tenant-scoped delete_by_query, never an index deletion.",
    ].join("\n")
  )
}

function printInventory(report: DemoNamespaceReport): void {
  const inventory = report.inventory
  console.log(
    `demo namespace inventory (tenant ${inventory.tenantId}, read-only — nothing deleted by this step)`
  )
  console.log(`  SQLite rows owned by the namespace:`)
  for (const target of inventory.sqliteTables) {
    if (target.rows > 0) console.log(`    ${target.table}: ${target.rows} row(s)`)
  }
  const empty = inventory.sqliteTables.filter((target) => target.rows === 0).length
  console.log(`    (${empty} further tracked table(s) with 0 rows)`)
  console.log(
    `  Elasticsearch ${inventory.esIndex.index}: ${inventory.esIndex.documents ?? "unknown"} document(s) for this tenant`
  )
  console.log(`  Neo4j provenance owned: ${inventory.neo4jProvenanceOwned ? "yes" : "no"}`)
  for (const error of inventory.errors) {
    console.error(`  inventory error [${error.layer}]: ${error.message}`)
  }
}

function printCleanup(report: DemoNamespaceReport): boolean {
  const cleanup = report.cleanup
  if (!cleanup) return true
  let failed = false
  for (const table of cleanup.sqliteTables) {
    if (table.rowsDeleted === 0 && !table.error) continue
    console.log(
      `  cleared ${table.table}: ${table.rowsDeleted} row(s)${table.error ? ` (${table.error})` : ""}`
    )
    if (table.error) failed = true
  }
  console.log(
    `  Elasticsearch ${cleanup.esIndex.index}: deleted ${cleanup.esIndex.deleted} document(s)${cleanup.esIndex.error ? ` (${cleanup.esIndex.error})` : ""}`
  )
  if (cleanup.esIndex.error) failed = true
  console.log(
    `  Neo4j provenance ${cleanup.neo4jProvenance.tenantId}: ${cleanup.neo4jProvenance.outcome}${cleanup.neo4jProvenance.error ? ` (${cleanup.neo4jProvenance.error})` : ""}`
  )
  if (cleanup.neo4jProvenance.outcome === "failed") failed = true
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
  const clients: DemoNamespaceClients = {
    db,
    indexName: config.esChunkIndexName,
    // The real client's top-level `exists` is the DOCUMENT exists API — the
    // namespace reset needs the INDEX exists (`indices.exists`).
    es: {
      exists: (request, meta) => es.indices.exists(request, meta),
      count: (request, meta) => es.count(request, meta),
      deleteByQuery: (request, meta) => es.deleteByQuery(request, meta),
    },
    // The SAME graph adapter the one-time rebuild uses — one strip rule
    // implementation, no drift.
    graph: createNeo4jDemoRebuildGraph(graphDriver),
  }

  try {
    const report = await resetDemoNamespace(clients, DEMO_NAMESPACE_TENANT, { confirm })
    printInventory(report)

    if (!report.executed) {
      if (report.refusedReason) {
        console.error(`refused — nothing was deleted: ${report.refusedReason}`)
        return 1
      }
      if (report.inventory.errors.length > 0) {
        console.error(
          "preview incomplete — some targets could not be listed; nothing was deleted"
        )
        return 1
      }
      console.log("preview complete — nothing was deleted")
      console.log("rerun with `-- --confirm` to clear exactly this namespace and re-seed it.")
      return 0
    }

    const clean = printCleanup(report)

    // Re-seed the deterministic demo data so the namespace comes back
    // reproducible after the confirmed reset. A cleanup that FAILED must not
    // be papered over with a fresh seed — old chunks could survive next to
    // the new documents.
    if (!clean) {
      console.error("cleanup had failures — skipping the re-seed; inspect and rerun.")
      return 1
    }
    const lifecycle = createIngestionLifecycle(db, { activationMode: "auto" })
    try {
      const seedReport = await seedDemoNamespace({
        db,
        lifecycle,
        embeddingProfile: knowledgeBaseEmbeddingProfile(
          config.embeddingModel,
          config.embeddingDimensions
        ),
      })
      console.log(
        `re-seeded ${seedReport.documents.filter((doc) => doc.outcome === "submitted").length} document(s), ${seedReport.knowledgeBases.length} knowledge base(s)`
      )
    } finally {
      await lifecycle.close()
    }
    console.log("reset complete — only the demo namespace was touched")
    return 0
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
      "[demo-reset] failed:",
      error instanceof Error ? error.message : String(error)
    )
    process.exitCode = 1
  })
