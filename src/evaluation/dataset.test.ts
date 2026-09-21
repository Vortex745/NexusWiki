import assert from "node:assert/strict"
import test from "node:test"
import {
  EVAL_DATASET_LIMITS,
  EvalDatasetValidationError,
  evalDatasetDigest,
  validateEvalDataset,
  type EvalDataset,
} from "./dataset"
import { BUILTIN_EVAL_DATASETS } from "./builtin_datasets"

function validDataset(): EvalDataset {
  return {
    schemaVersion: 1,
    name: "sample",
    version: "1.0.0",
    corpus: [
      { passageId: "p1", content: "first passage" },
      { passageId: "p2", title: "second", content: "second passage" },
    ],
    cases: [
      {
        caseId: "c1",
        question: "q?",
        referenceAnswer: "a",
        relevantPassageIds: ["p1"],
      },
    ],
  }
}

function issuesOf(input: unknown): string[] {
  try {
    validateEvalDataset(input)
  } catch (error) {
    assert.ok(error instanceof EvalDatasetValidationError)
    return error.issues
  }
  throw new Error("expected validation to reject the dataset")
}

test("every built-in sample satisfies the authoritative validator", () => {
  for (const { dataset } of BUILTIN_EVAL_DATASETS) {
    assert.deepEqual(validateEvalDataset(dataset), dataset)
  }
})

test("a valid dataset normalizes and keeps corpus plus distractors", () => {
  const validated = validateEvalDataset(validDataset())

  assert.equal(validated.corpus.length, 2)
  assert.deepEqual(validated.corpus[1], {
    passageId: "p2",
    title: "second",
    content: "second passage",
  })
})

test("unknown fields are dropped instead of trusted", () => {
  const validated = validateEvalDataset({
    ...validDataset(),
    secret: "must not survive",
    cases: [{ ...validDataset().cases[0], hiddenTruth: "x" }],
  })

  assert.equal("secret" in validated, false)
  assert.equal("hiddenTruth" in validated.cases[0], false)
})

test("schema version, name and version are validated", () => {
  assert.match(issuesOf({ ...validDataset(), schemaVersion: 2 }).join("; "), /schemaVersion must be 1/)
  assert.match(issuesOf({ ...validDataset(), name: "  " }).join("; "), /name must be a non-empty string/)
  assert.match(
    issuesOf({ ...validDataset(), version: "v".repeat(EVAL_DATASET_LIMITS.maxVersionChars + 1) }).join("; "),
    /version must be at most/
  )
})

test("duplicate passage ids and empty corpus are rejected", () => {
  const duplicate = {
    ...validDataset(),
    corpus: [
      { passageId: "p1", content: "a" },
      { passageId: "p1", content: "b" },
    ],
  }
  assert.match(issuesOf(duplicate).join("; "), /duplicates an earlier id: p1/)
  assert.match(issuesOf({ ...validDataset(), corpus: [] }).join("; "), /corpus must be a non-empty array/)
})

test("case-level issues name the offending entry", () => {
  const dataset = validDataset()
  const issues = issuesOf({
    ...dataset,
    cases: [
      { ...dataset.cases[0], caseId: "c1", relevantPassageIds: ["missing"] },
      { ...dataset.cases[0], caseId: "c1", question: "  " },
    ],
  }).join("; ")

  assert.match(issues, /cases\[0\]\.relevantPassageIds\[0\] references unknown passageId: missing/)
  assert.match(issues, /cases\[1\]\.question must be a non-empty string/)
})

test("case ids must be unique and questions/reference answers non-empty", () => {
  const dataset = validDataset()
  assert.match(
    issuesOf({ ...dataset, cases: [dataset.cases[0], dataset.cases[0]] }).join("; "),
    /cases\[1\]\.caseId duplicates an earlier id: c1/
  )
  assert.match(
    issuesOf({ ...dataset, cases: [{ ...dataset.cases[0], referenceAnswer: "" }] }).join("; "),
    /referenceAnswer must be a non-empty string/
  )
})

test("size limits are enforced before any provider call", () => {
  const dataset = validDataset()
  const tooManyPassages = {
    ...dataset,
    corpus: Array.from({ length: EVAL_DATASET_LIMITS.maxPassages + 1 }, (_, index) => ({
      passageId: `p${index}`,
      content: "x",
    })),
  }
  assert.match(issuesOf(tooManyPassages).join("; "), /at most 200 passages/)

  const oversizedCase = {
    ...dataset,
    cases: [
      {
        ...dataset.cases[0],
        question: "q".repeat(EVAL_DATASET_LIMITS.maxQuestionChars + 1),
      },
    ],
  }
  assert.match(issuesOf(oversizedCase).join("; "), /question must be at most/)
})

test("non-object payloads are rejected", () => {
  assert.match(issuesOf("not-a-dataset").join("; "), /must be a JSON object/)
  assert.match(issuesOf(null).join("; "), /must be a JSON object/)
})

test("content digest separates same-version datasets with different content", () => {
  const base = validateEvalDataset(validDataset())
  const sameContentDifferentKeyOrder = validateEvalDataset({
    cases: base.cases,
    corpus: base.corpus,
    version: base.version,
    name: base.name,
    schemaVersion: 1,
  })
  const differentContent = validateEvalDataset({
    ...base,
    corpus: [...base.corpus, { passageId: "p3", content: "third" }],
  })

  assert.equal(evalDatasetDigest(base), evalDatasetDigest(sameContentDifferentKeyOrder))
  assert.notEqual(evalDatasetDigest(base), evalDatasetDigest(differentContent))
  assert.match(evalDatasetDigest(base), /^[a-f0-9]{64}$/)
})
