import assert from "node:assert/strict"
import test from "node:test"
import type { AnswerRunEvent } from "../types/answer"
import type { OperationEndOptions, OperationScope, TracingAttributes } from "./contract"
import { AnswerScopeTracker } from "./answer_scopes"

/**
 * LO-09 (stage half): stage scopes follow the events the runner really emits —
 * no invented phases, no leaked stage, exactly one terminal close.
 */

interface Recorded {
  name: string
  ended: OperationEndOptions | undefined
}

class FakeScope implements OperationScope {
  readonly traceId = "0".repeat(32)
  readonly spanId = "1".repeat(16)
  readonly sampled = true
  readonly children: Recorded[] = []
  readonly own: Recorded

  constructor(name = "root", own?: Recorded) {
    this.own = own ?? { name, ended: undefined }
  }

  setAttributes(_attributes: TracingAttributes): void {
    // not needed for the assertions
  }

  startChild(name: string): OperationScope {
    const record: Recorded = { name, ended: undefined }
    this.children.push(record)
    return new FakeScope(name, record)
  }

  runInContext<T>(fn: () => T): T {
    return fn()
  }

  end(options: OperationEndOptions = {}): void {
    this.own.ended = options
  }
}

function event(payload: Record<string, unknown>): AnswerRunEvent {
  return {
    schemaVersion: 1,
    sessionId: "sess",
    runId: "run",
    createdAt: "2026-10-20T00:00:00.000Z",
    status: "running",
    durationMs: null,
    attempt: 1,
    round: 0,
    inputSummary: "",
    outputSummary: "",
    eventId: `e-${Math.random()}`,
    sequence: 0,
    ...payload,
  } as unknown as AnswerRunEvent
}

test("LO-09: stage spans open on the real stage and close on transition", () => {
  const root = new FakeScope()
  const tracker = new AnswerScopeTracker(root)

  tracker.observe(event({ type: "progress", stage: "route", message: "routing", data: {} }))
  assert.equal(tracker.currentStage, "route")
  tracker.observe(event({ type: "progress", stage: "retrieval", message: "retrieving", data: {} }))
  assert.equal(tracker.currentStage, "retrieval")
  tracker.observe(event({ type: "answer_delta", stage: "answer", token: "你" }))
  assert.equal(tracker.currentStage, "answer")
  tracker.observe(event({ type: "done", stage: "done", result: { reply: "你好" } }))

  assert.deepEqual(root.children.map((child) => child.name), ["stage.route", "stage.retrieval", "stage.answer"])
  for (const child of root.children) {
    assert.ok(child.ended, `${child.name} must be ended`)
    assert.equal(child.ended?.outcome, "ok")
  }
  assert.equal(tracker.currentStage, undefined)
})

test("LO-09: an error run closes the open stage exactly once as an error", () => {
  const root = new FakeScope()
  const tracker = new AnswerScopeTracker(root)
  tracker.observe(event({ type: "progress", stage: "context", message: "assembling", data: {} }))
  tracker.finish("error")
  tracker.finish("error")
  assert.equal(root.children.length, 1)
  assert.equal(root.children[0].ended?.outcome, "error")
  assert.equal(root.children[0].ended?.message, "error")

  // Events after close are ignored, so a late frame cannot resurrect a stage.
  tracker.observe(event({ type: "progress", stage: "answer", message: "late", data: {} }))
  assert.equal(root.children.length, 1)
})

test("LO-09: a repeated stage does not open a second span", () => {
  const root = new FakeScope()
  const tracker = new AnswerScopeTracker(root)
  tracker.observe(event({ type: "progress", stage: "validation", message: "a", data: {} }))
  tracker.observe(event({ type: "progress", stage: "validation", message: "b", data: {} }))
  tracker.finish("ok")
  assert.equal(root.children.length, 1)
})
