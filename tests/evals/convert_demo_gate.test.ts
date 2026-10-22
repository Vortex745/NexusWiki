/**
 * DR-01 acceptance tests for the versioned evaluation-data converters.
 *
 * The seam under test is the caller-visible CLI: run the converter, inspect
 * the written DeepEval goldens and the exit code. Fixtures exercise
 * fail-closed validation without touching the committed v1/v2 assets.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const ROOT = resolve(__dirname, "..", "..")
const CONTRACT = {
  kindRules: {
    answer: "ANSWER_KIND_RULE",
    refuse: "REFUSE_KIND_RULE",
    "memory-not-cited": "MEMORY_KIND_RULE",
  },
  prohibitedAssertionsPolicy: "REVIEWED_POLICY",
  memoryConstraints: {
    citationRule: "MEMORY_CITATION_RULE",
    viewingRule: "MEMORY_VIEWING_RULE",
  },
}
const DEMO_CONVERTER = join(ROOT, "tests", "evals", "convert_demo_gate.mts")
const CONVERSATIONAL_CONVERTER = join(
  ROOT,
  "tests",
  "evals",
  "convert_ts_goldens.mts"
)
const DEMO_OUTPUT = join(ROOT, "tests", "evals", ".dataset.json")
const V1_PATH = join(ROOT, "golden", "demo-release-cases.v1.json")
const V2_PATH = join(ROOT, "golden", "demo-release-cases.v2.json")

interface GateCase {
  id: string
  hard: boolean
  kind: string
  message: string
  knowledgeBaseIds?: string[]
  answerPoints?: string[]
  prohibitedAssertions?: string[]
  forbiddenReferenceContent?: string
  memoryConstraints?: Record<string, string>
  reason?: string
}

interface GateDataset {
  schema: string
  version: number
  rules: unknown
  contract: {
    kindRules: Record<string, string>
    prohibitedAssertionsPolicy: string
    memoryConstraints?: Record<string, string>
  }
  digest: {
    algorithm: string
    scope: string
    canonicalization: string
    value: string
  }
  cases: GateCase[]
}

interface Golden {
  name: string
  input: string
  expected_output: string
  additional_metadata: {
    gate_id: string
    kind: string
    hard: boolean
    scope?: string[]
    answer_points?: string[]
    prohibited_assertions?: string[]
    forbidden_reference_content?: string
    memory_constraints?: Record<string, string>
    contract_version: number
    source_digest: string
  }
}

function runConverter(
  script: string,
  args: string[] = []
): { status: number | null; stdout: string; stderr: string } {
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

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "dr01-"))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

function datasetDigest(dataset: {
  version: number
  contract: unknown
  rules?: unknown
  cases: unknown
}): string {
  const material = {
    version: dataset.version,
    contract: dataset.contract,
    rules: dataset.rules,
    cases: dataset.cases,
  }
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(material)), "utf8")
    .digest("hex")
}

function writeFixture(dir: string, cases: GateCase[]): string {
  const body = {
    schema: "demo-release-cases",
    version: 2,
    contract: CONTRACT,
    cases,
  }
  const source = {
    ...body,
    digest: {
      algorithm: "sha256",
      scope: "version+contract+rules+cases",
      canonicalization: "sorted keys",
      value: datasetDigest(body),
    },
  }
  const path = join(dir, "source.json")
  writeFileSync(path, JSON.stringify(source, null, 2), "utf8")
  return path
}

// --- DR-01-AC01 ---------------------------------------------------------

test("v2 preserves every v1 case field and the original 20 ids", () => {
  const v1 = readJson<{ cases: GateCase[] }>(V1_PATH)
  const v2 = readJson<GateDataset>(V2_PATH)
  assert.equal(v1.cases.length, 20)
  assert.deepEqual(
    v2.cases.map((c) => c.id),
    v1.cases.map((c) => c.id)
  )
  assert.deepEqual(
    v2.rules,
    readJson<{ rules: unknown }>(V1_PATH).rules
  )
  for (const [index, v1Case] of v1.cases.entries()) {
    const v2Case = v2.cases[index]
    for (const key of [
      "hard",
      "kind",
      "message",
      "knowledgeBaseIds",
      "answerPoints",
      "forbiddenReferenceContent",
      "reason",
    ] as const) {
      assert.deepEqual(v2Case[key], v1Case[key], `${v1Case.id}.${key}`)
    }
  }
  assert.equal(v2.cases.filter((c) => c.kind === "answer").length, 15)
})

test("real v2 conversion yields exactly 20 unique cases with faithful kind/hard/scope", () => {
  const result = runConverter(DEMO_CONVERTER)
  assert.equal(result.status, 0, `converter failed: ${result.stderr}`)

  const goldens = readJson<Golden[]>(DEMO_OUTPUT)
  const source = readJson<GateDataset>(V2_PATH)

  assert.equal(goldens.length, 20)
  assert.equal(new Set(goldens.map((g) => g.name)).size, 20)
  assert.deepEqual(
    goldens.map((g) => g.name),
    source.cases.map((c) => c.id)
  )

  const byId = new Map(goldens.map((g) => [g.name, g]))
  for (const sourceCase of source.cases) {
    const golden = byId.get(sourceCase.id)
    assert.ok(golden, `missing golden for ${sourceCase.id}`)
    assert.equal(golden.input, sourceCase.message)
    assert.equal(golden.additional_metadata.kind, sourceCase.kind)
    assert.equal(golden.additional_metadata.hard, sourceCase.hard)
    assert.deepEqual(golden.additional_metadata.scope, sourceCase.knowledgeBaseIds)
  }
})

test("all 15 answer cases carry every non-empty answer point in metadata and expected_output", () => {
  const result = runConverter(DEMO_CONVERTER)
  assert.equal(result.status, 0, `converter failed: ${result.stderr}`)

  const goldens = readJson<Golden[]>(DEMO_OUTPUT)
  const answers = goldens.filter(
    (golden) => golden.additional_metadata.kind === "answer"
  )
  assert.equal(answers.length, 15)

  for (const golden of answers) {
    const points = golden.additional_metadata.answer_points
    assert.ok(Array.isArray(points), `${golden.name}: answer_points missing`)
    assert.ok(points.length > 0, `${golden.name}: answer_points empty`)
    for (const point of points) {
      assert.ok(point.trim().length > 0, `${golden.name}: blank answer point`)
      assert.ok(
        golden.expected_output.includes(point),
        `${golden.name}: expected_output omits point ${point}`
      )
    }
  }

  const faq = goldens.find((g) => g.name === "hard-04-faq-exact-answer")
  assert.ok(faq)
  assert.ok(faq.expected_output.includes("30 个自然日"))
})

// --- DR-01-AC02 ---------------------------------------------------------

test("present, missing and blank reasons all produce clean expected_output", () => {
  withTempDir((dir) => {
    const cases: GateCase[] = [
      {
        id: "reason-present",
        hard: false,
        kind: "answer",
        message: "有原因的问题",
        knowledgeBaseIds: ["kb-demo-project"],
        answerPoints: ["要点甲"],
        reason: "  reviewed reason  ",
      },
      {
        id: "reason-missing",
        hard: false,
        kind: "answer",
        message: "缺原因的问题",
        knowledgeBaseIds: ["kb-demo-project"],
        answerPoints: ["要点乙"],
      },
      {
        id: "reason-blank",
        hard: false,
        kind: "answer",
        message: "空白原因的问题",
        knowledgeBaseIds: ["kb-demo-project"],
        answerPoints: ["要点丙"],
        reason: "   \n\t  ",
      },
    ]
    const source = writeFixture(dir, cases)
    const out = join(dir, "out.json")
    const result = runConverter(DEMO_CONVERTER, ["--source", source, "--out", out])
    assert.equal(result.status, 0, result.stderr)

    const goldens = readJson<Golden[]>(out)
    assert.equal(goldens.length, 3)
    const byId = new Map(goldens.map((g) => [g.name, g]))

    const present = byId.get("reason-present")!
    assert.ok(present.expected_output.includes("判定规则：reviewed reason。"))
    assert.ok(!present.expected_output.includes("  reviewed reason"))

    for (const id of ["reason-missing", "reason-blank"]) {
      const golden = byId.get(id)!
      assert.ok(!golden.expected_output.includes("判定规则"), id)
      assert.ok(golden.expected_output.includes("ANSWER_KIND_RULE"), id)
      assert.ok(golden.expected_output.includes(id === "reason-missing" ? "要点乙" : "要点丙"), id)
    }

    const raw = readFileSync(out, "utf8")
    assert.equal(raw.split("undefined").length - 1, 0)
  })
})

test("the committed v2 dataset converts with zero literal undefined", () => {
  const result = runConverter(DEMO_CONVERTER)
  assert.equal(result.status, 0, result.stderr)
  const raw = readFileSync(DEMO_OUTPUT, "utf8")
  assert.equal(raw.split("undefined").length - 1, 0)
})

// --- DR-01-AC03 ---------------------------------------------------------

function expectRejected(
  label: string,
  cases: GateCase[],
  expectedMessage: RegExp
): void {
  withTempDir((dir) => {
    const source = writeFixture(dir, cases)
    const out = join(dir, "out.json")
    const result = runConverter(DEMO_CONVERTER, ["--source", source, "--out", out])
    assert.notEqual(result.status, 0, `${label}: expected non-zero exit`)
    assert.match(result.stderr, expectedMessage, label)
    assert.ok(!existsSync(out), `${label}: no dataset may be written`)
    assert.ok(!result.stdout.includes("wrote"), `${label}: must not report success`)
  })
}

test("unknown kind fails closed before writing", () => {
  expectRejected(
    "unknown kind",
    [
      {
        id: "bad-kind",
        hard: false,
        kind: "chat" as GateCase["kind"],
        message: "未知类型",
        knowledgeBaseIds: ["kb-demo-project"],
      },
    ],
    /unknown kind/
  )
})

test("duplicate case ids fail closed before writing", () => {
  expectRejected(
    "duplicate id",
    [
      {
        id: "same-id",
        hard: false,
        kind: "refuse",
        message: "第一条",
        knowledgeBaseIds: ["kb-demo-project"],
      },
      {
        id: "same-id",
        hard: false,
        kind: "refuse",
        message: "第二条",
        knowledgeBaseIds: ["kb-demo-project"],
      },
    ],
    /duplicate case id/
  )
})

test("wrong scope types fail closed before writing", () => {
  const variants: unknown[] = ["kb-demo-project", null, { id: "kb" }, [1], ["kb", ""]]
  for (const [index, scope] of variants.entries()) {
    expectRejected(
      `scope variant ${index}`,
      [
        {
          id: `bad-scope-${index}`,
          hard: false,
          kind: "refuse",
          message: "作用域类型错误",
          knowledgeBaseIds: scope as string[],
        },
      ],
      /knowledgeBaseIds must be an array of non-empty strings/
    )
  }
})

test("answer cases without non-empty answer points fail closed before writing", () => {
  const variants: Array<{ label: string; answerPoints?: string[] }> = [
    { label: "missing", answerPoints: undefined },
    { label: "empty", answerPoints: [] },
    { label: "blank", answerPoints: ["   "] },
  ]
  for (const variant of variants) {
    expectRejected(
      `answer points ${variant.label}`,
      [
        {
          id: `answer-points-${variant.label}`,
          hard: false,
          kind: "answer",
          message: "答案要点缺失",
          knowledgeBaseIds: ["kb-demo-project"],
          answerPoints: variant.answerPoints,
        },
      ],
      /answer case requires non-empty answerPoints/
    )
  }
})

test("a tampered source digest fails closed before writing", () => {
  withTempDir((dir) => {
    const sourcePath = writeFixture(dir, [
      {
        id: "digest-source",
        hard: false,
        kind: "refuse",
        message: "摘要校验",
        knowledgeBaseIds: ["kb-demo-project"],
      },
    ])
    const tampered = readJson<{ cases: GateCase[]; digest: { value: string } }>(
      sourcePath
    )
    tampered.cases[0].message = "被篡改"
    writeFileSync(sourcePath, JSON.stringify(tampered, null, 2), "utf8")

    const out = join(dir, "out.json")
    const result = runConverter(DEMO_CONVERTER, [
      "--source",
      sourcePath,
      "--out",
      out,
    ])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /digest mismatch/)
    assert.ok(!existsSync(out))
  })
})

// --- DR-01-AC04 ---------------------------------------------------------

test("a missing scope stays omitted while an explicit empty scope stays []", () => {
  withTempDir((dir) => {
    const cases: GateCase[] = [
      {
        id: "scope-default",
        hard: false,
        kind: "refuse",
        message: "缺省作用域",
      },
      {
        id: "scope-explicit-empty",
        hard: false,
        kind: "refuse",
        message: "显式空作用域",
        knowledgeBaseIds: [],
      },
      {
        id: "scope-explicit",
        hard: false,
        kind: "refuse",
        message: "显式作用域",
        knowledgeBaseIds: ["kb-demo-policy"],
      },
    ]
    const source = writeFixture(dir, cases)
    const out = join(dir, "out.json")
    const result = runConverter(DEMO_CONVERTER, ["--source", source, "--out", out])
    assert.equal(result.status, 0, result.stderr)

    const goldens = readJson<Golden[]>(out)
    const byId = new Map(goldens.map((g) => [g.name, g]))
    assert.ok(!Object.hasOwn(byId.get("scope-default")!.additional_metadata, "scope"))
    assert.deepEqual(byId.get("scope-explicit-empty")!.additional_metadata.scope, [])
    assert.deepEqual(byId.get("scope-explicit")!.additional_metadata.scope, [
      "kb-demo-policy",
    ])
  })
})

test("real v2 keeps the explicit empty scope of hard-03 as []", () => {
  const result = runConverter(DEMO_CONVERTER)
  assert.equal(result.status, 0, result.stderr)
  const goldens = readJson<Golden[]>(DEMO_OUTPUT)
  const hard03 = goldens.find((g) => g.name === "hard-03-empty-scope-refuse")
  assert.ok(hard03)
  assert.deepEqual(hard03.additional_metadata.scope, [])
})

// --- DR-01-AC05 ---------------------------------------------------------

test("memory-not-cited forbids memory in references only and keeps owner viewing allowed", () => {
  const result = runConverter(DEMO_CONVERTER)
  assert.equal(result.status, 0, result.stderr)
  const goldens = readJson<Golden[]>(DEMO_OUTPUT)
  const memory = goldens.find((g) => g.name === "hard-06-memory-never-cited")
  assert.ok(memory)

  assert.ok(memory.expected_output.includes("引用列表中绝不能出现长期记忆内容"))
  assert.ok(memory.expected_output.includes("主动查看自己的长期记忆"))
  for (const forbidden of [
    "必须引用文档",
    "必须引用资料",
    "禁止本人查看",
    "不得查看自己的记忆",
  ]) {
    assert.ok(
      !memory.expected_output.includes(forbidden),
      `memory rule must not contain ${forbidden}`
    )
  }

  assert.equal(memory.additional_metadata.forbidden_reference_content, "演示记忆")
  const constraints = memory.additional_metadata.memory_constraints
  assert.ok(constraints)
  assert.ok(constraints.citationRule.includes("绝不能出现在 references 列表中"))
  assert.ok(constraints.viewingRule.includes("允许所有者主动查看"))
})

test("memory-not-cited without the citation constraint fails closed", () => {
  expectRejected(
    "memory without forbidden content",
    [
      {
        id: "memory-missing-content",
        hard: true,
        kind: "memory-not-cited",
        message: "记忆约束缺失",
        knowledgeBaseIds: ["kb-demo-project"],
        memoryConstraints: CONTRACT.memoryConstraints,
      },
    ],
    /requires forbiddenReferenceContent/
  )
  expectRejected(
    "memory without case constraints",
    [
      {
        id: "memory-missing-constraints",
        hard: true,
        kind: "memory-not-cited",
        message: "记忆约束缺失",
        knowledgeBaseIds: ["kb-demo-project"],
        forbiddenReferenceContent: "演示记忆",
      },
    ],
    /requires memoryConstraints/
  )
})

// --- DR-01-AC07 ---------------------------------------------------------

test("expected_output is composed from kind rule, reason and every answer point, in order", () => {
  withTempDir((dir) => {
    const cases: GateCase[] = [
      {
        id: "composition",
        hard: false,
        kind: "answer",
        message: "组合顺序",
        knowledgeBaseIds: ["kb-demo-project"],
        answerPoints: ["要点一", "要点二", "要点三"],
        reason: "reviewed reason",
      },
    ]
    const source = writeFixture(dir, cases)
    const out = join(dir, "out.json")
    const result = runConverter(DEMO_CONVERTER, ["--source", source, "--out", out])
    assert.equal(result.status, 0, result.stderr)

    const [golden] = readJson<Golden[]>(out)
    const text = golden.expected_output
    const ruleAt = text.indexOf("ANSWER_KIND_RULE")
    const reasonAt = text.indexOf("判定规则：reviewed reason")
    const pointsAt = text.indexOf("标准答案要点（须全部出现）：要点一；要点二；要点三")
    assert.ok(ruleAt === 0, "kind rule must lead")
    assert.ok(reasonAt > ruleAt, "reason follows the kind rule")
    assert.ok(pointsAt > reasonAt, "answer points follow the reason")
    assert.ok(text.endsWith("。"))
  })
})

test("v2 states inline citation, coverage-gap refusal and the reviewed case-10 prohibition", () => {
  const result = runConverter(DEMO_CONVERTER)
  assert.equal(result.status, 0, result.stderr)
  const source = readJson<GateDataset>(V2_PATH)
  const goldens = readJson<Golden[]>(DEMO_OUTPUT)
  const byId = new Map(goldens.map((g) => [g.name, g]))

  for (const golden of goldens.filter(
    (g) => g.additional_metadata.kind === "answer"
  )) {
    assert.ok(golden.expected_output.startsWith(source.contract.kindRules.answer))
    assert.ok(golden.expected_output.includes("行内引用"))
    assert.ok(golden.expected_output.includes("[cite:证据ID]"))
  }

  const outOfDomain = byId.get("hard-05-no-fabrication")!
  assert.ok(outOfDomain.expected_output.includes("覆盖缺口"))
  assert.ok(outOfDomain.expected_output.includes("不得以泛泛澄清代替拒答"))

  const case10 = byId.get("case-10-fusion-rerank")!
  assert.ok(case10.expected_output.includes("禁止断言（出现任一即判失败）"))
  assert.ok(case10.expected_output.includes("未配置重排因此不会精排"))
  assert.ok(case10.additional_metadata.prohibited_assertions?.includes("未配置重排因此不会精排"))
  assert.ok(case10.expected_output.includes("精排"))
})

// --- DR-01-AC06 ---------------------------------------------------------

test("both converters keep disjoint outputs and preserve v1 and the v2 digest", () => {
  const v1Before = readFileSync(V1_PATH)
  const v1HashBefore = createHash("sha256").update(v1Before).digest("hex")

  const demoFirst = runConverter(DEMO_CONVERTER)
  assert.equal(demoFirst.status, 0, demoFirst.stderr)
  const demoBefore = readFileSync(DEMO_OUTPUT)

  withTempDir((dir) => {
    const conversationalOut = join(dir, ".conversational-dataset.json")
    const conversational = runConverter(CONVERSATIONAL_CONVERTER, [
      "--out",
      conversationalOut,
    ])
    assert.equal(conversational.status, 0, conversational.stderr)
    assert.ok(existsSync(conversationalOut))
    assert.deepEqual(readFileSync(DEMO_OUTPUT), demoBefore)

    const conversationalGoldens = readJson<Array<Record<string, unknown>>>(
      conversationalOut
    )
    assert.ok(conversationalGoldens.length > 0)
    assert.ok(Object.hasOwn(conversationalGoldens[0], "scenario"))
    assert.ok(Object.hasOwn(conversationalGoldens[0], "expected_outcome"))

    const conversationalBefore = readFileSync(conversationalOut)
    const demoAgain = runConverter(DEMO_CONVERTER)
    assert.equal(demoAgain.status, 0, demoAgain.stderr)
    assert.deepEqual(
      readFileSync(conversationalOut),
      conversationalBefore,
      "the demo converter must not touch the conversational output"
    )
  })

  const v1HashAfter = createHash("sha256").update(readFileSync(V1_PATH)).digest("hex")
  assert.equal(v1HashAfter, v1HashBefore, "v1 source must stay byte-identical")

  const source = readJson<GateDataset>(V2_PATH)
  assert.equal(source.digest.value, datasetDigest(source))
  const goldens = readJson<Golden[]>(DEMO_OUTPUT)
  for (const golden of goldens) {
    assert.equal(golden.additional_metadata.contract_version, 2)
    assert.equal(
      golden.additional_metadata.source_digest,
      `sha256:${source.digest.value}`
    )
  }
})
