/**
 * Eval refactor Ticket 14 — scoped residue sweep for a hard-killed evaluation.
 *
 * Usage (same .env as the service):
 *   npm run eval:residue                            # dry run: list residue
 *   npm run eval:residue -- --delete                # delete the listed residue
 *   npm run eval:residue -- --delete --scope eval-<id>
 *
 * What this cannot do, by design: it cannot list or restore evaluation tasks.
 * Task records live only in the memory of the process that ran them, so after a
 * kill they are gone — this tool only releases what a crash left in the shared
 * cluster: dedicated `kefu-rag-chunks-eval-*` indices and eval-owned graph
 * provenance. Business data is out of reach: the business index cannot match
 * the eval prefix, and a relation the business tenant also owns keeps its
 * provenance entries.
 *
 * Exit codes: 0 ok, 1 a step failed / a scope was refused, 2 invalid usage.
 */

import "dotenv/config"
import neo4j from "neo4j-driver"
import { createElasticsearchClient } from "../src/clients"
import { loadConfig } from "../src/config"
import {
  listEvalResidue,
  sweepEvalResidue,
  type EvalResidueClients,
  type EvalResidueSweepReport,
} from "../src/evaluation/residue"

function usage(): void {
  console.log(
    [
      "Usage: npm run eval:residue [-- --delete] [-- --scope <eval-scope-id>]",
      "",
      "  (no flags)   dry run — list the residue a hard kill left behind",
      "  --delete     delete the listed residue (eval indices + eval provenance)",
      "  --scope id   limit the sweep to one scope id (repeatable, still validated)",
      "",
      "Evaluation task records are memory-only: they cannot be listed or restored",
      "after a kill. This tool only releases eval-owned resources.",
    ].join("\n")
  )
}

function formatReport(report: EvalResidueSweepReport): string {
  const es = `index=${report.esIndex}${report.esError ? ` (${report.esError})` : ""}`
  const graph = `provenance=${report.graphProvenance}${
    report.graphError ? ` (${report.graphError})` : ""
  }`
  return `  ${report.scopeId}: ${es} · ${graph}`
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  let shouldDelete = false
  const scopeIds: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--delete") {
      shouldDelete = true
      continue
    }
    if (arg === "--scope") {
      const value = args[index + 1]
      if (!value) {
        console.error("--scope needs a scope id, e.g. --scope eval-3f6c1d9a4b7e4c2f8a1d5b6e0c3f7a92")
        return 2
      }
      scopeIds.push(value)
      index += 1
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
  const es = createElasticsearchClient({
    node: config.esNode,
    ...(config.esApiKey ? { apiKey: config.esApiKey } : {}),
  })
  const graphDriver = neo4j.driver(
    config.neo4jUri,
    neo4j.auth.basic(config.neo4jUser, config.neo4jPassword)
  )
  const clients: EvalResidueClients = { es, graphDriver }

  try {
    if (!shouldDelete) {
      const listing = await listEvalResidue(clients)
      console.log("eval residue check (dry run — nothing was deleted)")
      console.log(`  dedicated indices: ${listing.esIndices.length}`)
      for (const index of listing.esIndices) console.log(`    ${index}`)
      console.log(`  scopes owning graph provenance: ${listing.scopeIds.length}`)
      for (const scopeId of listing.scopeIds) console.log(`    ${scopeId}`)
      console.log(
        "  task records are memory-only and cannot be listed or restored after a kill;"
      )
      console.log(
        "  only eval-owned resources (kefu-rag-chunks-eval-*, eval-* provenance) are in scope."
      )
      console.log("  rerun with `-- --delete` to release them.")
      return 0
    }

    const { scopes } = await sweepEvalResidue(
      clients,
      scopeIds.length > 0 ? { scopeIds } : {}
    )
    if (scopes.length === 0) {
      console.log("no eval residue found — nothing to delete")
      return 0
    }
    let failed = false
    for (const report of scopes) {
      console.log(formatReport(report))
      const bad =
        report.esIndex === "failed" ||
        report.esIndex === "refused" ||
        report.graphProvenance === "failed" ||
        report.graphProvenance === "refused"
      if (bad) failed = true
    }
    console.log(
      failed
        ? "some residue was NOT released — see the errors above"
        : `released ${scopes.length} scope(s); business data was never in scope`
    )
    return failed ? 1 : 0
  } finally {
    await graphDriver.close()
    await es.close()
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    console.error(
      "[eval-residue] failed:",
      error instanceof Error ? error.message : String(error)
    )
    process.exitCode = 1
  })
