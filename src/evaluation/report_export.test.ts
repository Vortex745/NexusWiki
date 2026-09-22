/**
 * Ticket 28 (EVAL-02A) — the export format itself.
 *
 * The API test drives the real HTTP export; these cases pin the two things a
 * spreadsheet will break on: RFC 4180 quoting and the difference between "not
 * applicable" and zero.
 */
import assert from "node:assert/strict"
import test from "node:test"
import {
  EVAL_EXPORT_FORMAT_VERSION,
  evalExportFilename,
  exportTaskCsv,
  exportTaskJson,
} from "./report_export"
import { notApplicableRetrievalMetrics } from "./metrics"
import { notApplicableBleuMetrics, notApplicableRougeMetrics } from "./text_metrics"
import type { EvalCaseResult, EvalTaskDetail } from "./contracts"

function caseResult(overrides: Partial<EvalCaseResult> = {}): EvalCaseResult {
  return {
    caseId: "c1",
    question: "问题",
    referenceAnswer: "参考答案",
    outcome: "answered",
    answer: "回答",
    durationMs: 12,
    metrics: {
      ...notApplicableRetrievalMetrics(),
      ...notApplicableBleuMetrics(),
      ...notApplicableRougeMetrics(),
    },
    retrievedPassageIds: [],
    candidates: [],
    unmappedCandidates: 0,
    ...overrides,
  }
}

function taskDetail(overrides: Partial<EvalTaskDetail> = {}): EvalTaskDetail {
  return {
    id: "01e5f6a7-0000-0000-0000-000000000000",
    dataset: {
      name: "退款数据集",
      version: "1.0.0",
      contentDigest: "digest",
      caseCount: 1,
      passageCount: 2,
    },
    stage: "completed",
    progress: { finished: 1, total: 1 },
    counts: { answered: 1, failed: 0, degraded: 0 },
    createdAt: "2026-09-23T00:00:00.000Z",
    config: {
      chatModel: "chat-model",
      rerankModel: null,
      embeddingModel: "embedding-model",
      rerankSource: "not_configured",
    },
    cases: [caseResult()],
    metrics: { version: "eval-metrics-v2", metrics: {} },
    cleanup: null,
    ...overrides,
  }
}

test("CSV quotes fields containing a delimiter, a quote or a newline", () => {
  const csv = exportTaskCsv(
    taskDetail({
      cases: [
        caseResult({
          caseId: 'c,"1"',
          question: "退款,多久 \"到账\"?\n第二行",
          answer: "a,b",
        }),
      ],
    })
  )
  assert.match(csv, /"c,""1"""/, "the case id keeps its comma and quotes")
  assert.match(
    csv,
    /"退款,多久 ""到账""\?\r?\n第二行"/,
    "the question is quoted and its quotes doubled"
  )
  assert.match(csv, /,"a,b",/, "a delimiter is preserved inside the quoted answer field")
  const [header, ...rows] = csv.trimEnd().split("\r\n")
  assert.equal(rows.length, 1, "three quoted fields still produce exactly one row")
  assert.equal(/"|,/.test(header), true, "the header uses plain column names")
  assert.equal(header.includes('"'), false, "no column name needs quoting")
})

test("CSV leaves not-applicable metrics empty instead of writing a zero", () => {
  const csv = exportTaskCsv(
    taskDetail({
      cases: [
        caseResult({
          outcome: "failed",
          answer: "",
          error: "provider refused",
          metrics: {
            ...notApplicableRetrievalMetrics(),
            ...notApplicableBleuMetrics(),
            ...notApplicableRougeMetrics(),
          },
        }),
      ],
    })
  )
  const [header, row] = csv.trimEnd().split("\r\n")
  const columns = header.split(",")
  const precision = row.split(",")[columns.indexOf("precision")]
  const error = row.split(",")[columns.indexOf("error")]
  assert.equal(precision, "", "a not-applicable metric is an empty cell, never 0")
  assert.equal(error, "provider refused", "the failure reason is exported")
})

test("the JSON export wraps the real task detail with its format version", () => {
  const exported = JSON.parse(
    exportTaskJson(taskDetail(), "2026-09-23T01:00:00.000Z")
  ) as Record<string, any>
  assert.equal(exported.formatVersion, EVAL_EXPORT_FORMAT_VERSION)
  assert.equal(exported.exportedAt, "2026-09-23T01:00:00.000Z")
  assert.equal(exported.task.cases[0].answer, "回答")
  assert.equal(exported.task.config.chatModel, "chat-model")
})

test("the export filename is deterministic and filesystem safe", () => {
  const name = evalExportFilename(taskDetail(), "csv")
  assert.equal(name, "退款数据集-01e5f6a7.csv")
  assert.equal(
    evalExportFilename(taskDetail({ dataset: { ...taskDetail().dataset, name: "a/b:c*d?" } }), "json"),
    "a-b-c-d-01e5f6a7.json",
    "path separators and reserved characters are replaced"
  )
})
