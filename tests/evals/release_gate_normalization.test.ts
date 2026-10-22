/**
 * DR-03-AC01 (TS side): the release gate and Python contracts share one
 * normalization fixture. This test pins the TypeScript result for every
 * reviewed example (NFKC, case, whitespace, digits, units, negation).
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import {
  containsNormalized,
  normalize,
} from "../../scripts/release-quality-gate"

interface NormalizeExample {
  name: string
  input: string
  expected: string
}

interface ContainsExample {
  name: string
  haystack: string
  needle: string
  expected: boolean
}

interface Fixture {
  schema: string
  version: number
  description: string
  normalize: NormalizeExample[]
  contains: ContainsExample[]
}

const ROOT = resolve(__dirname, "..", "..")
const FIXTURE_PATH = join(
  ROOT,
  "tests",
  "evals",
  "fixtures",
  "normalization.json"
)

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture

test("the shared fixture is the reviewed v1 schema with paired examples", () => {
  assert.equal(fixture.schema, "eval-normalization-examples")
  assert.equal(fixture.version, 1)
  assert.ok(fixture.normalize.length >= 10)
  assert.ok(fixture.contains.length >= 10)
  for (const entry of fixture.normalize) {
    assert.equal(typeof entry.input, "string", entry.name)
    assert.equal(typeof entry.expected, "string", entry.name)
  }
  for (const entry of fixture.contains) {
    assert.equal(typeof entry.haystack, "string", entry.name)
    assert.equal(typeof entry.needle, "string", entry.name)
    assert.equal(typeof entry.expected, "boolean", entry.name)
  }
})

for (const entry of fixture.normalize) {
  test(`normalization: ${entry.name}`, () => {
    assert.equal(normalize(entry.input), entry.expected)
  })
}

for (const entry of fixture.contains) {
  test(`containment: ${entry.name}`, () => {
    assert.equal(
      containsNormalized(entry.haystack, entry.needle),
      entry.expected
    )
  })
}
