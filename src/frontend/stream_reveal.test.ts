import assert from "node:assert/strict"
import test from "node:test"
import {
  REVEAL_MAX_TICKS,
  REVEAL_TOKEN_MS,
  revealTo,
  streamTokens,
  tokenBoundaries,
} from "./stream_reveal"

const latin = "Pistachio is up"
const cjk = "根据知识库的资料"
const long = `${"word ".repeat(400)}end`

test("streamTokens keeps latin words whole and splits what has no spaces", () => {
  assert.deepEqual(streamTokens("ab 中文"), ["ab", " ", "中", "文"])
})

test("tokenBoundaries absorb trailing whitespace into the preceding token", () => {
  assert.deepEqual(tokenBoundaries(latin), [10, 13, 15])
})

test("tokenBoundaries give every CJK character its own step", () => {
  assert.deepEqual(tokenBoundaries(cjk), [1, 2, 3, 4, 5, 6, 7, 8])
})

test("tokenBoundaries ignore leading whitespace and end at the last glyph", () => {
  assert.deepEqual(tokenBoundaries("  hi"), [4])
  assert.deepEqual(tokenBoundaries(""), [])
})

test("tokenBoundaries treat a markdown emphasis run as separate tokens", () => {
  // "**go**" has no spaces, so the punctuation dribbles around the word; the
  // reveal still never cuts a word in half.
  assert.deepEqual(tokenBoundaries("**go**"), [1, 2, 4, 5, 6])
})

test("revealTo holds still when caught up or nothing is due", () => {
  const boundaries = tokenBoundaries(latin)
  assert.equal(revealTo(15, 15, 1, boundaries), 15)
  assert.equal(revealTo(0, 15, 0, boundaries), 0)
})

test("revealTo lands on token boundaries, never mid-word", () => {
  const boundaries = new Set(tokenBoundaries(latin))
  let shown = 0
  for (let tick = 0; tick < 8; tick += 1) {
    shown = revealTo(shown, latin.length, 1, tokenBoundaries(latin))
    assert.ok(shown === 0 || boundaries.has(shown), `tick ${tick} cut at ${shown}`)
  }
})

test("a one-token-at-a-time stream stays in step with the target", () => {
  const text = "a b c d e"
  const boundaries = tokenBoundaries(text)
  let shown = 0
  for (let tick = 0; tick < boundaries.length; tick += 1) {
    const target = boundaries[tick]
    shown = revealTo(shown, target, 1, boundaries)
    assert.equal(shown, target, `tick ${tick} fell behind the arriving token`)
  }
  assert.equal(shown, text.length)
})

test("a single-frame burst drains inside the bounded window", () => {
  const boundaries = tokenBoundaries(long)
  let shown = 0
  let ticks = 0
  while (shown < long.length && ticks < 10_000) {
    const next = revealTo(shown, long.length, 1, boundaries)
    assert.ok(next > shown, `tick ${ticks} made no progress`)
    assert.ok(next <= long.length, `tick ${ticks} overshot to ${next}`)
    shown = next
    ticks += 1
  }
  assert.equal(shown, long.length)
  // The step is sized off the whole reply, so a burst never spends more than the
  // bounded window typing itself out.
  assert.ok(ticks <= REVEAL_MAX_TICKS, `took ${ticks} ticks to drain`)
  assert.ok(ticks * 4 < boundaries.length, `took ${ticks} of ${boundaries.length} ticks`)
})

test("the final token reveals exactly to the target", () => {
  const boundaries = tokenBoundaries(long)
  let shown = 0
  while (shown < long.length) shown = revealTo(shown, long.length, 64, boundaries)
  assert.equal(shown, long.length)
})

test("a short answer keeps the reference cadence instead of accelerating", () => {
  const boundaries = tokenBoundaries(cjk)
  let shown = 0
  let ticks = 0
  while (shown < cjk.length) {
    shown = revealTo(shown, cjk.length, 1, boundaries)
    ticks += 1
  }
  assert.equal(ticks, boundaries.length)
  assert.ok(ticks * REVEAL_TOKEN_MS <= 500, `${ticks * REVEAL_TOKEN_MS}ms for a short reply`)
})
