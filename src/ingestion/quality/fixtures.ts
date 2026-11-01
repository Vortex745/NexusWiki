import { createHash } from "node:crypto"
import { deflateSync } from "node:zlib"
import type { QualityImageMediaType, QualityPageEvidence, QualityPageImageEvidence } from "./evidence"
import { QUALITY_JOINT_LABELS, type PageQualityObservation, type QualityIssueType, type QualityJointLabel, type QualityVerdict } from "./contract"

/** Scripted evidence at the evaluator seam, never used to repair provider responses. */
export function jointObservation(verdict: QualityVerdict, issueType?: QualityIssueType, confidence = 0.8): PageQualityObservation {
  const choice = (verdict === "pass" ? "pass_no_issue" : `${verdict}_${issueType ?? "missing_content"}`) as QualityJointLabel
  return { jointDecision: { type: "choice", choice, probabilities: Object.fromEntries(QUALITY_JOINT_LABELS.map((label) => [label, label === choice ? 0.9 : 0.0125])) as Record<QualityJointLabel, number>, confidence } }
}

export function jointChoices(choice: string) {
  return choiceAnswer(choice, QUALITY_JOINT_LABELS)
}

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

function pngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length, 0)
  header.write(type, 4, "ascii")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0)
  return Buffer.concat([header, data, crc])
}

const PNG_IDAT = deflateSync(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]))

export const SYNTHETIC_PAGE_WIDTH = 64
export const SYNTHETIC_PAGE_HEIGHT = 48

export function syntheticPng(options: { width?: number; height?: number; extraBytes?: number; truncated?: boolean } = {}): Buffer {
  const width = options.width ?? SYNTHETIC_PAGE_WIDTH
  const height = options.height ?? SYNTHETIC_PAGE_HEIGHT
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const chunks: Buffer[] = [PNG_SIGNATURE, pngChunk("IHDR", ihdr)]
  if (options.extraBytes) chunks.push(pngChunk("prIv", Buffer.alloc(options.extraBytes, 0x5a)))
  chunks.push(pngChunk("IDAT", PNG_IDAT))
  if (!options.truncated) chunks.push(pngChunk("IEND", Buffer.alloc(0)))
  return Buffer.concat(chunks)
}

function uint16(value: number): Buffer {
  const out = Buffer.alloc(2)
  out.writeUInt16BE(value, 0)
  return out
}

export function syntheticJpeg(options: { width?: number; height?: number; extraBytes?: number; truncated?: boolean } = {}): Buffer {
  const width = options.width ?? SYNTHETIC_PAGE_WIDTH
  const height = options.height ?? SYNTHETIC_PAGE_HEIGHT
  const sof = Buffer.alloc(9)
  sof[0] = 8
  sof.writeUInt16BE(height, 1)
  sof.writeUInt16BE(width, 3)
  sof[5] = 1
  sof[6] = 1
  sof[7] = 0x11
  const comment = Buffer.alloc(options.extraBytes ?? 0, 0x41)
  const segments: Buffer[] = [Buffer.from([0xff, 0xd8])]
  if (options.extraBytes) {
    segments.push(Buffer.from([0xff, 0xfe]), uint16(comment.length + 2), comment)
  }
  segments.push(
    Buffer.from([0xff, 0xe0]), uint16(18),
    Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0]),
    Buffer.from([0xff, 0xc0]), uint16(11), sof,
    Buffer.from([0xff, 0xda]), uint16(8), Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])
  )
  if (!options.truncated) segments.push(Buffer.from([0xff, 0xd9]))
  return Buffer.concat(segments)
}

/** Each page gets distinct image bytes, so a page/image pairing mistake is always observable. */
export function imageEvidence(page: number, patch: Partial<QualityPageImageEvidence> = {}): QualityPageImageEvidence {
  const bytes = syntheticPng({ extraBytes: Number.isSafeInteger(page) && page > 0 ? 1 + (page % 997) : 0 })
  const base = {
    page,
    mediaType: "image/png" as QualityImageMediaType,
    dataBase64: bytes.toString("base64"),
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width: SYNTHETIC_PAGE_WIDTH,
    height: SYNTHETIC_PAGE_HEIGHT,
  }
  return { ...base, ...patch }
}

export function pageEvidence(
  page: number,
  options: { extractedText?: string; textLayerAbsent?: boolean; image?: Partial<QualityPageImageEvidence> } = {}
): QualityPageEvidence {
  const extractedText = options.extractedText ?? `page ${page} body text`
  return {
    page,
    image: imageEvidence(page, options.image ?? {}),
    extractedText,
    textLayerAbsent: options.textLayerAbsent ?? extractedText.trim().length === 0,
  }
}

const VERDICT_PROBABILITIES = { pass: 0.9, fail: 0.05, uncertain: 0.05 }
export const ISSUE_LABELS = ["missing_content", "text_corruption", "reading_order", "structure_loss", "no_issue"] as const

export function choiceAnswer(choice: string, keys: readonly string[], probabilities?: Record<string, number>) {
  const distribution = probabilities ?? Object.fromEntries(keys.map((key) => [key, key === choice ? 0.9 : (1 - 0.9) / (keys.length - 1)])) as Record<string, number>
  return { type: "choice", choice, probabilities: distribution, confidence: 0.8 }
}

export function verdictChoices(choice: "pass" | "fail" | "uncertain") {
  return choiceAnswer(choice, ["pass", "fail", "uncertain"], { ...VERDICT_PROBABILITIES, pass: choice === "pass" ? 0.9 : 0.05, fail: choice === "fail" ? 0.9 : 0.05, uncertain: choice === "uncertain" ? 0.9 : 0.05 })
}

export function issueChoices(choice: string) {
  return choiceAnswer(choice, ISSUE_LABELS)
}
