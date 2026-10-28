import { readFileSync, writeFileSync, rmSync } from "node:fs"
import { config as loadDotenv } from "dotenv"

loadDotenv({ path: ".env" })

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

async function main(): Promise<void> {
  const indexName = process.env.ES_CHUNK_INDEX?.trim() || "weknora-load-20"
  const dbPath = process.env.SQLITE_PATH ||
    ".scratch/weknora-docreader-tickets/evidence/load-20-ingest.db"
  process.env.ES_NODE = process.env.ES_NODE || "http://127.0.0.1:9201"
  process.env.ES_CHUNK_INDEX = indexName
  process.env.SQLITE_PATH = dbPath
  process.env.DOCREADER_TIMEOUT_MS = process.env.DOCREADER_TIMEOUT_MS || "300000"
  rmSync(dbPath, { force: true })
  const esBase = process.env.ES_NODE.replace(/\/$/, "")
  await fetch(`${esBase}/${indexName}`, { method: "DELETE" }).catch(() => undefined)

  const { createIngestionLifecycle } = await import("../src/ingestion/pipeline")
  const { closeDb, openDb } = await import("../src/ingestion/tracking")
  const { DocumentRepo } = await import("../src/ingestion/tracking/doc_repo")
  const db = openDb()
  const workers = [createIngestionLifecycle(db), createIngestionLifecycle(db)]
  const sample = readFileSync("golden/upload-truth/pdf/simple-body.pdf")
  const submitted = Array.from({ length: 20 }, (_, index) => {
    const startedAt = Date.now()
    const submission = workers[index % workers.length].submit({
      title: `Load ${index}`,
      content: "",
      rawContent: sample,
      fileName: `load-${index}.pdf`,
      mimeType: "application/pdf",
      sourceIdentity: {
        kind: "file",
        uriOrExternalId: `acceptance-load:${index}`,
        namespace: "acceptance-load",
      },
      knowledgeBaseId: "kb-acceptance-load",
    })
    return { ...submission, startedAt }
  })

  const completed: Array<{
    docId: string
    success: boolean
    elapsedMs: number
    status: string | null
    error: string | null
  }> = []
  const started = Date.now()
  while (completed.length < submitted.length) {
    const results = await Promise.all(workers.map((worker) => worker.runNext()))
    let claimed = false
    for (const result of results) {
      if (!result) continue
      claimed = true
      const record = submitted.find((entry) => entry.docId === result.docId)
      const status = workers[0].getStatus(result.docId)?.documentStatus ?? null
      completed.push({
        docId: result.docId,
        success: result.success,
        elapsedMs: Date.now() - (record?.startedAt ?? started),
        status,
        error: result.success ? null : result.error ?? null,
      })
    }
    if (!claimed) await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    if (Date.now() - started > 5 * 60_000) break
  }

  const repo = new DocumentRepo(db)
  const active = submitted.filter((submission) => repo.getActive(repo.get(submission.docId)!.sourceId)?.id === submission.docId).length
  const durations = completed.map((entry) => entry.elapsedMs)
  const countResponse = await fetch(`${esBase}/${indexName}/_count`).catch(() => null)
  const count = countResponse?.ok ? await countResponse.json() as { count?: number } : null
  const evidence = {
    timestamp: new Date().toISOString(),
    files: submitted.length,
    workers: workers.length,
    totalElapsedMs: Date.now() - started,
    processed: completed.length,
    successes: completed.filter((entry) => entry.success).length,
    failures: completed.filter((entry) => !entry.success).length,
    activeDocuments: active,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    maxMs: durations.length > 0 ? Math.max(...durations) : null,
    esChunkCount: count?.count ?? null,
    failuresDetail: completed.filter((entry) => !entry.success).slice(0, 5),
  }
  const text = JSON.stringify(evidence, null, 2)
  console.log(text)
  writeFileSync(".scratch/weknora-docreader-tickets/evidence/load-20-ingest.json", `${text}\n`, "utf8")
  await Promise.all(workers.map((worker) => worker.close()))
  closeDb()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
