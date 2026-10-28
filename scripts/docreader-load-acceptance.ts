import { readFileSync, writeFileSync } from "node:fs"
import { config as loadDotenv } from "dotenv"

loadDotenv({ path: ".env" })

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

async function main(): Promise<void> {
  const sample = readFileSync("golden/upload-truth/pdf/simple-body.pdf")
  const address = process.env.DOCREADER_ADDR?.trim() || "127.0.0.1:50051"
  const { DocReaderClient } = await import("../src/ingestion/parser/docreader_client")
  const { DocReaderPdfParser } = await import("../src/ingestion/parser/docreader_pdf")
  const parser = new DocReaderPdfParser({
    address,
    timeoutMs: 300_000,
    inputLimitBytes: 20 * 1024 * 1024,
    outputLimitBytes: 20 * 1024 * 1024,
    clientFactory: () => new DocReaderClient({ address, timeoutMs: 300_000 }),
  })
  const started = Date.now()
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, async (_, index) => {
      const itemStarted = Date.now()
      const raw = await parser.parseRaw({
        content: sample,
        fileName: `load-${index}.pdf`,
        mimeType: "application/pdf",
      })
      const blocks = parser.normalizeRaw(raw, `load-${index}`)
      return { elapsedMs: Date.now() - itemStarted, blocks: blocks.length }
    })
  )
  const durations = results
    .filter((result): result is PromiseFulfilledResult<{ elapsedMs: number; blocks: number }> =>
      result.status === "fulfilled")
    .map((result) => result.value.elapsedMs)
  const failures = results.filter((result) => result.status === "rejected").length
  const evidence = {
    timestamp: new Date().toISOString(),
    files: 20,
    concurrency: 20,
    totalElapsedMs: Date.now() - started,
    successes: durations.length,
    failures,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    maxMs: durations.length > 0 ? Math.max(...durations) : null,
    allSucceeded: failures === 0,
  }
  const text = JSON.stringify(evidence, null, 2)
  console.log(text)
  writeFileSync(".scratch/weknora-docreader-tickets/evidence/load-20.json", `${text}\n`, "utf8")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
