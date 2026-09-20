/**
 * Eval refactor Ticket 02 — Isolated evaluation resources.
 *
 * A prepare/ready/run/dispose lifecycle that ingests an evaluation corpus
 * (every passage INCLUDING distractors) into a dedicated, task-owned search
 * scope and runs real Answer questions against it — without touching the
 * business library, business conversations, or persistent trace backends.
 *
 * Task ownership (one identity, every layer):
 *   - tenantId = `eval-<sanitized-taskId>` → stamped on sources, documents,
 *     ES chunks, graph provenance, PageIndex nodes, conversation turns,
 *     handoff cases.
 *   - namespace = same string → source identity namespace.
 *   - ES index = `kefu-rag-chunks-eval-<sanitized-taskId>` → a dedicated
 *     chunk index per scope. Eval writes never enter the business index;
 *     dispose deletes the whole index, so "released ⇒ no longer retrievable"
 *     holds structurally, not just by query filtering.
 *
 * Graph note (deliberate, per spec "图谱清理以明确的任务所有权及
 * provenance 为依据，不按相同实体名称删除其他任务或业务图节点"):
 * Entity nodes are content-addressed (deterministic uuid v5 of name) and
 * carry no ownership — they are a shared vocabulary MERGEd across tenants.
 * Relation ownership lives in the JSON provenance entries themselves, so
 * dispose strips only this scope's entries and deletes a relation only once
 * nothing remains of it (business provenance on a shared relation survives).
 * Entity nodes are NEVER deleted. Orphaned entities are inert (queries
 * authorize through provenance + ES recheck under the tenant filter).
 * Crash-residue sweep is Ticket 14's scope.
 *
 * Memory-only side channel: conversation turns, handoffs, and run traces live
 * in ONE `openDb(":memory:")` SQLite instance owned by the scope. The eval
 * AnswerRuntime uses NoopLangfuseExporter and the in-memory trace collector
 * — nothing reaches the business DB or a persistent observation backend.
 */

import type { Client } from "@elastic/elasticsearch"
import type OpenAI from "openai"
import type { Driver } from "neo4j-driver"
import type { AppConfig } from "../config"
import type { AccessContext } from "../access/context"
import { ALL_LOCAL_SCOPES } from "../access/context"
import type { AnswerRunEvent } from "../types"
import type { Chunk } from "../types"
import type { AnswerRunObserver } from "../answer/generation"
import { AnswerRuntime } from "../answer/runtime"
import { AnswerTraceRepository } from "../answer/trace_repository"
import { NoopLangfuseExporter } from "../answer/langfuse_exporter"
import { SqliteConversationStore } from "../answer/conversation_store"
import { SqliteHandoffStore } from "../answer/handoff_store"
import {
  createIngestionLifecycle,
  PipelineStageRunner,
  type WikifierLike,
} from "../ingestion/pipeline"
import type { IngestionLifecycle } from "../ingestion/lifecycle"
import { openDb, type DB } from "../ingestion/tracking/db"
import { PageIndexRepository } from "../ingestion/tracking/page_index_repo"
import { ActiveVersionRepository } from "../ingestion/tracking/active_version_repo"
import {
  IngestionStoreImpl,
  type KnowledgeAccessMetadata,
  type KnowledgePersistenceDependencies,
} from "../ingestion/storage/store"
import { RuntimeSearchOperations } from "../retrieval/search/searcher"
import {
  createDedicatedReranker,
  type Reranker,
} from "../retrieval/search/dedicated_reranker"
import {
  createSharedAnswerEntry,
  type SharedAnswerEventsSource,
} from "../mastra/shared_answer_entry"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One corpus passage. Every passage is ingested — including distractors
 * that no case marks as relevant (spec US #6). */
export interface EvalCorpusPassage {
  passageId: string
  title?: string
  content: string
}

export interface IsolatedEvalClients {
  /** ES client of the shared cluster (business index lives there too). */
  es: Client
  chatClient: OpenAI
  embeddingClient: OpenAI
  /**
   * Graph driver of the shared cluster. Required: omitting it would let the
   * ingestion store and search operations fall back to the business
   * singleton driver and write this scope's provenance into the business
   * graph — isolation is structural, not conventional.
   */
  graphDriver: Driver
}

export interface IsolatedEvalResourceOptions {
  /** Unique scope id (uuid recommended) — the single ownership source. */
  taskId: string
  config: AppConfig
  clients: IsolatedEvalClients
  /** LLM boundary of the wikify stage. Omitted → production LLMWikifier. */
  wikifier?: WikifierLike
  /** Clock override (tests skip the lifecycle's retry backoff). */
  now?: () => Date
  /** Readiness poll budget for "index searchable" verification. */
  readinessTimeoutMs?: number
  readinessIntervalMs?: number
  /** Overall prepare budget (submit + drive + readiness). */
  prepareTimeoutMs?: number
  /**
   * Dedicated reranker for this scope (Ticket 03). Default: built from the
   * RERANK_* config. An evaluation task with a per-run rerank model override
   * (Ticket 11) passes its own adapter so the shared default is untouched.
   */
  reranker?: Reranker
}

export interface EvalDisposeReport {
  /**
   * deleted | not_found (already gone) | skipped (this scope never created
   * resources, so nothing of its own existed to delete) | failed
   */
  esIndex: "deleted" | "not_found" | "skipped" | "failed"
  esError?: string
  /** cleaned | skipped (never created resources) | failed */
  graphProvenance: "cleaned" | "skipped" | "failed"
  graphError?: string
  /** The in-memory SQLite (tracking + sessions + traces) was closed. */
  dbClosed: boolean
}

/** Thrown when prepare fails; carries the best-effort cleanup report. */
export class EvalPrepareError extends Error {
  constructor(
    message: string,
    readonly cleanupReport: EvalDisposeReport
  ) {
    super(message)
    this.name = "EvalPrepareError"
  }
}

export interface EvalTraceCollector extends AnswerRunObserver {
  readonly events: readonly AnswerRunEvent[]
  eventsByCase(caseId: string): AnswerRunEvent[]
}

export interface IsolatedEvalAnswerEntry {
  /**
   * The shared Answer run entry (ticket 01) wired to the isolated scope.
   * The scope's AccessContext is ALWAYS injected — a caller cannot point an
   * eval run at another tenant.
   */
  eventsSource: SharedAnswerEventsSource
  accessContext: AccessContext
  traceCollector: EvalTraceCollector
}

export interface IsolatedEvalResources {
  readonly taskId: string
  readonly tenantId: string
  readonly namespace: string
  readonly esIndex: string
  readonly accessContext: AccessContext
  getState(): "created" | "prepared" | "disposed"
  /**
   * Ingest the FULL corpus (relevant passages AND distractors) through the
   * production ingestion lifecycle into the dedicated scope, then wait until
   * the chunk index is searchable. Resolves only when every passage is
   * ingested and visible; rejects with {@link EvalPrepareError} (including a
   * best-effot cleanup report) otherwise.
   */
  prepare(corpus: EvalCorpusPassage[]): Promise<void>
  /** Reverse lookup: chunk (by documentId) → stable passageId, or null. */
  passageIdForChunk(chunk: { documentId: string }): string | null
  /** docId per passageId (prepared corpus bookkeeping). */
  docIdForPassage(passageId: string): string | null
  /** Build the isolated shared-Answer entry (memory stores, no exports). */
  createAnswerEntry(): Promise<IsolatedEvalAnswerEntry>
  /**
   * Bounded, idempotent cleanup: delete the dedicated ES index, remove this
   * scope's graph provenance (never shared entity nodes), close the
   * in-memory SQLite. Safe to call more than once and after failed prepares.
   * Deletion is gated on this scope having created resources itself
   * (`skipped` otherwise), so disposing a scope whose prepare failed on a
   * taskId collision cannot delete the live scope that owns those names.
   */
  dispose(): Promise<EvalDisposeReport>
}

// ---------------------------------------------------------------------------
// Scope identity derivation
// ---------------------------------------------------------------------------

const TENANT_PREFIX = "eval-"
const ES_INDEX_PREFIX = "kefu-rag-chunks-eval-"
const SANITIZED_LENGTH = 32
const MIN_TASK_ID_LENGTH = 8

function sanitizeTaskId(taskId: string): string {
  const sanitized = taskId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()
  if (sanitized.length < MIN_TASK_ID_LENGTH) {
    throw new Error(
      `taskId must contain at least ${MIN_TASK_ID_LENGTH} alphanumeric characters: ${JSON.stringify(taskId)}`
    )
  }
  return sanitized.slice(0, SANITIZED_LENGTH)
}

// ---------------------------------------------------------------------------
// Counting ingestion store (unique chunk identities → readiness expectation)
// ---------------------------------------------------------------------------

class ScopeIngestionStore extends IngestionStoreImpl {
  private readonly chunkKeys = new Set<string>()

  constructor(deps: KnowledgePersistenceDependencies) {
    super(deps)
  }

  override async storeChunks(
    chunks: Chunk[],
    accessMetadata: KnowledgeAccessMetadata
  ): Promise<void> {
    await super.storeChunks(chunks, accessMetadata)
    for (const chunk of chunks) {
      this.chunkKeys.add(`${chunk.documentId}:${chunk.id}`)
    }
  }

  override async close(): Promise<void> {
    // Borrowed clients (shared with production): the scope never closes
    // them. IngestionStoreImpl.close() would close the shared ES client.
  }

  get totalStoredChunks(): number {
    return this.chunkKeys.size
  }
}

// ---------------------------------------------------------------------------
// Graph provenance cleanup
// ---------------------------------------------------------------------------

/**
 * Graph ownership is read from provenance and decided in this process, not by
 * a Cypher string match: relations carry no separate ownership field, a
 * relation belongs to every tenant whose `storeWikilinks` merged provenance
 * into it, and each entry is the JSON array [documentId, chunkId, tenantId,
 * allowedGroups, weight] (`Neo4jStore.storeWikilinks`). The needle only
 * narrows the initial scan; the strip/recompute decision parses the entries.
 * Entity nodes are shared vocabulary and are never touched here.
 */
const GRAPH_SELECT_OWNED_RELATIONS = `
  MATCH (a:Entity)-[r:WIKILINK]->(b:Entity)
  WHERE any(p IN coalesce(r.provenance, []) WHERE p CONTAINS $needle)
  RETURN elementId(r) AS rid, r.provenance AS provenance
`.trim()

/** Drop this scope's share but keep the relation alive. */
const GRAPH_UPDATE_RELATION_PROVENANCE = `
  MATCH ()-[r:WIKILINK]->()
  WHERE elementId(r) = $rid
  SET r.provenance = $remaining
`.trim()

/**
 * Same, plus restoring the weight to the max of the surviving contributors.
 * The writer max-merges (`SET r.weight = CASE WHEN $weight > r.weight ...`),
 * so without this a released scope would leave its larger weight behind on a
 * relation that the business tenant still owns.
 */
const GRAPH_UPDATE_RELATION_PROVENANCE_AND_WEIGHT = `
  MATCH ()-[r:WIKILINK]->()
  WHERE elementId(r) = $rid
  SET r.provenance = $remaining, r.weight = $maxWeight
`.trim()

/** No contributor left — the relation itself belonged to this scope. */
const GRAPH_DELETE_RELATION = `
  MATCH ()-[r:WIKILINK]->()
  WHERE elementId(r) = $rid
  DELETE r
`.trim()

/** Exact JSON-element form of a tenant inside a provenance entry. */
function provenanceTenantNeedle(tenantId: string): string {
  // Provenance entries are JSON arrays — the tenant element is always
  // preceded by `","` and followed by `",[` (the allowedGroups array). These
  // delimiters keep the scan narrow: a prefix tenant can never match another
  // tenant's element. The deal-breaking decision is still the parsed
  // comparison in `parseProvenance`, so an over-match here is harmless.
  return `","${tenantId}",[`
}

interface ParsedProvenanceEntry {
  /** The entry exactly as stored — written back untouched when it survives. */
  raw: string
  /** Parsed tenant element, or null when the entry is malformed. */
  tenant: string | null
  /** Parsed contributor weight element, or null (malformed / legacy entry). */
  weight: number | null
}

function parseProvenance(raw: unknown): ParsedProvenanceEntry[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((entry) => {
      try {
        const parsed: unknown = JSON.parse(entry)
        if (!Array.isArray(parsed)) return { raw: entry, tenant: null, weight: null }
        const weight = parsed[4]
        return {
          raw: entry,
          tenant: typeof parsed[2] === "string" ? parsed[2] : null,
          weight:
            typeof weight === "number" && Number.isFinite(weight) ? weight : null,
        }
      } catch {
        // Unparseable entry: keep it (never drop data we cannot attribute)
        // and never match it against this scope's tenant.
        return { raw: entry, tenant: null, weight: null }
      }
    })
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_READINESS_TIMEOUT_MS = 30_000
const DEFAULT_READINESS_INTERVAL_MS = 200
const DEFAULT_PREPARE_TIMEOUT_MS = 10 * 60_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createIsolatedEvalResources(
  options: IsolatedEvalResourceOptions
): IsolatedEvalResources {
  const { taskId, config, clients } = options
  const sanitized = sanitizeTaskId(taskId)
  const tenantId = TENANT_PREFIX + sanitized
  const namespace = tenantId
  const esIndex = ES_INDEX_PREFIX + sanitized

  const now = options.now ?? (() => new Date())
  const readinessTimeoutMs =
    options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
  const readinessIntervalMs =
    options.readinessIntervalMs ?? DEFAULT_READINESS_INTERVAL_MS
  const prepareTimeoutMs =
    options.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS
  // Ticket 03: evaluation uses the same dedicated rerank adapter as normal
  // chat; Ticket 11 can inject a per-task model override.
  const reranker =
    options.reranker ??
    createDedicatedReranker({
      baseUrl: config.rerankBaseUrl,
      apiKey: config.rerankApiKey,
      model: config.rerankModel,
      timeoutMs: config.rerankTimeoutMs,
      maxDocumentChars: config.rerankMaxDocumentChars,
    })

  // One in-memory SQLite owns tracking + sessions + traces for the scope.
  const db: DB = openDb(":memory:")

  const store = new ScopeIngestionStore({
    esClient: clients.es,
    embeddingClient: clients.embeddingClient,
    embeddingModel: config.embeddingModel,
    embeddingDimensions: config.embeddingDimensions,
    graphDriver: clients.graphDriver,
    indexName: esIndex,
  })
  const stageRunner = new PipelineStageRunner(
    db,
    undefined,
    store,
    options.wikifier ?? undefined
  )
  const lifecycle: IngestionLifecycle = createIngestionLifecycle(db, {
    stageRunner,
    activationMode: "auto",
    now,
  })

  const accessContext: AccessContext = {
    tenantId,
    subjectId: `eval:${sanitized}`,
    groups: [],
    scopes: [...ALL_LOCAL_SCOPES],
  }

  let state: "created" | "prepared" | "disposed" = "created"
  // Ownership gate for cleanup: until this scope has submitted its own
  // corpus it has created nothing, so disposing it must not delete anything
  // — otherwise a scope whose prepare failed on an index collision (same
  // taskId → same derived index/tenant) would delete the live scope that
  // actually owns those resources.
  let scopeOwnsResources = false
  const docIdByPassage = new Map<string, string>()
  const passageByDocId = new Map<string, string>()

  // -------------------------------------------------------------------------
  // Cleanup (shared by dispose and failed prepares)
  // -------------------------------------------------------------------------

  async function cleanupEsIndex(): Promise<{
    outcome: EvalDisposeReport["esIndex"]
    error?: string
  }> {
    if (!scopeOwnsResources) return { outcome: "skipped" }
    try {
      await clients.es.indices.delete({ index: esIndex })
      return { outcome: "deleted" }
    } catch (error) {
      const status = (error as { meta?: { statusCode?: number } })?.meta
        ?.statusCode
      if (status === 404) return { outcome: "not_found" }
      return {
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async function cleanupGraph(): Promise<{
    outcome: EvalDisposeReport["graphProvenance"]
    error?: string
  }> {
    if (!scopeOwnsResources) return { outcome: "skipped" }
    const session = clients.graphDriver.session()
    try {
      const needle = provenanceTenantNeedle(tenantId)
      const selected = await session.run(GRAPH_SELECT_OWNED_RELATIONS, { needle })
      for (const record of selected.records) {
        const rid = record.get("rid")
        const entries = parseProvenance(record.get("provenance"))
        const remaining = entries.filter((entry) => entry.tenant !== tenantId)
        // Needle over-match (or a concurrent cleanup): nothing of ours here.
        if (remaining.length === entries.length) continue
        if (remaining.length === 0) {
          await session.run(GRAPH_DELETE_RELATION, { rid })
          continue
        }
        const remainingRaw = remaining.map((entry) => entry.raw)
        const weights = remaining.map((entry) => entry.weight)
        if (weights.every((weight): weight is number => weight !== null)) {
          // Every survivor carries its own weight → restore the relation to
          // the max of the survivors (the writer's max-merge semantics).
          await session.run(GRAPH_UPDATE_RELATION_PROVENANCE_AND_WEIGHT, {
            rid,
            remaining: remainingRaw,
            maxWeight: Math.max(...weights),
          })
        } else {
          // Legacy/malformed survivor without a weight element: keep the
          // relation weight as-is rather than guessing it downward.
          await session.run(GRAPH_UPDATE_RELATION_PROVENANCE, {
            rid,
            remaining: remainingRaw,
          })
        }
      }
      return { outcome: "cleaned" }
    } catch (error) {
      return {
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      await session.close()
    }
  }

  let dbClosed = false
  function closeDb(): boolean {
    if (dbClosed) return true
    db.close()
    dbClosed = true
    return true
  }

  async function runCleanup(): Promise<EvalDisposeReport> {
    const es = await cleanupEsIndex()
    const graph = await cleanupGraph()
    return {
      esIndex: es.outcome,
      ...(es.error ? { esError: es.error } : {}),
      graphProvenance: graph.outcome,
      ...(graph.error ? { graphError: graph.error } : {}),
      dbClosed: closeDb(),
    }
  }

  // -------------------------------------------------------------------------
  // Prepare
  // -------------------------------------------------------------------------

  function assertValidCorpus(corpus: EvalCorpusPassage[]): void {
    if (!Array.isArray(corpus) || corpus.length === 0) {
      throw new Error("corpus must be a non-empty array of passages")
    }
    const seen = new Set<string>()
    for (const passage of corpus) {
      if (!passage.passageId?.trim()) {
        throw new Error("every corpus passage requires a non-empty passageId")
      }
      if (!passage.content?.trim()) {
        throw new Error(
          `passage ${passage.passageId} requires non-empty content`
        )
      }
      if (seen.has(passage.passageId)) {
        throw new Error(`duplicate passageId in corpus: ${passage.passageId}`)
      }
      seen.add(passage.passageId)
    }
  }

  /** Drive the lifecycle until no claimable task remains. Retry-scheduled
   * tasks are waited out within the prepare budget (tests advance the
   * injected clock instead of sleeping). */
  async function driveLifecycle(): Promise<void> {
    const deadline = now().getTime() + prepareTimeoutMs
    for (;;) {
      const result = await lifecycle.runNext()
      if (!result) {
        const pending = (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM task_pending_ops WHERE status = 'pending'`
            )
            .get() as { n: number }
        ).n
        if (pending === 0) return
        if (now().getTime() > deadline) {
          throw new Error(
            `prepare timed out with ${pending} pending ingestion task(s)`
          )
        }
        // With a real clock: wait one interval. With a test clock: the
        // caller advances time between awaits, so this resolves instantly.
        await sleep(readinessIntervalMs)
      }
    }
  }

  function assertAllDocumentsSucceeded(docIds: string[]): void {
    const placeholders = docIds.map(() => "?").join(",")
    const rows = db.prepare(
      `SELECT doc_id, status FROM documents WHERE doc_id IN (${placeholders})`
    ).all(...docIds) as Array<{ doc_id: string; status: string }>
    const byId = new Map(rows.map((row) => [row.doc_id, row.status]))
    const failed = docIds.filter((docId) => byId.get(docId) !== "completed")
    if (failed.length > 0) {
      throw new Error(
        `ingestion failed for passage(s): ${failed
          .map((docId) => passageByDocId.get(docId) ?? docId)
          .join(", ")} (status: ${failed
          .map((docId) => byId.get(docId))
          .join(", ")})`
      )
    }
  }

  async function waitForIndexReadable(expectedCount: number): Promise<void> {
    const deadline = now().getTime() + readinessTimeoutMs
    for (;;) {
      let count = -1
      try {
        const res = await clients.es.count({
          index: esIndex,
          query: { term: { tenantId } },
        })
        count = typeof res.count === "number" ? res.count : -1
      } catch {
        // Index may not be visible yet (creation propagation) — retry.
      }
      if (count >= expectedCount) return
      if (now().getTime() > deadline) {
        throw new Error(
          `chunk index did not become searchable in time: expected ${expectedCount} docs for tenant ${tenantId}, saw ${count}`
        )
      }
      await sleep(readinessIntervalMs)
    }
  }

  async function prepare(corpus: EvalCorpusPassage[]): Promise<void> {
    if (state === "disposed") {
      throw new Error("cannot prepare a disposed evaluation scope")
    }
    if (state === "prepared") {
      throw new Error("evaluation scope already prepared")
    }
    // Pre-flight checks happen BEFORE anything is created: a failure leaves
    // the scope in "created" (nothing to clean up, nothing burned).
    assertValidCorpus(corpus)
    const indexExists = await clients.es.indices.exists({ index: esIndex })
    if (indexExists) {
      // A colliding taskId (sanitized to the same index name) must NOT burn
      // the existing scope by cleaning it up — fail fast and leave it alone.
      throw new Error(
        `dedicated eval index already exists: ${esIndex} (taskId collision for ${JSON.stringify(taskId)}?)`
      )
    }
    try {
      // From here on the scope owns whatever it creates — a failure midway
      // must clean up (cleanup is gated on this flag).
      scopeOwnsResources = true
      const docIds: string[] = []
      for (const passage of corpus) {
        const submission = lifecycle.submit({
          title: passage.title?.trim() || `eval passage ${passage.passageId}`,
          content: passage.content,
          sourceIdentity: {
            kind: "submission",
            uriOrExternalId: `eval:${taskId}:passage:${passage.passageId}`,
            namespace,
            tenantId,
            allowedGroups: [],
          },
        })
        docIdByPassage.set(passage.passageId, submission.docId)
        passageByDocId.set(submission.docId, passage.passageId)
        docIds.push(submission.docId)
      }
      await driveLifecycle()
      assertAllDocumentsSucceeded(docIds)
      await waitForIndexReadable(store.totalStoredChunks)
      state = "prepared"
    } catch (error) {
      // Bounded, best-effort cleanup of everything this scope created so far
      // — then surface the original failure with the cleanup evidence.
      const report = await runCleanup()
      state = "disposed"
      const message = error instanceof Error ? error.message : String(error)
      throw new EvalPrepareError(
        `evaluation scope prepare failed: ${message}`,
        report
      )
    }
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  function passageIdForChunk(chunk: { documentId: string }): string | null {
    return passageByDocId.get(chunk.documentId) ?? null
  }

  async function createAnswerEntry(): Promise<IsolatedEvalAnswerEntry> {
    if (state !== "prepared") {
      throw new Error("evaluation scope must be prepared before running")
    }
    const events: AnswerRunEvent[] = []
    const traceCollector: EvalTraceCollector = {
      onEvent: (event) => events.push(event),
      get events() {
        return events
      },
      eventsByCase(caseId) {
        return events.filter(
          (event) => "caseId" in event && event.caseId === caseId
        )
      },
    }

    // Memory-only side channel: the eval runtime shares the production
    // clients but never the business DB, business trace repository, or a real
    // Langfuse exporter.
    const evalRuntime = new AnswerRuntime(
      {
        chatClient: clients.chatClient,
        embeddingClient: clients.embeddingClient,
        elasticsearch: clients.es,
        neo4jDriver: clients.graphDriver,
        db,
        close: async () => {
          /* scope-owned close happens in dispose() */
        },
      },
      new AnswerTraceRepository(db),
      new NoopLangfuseExporter()
    )

    const entry = await createSharedAnswerEntry({
      config,
      answerRuntime: evalRuntime,
      conversationStore: new SqliteConversationStore(db),
      searchOperations: new RuntimeSearchOperations({
        es: clients.es,
        embeddingClient: clients.embeddingClient,
        embeddingModel: config.embeddingModel,
        graphDriver: clients.graphDriver,
        pageIndexRepo: new PageIndexRepository(db),
        activeVersionRepo: new ActiveVersionRepository(db),
        indexName: esIndex,
        ...(reranker ? { reranker } : {}),
      }),
      handoffStore: new SqliteHandoffStore(db),
      traceObserver: traceCollector,
    })

    // The scope owns the run identity: the eval AccessContext is always
    // injected (and overrides any caller-supplied context) so an eval run
    // can never query outside its dedicated scope.
    const scopedEventsSource: SharedAnswerEventsSource = (
      message,
      runOptions
    ) => entry.eventsSource(message, { ...runOptions, accessContext })

    return { eventsSource: scopedEventsSource, accessContext, traceCollector }
  }

  async function dispose(): Promise<EvalDisposeReport> {
    const report = await runCleanup()
    state = "disposed"
    return report
  }

  return {
    taskId,
    tenantId,
    namespace,
    esIndex,
    accessContext,
    getState: () => state,
    prepare,
    passageIdForChunk,
    docIdForPassage: (passageId) => docIdByPassage.get(passageId) ?? null,
    createAnswerEntry,
    dispose,
  }
}
