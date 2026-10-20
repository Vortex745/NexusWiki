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
  MarkItDownParser,
  OcrApiParser,
  selectParserRoute,
  type Parser,
  type ParserRouteInfo,
} from "./parser"
import { BuiltinPdfTextLayerAbsentError } from "./parser/builtin_pdf"
import { ocrApiParserConfigVersion } from "./parser/ocr_api"
import {
  createIngestionStore,
  IngestionStoreImpl,
  type ChunkStoreMetrics,
} from "./storage"
import { evaluateBlockCoverage } from "./chunk_coverage"
import { findOversizedChunks, resolveEmbeddingLimits } from "./limits"
import { produceContentProof, manifestDigest } from "./content_proof"
import { verifyIndexEntries } from "./index_verification"
import { ACTIVATION_EVIDENCE_SCHEMA_VERSION } from "./activation_gate"
import type { TracingRuntime } from "../tracing/contract"
import {
  PdfQualityGateUnavailableError,
  PdfQualityRejectionError,
  decidePdfQualityWorkflow,
  pdfQualityDiagnostics,
  type PdfQualityDiagnostics,
  type PdfQualityGate,
  type PdfQualityGateResult,
} from "./quality/pdf_ocr_fallback_flag"
import { buildPageIndex } from "./page_index_builder"
import { createProductionPdfQualityGate } from "./page_evidence/production_gate"
import type { DB } from "./tracking/db"
import { DocumentRepo } from "./tracking/doc_repo"
import { ExpectedChunkRepository } from "./tracking/expected_chunk_repo"
import { PageIndexRepository } from "./tracking/page_index_repo"
import {
  EXTRACTION_EVIDENCE_SCHEMA_VERSION,
  ExtractionEvidenceRepository,
  buildPageEvidence,
} from "./tracking/extraction_evidence_repo"

export type ParserResolver = (type: ParserType) => Parser

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
  /** 解码/结构层的待校验理由码（UT-10 decode + UT-12 risks）。 */
  reviewReasons?: string[]
  /** Ticket 04 (PDF quality): effective switch state + gate outcome for task diagnostics. */
  pdfQuality?: PdfQualityDiagnostics
}

interface ChunkStoreStageResult {
  chunks: Chunk[]
  metrics: ChunkStoreMetrics | null
}

function configuredParser(type: ParserType): Parser {
  const config = loadConfig()
  // UT-10: the faithful TXT path decodes in-process — no runtime to configure.
  if (type === "direct-txt") {
    return new DirectTextParser()
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
function parserConfigFingerprint(type: ParserType): string {
  // loadConfig requires the full production env; restricted test environments
  // fall back to the SAME defaults configuredParser would use — the
  // fingerprint stays deterministic either way.
  let config: ReturnType<typeof loadConfig>
  try {
    config = loadConfig()
  } catch {
    config = {} as ReturnType<typeof loadConfig>
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

/**
 * Ticket 04 (PDF quality): the optional boundary of the PDF OCR-fallback +
 * page-quality-gate workflow.
 *
 * - `qualityGate` is the page-audit seam. Tickets 07/08/12 implement it; the
 *   pipeline only ever asks it to audit an extracted PDF candidate. Production
 *   omits it, which is why an enabled switch without an evaluator fails closed
 *   instead of importing an unaudited PDF.
 * - `pdfOcrFallbackEnabled` overrides the server switch for an isolated scope,
 *   the same way `createIngestionLifecycle({ activationMode })` overrides
 *   `ACTIVATION_MODE`. Production omits it and reads
 *   `loadConfig().pdfOcrFallbackEnabled` (env `PDF_OCR_FALLBACK_ENABLED`,
 *   default off).
 */
export interface PipelineStageRunnerOptions {
  qualityGate?: PdfQualityGate
  pdfOcrFallbackEnabled?: boolean
}

export class PipelineStageRunner implements IngestionStageRunner {
  private documentRepo: DocumentRepo
  private store: IngestionStoreImpl | null
  private readonly injectedWikifier?: WikifierLike
  private readonly qualityGate?: PdfQualityGate
  private readonly pdfOcrFallbackEnabledOverride?: boolean

  constructor(
    private db: DB,
    private resolveParser: ParserResolver = configuredParser,
    store?: IngestionStoreImpl,
    wikifier?: WikifierLike,
    options?: PipelineStageRunnerOptions
  ) {
    this.documentRepo = new DocumentRepo(db)
    // T21: accept an injected store for sharing across runs; lazily create one
    // on first run() if not provided so construction stays cheap and tests
    // that never reach storeChunks don't need env vars.
    this.store = store ?? null
    this.injectedWikifier = wikifier
    this.qualityGate = options?.qualityGate
    this.pdfOcrFallbackEnabledOverride = options?.pdfOcrFallbackEnabled
  }

  /**
   * Ticket 04: the effective PDF OCR-fallback / quality-gate switch for this
   * run. An explicit scope override wins; otherwise the validated server config
   * value is used. A restricted environment where config cannot load, or a
   * config object that never carried the field, resolves to the documented
   * default (off) — exactly like `parserConfigFingerprint` below. Off is the
   * only safe fallback: it keeps the existing import path instead of
   * inventing a gate.
   */
  private effectivePdfOcrFallbackEnabled(): boolean {
    if (this.pdfOcrFallbackEnabledOverride !== undefined) return this.pdfOcrFallbackEnabledOverride
    try {
      return loadConfig().pdfOcrFallbackEnabled === true
    } catch {
      return false
    }
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
    // Ticket 04 (PDF quality): the independent PDF OCR-fallback + quality-gate
    // switch, resolved once per run from server config (or an explicit scope
    // override). OFF (the default) this decision is inert and every candidate
    // keeps the existing import path; ON, a PDF candidate must clear the page
    // quality gate below before chunking, vectorization or index writes.
    // Question-answering Clef routing reads nothing here.
    const pdfQualityDecision = decidePdfQualityWorkflow({
      flagEnabled: this.effectivePdfOcrFallbackEnabled(),
      hasSourceBytes: Boolean(document.rawContent),
      fileName: document.fileName ?? document.title,
      mimeType: document.mimeType ?? undefined,
    })
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
        recordParserMetadata(
          this.documentRepo,
          document,
          parserRoute?.candidates[0] ?? null,
          parserRoute?.reason ?? parserRoutingError?.message ?? "parser routing failed"
        )
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
              // Ticket 04: the effective switch state is part of the task
              // diagnostics even when the stage later fails.
              pdfOcrFallbackEnabled: pdfQualityDecision.flagEnabled,
            }
          : {
              contentLength: document.content.length,
              pdfOcrFallbackEnabled: pdfQualityDecision.flagEnabled,
            },
        async (): Promise<ChunkStageResult> => {
          if (!document.rawContent) {
            return {
              chunks: await new RecursiveChunker().chunk(document),
              blocks: [],
              parser: null,
              parserReason: null,
              pdfQuality: pdfQualityDiagnostics(pdfQualityDecision),
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
          const reuseFingerprint = parserConfigFingerprint(reuseCandidate)
          if (
            reuseEvidence &&
            reuseEvidence.valid &&
            reuseEvidence.artifact.parserType === reuseCandidate &&
            reuseEvidence.artifact.parserConfigVersion === reuseFingerprint
          ) {
            const reuseParser = this.resolveParser(reuseCandidate)
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
            const parser = this.resolveParser(reuseCandidate)
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
                // Ticket 13: a PDF whose extractor read zero text blocks is a
                // scan, not a broken import — under the quality workflow the
                // candidate stays alive for the page-quality gate, whose
                // whole-document OCR fallback (Ticket 12) owns the recovery.
                // Ungated, the extractor's empty-text guard stays a terminal
                // input failure (Ticket 17).
                if (
                  !(error instanceof BuiltinPdfTextLayerAbsentError) ||
                  !pdfQualityDecision.gated
                ) {
                  throw error
                }
                blocks = []
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
          const stageReviewReasons: string[] = []
          if (rawExtraction !== null) {
            stageRawExtractionSha256 = createHash("sha256")
              .update(Buffer.from(rawExtraction, "utf8"))
              .digest("hex")
            if (reusedExtraction) {
              // UT-19: the persisted evidence row stays untouched on reuse.
              // The decode/structural review reasons from the ORIGINAL run are
              // still in the document's system metadata — carry them into this
              // run's content proof (a reuse never clears a pending review).
              const persistedSystem = (
                document.metadata as {
                  system?: {
                    decode?: { reviewRequired?: boolean; reviewReason?: string }
                    extraction?: { risks?: { reviewReasons?: string[] } }
                  }
                }
              ).system
              if (persistedSystem?.decode?.reviewRequired && persistedSystem.decode.reviewReason) {
                stageReviewReasons.push(persistedSystem.decode.reviewReason)
              }
              stageReviewReasons.push(...(persistedSystem?.extraction?.risks?.reviewReasons ?? []))
            } else {
              const provenance =
                typeof usedParserInstance?.extractionProvenance === "function"
                  ? usedParserInstance.extractionProvenance()
                  : null
              let warnings = provenance?.warnings ?? []
              let pageCount: number | null = null
              if (usedParser === "builtin-pdf" || usedParser === "ocr-api") {
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
              // UT-15: collect the decode (UT-10) and structural (UT-12) review
              // reasons the parser recorded — they are upstream gaps the content
              // proof must carry; downstream coverage can never clear them.
              const decodeInfo = provenance?.metadata.decode as
                | { reviewRequired?: boolean; reviewReason?: string }
                | undefined
              if (decodeInfo?.reviewRequired && decodeInfo.reviewReason) {
                stageReviewReasons.push(decodeInfo.reviewReason)
              }
              const extractionRisks = provenance?.metadata.extraction as
                | { risks?: { reviewReasons?: string[] } }
                | undefined
              stageReviewReasons.push(...(extractionRisks?.risks?.reviewReasons ?? []))
              new ExtractionEvidenceRepository(this.db).record({
                docId: document.id,
                version: document.version,
                schemaVersion: EXTRACTION_EVIDENCE_SCHEMA_VERSION,
                parserType: usedParser,
                parserConfigVersion: parserConfigFingerprint(usedParser),
                rawExtraction,
                rawExtractionSha256: stageRawExtractionSha256,
                warnings,
                pages: buildPageEvidence(blocks, pageCount, warnings),
                pageCount,
                completedAt: new Date().toISOString(),
              })
            }
          }

          // Ticket 04 (PDF quality): the switch's decision point. It sits after
          // local extraction (and its durable evidence record) and BEFORE
          // chunking, so an ON switch makes the page-quality gate the entry to
          // the rest of the import and an OFF switch skips this block entirely.
          // A rejection is terminal for this candidate; an enabled switch with
          // no evaluator wired fails closed rather than importing unaudited
          // pages. The audited candidate stays the local extraction — the OCR
          // fallback (Ticket 12) replaces it behind this same gate.
          let pdfQualityGateResult: PdfQualityGateResult | null = null
          if (pdfQualityDecision.gated) {
            if (!this.qualityGate) throw new PdfQualityGateUnavailableError()
            pdfQualityGateResult = await this.qualityGate.audit({
              docId: document.id,
              version: document.version,
              parser: usedParser,
              blocks,
              rawExtractionSha256: stageRawExtractionSha256,
              signal: execution.signal,
            })
            if (pdfQualityGateResult.verdict !== "pass") {
              throw new PdfQualityRejectionError(pdfQualityGateResult.reasonCodes)
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
            parserConfigVersion: parserConfigFingerprint(usedParser),
            reviewReasons: stageReviewReasons,
            pdfQuality: pdfQualityDiagnostics(pdfQualityDecision, pdfQualityGateResult),
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
          // Ticket 04: effective PDF switch state, stable codes only.
          ...(result.pdfQuality ?? {}),
        })
      )
      const chunks = chunkResult.chunks

      // Ticket UT-13: persist the EXPECTED retrieval manifest for this
      // document version (every index-bound chunk with its stable identity,
      // content hash and covered source blocks — parent chunks never enter
      // the index), then verify block coverage independently. A coverage gap
      // is a loud stage failure, never a silent partial index expectation.
      const indexChunks = chunks.filter((chunk) => chunk.metadata.kind !== "parent")
      const manifestEntries = indexChunks.map((chunk, position) => ({
        chunkId: chunk.id,
        kind: String(chunk.metadata.kind ?? "child"),
        position,
        contentSha256: ExpectedChunkRepository.contentSha256(chunk.content),
        blockIds: ((chunk.metadata.normalizedBlocks as Array<{ id?: string }> | undefined) ?? [])
          .map((block) => block.id)
          .filter((id): id is string => typeof id === "string"),
      }))
      new ExpectedChunkRepository(this.db).replaceAll(
        document.id,
        document.version,
        manifestEntries
      )
      if (chunkResult.blocks.length > 0) {
        const coverage = evaluateBlockCoverage(chunkResult.blocks, indexChunks)
        if (coverage.verdict === "gaps") {
          throw new Error(
            `chunk coverage gaps: ${coverage.missingBlockIds.length}/${coverage.totalBlocks} normalized blocks missing from index chunks`
          )
        }
      }

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

      // Ticket UT-15: the content integrity proof — the joint verdict over
      // extraction evidence, decode/structural review reasons and chunk
      // coverage, BOUND to the same raw extraction, manifest and parser
      // configuration. Recorded ALWAYS (pass or pending_review) so the
      // activation gate and the uploader see precise reasons. A pass never
      // activates anything by itself: it only qualifies the candidate for
      // index verification (UT-16) — the gate's index half stays fail-closed.
      const extractionEvidence = new ExtractionEvidenceRepository(this.db).get(
        document.id,
        document.version
      )
      const contentProof = produceContentProof({
        extractionEvidence: extractionEvidence?.artifact ?? null,
        reviewReasons: chunkResult.reviewReasons ?? [],
        blocks: chunkResult.blocks,
        indexChunks,
        manifestEntries,
        parserConfigVersion: chunkResult.parserConfigVersion ?? null,
      })
      // Ticket 21: merge, never overwrite — the page-quality audit envelope
      // the gate persisted earlier in this run (and any future producer) must
      // survive the content/index proof write.
      const existingEvidence = this.documentRepo.getCandidateEvidence(document.id)
      const priorEvidence = existingEvidence && typeof existingEvidence === "object" && !Array.isArray(existingEvidence)
        ? existingEvidence as Record<string, unknown>
        : {}
      this.documentRepo.setCandidateEvidence(document.id, {
        ...priorEvidence,
        schemaVersion: ACTIVATION_EVIDENCE_SCHEMA_VERSION,
        contentProof,
        indexProof: null,
      })

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

      // Ticket UT-16/UT-17: verify what ACTUALLY landed in the index against
      // the expected manifest — logical identity, count, content hash, vector
      // presence AND search visibility (a bounded-retry _search probe through
      // the actual retrieval boundary; refresh delay, invisibility or search
      // failure never announce completion). The result becomes the candidate
      // evidence's indexProof; its manifest digest is compared against the
      // content proof's binding at the joint gate (UT-17).
      if (indexChunks.length > 0) {
        const store = this.ensureStore() as IngestionStoreImpl & {
          readIndexEntries?: (
            documentId: string,
            chunkIds: string[]
          ) => Promise<Map<string, { content: string | null; embedding: number[] | null }>>
          countVisibleIndexEntries?: (
            documentId: string,
            chunkIds: string[],
            options?: { tenantId?: string }
          ) => Promise<number>
        }
        if (typeof store.readIndexEntries === "function") {
          const expectedIds = manifestEntries.map((entry) => entry.chunkId)
          let searchVisibleCount: number | undefined
          let probeError: string | null = null
          if (typeof store.countVisibleIndexEntries === "function") {
            // 有界等待索引可见性：刷新延迟/分片可见性延迟以 3×400ms 收敛；
            // 仍不可见如实记录（index_not_searchable），绝不宣布完成。
            for (let attempt = 0; attempt < 3; attempt += 1) {
              try {
                searchVisibleCount = await store.countVisibleIndexEntries(
                  document.id,
                  expectedIds,
                  { tenantId: document.tenantId }
                )
                if (searchVisibleCount >= expectedIds.length) break
              } catch (error) {
                // 探针故障不是摄取失败：核验语义（UT-16）是"失败可观察、
                // 由联合门槛拒绝激活"，已完成的索引工作不作废。
                probeError = error instanceof Error ? error.message : String(error)
                break
              }
              if (attempt < 2) await new Promise((resolveWait) => setTimeout(resolveWait, 400))
            }
          }
          let entries: Map<string, { content: string | null; embedding: number[] | null }> = new Map()
          try {
            entries = await store.readIndexEntries(document.id, expectedIds)
          } catch (error) {
            probeError = probeError ?? (error instanceof Error ? error.message : String(error))
          }
          const indexProof =
            probeError !== null
              ? {
                  verdict: "fail" as const,
                  reasonCodes: ["index_verification_probe_failed"],
                  expectedCount: manifestEntries.length,
                  verifiedCount: 0,
                  missingChunkIds: [] as string[],
                  contentMismatchChunkIds: [] as string[],
                  missingVectorChunkIds: [] as string[],
                  extraEntryCount: 0,
                  searchVisibleCount:
                    typeof searchVisibleCount === "number" ? searchVisibleCount : null,
                  manifestSha256: manifestDigest(manifestEntries),
                  verifiedAt: new Date().toISOString(),
                  probeError: probeError.slice(0, 300),
                }
              : verifyIndexEntries({
                  expected: manifestEntries,
                  entries,
                  searchVisibleCount,
                  manifestSha256: manifestDigest(manifestEntries),
                })
          // Read-merge-write, same contract as the contentProof write: the
          // candidate evidence column is shared by independent producers
          // (ticket 21's pdfQualityAudit, UT-15's contentProof), and no
          // single proof may whole-column-overwrite the others.
          const existingEvidence = this.documentRepo.getCandidateEvidence(document.id)
          const priorEvidence =
            existingEvidence && typeof existingEvidence === "object" && !Array.isArray(existingEvidence)
              ? (existingEvidence as Record<string, unknown>)
              : {}
          this.documentRepo.setCandidateEvidence(document.id, {
            ...priorEvidence,
            schemaVersion: ACTIVATION_EVIDENCE_SCHEMA_VERSION,
            contentProof: priorEvidence.contentProof ?? null,
            indexProof,
          })
        }
      }

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
        // Ticket 04: the root task record reports the effective switch state.
        ...(chunkResult.pdfQuality ?? {}),
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
 * Production callers (HTTP/worker/CLI) omit these — the factory reads
 * `loadConfig().activationMode` and wires a `PipelineStageRunner`. Release
 * testing infrastructure (e.g. revision-scoped ingestion fixtures) supplies
 * explicit overrides so acceptance probes can exercise the lifecycle under
 * a controlled activation mode and stage runner without touching production
 * config or external services.
 */
export interface CreateIngestionLifecycleOptions {
  stageRunner?: IngestionStageRunner
  activationMode?: ActivationMode
  now?: () => Date
  /** LO-13: the worker-side runtime; absent in submit-only callers. */
  tracing?: TracingRuntime
}

export function createIngestionLifecycle(
  db: DB,
  options?: CreateIngestionLifecycleOptions
): IngestionLifecycle {
  // P6.1 (spec L73): IngestionLifecycle owns the ACTIVATION_MODE decision.
  // The factory reads the config once at construction; HTTP/worker/CLI
  // callers all go through this factory so they cannot bypass the review
  // state machine. Release testing infrastructure (Ticket 18) passes explicit
  // overrides via `options` to exercise the lifecycle under a controlled
  // activation mode and stage runner — the config-driven default still
  // applies when an override is absent, so production behavior is unchanged.
  //
  // When `options.activationMode` is supplied, config loading is skipped
  // entirely: the override is authoritative and config env vars (e.g.
  // OPENAI_API_KEY) may not be present in the acceptance-test environment.
  // The `cfg` variable unifies both paths so the audit regex still sees
  // `cfg.activationMode` as the value passed to the constructor.
  const cfg = options?.activationMode
    ? { activationMode: options.activationMode }
    : loadConfig()
  // Ticket 21: the production page-quality gate, wired when the validated
  // server switch asks for it (an explicit stageRunner override always wins).
  // Wiring failures — config unreadable, a part unconstructible — leave the
  // gate unwired and log; a gated import then fails closed with the
  // documented PdfQualityGateUnavailableError instead of importing unaudited
  // pages, and an OFF switch keeps the existing import path untouched.
  let qualityGate: PdfQualityGate | undefined
  if (!options?.stageRunner) {
    try {
      if (loadConfig().pdfOcrFallbackEnabled === true) {
        qualityGate = createProductionPdfQualityGate(db, loadConfig())
      }
    } catch (error) {
      console.warn(
        "[pipeline] PDF page-quality gate not wired:",
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  return new IngestionLifecycle(
    db,
    options?.stageRunner ?? new PipelineStageRunner(db, configuredParser, undefined, undefined, { qualityGate }),
    options?.now ?? (() => new Date()),
    cfg.activationMode,
    undefined,
    options?.tracing)
}
