/**
 * DR-23 — the latency measurement command.
 *
 * The command must schedule the fixed demo plan (20 warmup + 5 x 20 measured +
 * a separate concurrent-3 pass), record every planned sample, derive
 * nearest-rank p50/p95 from the raw client-side durations, and fail on any
 * timeout/execution error or missing sample. Judge time is never part of chat
 * latency because this command never runs a judge.
 *
 * The HTTP tests use a controlled local Express app on `app.listen(0)` with an
 * in-memory SQLite database; they prove scheduling and counting, not real
 * provider performance.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { AddressInfo } from "node:net"
import type { RequestHandler } from "express"

import { openDb } from "../ingestion/tracking/db"
import { createApp } from "../api/server"
import type { AnswerRunOptions } from "../answer/generation"
import { createMastraChatEventAdapter } from "../mastra/chat_event_adapter"
import type { AccessContext } from "../access/context"
import type { RetrievalScope } from "../types/retrieval_scope"
import {
  CASES_PER_ROUND,
  CONCURRENT3_SAMPLES,
  GROUP_RULES,
  MEASURED_ROUNDS,
  MEASURED_SAMPLE_COUNT,
  MIN_NON_FAQ_KNOWLEDGE_SAMPLES,
  WARMUP_ROUNDS,
  buildLatencyManifest,
  buildLatencyPlan,
  buildLatencyReport,
  classifyLatencyCase,
  loadLatencyDataset,
  nearestRankPercentile,
  runLatencySuite,
  type LatencySampleRecord,
  type PlannedLatencySample,
} from "./latency_sampling"

const GOLDEN = resolve(__dirname, "..", "..", "golden", "demo-release-cases.v2.json")

function recordFor(
  planned: PlannedLatencySample,
  durationMs: number,
  overrides: Partial<LatencySampleRecord> = {}
): LatencySampleRecord {
  return {
    schema: "latency-measurement-sample",
    ticket: "DR-23",
    sampleId: planned.sampleId,
    phase: planned.phase,
    round: planned.round,
    caseId: planned.caseId,
    group: planned.group,
    concurrency: planned.concurrency,
    sessionId: `session-${planned.sampleId}`,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:00.100Z",
    durationMs,
    httpStatus: 200,
    terminalStatus: "completed",
    phases: [],
    error: null,
    writtenAt: "2026-01-01T00:00:00.100Z",
    ...overrides,
  }
}

function completeRecords(
  planned: PlannedLatencySample[],
  duration: (sample: PlannedLatencySample) => number
): Record<string, LatencySampleRecord> {
  const records: Record<string, LatencySampleRecord> = {}
  for (const sample of planned) records[sample.sampleId] = recordFor(sample, duration(sample))
  return records
}

// ---------------------------------------------------------------------------
// nearest-rank percentile (independent literal expectations)
// ---------------------------------------------------------------------------

test("nearest-rank p50/p95 use ceil(percentile * n) and the raw sorted sample", () => {
  assert.equal(nearestRankPercentile([10, 20, 30, 40], 50), 20)
  assert.equal(nearestRankPercentile([10, 20, 30, 40], 95), 40)
  assert.equal(nearestRankPercentile([5], 50), 5)
  assert.equal(nearestRankPercentile(Array.from({ length: 100 }, (_, i) => i + 1), 50), 50)
  assert.equal(nearestRankPercentile(Array.from({ length: 100 }, (_, i) => i + 1), 95), 95)
  assert.equal(nearestRankPercentile([40, 10, 30, 20], 100), 40)
  assert.equal(nearestRankPercentile([], 95), null)
})

test("nearest-rank never interpolates or drops the slowest recorded sample", () => {
  const values = [10, 10, 10, 10, 5000]
  assert.equal(nearestRankPercentile(values, 50), 10)
  assert.equal(nearestRankPercentile(values, 95), 5000)
})

// ---------------------------------------------------------------------------
// fixed dataset, grouping and plan
// ---------------------------------------------------------------------------

test("the fixed demo dataset produces FAQ/direct, non-FAQ knowledge and other groups", () => {
  const dataset = loadLatencyDataset(GOLDEN)
  assert.equal(dataset.cases.length, CASES_PER_ROUND)
  const counts = { faq_direct: 0, non_faq_knowledge: 0, other: 0 }
  for (const item of dataset.cases) counts[item.group] += 1
  assert.deepEqual(counts, { faq_direct: 1, non_faq_knowledge: 14, other: 5 })
  assert.equal(classifyLatencyCase("hard-04-faq-exact-answer", "answer"), "faq_direct")
  assert.equal(classifyLatencyCase("case-07-arch-channels", "answer"), "non_faq_knowledge")
  assert.equal(classifyLatencyCase("hard-01-isolation-policy-blocked", "refuse"), "other")
  assert.equal(classifyLatencyCase("hard-06-memory-never-cited", "memory-not-cited"), "other")
})

test("the fixed plan is 20 warmup, 100 measured and 20 separate concurrent-3 samples", () => {
  const plan = buildLatencyPlan(loadLatencyDataset(GOLDEN).cases)
  const byPhase = (phase: PlannedLatencySample["phase"]) =>
    plan.filter((sample) => sample.phase === phase)
  assert.equal(WARMUP_ROUNDS, 1)
  assert.equal(MEASURED_ROUNDS, 5)
  assert.equal(byPhase("warmup").length, 20)
  assert.equal(byPhase("measured").length, MEASURED_SAMPLE_COUNT)
  assert.equal(byPhase("measured").length, 100)
  assert.equal(byPhase("concurrent3").length, CONCURRENT3_SAMPLES)
  assert.equal(byPhase("concurrent3").length, 20)
  for (const sample of byPhase("warmup")) assert.equal(sample.concurrency, 1)
  for (const sample of byPhase("measured")) assert.equal(sample.concurrency, 1)
  for (const sample of byPhase("concurrent3")) assert.equal(sample.concurrency, 3)
  const nonFaqMeasured = byPhase("measured").filter(
    (sample) => sample.group === "non_faq_knowledge"
  )
  assert.equal(nonFaqMeasured.length, 70)
  assert.equal(MIN_NON_FAQ_KNOWLEDGE_SAMPLES, 70)
  // Every sample id is unique and every case appears once per round.
  assert.equal(new Set(plan.map((sample) => sample.sampleId)).size, plan.length)
  for (let round = 1; round <= MEASURED_ROUNDS; round += 1) {
    assert.equal(
      byPhase("measured").filter((sample) => sample.round === round).length,
      CASES_PER_ROUND
    )
  }
})

// ---------------------------------------------------------------------------
// report derivation, denominators and gate
// ---------------------------------------------------------------------------

function manifestFor(dataset: ReturnType<typeof loadLatencyDataset>) {
  return buildLatencyManifest({
    runId: "test-run",
    createdAt: "2026-01-01T00:00:00.000Z",
    dataset,
    models: { chat: "test-chat", embedding: "test-embedding", rerank: null, decision: "chat" },
    capabilities: { chat: "http-json", rerank: null },
    baseUrl: "http://localhost:3000",
    timeoutMs: 30_000,
  })
}

test("a complete plan reports public denominators and recomputable nearest-rank p50/p95", () => {
  const dataset = loadLatencyDataset(GOLDEN)
  const plan = buildLatencyPlan(dataset.cases)
  // Literal durations make the expected percentile values independent of the code.
  const records = completeRecords(plan, (sample) => {
    if (sample.phase === "warmup") return 999
    if (sample.phase === "concurrent3") return sample.group === "faq_direct" ? 40 : 50
    if (sample.group === "faq_direct") return 200
    if (sample.group === "non_faq_knowledge") return 100
    return 300
  })
  const manifest = manifestFor(dataset)
  assert.equal(manifest.plan.sampleIds.length, 140)
  assert.equal(manifest.plan.sampleIds.filter((id) => id.startsWith("warmup-")).length, 20)
  assert.equal(manifest.plan.sampleIds.filter((id) => id.startsWith("measured-")).length, 100)
  assert.equal(manifest.plan.sampleIds.filter((id) => id.startsWith("concurrent3-")).length, 20)
  assert.equal(manifest.judge.invoked, false)
  assert.equal(manifest.phaseTiming.judgeExcluded, true)
  const report = buildLatencyReport({ manifest, planned: plan, records })
  assert.equal(report.counts.planned, 140)
  assert.equal(report.counts.recorded, 140)
  assert.equal(report.counts.warmup.recorded, 20)
  assert.equal(report.counts.measured.recorded, 100)
  assert.equal(report.counts.concurrent3.recorded, 20)
  assert.equal(report.gate.passed, true)
  assert.equal(report.gate.status, "passed")
  assert.equal(report.judge.invoked, false)
  assert.equal(report.judge.excludedFromLatency, true)

  for (const group of ["faq_direct", "non_faq_knowledge", "other"] as const) {
    assert.equal(report.groups.single[group].rule, GROUP_RULES[group])
    assert.equal(report.groups.single[group].concurrency, 1)
    assert.equal(report.groups.concurrent3[group].concurrency, 3)
  }
  assert.equal(report.groups.single.non_faq_knowledge.denominator, 70)
  assert.equal(report.groups.single.non_faq_knowledge.recorded, 70)
  assert.equal(report.groups.single.non_faq_knowledge.n, 70)
  assert.equal(report.groups.single.non_faq_knowledge.p50Ms, 100)
  assert.equal(report.groups.single.non_faq_knowledge.p95Ms, 100)
  assert.equal(report.groups.single.non_faq_knowledge.rawDurationsMs.length, 70)
  assert.equal(report.groups.single.faq_direct.denominator, 5)
  assert.equal(report.groups.single.faq_direct.p50Ms, 200)
  assert.equal(report.groups.single.faq_direct.p95Ms, 200)
  assert.equal(report.groups.single.other.denominator, 25)
  assert.equal(report.groups.single.other.p95Ms, 300)
  assert.equal(report.groups.concurrent3.non_faq_knowledge.denominator, 14)
  assert.equal(report.groups.concurrent3.non_faq_knowledge.p95Ms, 50)
  assert.equal(report.groups.concurrent3.faq_direct.p95Ms, 40)
  // Concurrency-3 is never mixed into the single-concurrency denominator.
  assert.equal(
    report.groups.single.faq_direct.denominator +
      report.groups.single.non_faq_knowledge.denominator +
      report.groups.single.other.denominator,
    100
  )
  assert.equal(
    report.groups.concurrent3.faq_direct.denominator +
      report.groups.concurrent3.non_faq_knowledge.denominator +
      report.groups.concurrent3.other.denominator,
    20
  )
  assert.equal(report.groups.single.non_faq_knowledge.p95Ms, 100)
  assert.equal(report.samples.length, 140)
  assert.match(report.phaseTiming.definition, /terminal/i)
})

test("a missing measured sample is never a pass and keeps the insufficient denominator visible", () => {
  const dataset = loadLatencyDataset(GOLDEN)
  const plan = buildLatencyPlan(dataset.cases)
  const records = completeRecords(plan, () => 100)
  const missingSample = plan.find(
    (sample) => sample.phase === "measured" && sample.group === "non_faq_knowledge"
  )!
  delete records[missingSample.sampleId]
  const report = buildLatencyReport({
    manifest: manifestFor(dataset),
    planned: plan,
    records,
    missing: [missingSample.sampleId],
  })
  assert.equal(report.gate.passed, false)
  assert.equal(report.gate.status, "incomplete")
  assert.equal(report.counts.measured.recorded, 99)
  assert.equal(report.groups.single.non_faq_knowledge.denominator, 70)
  assert.equal(report.groups.single.non_faq_knowledge.recorded, 69)
  assert.equal(report.groups.single.non_faq_knowledge.n, 69)
  assert.ok(
    report.gate.reasons.some(
      (reason) => reason.kind === "not_started" && reason.sampleId === missingSample.sampleId
    )
  )
  assert.ok(report.gate.reasons.some((reason) => reason.kind === "insufficient_n"))
})

test("a timeout or execution error fails the run but keeps its real wait in the raw durations", () => {
  const dataset = loadLatencyDataset(GOLDEN)
  const plan = buildLatencyPlan(dataset.cases)
  const records = completeRecords(plan, () => 100)
  const failedSample = plan.find(
    (sample) => sample.phase === "measured" && sample.group === "non_faq_knowledge"
  )!
  records[failedSample.sampleId] = recordFor(failedSample, 25_000, {
    httpStatus: null,
    terminalStatus: null,
    error: "timeout after 25000ms",
  })
  const report = buildLatencyReport({ manifest: manifestFor(dataset), planned: plan, records })
  assert.equal(report.gate.passed, false)
  assert.equal(report.gate.status, "failed")
  assert.ok(
    report.gate.reasons.some(
      (reason) => reason.kind === "execution_error" && reason.sampleId === failedSample.sampleId
    )
  )
  const stored = report.samples.find((sample) => sample.sampleId === failedSample.sampleId)!
  assert.equal(stored.durationMs, 25_000)
  assert.equal(stored.error, "timeout after 25000ms")
  // The failed wait stays in the group's numerator/denominator, not only in
  // the successful fast samples.
  assert.equal(report.groups.single.non_faq_knowledge.recorded, 70)
  assert.equal(report.groups.single.non_faq_knowledge.n, 70)
  assert.ok(report.groups.single.non_faq_knowledge.rawDurationsMs.includes(25_000))
  assert.equal(report.groups.single.non_faq_knowledge.errors, 1)
})

test("a provider_error terminal is an execution error even when HTTP is 200", () => {
  const dataset = loadLatencyDataset(GOLDEN)
  const plan = buildLatencyPlan(dataset.cases)
  const records = completeRecords(plan, () => 100)
  const failedSample = plan.find((sample) => sample.phase === "measured")!
  records[failedSample.sampleId] = recordFor(failedSample, 12, {
    terminalStatus: "provider_error",
    error: "terminal status provider_error",
  })
  const report = buildLatencyReport({ manifest: manifestFor(dataset), planned: plan, records })
  assert.equal(report.gate.passed, false)
  assert.equal(
    report.gate.reasons.some(
      (reason) => reason.kind === "execution_error" && reason.sampleId === failedSample.sampleId
    ),
    true
  )
})

// ---------------------------------------------------------------------------
// controlled real HTTP service: scheduling and counting only
// ---------------------------------------------------------------------------

function identity(): RequestHandler {
  return (_req, res, next) => {
    res.locals.accessContext = {
      tenantId: "t1",
      subjectId: "u1",
      groups: [],
      scopes: ["admin", "chat"],
    } as AccessContext
    next()
  }
}

async function listen(
  app: import("express").Express
): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

interface ControlledOptions {
  delayFor: (message: string) => number
  failFor?: (message: string) => boolean
}

function controlledApp(options: ControlledOptions) {
  const db = openDb(":memory:")
  const source = createMastraChatEventAdapter({
    runner: async (input) => {
      const delay = options.delayFor(input.message)
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      if (input.signal.aborted) {
        const error = new Error("controlled run cancelled")
        error.name = "AbortError"
        throw error
      }
      if (options.failFor?.(input.message)) {
        throw new Error("controlled provider outage")
      }
      return {
        reply: "controlled latency answer",
        status: "completed",
        references: [],
        degradation: { status: "none", unavailableChannels: [] },
        tokens: ["controlled", "latency", "answer"],
        routeTrace: { decision: "simple" },
        retrievalTrace: { resultCount: 0 },
        contextTrace: { evidenceCount: 0, phase: "draft" },
        validationTrace: { round: 1, passed: true },
      }
    },
  })
  const scopeResolver = (
    _context: AccessContext,
    requested?: unknown
  ): RetrievalScope => ({
    knowledgeBaseIds: Array.isArray(requested) ? (requested as string[]) : [],
  })
  return createApp({
    db,
    eventsSource: source,
    accessMiddleware: identity(),
    retrievalScopeResolver: scopeResolver,
  })
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "dr23-latency-"))
}

test("the operator command schedules and counts every planned sample over real Chat HTTP", async () => {
  const app = controlledApp({ delayFor: (message) => 2 + (message.length % 4) })
  const { base, close } = await listen(app)
  const runsRoot = tempRoot()
  try {
    const outcome = await runLatencySuite({
      baseUrl: base,
      runsRoot,
      authToken: "test-token",
      timeoutMs: 5_000,
    })
    assert.equal(outcome.exitCode, 0)
    const report = outcome.report
    assert.ok(report)
    assert.equal(report.gate.passed, true)
    assert.equal(report.counts.warmup.recorded, 20)
    assert.equal(report.counts.warmup.excluded, true)
    assert.equal(report.counts.measured.recorded, 100)
    assert.equal(report.counts.concurrent3.recorded, 20)
    assert.equal(report.counts.recorded, 140)
    assert.equal(report.groups.single.non_faq_knowledge.denominator, 70)
    assert.equal(report.groups.single.non_faq_knowledge.n, 70)
    assert.equal(report.groups.single.faq_direct.n, 5)
    assert.equal(report.groups.single.other.n, 25)
    assert.equal(report.groups.concurrent3.non_faq_knowledge.denominator, 14)
    // The command stores raw durations so p50/p95 can be recomputed by hand.
    const raw = [...report.groups.single.non_faq_knowledge.rawDurationsMs].sort((a, b) => a - b)
    assert.equal(report.groups.single.non_faq_knowledge.p50Ms, raw[Math.ceil(0.5 * raw.length) - 1])
    assert.equal(report.groups.single.non_faq_knowledge.p95Ms, raw[Math.ceil(0.95 * raw.length) - 1])
    assert.equal(report.samples.length, 140)
    assert.equal(report.judge.invoked, false)
    assert.equal(report.judge.excludedFromLatency, true)
    assert.ok(report.samples.every((sample) => sample.error === null))
    assert.ok(
      report.samples.some((sample) => sample.concurrency === 3 && sample.phase === "concurrent3")
    )
    assert.ok(
      report.samples.every(
        (sample) =>
          sample.phase !== "concurrent3" || sample.concurrency === 3
      )
    )
  } finally {
    await close()
    rmSync(runsRoot, { recursive: true, force: true })
  }
})

test("a controlled timeout and provider failure fail the run while every original record survives", async () => {
  const dataset = loadLatencyDataset(GOLDEN)
  const slowCase = dataset.cases.find((item) => item.id.startsWith("case-11"))!
  const failingCase = dataset.cases.find((item) => item.id.startsWith("case-16"))!
  const app = controlledApp({
    delayFor: (message) => (message === slowCase.message ? 250 : 2),
    failFor: (message) => message === failingCase.message,
  })
  const { base, close } = await listen(app)
  const runsRoot = tempRoot()
  try {
    const outcome = await runLatencySuite({
      baseUrl: base,
      runsRoot,
      authToken: "test-token",
      timeoutMs: 40,
    })
    assert.equal(outcome.exitCode, 1)
    const report = outcome.report
    assert.ok(report)
    assert.equal(report.gate.passed, false)
    assert.equal(report.gate.status, "failed")
    // Every planned sample was still recorded; nothing slow/failed was deleted.
    assert.equal(report.counts.measured.recorded, 100)
    assert.equal(report.counts.recorded, 140)
    assert.ok(report.counts.measured.errors >= 5)
    const timedOut = report.samples.filter(
      (sample) =>
        sample.phase === "measured" &&
        sample.caseId === slowCase.id &&
        sample.error !== null
    )
    assert.equal(timedOut.length, 5)
    assert.ok(timedOut.every((sample) => sample.durationMs >= 30))
    assert.ok(timedOut.every((sample) => /timeout/.test(sample.error ?? "")))
    const providerFailed = report.samples.filter(
      (sample) =>
        sample.phase === "measured" &&
        sample.caseId === failingCase.id &&
        sample.terminalStatus === "provider_error"
    )
    assert.equal(providerFailed.length, 5)
    assert.ok(providerFailed.every((sample) => sample.durationMs >= 0))
    assert.ok(
      report.gate.reasons.some(
        (reason) => reason.kind === "execution_error" && reason.sampleId === timedOut[0].sampleId
      )
    )
    assert.ok(
      report.groups.single.non_faq_knowledge.rawDurationsMs.some(
        (duration) => duration >= 30
      ),
      "failed waits must stay in the reported raw durations"
    )
  } finally {
    await close()
    rmSync(runsRoot, { recursive: true, force: true })
  }
})
