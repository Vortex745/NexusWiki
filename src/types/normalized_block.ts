// Legacy names remain readable in persisted extraction provenance.
export type ParserType = "markitdown" | "marker" | "mineru" | "builtin-pdf" | "direct-txt" | "ocr-api"

export type NormalizedBlockType =
  | "heading"
  | "paragraph"
  | "table"
  | "code"
  | "image"
  | "equation"

export interface ParserProvenance {
  parser: ParserType
  adapter: "cli" | "script" | "in-process" | "api"
}

/**
 * Ticket 05: a page preview is a DERIVED render of the original PDF. It is
 * evidence for the quality gate, never content for the index — so it carries a
 * brand that `NormalizedBlock` refuses (`never` in the brand slot makes the
 * assignment a compile error, and the runtime guard below catches the forms
 * that survive a JSON round trip).
 */
export const PDF_PAGE_PREVIEW_BRAND = Symbol.for("kefu-rag.pdf-page-preview")

/** Plain-field twin of the brand, because symbol keys do not survive `JSON`. */
export const PDF_PAGE_PREVIEW_ORIGIN = "derived_preview"

/** Metadata key a laundered preview record still carries. */
export const PDF_PAGE_PREVIEW_METADATA_KEY = "pdfPagePreview"

export interface NormalizedBlock {
  id: string
  index: number
  type: NormalizedBlockType
  text: string
  headingLevel?: number
  page?: number
  sectionPath: string[]
  boundingBox?: [number, number, number, number]
  table?: Record<string, unknown>
  image?: Record<string, unknown>
  metadata: Record<string, unknown>
  provenance: ParserProvenance
  /** Brand slot: only a derived page preview sets it, and a block may not. */
  [PDF_PAGE_PREVIEW_BRAND]?: never
}

/** Reason code for every refusal raised by the indexability guard. */
export const PAGE_PREVIEW_INDEX_REJECTION = "page_preview_in_indexed_content"

export class PagePreviewAsContentError extends Error {
  readonly code = PAGE_PREVIEW_INDEX_REJECTION
  constructor(message: string) {
    super(`${message} (${PAGE_PREVIEW_INDEX_REJECTION})`)
    this.name = "PagePreviewAsContentError"
  }
}

/**
 * Shape test for a derived page preview. Deliberately structural: a preview
 * record may arrive from persisted JSON with its brand gone, and a value with
 * page image bytes plus its own digest is a preview whatever typed reference
 * it is hiding behind.
 */
export function isDerivedPagePreview(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string | symbol, unknown>
  if (record[PDF_PAGE_PREVIEW_BRAND] === true) return true
  if (record.origin === PDF_PAGE_PREVIEW_ORIGIN) return true
  return (
    typeof record.dataBase64 === "string" &&
    record.dataBase64.length > 0 &&
    typeof record.sha256 === "string" &&
    typeof record.page === "number"
  )
}

function blockCarriesPreview(block: NormalizedBlock): boolean {
  const record = block as unknown as Record<string | symbol, unknown>
  if (record[PDF_PAGE_PREVIEW_BRAND] === true) return true
  if (record.origin === PDF_PAGE_PREVIEW_ORIGIN) return true
  if (isDerivedPagePreview(record)) return true
  const metadata = record.metadata as Record<string, unknown> | undefined
  if (metadata && metadata[PDF_PAGE_PREVIEW_METADATA_KEY] !== undefined) return true
  const image = record.image as Record<string, unknown> | undefined
  if (image && typeof image.dataBase64 === "string" && image.dataBase64.length > 0) return true
  return false
}

/**
 * The bar in front of indexed content: no derived page preview may enter the
 * normalized-block set that chunking, the manifest and the content proof are
 * built from. Previews belong to the page evidence record, tied to the source
 * page they were rendered from.
 */
export function assertIndexableBlocks(blocks: readonly NormalizedBlock[]): readonly NormalizedBlock[] {
  if (!Array.isArray(blocks)) {
    throw new PagePreviewAsContentError("normalized block set must be an array")
  }
  blocks.forEach((block, position) => {
    if (!block || typeof block !== "object") {
      throw new PagePreviewAsContentError(`normalized block at index ${position} is not a block`)
    }
    if (blockCarriesPreview(block)) {
      const page = typeof block.page === "number" ? ` of page ${block.page}` : ""
      throw new PagePreviewAsContentError(
        `normalized block at index ${position}${page} is a derived page preview and can never be indexed content`
      )
    }
  })
  return blocks
}
