import { PDFDocument, StandardFonts } from "pdf-lib"
import { loadConfig } from "../config"
import { OcrApiParser } from "../ingestion/parser/ocr_api"
import type { ProbeImplementation } from "./smoke_harness"

/** Live provider probe sends only a synthetic one-page document. */
export const ocrApiProbe: ProbeImplementation = async (ctx) => {
  const started = Date.now()
  const config = loadConfig()
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage().drawText("OCR verification 314159", { x: 60, y: 700, size: 24, font })
  const parser = new OcrApiParser({
    accessKeyId: config.ocrAccessKeyId ?? "",
    secretAccessKey: config.ocrSecretAccessKey ?? "",
    sessionToken: config.ocrSessionToken,
    timeoutMs: Math.min(config.parserTimeoutMs ?? 120_000, 60_000),
    inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
    outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
  })
  const blocks = await parser.parse({
    content: Buffer.from(await pdf.save()), fileName: "ocr-verification.pdf",
    documentId: "synthetic-ocr-probe", signal: ctx.signal,
  })
  const ok = blocks.some((block) => block.text.includes("314159")) && blocks.every((block) => block.page === 1 && block.provenance.parser === "ocr-api")
  return {
    ok, reason: ok ? undefined : "synthetic OCR marker or page provenance is missing",
    outputs: { pages: 1, blocks: blocks.length, parser: "ocr-api" },
    durationMs: Date.now() - started,
  }
}
