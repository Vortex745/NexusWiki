import assert from "node:assert/strict"
import test from "node:test"
import { EVAL_TEXT_RULE_VERSION, normalizeEvalText, tokenizeEvalText } from "./text_rules"
import {
  bleu,
  bleuMetrics,
  EVAL_BLEU_KEYS,
  EVAL_BLEU_TEXT_RULE_VERSION,
  EVAL_BLEU_VERSION,
  EVAL_ROUGE_KEYS,
  EVAL_ROUGE_VERSION,
  notApplicableBleuMetrics,
  notApplicableRougeMetrics,
  rougeMetrics,
} from "./text_metrics"

/** 6-decimal comparison helper so hand-computed values can be asserted exactly. */
const round6 = (value: number) => Number(value.toFixed(6))

// ---------------------------------------------------------------------------
// Fixed text rules (shared with ROUGE in ticket 08)
// ---------------------------------------------------------------------------

test("the text rules are version-stamped and dependency-free", () => {
  assert.equal(EVAL_TEXT_RULE_VERSION, "eval-text-v1")
  assert.equal(EVAL_BLEU_VERSION, "eval-bleu-v1")
})

test("normalization folds case and punctuation; tokenization is word level for latin and character level for CJK", () => {
  assert.equal(normalizeEvalText("Hello, World!"), "hello world")
  assert.deepEqual(tokenizeEvalText("Hello, world"), ["hello", "world"])
  assert.deepEqual(tokenizeEvalText("退款政策"), ["退", "款", "政", "策"])
  assert.deepEqual(tokenizeEvalText("退款，需要 3 天。"), tokenizeEvalText("退款需要3天"))
  assert.deepEqual(tokenizeEvalText("退款，需要 3 天。"), ["退", "款", "需", "要", "3", "天"])
  assert.deepEqual(tokenizeEvalText("café münchen"), ["café", "münchen"], "accented latin stays word level")
})

test("punctuation-only and emoji-only text carries no tokens", () => {
  assert.deepEqual(tokenizeEvalText("！！……  "), [])
  assert.deepEqual(tokenizeEvalText("😀🎉"), [])
})

// ---------------------------------------------------------------------------
// BLEU-1/2/4 — fixed expected values
// ---------------------------------------------------------------------------

const LONG = "退款在审核通过后 3 个工作日内按原支付路径返还，遇节假日顺延。"

test("identical long text scores exactly 1 on all three orders", () => {
  const metrics = bleuMetrics(LONG, LONG)
  assert.equal(metrics["bleu-1"], 1)
  assert.equal(metrics["bleu-2"], 1)
  assert.equal(metrics["bleu-4"], 1)
})

test("mixed Chinese/English with different case, spacing and punctuation still matches perfectly", () => {
  const metrics = bleuMetrics("退款 REFUND 需要 3天", "退款 refund 需要 3 天。")
  assert.equal(metrics["bleu-1"], 1)
  assert.equal(metrics["bleu-2"], 1)
  assert.equal(metrics["bleu-4"], 1)
})

test("a hand-computed partial overlap gives the formula's exact values (no smoothing involved)", () => {
  // hyp and ref share ten of the eleven tokens in order; every order keeps one
  // wrong 2nd/3rd/4th-gram, and the lengths are equal so BP = 1.
  const hypothesis = "the cat sat on the roof"
  const reference = "the cat sat on the mat"

  const metrics = bleuMetrics(hypothesis, reference)
  const round = (value: number | null) => Number(value!.toFixed(6))
  assert.equal(round(metrics["bleu-1"]), round(5 / 6))
  assert.equal(round(metrics["bleu-2"]), round(Math.sqrt((5 / 6) * (4 / 5))))
  assert.equal(round(metrics["bleu-4"]), round(Math.pow(1 / 3, 1 / 4)))
  assert.ok(
    metrics["bleu-1"]! >= metrics["bleu-2"]! && metrics["bleu-2"]! >= metrics["bleu-4"]!,
    "higher orders cannot score above lower orders for the same pair"
  )
})

test("a shorter hypothesis is penalised by the brevity penalty", () => {
  const metrics = bleuMetrics("the cat sat", "the cat sat on the mat")
  const round = (value: number | null) => Number(value!.toFixed(6))
  assert.equal(round(metrics["bleu-1"]), round(Math.exp(-1)), "1 - 6/3 = -1 under the exponential")
  assert.equal(round(metrics["bleu-2"]), round(Math.exp(-1)))
  assert.equal(metrics["bleu-4"], 0, "three tokens cannot form a 4-gram")
})

test("short identical text has its own fixed progression", () => {
  // A truly single token has no bigram at all → only BLEU-1 is defined.
  const oneToken = bleuMetrics("refund", "refund")
  assert.equal(oneToken["bleu-1"], 1)
  assert.equal(oneToken["bleu-2"], 0, "a single token has no bigram to score")
  assert.equal(oneToken["bleu-4"], 0)

  // Two CJK characters are two tokens: exactly one bigram, still no 4-gram.
  const twoTokens = bleuMetrics("退款", "退款")
  assert.equal(twoTokens["bleu-1"], 1)
  assert.equal(twoTokens["bleu-2"], 1)
  assert.equal(twoTokens["bleu-4"], 0, "two tokens cannot form a 4-gram")

  // Four tokens fill every order.
  const fourTokens = bleuMetrics("退款到账", "退款到账")
  assert.equal(fourTokens["bleu-4"], 1)
})

test("completely unrelated answers score exactly 0 (order 1 is never smoothed)", () => {
  const metrics = bleuMetrics("苹果香蕉", "退款政策")
  assert.equal(metrics["bleu-1"], 0)
  assert.equal(metrics["bleu-2"], 0)
  assert.equal(metrics["bleu-4"], 0)
})

test("smoothing keeps higher orders from collapsing on partial matches", () => {
  // Shares the bigram 退款 but no 3-gram: order ≥ 2 falls back to 1/(total+1).
  const metrics = bleuMetrics("退款流程", "退款政策")
  assert.ok(metrics["bleu-2"]! > 0, "the shared bigram keeps BLEU-2 alive")
  assert.ok(metrics["bleu-4"]! > 0, "a zero 4-gram count is smoothed, not zeroed")
  assert.equal(
    Number(metrics["bleu-4"]!.toFixed(6)),
    Number(metrics["bleu-2"]!.toFixed(6)),
    "here the smoothed rates coincide: (1/6)^(1/2) = (1/36)^(1/4)"
  )
})

test("empty texts are honest: no reference → not applicable, no answer → 0", () => {
  assert.equal(bleu("退款到账", "", 1), null, "nothing to compare against")
  assert.equal(bleu("", LONG, 1), 0, "an empty reply scores 0, never NaN")
  assert.equal(bleu("   ", LONG, 4), 0)
  assert.deepEqual(notApplicableBleuMetrics(), { "bleu-1": null, "bleu-2": null, "bleu-4": null })
})

// ---------------------------------------------------------------------------
// Ticket 08 — ROUGE-1/2/L F1 on the same token sequences
// ---------------------------------------------------------------------------

test("the ROUGE metrics are version-stamped and reuse the frozen text rules", () => {
  assert.equal(EVAL_ROUGE_VERSION, "eval-rouge-v1")
  assert.equal(EVAL_BLEU_TEXT_RULE_VERSION, EVAL_TEXT_RULE_VERSION)
  assert.deepEqual(Object.keys(rougeMetrics("a", "a")), [...EVAL_ROUGE_KEYS])
})

test("identical text scores 1 on all three ROUGE metrics, in any script", () => {
  for (const text of [LONG, "refund policy", "退款 REFUND 需要 3 天。"]) {
    const metrics = rougeMetrics(text, text)
    assert.equal(metrics["rouge-1"], 1, `rouge-1 for ${text}`)
    assert.equal(metrics["rouge-2"], 1, `rouge-2 for ${text}`)
    assert.equal(metrics["rouge-l"], 1, `rouge-l for ${text}`)
  }
})

test("a hand-computed partial overlap gives the F1 values exactly", () => {
  // Same pair as the BLEU test: one wrong token at the end, equal lengths.
  const metrics = rougeMetrics("the cat sat on the roof", "the cat sat on the mat")
  const round = (value: number | null) => Number(value!.toFixed(6))
  assert.equal(round(metrics["rouge-1"]), round(5 / 6), "5 shared unigrams of 6")
  assert.equal(round(metrics["rouge-2"]), round(4 / 5), "4 shared bigrams of 5")
  assert.equal(round(metrics["rouge-l"]), round(5 / 6), "LCS = 5 of 6 tokens")
})

test("repetition in the answer cannot inflate the score (clipped overlap)", () => {
  const metrics = rougeMetrics("退款 退款 退款", "退款")
  // Six tokens repeat the two reference tokens three times: the clipped
  // overlap stays 2, so precision is 1/3 and recall 1.
  assert.equal(round6(metrics["rouge-1"]!), 0.5, "P = 2/6, R = 2/2 → F1 = 0.5")
  assert.equal(round6(metrics["rouge-l"]!), 0.5, "the LCS is the two reference tokens")
})

test("word order changes keep ROUGE-1 but empty ROUGE-2", () => {
  const metrics = rougeMetrics("alpha beta gamma", "gamma beta alpha")
  assert.equal(metrics["rouge-1"], 1, "same unigrams")
  assert.equal(metrics["rouge-2"], 0, "no bigram is shared once the order flips")
  assert.equal(round6(metrics["rouge-l"]!), round6(1 / 3), "LCS = 1 of 3 tokens")
})

test("multi-sentence answers are compared as ONE sequence (no sentence splitting)", () => {
  const metrics = rougeMetrics("退款需要3天。配送需要2天。", "退款需要3天。配送需要4天。")
  assert.ok(metrics["rouge-1"]! > metrics["rouge-2"]!, "shared unigrams outweigh shared bigrams")
  assert.ok(metrics["rouge-l"]! > 0.5, "one shared sentence keeps the long common subsequence large")
  assert.equal(
    round6(metrics["rouge-1"]!),
    round6(11 / 12),
    "punctuation-aware normalization leaves 11 of 12 tokens matching"
  )
})

test("empty texts are honest: no reference → not applicable, no answer → 0", () => {
  for (const key of EVAL_ROUGE_KEYS) {
    assert.equal(rougeMetrics("退款到账", "")[key], null, `${key} without a reference`)
    assert.equal(rougeMetrics("", LONG)[key], 0, `${key} with an empty answer`)
  }
  assert.deepEqual(notApplicableRougeMetrics(), { "rouge-1": null, "rouge-2": null, "rouge-l": null })
})

test("no ROUGE input produces NaN, Infinity or a value outside [0, 1]", () => {
  const hypotheses = ["", " ", "😀", "退款", LONG, "退款 退款 退款 退款"]
  const references = ["", " ", "退款", LONG, "the cat sat on the mat"]
  for (const hypothesis of hypotheses) {
    for (const reference of references) {
      for (const key of EVAL_ROUGE_KEYS) {
        const value = rougeMetrics(hypothesis, reference)[key]
        if (value === null) continue
        assert.ok(Number.isFinite(value), `${key} must be finite`)
        assert.ok(value >= 0 && value <= 1, `${key} must stay within [0, 1]`)
      }
    }
  }
})

test("no input produces NaN or Infinity", () => {
  const hypotheses = ["", " ", "😀", "！！！", "退款", LONG, LONG.repeat(3)]
  const references = ["", " ", "😀", "退款", LONG]
  for (const hypothesis of hypotheses) {
    for (const reference of references) {
      for (const key of EVAL_BLEU_KEYS) {
        const value = bleuMetrics(hypothesis, reference)[key]
        if (value === null) continue
        assert.ok(Number.isFinite(value), `${key} must be finite for ${JSON.stringify(hypothesis)}`)
        assert.ok(value >= 0 && value <= 1, `${key} must stay within [0, 1]`)
      }
    }
  }
})
