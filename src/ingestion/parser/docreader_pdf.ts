import { createHash, randomUUID } from "node:crypto"
import type { NormalizedBlock } from "../../types"
import type { ParseDocumentInput } from "./markitdown"
import {
  DocReaderClient,
  DocReaderError,
  type DocReaderReadRequest,
} from "./docreader_client"
import type { ImageRef__Output } from "./docreader_types/docreader/ImageRef"
import type { ReadStreamResponse__Output } from "./docreader_types/docreader/ReadStreamResponse"
import type { SourceBlock__Output } from "./docreader_types/docreader/SourceBlock"
import { normalizeDocReaderEnvelope, parseDocReaderEnvelope } from "./docreader_pdf_normalize"
import {
  DOCREADER_ADAPTER_VERSION,
  DOCREADER_PROTOCOL,
  DOCREADER_UPSTREAM_SHA,
  type DocReaderImageSummary,
  type DocReaderOcrPageResult,
  type DocReaderRawEnvelope,
  type DocReaderSourceBlockSummary,
} from "./docreader_pdf_types"

export interface DocReaderOcrPageInput {
  image: Buffer
  page: number
  fileName: string
  signal?: AbortSignal
  timeoutMs: number
}

export interface DocReaderClientLike {
  readStream(
    request: DocReaderReadRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): AsyncGenerator<ReadStreamResponse__Output>
  close(): void
}

export interface DocReaderPdfParserOptions {
  address: string
  timeoutMs: number
  inputLimitBytes: number
  outputLimitBytes: number
  forceScanned?: boolean
  maxMessageBytes?: number
  clientFactory?: () => DocReaderClientLike
  ocrPage?: (input: DocReaderOcrPageInput) => Promise<DocReaderOcrPageResult>
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function pageFromImageName(filename: string): number | null {
  const match = /^(?:.*\/)?[^/]*_page_(\d+)\.(?:jpe?g|png)$/i.exec(filename)
  if (!match) return null
  const page = Number(match[1])
  return Number.isInteger(page) && page >= 1 ? page : null
}

function parseSourceBlocks(blocks: readonly SourceBlock__Output[] | undefined): {
  blocks: DocReaderSourceBlockSummary[]
  warnings: string[]
} {
  const warnings: string[] = []
  const parsed: DocReaderSourceBlockSummary[] = []
  for (const block of blocks ?? []) {
    if (
      !Number.isInteger(block.start) ||
      !Number.isInteger(block.end) ||
      block.start < 0 ||
      block.end <= block.start
    ) {
      warnings.push("docreader_source_block_invalid")
      continue
    }
    parsed.push({
      start: block.start,
      end: block.end,
      locatorJson: block.locator_json ?? "",
    })
  }
  return { blocks: parsed, warnings }
}

/**
 * The extraction fingerprint binds the adapter, upstream snapshot, protocol,
 * PDF mode, render settings and OCR version. The service address is deliberately
 * absent: moving a compatible service does not change extraction semantics.
 */
export function docreaderParserConfigVersion(params: {
  forceScanned: boolean
  timeoutMs: number
  inputLimitBytes: number
  outputLimitBytes: number
  ocrVersion?: string
}): string {
  return createHash("sha256").update(JSON.stringify({
    parserType: "docreader-pdf",
    adapterVersion: DOCREADER_ADAPTER_VERSION,
    upstreamSha: DOCREADER_UPSTREAM_SHA,
    protocol: DOCREADER_PROTOCOL,
    forceScanned: params.forceScanned,
    timeoutMs: params.timeoutMs,
    inputLimitBytes: params.inputLimitBytes,
    outputLimitBytes: params.outputLimitBytes,
    render: { dpi: 200, jpegQuality: 85, maxEdge: 2000 },
    ocr: { provider: "volc-ocr-v1", version: params.ocrVersion ?? "ocrp-v3" },
  })).digest("hex")
}

export class DocReaderPdfParser {
  readonly type = "docreader-pdf" as const
  private lastProvenance: { metadata: Record<string, unknown>; warnings: string[] } | null = null

  constructor(private options: DocReaderPdfParserOptions) {}

  async parse(input: ParseDocumentInput): Promise<NormalizedBlock[]> {
    return this.normalizeRaw(await this.parseRaw(input), input.documentId)
  }

  async parseRaw(input: Omit<ParseDocumentInput, "documentId">): Promise<string> {
    this.lastProvenance = null
    input.signal?.throwIfAborted()
    if (!input.content.length || input.content.length > this.options.inputLimitBytes) {
      throw new DocReaderError(
        `DocReader input is empty or exceeded ${this.options.inputLimitBytes} bytes`,
        "permanent_input",
        "docreader_invalid_request"
      )
    }

    const documentSha256 = sha256(input.content)
    const deadlineAt = Date.now() + this.options.timeoutMs
    const client = this.options.clientFactory
      ? this.options.clientFactory()
      : new DocReaderClient({
          address: this.options.address,
          timeoutMs: this.options.timeoutMs,
          maxMessageBytes: this.options.maxMessageBytes,
        })
    const warnings = new Set<string>()
    type StreamState =
      | { phase: "awaiting_metadata" }
      | {
          phase: "receiving_images" | "awaiting_end"
          meta: NonNullable<ReadStreamResponse__Output["meta"]>
          images: DocReaderImageSummary[]
        }
    let streamState: StreamState = { phase: "awaiting_metadata" }

    try {
      const request: DocReaderReadRequest = {
        fileContent: input.content,
        fileName: `${documentSha256}.pdf`,
        fileType: "pdf",
        title: input.fileName,
        requestId: randomUUID(),
        parserEngine: "builtin",
        parserEngineOverrides: this.options.forceScanned ? { pdf_force_scanned: "true" } : {},
      }

      for await (const frame of client.readStream(request, {
        signal: input.signal,
        timeoutMs: Math.max(1, deadlineAt - Date.now()),
      })) {
        if (frame.meta) {
          if (streamState.phase !== "awaiting_metadata") {
            throw new DocReaderError(
              "DocReader sent more than one metadata frame",
              "permanent_input",
              "docreader_invalid_stream"
            )
          }
          const meta = frame.meta
          if (meta.error) {
            throw new DocReaderError(
              "DocReader reported a parse failure",
              "permanent_input",
              "docreader_parse_failed"
            )
          }
          if (typeof meta.markdown_content !== "string") {
            throw new DocReaderError(
              "DocReader metadata is missing markdown_content",
              "permanent_input",
              "docreader_invalid_stream"
            )
          }
          if (!Number.isInteger(meta.image_count) || meta.image_count < 0) {
            throw new DocReaderError(
              "DocReader metadata has an invalid image_count",
              "permanent_input",
              "docreader_invalid_stream"
            )
          }
          streamState = {
            phase: meta.image_count === 0 ? "awaiting_end" : "receiving_images",
            meta,
            images: [],
          }
          continue
        }
        if (frame.image) {
          if (streamState.phase === "awaiting_metadata") {
            throw new DocReaderError(
              "DocReader sent an image before metadata",
              "permanent_input",
              "docreader_invalid_stream"
            )
          }
          if (streamState.phase === "awaiting_end") {
            throw new DocReaderError(
              "DocReader sent more images than declared",
              "permanent_input",
              "docreader_invalid_stream"
            )
          }
          streamState.images.push(await this.consumeImage(frame.image, input, deadlineAt, warnings))
          if (streamState.images.length === streamState.meta.image_count) {
            streamState = { ...streamState, phase: "awaiting_end" }
          }
          continue
        }
        throw new DocReaderError(
          "DocReader sent an empty stream frame",
          "permanent_input",
          "docreader_invalid_stream"
        )
      }

      if (streamState.phase === "awaiting_metadata") {
        throw new DocReaderError(
          "DocReader stream ended without metadata",
          "permanent_input",
          "docreader_invalid_stream"
        )
      }
      if (streamState.phase === "receiving_images") {
        throw new DocReaderError(
          `DocReader stream ended before all declared images arrived (${streamState.images.length}/${streamState.meta.image_count})`,
          "permanent_input",
          "docreader_image_missing"
        )
      }

      const { meta, images } = streamState
      const sourceBlocks = parseSourceBlocks(meta.source_blocks)
      for (const warning of sourceBlocks.warnings) warnings.add(warning)

      const envelope: DocReaderRawEnvelope = {
        schemaVersion: 1,
        adapterVersion: DOCREADER_ADAPTER_VERSION,
        upstreamSha: DOCREADER_UPSTREAM_SHA,
        protocol: DOCREADER_PROTOCOL,
        forceScanned: this.options.forceScanned === true,
        documentSha256,
        fileName: input.fileName,
        markdown: meta.markdown_content,
        metadata: meta.metadata ?? {},
        sourceBlocks: sourceBlocks.blocks,
        imageCount: meta.image_count,
        images,
        warnings: [...warnings],
      }
      const serialized = JSON.stringify(envelope)
      if (Buffer.byteLength(serialized, "utf8") > this.options.outputLimitBytes) {
        throw new DocReaderError(
          `DocReader output exceeded ${this.options.outputLimitBytes} bytes`,
          "permanent_input",
          "docreader_invalid_request"
        )
      }
      this.lastProvenance = {
        metadata: {
          docreader: {
            adapterVersion: DOCREADER_ADAPTER_VERSION,
            upstreamSha: DOCREADER_UPSTREAM_SHA,
            forceScanned: envelope.forceScanned,
            imageCount: images.length,
          },
        },
        warnings: [...warnings],
      }
      return serialized
    } finally {
      client.close()
    }
  }

  normalizeRaw(raw: string, documentId: string): NormalizedBlock[] {
    const envelope = parseDocReaderEnvelope(raw)
    const result = normalizeDocReaderEnvelope(raw, documentId)
    this.lastProvenance = {
      metadata: {
        docreader: {
          adapterVersion: envelope.adapterVersion,
          upstreamSha: envelope.upstreamSha,
          forceScanned: envelope.forceScanned,
          imageCount: envelope.images.length,
        },
      },
      warnings: result.warnings,
    }
    return result.blocks
  }

  extractionProvenance(): { metadata: Record<string, unknown>; warnings: string[] } | null {
    return this.lastProvenance
  }

  private async consumeImage(
    image: ImageRef__Output,
    input: Omit<ParseDocumentInput, "documentId">,
    deadlineAt: number,
    warnings: Set<string>
  ): Promise<DocReaderImageSummary> {
    const bytes = image.image_data
    if (!bytes || bytes.length === 0) {
      throw new DocReaderError(
        image.storage_key
          ? "DocReader returned an external image reference; this deployment requires inline image bytes"
          : "DocReader returned an empty image payload",
        "permanent_input",
        "docreader_image_missing"
      )
    }
    const buffer = Buffer.from(bytes)
    const page = pageFromImageName(image.filename ?? "")
    const kind = page === null ? "figure" : "scan"
    const summary: DocReaderImageSummary = {
      filename: image.filename ?? "",
      originalRef: image.original_ref ?? "",
      mimeType: image.mime_type ?? "image/jpeg",
      byteLength: buffer.length,
      sha256: sha256(buffer),
      page,
      kind,
    }
    if (kind === "scan") {
      if (!this.options.ocrPage) {
        throw new DocReaderError(
          "Scanned PDF pages require the OCR stage",
          "capability_missing",
          "docreader_ocr_required"
        )
      }
      summary.ocr = await this.options.ocrPage({
        image: buffer,
        page: page as number,
        fileName: summary.filename,
        signal: input.signal,
        timeoutMs: Math.max(1, deadlineAt - Date.now()),
      })
      for (const warning of summary.ocr.warnings) warnings.add(warning)
    }
    return summary
  }
}
