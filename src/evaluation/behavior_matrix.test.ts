/**
 * Ticket DR-21 — the aggregation rules themselves.
 *
 * The matrix is an operator-facing report, so its honesty rules are behaviour:
 * a cell is `pass/offline` ONLY when this run observed its named tests pass.
 * Missing tests, failures, absent capability snapshots and online cells must
 * never be counted as a pass, and one of them must block the overall result.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  evaluateCapabilityCell,
  evaluateOfflineCell,
  evaluateMatrix,
  evaluateOnlineCell,
  observationKey,
  summarizeMatrix,
  type CapabilityCellSpec,
  type OfflineCellSpec,
  type OnlineCellSpec,
  type TestObservation,
} from "./behavior_matrix"

const ref = { file: "src/api/example.test.ts", name: "the cell behaviour" }

const offlineCell: OfflineCellSpec = {
  id: "group.cell",
  group: "group",
  caseKind: "normal",
  description: "a named offline scenario",
  ticket: "DR-15",
  source: "offline_test",
  tests: [ref],
}

function observed(...entries: Array<[string, TestObservation]>): Map<string, TestObservation> {
  return new Map(entries)
}

test("DR-21: a cell whose named tests all passed this run is pass/offline", () => {
  const result = evaluateOfflineCell(
    offlineCell,
    observed([observationKey(ref), { status: "pass", durationMs: 3 }]),
  )
  assert.equal(result.status, "pass/offline")
  assert.equal(result.countedAsPass, true)
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.failed, [])
  assert.deepEqual(result.evidence, [
    { file: ref.file, test: ref.name, result: "pass" },
  ])
})

test("DR-21: a named test absent from this run makes the cell incomplete, never a pass", () => {
  const result = evaluateOfflineCell(offlineCell, observed())
  assert.equal(result.status, "incomplete")
  assert.equal(result.countedAsPass, false)
  assert.deepEqual(result.missing, [ref.name])
  assert.match(result.detail, /missing/)
})

test("DR-21: a failing named test marks the cell error and is not a pass", () => {
  const result = evaluateOfflineCell(
    offlineCell,
    observed([observationKey(ref), { status: "fail", durationMs: 5 }]),
  )
  assert.equal(result.status, "error")
  assert.equal(result.countedAsPass, false)
  assert.deepEqual(result.failed, [ref.name])
  assert.deepEqual(result.evidence, [
    { file: ref.file, test: ref.name, result: "fail" },
  ])
})

test("DR-21: a cell with no named tests cannot claim evidence", () => {
  const result = evaluateOfflineCell({ ...offlineCell, tests: [] }, observed())
  assert.equal(result.status, "incomplete")
  assert.equal(result.countedAsPass, false)
})

test("DR-21: an online cell is not_run/online and carries its gate", () => {
  const online: OnlineCellSpec = {
    id: "rerank.online",
    group: "rerank",
    caseKind: "online",
    description: "real provider coverage",
    ticket: "DR-21",
    source: "online",
    gate: "G-RERANK-LIVE",
  }
  const result = evaluateOnlineCell(online)
  assert.equal(result.status, "not_run/online")
  assert.equal(result.countedAsPass, false)
  assert.equal(result.onlineAcceptance, "not_run")
  assert.match(result.detail, /G-RERANK-LIVE/)
})

test("DR-21: no rerank capability snapshot is not_configured and never a pass", () => {
  const capability: CapabilityCellSpec = {
    id: "rerank.capability",
    group: "rerank",
    caseKind: "config",
    description: "capability report status",
    ticket: "DR-13",
    source: "capability",
    capability: "rerank",
  }
  const result = evaluateCapabilityCell(capability, null)
  assert.equal(result.status, "not_configured")
  assert.equal(result.countedAsPass, false)
  assert.equal(result.onlineAcceptance, "not_run")
  assert.match(result.detail, /snapshot/)
})

test("DR-21: a configured rerank provider without provider evidence is not_exercised", () => {
  const capability: CapabilityCellSpec = {
    id: "rerank.capability",
    group: "rerank",
    caseKind: "config",
    description: "capability report status",
    ticket: "DR-13",
    source: "capability",
    capability: "rerank",
  }
  const result = evaluateCapabilityCell(capability, { configured: true })
  assert.equal(result.status, "not_exercised")
  assert.equal(result.countedAsPass, false)
  assert.match(result.detail, /configured/)
})

test("DR-21: a controlled exercised snapshot proves the protocol branch only", () => {
  const capability: CapabilityCellSpec = {
    id: "rerank.capability",
    group: "rerank",
    caseKind: "config",
    description: "capability report status",
    ticket: "DR-13",
    source: "capability",
    capability: "rerank",
  }
  const result = evaluateCapabilityCell(capability, {
    status: "exercised",
    configured: true,
    model: { configured: "bge-reranker-v2-m3", observed: ["bge-reranker-v2-m3"] },
  })
  assert.equal(result.status, "pass/offline")
  assert.equal(result.onlineAcceptance, "not_run")
  assert.match(result.detail, /controlled/)
})

test("DR-21: a degraded or malformed capability snapshot never claims coverage", () => {
  const capability: CapabilityCellSpec = {
    id: "rerank.capability",
    group: "rerank",
    caseKind: "config",
    description: "capability report status",
    ticket: "DR-13",
    source: "capability",
    capability: "rerank",
  }
  assert.equal(
    evaluateCapabilityCell(capability, { status: "degraded", configured: true }).status,
    "not_exercised",
  )
  assert.equal(
    evaluateCapabilityCell(capability, { status: "invalid", configured: true }).status,
    "incomplete",
  )
})

test("DR-21: one incomplete required cell blocks the overall matrix", () => {
  const cells: Array<typeof offlineCell> = [
    offlineCell,
    { ...offlineCell, id: "group.missing", tests: [{ ...ref, name: "absent test" }] },
  ]
  const results = evaluateMatrix(cells, observed([observationKey(ref), { status: "pass" }]), null)
  const summary = summarizeMatrix(results, { offlineOnly: true })
  assert.equal(summary.status, "incomplete")
  assert.equal(summary.offlineComplete, false)
  assert.equal(summary.exitCode, 1)
  assert.deepEqual(summary.blocking, ["group.missing"])
})

test("DR-21: --offline-only passes only when every offline cell passed this run", () => {
  const cells: Array<typeof offlineCell> = [offlineCell]
  const results = evaluateMatrix(cells, observed([observationKey(ref), { status: "pass" }]), null)
  const summary = summarizeMatrix(results, { offlineOnly: true })
  assert.equal(summary.status, "offline_complete")
  assert.equal(summary.offlineComplete, true)
  assert.equal(summary.onlineAcceptance, "not_run")
  assert.equal(summary.exitCode, 0)
  assert.equal(summary.counts["pass/offline"], 1)
})

test("DR-21: without --offline-only, pending online evidence keeps the matrix incomplete", () => {
  const online: OnlineCellSpec = {
    id: "rerank.online",
    group: "rerank",
    caseKind: "online",
    description: "real provider coverage",
    ticket: "DR-21",
    source: "online",
    gate: "G-RERANK-LIVE",
  }
  const results = evaluateMatrix(
    [offlineCell, online],
    observed([observationKey(ref), { status: "pass" }]),
    null,
  )
  const summary = summarizeMatrix(results, { offlineOnly: false })
  assert.equal(summary.status, "incomplete")
  assert.equal(summary.exitCode, 1)
  assert.deepEqual(summary.blocking, [])
  assert.deepEqual(summary.pending, [online.id])
})

test("DR-21: a required group with untested cells prevents that group from passing", () => {
  const cells: Array<typeof offlineCell> = [
    offlineCell,
    { ...offlineCell, id: "group.untested", tests: [{ ...ref, name: "never ran" }] },
  ]
  const results = evaluateMatrix(cells, observed([observationKey(ref), { status: "pass" }]), null)
  const missing = results.find((result) => result.id === "group.untested")
  assert.equal(missing?.status, "incomplete")
  assert.equal(missing?.countedAsPass, false)
})
