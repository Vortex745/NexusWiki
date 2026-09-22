/**
 * Eval refactor Ticket 04 — in-process evaluation task service.
 *
 * One responsibility set: accept a validated dataset, run its cases against
 * the REAL shared Answer entry inside an isolated retrieval scope (ticket 02),
 * score what actually happened, clean up, and expose the record in memory.
 *
 * Guarantees that later tickets build on (and must not weaken):
 *   - the HTTP layer returns immediately; the task runs in the background;
 *   - ground truth never enters the answering path — it is only read by the
 *     scorer after the run produced its real reply;
 *   - cleanup runs on the success AND failure path, and its report is kept
 *     separate from the run error;
 *   - nothing is written outside this process (no JSON reports, no business
 *     DB rows, no persistent trace export).
 */

import { randomUUID } from "node:crypto"
import type { AppConfig } from "../config"
import type {
  AnswerRunEvent,
  AnswerRunResult,
  FinalContextOrdering,
  RankedCandidateObservation,
} from "../types"
import type { Reranker } from "../retrieval/search/interface"
import {
  createIsolatedEvalResources,
  EvalPrepareError,
  type EvalCorpusPassage,
  type EvalDisposeReport,
  type IsolatedEvalClients,
  type IsolatedEvalResources,
} from "./isolated_resources"
import {
  evalDatasetDigest,
  validateEvalDataset,
  type EvalDataset,
  type EvalDatasetCase,
} from "./dataset"
import { getBuiltinEvalDataset, listBuiltinEvalDatasets } from "./builtin_datasets"
import {
  EVAL_METRIC_VERSION,
  notApplicableRetrievalMetrics,
  retrievalMetrics,
  type ScoredCandidate,
} from "./metrics"
import {
  bleuMetrics,
  EVAL_BLEU_VERSION,
  EVAL_ROUGE_VERSION,
  notApplicableBleuMetrics,
  notApplicableRougeMetrics,
  rougeMetrics,
} from "./text_metrics"
import { EVAL_TEXT_RULE_VERSION } from "./text_rules"
import {
  EVAL_TASK_TERMINAL_STAGES,
  cleanupIncomplete,
  type EvalCaseResult,
  type EvalCleanupReport,
  type EvalMetricsSummary,
  type EvalRankedCandidate,
  type EvalTaskConfigSnapshot,
  type EvalTaskDetail,
  type EvalTaskStage,
  type EvalTaskSummary,
} from "./contracts"

export const DEFAULT_MAX_RETAINED_TASKS = 20
/**
 * Ticket 12: in-memory history is bounded by BOTH a record count and a total
 * case count, and a finished record older than its TTL is dropped on the next
 * touch. Active (non-terminal) tasks are never evicted — capacity is only ever
 * freed by finished records, and a task that cannot fit is rejected explicitly.
 */
export const DEFAULT_MAX_RETAINED_CASES = 200
export const DEFAULT_TASK_TTL_MS = 60 * 60_000
/**
 * Ticket 09: a task runs its dataset's cases with BOUNDED concurrency — never
 * an unbounded Promise.all over model calls. Cases beyond the cap are rejected
 * up front (the dataset validator already caps a dataset at 100 cases; a
 * single task is kept smaller so one run cannot monopolize the shared
 * providers).
 */
export const DEFAULT_MAX_CASES_PER_TASK = 20
/** How many cases of one task may run at the same time. */
export const DEFAULT_CASE_CONCURRENCY = 2
export const DEFAULT_TASK_TIMEOUT_MS = 10 * 60_000
export const DEFAULT_CASE_TIMEOUT_MS = 3 * 60_000
/**
 * Ticket 25 (EVAL-01A): one task's CLEANUP (release) phase is bounded too.
 * Preparation and cases share the task deadline; cleanup gets this budget on
 * top, so a task's whole lifetime is `taskTimeoutMs + cleanupTimeoutMs` and no
 * phase of it can hang the page forever.
 */
export const DEFAULT_CLEANUP_TIMEOUT_MS = 60_000

/** Invalid request/dataset — maps to HTTP 400. */
export class EvaluationRequestError extends Error {
  constructor(message: string, readonly issues: string[] = []) {
    super(message)
    this.name = "EvaluationRequestError"
  }
}

/** Service capacity reached — maps to HTTP 429 (ticket 12 refines eviction). */
export class EvaluationCapacityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EvaluationCapacityError"
  }
}

/**
 * Ticket 14: the service stops accepting new tasks the moment shutdown starts.
 * The HTTP layer reports this as 503, so a client can retry against a restarted
 * process instead of believing its request was invalid.
 */
export class EvaluationShuttingDownError extends Error {
  constructor(
    message = "the evaluation service is shutting down and no longer accepts new tasks"
  ) {
    super(message)
    this.name = "EvaluationShuttingDownError"
  }
}

/** Ticket 14: bounded budget for releasing the scopes of a stopped service. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000

/** Ticket 14: what a graceful stop did to the runs that were still in flight. */
export interface EvalShutdownReport {
  /** Tasks aborted when shutdown began, in creation order. */
  cancelledTaskIds: string[]
  /** False when every cancelled task finished its cleanup inside the budget. */
  timedOut: boolean
  /** Cleanup evidence per cancelled task — the same reports the API shows. */
  releases: Array<{
    taskId: string
    stage: EvalTaskStage
    cleanup: EvalCleanupReport | null
  }>
}

export interface EvaluationOwner {
  tenantId: string
  subjectId: string
}

export interface CreateEvaluationTaskInput {
  /** Built-in dataset id — mutually exclusive with `dataset`. */
  datasetId?: unknown
  /** Inline dataset payload — mutually exclusive with `datasetId`. */
  dataset?: unknown
  /**
   * Ticket 11: model identifiers this run should use. Only ids the operator
   * allowed are accepted — never a base URL, key or any other provider
   * setting, so a request can never make the service proxy an arbitrary
   * endpoint.
   */
  chatModel?: unknown
  rerankModel?: unknown
}

/** Per-task model overrides that survived validation. */
export interface EvalModelOverrides {
  chatModel?: string
  rerankModel?: string
}

/**
 * Model ids arrive from HTTP: keep them to an identifier-shaped string. `//`
 * is rejected outright, so a scheme or endpoint path can never be smuggled in
 * as a "model id" (an operator's allowlist stays the only way in).
 */
const MODEL_ID_PATTERN = /^(?!.*\/\/)[A-Za-z0-9._:/-]{1,120}$/

/**
 * Ticket 14: error text reaches the page, and a driver/provider error can quote
 * a connection URI — so `scheme://user:secret@host` becomes `scheme://***@host`
 * and the message is capped instead of dumping a whole stack detail.
 */
function redactDetail(message: string, limit = 300): string {
  const scrubbed = message.replace(
    /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s@]*@/g,
    "$1***@"
  )
  return scrubbed.length > limit ? `${scrubbed.slice(0, limit)}…` : scrubbed
}

/** Same redaction for a cleanup report's two error fields. */
function redactCleanupReport(report: EvalCleanupReport): EvalCleanupReport {
  return {
    ...report,
    ...(report.esError ? { esError: redactDetail(report.esError) } : {}),
    ...(report.graphError ? { graphError: redactDetail(report.graphError) } : {}),
  }
}

export interface EvaluationServiceOptions {
  config: AppConfig
  clients: IsolatedEvalClients
  /**
   * Isolated-scope factory seam. Production uses
   * {@link createIsolatedEvalResources}; tests inject a fake to replace the
   * external ES/Neo4j/model boundary while exercising the whole lifecycle.
   */
  createResources?: (
    taskId: string,
    overrides: EvalModelOverrides,
    reranker?: Reranker
  ) => IsolatedEvalResources
  /** Dedicated reranker (ticket 03). Default: none configured. */
  reranker?: Reranker
  /**
   * Ticket 11: the model ids a task may override. Empty (the default) means
   * "no override" — the server's own configuration is the only choice, and any
   * other id is refused before a scope, an index or a paid call exists.
   */
  allowedChatModels?: readonly string[]
  allowedRerankModels?: readonly string[]
  /**
   * Builds a reranker for an allowed rerank-model override. Wired to the same
   * dedicated adapter normal chat uses; absent → rerank overrides are refused.
   */
  createReranker?: (model: string) => Reranker | undefined
  /**
   * Ticket 16 (MODEL-01A): profile gate — a disabled profile can never be
   * selected through raw request values, whatever the allowlists contain.
   * Absent (tests) → no profile gate beyond the allowlists.
   */
  modelProfileGate?: { selectable(kind: "chat" | "rerank"): boolean }
  now?: () => Date
  generateId?: () => string
  maxRetainedTasks?: number
  /** Ticket 12: total retained cases across the in-memory history. */
  maxRetainedCases?: number
  /** Ticket 12: how long a finished record stays queryable. */
  taskTtlMs?: number
  maxCasesPerTask?: number
  /** Bounded concurrency across one task's cases (ticket 09). */
  caseConcurrency?: number
  taskTimeoutMs?: number
  caseTimeoutMs?: number
  /** Ticket 25: bound on the cleanup (release) phase, after the task deadline. */
  cleanupTimeoutMs?: number
}

interface TaskRecord {
  id: string
  owner: EvaluationOwner
  dataset: EvalDataset
  /** Built-in id when the task used a sample. */
  datasetId?: string
  contentDigest: string
  stage: EvalTaskStage
  createdAt: string
  startedAt?: string
  finishedAt?: string
  finished: number
  total: number
  cases: EvalCaseResult[]
  cleanup: EvalCleanupReport | null
  error?: string
  /** Ticket 11: validated per-task model overrides (snapshot input). */
  modelOverrides: EvalModelOverrides
  /** Ticket 11: the reranker this task actually runs with. */
  reranker?: Reranker
  config: EvalTaskConfigSnapshot
  /**
   * Ticket 14: the run's abort seam, the promise the process shutdown waits
   * for, and why it was cancelled (so a cancelled run never reads as a random
   * provider failure).
   */
  controller: AbortController
  run?: Promise<void>
  cancelReason?: string
  /** Ticket 25: the deadline watchdog had to abandon the case loop. */
  watchdogExpired?: boolean
  /**
   * Ticket 25: the record's outcome is FINAL (set by the shutdown deadline),
   * so the run's own finally must not stage it again.
   */
  sealed?: boolean
}

export class EvaluationService {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly now: () => Date
  private readonly generateId: () => string
  private readonly maxRetainedTasks: number
  private readonly maxRetainedCases: number
  private readonly taskTtlMs: number
  private readonly maxCasesPerTask: number
  private readonly caseConcurrency: number
  private readonly taskTimeoutMs: number
  private readonly caseTimeoutMs: number
  private readonly cleanupTimeoutMs: number
  private readonly createResources: (
    taskId: string,
    overrides: EvalModelOverrides,
    reranker?: Reranker
  ) => IsolatedEvalResources
  private readonly reranker?: Reranker
  private readonly allowedChatModels: readonly string[]
  private readonly allowedRerankModels: readonly string[]
  private readonly createReranker?: (model: string) => Reranker | undefined
  private readonly modelProfileGate?: { selectable(kind: "chat" | "rerank"): boolean }
  /** Ticket 14: set once shutdown began — no new task is accepted after it. */
  private stopped = false

  constructor(private readonly options: EvaluationServiceOptions) {
    this.now = options.now ?? (() => new Date())
    this.generateId = options.generateId ?? (() => randomUUID())
    this.maxRetainedTasks = options.maxRetainedTasks ?? DEFAULT_MAX_RETAINED_TASKS
    this.maxRetainedCases = options.maxRetainedCases ?? DEFAULT_MAX_RETAINED_CASES
    this.taskTtlMs = options.taskTtlMs ?? DEFAULT_TASK_TTL_MS
    this.maxCasesPerTask = options.maxCasesPerTask ?? DEFAULT_MAX_CASES_PER_TASK
    this.caseConcurrency = Math.max(
      1,
      options.caseConcurrency ?? DEFAULT_CASE_CONCURRENCY
    )
    this.taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS
    this.caseTimeoutMs = options.caseTimeoutMs ?? DEFAULT_CASE_TIMEOUT_MS
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS
    this.reranker = options.reranker
    this.allowedChatModels = options.allowedChatModels ?? []
    this.allowedRerankModels = options.allowedRerankModels ?? []
    this.createReranker = options.createReranker
    this.modelProfileGate = options.modelProfileGate
    this.createResources =
      options.createResources ??
      ((
        taskId: string,
        overrides: EvalModelOverrides,
        taskReranker?: Reranker
      ) => {
        // Ticket 11: a task's model override is applied to a COPY of the shared
        // config — the singleton normal chat reads is never mutated, so a run
        // with an override cannot change anyone else's behaviour.
        const taskConfig = overrides.chatModel
          ? { ...options.config, openaiChatModel: overrides.chatModel }
          : options.config
        return createIsolatedEvalResources({
          taskId,
          config: taskConfig,
          clients: options.clients,
          ...(taskReranker ? { reranker: taskReranker } : {}),
        })
      })
  }

  /** Built-in samples + non-sensitive default model information. */
  describeDatasets(): {
    datasets: ReturnType<typeof listBuiltinEvalDatasets>
    defaults: { chatModel: string; rerankModel: string | null; embeddingModel: string }
    /** Ticket 11: ids a task may pick instead of the server default. */
    allowedModels: { chat: string[]; rerank: string[] }
    maxCasesPerTask: number
  } {
    return {
      datasets: listBuiltinEvalDatasets(),
      defaults: {
        chatModel: this.options.config.openaiChatModel,
        rerankModel: this.reranker?.model ?? null,
        embeddingModel: this.options.config.embeddingModel,
      },
      allowedModels: {
        chat: [...this.allowedChatModels],
        rerank: [...this.allowedRerankModels],
      },
      maxCasesPerTask: this.maxCasesPerTask,
    }
  }

  /**
   * Validate and register a task, then run it in the background. Returns
   * immediately — the caller polls {@link getTask}.
   */
  createTask(input: CreateEvaluationTaskInput, owner: EvaluationOwner): EvalTaskSummary {
    // Ticket 14: a stopping service must not register work it cannot release.
    if (this.stopped) throw new EvaluationShuttingDownError()
    const { dataset, datasetId } = this.resolveDataset(input)
    // Ticket 11: validate the requested models BEFORE anything exists — an
    // unlisted id never reaches a scope, an index or a paid provider call.
    const modelOverrides = this.resolveModelOverrides(input)
    const taskReranker = modelOverrides.rerankModel
      ? this.createReranker?.(modelOverrides.rerankModel)
      : this.reranker
    if (dataset.cases.length > this.maxCasesPerTask) {
      throw new EvaluationRequestError(
        `this dataset has ${dataset.cases.length} cases but one task runs at most ${this.maxCasesPerTask} (bounded concurrency of ${this.caseConcurrency}); split the dataset into several tasks`,
        ["cases"]
      )
    }
    // Ticket 12: free the history first (TTL + over-limit records), then make
    // room for this one by dropping the oldest FINISHED records. A running task
    // is never evicted, so a house full of running tasks is rejected
    // explicitly instead of silently losing work.
    this.pruneHistory()
    while (
      this.tasks.size >= this.maxRetainedTasks ||
      this.retainedCaseCount() + dataset.cases.length > this.maxRetainedCases
    ) {
      const oldest = this.oldestFinishedRecord()
      if (!oldest) {
        throw new EvaluationCapacityError(
          `evaluation task capacity reached (${this.maxRetainedTasks} retained tasks / ${this.maxRetainedCases} cases in this process, all still running); wait for a running task to finish or restart the service`
        )
      }
      this.tasks.delete(oldest.id)
    }

    const record: TaskRecord = {
      id: this.generateId(),
      owner,
      dataset,
      ...(datasetId ? { datasetId } : {}),
      contentDigest: evalDatasetDigest(dataset),
      stage: "queued",
      createdAt: this.now().toISOString(),
      finished: 0,
      total: dataset.cases.length,
      cases: [],
      cleanup: null,
      modelOverrides,
      ...(taskReranker ? { reranker: taskReranker } : {}),
      // Ticket 14: shutdown aborts this run through here.
      controller: new AbortController(),
      // Snapshot at start: later global config changes cannot re-interpret a
      // task that already ran (ticket 11).
      config: this.configSnapshot(modelOverrides, taskReranker),
    }
    this.tasks.set(record.id, record)

    // Fire-and-forget: the HTTP response must not wait for prepare/run/cleanup.
    // Ticket 14: the chain is kept on the record so shutdown can await every
    // in-flight task's cleanup instead of hoping it finished in time.
    record.run = this.runTask(record, record.controller).catch((error) => {
      // runTask already records failures; this is the last-resort guard so a
      // bug in the runner can never leave an unhandled rejection behind.
      // Ticket 25: it must never RE-open or overwrite a record that already
      // reached its terminal state (or was sealed by shutdown), and whatever
      // it reports is redacted.
      if (EVAL_TASK_TERMINAL_STAGES.includes(record.stage) || record.sealed) return
      record.stage = "failed"
      record.error = redactDetail(error instanceof Error ? error.message : String(error))
      record.finishedAt = this.now().toISOString()
    })

    return this.toSummary(record)
  }

  getTask(id: string, owner: EvaluationOwner): EvalTaskDetail | null {
    this.pruneHistory()
    const record = this.tasks.get(id)
    if (!record || !this.isOwner(record, owner)) return null
    return this.toDetail(record)
  }

  listTasks(owner: EvaluationOwner): EvalTaskSummary[] {
    this.pruneHistory()
    return [...this.tasks.values()]
      .filter((record) => this.isOwner(record, owner))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((record) => this.toSummary(record))
  }

  /**
   * Ticket 25 (EVAL-01A): cancel one task on the caller's behalf. The cancel
   * reaches preparation (no case starts after it), the case loop (the signal
   * every case already runs on) and cleanup (the run always reaches its one
   * terminal state). A task that already decided its outcome keeps it — a
   * cancel can never rewrite a settled result.
   *
   * Returns null for an unknown or foreign task (the HTTP layer maps that to
   * the same 404 an unknown id gets).
   */
  cancelTask(
    id: string,
    owner: EvaluationOwner,
    reason = "cancelled by request"
  ): EvalTaskDetail | null {
    this.pruneHistory()
    const record = this.tasks.get(id)
    if (!record || !this.isOwner(record, owner)) return null
    if (!EVAL_TASK_TERMINAL_STAGES.includes(record.stage) && record.stage !== "cleaning") {
      record.cancelReason = reason
      record.controller.abort()
    }
    return this.toDetail(record)
  }

  /** Test/verification helper: wait until a task reaches a terminal stage. */
  async waitForTerminal(id: string, owner: EvaluationOwner, timeoutMs = 30_000): Promise<EvalTaskDetail> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const detail = this.getTask(id, owner)
      if (detail && EVAL_TASK_TERMINAL_STAGES.includes(detail.stage)) return detail
      if (Date.now() > deadline) {
        throw new Error(`evaluation task ${id} did not reach a terminal stage in ${timeoutMs}ms`)
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  /**
   * Ticket 14: stop accepting tasks, cancel what is still running, and wait —
   * bounded — for their cleanup. The process shutdown controller calls this
   * BEFORE closing the shared ES/graph clients, because releasing a scope
   * needs both. Nothing is persisted: the in-memory records disappear with the
   * process (a hard kill cannot be recovered here by design).
   */
  async shutdown(options: { timeoutMs?: number } = {}): Promise<EvalShutdownReport> {
    this.stopped = true
    const inFlight = [...this.tasks.values()].filter(
      (record) => !EVAL_TASK_TERMINAL_STAGES.includes(record.stage)
    )
    for (const record of inFlight) {
      // A record already in `cleaning` decided its outcome before shutdown:
      // its run is over and only the release is pending. Anything earlier is a
      // genuine in-flight run — name the reason first, then abort, so the case
      // loop, the answer run and every provider call observe the signal.
      if (record.stage === "cleaning") continue
      record.cancelReason = "cancelled by service shutdown"
      record.controller.abort()
    }

    const budget = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
    let timer: NodeJS.Timeout | undefined
    const settled = Promise.all(inFlight.map((record) => record.run ?? Promise.resolve()))
    const timedOut = await Promise.race([
      settled.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), budget)
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer)
    })

    for (const record of inFlight) {
      // A run cancelled by the shutdown says why: without this it would read
      // as an ordinary provider failure. A run that was already deciding its
      // own outcome (or had settled it) keeps its own, honest reason.
      if (record.cancelReason && !record.error) {
        record.error = "cancelled by service shutdown"
      }
      // Ticket 25: when the budget ran out, a record can still be sitting in
      // a non-terminal stage (typically `cleaning`). The process is going
      // away, so it is reported as a bounded, honest failure — never left in
      // a stage no client can ever leave.
      if (!EVAL_TASK_TERMINAL_STAGES.includes(record.stage)) {
        record.stage = "failed"
        record.error = record.error ?? `cancelled by service shutdown (cleanup did not settle within ${budget}ms)`
        record.finishedAt = record.finishedAt ?? this.now().toISOString()
        // The run's own finally must not stage it back into `cleaning`.
        record.sealed = true
      }
    }

    return {
      cancelledTaskIds: inFlight.map((record) => record.id),
      timedOut,
      releases: inFlight.map((record) => ({
        taskId: record.id,
        stage: record.stage,
        cleanup: record.cleanup,
      })),
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private isOwner(record: TaskRecord, owner: EvaluationOwner): boolean {
    return (
      record.owner.tenantId === owner.tenantId &&
      record.owner.subjectId === owner.subjectId
    )
  }

  private configSnapshot(
    overrides: EvalModelOverrides,
    reranker?: Reranker
  ): EvalTaskConfigSnapshot {
    return {
      chatModel: overrides.chatModel ?? this.options.config.openaiChatModel,
      rerankModel: reranker?.model ?? null,
      embeddingModel: this.options.config.embeddingModel,
      rerankSource: reranker ? "dedicated_rerank" : "not_configured",
    }
  }

  /**
   * Ticket 11: turn the request's model ids into a validated plan. Only ids
   * this server allows (or the server's own default) survive; a rejected id
   * names the offending field so the page can point at it. Nothing else from
   * the request — no URL, key or provider setting — is ever read, so a task
   * can never make the service proxy another endpoint.
   */
  private resolveModelOverrides(input: CreateEvaluationTaskInput): EvalModelOverrides {
    const chatModel = this.resolveModelId(
      input.chatModel,
      "chatModel",
      this.allowedChatModels
    )
    const rerankModel = this.resolveModelId(
      input.rerankModel,
      "rerankModel",
      this.allowedRerankModels
    )
    if (rerankModel && !this.createReranker) {
      throw new EvaluationRequestError(
        "rerank model overrides are not enabled on this server",
        ["rerankModel"]
      )
    }
    // Ticket 16 (MODEL-01A): the profile gate runs LAST so a disabled profile
    // reports the same field-named 400 as any other refused id.
    if (chatModel && this.modelProfileGate && !this.modelProfileGate.selectable("chat")) {
      throw new EvaluationRequestError(
        "chatModel rejected: the chat model profile is disabled on this server",
        ["chatModel"]
      )
    }
    if (rerankModel && this.modelProfileGate && !this.modelProfileGate.selectable("rerank")) {
      throw new EvaluationRequestError(
        "rerankModel rejected: the rerank model profile is disabled on this server",
        ["rerankModel"]
      )
    }
    return { ...(chatModel ? { chatModel } : {}), ...(rerankModel ? { rerankModel } : {}) }
  }

  private resolveModelId(
    raw: unknown,
    field: "chatModel" | "rerankModel",
    allowed: readonly string[]
  ): string | undefined {
    // An absent/empty value means "use the server's configuration".
    if (raw === undefined || raw === null || raw === "") return undefined
    if (typeof raw !== "string") {
      throw new EvaluationRequestError(`${field} must be a model id string`, [field])
    }
    const value = raw.trim()
    if (!MODEL_ID_PATTERN.test(value)) {
      throw new EvaluationRequestError(
        `${field} must be a plain model id (letters, digits, . _ : / -); base URLs and keys are not accepted`,
        [field]
      )
    }
    const baseline =
      field === "chatModel" ? this.options.config.openaiChatModel : this.reranker?.model
    if (value === baseline) return value
    if (!allowed.includes(value)) {
      throw new EvaluationRequestError(
        `${field} "${value}" is not in this server's allowed list`,
        [field]
      )
    }
    return value
  }

  private resolveDataset(input: CreateEvaluationTaskInput): {
    dataset: EvalDataset
    datasetId?: string
  } {
    const hasId = input.datasetId !== undefined && input.datasetId !== null
    const hasInline = input.dataset !== undefined && input.dataset !== null
    if (hasId && hasInline) {
      throw new EvaluationRequestError(
        "provide either datasetId (built-in sample) or dataset (inline JSON), not both",
        ["datasetId", "dataset"]
      )
    }
    if (!hasId && !hasInline) {
      throw new EvaluationRequestError(
        "provide either datasetId (built-in sample) or dataset (inline JSON)",
        ["datasetId"]
      )
    }
    if (hasId) {
      if (typeof input.datasetId !== "string" || !input.datasetId.trim()) {
        throw new EvaluationRequestError("datasetId must be a non-empty string", ["datasetId"])
      }
      const builtin = getBuiltinEvalDataset(input.datasetId)
      if (!builtin) {
        throw new EvaluationRequestError(
          `unknown built-in dataset id: ${input.datasetId}`,
          ["datasetId"]
        )
      }
      return { dataset: builtin.dataset, datasetId: builtin.id }
    }
    // Inline datasets are validated by the same authoritative validator; a
    // rejection carries every field/case-level issue (ticket 05).
    const dataset = validateEvalDataset(input.dataset)
    return { dataset }
  }

  private async runTask(record: TaskRecord, taskController: AbortController): Promise<void> {
    record.stage = "preparing"
    record.startedAt = this.now().toISOString()

    // Ticket 25 (EVAL-01A): ONE deadline for the whole run — preparation and
    // the case loop share it, and it stays armed while cleanup runs, so the
    // task can never outlive `taskTimeoutMs + cleanupTimeoutMs`.
    const deadlineAt = Date.now() + this.taskTimeoutMs
    const taskTimer = setTimeout(() => taskController.abort(), this.taskTimeoutMs)
    let resources: IsolatedEvalResources | undefined
    let resourcesDisposed = false

    try {
      resources = this.createResources(
        record.id,
        record.modelOverrides,
        record.reranker
      )
      try {
        await resources.prepare(
          record.dataset.corpus.map<EvalCorpusPassage>((passage) => ({
            passageId: passage.passageId,
            content: passage.content,
            ...(passage.title ? { title: passage.title } : {}),
          }))
        )
      } catch (error) {
        // The scope cleaned up after itself and reports what it removed —
        // keep that evidence instead of re-running the cleanup.
        if (error instanceof EvalPrepareError) {
          record.cleanup = redactCleanupReport(error.cleanupReport)
          resourcesDisposed = true
        }
        throw error
      }

      // Ticket 25: a cancellation that arrived DURING preparation must not
      // start a single case. The preparation itself has its own bounded
      // deadline inside the scope; this check is the boundary that turns the
      // cancel into the run's one terminal state.
      if (taskController.signal.aborted) {
        throw new Error(record.cancelReason ?? "evaluation task was cancelled during preparation")
      }

      record.stage = "running"
      const entry = await resources.createAnswerEntry()
      // Ticket 25: the total deadline is a WATCHDOG, not a hope. The signal
      // reaches every cooperative stage; if a case (or a provider) ignores it,
      // this race still guarantees the record reaches a terminal stage inside
      // the task's bounded lifetime.
      await this.runCasesWithWatchdog(record, entry, resources, taskController, deadlineAt)
      if (record.watchdogExpired) {
        throw new Error(
          `task exceeded its ${this.taskTimeoutMs}ms deadline; the run was abandoned and reported as failed`
        )
      }

      // Ticket 25: a cancelled run says so at the TASK level too — without
      // this the cancelled cases would only carry their own abort messages.
      if (taskController.signal.aborted && record.cancelReason && !record.error) {
        record.error = record.cancelReason
        // A cancel that arrives after the last answer is still not a clean
        // success: the run was cut short, so it says so.
        // `runCases` may have moved the stage past the literal TS still sees.
        const current = record.stage as EvalTaskStage
        record.stage = current === "completed" ? "completed_with_errors" : current
      }
      if (!EVAL_TASK_TERMINAL_STAGES.includes(record.stage)) {
        record.stage = this.terminalStageFor(record.cases)
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      // Ticket 14: a run cancelled by shutdown says so, instead of reading as
      // a random provider failure.
      record.error = redactDetail(
        record.cancelReason ? `${record.cancelReason} (${detail})` : detail
      )
      record.stage = "failed"
    } finally {
      // The run outcome is decided first; cleanup runs afterwards and never
      // overwrites it (spec "清理结果单独记录，不能覆盖原始失败原因").
      const outcomeStage = record.stage
      if (resources && !resourcesDisposed) {
        // Ticket 14: the cleaning stage is observable while dispose runs.
        // Ticket 25: a sealed record keeps the outcome the shutdown reported.
        if (!record.sealed) record.stage = "cleaning"
        // Ticket 25: cleanup is bounded — the wait may extend the task's total
        // lifetime by at most `cleanupTimeoutMs` (and never more than what is
        // left of `deadlineAt + cleanupTimeoutMs`).
        const cleanupBudgetMs = Math.min(
          this.cleanupTimeoutMs,
          Math.max(0, deadlineAt + this.cleanupTimeoutMs - Date.now())
        )
        record.cleanup = await this.disposeQuietly(resources, cleanupBudgetMs)
      }
      clearTimeout(taskTimer)
      // Ticket 14: a run that could not release everything must not read as an
      // unqualified success. The original outcome still wins (a failed run
      // stays failed, its cleanup error stays visible alongside it), but a
      // clean run with leftovers is reported as completed_with_errors.
      record.stage = record.sealed
        ? record.stage
        : outcomeStage === "completed" && cleanupIncomplete(record.cleanup)
          ? "completed_with_errors"
          : outcomeStage
      record.finishedAt = this.now().toISOString()
    }
  }

  private async disposeQuietly(
    resources: IsolatedEvalResources,
    budgetMs: number
  ): Promise<EvalCleanupReport> {
    let timer: NodeJS.Timeout | undefined
    try {
      // The losing branch of the race must never surface as an unhandled
      // rejection: a release that throws after the budget won is a cleanup
      // failure we already reported, not a process-level crash.
      type Release = { released: true; report: EvalDisposeReport } | { released: false; error: string | null }
      const released = await Promise.race<Release>([
        resources
          .dispose()
          .then((report) => ({ released: true as const, report }))
          .catch((error) => {
            const detail = redactDetail(error instanceof Error ? error.message : String(error))
            console.warn("[evaluation] cleanup failed:", detail)
            return { released: false as const, error: detail }
          }),
        new Promise<Release>((resolve) => {
          timer = setTimeout(() => resolve({ released: false, error: null }), budgetMs)
        }),
      ])
      if (!released.released) {
        // Ticket 25: an unbounded release would hang the page. A timeout — or
        // a release that threw — is a cleanup FAILURE with evidence, never a
        // silent success.
        const message = released.error ?? `cleanup did not finish within ${budgetMs}ms`
        return {
          esIndex: "failed",
          esError: message,
          graphProvenance: "failed",
          graphError: message,
          dbClosed: false,
        }
      }
      return redactCleanupReport(released.report)
    } catch (error) {
      // A cleanup that throws is itself a cleanup failure — report it as such
      // rather than pretending the scope was released.
      const message = redactDetail(error instanceof Error ? error.message : String(error))
      return {
        esIndex: "failed",
        esError: message,
        graphProvenance: "failed",
        graphError: message,
        dbClosed: false,
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private terminalStageFor(cases: EvalCaseResult[]): EvalTaskStage {
    if (cases.length === 0) return "failed"
    const failed = cases.filter((item) => item.outcome === "failed").length
    if (failed === cases.length) return "failed"
    if (failed > 0) return "completed_with_errors"
    return "completed"
  }

  /**
   * Ticket 25 (EVAL-01A): the bounded case phase. The signal is the normal
   * cancellation path; this race is the GUARANTEE — a stage or provider that
   * ignores the signal still cannot keep the record non-terminal past
   * `deadlineAt + cleanupTimeoutMs`.
   */
  private async runCasesWithWatchdog(
    record: TaskRecord,
    entry: Awaited<ReturnType<IsolatedEvalResources["createAnswerEntry"]>>,
    resources: IsolatedEvalResources,
    taskController: AbortController,
    deadlineAt: number
  ): Promise<void> {
    const loop = this.runCases(record, entry, resources, taskController.signal)
    // An abandoned loop must never surface as an unhandled rejection.
    loop.catch(() => {})
    const budgetMs = Math.max(0, deadlineAt + this.cleanupTimeoutMs - Date.now())
    let timer: NodeJS.Timeout | undefined
    const outcome = await Promise.race<"finished" | "expired">([
      loop.then(() => "finished" as const),
      new Promise<"expired">((resolve) => {
        timer = setTimeout(() => resolve("expired"), budgetMs)
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer)
    })
    if (outcome === "expired") record.watchdogExpired = true
  }

  /**
   * Ticket 09: run every case of the task with bounded concurrency. Each
   * worker owns one case at a time (so at most `caseConcurrency` runs are in
   * flight — never an unbounded aggregation of model calls), and a result is
   * written back at its DATASET index, so the task always reports its cases in
   * dataset order no matter which one finishes first.
   */
  private async runCases(
    record: TaskRecord,
    entry: Awaited<ReturnType<IsolatedEvalResources["createAnswerEntry"]>>,
    resources: IsolatedEvalResources,
    taskSignal: AbortSignal
  ): Promise<void> {
    const caseDefs = record.dataset.cases
    record.cases = new Array<EvalCaseResult>(caseDefs.length)
    let nextIndex = 0

    const runWorker = async (): Promise<void> => {
      for (;;) {
        const index = nextIndex
        nextIndex += 1
        const caseDef = caseDefs[index]
        if (!caseDef) return
        let result: EvalCaseResult
        if (taskSignal.aborted) {
          result = failedCase(
            caseDef,
            `task exceeded its ${this.taskTimeoutMs}ms budget before this case started`
          )
        } else {
          try {
            result = await this.runCase(record, caseDef, entry, resources, taskSignal)
          } catch (error) {
            // A case must never leave a hole in the result list.
            result = failedCase(
              caseDef,
              error instanceof Error ? error.message : String(error)
            )
          }
        }
        record.cases[index] = result
        record.finished += 1
      }
    }

    const workers = Math.max(1, Math.min(this.caseConcurrency, caseDefs.length))
    await Promise.all(Array.from({ length: workers }, () => runWorker()))
  }

  private async runCase(
    record: TaskRecord,
    caseDef: EvalDatasetCase,
    entry: Awaited<ReturnType<IsolatedEvalResources["createAnswerEntry"]>>,
    resources: IsolatedEvalResources,
    taskSignal: AbortSignal
  ): Promise<EvalCaseResult> {
    const startedAt = Date.now()
    // Per-case session + case correlation: cases never share conversation
    // memory, and every emitted event is attributable to its case.
    // Dataset ids may contain Unicode or be long; internal ids must satisfy
    // the shared Answer adapter's ASCII/100-character contract.
    const sessionId = `eval-${record.id}-${randomUUID()}`
    const runId = `eval-${record.id}-${randomUUID()}`
    const caseSignal = AbortSignal.any([taskSignal, AbortSignal.timeout(this.caseTimeoutMs)])

    let done: AnswerRunResult | undefined
    let failure: string | undefined
    const events: AnswerRunEvent[] = []
    try {
      for await (const event of entry.eventsSource(caseDef.question, {
        runId,
        sessionId,
        caseId: caseDef.caseId,
        signal: caseSignal,
        accessContext: entry.accessContext,
      })) {
        events.push(event)
        if (event.type === "done") done = event.result
      }
    } catch (error) {
      // Ticket 25: a provider error can quote a connection URI — every case
      // failure is redacted before it is stored or returned.
      failure = redactDetail(error instanceof Error ? error.message : String(error))
      if (caseSignal.aborted && !taskSignal.aborted) {
        failure = `case exceeded its ${this.caseTimeoutMs}ms budget: ${failure}`
      }
    }

    // The shared Answer adapter reports provider errors and cancellation as
    // terminal events; it does not necessarily throw from the event stream.
    if (failure === undefined) {
      if (!done) {
        failure = "answer stream ended without a terminal result"
      } else if (done.status === "provider_error" || done.status === "cancelled") {
        failure = `answer run ended with ${done.status}`
        if (caseSignal.aborted && !taskSignal.aborted) {
          failure = `case exceeded its ${this.caseTimeoutMs}ms budget: ${failure}`
        }
      }
    }

    const { candidates, ordering, round } = collectFinalContext(caseDef, events, resources)
    const scored: ScoredCandidate[] = candidates.map((candidate) => ({
      passageId: candidate.passageId,
      relevant: candidate.relevant,
    }))
    // A failed case has no completed final round to score — reporting 0 would
    // launder a provider failure into a retrieval failure, so every metric is
    // "not applicable" (null) instead. Answered cases with an empty ranking
    // still score a real 0 (nothing relevant was retrieved).
    //
    // Ticket 07/08: the answer-similarity metrics come from the ACTUAL reply of
    // this run (the refusal when the run honestly refused), never from the
    // reference answer.
    const metrics =
      failure === undefined
        ? {
            ...retrievalMetrics(scored, caseDef.relevantPassageIds),
            ...bleuMetrics(done?.reply ?? "", caseDef.referenceAnswer),
            ...rougeMetrics(done?.reply ?? "", caseDef.referenceAnswer),
          }
        : notApplicableCaseMetrics()

    return {
      caseId: caseDef.caseId,
      question: caseDef.question,
      referenceAnswer: caseDef.referenceAnswer,
      outcome: failure === undefined ? "answered" : "failed",
      answer: done?.reply ?? "",
      ...(done ? { terminalStatus: done.status } : {}),
      ...(failure !== undefined ? { error: failure } : {}),
      ...(ordering ? { ordering } : {}),
      ...(round !== undefined ? { finalContextRound: round } : {}),
      // Ticket 27 (EVAL-01B2): the per-task model snapshot the entry stamped on
      // this case's terminal event — the override is verifiable per case, and a
      // case that never reached a terminal result carries none.
      ...(done?.modelProfile ? { modelProfile: done.modelProfile } : {}),
      runId,
      durationMs: Date.now() - startedAt,
      metrics,
      retrievedPassageIds: [...new Set(
        candidates.flatMap((candidate) => (candidate.passageId ? [candidate.passageId] : []))
      )],
      candidates,
      unmappedCandidates: candidates.filter((candidate) => candidate.passageId === null).length,
    }
  }

  /**
   * Ticket 12: keep the in-memory history bounded. Expired finished records go
   * first, then — while the record or case budget is exceeded — the oldest
   * finished ones. A task that is still running is never evicted, and dropping
   * a record releases its dataset and replies with it (nothing is cached
   * anywhere else).
   */
  private pruneHistory(): void {
    const now = this.now().getTime()

    for (const [id, record] of [...this.tasks]) {
      if (!this.isFinished(record)) continue
      const finishedAt = Date.parse(record.finishedAt ?? record.createdAt)
      if (Number.isFinite(finishedAt) && now - finishedAt >= this.taskTtlMs) {
        this.tasks.delete(id)
      }
    }

    while (
      this.tasks.size > this.maxRetainedTasks ||
      this.retainedCaseCount() > this.maxRetainedCases
    ) {
      const oldest = this.oldestFinishedRecord()
      if (!oldest) return
      this.tasks.delete(oldest.id)
    }
  }

  private isFinished(record: TaskRecord): boolean {
    return EVAL_TASK_TERMINAL_STAGES.includes(record.stage)
  }

  /** Oldest finished record, or undefined when every retained task is running. */
  private oldestFinishedRecord(): TaskRecord | undefined {
    return [...this.tasks.values()]
      .filter((record) => this.isFinished(record))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0]
  }

  private retainedCaseCount(): number {
    return [...this.tasks.values()].reduce((sum, record) => sum + record.total, 0)
  }

  private toSummary(record: TaskRecord): EvalTaskSummary {
    // Ticket 10: counts come from the cases that actually settled, so a
    // running batch reports 0/0/0 for the ones still in flight and the
    // numbers always add up to `progress.finished`.
    const settled = record.cases.filter(Boolean)
    const counts = {
      answered: settled.filter((item) => item.outcome === "answered").length,
      failed: settled.filter((item) => item.outcome === "failed").length,
      // Only cases that actually carry a ranking label can be called
      // degraded — an unlabelled answer is unknown, not a degradation claim.
      degraded: settled.filter(
        (item) =>
          item.outcome === "answered" &&
          item.ordering !== undefined &&
          item.ordering.source !== "dedicated_rerank"
      ).length,
    }
    return {
      id: record.id,
      dataset: {
        ...(record.datasetId ? { id: record.datasetId } : {}),
        name: record.dataset.name,
        version: record.dataset.version,
        contentDigest: record.contentDigest,
        caseCount: record.dataset.cases.length,
        passageCount: record.dataset.corpus.length,
      },
      stage: record.stage,
      progress: { finished: record.finished, total: record.total },
      counts,
      createdAt: record.createdAt,
      ...(record.startedAt ? { startedAt: record.startedAt } : {}),
      ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    }
  }

  private toDetail(record: TaskRecord): EvalTaskDetail {
    return {
      ...this.toSummary(record),
      config: record.config,
      // Ticket 09: while a batch is running, results land at their dataset
      // index one by one — only the settled ones are reported (the progress
      // counters carry the rest), so the detail never shows empty slots.
      cases: record.cases.filter(Boolean),
      metrics: summarizeMetrics(record.cases),
      cleanup: record.cleanup,
      ...(record.error ? { error: record.error } : {}),
    }
  }
}

/**
 * The full metric key set with every value "not applicable" — retrieval and
 * generation side both. Used when a case never produced a scorable run, so the
 * aggregate reports a sample size of 0 instead of six retrieval zeros plus
 * three BLEU zeros.
 */
function notApplicableCaseMetrics(): EvalCaseResult["metrics"] {
  return {
    ...notApplicableRetrievalMetrics(),
    ...notApplicableBleuMetrics(),
    ...notApplicableRougeMetrics(),
  }
}

function failedCase(caseDef: EvalDatasetCase, error: string): EvalCaseResult {
  return {
    caseId: caseDef.caseId,
    question: caseDef.question,
    referenceAnswer: caseDef.referenceAnswer,
    outcome: "failed",
    answer: "",
    // Ticket 25: the same redaction rule as every other exposed error.
    error: redactDetail(error),
    durationMs: 0,
    metrics: notApplicableCaseMetrics(),
    retrievedPassageIds: [],
    candidates: [],
    unmappedCandidates: 0,
  }
}

/**
 * Project the FINAL generation round's ordered candidates onto this dataset's
 * corpus. The ranking comes from the runner observation
 * (`RetrievalTraceData.finalContextCandidates`, ticket 01) — never from the
 * done event's citation-derived references.
 *
 * The runner submits an observation only for the round whose draft was
 * accepted, so taking the LAST one keeps the published round's ranking when a
 * correction round regenerated the answer. The same observation carries the
 * ordering label (ticket 06) so the scorer can say whether the ranking it just
 * scored came from the dedicated reranker or from an unscored fallback/merge.
 */
function collectFinalContext(
  caseDef: EvalDatasetCase,
  events: readonly AnswerRunEvent[],
  resources: IsolatedEvalResources
): { candidates: EvalRankedCandidate[]; ordering?: FinalContextOrdering; round?: number } {
  let observations: RankedCandidateObservation[] | undefined
  let ordering: FinalContextOrdering | undefined
  let round: number | undefined
  for (const event of events) {
    if (
      event.type === "progress" &&
      event.stage === "retrieval" &&
      event.data.finalContextCandidates
    ) {
      observations = event.data.finalContextCandidates
      ordering = event.data.finalContextOrdering
      round = event.data.finalContextRound
    }
  }
  if (!observations) return { candidates: [] }
  const relevant = new Set(caseDef.relevantPassageIds)
  const candidates = observations.map((observation) => {
    const passageId = resources.passageIdForChunk({ documentId: observation.documentId })
    return {
      rank: observation.rank,
      passageId,
      documentId: observation.documentId,
      chunkId: observation.chunkId,
      score: observation.score,
      channels: [...observation.channels],
      relevant: passageId !== null && relevant.has(passageId),
    }
  })
  return {
    candidates,
    ...(ordering ? { ordering } : {}),
    ...(round !== undefined ? { round } : {}),
  }
}

/**
 * Aggregate per-case metric values. Every average carries its effective
 * sample size; cases where the metric does not apply are counted separately
 * and never turn into a fake 100%.
 */
export function summarizeMetrics(cases: EvalCaseResult[]): EvalMetricsSummary {
  // Ticket 09: a running batch has slots that are not settled yet — averages
  // are computed from the cases that actually produced a result.
  const settled = cases.filter(Boolean)
  const keys = new Set<string>()
  for (const item of settled) {
    for (const key of Object.keys(item.metrics)) keys.add(key)
  }
  const metrics: EvalMetricsSummary["metrics"] = {}
  for (const key of keys) {
    const values = settled
      .map((item) => item.metrics[key])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    const notApplicable = settled.filter((item) => item.metrics[key] === null).length
    metrics[key] = {
      value: values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      sampleSize: values.length,
      notApplicable,
    }
  }
  return {
    version: EVAL_METRIC_VERSION,
    generation: {
      bleuVersion: EVAL_BLEU_VERSION,
      rougeVersion: EVAL_ROUGE_VERSION,
      textRuleVersion: EVAL_TEXT_RULE_VERSION,
    },
    metrics,
  }
}
