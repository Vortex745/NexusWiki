// Test support for ticket 05 (PDF page evidence and candidate identity).
//
// Everything here exists so the unit tests never need the real PDF rasterizer:
// `solidPng` emits a genuinely decodable PNG (so digest/size/dimension checks
// run against real bytes), `fakePagePreviewRenderer` stands in at the renderer
// seam, and `textlessScanPdfBytes` builds a real textless PDF with pdf-lib.
// None of it is production wiring.
import { createHash } from "node:crypto"
import { deflateSync } from "node:zlib"
import { PDFDocument } from "pdf-lib"
import type { RenderedPagePreview, PagePreviewRenderer } from "./preview_renderer"
import type { PdfPageTextRecord } from "./page_evidence"

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

let crcTable: number[] | undefined
function crc32(bytes: Buffer): number {
  if (!crcTable) {
    crcTable = []
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length, 0)
  header.write(type, 4, "ascii")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0)
  return Buffer.concat([header, data, crc])
}

/**
 * A real 8-bit RGB PNG whose pixels are derived from `seed`, so two different
 * seeds always produce two different byte sequences (and therefore two
 * different digests). Page pairing is observable because of this.
 */
export function solidPng(seed: number, width = 64, height = 88): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 0 // filter: none
    for (let x = 0; x < stride; x += 1) {
      raw[rowStart + 1 + x] = (seed * 7 + x * 3 + y * 5) % 251
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/**
 * A PNG with a declared IHDR size and an optional filler chunk, for exercising
 * the byte and pixel ceilings without allocating a real 16-megapixel raster.
 */
export function pngStub(options: {
  width?: number
  height?: number
  fillerBytes?: number
  seed?: number
} = {}): Buffer {
  const width = options.width ?? 64
  const height = options.height ?? 88
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const chunks: Buffer[] = [PNG_SIGNATURE, chunk("IHDR", ihdr)]
  if (options.fillerBytes) {
    const filler = Buffer.alloc(options.fillerBytes)
    for (let offset = 0; offset < filler.length; offset += 512) {
      filler[offset] = ((options.seed ?? 1) + offset) % 251
    }
    chunks.push(chunk("prIv", filler))
  }
  chunks.push(chunk("IDAT", deflateSync(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]))))
  chunks.push(chunk("IEND", Buffer.alloc(0)))
  return Buffer.concat(chunks)
}

export function pngBase64(seed: number, width?: number, height?: number): string {
  return solidPng(seed, width, height).toString("base64")
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * The seam fake: distinct PNG bytes per page, correct declared dimensions, and
 * a `textLayerAbsent` observation the caller controls page by page.
 */
export function renderedPreview(
  page: number,
  patch: Partial<RenderedPagePreview> = {}
): RenderedPagePreview {
  const bytes = solidPng(page)
  return {
    page,
    mediaType: "image/png",
    dataBase64: bytes.toString("base64"),
    byteLength: bytes.length,
    sha256: sha256Hex(bytes),
    width: 64,
    height: 88,
    observedTextLayerAbsent: true,
    warnings: [],
    exceptions: [],
    ...patch,
  }
}

export interface FakeRendererOptions {
  /** Pages the fake actually renders — omit one to simulate a missing preview. */
  omitPages?: readonly number[]
  /** Duplicate a page to simulate a mis-paired renderer. */
  duplicatePage?: number
  /** Extra page outside the request to simulate a renderer that invents pages. */
  extraPage?: number
  textLayerAbsentPages?: "all" | "none" | readonly number[]
  failWith?: Error
  /** Observation override: page -> declared text-layer absence. */
  observations?: Record<number, boolean>
  onRequest?: (request: { pageCount: number; pages: readonly number[]; bytes: number }) => void
}

export function fakePagePreviewRenderer(options: FakeRendererOptions = {}): PagePreviewRenderer & {
  calls: Array<{ pageCount: number; pages: number[]; bytes: number }>
} {
  const calls: Array<{ pageCount: number; pages: number[]; bytes: number }> = []
  const renderer = async (request: {
    content: Buffer
    pageCount: number
    pages?: readonly number[]
  }): Promise<readonly RenderedPagePreview[]> => {
    calls.push({
      pageCount: request.pageCount,
      pages: [...(request.pages ?? Array.from({ length: request.pageCount }, (_, i) => i + 1))],
      bytes: request.content.length,
    })
    options.onRequest?.(calls[calls.length - 1])
    if (options.failWith) throw options.failWith
    const requested = request.pages ?? Array.from({ length: request.pageCount }, (_, index) => index + 1)
    const omit = new Set(options.omitPages ?? [])
    const previews: RenderedPagePreview[] = []
    for (const page of requested) {
      if (omit.has(page)) continue
      const absent =
        options.observations?.[page] ??
        (options.textLayerAbsentPages === "all"
          ? true
          : options.textLayerAbsentPages === "none"
            ? false
            : Array.isArray(options.textLayerAbsentPages)
              ? options.textLayerAbsentPages.includes(page)
              : true)
      previews.push(renderedPreview(page, { observedTextLayerAbsent: absent }))
    }
    if (options.duplicatePage !== undefined) {
      previews.push(renderedPreview(options.duplicatePage))
    }
    if (options.extraPage !== undefined) {
      previews.push(renderedPreview(options.extraPage))
    }
    return previews
  }
  return Object.assign(renderer, { calls })
}

/** A raw builtin-pdf extraction payload with the given per-page blocks. */
export function rawExtractionPayload(input: {
  pageCount: number
  blocks?: Array<{ page: number; text: string }>
  tables?: Array<{ page: number; markdown: string }>
  warnings?: string[]
}): string {
  return JSON.stringify({
    version: 1,
    pageCount: input.pageCount,
    outline: [],
    blocks: (input.blocks ?? []).map((block) => ({
      page: block.page,
      text: block.text,
      bbox: [50, 100, 545, 130],
      fontSize: 12,
      bold: false,
    })),
    tables: (input.tables ?? []).map((table) => ({
      page: table.page,
      bbox: [60, 200, 500, 300],
      markdown: table.markdown,
    })),
    warnings: input.warnings ?? [],
    stats: {
      textChars: (input.blocks ?? []).reduce((sum, block) => sum + block.text.length, 0),
      pagesWithText: new Set((input.blocks ?? []).map((block) => block.page)).size,
    },
  })
}

/** Page text records for tests that need an extractor observation without the parser. */
export function pageTextRecord(
  page: number,
  patch: Partial<PdfPageTextRecord> = {}
): PdfPageTextRecord {
  const text = patch.text ?? `page ${page} extracted text`
  return {
    page,
    text,
    blockCount: text ? 1 : 0,
    tableCount: 0,
    textChars: text.length,
    status: text ? "extracted" : "text_layer_absent",
    textLayerAbsent: !text,
    warnings: [],
    exceptions: [],
    ...patch,
  }
}

/**
 * A REAL textless PDF: one page per requested page number carrying nothing but
 * an embedded raster image — no text operators anywhere. Built with pdf-lib so
 * the test does not depend on the ticket 02 corpus.
 */
export async function textlessScanPdfBytes(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const image = await doc.embedPng(solidPng(1000 + pageCount))
  for (let page = 0; page < pageCount; page += 1) {
    const sheet = doc.addPage([595, 842])
    sheet.drawImage(image, { x: 40, y: 40, width: 500, height: 700 })
  }
  return Buffer.from(await doc.save())
}

/** A PDF whose pages 1..pageCount carry the given text lines (page 1 = lines[0]). */
export async function textLayerPdfBytes(pages: readonly string[][]): Promise<Buffer> {
  const doc = await PDFDocument.create()
  for (const lines of pages) {
    const sheet = doc.addPage([595, 842])
    let y = 800
    for (const line of lines) {
      sheet.drawText(line, { x: 50, y, size: 14 })
      y -= 22
    }
  }
  return Buffer.from(await doc.save())
}

export const TEST_ORIGINAL_FILE = {
  fileName: "candidate.pdf",
  mimeType: "application/pdf",
} as const
