// Ticket 05: the page-preview seam.
//
// There is no JavaScript PDF rasterizer in this project (pdf-lib builds and
// manipulates PDFs; it cannot render a page), and poppler/mutool/ghostscript
// are not on PATH. The proven local rasterizer is the same one the text
// extractor already uses: a bounded Python/PyMuPDF subprocess. This module
// follows the `builtin_pdf.ts` pattern exactly — one `runBoundedProcess` call
// with `[...commandArgs, scriptPath, sourcePath, pageSpec, scale]` — and adds
// one injectable seam (`runProcess`) so unit tests never need PyMuPDF.
//
// What the seam promises:
// - one PNG per requested page, tied to that page by a digest recomputed from
//   the returned bytes in TypeScript (the script's word is never taken);
// - a requested page that came back without an image is an explicit failure;
// - undecodable or over-limit image bytes fail instead of being truncated;
// - the render subprocess reports, per page, what IT saw of the text layer —
//   the second observation the evidence layer declares absence from.
import { createHash } from "node:crypto"
import { accessSync, constants } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runBoundedProcess, type BoundedProcessInput } from "../parser/process"
import { CLEF_IMAGE_LIMITS, type QualityImageMediaType } from "../quality/evidence"

export const PDF_PAGE_PREVIEW_SCHEMA_VERSION = 1

export type PagePreviewErrorCode =
  | "renderer_unavailable"
  | "renderer_failed"
  | "renderer_output_malformed"
  | "renderer_document_input_invalid"
  | "preview_page_missing"
  | "preview_page_duplicate"
  | "preview_page_unrequested"
  | "preview_document_shape_mismatch"
  | "image_bytes_missing"
  | "image_base64_invalid"
  | "image_media_type_invalid"
  | "image_content_invalid"
  | "image_resolution_mismatch"
  | "image_resolution_invalid"
  | "image_resolution_too_large"
  | "image_too_large"

export class PagePreviewError extends Error {
  constructor(readonly code: PagePreviewErrorCode, message: string) {
    super(message)
    this.name = "PagePreviewError"
  }
}

export interface RenderedPagePreview {
  page: number
  mediaType: QualityImageMediaType
  /** The rendered page bytes themselves — a path or a metadata record is not a preview. */
  dataBase64: string
  byteLength: number
  sha256: string
  width: number
  height: number
  /** What the render subprocess observed of this page's text layer. */
  observedTextLayerAbsent: boolean
  /** Per-page render warnings, retained verbatim. */
  warnings: string[]
  /** Per-page exceptions the render subprocess hit while reading the page. */
  exceptions: Array<{ code: string; message: string }>
}

export interface PagePreviewRequest {
  /** The ORIGINAL document bytes — a preview is always a render of these. */
  content: Buffer
  /** Declared page count of the original document. */
  pageCount: number
  /** Subset to render; defaults to every declared page, 1..pageCount. */
  pages?: readonly number[]
  signal?: AbortSignal
}

export type PagePreviewRenderer = (request: PagePreviewRequest) => Promise<readonly RenderedPagePreview[]>

export type BoundedProcessRunner = (input: BoundedProcessInput) => Promise<string>
export type { BoundedProcessInput }

export interface BuiltinPdfPreviewRendererOptions {
  command: string
  commandArgs?: string[]
  scriptPath?: string
  timeoutMs: number
  inputLimitBytes: number
  outputLimitBytes: number
  /** Device pixels per PDF point. 2.0 is ~144 dpi — legible, inside the Clef ceilings. */
  scale?: number
  /** Test seam. Production leaves this unset and uses the bounded subprocess helper. */
  runProcess?: BoundedProcessRunner
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const BASE64_ONLY = /^[A-Za-z0-9+/]*={0,2}$/
const DEFAULT_SCALE = 2

/**
 * The renderer script ships with the repository next to the extractor script.
 * Module layout differs between tsx (src/ingestion/parser) and the compiled
 * build (dist/ingestion/parser), so resolve from the module directory first
 * and fall back to the working directory — same rule as `builtin_pdf.ts`.
 */
export function resolveDefaultPreviewScriptPath(): string {
  const relative = join("scripts", "builtin_pdf_preview.py")
  const candidates = [
    resolve(__dirname, "..", "..", "..", relative),
    resolve(process.cwd(), relative),
  ]
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.R_OK)
      return candidate
    } catch {
      continue
    }
  }
  return candidates[0]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function pngHeader(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new PagePreviewError(
      "image_content_invalid",
      `page render is not a PNG (first bytes: ${bytes.subarray(0, 8).toString("hex")})`
    )
  }
  const type = bytes.toString("ascii", 12, 16)
  const length = bytes.readUInt32BE(8)
  if (type !== "IHDR" || length !== 13) {
    throw new PagePreviewError("image_content_invalid", "page render has no PNG IHDR header")
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function decodePreview(row: Record<string, unknown>, page: number): RenderedPagePreview {
  if (row.mediaType !== "image/png") {
    throw new PagePreviewError(
      "image_media_type_invalid",
      `page ${page}: page previews are PNG renders, got ${JSON.stringify(row.mediaType)}`
    )
  }
  const encoded = row.dataBase64
  if (typeof encoded !== "string" || encoded.trim() === "") {
    throw new PagePreviewError("image_bytes_missing", `page ${page}: the render carries no image bytes`)
  }
  if (!BASE64_ONLY.test(encoded) || encoded.length % 4 !== 0) {
    throw new PagePreviewError("image_base64_invalid", `page ${page}: the render is not canonical base64`)
  }
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.toString("base64") !== encoded) {
    throw new PagePreviewError("image_base64_invalid", `page ${page}: the render is not canonical base64`)
  }
  if (bytes.length === 0) {
    throw new PagePreviewError("image_bytes_missing", `page ${page}: the render carries no image bytes`)
  }
  if (bytes.length > CLEF_IMAGE_LIMITS.maxImageBytes) {
    throw new PagePreviewError(
      "image_too_large",
      `page ${page}: render is ${bytes.length} bytes over the Clef ${CLEF_IMAGE_LIMITS.maxImageBytes} byte per-image limit; it was not truncated`
    )
  }
  const header = pngHeader(bytes)
  if (typeof row.width !== "number" || typeof row.height !== "number") {
    throw new PagePreviewError("renderer_output_malformed", `page ${page}: the render declares no dimensions`)
  }
  if (row.width !== header.width || row.height !== header.height) {
    throw new PagePreviewError(
      "image_resolution_mismatch",
      `page ${page}: render declares ${String(row.width)}x${String(row.height)} but its PNG header carries ${header.width}x${header.height}`
    )
  }
  if (header.width < CLEF_IMAGE_LIMITS.minImageEdgePixels || header.height < CLEF_IMAGE_LIMITS.minImageEdgePixels) {
    throw new PagePreviewError(
      "image_resolution_invalid",
      `page ${page}: render is ${header.width}x${header.height}, below the ${CLEF_IMAGE_LIMITS.minImageEdgePixels}px edge a model can read`
    )
  }
  if (header.width * header.height > CLEF_IMAGE_LIMITS.maxImagePixels) {
    throw new PagePreviewError(
      "image_resolution_too_large",
      `page ${page}: render is ${header.width}x${header.height}, over the Clef ${CLEF_IMAGE_LIMITS.maxImagePixels} pixel limit`
    )
  }
  if (typeof row.textLayerAbsent !== "boolean") {
    throw new PagePreviewError(
      "renderer_output_malformed",
      `page ${page}: the render did not report what it saw of the text layer`
    )
  }

  return Object.freeze({
    page,
    mediaType: "image/png" as QualityImageMediaType,
    dataBase64: encoded,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width: header.width,
    height: header.height,
    observedTextLayerAbsent: row.textLayerAbsent,
    warnings: Array.isArray(row.warnings)
      ? row.warnings.filter((warning): warning is string => typeof warning === "string")
      : [],
    exceptions: Array.isArray(row.errors)
      ? (row.errors as unknown[]).flatMap((entry) => {
          if (!isRecord(entry) || typeof entry.code !== "string") return []
          return [{ code: entry.code, message: typeof entry.message === "string" ? entry.message : "" }]
        })
      : [],
  })
}

function parseRenderOutput(raw: string, requested: readonly number[], documentPageCount: number): readonly RenderedPagePreview[] {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch (error) {
    throw new PagePreviewError(
      "renderer_output_malformed",
      `page render output is not JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (
    !isRecord(payload) ||
    payload.version !== PDF_PAGE_PREVIEW_SCHEMA_VERSION ||
    !Number.isInteger(payload.pageCount) ||
    !Array.isArray(payload.previews)
  ) {
    throw new PagePreviewError(
      "renderer_output_malformed",
      "page render output is not a versioned preview set (one render per requested page)"
    )
  }
  if (payload.pageCount !== documentPageCount) {
    throw new PagePreviewError(
      "preview_document_shape_mismatch",
      `the render reports ${payload.pageCount} pages for a document that declares ${documentPageCount}`
    )
  }

  const wanted = new Set(requested)
  const byPage = new Map<number, RenderedPagePreview>()
  for (const entry of payload.previews) {
    if (!isRecord(entry) || !Number.isInteger(entry.page) || (entry.page as number) < 1) {
      throw new PagePreviewError("renderer_output_malformed", "a page render carries no valid 1-based page number")
    }
    const page = entry.page as number
    if (!wanted.has(page)) {
      throw new PagePreviewError(
        "preview_page_unrequested",
        `page ${page} was rendered but never requested — its preview has no place in this evidence set`
      )
    }
    if (byPage.has(page)) {
      throw new PagePreviewError("preview_page_duplicate", `page ${page} came back with more than one render`)
    }
    byPage.set(page, decodePreview(entry, page))
  }
  for (const page of requested) {
    if (!byPage.has(page)) {
      throw new PagePreviewError(
        "preview_page_missing",
        `page ${page} has no rendered preview — a placeholder image is never substituted for a real page render`
      )
    }
  }
  return requested.map((page) => byPage.get(page)!)
}

/**
 * Production renderer: one bounded PyMuPDF subprocess per request, reading the
 * original document bytes from a temporary workspace that is always removed.
 */
export function createBuiltinPdfPreviewRenderer(options: BuiltinPdfPreviewRendererOptions): PagePreviewRenderer {
  const scale = options.scale ?? DEFAULT_SCALE
  const runProcess = options.runProcess ?? runBoundedProcess

  return async (request: PagePreviewRequest): Promise<readonly RenderedPagePreview[]> => {
    if (!Buffer.isBuffer(request.content) || request.content.length === 0) {
      throw new PagePreviewError("renderer_document_input_invalid", "page rendering needs the original document bytes")
    }
    if (!Number.isSafeInteger(request.pageCount) || request.pageCount < 1) {
      throw new PagePreviewError(
        "renderer_document_input_invalid",
        `page rendering needs a declared page count, got ${String(request.pageCount)}`
      )
    }
    if (request.content.length > options.inputLimitBytes) {
      throw new PagePreviewError(
        "renderer_document_input_invalid",
        `page render input exceeded ${options.inputLimitBytes} bytes`
      )
    }

    const requested = request.pages
      ? [...request.pages].map((page) => {
          if (!Number.isSafeInteger(page) || page < 1 || page > request.pageCount) {
            throw new PagePreviewError(
              "renderer_document_input_invalid",
              `page ${String(page)} is outside the declared document of ${request.pageCount} pages`
            )
          }
          return page
        })
      : Array.from({ length: request.pageCount }, (_, index) => index + 1)
    const duplicate = requested.find((page, index) => requested.indexOf(page) !== index)
    if (duplicate !== undefined) {
      throw new PagePreviewError("preview_page_duplicate", `page ${duplicate} was requested more than once`)
    }

    const scriptPath = options.scriptPath ?? resolveDefaultPreviewScriptPath()
    const workspace = await mkdtemp(join(tmpdir(), "kefu-rag-builtin-pdf-preview-"))
    const sourcePath = join(workspace, "input.pdf")
    try {
      await writeFile(sourcePath, request.content, { flag: "wx" })
      let raw: string
      try {
        raw = await runProcess({
          command: options.command,
          args: [
            ...(options.commandArgs ?? []),
            scriptPath,
            sourcePath,
            requested.join(","),
            String(scale),
          ],
          cwd: workspace,
          timeoutMs: options.timeoutMs,
          outputLimitBytes: options.outputLimitBytes,
          signal: request.signal,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes("Parser executable is unavailable")) {
          throw new PagePreviewError(
            "renderer_unavailable",
            `page previews need the local PDF rasterizer. Configure PYTHON_COMMAND. ${message}`
          )
        }
        if (error instanceof PagePreviewError) throw error
        throw new PagePreviewError("renderer_failed", `page render subprocess failed: ${message}`)
      }
      return parseRenderOutput(raw, requested, request.pageCount)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }
}
