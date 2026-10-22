/**
 * DR-23 — the operator-run latency measurement command.
 *
 * What this owns:
 *   - the fixed demo plan: one complete twenty-case warmup (explicitly
 *     excluded), then five complete twenty-case rounds measured at single
 *     concurrency (100 samples), then a separate concurrent-3 pass;
 *   - the durable ledger: a frozen manifest before the first request, one
 *     atomically written record per planned sample, and a report derived only
 *     from those records;
 *   - nearest-rank p50/p95 over the raw client-side chat durations, with the
 *     grouping rule and denominator published for every group;
 *   - a fail-closed gate: any timeout/execution error or missing/not-started
 *     sample fails the performance run while its original record and real
 *     wait stay in the report;
 *   - separation of FAQ/direct, non-FAQ knowledge answers and other cases,
 *     and of single concurrency vs concurrent-3.
 *
 * What this deliberately does not own:
 *   - any judge call. Latency is the wall time from sending POST /api/chat to
 *     receiving the JSON body carrying the terminal done event; judge time
 *     can never enter it because no judge runs here.
 *   - the real-provider 30 s p95 target. That needs the online stack and is
 *     evaluated by DR-24; this command only proves scheduling, counting,
 *     persistence, recomputation and the failure contract over a controlled
 *     local HTTP service.
 */

import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

export type LatencyGroup = "faq_direct" | "non_faq_knowledge" | "other"
export type LatencyPhase = "warmup" | "measured" | "concurrent3"

export const FAQ_CASE_ID = "hard-04-faq-exact-answer"
export const WARMUP_ROUNDS = 1
export const MEASURED_ROUNDS = 5
export const CASES_PER_ROUND = 20
export const WARMUP_SAMPLES = WARMUP_ROUNDS * CASES_PER_ROUND
export const MEASURED_SAMPLE_COUNT = MEASURED_ROUNDS * CASES_PER_ROUND
export const CONCURRENT3_ROUNDS = 1
export const CONCURRENT3_SESSIONS = 3
export const CONCURRENT3_SAMPLES = CONCURRENT3_ROUNDS * CASES_PER_ROUND
export const MIN_NON_FAQ_KNOWLEDGE_SAMPLES = 70
export const DEFAULT_TIMEOUT_MS = 120_000

export const GROUP_RULES: Record<LatencyGroup, string> = {
  faq_direct:
    "the FAQ exact-answer case only (unique standard answer, direct fast path); reported alone so a fast FAQ hit cannot hide knowledge-answer latency",
  non_faq_knowledge:
    "answer cases other than the FAQ exact-answer case; the performance denominator is five measured rounds x fourteen cases = 70",
  other:
    "refusal, empty-scope and memory-only cases; recorded and reported but not used as knowledge-answer latency",
}

export const PHASE_TIMING_DEFINITION =
  "Chat latency is the monotonic wall time from sending POST /api/chat (stream=false) " +
  "to receiving and parsing the JSON body that carries the terminal done event. " +
  "Phase marks are the run's own event stages (route, retrieval, context, answer, " +
  "validation, done) taken from event.durationMs; they are diagnostic and never " +
  "replace the end-to-end duration. No judge runs in this command, so judge time " +
  "cannot enter any latency statistic."

const PHASE_STAGES = ["route", "retrieval", "context", "answer", "validation", "done"] as const
const EXECUTION_ERROR_TERMINALS = new Set(["provider_error", "cancelled"])
const SAMPLE_SCHEMA = "latency-measurement-sample"
const MANIFEST_SCHEMA = "latency-measurement-manifest"
const REPORT_SCHEMA = "latency-measurement-report"

const DEFAULT_DATASET = resolve(
  __dirname,
  "..",
  "..",
  "golden",
  "demo-release-cases.v2.json"
)

// ---------------------------------------------------------------------------
// Fixed demo dataset
// ---------------------------------------------------------------------------

export interface LatencyCase {
  id: string
  kind: string
  group: LatencyGroup
  message: string
  knowledgeBaseIds?: string[]
}

export interface LoadedLatencyDataset {
  path: string
  sha256: string
  cases: LatencyCase[]
}

export function classifyLatencyCase(caseId: string, kind: string): LatencyGroup {
  if (caseId === FAQ_CASE_ID) return "faq_direct"
  if (kind === "answer") return "non_faq_knowledge"
  return "other"
}

export function loadLatencyDataset(path: string = DEFAULT_DATASET): LoadedLatencyDataset {
  const absolute = resolve(path)
  const raw = readFileSync(absolute, "utf8")
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `latency dataset ${absolute} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("the latency dataset must be a JSON object")
  }
  const dataset = payload as { version?: unknown; cases?: unknown }
  if (dataset.version !== 2) {
    throw new Error(`the latency dataset must be version 2; found ${String(dataset.version)}`)
  }
  if (!Array.isArray(dataset.cases)) {
    throw new Error("the latency dataset requires a cases array")
  }
  if (dataset.cases.length !== CASES_PER_ROUND) {
    throw new Error(
      `the latency plan requires exactly the fixed ${CASES_PER_ROUND} demo cases; ` +
        `found ${dataset.cases.length}`
    )
  }
  const seen = new Set<string>()
  const cases: LatencyCase[] = []
  for (const [index, candidate] of dataset.cases.entries()) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`latency cases[${index}] must be an object`)
    }
    const item = candidate as {
      id?: unknown
      kind?: unknown
      message?: unknown
      knowledgeBaseIds?: unknown
    }
    if (typeof item.id !== "string" || item.id.length === 0) {
      throw new Error(`latency cases[${index}].id must be a non-empty string`)
    }
    if (typeof item.message !== "string" || item.message.trim().length === 0) {
      throw new Error(`${item.id}: message must be a non-empty string`)
    }
    if (typeof item.kind !== "string" || item.kind.length === 0) {
      throw new Error(`${item.id}: kind must be a non-empty string`)
    }
    if (seen.has(item.id)) throw new Error(`duplicate latency case id: ${item.id}`)
    seen.add(item.id)
    if (
      item.knowledgeBaseIds !== undefined &&
      (!Array.isArray(item.knowledgeBaseIds) ||
        item.knowledgeBaseIds.some(
          (entry) => typeof entry !== "string" || entry.length === 0
        ))
    ) {
      throw new Error(`${item.id}: knowledgeBaseIds must be an array of non-empty strings`)
    }
    cases.push({
      id: item.id,
      kind: item.kind,
      message: item.message,
      group: classifyLatencyCase(item.id, item.kind),
      ...(item.knowledgeBaseIds !== undefined
        ? { knowledgeBaseIds: item.knowledgeBaseIds as string[] }
        : {}),
    })
  }
  return {
    path: absolute,
    sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
    cases,
  }
}

// ---------------------------------------------------------------------------
// Frozen plan
// ---------------------------------------------------------------------------

export interface PlannedLatencySample {
  sampleId: string
  phase: LatencyPhase
  round: number
  caseId: string
  group: LatencyGroup
  concurrency: 1 | 3
}

export function buildLatencyPlan(cases: readonly LatencyCase[]): PlannedLatencySample[] {
  if (cases.length !== CASES_PER_ROUND) {
    throw new Error(
      `the fixed plan needs ${CASES_PER_ROUND} cases; got ${cases.length}`
    )
  }
  const plan: PlannedLatencySample[] = []
  for (let round = 1; round <= WARMUP_ROUNDS; round += 1) {
    for (const item of cases) {
      plan.push({
        sampleId: `warmup-r${round}-${item.id}`,
        phase: "warmup",
        round,
        caseId: item.id,
        group: item.group,
        concurrency: 1,
      })
    }
  }
  for (let round = 1; round <= MEASURED_ROUNDS; round += 1) {
    for (const item of cases) {
      plan.push({
        sampleId: `measured-r${round}-${item.id}`,
        phase: "measured",
        round,
        caseId: item.id,
        group: item.group,
        concurrency: 1,
      })
    }
  }
  for (let round = 1; round <= CONCURRENT3_ROUNDS; round += 1) {
    for (const item of cases) {
      plan.push({
        sampleId: `concurrent3-r${round}-${item.id}`,
        phase: "concurrent3",
        round,
        caseId: item.id,
        group: item.group,
        concurrency: 3,
      })
    }
  }
  return plan
}

// ---------------------------------------------------------------------------
// nearest-rank statistics
// ---------------------------------------------------------------------------

/**
 * Nearest-rank percentile: rank = ceil(percentile/100 * n), 1-indexed, no
 * interpolation. The returned value is always one of the raw observations.
 */
export function nearestRankPercentile(
  values: readonly number[],
  percentile: number
): number | null {
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 100) {
    throw new RangeError(`percentile must be in (0, 100]; got ${percentile}`)
  }
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length))
  return sorted[rank - 1]
}

// ---------------------------------------------------------------------------
// Manifest and sample records
// ---------------------------------------------------------------------------

export interface LatencyManifest {
  schema: typeof MANIFEST_SCHEMA
  ticket: "DR-23"
  runId: string
  createdAt: string
  frozen: true
  dataset: {
    path: string
    sha256: string
    caseCount: number
    cases: Array<{
      id: string
      kind: string
      group: LatencyGroup
      messageSha256: string
      knowledgeBaseIds: string[] | null
    }>
  }
  models: {
    chat: string | null
    embedding: string | null
    rerank: string | null
    decision: string
  }
  capabilities: {
    chat: string
    rerank: {
      configured: boolean
      exercised: false
      countedAsPass: false
    } | null
  }
  concurrency: {
    single: 1
    concurrent3: 3
    concurrent3SessionsInFlight: 3
    mixing: "never"
  }
  phaseTiming: {
    definition: string
    stages: string[]
    judgeExcluded: true
  }
  configuration: {
    baseUrl: string
    timeoutMs: number
    stream: false
    warmupRounds: number
    measuredRounds: number
    casesPerRound: number
    minNonFaqKnowledgeSamples: number
  }
  plan: {
    warmupSamples: number
    measuredSamples: number
    concurrent3Samples: number
    totalSamples: number
    sampleIds: string[]
    groups: Record<LatencyGroup, string>
  }
  judge: {
    invoked: false
    excludedFromLatency: true
  }
}

export interface LatencySampleRecord {
  schema: typeof SAMPLE_SCHEMA
  ticket: "DR-23"
  sampleId: string
  phase: LatencyPhase
  round: number
  caseId: string
  group: LatencyGroup
  concurrency: 1 | 3
  sessionId: string
  startedAt: string
  finishedAt: string
  /** Client-side chat wall time; a timeout stores the actual wait too. */
  durationMs: number
  httpStatus: number | null
  terminalStatus: string | null
  phases: Array<{ stage: string; status: string | null; durationMs: number }>
  error: string | null
  writtenAt: string
}

export function latencyModelSnapshot(
  env: NodeJS.ProcessEnv = process.env
): LatencyManifest["models"] {
  return {
    chat: env.OPENAI_CHAT_MODEL || null,
    embedding: env.EMBEDDING_MODEL || null,
    rerank: env.RERANK_MODEL || null,
    decision: env.DECISION_PROVIDER || "chat",
  }
}

export function latencyCapabilitySnapshot(
  env: NodeJS.ProcessEnv = process.env
): LatencyManifest["capabilities"] {
  return {
    chat: "http-json",
    rerank: {
      configured: Boolean(env.RERANK_MODEL || env.RERANK_API_KEY),
      exercised: false,
      countedAsPass: false,
    },
  }
}

export function buildLatencyManifest(input: {
  runId: string
  createdAt: string
  dataset: LoadedLatencyDataset
  models: LatencyManifest["models"]
  capabilities: LatencyManifest["capabilities"]
  baseUrl: string
  timeoutMs: number
}): LatencyManifest {
  return {
    schema: MANIFEST_SCHEMA,
    ticket: "DR-23",
    runId: input.runId,
    createdAt: input.createdAt,
    frozen: true,
    dataset: {
      path: input.dataset.path,
      sha256: input.dataset.sha256,
      caseCount: input.dataset.cases.length,
      cases: input.dataset.cases.map((item) => ({
        id: item.id,
        kind: item.kind,
        group: item.group,
        messageSha256: createHash("sha256").update(item.message, "utf8").digest("hex"),
        knowledgeBaseIds:
          item.knowledgeBaseIds !== undefined ? [...item.knowledgeBaseIds] : null,
      })),
    },
    models: { ...input.models },
    capabilities: {
      chat: input.capabilities.chat,
      rerank: input.capabilities.rerank ? { ...input.capabilities.rerank } : null,
    },
    concurrency: {
      single: 1,
      concurrent3: CONCURRENT3_SESSIONS,
      concurrent3SessionsInFlight: CONCURRENT3_SESSIONS,
      mixing: "never",
    },
    phaseTiming: {
      definition: PHASE_TIMING_DEFINITION,
      stages: [...PHASE_STAGES],
      judgeExcluded: true,
    },
    configuration: {
      baseUrl: safeUrl(input.baseUrl),
      timeoutMs: input.timeoutMs,
      stream: false,
      warmupRounds: WARMUP_ROUNDS,
      measuredRounds: MEASURED_ROUNDS,
      casesPerRound: CASES_PER_ROUND,
      minNonFaqKnowledgeSamples: MIN_NON_FAQ_KNOWLEDGE_SAMPLES,
    },
    plan: {
      warmupSamples: WARMUP_SAMPLES,
      measuredSamples: MEASURED_SAMPLE_COUNT,
      concurrent3Samples: CONCURRENT3_SAMPLES,
      totalSamples: WARMUP_SAMPLES + MEASURED_SAMPLE_COUNT + CONCURRENT3_SAMPLES,
      sampleIds: buildLatencyPlan(input.dataset.cases).map((sample) => sample.sampleId),
      groups: { ...GROUP_RULES },
    },
    judge: { invoked: false, excludedFromLatency: true },
  }
}

// ---------------------------------------------------------------------------
// Report derivation (pure; the caller supplies the durable records)
// ---------------------------------------------------------------------------

export interface LatencyGroupStats {
  group: LatencyGroup
  rule: string
  phase: "measured" | "concurrent3"
  concurrency: 1 | 3
  denominator: number
  recorded: number
  notStarted: number
  n: number
  errors: number
  p50Ms: number | null
  p95Ms: number | null
  rawDurationsMs: number[]
  sampleIds: string[]
}

export interface LatencyGateReason {
  kind: "not_started" | "corrupt" | "execution_error" | "insufficient_n" | "incomplete_phase"
  sampleId?: string
  detail: string
}

export interface LatencyPhaseCounts {
  planned: number
  recorded: number
  notStarted: number
  corrupt: number
  errors: number
  excluded?: true
}

export interface LatencyReport {
  schema: typeof REPORT_SCHEMA
  ticket: "DR-23"
  runId: string
  generatedAt: string
  judge: LatencyManifest["judge"]
  phaseTiming: LatencyManifest["phaseTiming"]
  plan: LatencyManifest["plan"]
  counts: {
    planned: number
    recorded: number
    notStarted: number
    corrupt: number
    errors: number
    warmup: LatencyPhaseCounts
    measured: LatencyPhaseCounts
    concurrent3: LatencyPhaseCounts
  }
  groups: {
    single: Record<LatencyGroup, LatencyGroupStats>
    concurrent3: Record<LatencyGroup, LatencyGroupStats>
  }
  samples: LatencySampleRecord[]
  missing: string[]
  corrupt: string[]
  gate: {
    passed: boolean
    status: "passed" | "failed" | "incomplete"
    reasons: LatencyGateReason[]
  }
  limits: {
    scope: string
    productionSlo: false
    p95TargetEvaluatedBy: "DR-24 online"
  }
}

const PHASE_ORDER: Record<LatencyPhase, number> = {
  warmup: 0,
  measured: 1,
  concurrent3: 2,
}

function compareSamples(
  left: PlannedLatencySample,
  right: PlannedLatencySample
): number {
  return (
    PHASE_ORDER[left.phase] - PHASE_ORDER[right.phase] ||
    left.round - right.round ||
    left.caseId.localeCompare(right.caseId)
  )
}

function statsFor(
  planned: readonly PlannedLatencySample[],
  records: Record<string, LatencySampleRecord>,
  group: LatencyGroup,
  phase: "measured" | "concurrent3",
  concurrency: 1 | 3
): LatencyGroupStats {
  const denominator = planned.filter(
    (sample) => sample.phase === phase && sample.group === group
  )
  const observed = denominator
    .map((sample) => records[sample.sampleId])
    .filter((record): record is LatencySampleRecord => record !== undefined)
  const durations = observed
    .map((record) => record.durationMs)
    .filter((value) => Number.isFinite(value))
  return {
    group,
    rule: GROUP_RULES[group],
    phase,
    concurrency,
    denominator: denominator.length,
    recorded: observed.length,
    notStarted: denominator.length - observed.length,
    n: durations.length,
    errors: observed.filter((record) => record.error !== null).length,
    p50Ms: nearestRankPercentile(durations, 50),
    p95Ms: nearestRankPercentile(durations, 95),
    rawDurationsMs: durations,
    sampleIds: observed.map((record) => record.sampleId),
  }
}

function phaseCounts(
  planned: readonly PlannedLatencySample[],
  records: Record<string, LatencySampleRecord>,
  phase: LatencyPhase,
  corrupt: readonly string[]
): LatencyPhaseCounts {
  const items = planned.filter((sample) => sample.phase === phase)
  const observed = items.filter((sample) => records[sample.sampleId] !== undefined)
  return {
    planned: items.length,
    recorded: observed.length,
    notStarted: items.length - observed.length,
    corrupt: corrupt.filter((sampleId) =>
      items.some((sample) => sample.sampleId === sampleId)
    ).length,
    errors: observed.filter((sample) => records[sample.sampleId].error !== null).length,
    ...(phase === "warmup" ? { excluded: true as const } : {}),
  }
}

export function buildLatencyReport(input: {
  manifest: LatencyManifest
  planned: readonly PlannedLatencySample[]
  records: Record<string, LatencySampleRecord>
  missing?: readonly string[]
  corrupt?: readonly string[]
  generatedAt?: string
}): LatencyReport {
  const planned = [...input.planned].sort(compareSamples)
  const records: Record<string, LatencySampleRecord> = {}
  for (const sample of planned) {
    const record = input.records[sample.sampleId]
    if (record !== undefined) records[sample.sampleId] = record
  }
  const missing = [...(input.missing ?? [])]
  const corrupt = [...(input.corrupt ?? [])]
  const warmup = phaseCounts(planned, records, "warmup", corrupt)
  const measured = phaseCounts(planned, records, "measured", corrupt)
  const concurrent3 = phaseCounts(planned, records, "concurrent3", corrupt)
  const groups = {
    single: {
      faq_direct: statsFor(planned, records, "faq_direct", "measured", 1),
      non_faq_knowledge: statsFor(
        planned,
        records,
        "non_faq_knowledge",
        "measured",
        1
      ),
      other: statsFor(planned, records, "other", "measured", 1),
    },
    concurrent3: {
      faq_direct: statsFor(planned, records, "faq_direct", "concurrent3", 3),
      non_faq_knowledge: statsFor(
        planned,
        records,
        "non_faq_knowledge",
        "concurrent3",
        3
      ),
      other: statsFor(planned, records, "other", "concurrent3", 3),
    },
  }

  const reasons: LatencyGateReason[] = []
  for (const sample of planned) {
    if (missing.includes(sample.sampleId) || records[sample.sampleId] === undefined) {
      if (!missing.includes(sample.sampleId) && corrupt.includes(sample.sampleId)) continue
      reasons.push({
        kind: "not_started",
        sampleId: sample.sampleId,
        detail: `${sample.phase} sample was planned but has no durable record`,
      })
    }
    if (corrupt.includes(sample.sampleId)) {
      reasons.push({
        kind: "corrupt",
        sampleId: sample.sampleId,
        detail: `${sample.phase} sample record is missing, truncated or mis-identified`,
      })
    }
  }
  for (const record of Object.values(records)) {
    if (record.error !== null) {
      reasons.push({
        kind: "execution_error",
        sampleId: record.sampleId,
        detail: `${record.error}; actual wait ${record.durationMs} ms`,
      })
    }
  }
  for (const [label, counts] of [
    ["warmup", warmup],
    ["measured", measured],
    ["concurrent3", concurrent3],
  ] as const) {
    if (counts.recorded + counts.corrupt !== counts.planned) {
      reasons.push({
        kind: "incomplete_phase",
        detail: `${label}: ${counts.recorded}/${counts.planned} samples recorded`,
      })
    }
  }
  const nonFaq = groups.single.non_faq_knowledge
  if (nonFaq.denominator < MIN_NON_FAQ_KNOWLEDGE_SAMPLES) {
    reasons.push({
      kind: "insufficient_n",
      detail: `non-FAQ knowledge denominator ${nonFaq.denominator} < ${MIN_NON_FAQ_KNOWLEDGE_SAMPLES}`,
    })
  } else if (nonFaq.recorded < MIN_NON_FAQ_KNOWLEDGE_SAMPLES || nonFaq.n < MIN_NON_FAQ_KNOWLEDGE_SAMPLES) {
    reasons.push({
      kind: "insufficient_n",
      detail: `non-FAQ knowledge samples ${nonFaq.n}/${MIN_NON_FAQ_KNOWLEDGE_SAMPLES} have a usable duration`,
    })
  }
  if (groups.single.faq_direct.recorded === 0) {
    reasons.push({
      kind: "insufficient_n",
      detail: "FAQ/direct group has no recorded sample and is not a pass",
    })
  }

  const incomplete = reasons.some(
    (reason) => reason.kind === "not_started" || reason.kind === "corrupt"
  )
  const passed = reasons.length === 0
  return {
    schema: REPORT_SCHEMA,
    ticket: "DR-23",
    runId: input.manifest.runId,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    judge: { ...input.manifest.judge },
    phaseTiming: { ...input.manifest.phaseTiming },
    plan: { ...input.manifest.plan },
    counts: {
      planned: planned.length,
      recorded: Object.keys(records).length,
      notStarted: warmup.notStarted + measured.notStarted + concurrent3.notStarted,
      corrupt: warmup.corrupt + measured.corrupt + concurrent3.corrupt,
      errors: Object.values(records).filter((record) => record.error !== null).length,
      warmup,
      measured,
      concurrent3,
    },
    groups,
    samples: planned
      .map((sample) => records[sample.sampleId])
      .filter((record): record is LatencySampleRecord => record !== undefined),
    missing,
    corrupt,
    gate: {
      passed,
      status: passed ? "passed" : incomplete ? "incomplete" : "failed",
      reasons,
    },
    limits: {
      scope:
        "Fixed demo dataset and configuration at the recorded concurrency only; " +
        "single-concurrency and concurrent-3 are reported separately and never " +
        "mixed. This is not a production SLO.",
      productionSlo: false,
      p95TargetEvaluatedBy: "DR-24 online",
    },
  }
}

// ---------------------------------------------------------------------------
// HTTP sampling
// ---------------------------------------------------------------------------

export interface LatencyRunOptions {
  baseUrl: string
  runsRoot: string
  authToken?: string
  password?: string
  timeoutMs?: number
  casesPath?: string
  fetchImpl?: typeof fetch
  now?: () => number
  env?: NodeJS.ProcessEnv
}

export interface LatencyRunOutcome {
  exitCode: 0 | 1 | 2
  runId?: string
  runDir?: string
  report?: LatencyReport
  error?: string
}

function safeUrl(input: string): string {
  try {
    const url = new URL(input)
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`
  } catch {
    return "[invalid-url]"
  }
}

function writeJsonAtomic(path: string, payload: unknown): unknown {
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  writeFileSync(temporary, JSON.stringify(payload, null, 2), "utf8")
  renameSync(temporary, path)
  return JSON.parse(readFileSync(path, "utf8"))
}

function baseSample(
  planned: PlannedLatencySample,
  input: {
    sessionId: string
    startedAt: string
    finishedAt: string
    durationMs: number
    httpStatus: number | null
    terminalStatus: string | null
    phases: LatencySampleRecord["phases"]
    error: string | null
  }
): LatencySampleRecord {
  return {
    schema: SAMPLE_SCHEMA,
    ticket: "DR-23",
    sampleId: planned.sampleId,
    phase: planned.phase,
    round: planned.round,
    caseId: planned.caseId,
    group: planned.group,
    concurrency: planned.concurrency,
    sessionId: input.sessionId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    httpStatus: input.httpStatus,
    terminalStatus: input.terminalStatus,
    phases: input.phases,
    error: input.error,
    writtenAt: new Date().toISOString(),
  }
}

function phaseMarks(events: unknown): LatencySampleRecord["phases"] {
  if (!Array.isArray(events)) return []
  const latest = new Map<
    string,
    { stage: string; status: string | null; durationMs: number }
  >()
  for (const candidate of events) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue
    const event = candidate as {
      stage?: unknown
      status?: unknown
      durationMs?: unknown
    }
    if (
      typeof event.stage === "string" &&
      typeof event.durationMs === "number" &&
      Number.isFinite(event.durationMs)
    ) {
      latest.set(event.stage, {
        stage: event.stage,
        status: typeof event.status === "string" ? event.status : null,
        durationMs: event.durationMs,
      })
    }
  }
  return [...latest.values()]
}

async function login(
  baseUrl: string,
  password: string | undefined,
  fetchImpl: typeof fetch
): Promise<string> {
  const credential = password ?? process.env.DEMO_OIDC_PASSWORD
  if (!credential) {
    throw new Error("DEMO_OIDC_PASSWORD is not set; cannot sign in to the demo tenant")
  }
  const response = await fetchImpl(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: "admin", password: credential }),
  })
  if (response.status !== 200) {
    throw new Error(`demo sign-in failed: HTTP ${response.status}`)
  }
  const payload = (await response.json()) as { accessToken?: unknown }
  if (typeof payload.accessToken !== "string" || payload.accessToken.length === 0) {
    throw new Error("demo sign-in returned no accessToken")
  }
  return payload.accessToken
}

async function measureSample(input: {
  baseUrl: string
  token: string
  timeoutMs: number
  planned: PlannedLatencySample
  caseDef: LatencyCase
  fetchImpl: typeof fetch
  now: () => number
}): Promise<LatencySampleRecord> {
  const sessionId = randomUUID()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs)
  const startedAt = new Date().toISOString()
  const start = input.now()
  let httpStatus: number | null = null
  let terminalStatus: string | null = null
  let phases: LatencySampleRecord["phases"] = []
  let error: string | null = null
  try {
    const body: Record<string, unknown> = {
      message: input.caseDef.message,
      stream: false,
      sessionId,
    }
    if (input.caseDef.knowledgeBaseIds !== undefined) {
      body.knowledgeBaseIds = [...input.caseDef.knowledgeBaseIds]
    }
    const response = await input.fetchImpl(`${input.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    httpStatus = response.status
    const text = await response.text()
    if (response.status !== 200) {
      error = `HTTP ${response.status}: ${text.slice(0, 300)}`
    } else {
      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch {
        error = "chat response body is not JSON"
      }
      if (error === null) {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          error = "chat response is not a JSON object"
        } else {
          const result = payload as { status?: unknown; events?: unknown }
          if (typeof result.status !== "string") {
            error = "chat response has no terminal status"
          } else {
            terminalStatus = result.status
            phases = phaseMarks(result.events)
            if (EXECUTION_ERROR_TERMINALS.has(result.status)) {
              error = `terminal status ${result.status}`
            }
          }
        }
      }
    }
  } catch (caught) {
    if (controller.signal.aborted) {
      error = `timeout after ${input.timeoutMs}ms`
    } else {
      error = caught instanceof Error ? caught.message : String(caught)
    }
  } finally {
    clearTimeout(timer)
  }
  return baseSample(input.planned, {
    sessionId,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: input.now() - start,
    httpStatus,
    terminalStatus,
    phases,
    error,
  })
}

function dedupeSample(record: LatencySampleRecord): LatencySampleRecord {
  return {
    ...record,
    phases: record.phases.map((phase) => ({ ...phase })),
  }
}

export async function runLatencySuite(
  options: LatencyRunOptions
): Promise<LatencyRunOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? (() => performance.now())
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const baseUrl = options.baseUrl.replace(/\/+$/, "")

  let dataset: LoadedLatencyDataset
  let token: string
  try {
    dataset = loadLatencyDataset(options.casesPath)
    token =
      options.authToken ??
      (await login(baseUrl, options.password, fetchImpl))
  } catch (error) {
    return {
      exitCode: 2,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const runId = `${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")}-${randomUUID().slice(0, 8)}`
  const runDir = join(resolve(options.runsRoot), runId)
  const samplesDir = join(runDir, "samples")
  const manifest = buildLatencyManifest({
    runId,
    createdAt: new Date().toISOString(),
    dataset,
    models: latencyModelSnapshot(options.env),
    capabilities: latencyCapabilitySnapshot(options.env),
    baseUrl,
    timeoutMs,
  })
  let planned: PlannedLatencySample[]
  try {
    planned = buildLatencyPlan(dataset.cases)
    mkdirSync(samplesDir, { recursive: true })
    const reread = writeJsonAtomic(join(runDir, "manifest.json"), manifest)
    if (JSON.stringify(reread) !== JSON.stringify(manifest)) {
      throw new Error("latency manifest did not read back intact")
    }
  } catch (error) {
    return {
      exitCode: 2,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const byId = new Map(dataset.cases.map((item) => [item.id, item]))
  const execute = async (sample: PlannedLatencySample): Promise<void> => {
    const caseDef = byId.get(sample.caseId)
    if (!caseDef) throw new Error(`planned case ${sample.caseId} is not in the dataset`)
    const record = dedupeSample(
      await measureSample({
        baseUrl,
        token,
        timeoutMs,
        planned: sample,
        caseDef,
        fetchImpl,
        now,
      })
    )
    const path = join(samplesDir, `${sample.sampleId}.json`)
    const reread = writeJsonAtomic(path, record)
    if (JSON.stringify(reread) !== JSON.stringify(record)) {
      throw new Error(`sample ${sample.sampleId} did not read back intact`)
    }
  }

  try {
    for (const sample of planned.filter((item) => item.phase === "warmup")) {
      await execute(sample)
    }
    for (const sample of planned.filter((item) => item.phase === "measured")) {
      await execute(sample)
    }
    const concurrent = planned.filter((item) => item.phase === "concurrent3")
    let cursor = 0
    const workers = Array.from(
      { length: Math.min(CONCURRENT3_SESSIONS, concurrent.length) },
      async () => {
        while (true) {
          const index = cursor
          cursor += 1
          if (index >= concurrent.length) return
          await execute(concurrent[index])
        }
      }
    )
    await Promise.all(workers)
  } catch (error) {
    return {
      exitCode: 2,
      runId,
      runDir,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const records: Record<string, LatencySampleRecord> = {}
  const missing: string[] = []
  const corrupt: string[] = []
  for (const sample of planned) {
    const path = join(samplesDir, `${sample.sampleId}.json`)
    let raw: string
    try {
      raw = readFileSync(path, "utf8")
    } catch {
      missing.push(sample.sampleId)
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      corrupt.push(sample.sampleId)
      continue
    }
    const candidate = parsed as Partial<LatencySampleRecord>
    if (
      candidate.sampleId !== sample.sampleId ||
      candidate.phase !== sample.phase ||
      candidate.caseId !== sample.caseId ||
      candidate.group !== sample.group ||
      candidate.concurrency !== sample.concurrency ||
      typeof candidate.durationMs !== "number" ||
      !Number.isFinite(candidate.durationMs)
    ) {
      corrupt.push(sample.sampleId)
      continue
    }
    records[sample.sampleId] = candidate as LatencySampleRecord
  }

  const report = buildLatencyReport({
    manifest,
    planned,
    records,
    missing,
    corrupt,
  })
  try {
    writeJsonAtomic(join(runDir, "report.json"), report)
    writeJsonAtomic(join(runDir, "summary.json"), report)
  } catch (error) {
    return {
      exitCode: 2,
      runId,
      runDir,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  return {
    exitCode: report.gate.passed ? 0 : 1,
    runId,
    runDir,
    report,
  }
}
