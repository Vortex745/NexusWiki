// Ticket UT-09: durable extraction evidence repository.
//
// The evidence contract (UP-04): the RAW extraction (before cleaning), its
// own hash, the parser configuration fingerprint, per-page coverage and
// warnings are persisted per (docId, version) and stay readable — byte-for-
// byte — across process restarts. Cleaning never overwrites this record.
// Reads validate the record (hash, schema version, presence) so half-written
// or tampered rows can never serve as a verification cache (UT-19 consumes
// this judgement).
import { createHash } from "node:crypto"
import { PDF_PAGE_PREVIEW_ORIGIN } from "../../types/normalized_block"
import type { PdfExtractionEvidenceBundle } from "../page_evidence/page_evidence"
import type { DB } from "./db"

export const EXTRACTION_EVIDENCE_SCHEMA_VERSION = 1

/**
 * Ticket 05: the durable binding between a page of the original and the preview
 * derived from it. Only the identity of the render is stored here — the image
 * bytes belong to the evidence envelope (ticket 06) and are never indexable
 * content, which is why the record keeps its `derived_preview` origin.
 */
export interface ExtractionPagePreviewBinding {
  page: number
  mediaType: string
  sha256: string
  byteLength: number
  width: number
  height: number
  origin: typeof PDF_PAGE_PREVIEW_ORIGIN
  /** sha256 of the ORIGINAL document the page was rendered from. */
  sourceFileSha256: string
}

export interface ExtractionPageEvidenceException {
  page?: number | null
  code: string
  message: string
  stage: string
}

export interface ExtractionPageEvidence {
  /** 1-based page number; null for parsers without page structure. */
  page: number | null
  blockCount: number
  textChars: number
  /** e.g. "unextracted_no_text_layer_or_empty" — honest, never fabricated. */
  status: "extracted" | "unextracted_no_text_layer_or_empty"
  /** 区分真实空白、未提取、异常与缺非文本能力的说明（未知如实写未知）。 */
  note?: string
  /** Ticket 05: declared from what the extractor actually saw on this page. */
  textLayerAbsent?: boolean
  /** Ticket 05: the preview derived from this page of the original file. */
  preview?: ExtractionPagePreviewBinding
  /** Ticket 05: per-page extraction/render exceptions kept as evidence. */
  exceptions?: ExtractionPageEvidenceException[]
}

export interface ExtractionEvidenceRecord {
  docId: string
  version: number
  schemaVersion: number
  parserType: string
  parserConfigVersion: string
  rawExtraction: string
  rawExtractionSha256: string
  warnings: string[]
  pages: ExtractionPageEvidence[]
  pageCount: number | null
  completedAt: string
}

export interface ExtractionEvidenceReadResult {
  artifact: ExtractionEvidenceRecord
  /**
   * UT-09 AC 3: a record whose hash mismatches, whose schema version is
   * unknown, or that is missing fields is NOT a valid verification cache.
   */
  valid: boolean
  invalidReason?: string
}

interface ExtractionRow {
  doc_id: string
  version: number
  schema_version: number
  parser_type: string
  parser_config_version: string
  raw_extraction: string
  raw_extraction_sha256: string
  warnings_json: string
  pages_json: string
  page_count: number | null
  completed_at: string
}

function rowToRecord(row: ExtractionRow): ExtractionEvidenceRecord {
  let warnings: string[] = []
  let pages: ExtractionPageEvidence[] = []
  try {
    warnings = JSON.parse(row.warnings_json) as string[]
  } catch {
    warnings = []
  }
  try {
    pages = JSON.parse(row.pages_json) as ExtractionPageEvidence[]
  } catch {
    pages = []
  }
  return {
    docId: row.doc_id,
    version: row.version,
    schemaVersion: row.schema_version,
    parserType: row.parser_type,
    parserConfigVersion: row.parser_config_version,
    rawExtraction: row.raw_extraction,
    rawExtractionSha256: row.raw_extraction_sha256,
    warnings,
    pages,
    pageCount: row.page_count,
    completedAt: row.completed_at,
  }
}

export class ExtractionEvidenceRepository {
  constructor(private db: DB) {}

  record(entry: ExtractionEvidenceRecord): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO extraction_artifacts
        (doc_id, version, schema_version, parser_type, parser_config_version,
         raw_extraction, raw_extraction_sha256, warnings_json, pages_json,
         page_count, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.docId,
      entry.version,
      entry.schemaVersion,
      entry.parserType,
      entry.parserConfigVersion,
      entry.rawExtraction,
      entry.rawExtractionSha256,
      JSON.stringify(entry.warnings),
      JSON.stringify(entry.pages),
      entry.pageCount,
      entry.completedAt
    )
  }

  /**
   * Read the evidence for a document version (latest when omitted). The read
   * validates the record — a hash mismatch, an unknown schema version or a
   * missing field marks the row invalid so it can never be used as a
   * verification cache, and the original stays readable via the artifact.
   */
  get(docId: string, version?: number): ExtractionEvidenceReadResult | null {
    const row = version === undefined
      ? this.db.prepare(
          "SELECT * FROM extraction_artifacts WHERE doc_id = ? ORDER BY version DESC LIMIT 1"
        ).get(docId) as ExtractionRow | undefined
      : this.db.prepare(
          "SELECT * FROM extraction_artifacts WHERE doc_id = ? AND version = ?"
        ).get(docId, version) as ExtractionRow | undefined
    if (!row) return null

    const artifact = rowToRecord(row)
    const problems: string[] = []
    const actualHash = createHash("sha256")
      .update(Buffer.from(artifact.rawExtraction, "utf8"))
      .digest("hex")
    if (actualHash !== artifact.rawExtractionSha256) {
      problems.push("raw_extraction_hash_mismatch")
    }
    if (artifact.schemaVersion !== EXTRACTION_EVIDENCE_SCHEMA_VERSION) {
      problems.push("schema_version_mismatch")
    }
    if (!artifact.parserType || !artifact.parserConfigVersion) {
      problems.push("missing_parser_or_config_identity")
    }
    if (!artifact.completedAt) {
      problems.push("missing_completion_marker")
    }
    return {
      artifact,
      valid: problems.length === 0,
      ...(problems.length > 0 ? { invalidReason: problems.join(";") } : {}),
    }
  }
}

/** 逐页覆盖证据：从归一化块汇总；无块的页如实记为未提取（不伪造跨度）。 */
export function buildPageEvidence(
  blocks: Array<{ page?: number; text: string }>,
  pageCount: number | null,
  warnings: string[]
): ExtractionPageEvidence[] {
  const byPage = new Map<number, { blockCount: number; textChars: number }>()
  for (const block of blocks) {
    if (typeof block.page !== "number") continue
    const existing = byPage.get(block.page) ?? { blockCount: 0, textChars: 0 }
    existing.blockCount += 1
    existing.textChars += block.text.length
    byPage.set(block.page, existing)
  }
  const pages: ExtractionPageEvidence[] = []
  const highestPage = pageCount ?? (byPage.size > 0 ? Math.max(...byPage.keys()) : null)
  if (highestPage !== null) {
    for (let page = 1; page <= highestPage; page += 1) {
      const extracted = byPage.get(page)
      if (extracted) {
        pages.push({ page, blockCount: extracted.blockCount, textChars: extracted.textChars, status: "extracted" })
      } else {
        pages.push({
          page,
          blockCount: 0,
          textChars: 0,
          status: "unextracted_no_text_layer_or_empty",
          note: warnings.length > 0
            ? "no text blocks; low text-layer coverage warning present — likely scanned, OCR capability required"
            : "no text blocks; cause unknown (genuinely empty page or non-text content without an OCR-capable parser)",
        })
      }
    }
  }
  for (const [page, extracted] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    if (highestPage !== null && page <= highestPage) continue
    pages.push({ page, blockCount: extracted.blockCount, textChars: extracted.textChars, status: "extracted" })
  }
  return pages
}

export class PageEvidenceBindingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "PageEvidenceBindingError"
  }
}

export interface BindPreviewEvidenceOptions {
  /** Rejects a bundle produced by a different evidence version than the caller expects. */
  evidenceVersion?: string
}

/**
 * Ticket 05: bind each page's derived preview into that page's durable evidence
 * row — one per page, matched by page number, with the exception records the
 * bundle carried. A page whose preview has no text record (or the reverse) is a
 * failure here; nothing is bound to the neighbouring page and nothing is
 * dropped quietly.
 */
export function bindPreviewEvidence(
  pages: readonly ExtractionPageEvidence[],
  bundle: PdfExtractionEvidenceBundle,
  options: BindPreviewEvidenceOptions = {}
): ExtractionPageEvidence[] {
  if (
    options.evidenceVersion !== undefined &&
    options.evidenceVersion !== bundle.evidenceVersion
  ) {
    throw new PageEvidenceBindingError(
      "evidence_version_mismatch",
      `the page evidence is ${bundle.evidenceVersion} but the caller bound evidence version ${options.evidenceVersion}`
    )
  }
  if (pages.some((page) => page.preview)) {
    throw new PageEvidenceBindingError(
      "page_preview_already_bound",
      "these page records already carry a preview binding"
    )
  }

  const rowsByPage = new Map<number, ExtractionPageEvidence>()
  for (const row of pages) {
    if (typeof row.page !== "number") {
      throw new PageEvidenceBindingError(
        "page_preview_binding_unpaired",
        "previews can only bind to page-structured evidence rows"
      )
    }
    if (rowsByPage.has(row.page)) {
      throw new PageEvidenceBindingError(
        "page_preview_binding_unpaired",
        `page ${row.page} appears twice in the evidence rows`
      )
    }
    rowsByPage.set(row.page, row)
  }

  const bound: ExtractionPageEvidence[] = []
  for (const record of bundle.pages) {
    const row = rowsByPage.get(record.page)
    if (!row) {
      throw new PageEvidenceBindingError(
        "page_preview_binding_unpaired",
        `page ${record.page} has preview evidence but no durable page row`
      )
    }
    if (record.preview.page !== record.page || record.text.page !== record.page) {
      throw new PageEvidenceBindingError(
        "page_preview_binding_unpaired",
        `page ${record.page}'s evidence carries a preview numbered ${record.preview.page}`
      )
    }
    if (record.preview.sourceFileSha256 !== bundle.identity.originalFile.sha256) {
      throw new PageEvidenceBindingError(
        "preview_source_binding_mismatch",
        `page ${record.page}'s preview is not bound to this candidate's original file`
      )
    }
    bound.push({
      ...row,
      textLayerAbsent: record.text.textLayerAbsent,
      exceptions: record.text.exceptions.map((exception) => ({
        page: record.page,
        code: exception.code,
        message: exception.message,
        stage: exception.stage,
      })),
      preview: Object.freeze({
        page: record.page,
        mediaType: record.preview.mediaType,
        sha256: record.preview.sha256,
        byteLength: record.preview.byteLength,
        width: record.preview.width,
        height: record.preview.height,
        origin: record.preview.origin,
        sourceFileSha256: record.preview.sourceFileSha256,
      }),
    })
    rowsByPage.delete(record.page)
  }
  const orphaned = [...rowsByPage.keys()].sort((left, right) => left - right)
  if (orphaned.length > 0) {
    throw new PageEvidenceBindingError(
      "page_preview_binding_unpaired",
      `page ${orphaned.join(", ")} has a durable row but no page evidence`
    )
  }
  return bound.sort((left, right) => (left.page ?? 0) - (right.page ?? 0))
}
