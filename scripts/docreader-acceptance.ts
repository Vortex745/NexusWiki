import { readFileSync, writeFileSync } from "node:fs"
import { basename, resolve } from "node:path"
import { config as loadDotenv } from "dotenv"
import { DocReaderClient } from "../src/ingestion/parser/docreader_client"
import { DocReaderPdfParser } from "../src/ingestion/parser/docreader_pdf"
import { OcrApiParser } from "../src/ingestion/parser/ocr_api"
import { parseDocReaderEnvelope } from "../src/ingestion/parser/docreader_pdf_normalize"

loadDotenv({ path: resolve(".env") })

interface Args {
  sample: string
  force: boolean
  repeat: number
  timeoutMs: number
  out: string | null
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    sample: "",
    force: false,
    repeat: 1,
    timeoutMs: Number(process.env.DOCREADER_TIMEOUT_MS) || 300_000,
    out: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--sample") args.sample = argv[++index] ?? ""
    else if (arg === "--force") args.force = true
    else if (arg === "--repeat") args.repeat = Math.max(1, Number(argv[++index]) || 1)
    else if (arg === "--timeout") args.timeoutMs = Math.max(1, Number(argv[++index]) || 300_000)
    else if (arg === "--out") args.out = argv[++index] ?? null
  }
  if (!args.sample) throw new Error("usage: docreader-acceptance --sample <pdf> [--force] [--repeat N] [--out file]")
  return args
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)]
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const sample = readFileSync(args.sample)
  const address = process.env.DOCREADER_ADDR?.trim() || "127.0.0.1:50051"
  const ocr = new OcrApiParser({
    accessKeyId: process.env.VOLC_ACCESSKEY?.trim() || "",
    secretAccessKey: process.env.VOLC_SECRETKEY?.trim() || "",
    sessionToken: process.env.VOLC_SESSION_TOKEN?.trim(),
    timeoutMs: 120_000,
    inputLimitBytes: 20 * 1024 * 1024,
    outputLimitBytes: 20 * 1024 * 1024,
  })
  let ocrCalls = 0
  const parser = new DocReaderPdfParser({
    address,
    timeoutMs: args.timeoutMs,
    inputLimitBytes: 20 * 1024 * 1024,
    outputLimitBytes: 20 * 1024 * 1024,
    forceScanned: args.force,
    clientFactory: () => new DocReaderClient({ address, timeoutMs: args.timeoutMs }),
    ocrPage: (input) => {
      ocrCalls += 1
      return ocr.readImagePage(input)
    },
  })

  const durations: number[] = []
  let last: Record<string, unknown> | null = null
  for (let attempt = 0; attempt < args.repeat; attempt += 1) {
    ocrCalls = 0
    const started = Date.now()
    const raw = await parser.parseRaw({
      content: sample,
      fileName: basename(args.sample),
      mimeType: "application/pdf",
    })
    const blocks = parser.normalizeRaw(raw, `acceptance-${attempt}`)
    durations.push(Date.now() - started)
    const envelope = parseDocReaderEnvelope(raw)
    const pages = [...new Set(blocks.map((block) => block.page).filter((page): page is number => typeof page === "number"))]
    const declaredPageCount = Number(envelope.metadata.page_count)
    last = {
      sample: resolve(args.sample),
      forceScanned: args.force,
      bytes: sample.length,
      elapsedMs: durations.at(-1),
      pageCount: Number.isInteger(declaredPageCount) && declaredPageCount > 0
        ? declaredPageCount
        : pages.length > 0 ? Math.max(...pages) : 0,
      ocrCalls,
      imageCount: envelope.imageCount,
      sourceBlockCount: envelope.sourceBlocks.length,
      blockCount: blocks.length,
      blockTypes: [...new Set(blocks.map((block) => block.type))],
      pagesWithBlocks: pages,
      tableCount: blocks.filter((block) => block.type === "table").length,
      textChars: blocks.reduce((sum, block) => sum + block.text.length, 0),
      warnings: envelope.warnings,
      envelopeBytes: Buffer.byteLength(raw, "utf8"),
      firstText: blocks.find((block) => block.text.trim())?.text.slice(0, 120) ?? null,
      lastText: [...blocks].reverse().find((block) => block.text.trim())?.text.slice(0, 120) ?? null,
    }
  }

  const result = {
    ...last,
    repeats: args.repeat,
    durationsMs: durations,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    timestamp: new Date().toISOString(),
  }
  const text = JSON.stringify(result, null, 2)
  console.log(text)
  if (args.out) writeFileSync(args.out, `${text}\n`, "utf8")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
