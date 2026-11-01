import "dotenv/config"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { Client } from "@elastic/elasticsearch"
import { loadConfig } from "../src/config"
import { migrateChunkIndex, safeMigrationDiagnostic, ChunkIndexMigrationError } from "../src/ingestion/storage/chunk_index_migration"

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const allowed = new Set(["--source", "--target", "--report", "--apply"])
  const values = new Map<string, string>()
  let apply = false
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (!allowed.has(flag) || values.has(flag) || (flag === "--apply" && apply)) throw new ChunkIndexMigrationError("Invalid or duplicate migration argument")
    if (flag === "--apply") { apply = true; continue }
    const value = args[++i]
    if (!value || value.startsWith("--")) throw new ChunkIndexMigrationError("Missing migration argument value")
    values.set(flag, value)
  }
  const source = values.get("--source")
  const target = values.get("--target")
  const reportPath = values.get("--report")
  if (!source || !target || !reportPath) throw new ChunkIndexMigrationError("Required: --source NAME --target NAME --report PATH [--apply]")
  const config = loadConfig()
  const client = new Client({ node: config.esNode, ...(config.esApiKey ? { auth: { apiKey: config.esApiKey } } : {}) })
  mkdirSync(dirname(resolve(reportPath)), { recursive: true })
  try {
    const report = await migrateChunkIndex(client, {
      source, target, apply, node: config.esNode, embeddingDimensions: config.embeddingDimensions,
    })
    writeFileSync(reportPath, JSON.stringify({ ...report, timestamp: new Date().toISOString() }, null, 2))
    console.log(JSON.stringify(report))
  } catch (error) {
    // Diagnostics omit credentials, request headers and document source.
    const message = safeMigrationDiagnostic(error)
    writeFileSync(reportPath, JSON.stringify({ phase: "failed", source, target, message, timestamp: new Date().toISOString() }, null, 2))
    throw new ChunkIndexMigrationError(message)
  } finally {
    await client.close()
  }
}

void main().catch(error => { console.error(safeMigrationDiagnostic(error)); process.exitCode = 1 })
