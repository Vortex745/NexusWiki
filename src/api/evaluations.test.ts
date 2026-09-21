import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"
import type { Request, Response, NextFunction } from "express"
import { createEvaluationsRouter } from "./evaluations"
import { EvaluationService } from "../evaluation/service"
import type {
  EvalCorpusPassage,
  EvalDisposeReport,
  IsolatedEvalAnswerEntry,
  IsolatedEvalResources,
} from "../evaluation/isolated_resources"
import { EvalPrepareError } from "../evaluation/isolated_resources"
import type { AppConfig } from "../config"
import type { AnswerRunEvent, AnswerRunResult, RankedCandidateObservation } from "../types"
import type { AccessContext, Scope } from "../access/context"
import { singleTenantAccessContext } from "../access/context"

/**
 * Eval refactor Ticket 04 — evaluation HTTP API, end to end.
 *
 * The external boundary (ES / Neo4j / models) is replaced by a fake isolated
 * scope; everything else — validation, identity/scope checks, asynchronous
 * task registration, polling, scoring, cleanup reporting, restart behaviour —
 * runs for real.
 */

const CONFIG: AppConfig = {
  esNode: "http://es.test",
  esApiKey: "",
  openaiApiKey: "chat-key",
  openaiBaseUrl: "http://chat.test",
  openaiChatModel: "test-chat-model",
  embeddingApiKey: "emb-key",
  embeddingBaseUrl: "http://emb.test",
  embeddingModel: "test-embedding-model",
  embeddingDimensions: 3,
  openaiRequestTimeoutMs: 1_000,
  openaiMaxRetries: 0,
  neo4jUri: "bolt://neo4j.test",
  neo4jUser: "neo4j",
  neo4jPassword: "password",
  sqlitePath: ":memory:",
  pollIntervalMs: 1,
  claimedTimeoutMs: 1,
  accessMode: "single_tenant",
  activationMode: "auto",
  conversationTtlDays: 30,
  conversationGcIntervalMs: 86_400_000,
  rerankApiKey: "rerank-key",
  rerankBaseUrl: "https://reranker.test/v1",
  rerankModel: "bge-reranker-v2-m3",
  rerankTimeoutMs: 5_000,
  rerankMaxDocumentChars: 4_000,
}

/** Ranking the fake answering path publishes for every case. */
const FAKE_RANKING: Array<{ passageId: string; relevant: boolean }> = [
  { passageId: "shipping-policy", relevant: false },
  { passageId: "refund-policy", relevant: true },
]

const FAKE_REPLY = "退款在审核通过后 3 个工作日内回到原支付路径。"

interface FakeScopeOptions {
  prepareFails?: string
  disposeReport?: EvalDisposeReport
  noObservation?: boolean
  caseThrows?: string
  /**
   * Ranking the fake answering path publishes. Defaults to {@link FAKE_RANKING}
   * (the built-in sample's corpus); a custom dataset supplies its own so the
   * corpus → passageId mapping can be exercised for arbitrary ids (ticket 05).
   */
  ranking?: readonly { passageId: string; relevant: boolean }[]
  /**
   * Ticket 06: how that ranking was produced. Omitted by default — a release
   * that never labelled its ordering must not gain a label from the fake.
   */
  ordering?: { source: "dedicated_rerank" | "fused"; reason?: string }
  /** Ticket 07: the reply this run publishes (defaults to FAKE_REPLY). */
  reply?: string
}

class FakeScope implements IsolatedEvalResources {
  readonly taskId: string
  readonly tenantId: string
  readonly namespace: string
  readonly esIndex: string
  readonly accessContext: AccessContext
  readonly corpus: EvalCorpusPassage[] = []
  readonly preparedCaseOptions: Array<{ caseId?: string; sessionId?: string; message: string }> = []
  disposeCalls = 0
  private state: "created" | "prepared" | "disposed" = "created"

  constructor(taskId: string, private readonly options: FakeScopeOptions) {
    this.taskId = taskId
    this.tenantId = `eval-${taskId}`
    this.namespace = this.tenantId
    this.esIndex = `kefu-rag-chunks-eval-${taskId}`
    this.accessContext = {
      tenantId: this.tenantId,
      subjectId: `eval:${taskId}`,
      groups: [],
      scopes: ["chat"],
    }
  }

  getState(): "created" | "prepared" | "disposed" {
    return this.state
  }

  async prepare(corpus: EvalCorpusPassage[]): Promise<void> {
    this.corpus.push(...corpus)
    if (this.options.prepareFails) {
      this.state = "disposed"
      throw new EvalPrepareError(this.options.prepareFails, {
        esIndex: "deleted",
        graphProvenance: "cleaned",
        dbClosed: true,
      })
    }
    this.state = "prepared"
  }

  passageIdForChunk(chunk: { documentId: string }): string | null {
    const passage = this.corpus.find((entry) => `doc-${entry.passageId}` === chunk.documentId)
    return passage?.passageId ?? null
  }

  docIdForPassage(passageId: string): string | null {
    return this.corpus.some((entry) => entry.passageId === passageId)
      ? `doc-${passageId}`
      : null
  }

  async createAnswerEntry(): Promise<IsolatedEvalAnswerEntry> {
    const options = this.options
    const preparedCaseOptions = this.preparedCaseOptions
    const passageIdForChunk = (documentId: string) => this.passageIdForChunk({ documentId })
    return {
      accessContext: this.accessContext,
      traceCollector: {
        onEvent: () => {},
        events: [],
        eventsByCase: () => [],
      },
      eventsSource: (message, runOptions) => {
        preparedCaseOptions.push({
          message,
          ...(runOptions.caseId ? { caseId: runOptions.caseId } : {}),
          ...(runOptions.sessionId ? { sessionId: runOptions.sessionId } : {}),
        })
        return (async function* (): AsyncIterable<AnswerRunEvent> {
          if (options.caseThrows) throw new Error(options.caseThrows)
          const ranking = options.ranking ?? FAKE_RANKING
          const candidates: RankedCandidateObservation[] = options.noObservation
            ? []
            : ranking.map((entry, index) => ({
                rank: index + 1,
                documentId: `doc-${entry.passageId}`,
                chunkId: `chunk-${index}`,
                score: 1 - index / 10,
                channels: ["vector"],
              }))
          yield progressEvent(runOptions, {
            type: "progress",
            stage: "retrieval",
            message: "retrieval",
            data: {
              resultCount: candidates.length,
              ...(candidates.length > 0 ? { finalContextCandidates: candidates } : {}),
              ...(candidates.length > 0 && options.ordering
                ? { finalContextOrdering: options.ordering }
                : {}),
            },
          })
          yield progressEvent(runOptions, {
            type: "done",
            stage: "done",
            result: runResult(runOptions, options.reply ?? FAKE_REPLY),
          })
          // Keep the unused helper referenced for type clarity.
          void passageIdForChunk
        })()
      },
    }
  }

  async dispose(): Promise<EvalDisposeReport> {
    this.disposeCalls += 1
    this.state = "disposed"
    return (
      this.options.disposeReport ?? {
        esIndex: "deleted",
        graphProvenance: "cleaned",
        dbClosed: true,
      }
    )
  }
}

function progressEvent(
  options: { runId?: string; sessionId?: string; caseId?: string },
  payload:
    | {
        type: "progress"
        stage: "retrieval"
        message: string
        data: {
          resultCount: number
          finalContextCandidates?: RankedCandidateObservation[]
          finalContextOrdering?: { source: "dedicated_rerank" | "fused"; reason?: string }
        }
      }
    | { type: "done"; stage: "done"; result: AnswerRunResult }
): AnswerRunEvent {
  return {
    schemaVersion: 1,
    sessionId: options.sessionId ?? "session",
    runId: options.runId ?? "run",
    ...(options.caseId ? { caseId: options.caseId } : {}),
    eventId: `event-${Math.random().toString(16).slice(2)}`,
    sequence: 1,
    createdAt: new Date().toISOString(),
    status: payload.type === "done" ? "completed" : "running",
    durationMs: null,
    attempt: 1,
    round: 1,
    inputSummary: "eval",
    outputSummary: "eval",
    ...payload,
  } as AnswerRunEvent
}

function runResult(
  options: { runId?: string; caseId?: string },
  reply: string
): AnswerRunResult {
  return {
    runId: options.runId ?? "run",
    status: "completed",
    reply,
    references: [],
    degradation: { status: "none", unavailableChannels: [] },
  } as AnswerRunResult & { caseId?: string }
}

interface Harness {
  port: number
  close: () => Promise<void>
  scopes: FakeScope[]
  rebuild: (options?: { maxCasesPerTask?: number; maxRetainedTasks?: number }) => Promise<void>
}

const ALL_SCOPES: Scope[] = ["chat", "ingest", "review", "admin"]

/** Header-switched identity so ownership checks can be exercised. */
function identityMiddleware(req: Request, res: Response, next: NextFunction): void {
  const tenant = (req.headers["x-test-tenant"] as string | undefined) ?? "default"
  const scopes = req.headers["x-test-scopes"]
  res.locals.accessContext = {
    tenantId: tenant,
    subjectId: `${tenant}-subject`,
    groups: [],
    scopes:
      typeof scopes === "string"
        ? (scopes.length === 0 ? [] : (scopes.split(",") as Scope[]))
        : [...ALL_SCOPES],
  }
  next()
}

async function buildHarness(
  scopeOptions: FakeScopeOptions = {},
  serviceOptions: { maxCasesPerTask?: number; maxRetainedTasks?: number } = {}
): Promise<Harness> {
  const scopes: FakeScope[] = []
  let server: import("node:http").Server | undefined
  const start = async () => {
    const service = new EvaluationService({
      config: CONFIG,
      clients: {} as never,
      createResources: (taskId) => {
        const scope = new FakeScope(taskId, scopeOptions)
        scopes.push(scope)
        return scope
      },
      now: () => new Date(),
      ...serviceOptions,
    })
    const app = express()
    app.use(express.json())
    app.use(identityMiddleware)
    app.use("/api", createEvaluationsRouter(service))
    server = app.listen(0)
    await new Promise<void>((resolve) => server!.once("listening", resolve))
  }
  await start()
  const stop = () =>
    new Promise<void>((resolve) => {
      // fetch keeps sockets alive; without this the server would never close.
      server!.closeAllConnections?.()
      server!.close(() => resolve())
    })
  return {
    get port() {
      return (server!.address() as AddressInfo).port
    },
    scopes,
    rebuild: async (options) => {
      await stop()
      await start()
      void options
    },
    close: stop,
  }
}

async function api(
  port: number,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, body }
}

async function createTask(port: number, body: unknown, headers: Record<string, string> = {}) {
  return api(port, "/api/evaluations", {
    method: "POST",
    body: JSON.stringify(body),
    headers,
  })
}

async function pollTerminal(
  port: number,
  id: string,
  headers: Record<string, string> = {},
  timeoutMs = 5_000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { status, body } = await api(port, `/api/evaluations/${id}`, { headers })
    assert.equal(status, 200)
    const stage = body.stage as string
    if (["completed", "completed_with_errors", "failed"].includes(stage)) return body
    if (Date.now() > deadline) throw new Error(`task ${id} stuck at stage ${stage}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test("built-in sample runs end to end: register, poll, real answer, Precision, cleanup", async () => {
  const harness = await buildHarness()
  try {
    const datasets = await api(harness.port, "/api/evaluation-datasets")
    assert.equal(datasets.status, 200)
    const list = datasets.body.datasets as Array<Record<string, unknown>>
    assert.equal(list.length, 1)
    assert.equal(list[0].id, "refund-single-case")
    assert.equal(list[0].caseCount, 1)
    assert.equal((datasets.body.defaults as Record<string, unknown>).chatModel, "test-chat-model")

    const created = await createTask(harness.port, { datasetId: "refund-single-case" })
    assert.equal(created.status, 202)
    const id = created.body.id as string
    assert.ok(id)
    assert.deepEqual(created.body.progress, { finished: 0, total: 1 })

    const detail = await pollTerminal(harness.port, id)
    assert.equal(detail.stage, "completed")
    assert.deepEqual(detail.progress, { finished: 1, total: 1 })
    assert.deepEqual(detail.error, undefined)

    const cases = detail.cases as Array<Record<string, unknown>>
    assert.equal(cases.length, 1)
    assert.equal(cases[0].caseId, "refund-eta")
    assert.equal(cases[0].outcome, "answered")
    assert.equal(cases[0].answer, FAKE_REPLY, "the real reply is reported verbatim")
    assert.equal(cases[0].terminalStatus, "completed")
    assert.deepEqual(cases[0].retrievedPassageIds, ["shipping-policy", "refund-policy"])
    assert.equal(
      (cases[0].metrics as Record<string, number>).precision,
      0.5,
      "1 relevant of 2 distinct candidates — irrelevant passages stay in the ranking"
    )

    const metrics = detail.metrics as Record<string, unknown>
    const precision = (metrics.metrics as Record<string, Record<string, unknown>>).precision
    assert.deepEqual(precision, { value: 0.5, sampleSize: 1, notApplicable: 0 })

    assert.deepEqual(detail.cleanup, {
      esIndex: "deleted",
      graphProvenance: "cleaned",
      dbClosed: true,
    })
    assert.equal(harness.scopes.length, 1)
    assert.equal(harness.scopes[0].disposeCalls, 1)
    assert.equal(harness.scopes[0].getState(), "disposed")
    assert.equal(
      harness.scopes[0].preparedCaseOptions[0].caseId,
      "refund-eta",
      "each case is correlated by caseId"
    )
    const asked = harness.scopes[0].preparedCaseOptions[0]
    assert.equal(asked.message, "退款一般需要多久才能到账？", "the question is what reaches the agent")
    assert.equal(
      asked.message.includes("审核通过后"),
      false,
      "the reference answer never enters the answering path"
    )

    const listed = await api(harness.port, "/api/evaluations")
    assert.equal(listed.status, 200)
    assert.equal((listed.body.tasks as unknown[]).length, 1)
  } finally {
    await harness.close()
  }
})

test("prepare failure is visible and cleanup evidence is kept", async () => {
  const harness = await buildHarness({ prepareFails: "ingestion failed for passage(s): refund-policy" })
  try {
    const created = await createTask(harness.port, { datasetId: "refund-single-case" })
    const detail = await pollTerminal(harness.port, created.body.id as string)

    assert.equal(detail.stage, "failed")
    assert.match(String(detail.error), /ingestion failed for passage\(s\): refund-policy/)
    assert.deepEqual(detail.cleanup, {
      esIndex: "deleted",
      graphProvenance: "cleaned",
      dbClosed: true,
    })
  } finally {
    await harness.close()
  }
})

test("a cleanup failure is reported separately from a successful run", async () => {
  const harness = await buildHarness({
    disposeReport: { esIndex: "failed", esError: "es unreachable", graphProvenance: "cleaned", dbClosed: true },
  })
  try {
    const created = await createTask(harness.port, { datasetId: "refund-single-case" })
    const detail = await pollTerminal(harness.port, created.body.id as string)

    assert.equal(detail.stage, "completed", "the run itself succeeded")
    assert.deepEqual(detail.cleanup, {
      esIndex: "failed",
      esError: "es unreachable",
      graphProvenance: "cleaned",
      dbClosed: true,
    })
  } finally {
    await harness.close()
  }
})

test("a case failure keeps the task honest: no fabricated answer, error recorded", async () => {
  const harness = await buildHarness({ caseThrows: "provider unavailable" })
  try {
    const created = await createTask(harness.port, { datasetId: "refund-single-case" })
    const detail = await pollTerminal(harness.port, created.body.id as string)

    assert.equal(detail.stage, "failed")
    const cases = detail.cases as Array<Record<string, unknown>>
    assert.equal(cases[0].outcome, "failed")
    assert.equal(cases[0].answer, "")
    assert.match(String(cases[0].error), /provider unavailable/)
    assert.equal((cases[0].metrics as Record<string, unknown>).precision, null)
  } finally {
    await harness.close()
  }
})

test("an observation without a final accepted round scores 0 rather than inventing a ranking", async () => {
  const harness = await buildHarness({ noObservation: true })
  try {
    const created = await createTask(harness.port, { datasetId: "refund-single-case" })
    const detail = await pollTerminal(harness.port, created.body.id as string)

    const cases = detail.cases as Array<Record<string, unknown>>
    assert.deepEqual(cases[0].candidates, [])
    assert.deepEqual(cases[0].retrievedPassageIds, [])
    assert.equal((cases[0].metrics as Record<string, unknown>).precision, 0)
    assert.equal(
      ((detail.metrics as Record<string, Record<string, { value: number }>>).metrics).precision.value,
      0
    )
  } finally {
    await harness.close()
  }
})

test("invalid datasets are rejected before any task or scope exists", async () => {
  const harness = await buildHarness()
  try {
    const inline = {
      schemaVersion: 1,
      name: "bad",
      version: "1.0.0",
      corpus: [{ passageId: "p1", content: "text" }],
      cases: [
        {
          caseId: "c1",
          question: "q",
          referenceAnswer: "a",
          relevantPassageIds: ["missing"],
        },
      ],
    }
    const rejected = await createTask(harness.port, { dataset: inline })
    assert.equal(rejected.status, 400)
    assert.match(
      String((rejected.body.issues as string[]).join("; ")),
      /references unknown passageId: missing/
    )
    assert.equal(harness.scopes.length, 0, "no scope was created for an invalid dataset")
    const listed = await api(harness.port, "/api/evaluations")
    assert.equal((listed.body.tasks as unknown[]).length, 0)
  } finally {
    await harness.close()
  }
})

test("multi-case datasets are refused explicitly until batch support exists", async () => {
  const harness = await buildHarness()
  try {
    const dataset = {
      schemaVersion: 1,
      name: "two cases",
      version: "1.0.0",
      corpus: [
        { passageId: "p1", content: "a" },
        { passageId: "p2", content: "b" },
      ],
      cases: [
        { caseId: "c1", question: "q1", referenceAnswer: "a1", relevantPassageIds: ["p1"] },
        { caseId: "c2", question: "q2", referenceAnswer: "a2", relevantPassageIds: ["p2"] },
      ],
    }
    const rejected = await createTask(harness.port, { dataset })
    assert.equal(rejected.status, 400)
    assert.match(String(rejected.body.error), /at most 1 per task|batch runs are not enabled/)
    assert.equal(harness.scopes.length, 0)
  } finally {
    await harness.close()
  }
})

test("datasetId and inline dataset are mutually exclusive, and one is required", async () => {
  const harness = await buildHarness()
  try {
    const both = await createTask(harness.port, { datasetId: "x", dataset: {} })
    assert.equal(both.status, 400)
    assert.match(String(both.body.error), /not both/)

    const neither = await createTask(harness.port, {})
    assert.equal(neither.status, 400)
    assert.match(String(neither.body.error), /datasetId \(built-in sample\) or dataset/)

    const unknown = await createTask(harness.port, { datasetId: "nope" })
    assert.equal(unknown.status, 400)
    assert.match(String(unknown.body.error), /unknown built-in dataset id/)
  } finally {
    await harness.close()
  }
})

test("creation requires the admin scope", async () => {
  const harness = await buildHarness()
  try {
    const forbidden = await createTask(
      harness.port,
      { datasetId: "refund-single-case" },
      { "x-test-scopes": "chat" }
    )
    assert.equal(forbidden.status, 403)
    assert.equal(harness.scopes.length, 0)

    const datasetsForbidden = await api(harness.port, "/api/evaluation-datasets", {
      headers: { "x-test-scopes": "chat" },
    })
    assert.equal(datasetsForbidden.status, 403)
  } finally {
    await harness.close()
  }
})

test("tasks are visible only to their owning identity", async () => {
  const harness = await buildHarness()
  try {
    const created = await createTask(harness.port, { datasetId: "refund-single-case" })
    const id = created.body.id as string
    await pollTerminal(harness.port, id)

    const crossTenant = await api(harness.port, `/api/evaluations/${id}`, {
      headers: { "x-test-tenant": "other" },
    })
    assert.equal(crossTenant.status, 404, "another identity must not even learn the id exists")

    const otherList = await api(harness.port, "/api/evaluations", {
      headers: { "x-test-tenant": "other" },
    })
    assert.deepEqual(otherList.body.tasks, [])
  } finally {
    await harness.close()
  }
})

test("results live only in this process: a rebuilt service cannot find old tasks", async () => {
  const harness = await buildHarness()
  try {
    const created = await createTask(harness.port, { datasetId: "refund-single-case" })
    const id = created.body.id as string
    await pollTerminal(harness.port, id)

    await harness.rebuild()

    const afterRestart = await api(harness.port, `/api/evaluations/${id}`)
    assert.equal(afterRestart.status, 404)
    const list = await api(harness.port, "/api/evaluations")
    assert.deepEqual(list.body.tasks, [])
  } finally {
    await harness.close()
  }
})

test("capacity is bounded and a running task is never evicted", async () => {
  const harness = await buildHarness({}, { maxRetainedTasks: 1 })
  try {
    const first = await createTask(harness.port, { datasetId: "refund-single-case" })
    assert.equal(first.status, 202)
    await pollTerminal(harness.port, first.body.id as string)

    const second = await createTask(harness.port, { datasetId: "refund-single-case" })
    assert.equal(second.status, 429)
    assert.match(String(second.body.error), /capacity reached/)

    const stillThere = await api(harness.port, `/api/evaluations/${first.body.id as string}`)
    assert.equal(stillThere.status, 200, "the retained record survived the rejected task")
  } finally {
    await harness.close()
  }
})

test("single-tenant requests without a mounted middleware still work", async () => {
  const scopes: FakeScope[] = []
  const service = new EvaluationService({
    config: CONFIG,
    clients: {} as never,
    createResources: (taskId) => {
      const scope = new FakeScope(taskId, {})
      scopes.push(scope)
      return scope
    },
  })
  const app = express()
  app.use(express.json())
  app.use("/api", createEvaluationsRouter(service))
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const created = await api(port, "/api/evaluations", {
      method: "POST",
      body: JSON.stringify({ datasetId: "refund-single-case" }),
    })
    assert.equal(created.status, 202, "singleTenantAccessContext holds the admin scope")
    assert.equal(scopes.length, 1)
    assert.deepEqual(singleTenantAccessContext().scopes, ALL_SCOPES)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

// ---------------------------------------------------------------------------
// Ticket 06 — the six retrieval metrics and the ranking's score source
// ---------------------------------------------------------------------------

test("a scored case reports all six retrieval metrics and the ranking's real source", async () => {
  // The fake publishes an unscored fallback order (fused) — the case must say
  // so instead of claiming the dedicated reranker produced this ranking.
  const harness = await buildHarness({ ordering: { source: "fused", reason: "not_configured" } })
  try {
    const created = await createTask(harness.port, { datasetId: "refund-single-case" })
    const detail = await pollTerminal(harness.port, created.body.id as string)

    const cases = detail.cases as Array<Record<string, unknown>>
    const metrics = cases[0].metrics as Record<string, number | null>
    // Ranking: shipping-policy (irrelevant), refund-policy (relevant). GT is
    // {refund-policy}: one hit of one ground-truth passage at rank 2.
    assert.deepEqual(Object.keys(metrics).sort(), [
      "bleu-1",
      "bleu-2",
      "bleu-4",
      "map",
      "mrr",
      "ndcg@10",
      "ndcg@3",
      "precision",
      "recall",
      "rouge-1",
      "rouge-2",
      "rouge-l",
    ])
    assert.equal(metrics.precision, 0.5)
    assert.equal(metrics.recall, 1)
    assert.equal(metrics.mrr, 0.5)
    assert.equal(metrics.map, 0.5)
    assert.equal(Number(metrics["ndcg@3"]!.toFixed(6)), Number((1 / Math.log2(3)).toFixed(6)))
    assert.equal(metrics["ndcg@10"], metrics["ndcg@3"])

    assert.deepEqual(
      cases[0].ordering,
      { source: "fused", reason: "not_configured" },
      "a fused fallback is never reported as a dedicated-rerank result"
    )

    // One metric version and one effective sample size for every average.
    const summary = detail.metrics as { version: string; metrics: Record<string, { value: number | null; sampleSize: number; notApplicable: number }> }
    assert.equal(summary.version, "eval-metrics-v2")
    for (const key of ["precision", "recall", "ndcg@3", "ndcg@10", "mrr", "map"]) {
      assert.deepEqual(
        { sampleSize: summary.metrics[key].sampleSize, notApplicable: summary.metrics[key].notApplicable },
        { sampleSize: 1, notApplicable: 0 },
        `${key} must carry its effective sample size`
      )
    }
    assert.equal(summary.metrics.map.value, 0.5, "the aggregate of per-case AP is MAP")
  } finally {
    await harness.close()
  }
})

test("a failed case reports no retrieval metrics instead of six zeros", async () => {
  const harness = await buildHarness({ caseThrows: "provider unavailable" })
  try {
    const created = await createTask(harness.port, { datasetId: "refund-single-case" })
    const detail = await pollTerminal(harness.port, created.body.id as string)

    const cases = detail.cases as Array<Record<string, unknown>>
    assert.deepEqual(cases[0].metrics, {
      precision: null,
      recall: null,
      "ndcg@3": null,
      "ndcg@10": null,
      mrr: null,
      map: null,
      "bleu-1": null,
      "bleu-2": null,
      "bleu-4": null,
      "rouge-1": null,
      "rouge-2": null,
      "rouge-l": null,
    })
    assert.equal(cases[0].ordering, undefined, "no scored ranking means no score source")
    const summary = detail.metrics as { metrics: Record<string, { value: number | null; sampleSize: number; notApplicable: number }> }
    for (const key of [
      "precision",
      "recall",
      "ndcg@3",
      "ndcg@10",
      "mrr",
      "map",
      "bleu-1",
      "bleu-2",
      "bleu-4",
      "rouge-1",
      "rouge-2",
      "rouge-l",
    ]) {
      assert.deepEqual(
        summary.metrics[key],
        { value: null, sampleSize: 0, notApplicable: 1 },
        `${key} must stay "not applicable" rather than becoming a fake 0`
      )
    }
  } finally {
    await harness.close()
  }
})

// ---------------------------------------------------------------------------
// Ticket 07 — BLEU is scored from the actual reply
// ---------------------------------------------------------------------------

/** Single-case dataset whose reference answer equals the fake reply. */
function bleuDataset(referenceAnswer: string) {
  return {
    schemaVersion: 1,
    name: "bleu",
    version: "1.0.0",
    corpus: [{ passageId: "bleu-p1", content: "退款在审核通过后 3 个工作日内到账。" }],
    cases: [
      {
        caseId: "bleu-1",
        question: "退款多久到账？",
        referenceAnswer,
        relevantPassageIds: ["bleu-p1"],
      },
    ],
  }
}

test("a reply identical to the reference scores BLEU-1/2/4 and ROUGE-1/2/L = 1", async () => {
  const harness = await buildHarness({ ranking: [{ passageId: "bleu-p1", relevant: true }] })
  try {
    const created = await createTask(harness.port, { dataset: bleuDataset(FAKE_REPLY) })
    const detail = await pollTerminal(harness.port, created.body.id as string)

    const cases = detail.cases as Array<Record<string, unknown>>
    const metrics = cases[0].metrics as Record<string, number | null>
    assert.equal(cases[0].answer, FAKE_REPLY)
    assert.equal(metrics["bleu-1"], 1)
    assert.equal(metrics["bleu-2"], 1)
    assert.equal(metrics["bleu-4"], 1)
    assert.equal(metrics["rouge-1"], 1)
    assert.equal(metrics["rouge-2"], 1)
    assert.equal(metrics["rouge-l"], 1)
    // The retrieval side of the same bundle is unaffected.
    assert.equal(metrics.precision, 1)

    const summary = detail.metrics as {
      generation?: { bleuVersion: string; rougeVersion: string; textRuleVersion: string }
      metrics: Record<string, { value: number | null; sampleSize: number }>
    }
    assert.equal(summary.metrics["bleu-4"].value, 1)
    assert.equal(summary.metrics["bleu-4"].sampleSize, 1)
    assert.equal(summary.metrics["rouge-l"].value, 1)
    assert.equal(summary.metrics["rouge-l"].sampleSize, 1)
    assert.equal(summary.generation?.bleuVersion, "eval-bleu-v1")
    assert.equal(summary.generation?.rougeVersion, "eval-rouge-v1")
    assert.equal(summary.generation?.textRuleVersion, "eval-text-v1")
  } finally {
    await harness.close()
  }
})

test("an honest refusal keeps its own text and its own low BLEU (the reference is never substituted)", async () => {
  const refusal = "抱歉，我无法回答这个问题。"
  // Zero character overlap with the refusal, so a substituted reference would
  // score exactly 1 and this test would catch it.
  const reference = "订单签收后可申请退货。"
  const harness = await buildHarness({
    ranking: [{ passageId: "bleu-p1", relevant: true }],
    reply: refusal,
  })
  try {
    const created = await createTask(harness.port, { dataset: bleuDataset(reference) })
    const detail = await pollTerminal(harness.port, created.body.id as string)

    const cases = detail.cases as Array<Record<string, unknown>>
    const metrics = cases[0].metrics as Record<string, number | null>
    assert.equal(cases[0].answer, refusal, "the published reply is what gets scored")
    assert.equal(metrics["bleu-1"], 0, "no shared unigram with the reference")
    assert.equal(metrics["bleu-2"], 0)
    assert.equal(metrics["bleu-4"], 0)
    assert.equal(metrics["rouge-1"], 0, "no shared unigram means no overlap to score")
    assert.equal(metrics["rouge-2"], 0)
    assert.equal(metrics["rouge-l"], 0, "no common subsequence at all")
    for (const key of ["bleu-1", "bleu-2", "bleu-4", "rouge-1", "rouge-2", "rouge-l"]) {
      assert.ok(Number.isFinite(metrics[key]), `${key} must never be NaN or Infinity`)
    }
  } finally {
    await harness.close()
  }
})

// ---------------------------------------------------------------------------
// Ticket 05 — custom JSON datasets
// ---------------------------------------------------------------------------

/** A minimal valid single-case dataset; passageIds are deliberately unfriendly. */
function inlineDataset(content = "退款在审核通过后 3 个工作日内按原支付路径返还。") {
  return {
    schemaVersion: 1,
    name: "自定义单题",
    version: "1.0.0",
    corpus: [
      { passageId: "段落/一 #1", title: "退款到账", content },
      { passageId: "干扰/配送 #2", content: "标准配送需要 2 至 4 个工作日。" },
    ],
    cases: [
      {
        caseId: "custom-1",
        question: "退款一般需要多久才能到账？",
        referenceAnswer: "审核通过后 3 个工作日内按原支付路径返还。",
        relevantPassageIds: ["段落/一 #1"],
      },
    ],
  }
}

test("an uploaded dataset runs end to end: arbitrary passageId, distractor ingested, digest identifies the content", async () => {
  const harness = await buildHarness({
    ranking: [
      { passageId: "段落/一 #1", relevant: true },
      { passageId: "干扰/配送 #2", relevant: false },
    ],
  })
  try {
    const created = await createTask(harness.port, { dataset: inlineDataset() })
    assert.equal(created.status, 202)
    const detail = await pollTerminal(harness.port, created.body.id as string)

    assert.equal(detail.stage, "completed")
    const cases = detail.cases as Array<Record<string, unknown>>
    assert.equal(cases[0].outcome, "answered")
    assert.deepEqual(
      cases[0].retrievedPassageIds,
      ["段落/一 #1", "干扰/配送 #2"],
      "an arbitrary passageId maps back to the corpus"
    )
    assert.equal(cases[0].unmappedCandidates, 0, "both candidates belong to this dataset's corpus")
    assert.equal(
      (cases[0].metrics as Record<string, number>).precision,
      0.5,
      "the distractor stays in the ranking (no filtering that would inflate the score)"
    )
    assert.equal(harness.scopes[0].corpus.length, 2, "the distractor passage is ingested too")

    // Same name/version, different content → a different digest (ticket 05).
    const other = await createTask(harness.port, {
      dataset: inlineDataset("退款到账时间以审核完成为准，一般为 5 个工作日。"),
    })
    assert.equal(other.status, 202)
    const otherDetail = await pollTerminal(harness.port, other.body.id as string)
    const firstRef = detail.dataset as Record<string, unknown>
    const secondRef = otherDetail.dataset as Record<string, unknown>
    assert.equal(secondRef.version, firstRef.version)
    assert.notEqual(
      secondRef.contentDigest,
      firstRef.contentDigest,
      "same version with different content must be distinguishable by digest"
    )
  } finally {
    await harness.close()
  }
})

test("uploaded datasets are rejected per field before any scope or model call", async () => {
  const base = inlineDataset()
  const cases: Array<[string, unknown, RegExp]> = [
    [
      "duplicate passageId",
      { ...base, corpus: [base.corpus[0], { ...base.corpus[1], passageId: "段落/一 #1" }] },
      /duplicates an earlier id/,
    ],
    [
      "unknown passage reference",
      { ...base, cases: [{ ...base.cases[0], relevantPassageIds: ["不存在"] }] },
      /references unknown passageId/,
    ],
    ["empty corpus", { ...base, corpus: [] }, /corpus must be a non-empty array/],
    [
      "empty question",
      { ...base, cases: [{ ...base.cases[0], question: "   " }] },
      /question must be a non-empty string/,
    ],
    ["illegal version", { ...base, version: "" }, /version must be a non-empty string/],
    [
      "oversized corpus",
      {
        ...base,
        corpus: Array.from({ length: 201 }, (_, index) => ({ passageId: `p${index}`, content: "x" })),
        cases: [{ ...base.cases[0], relevantPassageIds: ["p0"] }],
      },
      /at most 200 passages/,
    ],
  ]

  const harness = await buildHarness()
  try {
    for (const [label, dataset, pattern] of cases) {
      const rejected = await createTask(harness.port, { dataset })
      assert.equal(rejected.status, 400, `${label} must be rejected`)
      const issues = Array.isArray(rejected.body.issues) ? (rejected.body.issues as string[]) : []
      assert.ok(issues.length > 0, `${label} must report field/case-level issues`)
      assert.match(issues.join("; "), pattern, `${label}: issue must name the offending field`)
    }
    assert.equal(harness.scopes.length, 0, "no scope was created for any invalid dataset")
    const listed = await api(harness.port, "/api/evaluations")
    assert.deepEqual(listed.body.tasks, [], "no task was registered for any invalid dataset")
  } finally {
    await harness.close()
  }
})

test("a request cannot make the server read an arbitrary path", async () => {
  const harness = await buildHarness()
  try {
    const pathOnly = await createTask(harness.port, { datasetPath: "C:/Windows/win.ini" })
    assert.equal(pathOnly.status, 400, "a path-like field is not a dataset source")
    assert.match(String(pathOnly.body.error), /datasetId \(built-in sample\) or dataset/)

    const traversal = await createTask(harness.port, { datasetId: "../../etc/passwd" })
    assert.equal(traversal.status, 400, "built-in ids are matched against the in-code samples only")
    assert.match(String(traversal.body.error), /unknown built-in dataset id/)

    // Extra fields are ignored: the documented field decides, and it is the
    // in-code sample — never a file on disk.
    const withExtra = await createTask(harness.port, {
      datasetId: "refund-single-case",
      datasetPath: "C:/Windows/win.ini",
    })
    assert.equal(withExtra.status, 202)
    const detail = await pollTerminal(harness.port, withExtra.body.id as string)
    assert.equal(detail.stage, "completed")
    assert.equal(harness.scopes.length, 1)
    assert.deepEqual(
      harness.scopes[0].corpus.map((passage) => passage.passageId),
      ["refund-policy", "shipping-policy", "warranty-policy", "invoice-policy"],
      "the built-in corpus was ingested, not a file"
    )
  } finally {
    await harness.close()
  }
})
