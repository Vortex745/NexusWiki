import { readFileSync, writeFileSync } from "node:fs"
import { basename, resolve } from "node:path"
import { config as loadDotenv } from "dotenv"

loadDotenv({ path: resolve(".env") })

interface Args {
  sample: string
  force: boolean
  reprocess: boolean
  failDocreader: boolean
  drainRetries: boolean
  out: string | null
  source: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    sample: "",
    force: false,
    reprocess: false,
    failDocreader: false,
    drainRetries: false,
    out: null,
    source: `acceptance-${Date.now()}`,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--sample") args.sample = argv[++index] ?? ""
    else if (arg === "--force") args.force = true
    else if (arg === "--reprocess") args.reprocess = true
    else if (arg === "--fail-docreader") args.failDocreader = true
    else if (arg === "--drain-retries") args.drainRetries = true
    else if (arg === "--out") args.out = argv[++index] ?? null
    else if (arg === "--source") args.source = argv[++index] ?? args.source
  }
  if (!args.sample) throw new Error("usage: docreader-ingest-acceptance --sample <pdf> [--force] [--reprocess]")
  return args
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const indexName = process.env.ES_CHUNK_INDEX?.trim() || "weknora-acceptance"
  process.env.ES_NODE = process.env.ES_NODE || "http://127.0.0.1:9201"
  process.env.ES_CHUNK_INDEX = indexName
  process.env.SQLITE_PATH = process.env.SQLITE_PATH ||
    resolve(".scratch/weknora-docreader-tickets/evidence/acceptance.db")
  if (args.failDocreader) process.env.DOCREADER_ADDR = "127.0.0.1:59999"
  process.env.DOCREADER_TIMEOUT_MS = process.env.DOCREADER_TIMEOUT_MS || "300000"

  const esBase = process.env.ES_NODE.replace(/\/$/, "")
  await fetch(`${esBase}/${indexName}`, { method: "DELETE" }).catch(() => undefined)

  const { createIngestionLifecycle } = await import("../src/ingestion/pipeline")
  const { closeDb, openDb } = await import("../src/ingestion/tracking")
  const { DocumentRepo } = await import("../src/ingestion/tracking/doc_repo")

  const db = openDb()
  const lifecycle = createIngestionLifecycle(db)
  const sample = readFileSync(args.sample)
  const started = Date.now()
  const submitted = lifecycle.submit({
    title: basename(args.sample),
    content: "",
    rawContent: sample,
    fileName: basename(args.sample),
    mimeType: "application/pdf",
    parserOverride: args.force ? "ocr-api" : undefined,
    sourceIdentity: {
      kind: "file",
      uriOrExternalId: `acceptance:${args.source}`,
      namespace: "acceptance",
    },
    knowledgeBaseId: "kb-acceptance",
  })
  let run = await lifecycle.runNext()
  if (args.drainRetries) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = lifecycle.getStatus(submitted.docId)
      const task = current?.task
      if (!task || task.status === "failed" || task.status === "cancelled" || task.status === "completed") break
      const waitMs = task.nextAttemptAt
        ? Math.max(0, Date.parse(task.nextAttemptAt) - Date.now()) + 250
        : 0
      await new Promise((resolveWait) => setTimeout(resolveWait, waitMs))
      run = await lifecycle.runNext()
    }
  }
  const elapsedMs = Date.now() - started
  const status = lifecycle.getStatus(submitted.docId)
  const repo = new DocumentRepo(db)
  const document = repo.get(submitted.docId)
  const active = document ? repo.getActive(document.sourceId) : null

  let reprocess: Record<string, unknown> | null = null
  if (args.reprocess && run?.success) {
    const reprocessed = lifecycle.reprocess(submitted.docId)
    const secondRun = reprocessed ? await lifecycle.runNext() : null
    const secondStatus = reprocessed ? lifecycle.getStatus(reprocessed.docId) : null
    const secondDocument = reprocessed ? repo.get(reprocessed.docId) : null
    reprocess = {
      newDocId: reprocessed?.docId ?? null,
      success: secondRun?.success ?? false,
      status: secondStatus?.documentStatus ?? null,
      active: secondStatus?.documentVersion.active ?? false,
      originalActive: status?.documentVersion.active ?? false,
      activeDocId: secondDocument ? repo.getActive(secondDocument.sourceId)?.id ?? null : null,
    }
  }

  const countResponse = await fetch(`${esBase}/${indexName}/_count`).catch(() => null)
  const count = countResponse?.ok ? await countResponse.json() as { count?: number } : null

  const evidence = {
    timestamp: new Date().toISOString(),
    sample: resolve(args.sample),
    bytes: sample.length,
    forceScanned: args.force,
    failDocreader: args.failDocreader,
    elapsedMs,
    success: run?.success ?? false,
    error: run && "error" in run ? run.error ?? null : null,
    docId: submitted.docId,
    documentStatus: status?.documentStatus ?? null,
    activeVersion: status?.documentVersion ?? null,
    activeDocId: active?.id ?? null,
    processingPolicy: status?.processingPolicy ?? null,
    candidateState: status?.candidateState ?? null,
    activationBlockReason: status?.activationBlockReason ?? null,
    failure: status?.failure ?? null,
    chunkCount: repo.getStatus(submitted.docId) === "completed" ? count?.count ?? null : null,
    esIndex: indexName,
    reprocess,
  }
  const text = JSON.stringify(evidence, null, 2)
  console.log(text)
  if (args.out) writeFileSync(args.out, `${text}\n`, "utf8")
  await lifecycle.close()
  closeDb()
  if (!run?.success) process.exitCode = args.failDocreader ? 0 : 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
