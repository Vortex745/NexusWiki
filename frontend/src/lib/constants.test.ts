// The trace label is operator-facing copy: an empty knowledge scope is a
// scope fact, not one unavailable channel, so it must not be rendered as
// "1 个通道降级".
import assert from "node:assert/strict"
import { test } from "node:test"

import { traceEventLabel } from "./constants"

function retrieval(data: Record<string, unknown>) {
  return {
    eventId: "event-1",
    sequence: 1,
    type: "progress",
    stage: "retrieval",
    data,
  } as Parameters<typeof traceEventLabel>[0]
}

test("an empty knowledge scope is rendered as its own scope fact", () => {
  assert.equal(
    traceEventLabel(retrieval({ resultCount: 0, degradedReasons: ["no_knowledge_scope"] })),
    "检索知识库 · 0 条结果 · 未指定知识范围",
  )
})

test("a channel failure still reads as a channel degradation", () => {
  assert.equal(
    traceEventLabel(retrieval({ resultCount: 2, degradedReasons: ["vector unavailable"] })),
    "检索知识库 · 2 条结果 · 1 个通道降级",
  )
})

test("an empty scope and a channel failure are reported separately", () => {
  assert.equal(
    traceEventLabel(
      retrieval({ resultCount: 0, degradedReasons: ["no_knowledge_scope", "vector unavailable"] }),
    ),
    "检索知识库 · 0 条结果 · 未指定知识范围 · 1 个通道降级",
  )
})
