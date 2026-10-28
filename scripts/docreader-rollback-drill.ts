import { writeFileSync } from "node:fs"
import { config as loadDotenv } from "dotenv"

loadDotenv({ path: ".env" })

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
}

async function main(): Promise<void> {
  const dbPath = arg("db", ".scratch/weknora-docreader-tickets/evidence/acceptance.db")
  const oldDocId = arg("old-doc")
  const newDocId = arg("new-doc")
  const index = arg("index", process.env.ES_CHUNK_INDEX || "weknora-acceptance")
  const out = arg("out", ".scratch/weknora-docreader-tickets/evidence/rollback.json")
  const esBase = (process.env.ES_NODE || "http://127.0.0.1:9201").replace(/\/$/, "")
  if (!oldDocId || !newDocId) throw new Error("usage: docreader-rollback-drill --old-doc <id> --new-doc <id>")

  const { openDb, closeDb } = await import("../src/ingestion/tracking")
  const { DocumentRepo } = await import("../src/ingestion/tracking/doc_repo")
  const db = openDb(dbPath)
  const repo = new DocumentRepo(db)
  const newDocument = repo.get(newDocId)
  if (!newDocument) throw new Error(`new document not found: ${newDocId}`)
  const sourceId = newDocument.sourceId
  const before = repo.getActive(sourceId)
  const oldDocument = repo.get(oldDocId)
  if (!oldDocument) throw new Error(`old document not found: ${oldDocId}`)

  const updated = db.prepare(
    "UPDATE sources SET active_doc_id = ?, updated_at = ? WHERE source_id = ?"
  ).run(oldDocId, new Date().toISOString(), sourceId)
  if (updated.changes !== 1) throw new Error("active pointer update did not affect one source")
  const after = repo.getActive(sourceId)

  const countOld = await fetch(`${esBase}/${index}/_count`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: { term: { documentId: oldDocId } } }),
  }).then((response) => response.ok ? response.json() as Promise<{ count?: number }> : null).catch(() => null)
  const countNew = await fetch(`${esBase}/${index}/_count`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: { term: { documentId: newDocId } } }),
  }).then((response) => response.ok ? response.json() as Promise<{ count?: number }> : null).catch(() => null)

  const evidence = {
    timestamp: new Date().toISOString(),
    sourceId,
    oldDocId,
    newDocId,
    beforeActiveDocId: before?.id ?? null,
    afterActiveDocId: after?.id ?? null,
    oldStatus: repo.getStatus(oldDocId),
    newStatus: repo.getStatus(newDocId),
    oldChunkCount: countOld?.count ?? null,
    newChunkCount: countNew?.count ?? null,
    rollbackRestoredOldPointer: after?.id === oldDocId,
  }
  const text = JSON.stringify(evidence, null, 2)
  console.log(text)
  writeFileSync(out, `${text}\n`, "utf8")
  closeDb()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
