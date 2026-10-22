/**
 * DR-23 / DR-24 — the operator-run latency measurement command.
 *
 * What this owns:
 *   - the fixed demo plan: one complete twenty-case warmup (explicitly
 *     excluded), then five complete twenty-case rounds measured at single
 *     concurrency (100 samples), then a separate concurrent-3 pass;
 *   - the durable ledger: a frozen manifest before the first request, one
 *     atomically written record per planned sample, and a report derived only
 *     from those records;
 *   - nearest-rank p50/p95 over the raw client-side chat durations, with the
 *     grouping rule and denominator published for every group, and an explicit
 *     `p95 <= 30 s` failure threshold for single-concurrency non-FAQ knowledge
 *     answers (a mean is never a substitute);
 *   - per-sample degradation and ordering evidence read from the retained
 *     events, cross-checked against the DR-22 degradation matrix, so a silent
 *     degradation fails instead of disappearing into a green run;
 *   - a fail-closed gate: an unavailable stack, any timeout/execution error or
 *     missing/not-started sample fails the performance run while its original
 *     record and real wait stay in the report;
 *   - separation of FAQ/direct, non-FAQ knowledge answers and other cases,
 *     and of single concurrency vs concurrent-3, each with its own declared
 *     minimum sample count.
 *
 * What this deliberately does not own:
 *   - any judge call. Latency is the wall time from sending POST /api/chat to
 *     receiving the JSON body carrying the terminal done event; judge time
 *     can never enter it because no judge runs here.
 *   - online acceptance. The report always marks the real-provider p95,
 *     degradation and Rerank-on evidence as pending; G-P0 and G-RERANK-LIVE
 *     are decided by the online run, never by this command's local scaffold.
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
export const MIN_CONCURRENT3_NON_FAQ_KNOWLEDGE_SAMPLES = 14
export const P95_TARGET_MS = 30_000
export const DEFAULT_TIMEOUT_MS = 120_000

export const GROUP_RULES: Record<LatencyGroup, string> = {
  faq_direct:
    "the FAQ exact-answer case only (unique standard answer, direct fast path); reported alone so a fast FAQ hit cannot hide knowledge-answer latency",
  non_faq_knowledge:
    "answer cases other than the FAQ exact-answer case; the performance denominator is five measured rounds x fourteen cases = 70",
  other:
    "refusal, empty-scope and memory-only cases; recorded and reported but not used as knowledge-answer latency",
}

interface LatencySampleRule {
  minimumN: number | null
  nRule: string
}

const SINGLE_SAMPLE_RULES: Record<LatencyGroup, LatencySampleRule> = {
  faq_direct: {
    minimumN: 1,
    nRule: "one FAQ exact-answer case per measured round; five rounds give five samples, reported alone",
  },
  non_faq_knowledge: {
    minimumN: MIN_NON_FAQ_KNOWLEDGE_SAMPLES,
    nRule:
      "five measured rounds x fourteen non-FAQ knowledge cases = the fixed denominator 70; " +
      "fewer recorded or usable samples is never a pass",
  },
  other: {
    minimumN: null,
    nRule:
      "refusal, empty-scope and memory-only cases; recorded but never part of the knowledge-answer denominator",
  },
}

const CONCURRENT3_SAMPLE_RULES: Record<LatencyGroup, LatencySampleRule> = {
  faq_direct: {
    minimumN: 1,
    nRule: "one FAQ exact-answer case in the single independent concurrent-3 round",
  },
  non_faq_knowledge: {
    minimumN: MIN_CONCURRENT3_NON_FAQ_KNOWLEDGE_SAMPLES,
    nRule:
      "one independent concurrent-3 round x fourteen non-FAQ knowledge cases = 14; " +
      "this separate n is the declared minimum and is never mixed into the single-concurrency denominator",
  },
  other: {
    minimumN: null,
    nRule:
      "refusal, empty-scope and memory-only cases; recorded separately and never used as knowledge-answer latency",
  },
}

/**
 * DR-22 semantics: these retrieval reasons mean the answer was produced from a
 * degraded read. A missing capability (`reranker_not_configured`,
 * `web_unconfigured`) or an empty scope (`no_knowledge_scope`) is a
 * configuration/scope fact, not an answer degradation.
 */
const DEGRADATION_FAILURE_REASONS = [
  "parent_expansion_unavailable",
  "reranker_unavailable",
] as const

const RERANK_FUSED_REASONS = [
  "not_configured",
  "below_threshold",
  "unavailable",
  "multi_query_aggregation",
] as const

export const PHASE_TIMING_DEFINITION =
  "Chat latency is the monotonic wall time from sending POST /api/chat (stream=false) " +
  "to receiving and parsing the JSON body that carries the terminal done event. " +
  "Phase marks are the run's own event stages (route, retrieval, context, answer, " +
  "validation, done) taken from event.durationMs, which is the run clock accumulated " +
  "since the run started. The report publishes each stage as a delta from the previous " +
  "recorded stage and keeps the raw cumulative mark beside it; a stage with no mark of " +
  "its own is included in the next recorded delta. Phase marks are diagnostic and never " +
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
  corpus: {
    source: string
    path: string
    sha256: string
    caseCount: number
    groups: Record<LatencyGroup, number>
    frozen: true
    rule: string
  }
  stack: {
    startState: "cold" | "warm" | "unspecified"
    declaredBy: "operator"
    warmupExcludesColdStart: true
  }
  warmup: {
    rounds: number
    samples: number
    excluded: true
    rule: string
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
    concurrent3Rounds: number
    concurrent3SamplesPerRound: number
    statisticsSeparate: true
    mixing: "never"
  }
  phaseTiming: {
    definition: string
    stages: string[]
    durationSemantics: "per-stage delta of the run's cumulative clock"
    cumulativeRetained: true
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
    minConcurrent3NonFaqKnowledgeSamples: number
    p95TargetMs: number
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

export interface LatencyOrderingEvidence {
  source: string
  reason?: string
}

export interface LatencyDegradationEvidence {
  status: string | null
  reason: string | null
  unavailableChannels: string[]
}

/** Per-sample DR-22 evidence read from the retained Chat events. */
export interface LatencySampleEvidence {
  retrievalObserved: boolean
  degradedReasons: string[]
  ordering: LatencyOrderingEvidence | null
  orderingSeen: boolean
  rerankModel: string | null
  degradation: LatencyDegradationEvidence | null
}

export interface LatencyPhaseMark {
  stage: string
  status: string | null
  /** Raw event.durationMs: the run clock accumulated at this mark. */
  cumulativeMs: number
  /** Delta from the previous recorded stage mark. */
  durationMs: number
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
  phases: LatencyPhaseMark[]
  evidence: LatencySampleEvidence
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
  stackStart?: "cold" | "warm" | "unspecified"
}): LatencyManifest {
  const groups: Record<LatencyGroup, number> = { faq_direct: 0, non_faq_knowledge: 0, other: 0 }
  for (const item of input.dataset.cases) groups[item.group] += 1
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
    corpus: {
      source: "fixed demo dataset",
      path: input.dataset.path,
      sha256: input.dataset.sha256,
      caseCount: input.dataset.cases.length,
      groups,
      frozen: true,
      rule:
        "the same twenty cases run in every round; slow cases are never removed and " +
        "the denominator never changes after the manifest is frozen",
    },
    stack: {
      startState: input.stackStart ?? "unspecified",
      declaredBy: "operator",
      warmupExcludesColdStart: true,
    },
    warmup: {
      rounds: WARMUP_ROUNDS,
      samples: WARMUP_SAMPLES,
      excluded: true,
      rule:
        "one complete twenty-case warmup round is executed and recorded but excluded " +
        "from every latency statistic",
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
      concurrent3Rounds: CONCURRENT3_ROUNDS,
      concurrent3SamplesPerRound: CASES_PER_ROUND,
      statisticsSeparate: true,
      mixing: "never",
    },
    phaseTiming: {
      definition: PHASE_TIMING_DEFINITION,
      stages: [...PHASE_STAGES],
      durationSemantics: "per-stage delta of the run's cumulative clock",
      cumulativeRetained: true,
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
      minConcurrent3NonFaqKnowledgeSamples: MIN_CONCURRENT3_NON_FAQ_KNOWLEDGE_SAMPLES,
      p95TargetMs: P95_TARGET_MS,
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
  minimumN: number | null
  nRule: string
  nSufficient: boolean
  p50Ms: number | null
  p95Ms: number | null
  rawDurationsMs: number[]
  sampleIds: string[]
}

export interface LatencyGateReason {
  kind:
    | "not_started"
    | "corrupt"
    | "execution_error"
    | "insufficient_n"
    | "incomplete_phase"
    | "stack_unavailable"
    | "p95_over_target"
    | "silent_degradation"
    | "rerank_degraded"
    | "ordering_malformed"
    | "provider_failure_mislabelled"
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

export interface LatencyDenominator {
  planned: number
  minimum: number | null
  rule: string
  mixedWithSingle: false
}

export interface LatencyRerankCapability {
  status: "not_configured" | "not_exercised" | "exercised" | "degraded" | "invalid"
  configured: boolean
  countedAsPass: false
  dedicatedSamples: number
  degradedSamples: number
  model: {
    configured: string | null
    observed: string[]
    matches: boolean
  }
  detail: string
}

export interface LatencyEvidenceSummary {
  measuredSamples: number
  measuredSamplesWithRetrieval: number
  orderingSeen: number
  degradedReasons: string[]
  degradedSampleIds: string[]
  silentDegradationSampleIds: string[]
  malformedOrderingSampleIds: string[]
  mislabelledProviderFailureSampleIds: string[]
}

export interface LatencyReport {
  schema: typeof REPORT_SCHEMA
  ticket: "DR-23"
  runId: string
  generatedAt: string
  judge: LatencyManifest["judge"]
  phaseTiming: LatencyManifest["phaseTiming"]
  plan: LatencyManifest["plan"]
  corpus: LatencyManifest["corpus"]
  stack: LatencyManifest["stack"]
  warmup: LatencyManifest["warmup"]
  models: LatencyManifest["models"]
  concurrency: LatencyManifest["concurrency"]
  configuration: LatencyManifest["configuration"]
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
  denominators: {
    single: Record<LatencyGroup, LatencyDenominator>
    concurrent3: Record<LatencyGroup, LatencyDenominator>
  }
  targets: {
    p95: {
      ticket: "DR-24-AC03"
      metric: "nearest-rank p95"
      thresholdMs: number
      scope: string
      meanIsNotASubstitute: true
      measuredP95Ms: number | null
      withinTarget: boolean | null
    }
    degradation: {
      ticket: "DR-24-AC04"
      failureReasons: string[]
      silentDegradationFails: true
    }
  }
  evidence: LatencyEvidenceSummary
  capabilities: { rerank: LatencyRerankCapability }
  acceptance: {
    localGate: "passed" | "failed" | "incomplete"
    online: {
      status: "pending"
      p95: "pending"
      degradation: "pending"
      rerank: "pending"
      reason: string
    }
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
    p95TargetMs: number
    p95TargetScope: string
    p95TargetEvaluatedBy: "DR-24 online"
    pendingOnline: string[]
    failClosed: string[]
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
  const rule = (phase === "measured" ? SINGLE_SAMPLE_RULES : CONCURRENT3_SAMPLE_RULES)[group]
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
    minimumN: rule.minimumN,
    nRule: rule.nRule,
    nSufficient: rule.minimumN === null || durations.length >= rule.minimumN,
    p50Ms: nearestRankPercentile(durations, 50),
    p95Ms: nearestRankPercentile(durations, 95),
    rawDurationsMs: durations,
    sampleIds: observed.map((record) => record.sampleId),
  }
}

function denominatorsFor(
  groups: Record<LatencyGroup, LatencyGroupStats>,
  phase: "measured" | "concurrent3"
): Record<LatencyGroup, LatencyDenominator> {
  const rules = phase === "measured" ? SINGLE_SAMPLE_RULES : CONCURRENT3_SAMPLE_RULES
  const value = <G extends LatencyGroup>(group: G): LatencyDenominator => ({
    planned: groups[group].denominator,
    minimum: rules[group].minimumN,
    rule: rules[group].nRule,
    mixedWithSingle: false,
  })
  return {
    faq_direct: value("faq_direct"),
    non_faq_knowledge: value("non_faq_knowledge"),
    other: value("other"),
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

function isDegradationFailure(reason: string): boolean {
  return (
    (DEGRADATION_FAILURE_REASONS as readonly string[]).includes(reason) ||
    reason.endsWith(" unavailable")
  )
}

function retrievalDegraded(evidence: LatencySampleEvidence): boolean {
  return (
    evidence.degradedReasons.some(isDegradationFailure) ||
    evidence.ordering?.reason === "unavailable"
  )
}

/** Mirrors the DR-22 matrix: only these source/reason pairs are recognized. */
function orderingMalformed(evidence: LatencySampleEvidence): boolean {
  if (!evidence.orderingSeen) return false
  const ordering = evidence.ordering
  if (!ordering) return true
  if (ordering.source === "dedicated_rerank" && ordering.reason === undefined) return false
  return (
    ordering.source === "fused" &&
    (RERANK_FUSED_REASONS as readonly string[]).includes(ordering.reason ?? "")
  )
    ? false
    : true
}

interface DegradationCrossCheck {
  evidence: LatencyEvidenceSummary
  silentSampleIds: string[]
  malformedSampleIds: string[]
  mislabelledSampleIds: string[]
  degradedSampleIds: string[]
}

function crossCheckDegradation(
  planned: readonly PlannedLatencySample[],
  records: Record<string, LatencySampleRecord>
): DegradationCrossCheck {
  const silent: string[] = []
  const malformed: string[] = []
  const mislabelled: string[] = []
  const degraded: string[] = []
  const failedReasons = new Set<string>()
  const measured = planned.filter((sample) => sample.phase === "measured")
  let measuredWithRetrieval = 0
  let orderingSeen = 0
  for (const sample of planned) {
    const record = records[sample.sampleId]
    if (!record) continue
    const evidence = record.evidence
    for (const reason of evidence.degradedReasons) failedReasons.add(reason)
    if (orderingMalformed(evidence)) malformed.push(record.sampleId)
    if (evidence.degradedReasons.some(isDegradationFailure) || evidence.ordering?.reason === "unavailable") {
      degraded.push(record.sampleId)
    }
    if (record.terminalStatus === "completed") {
      if (
        retrievalDegraded(evidence) &&
        evidence.degradation?.status !== "partial"
      ) {
        silent.push(record.sampleId)
      } else if (
        evidence.ordering?.source === "dedicated_rerank" &&
        evidence.degradedReasons.some(isDegradationFailure)
      ) {
        silent.push(record.sampleId)
      }
    }
    if (record.terminalStatus === "provider_error" && evidence.degradation?.reason === "no_cited_claims") {
      mislabelled.push(record.sampleId)
    }
  }
  const measuredRecords = measured
    .map((sample) => records[sample.sampleId])
    .filter((record): record is LatencySampleRecord => record !== undefined)
  for (const record of measuredRecords) {
    if (record.evidence.retrievalObserved) measuredWithRetrieval += 1
    if (record.evidence.orderingSeen) orderingSeen += 1
  }
  return {
    evidence: {
      measuredSamples: measuredRecords.length,
      measuredSamplesWithRetrieval: measuredWithRetrieval,
      orderingSeen,
      degradedReasons: [...failedReasons].sort(),
      degradedSampleIds: [...new Set(degraded)].sort(),
      silentDegradationSampleIds: [...new Set(silent)].sort(),
      malformedOrderingSampleIds: [...new Set(malformed)].sort(),
      mislabelledProviderFailureSampleIds: [...new Set(mislabelled)].sort(),
    },
    silentSampleIds: [...new Set(silent)].sort(),
    malformedSampleIds: [...new Set(malformed)].sort(),
    mislabelledSampleIds: [...new Set(mislabelled)].sort(),
    degradedSampleIds: [...new Set(degraded)].sort(),
  }
}

function rerankCapability(
  manifest: LatencyManifest,
  planned: readonly PlannedLatencySample[],
  records: Record<string, LatencySampleRecord>
): LatencyRerankCapability {
  const measured = planned
    .filter((sample) => sample.phase === "measured")
    .map((sample) => records[sample.sampleId])
    .filter((record): record is LatencySampleRecord => record !== undefined)
  const configuredModel = manifest.models.rerank
  const configured =
    manifest.capabilities.rerank?.configured === true || Boolean(configuredModel)
  const dedicated = measured.filter(
    (record) => record.evidence.ordering?.source === "dedicated_rerank"
  )
  const degraded = measured.filter((record) => retrievalDegraded(record.evidence))
  const malformed = measured.filter((record) => orderingMalformed(record.evidence))
  const observedModels = [
    ...new Set(
      measured
        .map((record) => record.evidence.rerankModel)
        .filter((model): model is string => typeof model === "string" && model.length > 0)
    ),
  ].sort()
  const matches =
    observedModels.length > 0 &&
    (configuredModel === null ||
      (observedModels.length === 1 && observedModels[0] === configuredModel))
  let status: LatencyRerankCapability["status"]
  if (malformed.length > 0) status = "invalid"
  else if (degraded.length > 0) status = "degraded"
  else if (dedicated.length > 0) status = "exercised"
  else if (configured) status = "not_exercised"
  else status = "not_configured"
  const detail: Record<LatencyRerankCapability["status"], string> = {
    not_configured:
      "no rerank provider is configured; the capability is reported as absent and is not counted as coverage",
    not_exercised:
      "a rerank provider is configured but no measured sample proves a dedicated rerank call; configured presence is not coverage",
    exercised:
      "measured samples published dedicated_rerank ordering; online Rerank-on acceptance still belongs to the online run",
    degraded:
      "a measured sample published a fused/unavailable ranking or reranker_unavailable; Rerank-on evidence is not clean",
    invalid:
      "a measured sample carried malformed final-ordering evidence; no rerank claim is made",
  }
  return {
    status,
    configured,
    countedAsPass: false,
    dedicatedSamples: dedicated.length,
    degradedSamples: degraded.length,
    model: { configured: configuredModel, observed: observedModels, matches },
    detail: detail[status],
  }
}

export function buildLatencyReport(input: {
  manifest: LatencyManifest
  planned: readonly PlannedLatencySample[]
  records: Record<string, LatencySampleRecord>
  missing?: readonly string[]
  corrupt?: readonly string[]
  generatedAt?: string
  runError?: string
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
  if (input.runError !== undefined) {
    reasons.push({ kind: "stack_unavailable", detail: input.runError })
  }
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
  const c3NonFaq = groups.concurrent3.non_faq_knowledge
  if (
    c3NonFaq.denominator < MIN_CONCURRENT3_NON_FAQ_KNOWLEDGE_SAMPLES ||
    c3NonFaq.n < MIN_CONCURRENT3_NON_FAQ_KNOWLEDGE_SAMPLES
  ) {
    reasons.push({
      kind: "insufficient_n",
      detail:
        `concurrent-3 non-FAQ knowledge samples ${c3NonFaq.n}/${MIN_CONCURRENT3_NON_FAQ_KNOWLEDGE_SAMPLES} ` +
        "(the separate concurrent-3 denominator is declared and is never a pass when short)",
    })
  }
  if (groups.single.faq_direct.recorded === 0) {
    reasons.push({
      kind: "insufficient_n",
      detail: "FAQ/direct group has no recorded sample and is not a pass",
    })
  }

  const p95 = nonFaq.p95Ms
  const withinTarget = p95 === null ? null : p95 <= P95_TARGET_MS
  if (withinTarget === false) {
    reasons.push({
      kind: "p95_over_target",
      detail:
        `single-concurrency non-FAQ knowledge p95 ${p95} ms > ${P95_TARGET_MS} ms ` +
        "(nearest-rank p95 over the raw durations; the mean is not a substitute)",
    })
  }

  const crossCheck = crossCheckDegradation(planned, records)
  for (const sampleId of crossCheck.silentSampleIds) {
    reasons.push({
      kind: "silent_degradation",
      sampleId,
      detail:
        "a completed answer reported none/partial-inconsistent degradation while its " +
        "retrieval evidence recorded a failure reason",
    })
  }
  for (const sampleId of crossCheck.mislabelledSampleIds) {
    reasons.push({
      kind: "provider_failure_mislabelled",
      sampleId,
      detail: "a failure terminal is labelled no_cited_claims",
    })
  }
  for (const sampleId of crossCheck.malformedSampleIds) {
    reasons.push({
      kind: "ordering_malformed",
      sampleId,
      detail: "final ordering evidence is not a recognized source/reason pair",
    })
  }
  for (const sampleId of crossCheck.degradedSampleIds) {
    reasons.push({
      kind: "rerank_degraded",
      sampleId,
      detail:
        "the retrieval evidence reports reranker_unavailable or a fused/unavailable " +
        "ranking; a clean Rerank-on run never contains it",
    })
  }

  const incomplete = reasons.some(
    (reason) =>
      reason.kind === "not_started" ||
      reason.kind === "corrupt" ||
      reason.kind === "stack_unavailable"
  )
  const passed = reasons.length === 0
  const status = passed ? "passed" : incomplete ? "incomplete" : "failed"
  const p95Scope = "single-concurrency non-FAQ knowledge answers only"
  return {
    schema: REPORT_SCHEMA,
    ticket: "DR-23",
    runId: input.manifest.runId,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    judge: { ...input.manifest.judge },
    phaseTiming: { ...input.manifest.phaseTiming },
    plan: { ...input.manifest.plan },
    corpus: { ...input.manifest.corpus, groups: { ...input.manifest.corpus.groups } },
    stack: { ...input.manifest.stack },
    warmup: { ...input.manifest.warmup },
    models: { ...input.manifest.models },
    concurrency: { ...input.manifest.concurrency },
    configuration: { ...input.manifest.configuration },
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
    denominators: {
      single: denominatorsFor(groups.single, "measured"),
      concurrent3: denominatorsFor(groups.concurrent3, "concurrent3"),
    },
    targets: {
      p95: {
        ticket: "DR-24-AC03",
        metric: "nearest-rank p95",
        thresholdMs: P95_TARGET_MS,
        scope: p95Scope,
        meanIsNotASubstitute: true,
        measuredP95Ms: p95,
        withinTarget,
      },
      degradation: {
        ticket: "DR-24-AC04",
        failureReasons: [...DEGRADATION_FAILURE_REASONS],
        silentDegradationFails: true,
      },
    },
    evidence: crossCheck.evidence,
    capabilities: { rerank: rerankCapability(input.manifest, planned, records) },
    acceptance: {
      localGate: status,
      online: {
        status: "pending",
        p95: "pending",
        degradation: "pending",
        rerank: "pending",
        reason:
          "the real provider/model/rerank stack evidence is decided by the online run " +
          "(G-P0, G-RERANK-LIVE); this command's local gate never substitutes for it",
      },
    },
    samples: planned
      .map((sample) => records[sample.sampleId])
      .filter((record): record is LatencySampleRecord => record !== undefined),
    missing,
    corrupt,
    gate: { passed, status, reasons },
    limits: {
      scope:
        "Fixed demo dataset and configuration at the recorded concurrency only; " +
        "single-concurrency and concurrent-3 are reported separately and never " +
        "mixed. This is not a production SLO.",
      productionSlo: false,
      p95TargetMs: P95_TARGET_MS,
      p95TargetScope: p95Scope,
      p95TargetEvaluatedBy: "DR-24 online",
      pendingOnline: [
        "real provider p95 measured under the frozen online configuration",
        "real Rerank-on provider call, dedicated ordering and model snapshot",
        "real degradation matrix cross-check of the online run",
      ],
      failClosed: [
        "an unavailable stack writes a failed report instead of a bare error",
        "any timeout or execution error fails the run and keeps its real wait",
        "any missing or corrupt planned sample is incomplete, never a pass",
        "a p95 over 30 s for single-concurrency non-FAQ knowledge fails explicitly",
        "a silent degradation or a fused/unavailable ranking fails the run",
      ],
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
  /** Operator's declaration of whether the stack was already serving. */
  stackStart?: "cold" | "warm" | "unspecified"
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
    evidence: LatencySampleEvidence
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
    evidence: input.evidence,
    error: input.error,
    writtenAt: new Date().toISOString(),
  }
}

/**
 * A sample's per-stage durations. `event.durationMs` is the run clock
 * accumulated at that stage, so the report divides it into deltas here instead
 * of presenting a cumulative value as a stage cost. The cumulative mark is
 * kept beside each delta so the numbers stay recomputable.
 */
export function phaseMarks(events: unknown): LatencyPhaseMark[] {
  if (!Array.isArray(events)) return []
  const latest = new Map<
    string,
    { stage: string; status: string | null; cumulativeMs: number }
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
        cumulativeMs: event.durationMs,
      })
    }
  }
  const marks: LatencyPhaseMark[] = []
  let previous = 0
  for (const stage of PHASE_STAGES) {
    const mark = latest.get(stage)
    if (!mark) continue
    marks.push({
      stage: mark.stage,
      status: mark.status,
      cumulativeMs: mark.cumulativeMs,
      durationMs: Math.max(0, mark.cumulativeMs - previous),
    })
    previous = Math.max(previous, mark.cumulativeMs)
  }
  return marks
}

function orderingEvidence(value: unknown): LatencyOrderingEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const candidate = value as { source?: unknown; reason?: unknown }
  if (typeof candidate.source !== "string") return null
  return {
    source: candidate.source,
    ...(typeof candidate.reason === "string" ? { reason: candidate.reason } : {}),
  }
}

/**
 * Read one sample's degradation/ordering evidence from the retained Chat
 * events — the same fields the DR-22 degradation matrix uses. Answer text is
 * never read: a reply that mentions rerank cannot prove the provider ran.
 */
function sampleEvidence(events: unknown): LatencySampleEvidence {
  const evidence: LatencySampleEvidence = {
    retrievalObserved: false,
    degradedReasons: [],
    ordering: null,
    orderingSeen: false,
    rerankModel: null,
    degradation: null,
  }
  if (!Array.isArray(events)) return evidence
  for (const candidate of events) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue
    const event = candidate as {
      type?: unknown
      stage?: unknown
      data?: unknown
      result?: unknown
    }
    if (event.type === "progress" && event.stage === "retrieval") {
      const data = event.data
      if (!data || typeof data !== "object" || Array.isArray(data)) continue
      const trace = data as { degradedReasons?: unknown; finalContextOrdering?: unknown }
      if (Array.isArray(trace.degradedReasons)) {
        for (const reason of trace.degradedReasons) {
          if (
            typeof reason === "string" &&
            !evidence.degradedReasons.includes(reason)
          ) {
            evidence.degradedReasons.push(reason)
          }
        }
      }
      if ("finalContextOrdering" in trace) {
        evidence.orderingSeen = true
        evidence.ordering = orderingEvidence(trace.finalContextOrdering)
      }
      evidence.retrievalObserved = true
    } else if (event.type === "done") {
      const result = event.result
      if (!result || typeof result !== "object" || Array.isArray(result)) continue
      const done = result as { degradation?: unknown; modelProfile?: unknown }
      const degradation = done.degradation
      if (degradation && typeof degradation === "object" && !Array.isArray(degradation)) {
        const state = degradation as {
          status?: unknown
          reason?: unknown
          unavailableChannels?: unknown
        }
        evidence.degradation = {
          status: typeof state.status === "string" ? state.status : null,
          reason: typeof state.reason === "string" ? state.reason : null,
          unavailableChannels: Array.isArray(state.unavailableChannels)
            ? state.unavailableChannels.filter(
                (channel): channel is string => typeof channel === "string"
              )
            : [],
        }
      }
      const profile = done.modelProfile
      if (profile && typeof profile === "object" && !Array.isArray(profile)) {
        const rerank = (profile as { rerankModel?: unknown }).rerankModel
        if (typeof rerank === "string" && rerank.trim().length > 0) {
          evidence.rerankModel = rerank.trim()
        }
      }
    }
  }
  return evidence
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
  let evidence: LatencySampleEvidence = sampleEvidence(undefined)
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
            evidence = sampleEvidence(result.events)
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
    evidence,
    error,
  })
}

function dedupeSample(record: LatencySampleRecord): LatencySampleRecord {
  return {
    ...record,
    phases: record.phases.map((phase) => ({ ...phase })),
    evidence: {
      ...record.evidence,
      degradedReasons: [...record.evidence.degradedReasons],
      ordering: record.evidence.ordering ? { ...record.evidence.ordering } : null,
      degradation: record.evidence.degradation
        ? {
            ...record.evidence.degradation,
            unavailableChannels: [...record.evidence.degradation.unavailableChannels],
          }
        : null,
    },
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
  try {
    dataset = loadLatencyDataset(options.casesPath)
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
    ...(options.stackStart ? { stackStart: options.stackStart } : {}),
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

  // DR-24 AC05: an unavailable stack still leaves a fail-closed report behind,
  // instead of only a bare error with no measured/unmeasured accounting.
  let token: string
  try {
    token =
      options.authToken ??
      (await login(baseUrl, options.password, fetchImpl))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const report = buildLatencyReport({
      manifest,
      planned,
      records: {},
      missing: planned.map((sample) => sample.sampleId),
      runError: `stack unavailable: ${message}`,
    })
    try {
      writeJsonAtomic(join(runDir, "report.json"), report)
      writeJsonAtomic(join(runDir, "summary.json"), report)
    } catch {
      return { exitCode: 2, runId, runDir, error: message }
    }
    return { exitCode: 1, runId, runDir, report, error: message }
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
