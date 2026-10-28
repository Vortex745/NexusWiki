import { createHash } from "node:crypto"
import { loadConfig } from "../config"
import type {
  ActivationMode,
  Chunk,
  Document,
  Entity,
  NormalizedBlock,
  ParserType,
  Wikilink,
} from "../types"
import { RecursiveChunker } from "./chunker/chunker"
import {
  IngestionLifecycle,
  type IngestionStageRunner,
  type StageExecution,
} from "./lifecycle"
import {
  BuiltinPdfParser,
  DirectTextParser,
  DocReaderPdfParser,
  MarkItDownParser,
  OcrApiParser,
  docreaderParserConfigVersion,
  selectParserRoute,
  type Parser,
  type ParserRouteInfo,
} from "./parser"
import { ocrApiParserConfigVersion } from "./parser/ocr_api"
import {
  createIngestionStore,
  IngestionStoreImpl,
  type ChunkStoreMetrics,
} from "./storage"
import { findOversizedChunks, resolveEmbeddingLimits } from "./limits"
import type { TracingRuntime } from "../tracing/contract"
import { DOCREADER_UPSTREAM_SHA } from "./parser/docreader_pdf_types"
import { buildPageIndex } from "./page_index_builder"
import type { DB } from "./tracking/db"
import { DocumentRepo } from "./tracking/doc_repo"
import { PageIndexRepository } from "./tracking/page_index_repo"
import {
  EXTRACTION_EVIDENCE_SCHEMA_VERSION,
  ExtractionEvidenceRepository,
  buildPageEvidence,
} from "./tracking/extraction_evidence_repo"

export type ParserResolver = (type: ParserType, route?: ParserRouteInfo) => Parser

/**
 * Eval refactor Ticket 02: the LLM boundary of the wikify stage. Extraction
 * and link building are external LLM calls — tests and isolated evaluation
 * scopes may inject a controlled implementation. Production Wiki generation
 * runs asynchronously after activation, so ordinary imports omit this stage.
 */
export interface WikifierLike {
  extractEntities(chunks: Chunk[]): Promise<Entity[]>
  buildWikilinks(entities: Entity[], chunks: Chunk[]): Promise<Wikilink[]>
}

interface ChunkStageResult {
  chunks: Chunk[]
  blocks: NormalizedBlock[]
  parser: ParserType | null
  parserReason: string | null
  /** UT-15: proof inputs captured during the stage (null for content-only docs). */
  rawExtractionSha256?: string | null
  parserConfigVersion?: string | null
}

interface ChunkStoreStageResult {
  chunks: Chunk[]
  metrics: ChunkStoreMetrics | null
}

/**
 * The production parser for one route. Exported because the conversation
 * attachment path parses binary documents with the SAME parser instances the
 * import pipeline uses — one format list, one extraction behavior.
 */
export function createConfiguredParser(type: ParserType, route?: ParserRouteInfo): Parser {
  const config = loadConfig()
  // UT-10: the faithful TXT path decodes in-process — no runtime to configure.
  if (type === "direct-txt") {
    return new DirectTextParser()
  }
  if (type === "docreader-pdf") {
    const ocr = new OcrApiParser({
      accessKeyId: config.ocrAccessKeyId ?? "",
      secretAccessKey: config.ocrSecretAccessKey ?? "",
      sessionToken: config.ocrSessionToken,
      timeoutMs: config.parserTimeoutMs ?? 120_000,
      inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
      outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
    })
    return new DocReaderPdfParser({
      address: config.docreaderAddr ?? "127.0.0.1:50051",
      timeoutMs: config.docreaderTimeoutMs ?? 300_000,
      inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
      outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
      forceScanned: route?.pdfForceScanned === true,
      ocrPage: (page) => ocr.readImagePage(page),
    })
  }
  if (type === "builtin-pdf") {
    return new BuiltinPdfParser({
      command: config.pythonCommand ?? "python",
      timeoutMs: config.parserTimeoutMs ?? 120_000,
      inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
      outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
    })
  }
  if (type === "ocr-api") {
    return new OcrApiParser({
      accessKeyId: config.ocrAccessKeyId ?? "",
      secretAccessKey: config.ocrSecretAccessKey ?? "",
      sessionToken: config.ocrSessionToken,
      timeoutMs: config.parserTimeoutMs ?? 120_000,
      inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
      outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
    })
  }
  if (type !== "markitdown") throw new Error(`Unsupported production parser: ${type}`)
  return new MarkItDownParser({
    command: config.markitdownCommand ?? "markitdown",
    timeoutMs: config.parserTimeoutMs ?? 120_000,
    inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
    outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
  })
}

/**
 * Ticket UT-09: fingerprint of the parser configuration that produced an
 * extraction. Two records with different fingerprints were produced under
 * different parser settings and must never be treated as interchangeable
 * (the UT-19 reuse path consumes this judgement).
 */
function parserConfigFingerprint(type: ParserType, route?: ParserRouteInfo): string {
  // loadConfig requires the full production env; restricted test environments
  // fall back to the SAME defaults configuredParser would use — the
  // fingerprint stays deterministic either way.
  let config: ReturnType<typeof loadConfig>
  try {
    config = loadConfig()
  } catch {
    config = {} as ReturnType<typeof loadConfig>
  }
  if (type === "docreader-pdf") {
    return docreaderParserConfigVersion({
      forceScanned: route?.pdfForceScanned === true,
      timeoutMs: config.parserTimeoutMs ?? 120_000,
      inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
      outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
      ocrVersion: ocrApiParserConfigVersion({
        timeoutMs: config.parserTimeoutMs ?? 120_000,
        inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
        outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
      }),
    })
  }
  if (type === "ocr-api") {
    // Ticket 24: one shared fingerprint source with the quality gate's OCR
    // fallback seam (same key order, same digest).
    return ocrApiParserConfigVersion({
      timeoutMs: config.parserTimeoutMs ?? 120_000,
      inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
      outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
    })
  }
  // UT-10: direct-txt decodes in-process — no command participates.
  const command =
    type === "direct-txt"
      ? null
      : type === "builtin-pdf"
        ? (config.pythonCommand ?? "python")
        : (config.markitdownCommand ?? "markitdown")
  return createHash("sha256")
    .update(
      JSON.stringify({
        parserType: type,
        command,
        timeoutMs: config.parserTimeoutMs ?? 120_000,
        inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
        outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
      })
    )
    .digest("hex")
}

function recordParserMetadata(
  repository: DocumentRepo,
  document: Document,
  parser: ParserType | null,
  reason: string,
  blocks?: NormalizedBlock[],
  extractionMetadata?: Record<string, unknown>
): void {
  const existingSystem = document.metadata.system
  const system = existingSystem && typeof existingSystem === "object" && !Array.isArray(existingSystem)
    ? existingSystem as Record<string, unknown>
    : {}
  repository.updateMetadata(document.id, {
    ...document.metadata,
    system: {
      ...system,
      // UT-10: extraction-level provenance (e.g. the faithful TXT path's
      // decode evidence) lands beside the parser decision, keyed by the
      // producer ("decode" for direct-txt).
      ...(extractionMetadata ?? {}),
      source: document.source,
      fileName: document.fileName,
      mimeType: document.mimeType,
      contentHash: document.contentHash,
      version: document.version,
      parser: {
        selected: parser,
        reason,
        ...(blocks
          ? {
              normalizedBlockCount: blocks.length,
              provenance: blocks[0]?.provenance ?? null,
            }
          : {}),
      },
    },
  })
}

export interface IngestionPolicyMarker {
  version: "weknora-technical-v1"
  parser: ParserType | null
  upstreamSha: string | null
  pdfMode: "auto" | "force_scanned" | null
}

function recordIngestionPolicy(
  repository: DocumentRepo,
  document: Document,
  policy: IngestionPolicyMarker
): void {
  const existingSystem = document.metadata.system
  const system = existingSystem && typeof existingSystem === "object" && !Array.isArray(existingSystem)
    ? existingSystem as Record<string, unknown>
    : {}
  const metadata = { ...document.metadata, system: { ...system, ingestionPolicy: policy } }
  document.metadata = metadata
  if (repository.exists(document.id)) repository.updateMetadata(document.id, metadata)
}

export class PipelineStageRunner implements IngestionStageRunner {
  private documentRepo: DocumentRepo
  private store: IngestionStoreImpl | null
  private readonly injectedWikifier?: WikifierLike

  constructor(
    private db: DB,
    private resolveParser: ParserResolver = createConfiguredParser,
    store?: IngestionStoreImpl,
    wikifier?: WikifierLike
  ) {
    this.documentRepo = new DocumentRepo(db)
    // T21: accept an injected store for sharing across runs; lazily create one
    // on first run() if not provided so construction stays cheap and tests
    // that never reach storeChunks don't need env vars.
    this.store = store ?? null
    this.injectedWikifier = wikifier
  }

  private ensureStore(): IngestionStoreImpl {
    if (!this.store) {
      this.store = createIngestionStore()
    }
    return this.store
  }

  async close(): Promise<void> {
    if (!this.store) return
    try {
      await this.store.close()
    } catch (error) {
      console.warn(
        "[pipeline] Failed to close ingestion store:",
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  async run(
    document: Document,
    execution: StageExecution
  ): Promise<Record<string, unknown>> {
    let parserRoute: ParserRouteInfo | null = null
    let parserRoutingError: Error | null = null
      if (document.rawContent) {
        try {
          parserRoute = selectParserRoute({
            fileName: document.fileName ?? document.title,
            mimeType: document.mimeType ?? undefined,
            override: document.parserOverride ?? undefined,
          })
        } catch (error) {
          parserRoutingError = error instanceof Error ? error : new Error(String(error))
        }
        recordIngestionPolicy(this.documentRepo, document, {
          version: "weknora-technical-v1",
          parser: parserRoute?.candidates[0] ?? null,
          upstreamSha: parserRoute?.candidates[0] === "docreader-pdf" ? DOCREADER_UPSTREAM_SHA : null,
          pdfMode: parserRoute?.candidates[0] === "docreader-pdf"
            ? (parserRoute.pdfForceScanned ? "force_scanned" : "auto")
            : null,
        })
        recordParserMetadata(
          this.documentRepo,
          document,
          parserRoute?.candidates[0] ?? null,
          parserRoute?.reason ?? parserRoutingError?.message ?? "parser routing failed"
        )
      } else {
        recordIngestionPolicy(this.documentRepo, document, {
          version: "weknora-technical-v1",
          parser: null,
          upstreamSha: null,
          pdfMode: null,
        })
      }

      const chunkResult = await execution.runStage(
        "chunk",
        document.rawContent
          ? {
              contentLength: document.rawContent.length,
              fileName: document.fileName,
              mimeType: document.mimeType,
              parser: parserRoute?.candidates[0] ?? null,
              parserReason: parserRoute?.reason ?? parserRoutingError?.message ?? null,
            }
          : {
              contentLength: document.content.length,
            },
        async (): Promise<ChunkStageResult> => {
          if (!document.rawContent) {
            return {
              chunks: await new RecursiveChunker().chunk(document),
              blocks: [],
              parser: null,
              parserReason: null,
            }
          }
          if (parserRoutingError) throw parserRoutingError
          if (!parserRoute) throw new Error("Raw document parser routing did not produce a decision")

          // Each route has one parser. Preserve its failures and cancellation
          // without switching providers or discarding extraction evidence.
          let blocks: NormalizedBlock[] | null = null
          let rawExtraction: string | null = null
          let usedParser: ParserType | null = null
          let usedParserInstance: Parser | null = null
          const parserReason = parserRoute.reason

          // Ticket UT-19: verified-extraction reuse. A resume/reprocess may
          // reuse the durable extraction ONLY when the recorded evidence is
          // valid (hash-checked), produced by the SAME parser type under the
          // SAME configuration fingerprint, and the parser can re-derive
          // blocks from the raw output. Anything else — half-written rows,
          // hash mismatches, config drift, unknown compatibility — falls
          // through to a full re-run from the retained original. Embedding
          // or index config changes do NOT participate here, so an embedding
          // change never needlessly invalidates the extraction.
          let reusedExtraction = false
          const reuseEvidence = new ExtractionEvidenceRepository(this.db).get(
            document.id,
            document.version
          )
          const reuseCandidate = parserRoute.candidates[0]
          const reuseFingerprint = parserConfigFingerprint(reuseCandidate, parserRoute)
          if (
            reuseEvidence &&
            reuseEvidence.valid &&
            reuseEvidence.artifact.parserType === reuseCandidate &&
            reuseEvidence.artifact.parserConfigVersion === reuseFingerprint
          ) {
            const reuseParser = this.resolveParser(reuseCandidate, parserRoute)
            if (typeof reuseParser.normalizeRaw === "function") {
              try {
                rawExtraction = reuseEvidence.artifact.rawExtraction
                blocks = reuseParser.normalizeRaw(rawExtraction, document.id)
                usedParser = reuseCandidate
                usedParserInstance = reuseParser
                reusedExtraction = true
              } catch {
                // Cannot confirm the reuse (malformed persisted output?) —
                // fall through to a full re-run from the retained original.
                rawExtraction = null
                blocks = null
                usedParser = null
                usedParserInstance = null
              }
            }
          }

          if (!reusedExtraction) {
            const parser = this.resolveParser(reuseCandidate, parserRoute)
            if (typeof parser.parseRaw === "function" && typeof parser.normalizeRaw === "function") {
              // UT-09 truth seam: capture the RAW extraction (pre-cleaning)
              // for the durable evidence record; normalization happens on
              // the exact same output — nothing is parsed twice.
              rawExtraction = await parser.parseRaw({
                content: document.rawContent,
                fileName: document.fileName ?? document.title,
                mimeType: document.mimeType ?? undefined,
                signal: execution.signal,
              })
              try {
                blocks = parser.normalizeRaw(rawExtraction, document.id)
              } catch (error) {
                throw error
              }
            } else {
              rawExtraction = null
              blocks = await parser.parse({
                content: document.rawContent,
                fileName: document.fileName ?? document.title,
                mimeType: document.mimeType ?? undefined,
                documentId: document.id,
                signal: execution.signal,
              })
            }
            usedParser = reuseCandidate
            usedParserInstance = parser
          }
          if (!blocks || !usedParser) {
            throw new Error(
              `No usable parser for ${document.fileName ?? document.title}: tried ${parserRoute.candidates.join(", ")} (${parserRoute.reason}). Configure the selected parser runtime or the server-side OCR API credentials.`
            )
          }

          // Ticket UT-09: persist the durable extraction evidence — the RAW
          // extraction (pre-cleaning), its own hash, the parser configuration
          // fingerprint and per-page coverage — before any cleaning runs, so a
          // reviewer can audit the exact bytes the parser produced even after
          // a restart. Parsers without a raw seam (mineru) leave no evidence
          // row: absent capability is never fabricated. Coverage warnings come
          // from the extraction payload itself (builtin-pdf emits them), decode
          // warnings from the parser's own extraction provenance (UT-10).
          let stageRawExtractionSha256: string | null = null
          if (rawExtraction !== null) {
            stageRawExtractionSha256 = createHash("sha256")
              .update(Buffer.from(rawExtraction, "utf8"))
              .digest("hex")
            if (!reusedExtraction) {
              const provenance =
                typeof usedParserInstance?.extractionProvenance === "function"
                  ? usedParserInstance.extractionProvenance()
                  : null
              let warnings = provenance?.warnings ?? []
              let pageCount: number | null = null
              if (usedParser === "builtin-pdf" || usedParser === "ocr-api" || usedParser === "docreader-pdf") {
                try {
                  const rawJson = JSON.parse(rawExtraction) as {
                    warnings?: unknown
                    pageCount?: unknown
                  }
                  if (Array.isArray(rawJson.warnings)) {
                    warnings = rawJson.warnings.filter(
                      (warning): warning is string => typeof warning === "string"
                    )
                  }
                  if (Number.isInteger(rawJson.pageCount)) {
                    pageCount = rawJson.pageCount as number
                  }
                } catch {
                  // normalizeRaw already validated this exact JSON; a re-parse
                  // failure cannot happen for a successfully normalized payload.
                }
              }
              new ExtractionEvidenceRepository(this.db).record({
                docId: document.id,
                version: document.version,
                schemaVersion: EXTRACTION_EVIDENCE_SCHEMA_VERSION,
                parserType: usedParser,
                parserConfigVersion: parserConfigFingerprint(usedParser, parserRoute),
                rawExtraction,
                rawExtractionSha256: stageRawExtractionSha256,
                warnings,
                pages: buildPageEvidence(blocks, pageCount, warnings),
                pageCount,
                completedAt: new Date().toISOString(),
              })
            }
          }

          const parsedDocument: Document = {
            ...document,
            content: blocks.map((block) => block.text).join("\n\n"),
          }
          const chunks = await new RecursiveChunker().chunk(parsedDocument, blocks)
          recordParserMetadata(
            this.documentRepo,
            document,
            usedParser,
            parserReason,
            blocks,
            typeof usedParserInstance?.extractionProvenance === "function"
              ? usedParserInstance.extractionProvenance()?.metadata
              : undefined
          )
          return {
            chunks,
            blocks,
            parser: usedParser,
            parserReason,
            rawExtractionSha256: stageRawExtractionSha256,
            parserConfigVersion: parserConfigFingerprint(usedParser, parserRoute),
          }
        },
        (result) => ({
          chunkCount: result.chunks.length,
          chunkIds: result.chunks.map((chunk) => chunk.id),
          totalChars: result.chunks.reduce((sum, chunk) => sum + chunk.content.length, 0),
          ...(result.parser
            ? {
                parser: result.parser,
                parserReason: result.parserReason,
                normalizedBlockCount: result.blocks.length,
                normalizedBlockTypes: result.blocks.map((block) => block.type),
                provenance: result.blocks[0]?.provenance ?? null,
              }
            : {}),
        })
      )
      const chunks = chunkResult.chunks
      const indexChunks = chunks.filter((chunk) => chunk.metadata.kind !== "parent")

      // Ticket UT-14: enforce the explicit embedding input token limit with a
      // conservative character-based estimate (never inferred from bytes). A
      // chunk over the provider limit fails LOUDLY here instead of being
      // silently truncated (or rejected) by the provider during embedding.
      const embeddingLimits = resolveEmbeddingLimits()
      const oversized = findOversizedChunks(indexChunks, embeddingLimits)
      if (oversized.length > 0) {
        const first = oversized[0]
        throw new Error(
          `embedding input token limit exceeded: ${oversized.length} chunk(s) over ${embeddingLimits.inputTokenLimit} tokens ` +
            `(first: ${first.chunkId}, est. ${first.estimatedTokens} tokens / ${first.chars} chars) — ` +
            "lower the chunker size limits or raise EMBEDDING_INPUT_TOKEN_LIMIT; no silent provider truncation"
        )
      }

      const wikified = await execution.runStage(
        "wikify",
        { chunkCount: chunks.length },
        async (): Promise<{ entities: Entity[]; wikilinks: Wikilink[] }> => {
          // Wiki pages are generated after document activation. The legacy
          // graph extractor is optional and must not gate ordinary imports.
          if (!this.injectedWikifier) return { entities: [], wikilinks: [] }
          const entities = await this.injectedWikifier.extractEntities(chunks)
          const wikilinks = await this.injectedWikifier.buildWikilinks(entities, chunks)
          return { entities, wikilinks }
        },
        ({ entities, wikilinks }) => ({
          entityCount: entities.length,
          wikilinkCount: wikilinks.length,
          entityNames: entities.slice(0, 20).map((entity) => entity.name),
        })
      )

      await execution.runStage(
        "storeChunks",
        { chunkCount: chunks.length },
        async (): Promise<ChunkStoreStageResult> => {
          if (
            document.tenantId === undefined ||
            document.allowedGroups === undefined ||
            document.knowledgeBaseId === undefined
          ) {
            throw new Error("Document access metadata is required before chunk persistence")
          }
          const store = this.ensureStore()
          const metrics = await store.storeChunks(chunks, {
            tenantId: document.tenantId,
            allowedGroups: document.allowedGroups,
            knowledgeBaseId: document.knowledgeBaseId,
          }, execution.signal)
          const nodes = buildPageIndex(document, chunks)
          if (nodes.length > 0) {
            new PageIndexRepository(this.db).replaceNodes(document.id, nodes, {
              tenantId: document.tenantId,
              allowedGroups: document.allowedGroups,
              knowledgeBaseId: document.knowledgeBaseId,
            })
          }
          return { chunks, metrics: metrics ?? null }
        },
        (stored) => ({
          chunkCount: stored.chunks.length,
          indexName: this.ensureStore().chunkIndexName,
          ...(stored.metrics ?? {}),
        })
      )

      await execution.runStage(
        "storeGraph",
        {
          entityCount: wikified.entities.length,
          wikilinkCount: wikified.wikilinks.length,
        },
        async () => {
          if (
            document.tenantId === undefined ||
            document.allowedGroups === undefined ||
            document.knowledgeBaseId === undefined
          ) {
            throw new Error("Document access metadata is required before graph persistence")
          }
          if (!wikified.entities.length && !wikified.wikilinks.length) return wikified
          const store = this.ensureStore()
          await store.storeEntities(wikified.entities)
          await store.storeWikilinks(wikified.wikilinks, {
            tenantId: document.tenantId,
            allowedGroups: document.allowedGroups,
            knowledgeBaseId: document.knowledgeBaseId,
          })
          return wikified
        },
        ({ entities, wikilinks }) => ({
          entityCount: entities.length,
          wikilinkCount: wikilinks.length,
        })
      )

      return {
        chunkCount: chunks.length,
        entityCount: wikified.entities.length,
        wikilinkCount: wikified.wikilinks.length,
        ...(chunkResult.parser
          ? {
              parser: chunkResult.parser,
              parserReason: chunkResult.parserReason,
              normalizedBlockCount: chunkResult.blocks.length,
            }
          : {}),
      }
  }
}

/**
 * Optional overrides for {@link createIngestionLifecycle}.
 *
 * Production callers (HTTP/worker/CLI) omit these and use the configured
 * pipeline. Release testing infrastructure supplies explicit overrides so
 * acceptance probes can exercise the lifecycle without touching production
 * config or external services.
 */
export interface CreateIngestionLifecycleOptions {
  stageRunner?: IngestionStageRunner
  /** @deprecated Review mode is retired; accepted for historical callers and ignored. */
  activationMode?: ActivationMode
  now?: () => Date
  /** LO-13: the worker-side runtime; absent in submit-only callers. */
  tracing?: TracingRuntime
}

export function createIngestionLifecycle(
  db: DB,
  options?: CreateIngestionLifecycleOptions
): IngestionLifecycle {
  return new IngestionLifecycle(
    db,
    options?.stageRunner ?? new PipelineStageRunner(db, createConfiguredParser),
    options?.now ?? (() => new Date()),
    options?.activationMode ?? "auto",
    undefined,
    options?.tracing)
}
