import { createHash } from "node:crypto"
import { CLEF_REQUEST_LIMITS } from "../../clef/protocol_limits"
import { QualityContractError, assertQualityPageNumber, type QualityContractErrorCode } from "./contract"

export type QualityImageMediaType = "image/png" | "image/jpeg"

export interface QualityPageImageEvidence {
  page: number
  mediaType: QualityImageMediaType
  /** Raw base64 of the rendered page image — a path, filename or metadata record is not evidence. */
  dataBase64: string
  byteLength: number
  sha256: string
  width: number
  height: number
}

export interface QualityPageEvidence {
  page: number
  image: QualityPageImageEvidence
  /** Verbatim local text layer for this page. Empty only when textLayerAbsent is declared. */
  extractedText: string
  textLayerAbsent: boolean
}

/**
 * Page-image ceilings for one Clef quality batch. The wire limits (images per request, decoded
 * bytes per image, aggregate decoded bytes, request body) come from the shared Clef protocol
 * table so both Clef callers enforce the same numbers; the readability floors are quality-side.
 */
export const CLEF_IMAGE_LIMITS = Object.freeze({
  maxImagesPerRequest: CLEF_REQUEST_LIMITS.maxImagesPerRequest,
  maxImageBytes: CLEF_REQUEST_LIMITS.maxImageBytes,
  maxAggregateImageBytes: CLEF_REQUEST_LIMITS.maxAggregateImageBytes,
  maxRequestBytes: CLEF_REQUEST_LIMITS.maxRequestBytes,
  maxImagePixels: 16_000_000,
  minImageEdgePixels: 32,
})

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const BASE64_ONLY = /^[A-Za-z0-9+/]*={0,2}$/
const PLACEHOLDER_TEXT =
  /^(?:\.{3}|…|\[[^\]]{0,64}\]|\{[^}]{0,64}\}|<[^>]{0,64}>|n\/a|na|nil|null|undefined|todo|tbd|placeholder|image|metadata(?: ?only)?|see (?:the )?(?:page|image)[ \w]*)$/i

function fail(code: QualityContractErrorCode, message: string): never {
  throw new QualityContractError(code, message)
}

function decodeImage(image: QualityPageImageEvidence, page: number): Buffer {
  if (typeof image.dataBase64 !== "string" || image.dataBase64.trim() === "") {
    fail("image_bytes_missing", `page ${page}: image evidence carries no bytes`)
  }
  const encoded = image.dataBase64
  if (!BASE64_ONLY.test(encoded) || encoded.length % 4 !== 0) {
    fail("image_base64_invalid", `page ${page}: image evidence is not canonical base64`)
  }
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.toString("base64") !== encoded) {
    fail("image_base64_invalid", `page ${page}: image evidence is not canonical base64`)
  }
  if (bytes.length === 0) fail("image_bytes_missing", `page ${page}: image evidence carries no bytes`)
  if (bytes.length !== image.byteLength) {
    fail("image_size_mismatch", `page ${page}: image declares ${image.byteLength} bytes but carries ${bytes.length}`)
  }
  if (createHash("sha256").update(bytes).digest("hex") !== image.sha256) {
    fail("image_digest_mismatch", `page ${page}: image digest does not match the transmitted bytes`)
  }
  if (bytes.length > CLEF_IMAGE_LIMITS.maxImageBytes) {
    fail("image_too_large", `page ${page}: image exceeds the ${CLEF_IMAGE_LIMITS.maxImageBytes} byte Clef limit`)
  }
  return bytes
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail("image_content_invalid", "image evidence does not start with a PNG signature")
  }
  let offset = 8
  let width = 0
  let height = 0
  let sawIhdr = false
  let sawIend = false
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString("ascii", offset + 4, offset + 8)
    const dataStart = offset + 8
    if (dataStart + length + 4 > bytes.length) {
      fail("image_content_truncated", "PNG image is truncated inside a chunk")
    }
    if (type === "IHDR") {
      sawIhdr = true
      if (length !== 13) fail("image_content_invalid", "PNG IHDR chunk is malformed")
      width = bytes.readUInt32BE(dataStart)
      height = bytes.readUInt32BE(dataStart + 4)
    } else if (type === "IEND") {
      sawIend = true
      break
    }
    offset = dataStart + length + 4
  }
  if (!sawIhdr) fail("image_content_invalid", "PNG image carries no IHDR header")
  if (!sawIend) fail("image_content_truncated", "PNG image carries no IEND terminator")
  return { width, height }
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    fail("image_content_invalid", "image evidence does not start with a JPEG signature")
  }
  if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    fail("image_content_truncated", "JPEG image carries no end-of-image marker")
  }
  let offset = 2
  let width = 0
  let height = 0
  let sawSof = false
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) fail("image_content_invalid", "JPEG marker stream is malformed")
    const marker = bytes[offset + 1]
    if (marker === 0xd9) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = bytes.readUInt16BE(offset + 2)
    if (length < 2 || offset + 2 + length > bytes.length) {
      fail("image_content_truncated", "JPEG image is truncated inside a segment")
    }
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isStartOfFrame) {
      sawSof = true
      height = bytes.readUInt16BE(offset + 5)
      width = bytes.readUInt16BE(offset + 7)
      break
    }
    offset += 2 + length
  }
  if (!sawSof) fail("image_content_invalid", "JPEG image carries no start-of-frame header")
  return { width, height }
}

function validateImage(image: QualityPageImageEvidence, page: number): QualityPageImageEvidence {
  if (image.page !== page) {
    fail("image_page_mismatch", `image evidence is bound to page ${image.page} but the text belongs to page ${page}`)
  }
  if (image.mediaType !== "image/png" && image.mediaType !== "image/jpeg") {
    fail("image_media_type_invalid", `page ${page}: unsupported image media type declaration`)
  }
  const bytes = decodeImage(image, page)
  const isPng = bytes.subarray(0, 8).equals(PNG_SIGNATURE)
  const isJpeg = !isPng && bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8
  if (!isPng && !isJpeg) {
    fail("image_content_invalid", `page ${page}: image bytes are not a decodable PNG or JPEG page render`)
  }
  if ((isPng ? "image/png" : "image/jpeg") !== image.mediaType) {
    fail("image_media_type_mismatch", `page ${page}: declared media type does not match the image bytes`)
  }
  const dimensions = isPng ? pngDimensions(bytes) : jpegDimensions(bytes)
  if (dimensions.width !== image.width || dimensions.height !== image.height) {
    fail("image_resolution_mismatch", `page ${page}: declared resolution does not match the image header`)
  }
  if (image.width < CLEF_IMAGE_LIMITS.minImageEdgePixels || image.height < CLEF_IMAGE_LIMITS.minImageEdgePixels) {
    fail("image_resolution_invalid", `page ${page}: image is too small for the model to read`)
  }
  if (image.width * image.height > CLEF_IMAGE_LIMITS.maxImagePixels) {
    fail("image_resolution_too_large", `page ${page}: image exceeds the ${CLEF_IMAGE_LIMITS.maxImagePixels} pixel Clef limit`)
  }
  return image
}

function validateText(evidence: QualityPageEvidence): void {
  const { page, extractedText, textLayerAbsent } = evidence
  if (typeof extractedText !== "string") {
    fail("text_placeholder", `page ${page}: extracted text is missing from the evidence`)
  }
  if (typeof textLayerAbsent !== "boolean") {
    fail("text_declaration_conflict", `page ${page}: text layer absence is not declared`)
  }
  const hasText = extractedText.trim().length > 0
  if (!textLayerAbsent && !hasText) {
    fail("text_placeholder", `page ${page}: text is present-less but the text layer is not declared absent`)
  }
  if (textLayerAbsent && extractedText.length > 0) {
    fail("text_declaration_conflict", `page ${page}: a declared absent text layer must carry no text at all`)
  }
  if (!textLayerAbsent && PLACEHOLDER_TEXT.test(extractedText.trim())) {
    fail("text_placeholder", `page ${page}: extracted text is a placeholder marker`)
  }
}

/**
 * Grounds one Clef quality batch: every page must carry decodable image bytes that match
 * their declared digest, size and resolution, plus that page's own extracted text.
 */
export function validateQualityPages(pages: readonly QualityPageEvidence[]): readonly QualityPageEvidence[] {
  if (!Array.isArray(pages) || pages.length === 0) {
    fail("empty_page_set", "quality evaluation requires at least one page of evidence")
  }
  const seen = new Set<number>()
  let aggregateBytes = 0
  const validated: QualityPageEvidence[] = []
  for (const evidence of pages) {
    if (!evidence || typeof evidence !== "object" || !evidence.image) {
      fail("image_bytes_missing", `page ${String(evidence?.page)}: evidence carries no page image`)
    }
    assertQualityPageNumber(evidence.page, "evidence page")
    if (seen.has(evidence.page)) fail("duplicate_page", `page ${evidence.page} appears twice in the batch`)
    seen.add(evidence.page)
    const image = validateImage(evidence.image, evidence.page)
    validateText(evidence)
    aggregateBytes += image.byteLength
    validated.push(Object.freeze({ ...evidence, image: Object.freeze({ ...image }) }))
  }
  if (aggregateBytes > CLEF_IMAGE_LIMITS.maxAggregateImageBytes) {
    fail("image_aggregate_too_large", `batch images total ${aggregateBytes} bytes over the Clef ${CLEF_IMAGE_LIMITS.maxAggregateImageBytes} byte limit`)
  }
  return Object.freeze(validated)
}
