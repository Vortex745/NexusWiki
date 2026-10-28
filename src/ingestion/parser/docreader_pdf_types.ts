export const DOCREADER_ADAPTER_VERSION = "docreader-pdf-v1"
export const DOCREADER_UPSTREAM_SHA = "256a3f296686"
export const DOCREADER_PROTOCOL = "docreader-readstream-v1"

export interface DocReaderSourceBlockSummary {
  /** Unicode code point offsets into the markdown, end exclusive. */
  start: number
  end: number
  locatorJson: string
  /** Parsed locator; invalid JSON is recorded as a warning and omitted. */
  locator?: Record<string, unknown>
}

export interface DocReaderOcrPageResult {
  page: number
  text: string
  raw: unknown
  warnings: string[]
}

export interface DocReaderImageSummary {
  filename: string
  originalRef: string
  mimeType: string
  byteLength: number
  sha256: string
  /** 1-based page when the image is a scanned full-page render. */
  page: number | null
  kind: "scan" | "figure"
  ocr?: DocReaderOcrPageResult
}

export interface DocReaderRawEnvelope {
  schemaVersion: 1
  adapterVersion: string
  upstreamSha: string
  protocol: string
  forceScanned: boolean
  documentSha256: string
  fileName: string
  markdown: string
  metadata: Record<string, string>
  sourceBlocks: DocReaderSourceBlockSummary[]
  imageCount: number
  images: DocReaderImageSummary[]
  warnings: string[]
}
