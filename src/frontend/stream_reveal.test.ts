import assert from "node:assert/strict"
import test from "node:test"
import { MAX_REVEAL_PER_FRAME, revealStep } from "./stream_reveal"

const FRAME_MS = 16

test("revealStep exposes nothing when already caught up", () => {
  assert.equal(revealStep(120, 120, FRAME_MS), 0)
  assert.equal(revealStep(130, 120, FRAME_MS), 0)
})

test("revealStep exposes nothing before a frame delta exists", () => {
  // The first tick only records the timestamp; revealing 0 keeps the very first
  // frame from dumping the whole backlog.
  assert.equal(revealStep(0, 500, 0), 0)
  assert.equal(revealStep(0, 500, -8), 0)
})

test("revealStep never reveals past the target", () => {
  assert.equal(revealStep(98, 100, 5_000), MAX_REVEAL_PER_FRAME)
  assert.equal(revealStep(0, 7, 10_000), MAX_REVEAL_PER_FRAME)
})

test("a one-frame burst does not render in one frame", () => {
  // The knowledge routes land the entire reply in a single SSE frame.
  const first = revealStep(0, 400, FRAME_MS)
  assert.equal(first, MAX_REVEAL_PER_FRAME)
  assert.ok(first > 0 && first < 400, `expected a partial reveal, got ${first}`)
})

test("a live token trickle reveals at least one character per frame", () => {
  // The typewriter cadence stays at one character per frame, even when a
  // provider delta contains multiple characters.
  assert.equal(revealStep(0, 2, FRAME_MS), MAX_REVEAL_PER_FRAME)
  assert.equal(revealStep(0, 1, FRAME_MS), 1)
})

test("a burst drains in a bounded window and never overshoots", () => {
  let shown = 0
  let frames = 0
  const target = 400
  while (shown < target && frames < 10_000) {
    const step = revealStep(shown, target, FRAME_MS)
    assert.ok(step <= target - shown, `frame ${frames} overshoots by ${step - (target - shown)}`)
    shown += step
    frames += 1
  }
  assert.equal(shown, target)
  // At one character per frame, a normal answer completes in a few seconds.
  assert.ok(frames <= 450, `took ${frames} frames (~${(frames * FRAME_MS) / 1000}s) to drain`)
})

test("a large backlog never jumps by more than the frame cap", () => {
  assert.equal(revealStep(0, 10_000, FRAME_MS), MAX_REVEAL_PER_FRAME)
})

test("a one-character-per-frame stream stays caught up", () => {
  let shown = 0
  let target = 0
  let maxBacklog = 0
  for (let frame = 0; frame < 600; frame += 1) {
    target += 1
    shown += revealStep(shown, target, FRAME_MS)
    maxBacklog = Math.max(maxBacklog, target - shown)
  }
  assert.equal(maxBacklog, 0)
})
