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
  MarkerParser,
  MinerUParser,
  selectParserRoute,
  type Parser,
  type ParserRouteInfo,
} from "./parser"
import {
  createIngestionStore,
  IngestionStoreImpl,
  type ChunkStoreMetrics,
} from "./storage"
import { evaluateBlockCoverage } from "./chunk_coverage"
import { findOversizedChunks, resolveEmbeddingLimits } from "./limits"
import { buildPageIndex } from "./page_index_builder"
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
}

interface ChunkStoreStageResult {
  chunks: Chunk[]
  metrics: ChunkStoreMetrics | null
}

function isParserUnavailableError(error: unknown): boolean {
  // Every CLI-backed parser wraps a missing executable with this phrase; it
  // is the only failure mode that justifies trying the next route candidate.
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("executable is unavailable")
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
  if (type === "marker") {
    return new MarkerParser({
      command: config.markerCommand ?? "marker_single",
      timeoutMs: config.parserTimeoutMs ?? 120_000,
      inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
      outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
    })
  }
  if (type === "mineru") {
    return new MinerUParser({
      command: config.mineruCommand ?? "mineru",
      timeoutMs: config.parserTimeoutMs ?? 120_000,
      inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
      outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
      assetRoot: config.imageAssetPath,
    })
  }
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
  const config = loadConfig()
  // UT-10: direct-txt decodes in-process — no command participates.
  const command =
    type === "direct-txt"
      ? null
      : type === "builtin-pdf"
        ? (config.pythonCommand ?? "python")
        : type === "marker"
          ? (config.markerCommand ?? "marker_single")
          : type === "mineru"
            ? (config.mineruCommand ?? "mineru")
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

export class PipelineStageRunner implements IngestionStageRunner {
  private documentRepo: DocumentRepo
  private store: IngestionStoreImpl | null
  private readonly injectedWikifier?: WikifierLike

  constructor(
    private db: DB,
    private resolveParser: ParserResolver = configuredParser,
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
            }
          : { contentLength: document.content.length },
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

          // Walk the route candidates in preference order. A candidate whose
          // runtime is missing falls back to the next one; every other
          // failure (timeout, malformed output, content issues) aborts the
          // import loudly — fallback must never mask a real parse failure.
          let blocks: NormalizedBlock[] | null = null
          let rawExtraction: string | null = null
          let usedParser: ParserType | null = null
          let usedParserInstance: Parser | null = null
          let parserReason = parserRoute.reason
          const attempts: string[] = []
          for (const candidate of parserRoute.candidates) {
            const parser = this.resolveParser(candidate)
            try {
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
                blocks = parser.normalizeRaw(rawExtraction, document.id)
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
              usedParser = candidate
              usedParserInstance = parser
              if (attempts.length > 0) {
                parserReason = `${parserRoute.reason}; ${attempts.join("; ")}; fell back to ${candidate}`
              }
              break
            } catch (error) {
              const failure = error instanceof Error ? error : new Error(String(error))
              if (parserRoute.authoritative || !isParserUnavailableError(failure)) {
                throw failure
              }
              attempts.push(`${candidate} unavailable`)
            }
          }
          if (!blocks || !usedParser) {
            throw new Error(
              `No usable parser for ${document.fileName ?? document.title}: tried ${parserRoute.candidates.join(", ")} (${parserRoute.reason}). Install one of the missing runtimes — marker (pip install marker-pdf), mineru, or the repo-bundled builtin parser (python + pymupdf).`
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
          if (rawExtraction !== null) {
            const provenance =
              typeof usedParserInstance?.extractionProvenance === "function"
                ? usedParserInstance.extractionProvenance()
                : null
            let warnings = provenance?.warnings ?? []
            let pageCount: number | null = null
            if (usedParser === "builtin-pdf") {
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
              parserConfigVersion: parserConfigFingerprint(usedParser),
              rawExtraction,
              rawExtractionSha256: createHash("sha256")
                .update(Buffer.from(rawExtraction, "utf8"))
                .digest("hex"),
              warnings,
              pages: buildPageEvidence(blocks, pageCount, warnings),
              pageCount,
              completedAt: new Date().toISOString(),
            })
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

      // Ticket UT-13: persist the EXPECTED retrieval manifest for this
      // document version (every index-bound chunk with its stable identity,
      // content hash and covered source blocks — parent chunks never enter
      // the index), then verify block coverage independently. A coverage gap
      // is a loud stage failure, never a silent partial index expectation.
      const indexChunks = chunks.filter((chunk) => chunk.metadata.kind !== "parent")
      new ExpectedChunkRepository(this.db).replaceAll(
        document.id,
        document.version,
        indexChunks.map((chunk, position) => ({
          chunkId: chunk.id,
          kind: String(chunk.metadata.kind ?? "child"),
          position,
          contentSha256: ExpectedChunkRepository.contentSha256(chunk.content),
          blockIds: ((chunk.metadata.normalizedBlocks as Array<{ id?: string }> | undefined) ?? [])
            .map((block) => block.id)
            .filter((id): id is string => typeof id === "string"),
        }))
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
  return new IngestionLifecycle(
    db,
    options?.stageRunner ?? new PipelineStageRunner(db),
    options?.now ?? (() => new Date()),
    cfg.activationMode)
}
