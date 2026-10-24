import assert from "node:assert/strict"
import test from "node:test"
import type { Chunk, RetrievalResult } from "../../types"
import { ContextAssemblerImpl } from "./assembler"
import {
  findUncoveredGapFacts,
  selectCorrectionCandidates,
} from "./correction_selection"

function child(id: string, parent: Chunk): RetrievalResult {
  return {
    chunk: {
      id,
      documentId: parent.documentId,
      parentId: parent.id,
      content: `child-${id}`,
      childrenIds: [],
      metadata: { source: "policy.md", kind: "child" },
    },
    parentChunk: parent,
    score: 1,
    source: "vector",
    wikilinks: [],
  }
}

test("context deduplicates parent expansion while preserving child citations", async () => {
  const parent: Chunk = {
    id: "parent-1",
    documentId: "doc-1",
    content: "完整父级退款政策",
    childrenIds: ["child-1", "child-2"],
    metadata: { source: "policy.md", kind: "parent" },
  }
  const first = child("child-1", parent)
  const second = child("child-2", parent)
  const context = await new ContextAssemblerImpl().assemble(
    [first, second],
    new Map([
      ["doc-1\0child-1", "ev-child-1"],
      ["doc-1\0child-2", "ev-child-2"],
    ])
  )

  assert.equal(context.match(/完整父级退款政策/g)?.length, 1)
  assert.match(context, /\[cite:ev-child-1\] \[cite:ev-child-2\]/)
  assert.equal(context.includes("child-child-1"), false)
})

test("parent expansion keeps the matched child inside a bounded context window", async () => {
  const evidence = "命中的退款证据必须保留"
  const parent: Chunk = {
    id: "parent-long",
    documentId: "doc-long",
    content: `${"前置无关内容".repeat(1_200)}${evidence}${"后置无关内容".repeat(1_200)}`,
    childrenIds: ["child-hit"],
    metadata: { source: "long.md", kind: "parent" },
  }
  const result = child("child-hit", parent)
  result.chunk.content = evidence
  const context = await new ContextAssemblerImpl().assemble(
    [result],
    new Map([["doc-long\0child-hit", "ev-hit"]])
  )

  assert.match(context, /\[cite:ev-hit\]/)
  assert.equal(context.includes(evidence), true)
  assert.equal(context.length < parent.content.length, true)
})

test("context budget counts wrappers and uses the configured token counter", async () => {
  const parent: Chunk = {
    id: "parent-budget",
    documentId: "doc-budget",
    content: "预算证据".repeat(500),
    childrenIds: ["child-budget"],
    metadata: { source: "budget.md", kind: "parent" },
  }
  const result = child("child-budget", parent)
  result.chunk.content = "预算证据".repeat(20)
  const assembler = new ContextAssemblerImpl({
    maxContextTokens: 220,
    maxParentTokens: 100,
    countTokens: (text) => text.length,
  })
  const context = await assembler.assemble(
    [result],
    new Map([["doc-budget\0child-budget", "ev-budget"]])
  )

  assert.equal(context.length <= 220, true)
  assert.match(context, /\[cite:ev-budget\]/)
  assert.equal(context.includes("预算证据"), true)
})

test("citations are emitted only for child evidence fully included in the window", async () => {
  const firstEvidence = "甲".repeat(80)
  const secondEvidence = "乙".repeat(80)
  const parent: Chunk = {
    id: "parent-two-children",
    documentId: "doc-two-children",
    content: `${firstEvidence}\n${secondEvidence}`,
    childrenIds: ["child-first", "child-second"],
    metadata: { source: "two.md", kind: "parent" },
  }
  const first = child("child-first", parent)
  first.chunk.content = firstEvidence
  const second = child("child-second", parent)
  second.chunk.content = secondEvidence
  const context = await new ContextAssemblerImpl({
    maxContextTokens: 400,
    maxParentTokens: 100,
    countTokens: (text) => text.length,
  }).assemble(
    [first, second],
    new Map([
      ["doc-two-children\0child-first", "ev-first"],
      ["doc-two-children\0child-second", "ev-second"],
    ])
  )

  assert.match(context, /\[cite:ev-first\]/)
  assert.equal(context.includes("[cite:ev-second]"), false)
  assert.equal(context.includes(firstEvidence), true)
  assert.equal(context.includes(secondEvidence), false)
})

test("the default budget preserves one maximum-size CJK child", async () => {
  const evidence = "证".repeat(1_500)
  const parent: Chunk = {
    id: "parent-max-cjk",
    documentId: "doc-max-cjk",
    content: evidence,
    childrenIds: ["child-max-cjk"],
    metadata: { source: "cjk.md", kind: "parent" },
  }
  const result = child("child-max-cjk", parent)
  result.chunk.content = evidence
  const context = await new ContextAssemblerImpl().assemble(
    [result],
    new Map([["doc-max-cjk\0child-max-cjk", "ev-max-cjk"]])
  )

  assert.match(context, /\[cite:ev-max-cjk\]/)
  assert.equal(context.includes(evidence), true)
})

// ---------------------------------------------------------------------------
// PT-04 / PT-05 — the shared window, dedup and omission rules a gap-first
// correction selection depends on. Budgets are explicit and tiny, and the
// injected counter is `text.length`, so every token claim below is arithmetic.
// ---------------------------------------------------------------------------

const GAP_SNIPPET = "新例外：特定商品不可退款。"
// 98 chars: fits a 110-token parent window on its own, but 98 + separator + 13
// does not — so one parent window holds EITHER this or the gap snippet.
const OLD_SNIPPET = `旧规则：标准商品七日退款。${"甲".repeat(85)}`

/** One child of a long shared parent, with the snippet really inside it. */
function sharedParentChild(chunkId: string, content: string): RetrievalResult {
  const parent: Chunk = {
    id: "parent-shared",
    documentId: "doc-shared",
    content: `${"头".repeat(300)}${OLD_SNIPPET}${"中".repeat(300)}${GAP_SNIPPET}${"尾".repeat(300)}`,
    childrenIds: [],
    metadata: { source: "shared.md", kind: "parent" },
  }
  return {
    chunk: {
      id: chunkId,
      documentId: parent.documentId,
      parentId: parent.id,
      content,
      childrenIds: [],
      metadata: { source: "shared.md", kind: "child" },
    },
    parentChunk: parent,
    score: 0.9,
    source: "vector",
    wikilinks: [],
  }
}

function tightBudgetAssembler(): ContextAssemblerImpl {
  // 300 total, 110 per parent: one parent window can hold EITHER the 98-char
  // old snippet OR the 13-char gap snippet, never both.
  return new ContextAssemblerImpl({
    maxContextTokens: 300,
    maxParentTokens: 110,
    countTokens: (text) => text.length,
  })
}

const SHARED_CITATIONS = new Map([
  ["doc-shared\0child-gap", "ev-gap"],
  ["doc-shared\0child-old", "ev-old"],
])

test("a gap snippet leading the shared parent window keeps the new fact and its citation", async () => {
  const gap = sharedParentChild("child-gap", GAP_SNIPPET)
  const older = sharedParentChild("child-old", OLD_SNIPPET)

  const context = await tightBudgetAssembler().assemble(
    [gap, older],
    SHARED_CITATIONS
  )

  assert.ok(context.includes(GAP_SNIPPET), "the gap match is the one the window is built around")
  assert.equal(context.includes(OLD_SNIPPET), false, "the older match cannot also fit")
  assert.match(context, /\[cite:ev-gap\]/, "citations stay consistent with what was included")
  assert.equal(context.includes("[cite:ev-old]"), false, "an excluded match is never cited")
  assert.equal(
    context.match(/来源: shared\.md/g)?.length,
    1,
    "one shared parent is framed exactly once, so its window is not paid for twice"
  )
  assert.equal(findUncoveredGapFacts({
    gapCandidates: [gap],
    citationIds: SHARED_CITATIONS,
    context,
    mode: "verbatim",
    reason: "context_budget",
  }).length, 0, "a selected gap fact that reached the context is not reported missing")
})

test("the audited tail-append order loses the same gap fact, which is what the omission rule reports", async () => {
  const gap = sharedParentChild("child-gap", GAP_SNIPPET)
  const older = sharedParentChild("child-old", OLD_SNIPPET)

  // Pre-PT-04 candidate order: older material first, the 补检 hit appended last.
  const starved = await tightBudgetAssembler().assemble(
    [older, gap],
    SHARED_CITATIONS
  )
  assert.ok(starved.includes(OLD_SNIPPET))
  assert.equal(starved.includes(GAP_SNIPPET), false, "insertion order decided starvation, not relevance")

  const omissions = findUncoveredGapFacts({
    gapCandidates: [gap],
    citationIds: SHARED_CITATIONS,
    context: starved,
    mode: "verbatim",
    reason: "context_budget",
  })
  assert.equal(omissions.length, 1, "the missing gap fact is nameable, so no layer may claim coverage")
  assert.equal(omissions[0].chunkId, "child-gap")
  assert.equal(omissions[0].evidenceId, "ev-gap")
  assert.equal(omissions[0].reason, "context_budget")
})

test("gap-first selection hands the assembler one candidate per identity, older material last", async () => {
  const gap = sharedParentChild("child-gap", GAP_SNIPPET)
  const older = sharedParentChild("child-old", OLD_SNIPPET)
  const reHit = { ...gap, score: 0.4, channels: ["bm25"] as RetrievalResult["source"][] }

  const selection = selectCorrectionCandidates({
    gapResults: [gap, reHit],
    olderResults: [older, gap],
  })

  assert.deepEqual(
    selection.candidates.map((result) => result.chunk.id),
    ["child-gap", "child-old"],
    "the gap occurrence wins a repeated identity and nothing is offered twice"
  )
  assert.deepEqual(
    selection.gapCandidates.map((result) => result.chunk.id),
    ["child-gap"],
    "the coverage check is against the gap material that was actually selected"
  )
  assert.equal(
    selection.orderedResults.length,
    4,
    "raw order keeps the duplicates so Evidence still merges their channels"
  )

  const context = await tightBudgetAssembler().assemble(
    selection.candidates,
    SHARED_CITATIONS
  )
  assert.ok(context.includes(GAP_SNIPPET))
})

test("a repeated identity consumes no budget twice and frames no source twice", async () => {
  const parent: Chunk = {
    id: "parent-dup",
    documentId: "doc-dup",
    content: "重复身份的退款证据",
    childrenIds: ["child-dup"],
    metadata: { source: "dup.md", kind: "parent" },
  }
  const first = child("child-dup", parent)
  first.chunk.documentId = "doc-dup"
  first.chunk.content = "重复身份的退款证据"
  const again = { ...first, score: 0.3, source: "bm25" as RetrievalResult["source"] }

  const citations = new Map([["doc-dup\0child-dup", "ev-dup"]])
  const once = await new ContextAssemblerImpl({
    maxContextTokens: 300,
    countTokens: (text) => text.length,
  }).assemble([first], citations)
  const twice = await new ContextAssemblerImpl({
    maxContextTokens: 300,
    countTokens: (text) => text.length,
  }).assemble([first, again], citations)

  assert.equal(twice, once, "an identity offered twice produces a byte-identical context")
  assert.equal(twice.match(/\[cite:ev-dup\]/g)?.length, 1)
})

test("the gap group leads and the rest of the budget still fills with older material", async () => {
  const gap = sharedParentChild("child-gap", GAP_SNIPPET)
  const oldParent: Chunk = {
    id: "parent-old",
    documentId: "doc-old",
    content: `${"乙".repeat(400)}${OLD_SNIPPET}${"丙".repeat(400)}`,
    childrenIds: [],
    metadata: { source: "old.md", kind: "parent" },
  }
  const older: RetrievalResult = {
    chunk: {
      id: "child-old",
      documentId: "doc-old",
      parentId: oldParent.id,
      content: OLD_SNIPPET,
      childrenIds: [],
      metadata: { source: "old.md", kind: "child" },
    },
    parentChunk: oldParent,
    score: 0.9,
    source: "vector",
    wikilinks: [],
  }

  const context = await tightBudgetAssembler().assemble(
    [gap, older],
    new Map([
      ["doc-shared\0child-gap", "ev-gap"],
      ["doc-old\0child-old", "ev-old"],
    ])
  )

  assert.ok(context.length <= 300, "the configured total counts intro, suffix, headers and citations")
  assert.ok(context.includes(GAP_SNIPPET), "the new fact leads")
  assert.ok(context.includes("来源: old.md"), "the remaining budget is filled by older material")
  assert.equal(findUncoveredGapFacts({
    gapCandidates: [gap],
    citationIds: new Map([["doc-shared\0child-gap", "ev-gap"]]),
    context,
    mode: "verbatim",
    reason: "context_budget",
  }).length, 0)
})

test("a compressed context that dropped the fact's identity is reported as a compression omission", () => {
  const gap = sharedParentChild("child-gap", GAP_SNIPPET)
  const citationIds = new Map([["doc-shared\0child-gap", "ev-gap"]])

  assert.deepEqual(findUncoveredGapFacts({
    gapCandidates: [gap],
    citationIds,
    context: "以下是从知识库中找到的相关文档片段：\n[cite:ev-gap] [来源: shared.md]\n摘要\n",
    mode: "citation",
    reason: "compression",
  }), [], "citation mode is the right check for a rewritten context: the block header proves retention")

  assert.deepEqual(
    findUncoveredGapFacts({
      gapCandidates: [gap],
      citationIds,
      context: "以下是从知识库中找到的相关文档片段：\n[cite:ev-old] [来源: old.md]\n摘要\n",
      mode: "citation",
      reason: "compression",
    }),
    [{
      documentId: "doc-shared",
      chunkId: "child-gap",
      identity: "doc-shared\0child-gap",
      evidenceId: "ev-gap",
      reason: "compression",
    }],
    "a compressed output without the fact's identity does not close the correction round"
  )
})
