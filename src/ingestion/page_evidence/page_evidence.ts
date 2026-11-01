// Ticket 05: page-aligned extraction evidence and candidate identity.
//
// One bundle per extraction result. Every declared page — blank, image-only,
// textless, or page whose read raised — carries exactly one text record and
// exactly one derived preview, and the page's own exceptions and warnings ride
// on that record instead of collapsing into "empty document". The bundle also
// carries the candidate identity, so the evidence, the original file and the
// parser configuration that produced them are one auditable unit.
//
// Nothing here synthesizes content: text comes from the extractor, images from
// the renderer, and `textLayerAbsent` is declared only from an observation that
// actually happened.
import { PDF_PAGE_PREVIEW_BRAND, PDF_PAGE_PREVIEW_ORIGIN } from "../../types/normalized_block"
import type { OriginalFileIdentity } from "../source_identity"
import {
  buildExtractionCandidateIdentity,
  type ExtractionCandidateIdentity,
} from "./candidate_identity"
import type { RenderedPagePreview } from "./preview_renderer"

export const PDF_PAGE_EVIDENCE_SCHEMA_VERSION = 1

export type PdfEvidenceStage = "text_extraction" | "page_render" | "evidence_binding"

export type PdfPageTextStatus = "extracted" | "text_layer_absent" | "extraction_exception"

export interface PdfEvidenceException {
  /** null for a document-level exception; the page number for a page-level one. */
  page?: number | null
  code: string
  message: string
  stage: PdfEvidenceStage
}

/** What the local text extractor saw on one page. Empty text is a finding, not a failure. */
export interface PdfPageTextRecord {
  page: number
  /** The page's own extracted text, verbatim. "" when the text layer is absent. */
  text: string
  blockCount: number
  tableCount: number
  textChars: number
  status: PdfPageTextStatus
  /** Declared from the extractor's own reading of this page — never invented. */
  textLayerAbsent: boolean
  warnings: string[]
  exceptions: PdfEvidenceException[]
}

/**
 * A derived preview of one page of the original file. The brand makes it
 * un-assignable to `NormalizedBlock`, and `origin` keeps it identifiable after
 * a JSON round trip — a render is evidence, never indexable content.
 */
export interface PdfPagePreviewRecord extends RenderedPagePreview {
  origin: typeof PDF_PAGE_PREVIEW_ORIGIN
  /** sha256 of the ORIGINAL document this page was rendered from. */
  sourceFileSha256: string
  candidateId: string
  [PDF_PAGE_PREVIEW_BRAND]?: true
}

export interface PdfPageEvidenceRecord {
  page: number
  text: PdfPageTextRecord
  preview: PdfPagePreviewRecord
}

export interface PdfExtractionEvidenceBundle {
  schemaVersion: number
  evidenceVersion: string
  identity: ExtractionCandidateIdentity
  declaredPageCount: number
  /** Exactly one record per declared page, in page order. */
  pages: readonly PdfPageEvidenceRecord[]
  /** Document-level warnings from the extractor, retained verbatim. */
  documentWarnings: readonly string[]
  /** Document-level exceptions, e.g. an extraction that produced no content at all. */
  documentExceptions: readonly PdfEvidenceException[]
  pagesWithText: number
  /** Pages whose own read raised. */
  exceptionPages: readonly number[]
  /** Pages the extractor saw no text on, blank or scanned alike. */
  textlessPages: readonly number[]
  /** True when NO page produced local text — the OCR decision owns that, not the evidence layer. */
  localTextEmptyForAllPages: boolean
  ocrDecisionRequired: boolean
}

export type PageEvidenceErrorCode =
  | "page_count_invalid"
  | "page_text_record_missing"
  | "page_text_record_undeclared"
  | "duplicate_page_text_record"
  | "page_preview_missing"
  | "page_preview_undeclared"
  | "duplicate_page_preview"
  | "text_record_inconsistent"
  | "preview_source_binding_mismatch"
  | "text_layer_observation_conflict"

export class PageEvidenceError extends Error {
  constructor(readonly code: PageEvidenceErrorCode, message: string) {
    super(message)
    this.name = "PageEvidenceError"
  }
}

export interface BuildPdfExtractionEvidenceBundleInput {
  originalFile: OriginalFileIdentity
  extractionResultSha256: string
  parserType: string
  parserConfigVersion: string
  evidenceVersion?: string
  pageCount: number
  pageTexts: readonly PdfPageTextRecord[]
  previews: readonly (RenderedPagePreview & { sourceFileSha256?: string })[]
  documentWarnings?: readonly string[]
  documentExceptions?: readonly PdfEvidenceException[]
}

function declaredPages(pageCount: number): number[] {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new PageEvidenceError(
      "page_count_invalid",
      `a document declares a positive whole page count, got ${String(pageCount)}`
    )
  }
  return Array.from({ length: pageCount }, (_, index) => index + 1)
}

interface PairingLabels {
  missing: PageEvidenceErrorCode
  undeclared: PageEvidenceErrorCode
  duplicate: PageEvidenceErrorCode
}

function indexByPage<T extends { page: number }>(
  entries: readonly T[],
  pages: readonly number[],
  kind: string,
  labels: PairingLabels,
  describe: (page: unknown) => string
): Map<number, T> {
  const declared = new Set(pages)
  const byPage = new Map<number, T>()
  for (const entry of entries) {
    if (!entry || typeof entry.page !== "number" || !declared.has(entry.page)) {
      throw new PageEvidenceError(
        labels.undeclared,
        `${describe(entry?.page)} does not belong to a declared page`
      )
    }
    if (byPage.has(entry.page)) {
      throw new PageEvidenceError(labels.duplicate, `page ${entry.page} carries more than one ${kind}`)
    }
    byPage.set(entry.page, entry)
  }
  for (const page of pages) {
    if (!byPage.has(page)) {
      throw new PageEvidenceError(labels.missing, `page ${page} has no ${kind}`)
    }
  }
  return byPage
}

function validateTextRecord(record: PdfPageTextRecord): void {
  const hasText = record.text.length > 0
  if (record.textLayerAbsent && hasText) {
    throw new PageEvidenceError(
      "text_record_inconsistent",
      `page ${record.page}: a page declared textless must carry no text`
    )
  }
  if (record.status === "text_layer_absent" && !record.textLayerAbsent) {
    throw new PageEvidenceError(
      "text_record_inconsistent",
      `page ${record.page}: status is textless but the text layer is not declared absent`
    )
  }
  if (record.status === "extracted" && !hasText) {
    throw new PageEvidenceError(
      "text_record_inconsistent",
      `page ${record.page}: status is extracted but the page carries no text`
    )
  }
  if (record.textChars !== record.text.length) {
    throw new PageEvidenceError(
      "text_record_inconsistent",
      `page ${record.page}: declares ${record.textChars} characters but carries ${record.text.length}`
    )
  }
}

/**
 * Assembles the page-aligned evidence for one extraction result plus its
 * candidate identity. Refuses to complete unless every declared page is
 * represented exactly once by a text record and once by a preview.
 */
export function buildPdfExtractionEvidenceBundle(
  input: BuildPdfExtractionEvidenceBundleInput
): PdfExtractionEvidenceBundle {
  const pages = declaredPages(input.pageCount)
  const texts = indexByPage(input.pageTexts, pages, "text record", {
    missing: "page_text_record_missing",
    undeclared: "page_text_record_undeclared",
    duplicate: "duplicate_page_text_record",
  }, (page) => `a text record for page ${String(page)}`)
  const previews = indexByPage(input.previews, pages, "preview", {
    missing: "page_preview_missing",
    undeclared: "page_preview_undeclared",
    duplicate: "duplicate_page_preview",
  }, (page) => `a preview on page ${String(page)}`)

  for (const page of pages) {
    validateTextRecord(texts.get(page)!)
    const preview = previews.get(page)!
    if (preview.sourceFileSha256 !== undefined && preview.sourceFileSha256 !== input.originalFile.sha256) {
      throw new PageEvidenceError(
        "preview_source_binding_mismatch",
        `page ${page}'s preview is bound to ${preview.sourceFileSha256}, not to this candidate's original file ${input.originalFile.sha256}`
      )
    }
  }

  const identity = buildExtractionCandidateIdentity({
    originalFile: input.originalFile,
    extractionResultSha256: input.extractionResultSha256,
    parserType: input.parserType,
    parserConfigVersion: input.parserConfigVersion,
    evidenceVersion: input.evidenceVersion,
    pageCount: input.pageCount,
    previews: pages.map((page) => previews.get(page)!),
  })

  const records: PdfPageEvidenceRecord[] = []
  const exceptionPages: number[] = []
  const textlessPages: number[] = []
  let pagesWithText = 0

  for (const page of pages) {
    const source = texts.get(page)!
    const preview = previews.get(page)!
    const warnings = [...source.warnings, ...preview.warnings]

    // The render subprocess' own per-page failures are page evidence too.
    const exceptions: PdfEvidenceException[] = source.exceptions.map((exception) => ({
      ...exception,
      page,
    }))
    for (const entry of preview.exceptions) {
      if (exceptions.some((existing) => existing.code === entry.code && existing.message === entry.message)) {
        continue
      }
      exceptions.push({ page, code: entry.code, message: entry.message, stage: "page_render" })
    }

    let status = source.status
    if (exceptions.length > 0 && status !== "extracted") status = "extraction_exception"

    let textLayerAbsent = source.textLayerAbsent
    if (!textLayerAbsent && status !== "extracted" && preview.observedTextLayerAbsent) {
      // The extractor's own read failed on this page; the render's independent
      // read of the same page found no text. That is an observation, so the
      // absence may be declared — with the exception kept alongside it.
      textLayerAbsent = true
    }
    if (textLayerAbsent && status !== "extracted" && !preview.observedTextLayerAbsent) {
      throw new PageEvidenceError(
        "text_layer_observation_conflict",
        `page ${page}: the text layer was declared absent, but rendering that page found a text layer — the absence is not ours to invent`
      )
    }

    if (status === "extracted") pagesWithText += 1
    if (exceptions.length > 0) exceptionPages.push(page)
    if (textLayerAbsent) textlessPages.push(page)

    records.push(
      Object.freeze({
        page,
        text: Object.freeze({
          ...source,
          page,
          status,
          textLayerAbsent,
          warnings,
          exceptions,
        }) as PdfPageTextRecord,
        preview: Object.freeze({
          ...preview,
          page,
          origin: PDF_PAGE_PREVIEW_ORIGIN,
          sourceFileSha256: identity.originalFile.sha256,
          candidateId: identity.candidateId,
          [PDF_PAGE_PREVIEW_BRAND]: true,
        }) as PdfPagePreviewRecord,
      })
    )
  }

  const localTextEmptyForAllPages = records.every((record) => record.text.text === "")

  return Object.freeze({
    schemaVersion: PDF_PAGE_EVIDENCE_SCHEMA_VERSION,
    evidenceVersion: identity.evidenceVersion,
    identity,
    declaredPageCount: input.pageCount,
    pages: Object.freeze(records),
    documentWarnings: Object.freeze([...(input.documentWarnings ?? [])]),
    documentExceptions: Object.freeze([...(input.documentExceptions ?? [])]),
    pagesWithText,
    exceptionPages: Object.freeze(exceptionPages),
    textlessPages: Object.freeze(textlessPages),
    localTextEmptyForAllPages,
    ocrDecisionRequired: localTextEmptyForAllPages,
  })
}

/**
 * The only content this bundle offers toward indexing: page text, and nothing
 * else. Previews are structurally absent — no parameter, field or conversion
 * here can carry image bytes into a block set.
 */
export function indexedPageTextsForNormalization(
  bundle: PdfExtractionEvidenceBundle
): readonly { page: number; text: string }[] {
  return Object.freeze(
    bundle.pages
      .filter((record) => record.text.text !== "")
      .map((record) => Object.freeze({ page: record.page, text: record.text.text }))
  )
}
