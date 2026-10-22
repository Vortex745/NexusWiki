/**
 * DR-03: the release gate consumes the same v2 standard as the Python eval.
 *
 * The seam is the gate's caller-visible decision: load the versioned dataset,
 * judge one raw chat result, and summarize the run under the unchanged
 * 6-hard / 10-of-14 / 16-of-20 thresholds. No network is used.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import {
  buildReport,
  judgeCase,
  loadDataset,
  summarizeResults,
  type CaseResult,
  type DoneEvent,
  type GateCase,
  type GateDataset,
} from "../../scripts/release-quality-gate"

const ROOT = resolve(__dirname, "..", "..")
const V2_PATH = join(ROOT, "golden", "demo-release-cases.v2.json")
const V1_PATH = join(ROOT, "golden", "demo-release-cases.v1.json")

const V2 = loadDataset(V2_PATH)
const BY_ID = new Map(V2.cases.map((cs) => [cs.id, cs]))

function gateCase(id: string): GateCase {
  const cs = BY_ID.get(id)
  assert.ok(cs, `missing v2 case ${id}`)
  return cs
}

function ref(id = "ev_test", overrides: Record<string, string> = {}) {
  return { id, title: "", excerpt: "", ...overrides }
}

function done(
  reply: string,
  status = "completed",
  references: DoneEvent["references"] = [ref()]
): DoneEvent {
  return { reply, status, references }
}

function answerReply(points: string[], cite = "ev_test"): string {
  return `${points.join("；")} [cite:${cite}]`
}

function syntheticAnswer(
  points: string[] | undefined,
  overrides: Partial<GateCase> = {}
): GateCase {
  return {
    id: "synthetic-answer",
    hard: false,
    kind: "answer",
    message: "测试问题",
    knowledgeBaseIds: ["kb-demo-project"],
    answerPoints: points,
    ...overrides,
  }
}

// --- v2 source -----------------------------------------------------------

test("the gate loads the v2 standard and keeps the original thresholds", () => {
  assert.equal(V2.version, 2)
  assert.equal(V2.cases.length, 20)
  assert.equal(V2.cases.filter((cs) => cs.hard).length, 6)
  assert.equal(V2.cases.filter((cs) => !cs.hard).length, 14)
  assert.equal(V2.cases.filter((cs) => cs.kind === "answer").length, 15)
  assert.deepEqual(V2.rules, {
    hardMustPass: "all",
    othersMinPass: 10,
    overallMinPass: 16,
  })
})

test("v1 stays on disk but is not silently consumed as the v2 standard", () => {
  assert.ok(existsSync(V1_PATH))
  const v1 = JSON.parse(readFileSync(V1_PATH, "utf8")) as { version: number }
  assert.equal(v1.version, 1)
  assert.throws(() => loadDataset(V1_PATH), /v2 standard/)
})

test("a v2 case may carry empty optional arrays without being rejected", () => {
  const base = {
    schema: "demo-release-cases",
    version: 2,
    contract: V2.contract,
    rules: V2.rules,
  }
  const dir = mkdtempSync(join(tmpdir(), "dr03-gate-valid-"))
  try {
    const path = join(dir, "valid.json")
    writeFileSync(
      path,
      JSON.stringify(
        {
          ...base,
          cases: [
            {
              id: "empty-optionals",
              hard: false,
              kind: "refuse",
              message: "问题",
              knowledgeBaseIds: [],
              answerPoints: [],
              prohibitedAssertions: [],
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    )
    const dataset = loadDataset(path)
    assert.equal(dataset.cases.length, 1)
    assert.deepEqual(dataset.cases[0].knowledgeBaseIds, [])
    assert.deepEqual(dataset.cases[0].answerPoints, [])
    assert.deepEqual(dataset.cases[0].prohibitedAssertions, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the gate fails closed on an invalid v2 case before any request", () => {
  const base = {
    schema: "demo-release-cases",
    version: 2,
    contract: V2.contract,
    rules: V2.rules,
  }
  const dir = mkdtempSync(join(tmpdir(), "dr03-gate-"))
  try {
    const variants: Array<{ label: string; cases: unknown[]; expected: RegExp }> = [
      {
        label: "answer without points",
        cases: [
          {
            id: "bad-answer",
            hard: false,
            kind: "answer",
            message: "问题",
            knowledgeBaseIds: ["kb-demo-project"],
          },
        ],
        expected: /answerPoints/,
      },
      {
        label: "duplicate ids",
        cases: [
          {
            id: "same",
            hard: false,
            kind: "refuse",
            message: "一",
            knowledgeBaseIds: ["kb-demo-project"],
          },
          {
            id: "same",
            hard: false,
            kind: "refuse",
            message: "二",
            knowledgeBaseIds: ["kb-demo-project"],
          },
        ],
        expected: /duplicate case id/,
      },
      {
        label: "unknown kind",
        cases: [
          {
            id: "bad-kind",
            hard: false,
            kind: "chat",
            message: "问题",
            knowledgeBaseIds: ["kb-demo-project"],
          },
        ],
        expected: /unknown kind/,
      },
      {
        label: "memory without forbidden content",
        cases: [
          {
            id: "bad-memory",
            hard: true,
            kind: "memory-not-cited",
            message: "问题",
            knowledgeBaseIds: ["kb-demo-project"],
          },
        ],
        expected: /forbiddenReferenceContent/,
      },
      {
        label: "malformed prohibited list",
        cases: [
          {
            id: "bad-prohibited",
            hard: false,
            kind: "answer",
            message: "问题",
            knowledgeBaseIds: ["kb-demo-project"],
            answerPoints: ["要点"],
            prohibitedAssertions: "不是数组",
          },
        ],
        expected: /prohibitedAssertions/,
      },
    ]

    for (const variant of variants) {
      const path = join(dir, `${variant.label.replace(/\W+/g, "-")}.json`)
      writeFileSync(
        path,
        JSON.stringify({ ...base, cases: variant.cases }, null, 2),
        "utf8"
      )
      assert.throws(() => loadDataset(path), variant.expected, variant.label)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- answer cases --------------------------------------------------------

test("hard-04 requires 30 natural days and an inline citation that resolves", () => {
  const cs = gateCase("hard-04-faq-exact-answer")
  const faq = ref("ev_faq", {
    title: "FAQ：退货期限是多久？",
    excerpt:
      "问题：退货期限是多久？\n标准答案：标准商品自签收之日起 30 个自然日内可申请退货。",
  })

  const good = judgeCase(
    cs,
    done("标准商品自签收之日起 30 个自然日内可申请退货 [cite:ev_faq]。", "completed", [faq]),
    null
  )
  assert.equal(good.pass, true, good.detail)
  assert.equal(good.missingAnswerPoints, undefined)

  // The live FAQ runner returns the standard answer without an inline cite:
  // the v2 gate must fail it, not excuse it.
  const liveShaped = judgeCase(
    cs,
    done("标准商品自签收之日起 30 个自然日内可申请退货（演示标准答案，引用虚构政策文档）。", "completed", [faq]),
    null
  )
  assert.equal(liveShaped.pass, false)
  assert.match(liveShaped.detail, /no inline \[cite:<id>\]/)

  const wrongUnit = judgeCase(
    cs,
    done("标准商品自签收之日起 30 个工作日内可申请退货 [cite:ev_faq]。", "completed", [faq]),
    null
  )
  assert.equal(wrongUnit.pass, false)
  assert.deepEqual(wrongUnit.missingAnswerPoints, ["30 个自然日"])
})

test("missing points, wrong numbers, wrong units and negated conclusions fail", () => {
  const cs = syntheticAnswer(["30 个自然日", "7 个工作日"])
  const good = judgeCase(
    cs,
    done(
      "标准商品自签收之日起 30 个自然日内可申请退货，退款 7 个工作日内原路退回 [cite:ev_test]。"
    ),
    null
  )
  assert.equal(good.pass, true, good.detail)

  const missing = judgeCase(
    cs,
    done("标准商品自签收之日起 30 个自然日内可申请退货 [cite:ev_test]。"),
    null
  )
  assert.equal(missing.pass, false)
  assert.deepEqual(missing.missingAnswerPoints, ["7 个工作日"])

  const wrongNumber = judgeCase(
    cs,
    done(
      "标准商品自签收之日起 31 个自然日内可申请退货，退款 7 个工作日内原路退回 [cite:ev_test]。"
    ),
    null
  )
  assert.equal(wrongNumber.pass, false)
  assert.deepEqual(wrongNumber.missingAnswerPoints, ["30 个自然日"])

  const wrongUnit = judgeCase(
    cs,
    done(
      "标准商品自签收之日起 30 个工作日内可申请退货，退款 7 个工作日内原路退回 [cite:ev_test]。"
    ),
    null
  )
  assert.equal(wrongUnit.pass, false)
  assert.deepEqual(wrongUnit.missingAnswerPoints, ["30 个自然日"])

  const negated = judgeCase(
    syntheticAnswer(["不影响"]),
    done("未配置 Langfuse 会影响功能 [cite:ev_test]。"),
    null
  )
  assert.equal(negated.pass, false)
  assert.deepEqual(negated.missingAnswerPoints, ["不影响"])
})

test("case-10 rejects every reviewed inference and accepts the correct gap sample", () => {
  const cs = gateCase("case-10-fusion-rerank")
  assert.ok(cs.prohibitedAssertions && cs.prohibitedAssertions.length >= 5)

  const correct = judgeCase(
    cs,
    done(
      "四路结果经 RRF 融合后，如配置了专用重排模型则再做一次精排 [cite:ev_test]。文档未说明未配置时的行为，故此处不作推断。"
    ),
    null
  )
  assert.equal(correct.pass, true, correct.detail)

  for (const assertion of cs.prohibitedAssertions ?? []) {
    const bad = judgeCase(
      cs,
      done(`四路结果融合后还会精排 [cite:ev_test]。${assertion}。`),
      null
    )
    assert.equal(bad.pass, false, assertion)
    assert.match(bad.detail, /prohibited assertion/)
  }
})

test("inline citations must be exact and resolve to a returned reference", () => {
  const cs = syntheticAnswer(["精排"])

  assert.equal(
    judgeCase(cs, done("精排 [cite:ev_1]", "completed", [ref("ev_1")]), null).pass,
    true
  )
  assert.equal(
    judgeCase(cs, done("精排 [cite:ev_missing]", "completed", [ref("ev_1")]), null).pass,
    false
  )
  assert.match(
    judgeCase(cs, done("精排 [cite:ev_missing]", "completed", [ref("ev_1")]), null).detail,
    /not in the returned references/
  )
  assert.match(
    judgeCase(cs, done("精排 [cite: ev_1]", "completed", [ref("ev_1")]), null).detail,
    /malformed inline citation/
  )
  assert.match(
    judgeCase(cs, done("精排 [cite:]", "completed", [ref("ev_1")]), null).detail,
    /malformed inline citation/
  )
  // A references list alone is not an inline citation.
  assert.match(
    judgeCase(cs, done("精排（见右侧参考资料）", "completed", [ref("ev_1")]), null).detail,
    /no inline \[cite:<id>\]/
  )
})

test("answer cases fail closed without points or with a non-answer status", () => {
  const noPoints = judgeCase(
    syntheticAnswer(undefined),
    done("随便回答 [cite:ev_test]"),
    null
  )
  assert.equal(noPoints.pass, false)
  assert.match(noPoints.detail, /requires non-empty answerPoints/)

  const emptyPoints = judgeCase(
    syntheticAnswer([]),
    done("随便回答 [cite:ev_test]"),
    null
  )
  assert.equal(emptyPoints.pass, false)

  const clarified = judgeCase(
    syntheticAnswer(["精排"]),
    done("精排 [cite:ev_test]", "clarification_required"),
    null
  )
  assert.equal(clarified.pass, false)
  assert.match(clarified.detail, /terminal status clarification_required/)
})

test("forbidden reference content fails an answer case", () => {
  const cs = syntheticAnswer(["精排"], {
    forbiddenReferenceContent: "演示记忆",
  })
  const verdict = judgeCase(
    cs,
    done("精排 [cite:ev_test]", "completed", [
      ref("ev_test", { excerpt: "演示记忆：这一段不得成为引用" }),
    ]),
    null
  )
  assert.equal(verdict.pass, false)
  assert.match(verdict.detail, /forbidden reference content/)
})

// --- refuse cases --------------------------------------------------------

test("a generic clarification does not pass hard-05", () => {
  const cs = gateCase("hard-05-no-fabrication")
  assert.ok(cs.knowledgeBaseIds && cs.knowledgeBaseIds.length > 0)

  const clarification = judgeCase(
    cs,
    done("请提供更多信息：您指的是哪家公司，或在哪个交易所上市？", "clarification_required", []),
    null
  )
  assert.equal(clarification.pass, false)
  assert.match(clarification.detail, /clarification-only/)

  const clarificationWithPhrase = judgeCase(
    cs,
    done("无法回答，请提供更多信息后我再继续。", "clarification_required", []),
    null
  )
  assert.equal(clarificationWithPhrase.pass, false)
  assert.match(clarificationWithPhrase.detail, /clarification-only/)

  const completedClarification = judgeCase(
    cs,
    done("请补充公司全称，我才能继续。", "completed", []),
    null
  )
  assert.equal(completedClarification.pass, false)
  assert.match(completedClarification.detail, /clarification-only/)

  const honest = judgeCase(
    cs,
    done("知识库中没有该公司股票代码的信息，无法回答。", "completed", []),
    null
  )
  assert.equal(honest.pass, true, honest.detail)
})

test("refuse cases require honest gap evidence, not a fabricated answer", () => {
  const cs = gateCase("hard-01-isolation-policy-blocked")
  assert.equal(
    judgeCase(cs, done("未找到相关证据，无法回答。", "completed", []), null).pass,
    true
  )
  assert.equal(
    judgeCase(cs, done("知识库中没有相关信息。", "insufficient_retrieval", []), null).pass,
    true
  )
  assert.equal(
    judgeCase(cs, done("年假满一年 5 天。", "completed", [ref()]), null).pass,
    false
  )
  assert.equal(
    judgeCase(cs, done("模型服务暂时不可用。", "provider_error", []), null).pass,
    false
  )
})

test("an explicit empty scope returns no references and no inline citations", () => {
  const cs = gateCase("hard-03-empty-scope-refuse")
  assert.deepEqual(cs.knowledgeBaseIds, [])

  assert.equal(
    judgeCase(cs, done("未找到相关证据，无法回答。", "completed", []), null).pass,
    true
  )
  const withReference = judgeCase(
    cs,
    done("未找到相关证据，无法回答。", "completed", [ref()]),
    null
  )
  assert.equal(withReference.pass, false)
  assert.match(withReference.detail, /empty scope/)

  const withCite = judgeCase(
    cs,
    done("未找到相关证据 [cite:ev_test]。", "completed", []),
    null
  )
  assert.equal(withCite.pass, false)
  assert.match(withCite.detail, /empty scope/)
})

// --- memory-not-cited ----------------------------------------------------

test("memory is never cited, but the owner may view it without a citation", () => {
  const cs = gateCase("hard-06-memory-never-cited")

  const cited = judgeCase(
    cs,
    done("提醒如下。", "completed", [
      ref("ev_memory", { excerpt: "演示记忆：本演示的知识库包含虚构政策文档。" }),
    ]),
    null
  )
  assert.equal(cited.pass, false)
  assert.match(cited.detail, /memory content appeared in the references/)

  const viewing = judgeCase(
    cs,
    done(
      "你的长期记忆里记录的是：演示记忆：本演示的知识库包含虚构政策文档。",
      "completed",
      []
    ),
    null
  )
  assert.equal(viewing.pass, true, viewing.detail)
})

// --- thresholds and output shape -----------------------------------------

function result(id: string, hard: boolean, pass: boolean): CaseResult {
  return {
    id,
    hard,
    kind: "answer",
    pass,
    terminalStatus: "completed",
    replyExcerpt: "",
    referenceCount: 1,
    detail: pass ? "ok" : "FAIL",
  }
}

test("thresholds stay 6-hard all, 10-of-14 others and 16-of-20 overall", () => {
  const hard = Array.from({ length: 6 }, (_, i) => result(`hard-${i}`, true, true))
  const others = Array.from({ length: 14 }, (_, i) => result(`other-${i}`, false, i < 10))

  const boundary = summarizeResults([...hard, ...others], V2.rules)
  assert.equal(boundary.passed, true)
  assert.deepEqual(boundary.summary, {
    hardPassed: 6,
    hardTotal: 6,
    othersPassed: 10,
    othersTotal: 14,
    overallPassed: 16,
    overallTotal: 20,
    gate: "passed",
  })

  const oneHardShort = summarizeResults(
    [result("hard-0", true, false), ...hard.slice(1), ...others.map((r) => ({ ...r, pass: true }))],
    V2.rules
  )
  assert.equal(oneHardShort.passed, false, "all hard cases must pass")

  const othersShort = summarizeResults(
    [...hard, ...others.map((r, i) => ({ ...r, pass: i < 9 }))],
    V2.rules
  )
  assert.equal(othersShort.passed, false, "9 of 14 others is below the threshold")
  assert.equal(othersShort.summary.overallPassed, 15)
})

test("the results report keeps the existing shape and records dataset v2", () => {
  const results = [
    result("hard-04-faq-exact-answer", true, false),
    result("case-10-fusion-rerank", false, true),
  ]
  const report = buildReport(V2, results, "2026-10-22T00:00:00.000Z")

  assert.deepEqual(Object.keys(report).sort(), [
    "checkedAt",
    "datasetVersion",
    "results",
    "rules",
    "schema",
    "summary",
  ])
  assert.equal(report.schema, "release-quality-results")
  assert.equal(report.datasetVersion, 2)
  assert.equal(report.checkedAt, "2026-10-22T00:00:00.000Z")
  assert.deepEqual(report.rules, V2.rules)
  assert.deepEqual(report.summary, {
    hardPassed: 0,
    hardTotal: 1,
    othersPassed: 1,
    othersTotal: 1,
    overallPassed: 1,
    overallTotal: 2,
    gate: "failed",
  })
  assert.deepEqual(Object.keys(results[0]).sort(), [
    "detail",
    "hard",
    "id",
    "kind",
    "pass",
    "referenceCount",
    "replyExcerpt",
    "terminalStatus",
  ])
})
