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
  notApplicableBleuMetrics,
} from "./text_metrics"
import { EVAL_TEXT_RULE_VERSION } from "./text_rules"
import {
  EVAL_TASK_TERMINAL_STAGES,
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
 * Ticket 04 runs one case per task. Batch support (bounded concurrency,
 * progress across cases) is ticket 09 — until then a multi-case dataset is
 * rejected explicitly instead of silently running only the first case.
 */
export const DEFAULT_MAX_CASES_PER_TASK = 1
export const DEFAULT_TASK_TIMEOUT_MS = 10 * 60_000
export const DEFAULT_CASE_TIMEOUT_MS = 3 * 60_000

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

export interface EvaluationOwner {
  tenantId: string
  subjectId: string
}

export interface CreateEvaluationTaskInput {
  /** Built-in dataset id — mutually exclusive with `dataset`. */
  datasetId?: unknown
  /** Inline dataset payload — mutually exclusive with `datasetId`. */
  dataset?: unknown
}

export interface EvaluationServiceOptions {
  config: AppConfig
  clients: IsolatedEvalClients
  /**
   * Isolated-scope factory seam. Production uses
   * {@link createIsolatedEvalResources}; tests inject a fake to replace the
   * external ES/Neo4j/model boundary while exercising the whole lifecycle.
   */
  createResources?: (taskId: string) => IsolatedEvalResources
  /** Dedicated reranker (ticket 03). Default: none configured. */
  reranker?: Reranker
  now?: () => Date
  generateId?: () => string
  maxRetainedTasks?: number
  maxCasesPerTask?: number
  taskTimeoutMs?: number
  caseTimeoutMs?: number
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
  config: EvalTaskConfigSnapshot
}

export class EvaluationService {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly now: () => Date
  private readonly generateId: () => string
  private readonly maxRetainedTasks: number
  private readonly maxCasesPerTask: number
  private readonly taskTimeoutMs: number
  private readonly caseTimeoutMs: number
  private readonly createResources: (taskId: string) => IsolatedEvalResources
  private readonly reranker?: Reranker

  constructor(private readonly options: EvaluationServiceOptions) {
    this.now = options.now ?? (() => new Date())
    this.generateId = options.generateId ?? (() => randomUUID())
    this.maxRetainedTasks = options.maxRetainedTasks ?? DEFAULT_MAX_RETAINED_TASKS
    this.maxCasesPerTask = options.maxCasesPerTask ?? DEFAULT_MAX_CASES_PER_TASK
    this.taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS
    this.caseTimeoutMs = options.caseTimeoutMs ?? DEFAULT_CASE_TIMEOUT_MS
    this.reranker = options.reranker
    this.createResources =
      options.createResources ??
      ((taskId) =>
        createIsolatedEvalResources({
          taskId,
          config: options.config,
          clients: options.clients,
          ...(options.reranker ? { reranker: options.reranker } : {}),
        }))
  }

  /** Built-in samples + non-sensitive default model information. */
  describeDatasets(): {
    datasets: ReturnType<typeof listBuiltinEvalDatasets>
    defaults: { chatModel: string; rerankModel: string | null; embeddingModel: string }
    maxCasesPerTask: number
  } {
    return {
      datasets: listBuiltinEvalDatasets(),
      defaults: {
        chatModel: this.options.config.openaiChatModel,
        rerankModel: this.reranker?.model ?? null,
        embeddingModel: this.options.config.embeddingModel,
      },
      maxCasesPerTask: this.maxCasesPerTask,
    }
  }

  /**
   * Validate and register a task, then run it in the background. Returns
   * immediately — the caller polls {@link getTask}.
   */
  createTask(input: CreateEvaluationTaskInput, owner: EvaluationOwner): EvalTaskSummary {
    const { dataset, datasetId } = this.resolveDataset(input)
    if (dataset.cases.length > this.maxCasesPerTask) {
      throw new EvaluationRequestError(
        `this dataset has ${dataset.cases.length} cases but the service runs at most ${this.maxCasesPerTask} per task (batch runs are not enabled yet); split the dataset or use the built-in single-case sample`,
        ["cases"]
      )
    }
    if (this.tasks.size >= this.maxRetainedTasks) {
      throw new EvaluationCapacityError(
        `evaluation task capacity reached (${this.maxRetainedTasks} retained tasks in this process); wait for a running task to finish or restart the service`
      )
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
      config: this.configSnapshot(),
    }
    this.tasks.set(record.id, record)

    // Fire-and-forget: the HTTP response must not wait for prepare/run/cleanup.
    void this.runTask(record).catch((error) => {
      // runTask already records failures; this is the last-resort guard so a
      // bug in the runner can never leave an unhandled rejection behind.
      record.stage = "failed"
      record.error = error instanceof Error ? error.message : String(error)
      record.finishedAt = this.now().toISOString()
    })

    return this.toSummary(record)
  }

  getTask(id: string, owner: EvaluationOwner): EvalTaskDetail | null {
    const record = this.tasks.get(id)
    if (!record || !this.isOwner(record, owner)) return null
    return this.toDetail(record)
  }

  listTasks(owner: EvaluationOwner): EvalTaskSummary[] {
    return [...this.tasks.values()]
      .filter((record) => this.isOwner(record, owner))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((record) => this.toSummary(record))
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

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private isOwner(record: TaskRecord, owner: EvaluationOwner): boolean {
    return (
      record.owner.tenantId === owner.tenantId &&
      record.owner.subjectId === owner.subjectId
    )
  }

  private configSnapshot(): EvalTaskConfigSnapshot {
    return {
      chatModel: this.options.config.openaiChatModel,
      rerankModel: this.reranker?.model ?? null,
      embeddingModel: this.options.config.embeddingModel,
      rerankSource: this.reranker ? "dedicated_rerank" : "not_configured",
    }
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

  private async runTask(record: TaskRecord): Promise<void> {
    record.stage = "preparing"
    record.startedAt = this.now().toISOString()

    const taskController = new AbortController()
    const taskTimer = setTimeout(() => taskController.abort(), this.taskTimeoutMs)
    let resources: IsolatedEvalResources | undefined
    let resourcesDisposed = false

    try {
      resources = this.createResources(record.id)
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
          record.cleanup = error.cleanupReport
          resourcesDisposed = true
        }
        throw error
      }

      record.stage = "running"
      const entry = await resources.createAnswerEntry()
      for (const caseDef of record.dataset.cases) {
        if (taskController.signal.aborted) {
          record.cases.push(
            failedCase(caseDef, `task exceeded its ${this.taskTimeoutMs}ms budget before this case started`)
          )
          record.finished += 1
          continue
        }
        record.cases.push(
          await this.runCase(record, caseDef, entry, resources, taskController.signal)
        )
        record.finished += 1
      }

      record.stage = this.terminalStageFor(record.cases)
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error)
      record.stage = "failed"
    } finally {
      clearTimeout(taskTimer)
      // The run outcome is decided first; cleanup runs afterwards and never
      // overwrites it (spec "清理结果单独记录，不能覆盖原始失败原因").
      const outcomeStage = record.stage
      if (resources && !resourcesDisposed) {
        record.stage = "cleaning"
        record.cleanup = await this.disposeQuietly(resources)
      }
      record.stage = outcomeStage
      record.finishedAt = this.now().toISOString()
    }
  }

  private async disposeQuietly(
    resources: IsolatedEvalResources
  ): Promise<EvalCleanupReport> {
    try {
      return await resources.dispose()
    } catch (error) {
      // A cleanup that throws is itself a cleanup failure — report it as such
      // rather than pretending the scope was released.
      const message = error instanceof Error ? error.message : String(error)
      return {
        esIndex: "failed",
        esError: message,
        graphProvenance: "failed",
        graphError: message,
        dbClosed: false,
      }
    }
  }

  private terminalStageFor(cases: EvalCaseResult[]): EvalTaskStage {
    if (cases.length === 0) return "failed"
    const failed = cases.filter((item) => item.outcome === "failed").length
    if (failed === cases.length) return "failed"
    if (failed > 0) return "completed_with_errors"
    return "completed"
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
    const sessionId = `eval-${record.id}-${caseDef.caseId}`
    const runId = `eval-${record.id}-${caseDef.caseId}-${this.now().getTime()}`
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
      failure = error instanceof Error ? error.message : String(error)
      if (caseSignal.aborted && !taskSignal.aborted) {
        failure = `case exceeded its ${this.caseTimeoutMs}ms budget: ${failure}`
      }
    }

    const { candidates, ordering } = collectFinalContext(caseDef, events, resources)
    const scored: ScoredCandidate[] = candidates.map((candidate) => ({
      passageId: candidate.passageId,
      relevant: candidate.relevant,
    }))
    // A failed case has no completed final round to score — reporting 0 would
    // launder a provider failure into a retrieval failure, so every metric is
    // "not applicable" (null) instead. Answered cases with an empty ranking
    // still score a real 0 (nothing relevant was retrieved).
    //
    // Ticket 07: the BLEU metrics come from the ACTUAL reply of this run (the
    // refusal when the run honestly refused), never from the reference answer.
    const metrics =
      failure === undefined
        ? {
            ...retrievalMetrics(scored, caseDef.relevantPassageIds),
            ...bleuMetrics(done?.reply ?? "", caseDef.referenceAnswer),
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

  private toSummary(record: TaskRecord): EvalTaskSummary {
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
      createdAt: record.createdAt,
      ...(record.startedAt ? { startedAt: record.startedAt } : {}),
      ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    }
  }

  private toDetail(record: TaskRecord): EvalTaskDetail {
    return {
      ...this.toSummary(record),
      config: record.config,
      cases: [...record.cases],
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
  return { ...notApplicableRetrievalMetrics(), ...notApplicableBleuMetrics() }
}

function failedCase(caseDef: EvalDatasetCase, error: string): EvalCaseResult {
  return {
    caseId: caseDef.caseId,
    question: caseDef.question,
    referenceAnswer: caseDef.referenceAnswer,
    outcome: "failed",
    answer: "",
    error,
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
): { candidates: EvalRankedCandidate[]; ordering?: FinalContextOrdering } {
  let observations: RankedCandidateObservation[] | undefined
  let ordering: FinalContextOrdering | undefined
  for (const event of events) {
    if (
      event.type === "progress" &&
      event.stage === "retrieval" &&
      event.data.finalContextCandidates
    ) {
      observations = event.data.finalContextCandidates
      ordering = event.data.finalContextOrdering
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
  return { candidates, ...(ordering ? { ordering } : {}) }
}

/**
 * Aggregate per-case metric values. Every average carries its effective
 * sample size; cases where the metric does not apply are counted separately
 * and never turn into a fake 100%.
 */
export function summarizeMetrics(cases: EvalCaseResult[]): EvalMetricsSummary {
  const keys = new Set<string>()
  for (const item of cases) {
    for (const key of Object.keys(item.metrics)) keys.add(key)
  }
  const metrics: EvalMetricsSummary["metrics"] = {}
  for (const key of keys) {
    const values = cases
      .map((item) => item.metrics[key])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    const notApplicable = cases.filter((item) => item.metrics[key] === null).length
    metrics[key] = {
      value: values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      sampleSize: values.length,
      notApplicable,
    }
  }
  return {
    version: EVAL_METRIC_VERSION,
    generation: { bleuVersion: EVAL_BLEU_VERSION, textRuleVersion: EVAL_TEXT_RULE_VERSION },
    metrics,
  }
}
