import assert from "node:assert/strict"
import test from "node:test"
import {
  dedupeByPassageId,
  EVAL_METRIC_VERSION,
  EVAL_RETRIEVAL_METRIC_KEYS,
  notApplicableRetrievalMetrics,
  precision,
  retrievalMetrics,
} from "./metrics"

test("four irrelevant candidates followed by the relevant one give precision 0.2", () => {
  const candidates = [
    { passageId: "d1", relevant: false },
    { passageId: "d2", relevant: false },
    { passageId: "d3", relevant: false },
    { passageId: "d4", relevant: false },
    { passageId: "gold", relevant: true },
  ]

  // Irrelevant passages stay in the ranking — filtering them would inflate
  // precision to 1.
  assert.equal(precision(candidates, ["gold"]), 0.2)
})

test("precision counts distinct candidate passages and keeps the first position", () => {
  const candidates = [
    { passageId: "gold", relevant: true },
    { passageId: "gold", relevant: true }, // duplicate — one passage, counted once
    { passageId: "d1", relevant: false },
  ]

  assert.equal(precision(candidates, ["gold"]), 0.5)
  assert.deepEqual(dedupeByPassageId(candidates).map((c) => c.passageId), ["gold", "d1"])
})

test("unmapped candidates keep their ranking position and count as non-relevant", () => {
  const candidates = [
    { passageId: null, relevant: false },
    { passageId: "gold", relevant: true },
  ]

  assert.equal(precision(candidates, ["gold"]), 0.5)
  assert.equal(
    dedupeByPassageId(candidates).length,
    2,
    "identity-less candidates are never collapsed together"
  )
})

test("ground truth present without any recall scores 0, not 'not applicable'", () => {
  assert.equal(precision([], ["gold"]), 0)
  assert.equal(
    precision([{ passageId: "d1", relevant: false }], ["gold"]),
    0
  )
})

test("empty ground truth makes precision not applicable", () => {
  assert.equal(precision([{ passageId: "gold", relevant: true }], []), null)
})

test("precision with one of two ground-truth passages retrieved is 1 (precision, not recall)", () => {
  const candidates = [{ passageId: "a", relevant: true }]
  assert.equal(precision(candidates, ["a", "b"]), 1)
})

// ---------------------------------------------------------------------------
// Ticket 06 — the six retrieval metrics share one ranking view
// ---------------------------------------------------------------------------

test("four irrelevant then one relevant: precision 0.2 and MRR 0.2", () => {
  const candidates = [
    { passageId: "d1", relevant: false },
    { passageId: "d2", relevant: false },
    { passageId: "d3", relevant: false },
    { passageId: "d4", relevant: false },
    { passageId: "gold", relevant: true },
  ]

  const metrics = retrievalMetrics(candidates, ["gold"])
  assert.equal(metrics.precision, 0.2, "filtering the irrelevant passages would inflate this to 1")
  assert.equal(metrics.mrr, 0.2, "the reciprocal rank uses the real position 5")
  assert.equal(metrics.recall, 1)
  assert.equal(metrics.map, 0.2)
  assert.equal(metrics["ndcg@3"], 0, "the only relevant passage sits outside the top 3")
  assert.equal(
    Number(metrics["ndcg@10"]!.toFixed(6)),
    Number((1 / Math.log2(6)).toFixed(6)),
    "at K=10 the single ground-truth hit is discounted by its position"
  )
})

test("two ground-truth passages with one retrieved: recall 0.5 and AP 0.5", () => {
  const candidates = [
    { passageId: "a", relevant: true },
    { passageId: "d1", relevant: false },
  ]

  const metrics = retrievalMetrics(candidates, ["a", "b"])
  assert.equal(metrics.recall, 0.5, "one of two ground-truth passages was retrieved")
  assert.equal(metrics.map, 0.5, "per-case MAP value is this case's average precision")
  assert.equal(metrics.precision, 0.5, "precision and recall are different questions")
})

test("NDCG's ideal list comes from K and the ground truth, not from what was retrieved", () => {
  assert.equal(retrievalMetrics([{ passageId: "a", relevant: true }], ["a"])["ndcg@3"], 1)
  assert.equal(retrievalMetrics([{ passageId: "a", relevant: true }], ["a"])["ndcg@10"], 1)

  const bothInOrder = [
    { passageId: "a", relevant: true },
    { passageId: "b", relevant: true },
  ]
  assert.equal(retrievalMetrics(bothInOrder, ["a", "b"])["ndcg@3"], 1)

  // GT = {a, b}, only b retrieved at rank 2 → IDCG@3 = 1 + 1/log2(3).
  const onlySecondAtRankTwo = [
    { passageId: "x", relevant: false },
    { passageId: "b", relevant: true },
  ]
  const expected = 1 / Math.log2(3) / (1 + 1 / Math.log2(3))
  assert.equal(retrievalMetrics(onlySecondAtRankTwo, ["a", "b"])["ndcg@3"], expected)
})

test("duplicate passages keep the first position and are scored once", () => {
  const candidates = [
    { passageId: "gold", relevant: true },
    { passageId: "d1", relevant: false },
    { passageId: "gold", relevant: true },
  ]

  const metrics = retrievalMetrics(candidates, ["gold"])
  assert.equal(metrics.precision, 0.5)
  assert.equal(metrics.recall, 1)
  assert.equal(metrics.mrr, 1)
  assert.equal(metrics.map, 1)
})

test("unmapped candidates keep their diagnostic position and score as non-relevant", () => {
  const candidates = [
    { passageId: null, relevant: false },
    { passageId: null, relevant: false },
    { passageId: "gold", relevant: true },
  ]

  const metrics = retrievalMetrics(candidates, ["gold"])
  assert.equal(metrics.precision, 1 / 3)
  assert.equal(metrics.mrr, 1 / 3)
  assert.equal(metrics.map, 1 / 3)
  assert.equal(metrics.recall, 1)
})

test("no recall scores 0 on all six; empty ground truth is not applicable", () => {
  const noRecall = retrievalMetrics([], ["gold"])
  for (const key of EVAL_RETRIEVAL_METRIC_KEYS) {
    assert.equal(noRecall[key], 0, `${key} must be a real 0 when nothing was retrieved`)
  }

  const noGroundTruth = retrievalMetrics([{ passageId: "gold", relevant: true }], [])
  for (const key of EVAL_RETRIEVAL_METRIC_KEYS) {
    assert.equal(noGroundTruth[key], null, `${key} must be "not applicable" without ground truth`)
  }
  assert.deepEqual(notApplicableRetrievalMetrics(), noGroundTruth)
})

test("the bundle covers exactly the six displayed keys under one version stamp", () => {
  const metrics = retrievalMetrics([], [])
  assert.deepEqual(Object.keys(metrics), [...EVAL_RETRIEVAL_METRIC_KEYS])
  assert.equal(EVAL_METRIC_VERSION, "eval-metrics-v2")
})
