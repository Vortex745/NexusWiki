/**
 * DR-01 acceptance tests for the conversational converter's output ownership.
 *
 * The seam is the CLI: the default run writes
 * tests/evals/.conversational-dataset.json and must never overwrite the
 * single-turn tests/evals/.dataset.json.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { GOLDEN_SET } from "../../src/evaluation/golden/fixtures.js"

const ROOT = resolve(__dirname, "..", "..")
const DEMO_CONVERTER = join(ROOT, "tests", "evals", "convert_demo_gate.mts")
const CONVERSATIONAL_CONVERTER = join(
  ROOT,
  "tests",
  "evals",
  "convert_ts_goldens.mts"
)
const DEMO_OUTPUT = join(ROOT, "tests", "evals", ".dataset.json")
const CONVERSATIONAL_OUTPUT = join(
  ROOT,
  "tests",
  "evals",
  ".conversational-dataset.json"
)

function run(script: string, args: string[] = []) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", script, ...args],
    { cwd: ROOT, encoding: "utf8", timeout: 120_000 }
  )
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

interface ConversationalGolden {
  scenario: string
  expected_outcome: string
  user_description: string
}

test("the conversational converter owns .conversational-dataset.json and leaves .dataset.json alone", () => {
  const demo = run(DEMO_CONVERTER)
  assert.equal(demo.status, 0, demo.stderr)
  assert.ok(existsSync(DEMO_OUTPUT))
  const demoBefore = readFileSync(DEMO_OUTPUT)

  const conversational = run(CONVERSATIONAL_CONVERTER)
  assert.equal(conversational.status, 0, conversational.stderr)
  assert.ok(existsSync(CONVERSATIONAL_OUTPUT))
  assert.deepEqual(
    readFileSync(DEMO_OUTPUT),
    demoBefore,
    "the conversational converter must not overwrite the single-turn dataset"
  )

  const goldens = JSON.parse(
    readFileSync(CONVERSATIONAL_OUTPUT, "utf8")
  ) as ConversationalGolden[]
  assert.equal(goldens.length, GOLDEN_SET.cases.length)
  goldens.forEach((golden, index) => {
    assert.ok(golden.scenario.includes(`[${GOLDEN_SET.cases[index].id}]`))
    assert.ok(golden.expected_outcome.trim().length > 0)
    assert.equal(golden.user_description, "使用中文的企业知识库用户")
    assert.ok(!Object.hasOwn(golden, "name"))
    assert.ok(!Object.hasOwn(golden, "expected_output"))
  })

  const conversationalBefore = readFileSync(CONVERSATIONAL_OUTPUT)
  const demoAgain = run(DEMO_CONVERTER)
  assert.equal(demoAgain.status, 0, demoAgain.stderr)
  assert.ok(existsSync(CONVERSATIONAL_OUTPUT), "old output must not be deleted")
  assert.deepEqual(
    readFileSync(CONVERSATIONAL_OUTPUT),
    conversationalBefore,
    "the demo converter must not overwrite the conversational dataset"
  )
})

test("an invalid conversational --out usage fails non-zero without writing", () => {
  const result = run(CONVERSATIONAL_CONVERTER, ["--out"])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /usage/)
})
