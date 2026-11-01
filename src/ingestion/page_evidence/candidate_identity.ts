// Ticket 05 AC 4/5: candidate identity.
//
// A candidate text result is identified by five bound elements — the original
// file, the extraction result hash, the parser and its configuration, the
// declared page count, and the evidence version — plus the digest of the
// preview set derived from that same original. The candidate id is a canonical
// digest over exactly those elements: stable for identical inputs, and changed
// by any single substitution.
import { createHash } from "node:crypto"
import type { OriginalFileIdentity } from "../source_identity"
import type { RenderedPagePreview } from "./preview_renderer"

export const CANDIDATE_IDENTITY_SCHEMA_VERSION = 1

/** Bumped whenever the page-evidence shape or its derivation rules change. */
export const PDF_EVIDENCE_VERSION = "pdf-page-evidence-v1"

export type CandidateIdentityErrorCode =
  | "original_file_identity_invalid"
  | "extraction_result_hash_invalid"
  | "parser_identity_missing"
  | "page_count_invalid"
  | "evidence_version_invalid"
  | "preview_set_missing"
  | "preview_page_duplicate"
  | "preview_page_count_mismatch"
  | "preview_digest_invalid"
  | "preview_substituted_for_original"

export class CandidateIdentityError extends Error {
  constructor(readonly code: CandidateIdentityErrorCode, message: string) {
    super(message)
    this.name = "CandidateIdentityError"
  }
}

const DIGEST = /^[0-9a-f]{64}$/

export interface ExtractionCandidateIdentityInput {
  /** 1 — the uploaded document itself. */
  originalFile: OriginalFileIdentity
  /** 2 — hash of the raw extraction result this candidate was built from. */
  extractionResultSha256: string
  /** 3 — parser and parser configuration identity. */
  parserType: string
  parserConfigVersion: string
  /** 4 — the page count the document declared. */
  pageCount: number
  /** 5 — the evidence version that produced this candidate. */
  evidenceVersion?: string
  /** The derived previews bound to the pages above. */
  previews: readonly (RenderedPagePreview | { page: number; sha256: string })[]
}

export interface ExtractionCandidateIdentity {
  schemaVersion: number
  candidateId: string
  originalFile: OriginalFileIdentity
  extractionResultSha256: string
  parserType: string
  parserConfigVersion: string
  pageCount: number
  evidenceVersion: string
  previewSetSha256: string
}

function requireDigest(value: unknown, code: CandidateIdentityErrorCode, label: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new CandidateIdentityError(code, `${label} must be a sha256 hex digest, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Page-bound digest of the preview set: each entry is `page:digest`, sorted by
 * page number so array order is irrelevant, but a preview swapped onto a
 * different page changes the digest — the binding is part of the identity.
 */
export function computePreviewSetDigest(
  previews: readonly { page: number; sha256: string }[]
): string {
  if (!Array.isArray(previews) || previews.length === 0) {
    throw new CandidateIdentityError("preview_set_missing", "a candidate binds at least one page preview")
  }
  const seen = new Set<number>()
  const lines: string[] = []
  for (const preview of previews) {
    if (!preview || typeof preview.page !== "number" || !Number.isSafeInteger(preview.page) || preview.page < 1) {
      throw new CandidateIdentityError("preview_digest_invalid", "every preview needs a 1-based page number")
    }
    if (seen.has(preview.page)) {
      throw new CandidateIdentityError("preview_page_duplicate", `page ${preview.page} contributes more than one preview`)
    }
    seen.add(preview.page)
    lines.push(`${preview.page}:${requireDigest(preview.sha256, "preview_digest_invalid", `page ${preview.page} preview digest`)}`)
  }
  lines.sort((left, right) => Number(left.split(":")[0]) - Number(right.split(":")[0]))
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex")
}

/**
 * The stable identity of one candidate text result. Every element is validated
 * before an id is issued, so an identity can never be built on a missing page
 * count, an unnamed parser or a preview standing in for the original file.
 */
export function buildExtractionCandidateIdentity(
  input: ExtractionCandidateIdentityInput
): ExtractionCandidateIdentity {
  const originalFile = input.originalFile
  if (!originalFile || typeof originalFile !== "object") {
    throw new CandidateIdentityError("original_file_identity_invalid", "the candidate needs the original file identity")
  }
  requireDigest(originalFile.sha256, "original_file_identity_invalid", "original file digest")
  if (!Number.isSafeInteger(originalFile.byteLength) || originalFile.byteLength < 1) {
    throw new CandidateIdentityError("original_file_identity_invalid", "the original file identity needs its byte length")
  }

  requireDigest(input.extractionResultSha256, "extraction_result_hash_invalid", "extraction result digest")

  const parserType = typeof input.parserType === "string" ? input.parserType.trim() : ""
  const parserConfigVersion =
    typeof input.parserConfigVersion === "string" ? input.parserConfigVersion.trim() : ""
  if (!parserType || !parserConfigVersion) {
    throw new CandidateIdentityError(
      "parser_identity_missing",
      "a candidate binds the parser type and its configuration identity"
    )
  }

  if (!Number.isSafeInteger(input.pageCount) || input.pageCount < 1) {
    throw new CandidateIdentityError(
      "page_count_invalid",
      `a candidate declares a positive whole page count, got ${String(input.pageCount)}`
    )
  }

  const evidenceVersion =
    input.evidenceVersion === undefined ? PDF_EVIDENCE_VERSION : input.evidenceVersion.trim()
  if (!evidenceVersion) {
    throw new CandidateIdentityError("evidence_version_invalid", "a candidate declares the evidence version that produced it")
  }

  if (!Array.isArray(input.previews) || input.previews.length === 0) {
    throw new CandidateIdentityError(
      "preview_set_missing",
      `a candidate declaring ${input.pageCount} pages must bind their previews`
    )
  }
  if (input.previews.length !== input.pageCount) {
    throw new CandidateIdentityError(
      "preview_page_count_mismatch",
      `${input.previews.length} previews cannot cover a document that declares ${input.pageCount} pages`
    )
  }
  const previewSetSha256 = computePreviewSetDigest(input.previews)

  for (const preview of input.previews) {
    if (preview.sha256 === originalFile.sha256) {
      throw new CandidateIdentityError(
        "preview_substituted_for_original",
        `page ${preview.page}'s derived preview carries the original file digest — a render is not the document`
      )
    }
  }

  const canonical = [
    "pdf-candidate-identity-v1",
    evidenceVersion,
    parserType,
    parserConfigVersion,
    String(input.pageCount),
    originalFile.sha256,
    String(originalFile.byteLength),
    originalFile.sourceKey ?? "",
    originalFile.fileName ?? "",
    requireDigest(input.extractionResultSha256, "extraction_result_hash_invalid", "extraction result digest"),
    previewSetSha256,
  ].join("\u0000")

  return Object.freeze({
    schemaVersion: CANDIDATE_IDENTITY_SCHEMA_VERSION,
    candidateId: createHash("sha256").update(canonical, "utf8").digest("hex"),
    originalFile: Object.freeze({ ...originalFile }),
    extractionResultSha256: input.extractionResultSha256,
    parserType,
    parserConfigVersion,
    pageCount: input.pageCount,
    evidenceVersion,
    previewSetSha256,
  })
}
