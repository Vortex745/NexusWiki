import "dotenv/config"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { loadConfig } from "../src/config"
import { openDb } from "../src/ingestion/tracking/db"
import { IngestionLifecycle } from "../src/ingestion/lifecycle"
import { PipelineStageRunner } from "../src/ingestion/pipeline"
import { createProductionPdfQualityGate } from "../src/ingestion/page_evidence/production_gate"
import { DocumentRepo } from "../src/ingestion/tracking/doc_repo"
import type { DualStageEvidenceEnvelope } from "../src/ingestion/page_evidence/dual_stage_envelope"
import type { IngestionStoreImpl } from "../src/ingestion/storage"

const output = process.argv[2]
if (!output) throw new Error("Usage: node --import tsx scripts/pdf-quality-live-eval.ts OUTPUT.json [FIXTURE] [ROUNDS]")
const root = resolve(__dirname, "..")
const fixtureNames = [
  "pure-text", "text-long-6p", "garbled", "table-grid", "two-column", "footnote", "formula-inline",
  "image-cover", "mixed-text-scan", "partially-rasterized", "scanned-textless", "blank-page",
  "holdout-image-digits", "holdout-small-raster", "holdout-decoration", "holdout-complete-mixed",
]
const selected = process.argv[3] ? [process.argv[3]] : fixtureNames
if (selected.some(name => !fixtureNames.includes(name))) throw new Error("Unknown fixture")
const rounds = Number(process.argv[4] ?? 3)
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 3) throw new Error("ROUNDS must be 1..3")
const config = { ...loadConfig(), decisionRequestTimeoutMs: 60_000 }
if (!config.cloudflareAccountId || !config.cloudflareApiToken || !config.ocrAccessKeyId || !config.ocrSecretAccessKey) {
  throw new Error("Existing Clef and OCR credentials required")
}
const outcomes: unknown[] = []
const calls: { provider: string; status?: number; durationMs: number; error?: string }[] = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
  const url = new URL(typeof args[0] === "string" ? args[0] : args[0] instanceof URL ? args[0].href : args[0].url)
  const provider = url.hostname.endsWith("cloudflare.com") ? "clef" : url.hostname.includes("volcengine") ? "ocr" : "other"
  const start = performance.now()
  let status: number | undefined
  let error: string | undefined
  try {
    const response = await originalFetch(...args)
    status = response.status
    if (!response.ok) {
      let text = (await response.clone().text()).slice(0, 2000)
      for (const secret of [config.cloudflareApiToken, config.cloudflareAccountId, config.ocrAccessKeyId, config.ocrSecretAccessKey, config.ocrSessionToken]) {
        if (secret) text = text.split(secret).join("<redacted>")
      }
      error = text
    }
    return response
  }
  finally { calls.push({ provider, status, error, durationMs: Math.round(performance.now() - start) }) }
}
mkdirSync(dirname(resolve(output)), { recursive: true })
const checkpoint = () => writeFileSync(output, JSON.stringify({
  observedAt: new Date().toISOString(), rounds, outcomes, calls,
  note: "Real production PDF/Clef/OCR pipeline; in-memory database and counted persistence seam; no business index writes. Labels and fixture names never enter provider state.",
}, null, 2))

async function run(fixture: string, round: number): Promise<void> {
  const db = openDb(":memory:")
  const downstream = { chunks: 0, entities: 0, wikilinks: 0 }
  const store = {
    async storeChunks(chunks: unknown[]) { downstream.chunks += chunks.length; return { chunkCount: chunks.length } },
    async storeEntities(entities: unknown[]) { downstream.entities += entities.length },
    async storeWikilinks(links: unknown[]) { downstream.wikilinks += links.length },
    async close() {}, chunkIndexName: "isolated-pdf-quality-eval",
  } as unknown as IngestionStoreImpl
  const gate = createProductionPdfQualityGate(db, config)
  const docs = new DocumentRepo(db)
  const runner = new PipelineStageRunner(db, undefined, store, undefined, { qualityGate: gate, pdfOcrFallbackEnabled: true })
  const lifecycle = new IngestionLifecycle(db, runner)
  const path = fixture.startsWith("holdout-") ? resolve(root, "golden/pdf-quality-holdout", `${fixture}.pdf`)
    : resolve(root, "golden/pdf-quality-corpus/pdfs", `${fixture}.pdf`)
  const started = performance.now()
  try {
    const submitted = lifecycle.submit({ title: "evaluation.pdf", content: "", rawContent: readFileSync(path),
      fileName: "evaluation.pdf", mimeType: "application/pdf", source: "evaluation.pdf" })
    await lifecycle.runNext()
    const status = lifecycle.getStatus(submitted.docId)
    const evidence = docs.getCandidateEvidence(submitted.docId) as {
      pdfQualityAudit?: { envelope?: DualStageEvidenceEnvelope }; pdfQualityDiagnostic?: unknown
    } | null
    const envelope = evidence?.pdfQualityAudit?.envelope
    const stages = ["local_extraction", "ocr_candidate"].flatMap(stage => {
      const record = envelope?.stages[stage as keyof DualStageEvidenceEnvelope["stages"]]
      if (!record?.audits.length) return []
      const audit = record.audits.at(-1)!
      return [{ state: record.state, ...audit }]
    })
    outcomes.push({ fixture, round, documentStatus: status?.documentStatus, failureReasonCode: status?.failure?.reasonCode,
      failureMessage: status?.failure?.message?.slice(0, 400), stages, diagnostic: evidence?.pdfQualityDiagnostic,
      downstream, durationMs: Math.round(performance.now() - started) })
    console.log(JSON.stringify({ fixture, round, status: status?.documentStatus, stages: stages.length, durationMs: Math.round(performance.now() - started) }))
  } catch (error) {
    outcomes.push({ fixture, round, documentStatus: "crashed", error: error instanceof Error ? error.message.slice(0, 400) : "unknown",
      downstream, durationMs: Math.round(performance.now() - started) })
    console.log(JSON.stringify({ fixture, round, status: "crashed" }))
  } finally { db.close(); checkpoint() }
}

async function main(): Promise<void> {
  try {
    for (let round = 1; round <= rounds; round++) {
      // Two independent in-memory pipelines, bounded provider concurrency.
      for (let i = 0; i < selected.length; i += 2) await Promise.all(selected.slice(i, i + 2).map(name => run(name, round)))
    }
  } finally { globalThis.fetch = originalFetch; checkpoint() }
}
void main().catch(error => { console.error(error.message); process.exitCode = 1 })
