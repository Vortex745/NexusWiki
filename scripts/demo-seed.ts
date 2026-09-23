/**
 * Ticket 42 (DEMO-01A) — seed the deterministic demo namespace.
 *
 * Usage (same .env as the service):
 *   npm run demo:seed
 *
 * Seeds the fixed demo tenant: two knowledge bases with fixed ids, the
 * deterministic project + fictional-policy documents (through the NORMAL
 * ingestion lifecycle), and deterministic FAQ/memory rows. Idempotent: a
 * re-seed over unchanged content creates nothing (documents come back
 * "unchanged", existing FAQ/memory rows are skipped).
 *
 * Exit codes: 0 ok, 1 the seed failed, 2 invalid usage.
 */

import "dotenv/config"
import { openDb, closeDb } from "../src/ingestion/tracking/db"
import { createIngestionLifecycle } from "../src/ingestion/pipeline"
import { seedDemoNamespace } from "../src/knowledge/demo_seed"
import { knowledgeBaseEmbeddingProfile } from "../src/types/knowledge_base"
import { loadConfig } from "../src/config"

function usage(): void {
  console.log("Usage: npm run demo:seed  (no flags)")
}

async function main(): Promise<number> {
  for (const arg of process.argv.slice(2)) {
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
  const lifecycle = createIngestionLifecycle(db, { activationMode: "auto" })

  try {
    const report = await seedDemoNamespace({
      db,
      lifecycle,
      embeddingProfile: knowledgeBaseEmbeddingProfile(
        config.embeddingModel,
        config.embeddingDimensions
      ),
    })
    console.log(`seeded demo namespace (tenant ${report.tenantId})`)
    for (const base of report.knowledgeBases) {
      console.log(`  knowledge base ${base.id}: ${base.created ? "created" : "already present"}`)
    }
    for (const doc of report.documents) {
      console.log(
        `  document ${doc.slug}: ${doc.outcome} (sha256 ${doc.contentDigest.slice(0, 12)}...)`
      )
    }
    for (const faq of report.faqEntries) {
      console.log(
        `  faq ${faq.id.slice(0, 8)}... "${faq.question}": ${faq.created ? "created" : "already present"}`
      )
    }
    for (const memory of report.memories) {
      console.log(
        `  memory ${memory.subjectId}: ${memory.created ? "created" : "already present"} (sha256 ${memory.contentDigest.slice(0, 12)}...)`
      )
    }
    console.log("seed complete — repeated runs are no-ops while content is unchanged")
    return 0
  } catch (error) {
    console.error(
      "[demo-seed] failed:",
      error instanceof Error ? error.message : String(error)
    )
    return 1
  } finally {
    await lifecycle.close()
    closeDb()
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    console.error(
      "[demo-seed] failed:",
      error instanceof Error ? error.message : String(error)
    )
    process.exitCode = 1
  })
