// Ticket 05 → ticket 01 bridge: page evidence in the shape Clef grounds.
//
// A textless page becomes EMPTY local text plus a declared absent text layer,
// which is what the quality contract accepts — so a scan reaches the quality
// evaluation instead of being rejected for having no text. A page whose text
// layer was never observed cannot be turned into evidence here: the alternative
// would be inventing either the text or the absence.
import {
  CLEF_IMAGE_LIMITS,
  type QualityPageEvidence,
  type QualityPageImageEvidence,
} from "../quality/evidence"
import type { PdfExtractionEvidenceBundle, PdfPageEvidenceRecord } from "./page_evidence"

export const QUALITY_EVIDENCE_UNAVAILABLE = "page_evidence_unavailable"

export class QualityEvidenceUnavailableError extends Error {
  readonly code = QUALITY_EVIDENCE_UNAVAILABLE

  constructor(readonly pages: readonly number[], message: string) {
    super(message)
    this.name = "QualityEvidenceUnavailableError"
  }
}

/** Ticket 12: the page-image evidence a page record grounds — shared with the OCR fallback path. */
export function imageEvidence(record: PdfPageEvidenceRecord): QualityPageImageEvidence {
  const preview = record.preview
  return {
    page: preview.page,
    mediaType: preview.mediaType,
    dataBase64: preview.dataBase64,
    byteLength: preview.byteLength,
    sha256: preview.sha256,
    width: preview.width,
    height: preview.height,
  }
}

function qualityEvidenceFor(record: PdfPageEvidenceRecord): QualityPageEvidence | null {
  const { text } = record
  if (text.text !== "") {
    return {
      page: record.page,
      image: imageEvidence(record),
      extractedText: text.text,
      textLayerAbsent: false,
    }
  }
  if (text.textLayerAbsent) {
    // Empty local text, declared from an observation — exactly what a scan
    // must arrive as so the OCR decision can be the one that rules on it.
    return {
      page: record.page,
      image: imageEvidence(record),
      extractedText: "",
      textLayerAbsent: true,
    }
  }
  return null
}

/**
 * Every page of the bundle, in page order, as grounded Clef quality evidence.
 * Refuses with the page numbers it could not ground rather than dropping them.
 */
export function deriveQualityPageEvidence(
  bundle: PdfExtractionEvidenceBundle
): readonly QualityPageEvidence[] {
  const pages: QualityPageEvidence[] = []
  const ungroundable: number[] = []
  for (const record of bundle.pages) {
    const evidence = qualityEvidenceFor(record)
    if (!evidence) {
      ungroundable.push(record.page)
      continue
    }
    pages.push(evidence)
  }
  if (ungroundable.length > 0) {
    throw new QualityEvidenceUnavailableError(
      ungroundable,
      `page ${ungroundable.join(", ")} of this candidate has no extractable text and no observed text-layer absence — it cannot be sent to quality evaluation as empty evidence`
    )
  }
  return pages
}

/**
 * Splits page evidence into quality requests, one page per request. Measured on live Clef
 * (`stability-probe`/`multi-page-batch-probe`): byte-identical page + text flips verdict with
 * batch composition, deterministically — so a page is only ever judged alone, which also
 * removes the position effect and the multi-page pairing violations. Pages keep their order
 * and none is dropped; over-limit input splits, it is never truncated.
 */
export function splitQualityPageEvidence(
  pages: readonly QualityPageEvidence[],
  limits: { maxPages?: number; maxAggregateBytes?: number } = {}
): readonly (readonly QualityPageEvidence[])[] {
  const maxPages = limits.maxPages ?? 1
  const maxAggregateBytes = limits.maxAggregateBytes ?? CLEF_IMAGE_LIMITS.maxAggregateImageBytes
  const batches: Array<readonly QualityPageEvidence[]> = []
  let current: QualityPageEvidence[] = []
  let aggregate = 0

  for (const page of pages) {
    const exceedsBatch =
      current.length > 0 &&
      (current.length + 1 > maxPages || aggregate + page.image.byteLength > maxAggregateBytes)
    if (exceedsBatch) {
      batches.push(Object.freeze(current))
      current = []
      aggregate = 0
    }
    if (page.image.byteLength > maxAggregateBytes) {
      throw new QualityEvidenceUnavailableError(
        [page.page],
        `page ${page.page} image alone is ${page.image.byteLength} bytes over the ${maxAggregateBytes} byte aggregate ceiling — it was not truncated`
      )
    }
    current.push(page)
    aggregate += page.image.byteLength
  }
  if (current.length > 0) batches.push(Object.freeze(current))
  return Object.freeze(batches)
}
