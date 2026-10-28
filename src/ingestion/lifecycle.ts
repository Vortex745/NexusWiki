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
import {
  allowedOperationsFor,
  classifyIngestionError,
  redactedFailureMessage,
  RETRY_DELAYS_MS,
  type IngestionFailureCategory,
} from "./error_classification"
import {
  resolveSourceIdentity,
  sourceIdentityKey,
  type SourceIdentityInput,
} from "./source_identity"
import {
  readTaskTrace,
  taskTraceFromScope,
  type TaskTraceContext,
  type TracingRuntime,
} from "../tracing/contract"

export const INGESTION_STAGE_NAMES = [
  "chunk",
  "wikify",
  "storeChunks",
  "storeGraph",
] as const

// RETRY_DELAYS_MS (Ticket 18) now lives in ./error_classification next to the
// transient classification it serves — one bounded budget for the task runner
// and the PDF quality gate's per-page Clef requests alike.
const RUNNING_ABORT_CONTROLLERS = new Map<string, AbortController>()

export type IngestionStageName = (typeof INGESTION_STAGE_NAMES)[number]

export function readProcessingPolicy(metadata: Record<string, unknown> | undefined): string | null {
  const system = metadata?.system
  if (!system || typeof system !== "object" || Array.isArray(system)) return null
  const policy = (system as Record<string, unknown>).ingestionPolicy
  if (typeof policy === "string") return policy
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return null
  const version = (policy as Record<string, unknown>).version
  return typeof version === "string" ? version : null
}

function recordPolicyCompletion(docRepo: DocumentRepo, docId: string, completedAt: Date): void {
  const document = docRepo.get(docId)
  if (!document) return
  const existingSystem = document.metadata.system
  const system = existingSystem && typeof existingSystem === "object" && !Array.isArray(existingSystem)
    ? existingSystem as Record<string, unknown>
    : {}
  const policy = system.ingestionPolicy
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return
  docRepo.updateMetadata(docId, {
    ...document.metadata,
    system: {
      ...system,
      ingestionPolicy: {
        ...(policy as Record<string, unknown>),
        completedAt: completedAt.toISOString(),
      },
    },
  })
}

export interface StageExecution {
  readonly signal: AbortSignal
  /**
   * Ticket 25: the durable execution identity this run was claimed under.
   * Stage runners present it at the injection boundary so downstream writes
   * (extraction evidence, Clef calls, OCR) can be fenced against a superseded
   * execution.
   */
  readonly executionId: string
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
  /**
   * LO-13: neutral correlation captured by the caller (the HTTP handler that
   * owns the request scope). Persisted with the task, so the worker can
   * continue the same trace after the request is gone. Absent → the task
   * runs under the root policy.
   */
  trace?: TaskTraceContext
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
   * Non-blocking warnings the activation policy accepted for this version
   * (e.g. OCR text that was not proofread). Empty for legacy rows, rejected
   * candidates and never-attempted activations — never a block reason.
   */
  activationWarnings: string[]
  /**
   * Policy version that produced the acceptance fact; null when the version
   * was not activated under a recorded acceptance.
   */
  activationPolicyVersion: string | null
  /**
   * Ticket UT-26: the candidate pipeline state ('pending_review' while
   * ACTIVATION_MODE=review holds a completed candidate for business
   * approval). Null on legacy rows — distinct from activationBlockReason,
   * which records gate denials.
   */
  candidateState: string | null
  /** Server-owned policy marker for this import (null for legacy rows). */
  processingPolicy: string | null
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
  /** Ticket 17: actionable fix guidance when the failure may be protection-related. */
  userGuidance?: string
  /**
   * Ticket 26: the page-quality audit's own detailed reason codes (verbatim,
   * e.g. `quality_failed:3` / `service_failure:timeout:5`) when the failure was
   * a quality rejection — the evidence the frontend keys off to tell a true
   * quality rejection apart from gate service unavailability. Absent otherwise.
   */
  reasonCodes?: string[]
}

export interface IngestionExecutionResult {
  taskId: number
  docId: string
  rootSpanId: string
  success: boolean
  cancelled?: boolean
  /** Ticket 25: the run was superseded by a newer execution and wrote nothing. */
  stale?: boolean
  error?: string
}

export interface IngestionCancellationResult {
  docId: string
  taskId: number
  /** "retired" reports a refused retry/reprocess on a retired source. */
  status: IngestionTask["status"] | "retired"
  changed: boolean
  /**
   * Ticket UT-18: 可解释拒绝原因（changed:false 时）——例如文件型文档缺
   * 保留原件（恢复不能凭空造出原件，应重新上传）。成功/无操作时不填。
   */
  reason?: string
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
    // Ticket 25: the claim fence — every stage advance re-checks ownership so
    // a superseded execution (cancelled, or re-claimed after a restart)
    // cannot persist stage results.
    private taskRepo: TaskRepo,
    private taskId: number,
    readonly executionId: string,
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

    // Ticket 25: fence before any span or downstream write — cancellation
    // first (cooperative abort), then execution identity (stale run).
    this.signal.throwIfAborted()
    if (!this.taskRepo.owns(this.taskId, this.executionId)) {
      throw new Error(
        `Ingestion execution ${this.executionId} no longer owns task ${this.taskId}`
      )
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
    private cleanup: Pick<ArtifactCleanupService, "run"> = new ArtifactCleanupService(db),
    /** LO-13: the worker-side runtime; absent in submit-only callers. */
    private tracing?: TracingRuntime
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
    // Reserved system metadata is server-owned. A direct submit caller must not
    // be able to pre-seed parser/policy facts that the pipeline then trusts.
    const callerMetadata = input.metadata ? { ...input.metadata } : undefined
    if (callerMetadata) delete callerMetadata.system

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
        metadata: callerMetadata,
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
          // LO-13: three primitives, not an SDK object — the payload stays
          // JSON and an old reader simply ignores the field.
          ...(input.trace ? { trace: input.trace } : {}),
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
    const activationAcceptance = this.docRepo.getActivationAcceptance(docId)
    const document = this.docRepo.get(docId)
    const processingPolicy = readProcessingPolicy(document?.metadata)

    return {
      docId,
      task: this.taskRepo.getByDocId(docId),
      documentStatus: this.docRepo.getStatus(docId),
      lifecycleOutcome: this.docRepo.getLifecycleOutcome(docId),
      documentVersion,
      spanTree: buildSpanTree(this.spanRepo.listByDoc(docId)),
      activationBlockReason: this.docRepo.getActivationBlockReason(docId),
      activationWarnings: activationAcceptance?.warningCodes ?? [],
      activationPolicyVersion: activationAcceptance?.policyVersion ?? null,
      candidateState: processingPolicy === "weknora-technical-v1"
        ? null
        : this.docRepo.getOperationalState(docId)?.candidateState ?? null,
      processingPolicy,
      failure: readFailureRecord(document),
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
  retry(docId: string, trace?: TaskTraceContext): IngestionCancellationResult | null {
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
      // Ticket UT-18: a file-based resume re-processes the RETAINED original.
      // Without the original bytes a resume cannot invent them — refuse with
      // an explainable reason instead of silently running without the source.
      if (
        document &&
        document.fileName &&
        (!document.rawContent || document.rawContent.length === 0)
      ) {
        return {
          docId,
          taskId: task?.id ?? 0,
          status: task?.status ?? documentStatus ?? "pending",
          changed: false,
          reason:
            "original file content is not retained for this document; a resume re-processes the retained original — upload the file again instead",
        }
      }
      let taskId: number
      if (task) {
        if (!this.taskRepo.requeue(task.id, trace)) {
          // Lost a race (another worker/call moved the task out of a terminal
          // state) — report the current state instead of throwing.
          const current = this.taskRepo.getByDocId(docId)
          return { docId, taskId: task.id, status: current?.status ?? "pending", changed: false }
        }
        taskId = task.id
      } else {
        taskId = this.taskRepo.enqueue({
          docId,
          op: "ingest",
          payload: { retried: true, ...(trace ? { trace } : {}) },
        })
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
  reprocess(docId: string, trace?: TaskTraceContext): IngestionCancellationResult | null {
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
      if (!document) {
        return {
          docId,
          taskId: task?.id ?? 0,
          status: task?.status ?? documentStatus ?? "pending",
          changed: false,
        }
      }
      if (this.docRepo.getSourceLifecycleState(document.sourceId) === "retired") {
        return { docId, taskId: task?.id ?? 0, status: "retired", changed: false }
      }
      // Ticket UT-18: same retained-original rule as retry() — reprocess runs
      // from the stored original bytes, never without them.
      if (document.fileName && (!document.rawContent || document.rawContent.length === 0)) {
        return {
          docId,
          taskId: task?.id ?? 0,
          status: task?.status ?? documentStatus ?? "pending",
          changed: false,
          reason:
            "original file content is not retained for this document; a reprocess re-runs from the retained original — upload the file again instead",
        }
      }

      // A completed reprocess is a NEW document version. The old version and
      // its artifacts stay intact until the new candidate passes technical
      // completion, so a mid-run failure cannot damage the active content.
      const newDocId = uuid()
      const version = this.docRepo.getNextVersion(document.sourceId)
      const metadata = { ...document.metadata }
      delete metadata.system
      this.docRepo.insert({
        docId: newDocId,
        sourceId: document.sourceId,
        contentHash: document.contentHash,
        version,
        title: document.title,
        source: document.source,
        content: document.content,
        rawContent: document.rawContent ?? undefined,
        fileName: document.fileName ?? undefined,
        mimeType: document.mimeType ?? undefined,
        parserOverride: document.parserOverride ?? undefined,
        tenantId: document.tenantId,
        allowedGroups: document.allowedGroups,
        knowledgeBaseId: document.knowledgeBaseId,
        metadata,
      })
      const taskId = this.taskRepo.enqueue({
        docId: newDocId,
        op: "ingest",
        payload: {
          reprocessed: true,
          sourceDocId: docId,
          ...(trace ? { trace } : {}),
        },
      })
      this.docRepo.recordOutcome(document.sourceId, newDocId, "pending")
      return { docId: newDocId, taskId, status: "pending", changed: true }
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
        : this.taskRepo.recordFailure(task.id, nextAttemptAt, task.executionId)
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
      this.taskRepo.finalize(task.id, "failed", task.executionId)
      throw new Error(`Document not found: ${task.docId}`)
    }

    // LO-13: continue the submitter's trace when the task carries one. The
    // scope opens AFTER the claim, so every execution — including each retry,
    // which mints a new execution_id — owns its own span and no ended scope is
    // ever reused. A task without the field runs under the root policy.
    const taskTrace = readTaskTrace(
      (task.payload as Record<string, unknown> | null | undefined)?.trace
    )
    const taskScope = this.tracing?.startOperation(
      "ingestion.task",
      {
        "task.id": task.id,
        "task.op": task.op,
        "task.doc_id": task.docId,
        "task.execution_id": task.executionId ?? "",
        "task.attempt": task.failCount + 1,
      },
      taskTrace,
    )
    let taskOutcome: "ok" | "error" | "cancelled" = "error"

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
        this.taskRepo,
        task.id,
        task.executionId ?? "unowned",
        abortController.signal
      )
      // The stage runner's provider calls must land in the task scope.
      const runStages = () => this.stageRunner.run(document, execution)
      const summary = taskScope ? await taskScope.runInContext(runStages) : await runStages()
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
        if (!this.taskRepo.finalize(task.id, "completed", task.executionId)) {
          throw new Error(`Ingestion task ${task.id} could not be completed`)
        }
        this.docRepo.updateStatus(task.docId, "completed")
        recordPolicyCompletion(this.docRepo, task.docId, finishedAt)
        // A technically complete candidate activates directly. Version order
        // remains the only protection: an older candidate cannot displace a
        // newer active version.
        this.docRepo.activate(task.docId)
        this.docRepo.clearActivationBlock(task.docId)
        if (this.docRepo.getActive(document.sourceId)?.id === document.id) {
          const wiki = new WikiStore(this.db, this.now)
          if (wiki.enabled(document.tenantId ?? "default", document.knowledgeBaseId ?? "")) {
            // LO-16: the derived wiki job continues this ingestion task's
            // trace instead of rooting a new one.
            wiki.enqueue(document.tenantId ?? "default", document.knowledgeBaseId ?? "",
              document.id, document.sourceId, "ingest", taskTraceFromScope(taskScope))
          }
        }
      })()
      taskOutcome = "ok"
      return { taskId: task.id, docId: task.docId, rootSpanId, success: true }
    } catch (error) {
      // Ticket 25: a superseded execution (its identity was re-minted by a
      // restart recovery or a fence check tripped) must not record failures,
      // dead-letter, or touch document metadata — the execution that now owns
      // the task owns all writes. Cancelled tasks keep the existing path.
      const ownershipLost =
        task.executionId !== null && !this.taskRepo.owns(task.id, task.executionId)
      const isCancelled = this.taskRepo.getById(task.id)?.status === "cancelled"
      if (ownershipLost && !isCancelled) {
        return {
          taskId: task.id,
          docId: task.docId,
          rootSpanId,
          success: false,
          stale: true,
          error: "superseded by a newer execution",
        }
      }
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
          : this.taskRepo.recordFailure(task.id, nextAttemptAt, task.executionId)
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
              // Ticket 17: actionable fix guidance when the failure may be
              // protection-related (e.g. a PDF that will not open or decode).
              ...(classification.userGuidance ? { userGuidance: classification.userGuidance } : {}),
              // Ticket 26: the audit's detailed reason codes ride with the
              // record so the frontend can render page-level evidence-backed
              // reasons instead of the coarse error class.
              ...(classification.reasonCodes?.length ? { reasonCodes: classification.reasonCodes } : {}),
            },
          },
        })
        return false
      })()
      if (cancellationWon) {
        taskOutcome = "cancelled"
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
      // Exactly one end per execution, on success, failure, cancellation and
      // ownership loss alike (LG-06-AC07).
      taskScope?.end(
        taskOutcome === "ok"
          ? { outcome: "ok" }
          : { outcome: "error", message: taskOutcome }
      )
      if (RUNNING_ABORT_CONTROLLERS.get(task.docId) === abortController) {
        RUNNING_ABORT_CONTROLLERS.delete(task.docId)
      }
    }
  }

  private async runCleanup(task: IngestionTask): Promise<IngestionExecutionResult> {
    const document = this.docRepo.get(task.docId)
    if (!isCleanupOperation(task.op) || !document ||
      this.docRepo.getSourceLifecycleState(document.sourceId) !== "retired") {
      this.taskRepo.finalize(task.id, "failed", task.executionId)
      return { taskId: task.id, docId: task.docId, rootSpanId: "", success: false,
        error: `Unsafe or unsupported cleanup operation: ${task.op}` }
    }
    try {
      await this.cleanup.run(task.op, document)
      if (!this.taskRepo.finalize(task.id, "completed", task.executionId)) {
        throw new Error("cleanup task claim expired")
      }
      return { taskId: task.id, docId: task.docId, rootSpanId: "", success: true }
    } catch (error) {
      // Ticket 25: a superseded execution must not record a cleanup failure
      // against the run that now owns the task.
      if (task.executionId !== null && !this.taskRepo.owns(task.id, task.executionId)) {
        return { taskId: task.id, docId: task.docId, rootSpanId: "", success: false,
          stale: true, error: "superseded by a newer execution" }
      }
      const message = error instanceof Error ? error.message : String(error)
      const delay = RETRY_DELAYS_MS[task.failCount]
      const nextAttemptAt = delay === undefined ? null
        : new Date(this.now().getTime() + delay).toISOString()
      this.taskRepo.recordFailure(task.id, nextAttemptAt, task.executionId)
      return { taskId: task.id, docId: task.docId, rootSpanId: "", success: false,
        error: message }
    }
  }
}
