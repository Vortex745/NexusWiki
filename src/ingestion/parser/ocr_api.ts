import { createHash } from "node:crypto"
import { extname } from "node:path"
import { Signer } from "@volcengine/openapi"
import { PDFDocument } from "pdf-lib"
import type { NormalizedBlock, NormalizedBlockType } from "../../types"
import type { PdfPageTextRecord } from "../page_evidence/page_evidence"
import { OcrApiError } from "../error_classification"
import type { ParseDocumentInput } from "./markitdown"
import { normalizeMarkItDown } from "./normalize"

const ENDPOINT = "https://visual.volcengineapi.com/"
const QUERY = { Action: "OCRPdf", Version: "2021-08-23" }
const FORM_LIMIT_BYTES = 8 * 1024 * 1024
const BATCH_PAGES = 16

export interface OcrApiParserOptions {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  timeoutMs: number
  inputLimitBytes: number
  outputLimitBytes: number
  fetch?: typeof fetch
}

export { OcrApiError } from "../error_classification"

// OCRPdf requires content-type AND host in SignedHeaders. The general SDK
// excludes content-type by default, so include it for this service contract.
class OcrSigner extends Signer {
  override isSignableHeader(key: string): boolean {
    return key === "content-type" || super.isSignableHeader(key)
  }
}

type JsonObject = Record<string, unknown>
interface RawBatch {
  pageStart: number
  pageCount: number
  response: JsonObject
}
interface RawExtraction {
  schemaVersion: 1
  pageCount: number
  batches: RawBatch[]
}

interface PageValidationOptions {
  /** A successful OCR response may legitimately contain a textless page. */
  allowEmpty?: boolean
  /** The provider may return page_md without textblocks; keep the markdown. */
  allowLayoutFallback?: boolean
}

export interface OcrImagePageInput {
  image: Buffer
  page: number
  fileName: string
  signal?: AbortSignal
  timeoutMs: number
}

export interface OcrImagePageResult {
  page: number
  text: string
  raw: unknown
  warnings: string[]
}

function malformed(detail: string): never {
  throw new OcrApiError(`malformed ocr-api output: ${detail}`, "permanent_input")
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return malformed("expected an object")
  }
  return value as JsonObject
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return malformed("invalid JSON")
  }
}

function pages(
  response: JsonObject,
  count: number,
  pageStart = 0,
  options: PageValidationOptions = {}
): JsonObject[] {
  if (response.code !== 10000) return malformed("missing successful business code")
  const data = object(response.data)
  const detail = typeof data.detail === "string" ? parseJson(data.detail) : data.detail
  if (!Array.isArray(detail) || detail.length !== count) {
    return malformed("missing pages or unexpected page count")
  }
  const ordered = detail.map(object).sort((left, right) => Number(left.page_id) - Number(right.page_id))
  for (let index = 0; index < count; index += 1) {
    if (ordered[index].page_id !== index || typeof ordered[index].page_md !== "string") {
      return malformed("duplicate, missing or invalid page IDs/markdown")
    }
    const textblocks = ordered[index].textblocks
    if (textblocks !== undefined && !Array.isArray(textblocks)) return malformed("invalid textblocks")
    if (textblocks === undefined && (ordered[index].page_md as string).trim() && !options.allowLayoutFallback) {
      return malformed("missing textblocks")
    }
    if (Array.isArray(textblocks)) {
      for (const block of textblocks) {
        const source = object(block)
        if (typeof source.label !== "string" || (source.text !== undefined && typeof source.text !== "string")) return malformed("invalid textblock")
      }
    }
  }
  // Validate every page identity before classifying empty content. Otherwise a
  // malformed later page could be hidden by an earlier apparently empty page.
  for (let index = 0; index < count; index += 1) {
    const page = ordered[index]
    const textblocks = page.textblocks
    const hasBlocks = Array.isArray(textblocks) && textblocks.length > 0
    const hasMarkdown = typeof page.page_md === "string" && page.page_md.trim().length > 0
    if (!hasBlocks && !hasMarkdown) {
      if (!options.allowEmpty) {
        const pageNumber = pageStart + index + 1
        throw new OcrApiError(`OCR page ${pageNumber} has no recognized text; empty content remains unverified`, "permanent_input", "ocr_empty_page_unverified", pageNumber)
      }
      continue
    }
    if (!Array.isArray(textblocks) && !options.allowLayoutFallback) return malformed("missing textblocks")
  }
  return ordered
}

function form(content: Buffer, fileType: "pdf" | "image", count: number): string {
  return new URLSearchParams({
    image_base64: content.toString("base64"),
    version: "v3",
    file_type: fileType,
    page_start: "0",
    page_num: String(count),
    parse_mode: "ocr",
    table_mode: "html",
    filter_header: "false",
  }).toString()
}

function boundingBox(value: unknown): [number, number, number, number] | undefined {
  const coords = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? [object(value).x0, object(value).y0, object(value).x1, object(value).y1]
      : null
  if (!coords || coords.length !== 4 || !coords.every((item) => typeof item === "number" && Number.isFinite(item))) {
    return undefined
  }
  return coords as [number, number, number, number]
}

/**
 * Ticket 24: the fingerprint of the OCR configuration that produced an OCR
 * candidate. Audits and cache decisions compare this so a changed OCR
 * configuration invalidates the OCR stage's evidence while local evidence
 * stays untouched. One shared source of truth for the ingestion route's
 * parser fingerprint and the quality gate's fallback seam.
 */
export function ocrApiParserConfigVersion(params: {
  timeoutMs: number
  inputLimitBytes: number
  outputLimitBytes: number
}): string {
  return createHash("sha256").update(JSON.stringify({
    parserType: "ocr-api", adapterVersion: "volc-ocr-v1", action: "OCRPdf",
    apiVersion: "2021-08-23", version: "v3", region: "cn-north-1", service: "cv",
    batchPages: 16, parseMode: "ocr", tableMode: "html", filterHeader: false,
    timeoutMs: params.timeoutMs,
    inputLimitBytes: params.inputLimitBytes,
    outputLimitBytes: params.outputLimitBytes,
  })).digest("hex")
}

export class OcrApiParser {
  readonly type = "ocr-api" as const
  private lastProvenance: { metadata: Record<string, unknown>; warnings: string[] } | null = null

  constructor(private options: OcrApiParserOptions) {}

  async parse(input: ParseDocumentInput): Promise<NormalizedBlock[]> {
    return this.normalizeRaw(await this.parseRaw(input), input.documentId)
  }

  async parseRaw(input: Omit<ParseDocumentInput, "documentId">): Promise<string> {
    this.lastProvenance = null
    input.signal?.throwIfAborted()
    if (!this.options.accessKeyId.trim() || !this.options.secretAccessKey.trim()) {
      throw new OcrApiError("OCR API is unconfigured. Set VOLC_ACCESSKEY and VOLC_SECRETKEY on the server.", "capability_missing")
    }
    if (!input.content.length || input.content.length > this.options.inputLimitBytes) {
      throw new OcrApiError(`OCR input is empty or exceeded ${this.options.inputLimitBytes} bytes`, "permanent_input")
    }
    const deadline = AbortSignal.timeout(this.options.timeoutMs)
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline
    try {
      const isPdf = extname(input.fileName).toLowerCase() === ".pdf" || input.mimeType?.split(";", 1)[0].trim().toLowerCase() === "application/pdf"
      let pdf: PDFDocument | null = null
      if (isPdf) {
        try {
          pdf = await PDFDocument.load(input.content)
        } catch {
          throw new OcrApiError("OCR input PDF is malformed or encrypted; provide an unencrypted PDF.", "permanent_input")
        }
      }
      const pageCount = pdf?.getPageCount() ?? 1
      if (pageCount < 1) throw new OcrApiError("OCR input PDF has no pages", "permanent_input")
      const batches: RawBatch[] = []
      let responseBytes = 0
      for (let pageStart = 0; pageStart < pageCount;) {
        signal.throwIfAborted()
        let count = Math.min(BATCH_PAGES, pageCount - pageStart)
        let body: string
        while (true) {
          signal.throwIfAborted()
          let bytes = input.content
          if (pdf && (pageStart !== 0 || count !== pageCount)) {
            const part = await PDFDocument.create()
            const copied = await part.copyPages(pdf, Array.from({ length: count }, (_, index) => pageStart + index))
            copied.forEach((page) => part.addPage(page))
            bytes = Buffer.from(await part.save())
          }
          body = form(bytes, isPdf ? "pdf" : "image", count)
          if (Buffer.byteLength(body) <= FORM_LIMIT_BYTES) break
          if (!pdf || count === 1) {
            throw new OcrApiError("OCR encoded request exceeded 8388608 bytes; compress this image or PDF page.", "permanent_input")
          }
          count = Math.ceil(count / 2)
        }
        const response = await this.request(body, signal, this.options.outputLimitBytes - responseBytes)
        pages(response.value, count, pageStart)
        responseBytes += response.bytes
        batches.push({ pageStart, pageCount: count, response: response.value })
        pageStart += count
      }
      const raw = JSON.stringify({ schemaVersion: 1, pageCount, batches } satisfies RawExtraction)
      if (Buffer.byteLength(raw) > this.options.outputLimitBytes) {
        throw new OcrApiError(`OCR output exceeded ${this.options.outputLimitBytes} bytes`, "permanent_input")
      }
      return raw
    } catch (error) {
      if (input.signal?.aborted) throw new DOMException("OCR was cancelled", "AbortError")
      if (deadline.aborted) throw new OcrApiError(`OCR API timed out after ${this.options.timeoutMs}ms`, "transient")
      throw error
    }
  }

  /**
   * Read one scanned page image with the SAME signing, form limits and error
   * taxonomy as the PDF route. A successful provider response with no text is a
   * legal empty page here; the caller decides whether the whole document still
   * has indexable content.
   */
  async readImagePage(input: OcrImagePageInput): Promise<OcrImagePageResult> {
    input.signal?.throwIfAborted()
    if (!this.options.accessKeyId.trim() || !this.options.secretAccessKey.trim()) {
      throw new OcrApiError("OCR API is unconfigured. Set VOLC_ACCESSKEY and VOLC_SECRETKEY on the server.", "capability_missing")
    }
    if (!Number.isInteger(input.page) || input.page < 1) {
      throw new OcrApiError("OCR image page must be a positive integer", "permanent_input")
    }
    if (!input.image.length || input.image.length > this.options.inputLimitBytes) {
      throw new OcrApiError(`OCR input is empty or exceeded ${this.options.inputLimitBytes} bytes`, "permanent_input")
    }
    const body = form(input.image, "image", 1)
    if (Buffer.byteLength(body) > FORM_LIMIT_BYTES) {
      throw new OcrApiError("OCR encoded request exceeded 8388608 bytes; compress this page image.", "permanent_input")
    }
    const timeoutMs = Math.max(1, Math.min(input.timeoutMs, this.options.timeoutMs))
    const deadline = AbortSignal.timeout(timeoutMs)
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline
    try {
      const response = await this.request(body, signal, this.options.outputLimitBytes)
      const page = pages(response.value, 1, 0, { allowEmpty: true, allowLayoutFallback: true })[0]
      const warnings = new Set<string>()
      const textblocks = Array.isArray(page.textblocks) ? page.textblocks : []
      const parts: string[] = []
      for (const blockValue of textblocks) {
        const block = object(blockValue)
        const label = typeof block.label === "string" ? block.label : ""
        const text = typeof block.text === "string" ? block.text : ""
        if (label === "image") warnings.add("ocr_image_semantics_unverified")
        if (!text.trim()) {
          if (label !== "image") warnings.add("ocr_empty_textblock")
          continue
        }
        if (text.includes("\0") || text.includes("\uFFFD")) warnings.add("ocr_text_corruption")
        parts.push(text.trim())
      }
      let text = parts.join("\n\n")
      if (!text && typeof page.page_md === "string" && page.page_md.trim()) {
        text = page.page_md.trim()
        warnings.add("ocr_layout_missing")
      }
      return { page: input.page, text, raw: response.value, warnings: [...warnings] }
    } catch (error) {
      if (input.signal?.aborted) throw new DOMException("OCR was cancelled", "AbortError")
      if (deadline.aborted) throw new OcrApiError(`OCR API timed out after ${timeoutMs}ms`, "transient")
      throw error
    }
  }

  private async request(body: string, signal: AbortSignal, remainingBytes: number): Promise<{ value: JsonObject; bytes: number }> {
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      host: "visual.volcengineapi.com",
    }
    new OcrSigner({ region: "cn-north-1", method: "POST", pathname: "/", params: QUERY, headers, body }, "cv")
      .addAuthorization({ accessKeyId: this.options.accessKeyId, secretKey: this.options.secretAccessKey, sessionToken: this.options.sessionToken })
    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)(`${ENDPOINT}?${new URLSearchParams(QUERY)}`, {
        method: "POST", headers, body, signal, redirect: "error",
      })
    } catch {
      signal.throwIfAborted()
      throw new OcrApiError("OCR API network error", "transient")
    }
    if (!response.ok) {
      await response.body?.cancel()
      const category = response.status === 401 || response.status === 403
        ? "capability_missing"
        : response.status === 429 || response.status >= 500 ? "transient" : "permanent_input"
      throw new OcrApiError(`OCR API HTTP ${response.status}`, category)
    }
    if (!response.body) return malformed("empty response body")
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        const result = await reader.read()
        if (result.done) break
        bytes += result.value.byteLength
        if (bytes > remainingBytes) {
          await reader.cancel()
          throw new OcrApiError(`OCR output exceeded ${this.options.outputLimitBytes} bytes`, "permanent_input")
        }
        chunks.push(result.value)
      }
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof OcrApiError) throw error
      throw new OcrApiError("OCR API network error while reading response", "transient")
    } finally {
      reader.releaseLock()
    }
    const value = object(parseJson(Buffer.concat(chunks).toString("utf8")))
    if (value.code !== 10000) {
      const code = typeof value.code === "number" ? value.code : "unknown"
      // Provider messages can contain input or credentials; expose only codes.
      const category = code === 50400 ? "capability_missing" : code === 50500 ? "transient" : "permanent_input"
      throw new OcrApiError(`OCR API business code ${code}`, category)
    }
    return { value, bytes }
  }

  normalizeRaw(raw: string, documentId: string): NormalizedBlock[] {
    const value = object(parseJson(raw))
    if (value.schemaVersion !== 1 || !Number.isInteger(value.pageCount) || Number(value.pageCount) < 1 || !Array.isArray(value.batches)) {
      return malformed("invalid extraction envelope")
    }
    const blocks: NormalizedBlock[] = []
    const warnings = new Set<string>()
    const sections: string[] = []
    let expectedStart = 0
    const add = (type: NormalizedBlockType, text: string, page: number, source: JsonObject = {}, extras: Partial<NormalizedBlock> = {}) => {
      const index = blocks.length
      blocks.push({
        id: createHash("sha256").update(`${documentId}\0${index}\0${page}\0${type}\0${text}`).digest("hex"),
        index, type, text, page, sectionPath: [...sections],
        boundingBox: boundingBox(source.box),
        metadata: { label: source.label, normalizedBox: source.norm_box },
        provenance: { parser: "ocr-api", adapter: "api" },
        ...extras,
      })
    }
    for (const batchValue of value.batches) {
      const batch = object(batchValue)
      if (batch.pageStart !== expectedStart || !Number.isInteger(batch.pageCount) || Number(batch.pageCount) < 1 || Number(batch.pageCount) > BATCH_PAGES) {
        return malformed("non-contiguous batch coverage")
      }
      for (const page of pages(object(batch.response), Number(batch.pageCount), expectedStart)) {
        const pageNumber = expectedStart + Number(page.page_id) + 1
        const textblocks = page.textblocks as unknown[]
        if (textblocks.length === 0 && (page.page_md as string).trim()) {
          warnings.add("ocr_layout_missing")
          for (const block of normalizeMarkItDown(page.page_md as string, documentId)) {
            add(block.type, block.text, pageNumber, {}, { headingLevel: block.headingLevel, table: block.table, image: block.image })
          }
        }
        for (const blockValue of textblocks) {
          const source = object(blockValue)
          if (typeof source.label !== "string" || (source.text !== undefined && typeof source.text !== "string")) {
            return malformed("invalid textblock")
          }
          const text = typeof source.text === "string" ? source.text : ""
          if (source.label === "image") warnings.add("ocr_image_semantics_unverified")
          if (!text.trim()) {
            if (source.label !== "image") warnings.add("ocr_empty_textblock")
            continue
          }
          if (text.includes("\0") || text.includes("\uFFFD")) warnings.add("ocr_text_corruption")
          if (source.label === "title" || source.label === "sec") {
            const level = source.label === "title" ? 1 : 2
            sections.splice(level - 1)
            sections.push(text)
            add("heading", text, pageNumber, source, { headingLevel: level })
          } else if (source.label === "table") {
            const html = /<table[\s>]/i.test(text)
            if (!html && !text.includes("|")) warnings.add("ocr_table_structure_unverified")
            add("table", text, pageNumber, source, { table: html ? { html: text } : { markdown: text } })
          } else if (source.label === "formula" || source.label === "equation") {
            add("equation", text, pageNumber, source)
          } else {
            // Preserve authors, headers, footers, footnotes and captions.
            add("paragraph", text, pageNumber, source)
          }
        }
      }
      expectedStart += Number(batch.pageCount)
    }
    if (expectedStart !== value.pageCount) return malformed("incomplete document coverage")
    if (!blocks.length) return malformed("no recognized text")
    // Successful transport and complete page IDs do not prove OCR accuracy.
    const reviewReasons = ["ocr_content_unverified", ...warnings]
    this.lastProvenance = {
      metadata: { extraction: { pageCount: value.pageCount, risks: { reviewRequired: true, reviewReasons } } },
      warnings: [...warnings],
    }
    return blocks
  }

  extractionProvenance(): { metadata: Record<string, unknown>; warnings: string[] } | null {
    return this.lastProvenance
  }
}

export interface OcrApiPageTextReading {
  schemaVersion: 1
  pageCount: number
  /** Exactly one record per declared page, in page order, textless pages included. */
  pageTexts: PdfPageTextRecord[]
  /** How many provider HTTP calls produced the extraction (one per batch). */
  providerCallCount: number
}

/**
 * Ticket 21: the per-page text reading of a durable ocr-api raw extraction —
 * the same JSON `parseRaw` persisted in the extraction artifact. The quality
 * gate grounds an ocr-api candidate's page records with it, and the
 * whole-document OCR fallback joins these texts with the original page images.
 * Shape violations fail loudly — never a silently empty page.
 */
export function readOcrApiPageTexts(value: unknown): OcrApiPageTextReading {
  // The gate hands over the DURABLE raw extraction — the same JSON string
  // `parseRaw` persisted — so accept both the string and its parsed shape,
  // exactly like readBuiltinPdfPageTexts does on the builtin side.
  const envelope = object(typeof value === "string" ? parseJson(value) : value)
  if (
    envelope.schemaVersion !== 1 ||
    !Number.isInteger(envelope.pageCount) ||
    Number(envelope.pageCount) < 1 ||
    !Array.isArray(envelope.batches)
  ) {
    return malformed("invalid extraction envelope")
  }
  const pageCount = Number(envelope.pageCount)
  const pageTexts: PdfPageTextRecord[] = []
  let expectedStart = 0
  for (const batchValue of envelope.batches) {
    const batch = object(batchValue)
    if (
      batch.pageStart !== expectedStart ||
      !Number.isInteger(batch.pageCount) ||
      Number(batch.pageCount) < 1 ||
      Number(batch.pageCount) > BATCH_PAGES
    ) {
      return malformed("non-contiguous batch coverage")
    }
    for (const page of pages(object(batch.response), Number(batch.pageCount), expectedStart)) {
      const page_ = expectedStart + Number(page.page_id) + 1
      const textblocks = page.textblocks as unknown[]
      const parts: string[] = []
      let blockCount = 0
      let tableCount = 0
      for (const blockValue of textblocks) {
        const source = object(blockValue)
        blockCount += 1
        if (source.label === "table") tableCount += 1
        if (typeof source.text === "string" && source.text.trim() !== "") parts.push(source.text)
      }
      if (parts.length === 0 && typeof page.page_md === "string" && (page.page_md as string).trim() !== "") {
        parts.push(page.page_md as string)
      }
      const text = parts.join("\n\n")
      pageTexts.push({
        page: page_,
        text,
        blockCount,
        tableCount,
        textChars: text.length,
        status: text ? "extracted" : "text_layer_absent",
        // The OCR provider read this page directly, so an empty page is an
        // observation of absence — declared, not invented.
        textLayerAbsent: text === "",
        warnings: [],
        exceptions: [],
      })
    }
    expectedStart += Number(batch.pageCount)
  }
  if (expectedStart !== pageCount) return malformed("incomplete document coverage")
  return {
    schemaVersion: 1,
    pageCount,
    pageTexts,
    providerCallCount: envelope.batches.length,
  }
}
