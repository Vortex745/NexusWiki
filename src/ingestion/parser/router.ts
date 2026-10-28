import { extname } from "node:path"
import type { ParserType } from "../../types"

/** Image formats are OCR-routed, never markitdown-routed. */
const IMAGE_EXTENSIONS = [".bmp", ".heic", ".jpeg", ".jpg", ".png", ".tif", ".tiff"] as const

const MARKITDOWN_EXTENSIONS = new Set([
  ".csv",
  ".doc",
  ".docx",
  ".epub",
  ".htm",
  ".html",
  ".json",
  ".md",
  ".markdown",
  ".ppt",
  ".pptx",
  ".rtf",
  ".txt",
  ".xls",
  ".xlsx",
  ".xml",
])

const MARKITDOWN_MIME_TYPES = new Set([
  "application/epub+zip",
  "application/json",
  "application/msword",
  "application/rtf",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/xml",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/xml",
])

/**
 * Every extension the router can route — the ONE format list both entry points
 * accept: the import picker (mirrored in frontend/src/lib/constants.ts) and the
 * conversation composer's attachment picker. A format that can be imported can
 * also be attached to a conversation, and vice versa.
 */
export const SUPPORTED_DOCUMENT_EXTENSIONS: readonly string[] = [
  ".pdf",
  ...MARKITDOWN_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
]

const PARSER_OVERRIDES = new Set<ParserType>([
  "markitdown",
  "marker",
  "mineru",
  "builtin-pdf",
  "direct-txt",
  "ocr-api",
])

export interface ParserSelectionInput {
  fileName: string
  mimeType?: string
  override?: string
}

export interface ParserDecision {
  parser: ParserType
  reason: string
}

export interface ParserRouteInfo {
  /** One type-matched parser; failures never switch OCR providers. */
  candidates: ParserType[]
  reason: string
  authoritative: boolean
}

export function isParserOverride(value: string): value is ParserType {
  return PARSER_OVERRIDES.has(value as ParserType)
}

function parserOverride(value: string): ParserType {
  if (isParserOverride(value)) {
    return value
  }
  throw new Error(
    `Unsupported parser override: ${value}. Expected markitdown, ocr-api, builtin-pdf, or direct-txt.`
  )
}

// Ticket UT-06: which file classes each parser is type-compatible with. A
// known override whose parser is NOT compatible with the declared file class
// is normalized to the type-matched route (original intent preserved in the
// recorded reason) instead of hijacking the file into a wrong-class parser.
type ParserFileClass = "pdf" | "image" | "text"
const PARSER_COMPATIBLE_CLASSES: Record<ParserType, Set<ParserFileClass>> = {
  // Ticket 21: markitdown is the general text converter — and ONLY that. It
  // has no raw seam, no page structure and no extraction evidence row, so a
  // PDF routed through it could never produce the page evidence the quality
  // gate grounds an audit on. An explicit markitdown choice on a PDF is
  // normalized to the type-matched route (original intent preserved in the
  // recorded reason), exactly like any other wrong-class override.
  markitdown: new Set<ParserFileClass>(["text"]),
  marker: new Set<ParserFileClass>(["pdf"]),
  "builtin-pdf": new Set<ParserFileClass>(["pdf"]),
  // mineru is the OCR-aware extractor for images and also handles PDFs.
  mineru: new Set<ParserFileClass>(["pdf", "image"]),
  "ocr-api": new Set<ParserFileClass>(["pdf", "image"]),
  // UT-10: the faithful TXT path is strictly plain text — no other format may
  // enter it (structured text like .md/.csv keeps its markdown-aware route).
  "direct-txt": new Set<ParserFileClass>(["text"]),
}

function declaredFileClass(fileName: string, mimeType?: string): ParserFileClass | "unknown" {
  const extension = extname(fileName).toLowerCase()
  if (extension === ".pdf") return "pdf"
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(extension)) {
    return "image"
  }
  if (MARKITDOWN_EXTENSIONS.has(extension)) return "text"
  const normalizedMime = mimeType?.split(";", 1)[0].trim().toLowerCase()
  if (normalizedMime === "application/pdf") return "pdf"
  if (normalizedMime?.startsWith("image/")) return "image"
  if (normalizedMime && MARKITDOWN_MIME_TYPES.has(normalizedMime)) return "text"
  return "unknown"
}

export function selectParserRoute(input: ParserSelectionInput): ParserRouteInfo {
  if (input.override) {
    const parser = parserOverride(input.override)
    const fileClass = declaredFileClass(input.fileName, input.mimeType)
    if (fileClass === "unknown") {
      // UT-05/UT-06: an unconfirmable type must not be blindly declared
      // compatible — admission refuses unrouteable types earlier; reaching
      // here means the type could not be confirmed at all.
      throw new Error(
        `Cannot confirm type compatibility for ${input.fileName}: no known file class, override ${parser} refused`
      )
    }
    if (!PARSER_COMPATIBLE_CLASSES[parser].has(fileClass)) {
      // UT-06: a PDF-only (or image-only) override on a file of a different
      // class normalizes to the type-matched route. The adjustment reason is
      // persisted via parser metadata so the original intent and the actual
      // strategy stay auditable.
      const typeMatched = selectParserRoute({
        fileName: input.fileName,
        mimeType: input.mimeType,
      })
      return {
        candidates: typeMatched.candidates,
        reason: `${parser} is not compatible with ${fileClass} files; original override normalized to the type-matched route (${typeMatched.reason})`,
        authoritative: false,
      }
    }
    return {
      candidates: [parser === "marker" || parser === "mineru" ? "ocr-api" : parser],
      reason: parser === "marker" || parser === "mineru"
        ? `${parser} legacy OCR override mapped to ocr-api`
        : "explicit parser override",
      authoritative: true,
    }
  }

  const extension = extname(input.fileName).toLowerCase()
  if (extension === ".pdf") {
    return {
      candidates: ["builtin-pdf"],
      reason: "PDF documents use text-layer extraction; select ocr-api for OCR",
      authoritative: false,
    }
  }
  if (extension === ".txt") {
    return {
      // UT-10: plain text is decoded in-process. The general CLI/Markdown
      // route loses trailing spaces at the extraction boundary and interprets
      // literal `#`/`**`/`|` syntax at the cleaning boundary; the faithful
      // path preserves whitespace, indentation and literal syntax exactly.
      candidates: ["direct-txt"],
      reason: "plain text is decoded directly (faithful TXT path with recorded encoding evidence)",
      authoritative: false,
    }
  }
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(extension)) {
    return {
      candidates: ["ocr-api"],
      reason: "image documents use the OCR API",
      authoritative: false,
    }
  }
  if (MARKITDOWN_EXTENSIONS.has(extension)) {
    return {
      candidates: ["markitdown"],
      reason: `extension ${extension} is supported by MarkItDown`,
      authoritative: false,
    }
  }

  const mimeType = input.mimeType?.split(";", 1)[0].trim().toLowerCase()
  if (mimeType === "application/pdf") {
    return {
      candidates: ["builtin-pdf"],
      reason: "PDF documents use text-layer extraction; select ocr-api for OCR",
      authoritative: false,
    }
  }
  if (mimeType?.startsWith("image/")) {
    return {
      candidates: ["ocr-api"],
      reason: "image documents use the OCR API",
      authoritative: false,
    }
  }
  if (mimeType === "text/plain") {
    return {
      // UT-10: same faithful path as .txt — but ONLY text/plain. Structured
      // text formats keep their MarkItDown route below.
      candidates: ["direct-txt"],
      reason: "text/plain is decoded directly (faithful TXT path with recorded encoding evidence)",
      authoritative: false,
    }
  }
  if (mimeType && MARKITDOWN_MIME_TYPES.has(mimeType)) {
    return {
      candidates: ["markitdown"],
      reason: `MIME type ${mimeType} is supported by MarkItDown`,
      authoritative: false,
    }
  }
  throw new Error(
    `No parser route for ${input.fileName}${mimeType ? ` (${mimeType})` : ""}`
  )
}

export function selectParser(input: ParserSelectionInput): ParserDecision {
  const route = selectParserRoute(input)
  return { parser: route.candidates[0], reason: route.reason }
}
