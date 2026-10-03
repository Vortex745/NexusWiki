import { v4 as uuid } from "uuid"
import { createHash } from "node:crypto"
import type {
  Document,
  DocumentStatus,
  DeadLetter,
  IngestionTask,
  ProcessingSpan,
  ActivationMode,
} from "../types"
import type { DB } from "./tracking/db"
import { DocumentRepo } from "./tracking/doc_repo"
import type { DocumentVersionInfo } from "./tracking/doc_repo"
import { SpanRepo } from "./tracking/span_repo"
import { TaskRepo } from "./tracking/task_repo"
import { WikiStore } from "../wiki/store"
import { ArtifactCleanupService, isCleanupOperation } from "../knowledge/cleanup"
import { evaluateActivationGate } from "./activation_gate"
import {
  allowedOperationsFor,
  classifyIngestionError,
  redactedFailureMessage,
  type IngestionFailureCategory,
} from "./error_classification"
import {
  resolveSourceIdentity,
  sourceIdentityKey,
  type SourceIdentityInput,
} from "./source_identity"

export const INGESTION_STAGE_NAMES = [
  "chunk",
  "wikify",
  "storeChunks",
  "storeGraph",
] as const

const RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const
const RUNNING_ABORT_CONTROLLERS = new Map<string, AbortController>()

export type IngestionStageName = (typeof INGESTION_STAGE_NAMES)[number]

export interface StageExecution {
  readonly signal: AbortSignal
  runStage<T>(
    name: IngestionStageName,
    input: Record<string, unknown>,
    operation: () => Promise<T>,
    summarize: (result: T) => Record<string, unknown>
  ): Promise<T>
}

export interface IngestionStageRunner {
  run(
    document: Document,
    execution: StageExecution
  ): Promise<Record<string, unknown> | void>
  /**
   * T53: Typed close — releases shared resources owned by the stage runner
   * (e.g. ES/Neo4j/OpenAI clients). No longer duck-typed.
   */
  close(): Promise<void>
}

export interface SubmitIngestionInput {
  title: string
  content: string
  rawContent?: Buffer
  fileName?: string
  mimeType?: string
  parserOverride?: string
  source?: string
  sourceIdentity?: SourceIdentityInput
  legacySourceAliases?: string[]
  /**
   * Ticket 03 (KB-02A): the knowledge base that owns this import. Omitted →
   * the tenant's deterministic default knowledge base (legacy callers keep
   * working); the resolved value is always carried on the submission.
   */
  knowledgeBaseId?: string
  /**
   * Ticket 11 (DOC-01A): catalog metadata the caller validated (tags/folder).
   * Stored verbatim on the document row for the knowledge-base catalog.
   */
  metadata?: Record<string, unknown>
  /**
   * Ticket 12 (DOC-01B): required when the submission's identity resolves to
   * an EXISTING source whose active version has DIFFERENT content — the
   * caller must say whether this is a new version of that document or a new
   * independent document. Identical content needs no intent (it is an
   * "unchanged" no-op) and a brand-new source needs none either.
   */
  versionIntent?: "new_version" | "new_document"
}

export type IngestionSubmission = {
  docId: string
  taskId: number
  status: "pending"
  version: number
  /** Ticket 03 (KB-02A): the knowledge base the import was filed under. */
  knowledgeBaseId: string
} | {
  docId: string
  taskId: null
  status: "unchanged"
  version: number
  /** Ticket 03 (KB-02A): the knowledge base the import was filed under. */
  knowledgeBaseId: string
}

export interface SpanNode {
  span: ProcessingSpan
  children: SpanNode[]
}

export interface IngestionStatus {
  docId: string
  task: IngestionTask | null
  documentStatus: DocumentStatus | null
  lifecycleOutcome: DocumentStatus | "unchanged" | null
  documentVersion: DocumentVersionInfo
  spanTree: SpanNode[]
  /**
   * Ticket UT-04: why the joint activation gate denied this candidate, as
   * stable reason codes joined by ";" (null = active or never attempted).
   * The candidate's own status can be "completed" while this is set — stage
   * success and activation are independent since the gate.
   */
  activationBlockReason: string | null
  /**
   * Ticket UT-07/UT-08: machine-readable failure classification (category,
   * stable reason code, allowed operations) recorded when a run failed.
   * Null while the document has no recorded failure.
   */
  failure: IngestionFailureRecord | null
}

export interface IngestionFailureRecord {
  category: IngestionFailureCategory
  reasonCode: string
  retryable: boolean
  allowedOperations: string[]
  message: string
  failedAt: string
}

export interface IngestionExecutionResult {
  taskId: number
  docId: string
  rootSpanId: string
  success: boolean
  cancelled?: boolean
  error?: string
}

export interface IngestionCancellationResult {
  docId: string
  taskId: number
  /** "retired" reports a refused retry/reprocess on a retired source. */
  status: IngestionTask["status"] | "retired"
  changed: boolean
}

/**
 * Ticket 12 (DOC-01B): a submission whose identity resolves to an existing
 * source with different active content arrived without an explicit
 * version-or-new-document intent. The route maps it to 409 with the active
 * version info so the caller can decide.
 */
export class SameNameIntentRequiredError extends Error {
  constructor(readonly activeDocId: string, readonly activeVersion: number) {
    super(
      "this source already exists with different content — specify an explicit intent: new_version or new_document"
    )
    this.name = "SameNameIntentRequiredError"
  }
}

function buildSpanTree(spans: ProcessingSpan[]): SpanNode[] {
  const byId = new Map<string, SpanNode>()
  const roots: SpanNode[] = []

  for (const span of spans) {
    byId.set(span.spanId, { span, children: [] })
  }
  for (const span of spans) {
    const node = byId.get(span.spanId)!
    if (span.parentSpanId && byId.has(span.parentSpanId)) {
      byId.get(span.parentSpanId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }

  return roots
}

/** Ticket UT-07/UT-08: read the persisted failure record from doc metadata. */
function readFailureRecord(document: Document | null): IngestionFailureRecord | null {
  const system = (document?.metadata as { system?: { failure?: IngestionFailureRecord } } | undefined)?.system
  const failure = system?.failure
  if (!failure || typeof failure !== "object" || typeof failure.category !== "string") {
    return null
  }
  return failure
}

class TrackedStageExecution implements StageExecution {
  private nextStageIndex = 0

  constructor(
    private spanRepo: SpanRepo,
    private stageSpanIds: Map<IngestionStageName, string>,
    private now: () => Date,
    readonly signal: AbortSignal
  ) {}

  async runStage<T>(
    name: IngestionStageName,
    input: Record<string, unknown>,
    operation: () => Promise<T>,
    summarize: (result: T) => Record<string, unknown>
  ): Promise<T> {
    const expectedStage = INGESTION_STAGE_NAMES[this.nextStageIndex]
    if (name !== expectedStage) {
      throw new Error(
        expectedStage
          ? `Expected ingestion stage ${expectedStage}, received ${name}`
          : `Ingestion stage ${name} was already completed`
      )
    }

    const spanId = this.stageSpanIds.get(name)
    if (!spanId) {
      throw new Error(`Unknown ingestion stage: ${name}`)
    }

    const startedAt = this.now()
    if (!this.spanRepo.markRunning(spanId, input, startedAt.toISOString())) {
      throw new Error(`Ingestion stage ${name} is not pending`)
    }
    try {
      const result = await operation()
      const finishedAt = this.now()
      if (
        !this.spanRepo.markDone(
          spanId,
          summarize(result),
          finishedAt.toISOString(),
          finishedAt.getTime() - startedAt.getTime()
        )
      ) {
        throw new Error(`Ingestion stage ${name} could not be completed`)
      }
      this.nextStageIndex += 1
      return result
    } catch (error) {
      const finishedAt = this.now()
      this.spanRepo.markFailed(
        spanId,
        error instanceof Error ? error.message : String(error),
        finishedAt.toISOString(),
        finishedAt.getTime() - startedAt.getTime(),
        error instanceof Error ? error.stack ?? null : null
      )
      throw error
    }
  }

  assertComplete(): void {
    if (this.nextStageIndex !== INGESTION_STAGE_NAMES.length) {
      throw new Error(
        `Ingestion execution stopped before ${INGESTION_STAGE_NAMES[this.nextStageIndex]}`
      )
    }
  }
}

export class IngestionLifecycle {
  private docRepo: DocumentRepo
  private spanRepo: SpanRepo
  private taskRepo: TaskRepo

  constructor(
    private db: DB,
    private stageRunner: IngestionStageRunner,
    private now: () => Date = () => new Date(),
    private activationMode: ActivationMode = "auto",
    private cleanup: Pick<ArtifactCleanupService, "run"> = new ArtifactCleanupService(db)
  ) {
    this.docRepo = new DocumentRepo(db)
    this.spanRepo = new SpanRepo(db)
    this.taskRepo = new TaskRepo(db, now)
  }

  /**
   * T21: close the deepmodule's shared resources (ES/OpenAI/Neo4j clients).
   * T53: Now a typed close — IngestionStageRunner.close() is part of the
   * interface, no longer duck-typed. Full graceful shutdown wiring is T22's scope.
   */
  async close(): Promise<void> {
    await this.stageRunner.close()
  }

  submit(input: SubmitIngestionInput): IngestionSubmission {
    const docId = uuid()
    const sourceBytes = input.rawContent ?? Buffer.from(input.content, "utf8")
    const contentHash = createHash("sha256").update(sourceBytes).digest("hex")
    let identity = resolveSourceIdentity(
      input.sourceIdentity,
      input.source,
      docId,
      input.knowledgeBaseId
    )
    // Ticket 12 (DOC-01B): "new_document" means this content must NOT ride
    // the existing source's version history — a fresh namespace detaches the
    // source key (same uri for display, new identity for isolation).
    if (input.versionIntent === "new_document") {
      identity = { ...identity, namespace: uuid() }
    }
    const sourceKey = sourceIdentityKey(identity)

    return this.db.transaction((): IngestionSubmission => {
      let source = this.docRepo.getSourceByKey(sourceKey)
      // Ticket 12 (DOC-01B): "new_document" must not be re-anchored onto a
      // legacy alias — the caller explicitly detached this submission into
      // its own source.
      if (identity.kind === "file" && input.versionIntent !== "new_document" && input.legacySourceAliases?.length) {
        const matches = this.docRepo.listLegacySources().filter((candidate) =>
          candidate.tenantId === identity.tenantId &&
          // Ticket 03 (KB-02A): a legacy Source may only be adopted into the
          // knowledge base it belongs to — the same file in two knowledge
          // bases stays two Source identities (criterion 2).
          candidate.knowledgeBaseId === identity.knowledgeBaseId &&
          resolveSourceIdentity(
            { kind: "file", uriOrExternalId: candidate.uri, namespace: "local" },
            undefined,
            docId
          ).uri === identity.uri
        )
        const candidates = source ? [source, ...matches] : matches
        const ranked = candidates
          .map((candidate) => ({
            candidate,
            active: this.docRepo.getActive(candidate.sourceId),
          }))
          .sort((left, right) => {
            const timeDifference = (right.active?.createdAt.getTime() ?? 0) -
              (left.active?.createdAt.getTime() ?? 0)
            return timeDifference ||
              left.candidate.sourceId.localeCompare(right.candidate.sourceId)
          })
        const preferred = ranked[0] ?? null
        const canonicalSource = source ?? preferred?.candidate ?? null
        if (canonicalSource && matches.length) {
          this.docRepo.adoptCanonicalSource(
            canonicalSource.sourceId,
            matches
              .filter((candidate) => candidate.sourceId !== canonicalSource.sourceId)
              .map((candidate) => candidate.sourceId),
            {
              sourceKey,
              kind: identity.kind,
              uri: identity.uri,
              namespace: identity.namespace,
              tenantId: identity.tenantId,
              allowedGroups: identity.allowedGroups,
              knowledgeBaseId: identity.knowledgeBaseId,
            },
            preferred?.active?.id ?? null
          )
        }
        source = canonicalSource
      }
      if (!source) {
        source = this.docRepo.createSource({
          sourceId: uuid(),
          sourceKey,
          kind: identity.kind,
          uri: identity.uri,
          namespace: identity.namespace,
          tenantId: identity.tenantId,
          allowedGroups: identity.allowedGroups,
          knowledgeBaseId: identity.knowledgeBaseId,
        })
      }

      const active = this.docRepo.getActive(source.sourceId)
      if (active?.contentHash === contentHash) {
        this.docRepo.recordOutcome(source.sourceId, active.id, "unchanged")
        return {
          docId: active.id,
          taskId: null,
          status: "unchanged",
          version: active.version,
          knowledgeBaseId: identity.knowledgeBaseId,
        }
      }

      const inFlight = this.docRepo.getInFlightByHash(source.sourceId, contentHash)
      if (inFlight) {
        const task = this.taskRepo.getByDocId(inFlight.id)
        if (task) {
          return {
            docId: inFlight.id,
            taskId: task.id,
            status: "pending",
            version: inFlight.version,
            knowledgeBaseId: identity.knowledgeBaseId,
          }
        }
      }

      // Ticket UT-04: while the joint activation gate keeps candidates
      // inactive, identity semantics must reference the LATEST submission and
      // not only the active version — an identical re-submission of a blocked
      // candidate is still a no-op, never a silent new version.
      const latest = this.docRepo.getLatestDocument(source.sourceId)
      if (latest && latest.contentHash === contentHash) {
        this.docRepo.recordOutcome(source.sourceId, latest.id, "unchanged")
        return {
          docId: latest.id,
          taskId: null,
          status: "unchanged",
          version: latest.version,
          knowledgeBaseId: identity.knowledgeBaseId,
        }
      }

      // Ticket 12 (DOC-01B): same source + different content + no explicit
      // intent = refused BEFORE any document row exists. Identical content
      // (active or in-flight) has already returned above without intent.
      if (active && !input.versionIntent) {
        throw new SameNameIntentRequiredError(active.id, active.version)
      }

      const version = this.docRepo.getNextVersion(source.sourceId)
      this.docRepo.insert({
        docId,
        sourceId: source.sourceId,
        contentHash,
        version,
        title: input.title,
        source: identity.kind === "submission" ? "api" : identity.uri,
        content: input.content,
        rawContent: input.rawContent,
        fileName: input.fileName,
        mimeType: input.mimeType,
        parserOverride: input.parserOverride,
        // Ticket 06 P2: inherit access metadata from the resolved Source row.
        // Sources table columns are NOT NULL DEFAULT so this always carries
        // real values — 'default' / '[]' in single-tenant mode.
        tenantId: source.tenantId,
        allowedGroups: source.allowedGroups,
        knowledgeBaseId: source.knowledgeBaseId,
        // Ticket 11 (DOC-01A): caller-validated catalog metadata (tags/folder).
        metadata: input.metadata,
      })
      const taskId = this.taskRepo.enqueue({
        docId,
        op: "ingest",
        payload: {
          title: input.title,
          contentLength: sourceBytes.length,
          ...(input.fileName ? { fileName: input.fileName } : {}),
          ...(input.mimeType ? { mimeType: input.mimeType } : {}),
          ...(input.parserOverride ? { parserOverride: input.parserOverride } : {}),
        },
      })
      this.docRepo.recordOutcome(source.sourceId, docId, "pending")
      return { docId, taskId, status: "pending", version, knowledgeBaseId: identity.knowledgeBaseId }
    })()
  }

  getStatus(docId: string): IngestionStatus | null {
    if (!this.docRepo.exists(docId)) return null

    const documentVersion = this.docRepo.getVersionInfo(docId)
    if (!documentVersion) return null

    return {
      docId,
      task: this.taskRepo.getByDocId(docId),
      documentStatus: this.docRepo.getStatus(docId),
      lifecycleOutcome: this.docRepo.getLifecycleOutcome(docId),
      documentVersion,
      spanTree: buildSpanTree(this.spanRepo.listByDoc(docId)),
      activationBlockReason: this.docRepo.getActivationBlockReason(docId),
      failure: readFailureRecord(this.docRepo.get(docId)),
    }
  }

  getDeadLetter(taskId: number): DeadLetter | null {
    return this.taskRepo.getDeadLetter(taskId)
  }

  cancel(docId: string): IngestionCancellationResult | null {
    const task = this.taskRepo.getByDocId(docId)
    if (!task) return null
    if (task.status !== "pending" && task.status !== "running") {
      return { docId, taskId: task.id, status: task.status, changed: false }
    }

    return this.db.transaction((): IngestionCancellationResult => {
      const changed = this.taskRepo.cancel(task.id)
      if (!changed) {
        const current = this.taskRepo.getByDocId(docId)!
        return {
          docId,
          taskId: current.id,
          status: current.status,
          changed: false,
        }
      }
      this.docRepo.updateStatus(docId, "cancelled")
      this.spanRepo.cancelOpen(docId, this.now().toISOString())
      RUNNING_ABORT_CONTROLLERS.get(docId)?.abort()
      return { docId, taskId: task.id, status: "cancelled", changed: true }
    })()
  }

  /**
   * Ticket 12 (DOC-01B): manual retry of a FAILED or CANCELLED ingestion.
   * Reuses the existing task row (retry budget restarts) and flips the
   * document back to 'pending' so the worker pipeline picks it up again —
   * the same stages, the same activation gate as any other run.
   */
  retry(docId: string): IngestionCancellationResult | null {
    if (!this.docRepo.exists(docId)) return null
    const documentStatus = this.docRepo.getStatus(docId)
    const task = this.taskRepo.getByDocId(docId)
    const retryable =
      (documentStatus === "failed" || documentStatus === "cancelled") &&
      (task === null || task.status === "failed" || task.status === "cancelled")
    if (!retryable) {
      return {
        docId,
        taskId: task?.id ?? 0,
        status: task?.status ?? documentStatus ?? "pending",
        changed: false,
      }
    }
    return this.db.transaction((): IngestionCancellationResult => {
      // Ticket 12 (DOC-01B): a retired source must not be resurrected —
      // retirement purged its artifacts; requeueing would re-index them.
      const document = this.docRepo.get(docId)
      if (document && this.docRepo.getSourceLifecycleState(document.sourceId) === "retired") {
        return { docId, taskId: task?.id ?? 0, status: "retired", changed: false }
      }
      let taskId: number
      if (task) {
        if (!this.taskRepo.requeue(task.id)) {
          // Lost a race (another worker/call moved the task out of a terminal
          // state) — report the current state instead of throwing.
          const current = this.taskRepo.getByDocId(docId)
          return { docId, taskId: task.id, status: current?.status ?? "pending", changed: false }
        }
        taskId = task.id
      } else {
        taskId = this.taskRepo.enqueue({ docId, op: "ingest", payload: { retried: true } })
      }
      this.docRepo.updateStatus(docId, "pending")
      return { docId, taskId, status: "pending", changed: true }
    })()
  }

  /**
   * Ticket 12 (DOC-01B): reprocess a COMPLETED document — re-runs the whole
   * pipeline on the stored content (chunk ids are deterministic, so ES and
   * graph writes land on the same identities; the activation gate is the
   * same as any run: the active version only moves on full success).
   *
   * ponytail: reprocessing the ACTIVE version rewrites its ES/graph artifacts
   * in place — a mid-run failure can leave them half-updated (criterion 3
   * only protects candidates). Bounded by idempotent writes; route reprocess
   * through a fresh candidate version if that ever matters.
   */
  reprocess(docId: string): IngestionCancellationResult | null {
    if (!this.docRepo.exists(docId)) return null
    const documentStatus = this.docRepo.getStatus(docId)
    const task = this.taskRepo.getByDocId(docId)
    if (documentStatus !== "completed" || (task !== null && task.status !== "completed")) {
      return {
        docId,
        taskId: task?.id ?? 0,
        status: task?.status ?? documentStatus ?? "pending",
        changed: false,
      }
    }
    return this.db.transaction((): IngestionCancellationResult => {
      const document = this.docRepo.get(docId)
      if (document && this.docRepo.getSourceLifecycleState(document.sourceId) === "retired") {
        return { docId, taskId: task?.id ?? 0, status: "retired", changed: false }
      }
      let taskId: number
      if (task) {
        if (!this.taskRepo.requeue(task.id)) {
          const current = this.taskRepo.getByDocId(docId)
          return { docId, taskId: task.id, status: current?.status ?? "pending", changed: false }
        }
        taskId = task.id
      } else {
        // A legacy completed document may have no task row at all — enqueue one
        // instead of requeueing.
        taskId = this.taskRepo.enqueue({ docId, op: "ingest", payload: { reprocessed: true } })
      }
      this.docRepo.updateStatus(docId, "pending")
      return { docId, taskId, status: "pending", changed: true }
    })()
  }

  recoverStaleClaims(claimedTimeoutMs: number): number {
    if (!Number.isFinite(claimedTimeoutMs) || claimedTimeoutMs <= 0) {
      throw new Error("claimedTimeoutMs must be a positive number")
    }

    const recoveredAt = this.now()
    const cutoff = new Date(recoveredAt.getTime() - claimedTimeoutMs).toISOString()
    let recovered = 0

    while (this.db.transaction(() => {
      const task = this.taskRepo.claimStale(cutoff)
      if (!task) return false

      const error = new Error(`Ingestion claim timed out after ${claimedTimeoutMs}ms`)
      const retryDelay = RETRY_DELAYS_MS[task.failCount]
      const nextAttemptAt = retryDelay === undefined
        ? null
        : new Date(recoveredAt.getTime() + retryDelay).toISOString()
      const spans = this.spanRepo.listByDoc(task.docId)
      const root = [...spans].reverse().find(
        (span) => span.kind === "root" && span.status === "running"
      )

      if (root) {
        for (const span of spans) {
          if (span.parentSpanId === root.spanId && span.status === "running") {
            this.spanRepo.markFailed(
              span.spanId,
              error.message,
              recoveredAt.toISOString(),
              span.startedAt
                ? recoveredAt.getTime() - new Date(span.startedAt).getTime()
                : 0,
              error.stack ?? null
            )
          }
        }
        this.spanRepo.skipPendingChildren(root.spanId, recoveredAt.toISOString())
        this.spanRepo.markFailed(
          root.spanId,
          error.message,
          recoveredAt.toISOString(),
          root.startedAt
            ? recoveredAt.getTime() - new Date(root.startedAt).getTime()
            : 0,
          error.stack ?? null
        )
      }

      const recorded = retryDelay === undefined
        ? this.taskRepo.deadLetter(
            task,
            error.message,
            error.stack ?? null,
            recoveredAt.toISOString()
          )
        : this.taskRepo.recordFailure(task.id, nextAttemptAt, task.claimedAt)
      if (!recorded) {
        throw new Error(`Stale ingestion task ${task.id} could not be recovered`)
      }
      if (nextAttemptAt === null) {
        this.docRepo.updateStatus(task.docId, "failed")
      }
      return true
    })()) {
      recovered += 1
    }

    return recovered
  }

  async runNext(): Promise<IngestionExecutionResult | null> {
    const task = this.taskRepo.claimNext()
    if (!task) return null

    if (task.op !== "ingest") return this.runCleanup(task)

    const document = this.docRepo.get(task.docId)
    if (!document) {
      this.taskRepo.finalize(task.id, "failed", task.claimedAt)
      throw new Error(`Document not found: ${task.docId}`)
    }

    const rootSpanId = uuid()
    const rootStartedAt = this.now()
    const stageSpanIds = new Map<IngestionStageName, string>()

    this.db.transaction(() => {
      this.spanRepo.insert({
        docId: task.docId,
        spanId: rootSpanId,
        parentSpanId: null,
        name: "ingest",
        kind: "root",
        status: "running",
        input: { docId: task.docId },
        output: null,
        errorMessage: null,
        startedAt: rootStartedAt.toISOString(),
        finishedAt: null,
        durationMs: null,
      })

      for (const name of INGESTION_STAGE_NAMES) {
        const spanId = uuid()
        stageSpanIds.set(name, spanId)
        this.spanRepo.insert({
          docId: task.docId,
          spanId,
          parentSpanId: rootSpanId,
          name,
          kind: "stage",
          status: "pending",
          input: null,
          output: null,
          errorMessage: null,
          startedAt: null,
          finishedAt: null,
          durationMs: null,
        })
      }
    })()

    const abortController = new AbortController()
    RUNNING_ABORT_CONTROLLERS.set(task.docId, abortController)
    try {
      const execution = new TrackedStageExecution(
        this.spanRepo,
        stageSpanIds,
        this.now,
        abortController.signal
      )
      const summary = await this.stageRunner.run(
        document,
        execution
      )
      execution.assertComplete()
      this.db.transaction(() => {
        const finishedAt = this.now()
        if (
          !this.spanRepo.markDone(
            rootSpanId,
            { stages: [...INGESTION_STAGE_NAMES], ...(summary ?? {}) },
            finishedAt.toISOString(),
            finishedAt.getTime() - rootStartedAt.getTime()
          )
        ) {
          throw new Error("Ingestion root span could not be completed")
        }
        if (!this.taskRepo.finalize(task.id, "completed", task.claimedAt)) {
          throw new Error(`Ingestion task ${task.id} could not be completed`)
        }
        this.docRepo.updateStatus(task.docId, "completed")
        // P6.1 (spec L73, L1574): IngestionLifecycle owns terminal activation.
        // `ACTIVATION_MODE=review` blocks unreviewed versions from active
        // status — the completed candidate is marked `pending_review` and
        // does NOT become active until human approval via
        // `CandidateReviewStore.review()` (spec L1575). HTTP, worker,
        // pipeline, and repository do NOT implement implicit success
        // transfer. `ACTIVATION_MODE=auto` (default) preserves the existing
        // behavior — activate immediately on completion.
        if (this.activationMode === "review") {
          this.docRepo.markPendingReview(task.docId)
        } else {
          // Ticket UT-04 (UP-08): the joint activation gate. A candidate
          // without complete content-integrity and index evidence must not
          // switch the active identity — the stages succeeded, so the task
          // still completes, but the candidate stays inactive with a recorded
          // reason. The positive path arrives with UT-15/16/17; no
          // intermediate ticket may bypass this gate.
          const decision = evaluateActivationGate(
            this.docRepo.getCandidateEvidence(task.docId)
          )
          if (decision.passed) {
            this.docRepo.activate(task.docId)
            this.docRepo.clearActivationBlock(task.docId)
            if (this.docRepo.getActive(document.sourceId)?.id === document.id) {
              const wiki = new WikiStore(this.db, this.now)
              if (wiki.enabled(document.tenantId ?? "default", document.knowledgeBaseId ?? "")) {
                wiki.enqueue(document.tenantId ?? "default", document.knowledgeBaseId ?? "",
                  document.id, document.sourceId, "ingest")
              }
            }
          } else {
            this.docRepo.recordActivationBlock(task.docId, decision.reason ?? "activation_gate_denied")
          }
        }
      })()
      return { taskId: task.id, docId: task.docId, rootSpanId, success: true }
    } catch (error) {
      // Ticket UT-07/UT-08: classify before deciding whether the failure may
      // retry. Capability-missing and permanent-input errors terminate
      // immediately; only evidence-backed transient errors enter the bounded
      // 2s/4s/8s budget; cancellation keeps its own semantics.
      const classification = classifyIngestionError(error)
      const message = error instanceof Error ? error.message : String(error)
      const errorStack = error instanceof Error ? error.stack ?? null : null
      const finishedAt = this.now()
      const retryDelay = classification.retryable ? RETRY_DELAYS_MS[task.failCount] : undefined
      const nextAttemptAt = retryDelay === undefined
        ? null
        : new Date(finishedAt.getTime() + retryDelay).toISOString()
      const cancellationWon = this.db.transaction(() => {
        this.spanRepo.skipPendingChildren(rootSpanId, finishedAt.toISOString())
        this.spanRepo.markFailed(
          rootSpanId,
          message,
          finishedAt.toISOString(),
          finishedAt.getTime() - rootStartedAt.getTime(),
          errorStack
        )
        const recorded = classification.retryable && retryDelay === undefined
          ? this.taskRepo.deadLetter(
              task,
              message,
              errorStack,
            finishedAt.toISOString()
          )
          : this.taskRepo.recordFailure(task.id, nextAttemptAt, task.claimedAt)
        if (!recorded) {
          if (this.taskRepo.getById(task.id)?.status === "cancelled") return true
          throw new Error(`Ingestion task ${task.id} failure could not be recorded`)
        }
        if (nextAttemptAt === null) {
          this.docRepo.updateStatus(task.docId, "failed")
        }
        // Ticket UT-07/UT-08: persist the machine-readable failure
        // classification so the status API can explain the reason and the
        // allowed operations without exposing credentials or content.
        const currentDocument = this.docRepo.get(task.docId)
        const currentMetadata = currentDocument?.metadata ?? {}
        const currentSystem = typeof (currentMetadata as { system?: unknown }).system === "object" &&
            !Array.isArray((currentMetadata as { system?: unknown }).system)
          ? (currentMetadata as { system: Record<string, unknown> }).system
          : {}
        this.docRepo.updateMetadata(task.docId, {
          ...currentMetadata,
          system: {
            ...currentSystem,
            failure: {
              category: classification.category,
              reasonCode: classification.reasonCode,
              retryable: classification.retryable,
              allowedOperations: allowedOperationsFor(classification.category),
              message: redactedFailureMessage(error),
              failedAt: finishedAt.toISOString(),
            },
          },
        })
        return false
      })()
      if (cancellationWon) {
        return {
          taskId: task.id,
          docId: task.docId,
          rootSpanId,
          success: false,
          cancelled: true,
          error: "cancelled",
        }
      }
      return {
        taskId: task.id,
        docId: task.docId,
        rootSpanId,
        success: false,
        error: message,
      }
    } finally {
      if (RUNNING_ABORT_CONTROLLERS.get(task.docId) === abortController) {
        RUNNING_ABORT_CONTROLLERS.delete(task.docId)
      }
    }
  }

  private async runCleanup(task: IngestionTask): Promise<IngestionExecutionResult> {
    const document = this.docRepo.get(task.docId)
    if (!isCleanupOperation(task.op) || !document ||
      this.docRepo.getSourceLifecycleState(document.sourceId) !== "retired") {
      this.taskRepo.finalize(task.id, "failed", task.claimedAt)
      return { taskId: task.id, docId: task.docId, rootSpanId: "", success: false,
        error: `Unsafe or unsupported cleanup operation: ${task.op}` }
    }
    try {
      await this.cleanup.run(task.op, document)
      if (!this.taskRepo.finalize(task.id, "completed", task.claimedAt)) {
        throw new Error("cleanup task claim expired")
      }
      return { taskId: task.id, docId: task.docId, rootSpanId: "", success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const delay = RETRY_DELAYS_MS[task.failCount]
      const nextAttemptAt = delay === undefined ? null
        : new Date(this.now().getTime() + delay).toISOString()
      this.taskRepo.recordFailure(task.id, nextAttemptAt, task.claimedAt)
      return { taskId: task.id, docId: task.docId, rootSpanId: "", success: false,
        error: message }
    }
  }
}
