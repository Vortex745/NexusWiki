import assert from "node:assert/strict"
import test from "node:test"
import { dedupeByPassageId, precision } from "./metrics"

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
