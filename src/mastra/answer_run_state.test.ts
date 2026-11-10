import assert from "node:assert/strict"
import test from "node:test"
import { buildEvidence } from "../answer/evidence"
import { createAnswerDeliveryMachine, createKnowledgeAnswerMachine } from "./answer_run_state"

const evidence = buildEvidence([{
  chunk: { id: "checked-chunk", documentId: "checked-doc", content: "Approved policy", childrenIds: [], metadata: {} },
  score: 1, source: "vector", wikilinks: [],
}])
const draft = { reply: "Approved policy", tokens: ["Approved", " policy"], evidence }
type Machine = ReturnType<typeof createKnowledgeAnswerMachine>
type Observation = Parameters<Machine["advance"]>[0]

function accept(machine: Machine, observation: Observation): void {
  assert.equal(machine.advance(observation).kind, "accepted")
}

function prepareDraft(machine: Machine): void {
  accept(machine, { type: "retrieval_finished", result: "usable" })
  accept(machine, { type: "context_prepared" })
  accept(machine, { type: "draft_checked", draft, citations: "valid" })
}

test("knowledge approval owns the checked draft and its final reference basis", () => {
  const machine = createKnowledgeAnswerMachine("simple")
  const initial = machine.state
  assert.equal(machine.advance({ type: "context_prepared" }).kind, "rejected")
  assert.ok(Object.is(machine.state, initial))
  assert.equal(machine.advance({ type: "route_selected", route: "complex" }).kind, "rejected")
  assert.ok(Object.is(machine.state, initial))
  accept(machine, { type: "route_selected", route: "simple" })
  prepareDraft(machine)
  accept(machine, { type: "validation_finished", verdict: { passed: false, hallucination: false, completeness: false } })
  accept(machine, { type: "gaps_planned", result: "queries_available" })
  prepareDraft(machine)
  accept(machine, { type: "validation_finished", verdict: { passed: true, hallucination: false, completeness: true,
    answerBasis: { text: "  Checked policy  ", referenceIds: [evidence[0].id] } } })
  const approved = machine.state
  assert.equal(approved.kind, "approved")
  accept(machine, { type: "publication_checked", references: evidence })
  const ready = machine.state
  assert.equal(ready.kind, "ready_to_commit")
  accept(machine, { type: "answer_committed" })
  const terminal = machine.state
  assert.equal(terminal.kind, "resolved")
  if (terminal.kind !== "resolved" || terminal.outcome.kind !== "completed") assert.fail("expected a completed answer")
  assert.equal(terminal.outcome.answer.reply, draft.reply)
  assert.deepEqual(terminal.outcome.answer.tokens, draft.tokens)
  assert.deepEqual(terminal.outcome.answer.references, evidence)
  assert.deepEqual(terminal.outcome.answer.answerBasis, { text: "Checked policy", referenceIds: [evidence[0].id] })
  assert.equal(machine.advance({ type: "answer_committed" }).kind, "rejected")
  assert.equal(machine.advance({ type: "gaps_planned", result: "queries_available" }).kind, "rejected")
  assert.ok(Object.is(machine.state, terminal))
})

test("three failed validations allow the last regeneration but no fourth validation", () => {
  const machine = createKnowledgeAnswerMachine("complex")
  accept(machine, { type: "route_selected", route: "complex" })
  for (let round = 1; round <= 3; round += 1) {
    prepareDraft(machine)
    const validating = machine.state
    assert.equal(validating.kind, "validating")
    accept(machine, { type: "validation_finished", verdict: { passed: false, hallucination: false, completeness: false } })
    accept(machine, { type: "gaps_planned", result: "queries_available" })
  }
  prepareDraft(machine)
  const exhausted = machine.state
  assert.equal(exhausted.kind, "handoff_pending")
  assert.equal(machine.advance({ type: "validation_finished", verdict: { passed: true, hallucination: false, completeness: true } }).kind, "rejected")
  assert.ok(Object.is(machine.state, exhausted))
  accept(machine, { type: "handoff_finished", result: "unavailable" })
  const terminal = machine.state
  assert.equal(terminal.kind, "resolved")
  if (terminal.kind !== "resolved") assert.fail("expected terminal refusal")
  assert.deepEqual(terminal.outcome, { kind: "refused", status: "insufficient_evidence" })
})

test("publication cannot bypass approval and a passed uncited draft cannot complete", () => {
  const machine = createKnowledgeAnswerMachine("simple")
  accept(machine, { type: "route_selected", route: "simple" })
  prepareDraft(machine)
  const validating = machine.state
  assert.equal(machine.advance({ type: "publication_checked", references: evidence }).kind, "rejected")
  assert.equal(machine.state, validating)
  accept(machine, { type: "validation_finished", verdict: { passed: true, hallucination: false, completeness: true } })
  accept(machine, { type: "publication_checked", references: [] })
  const terminal = machine.state
  assert.equal(terminal.kind, "resolved")
  if (terminal.kind !== "resolved") assert.fail("expected refusal")
  assert.deepEqual(terminal.outcome, { kind: "refused", status: "insufficient_evidence" })
})

test("delivery preserves the first settlement and claims its terminal exactly once", () => {
  const delivery = createAnswerDeliveryMachine<{ reply: string }>()
  assert.equal(delivery.advance({ type: "terminal_claimed" }).kind, "rejected")
  assert.equal(delivery.advance({ type: "runner_started" }).kind, "accepted")
  const output = { reply: "completed before transport abort" }
  assert.equal(delivery.advance({ type: "runner_fulfilled", output }).kind, "accepted")
  const settled = delivery.state
  assert.equal(delivery.advance({ type: "runner_rejected", failure: { kind: "cancelled" } }).kind, "rejected")
  assert.ok(Object.is(delivery.state, settled))
  assert.equal(delivery.advance({ type: "terminal_claimed" }).kind, "accepted")
  const terminal = delivery.state
  assert.equal(terminal.kind, "terminal")
  if (terminal.kind !== "terminal" || terminal.resolution.kind !== "fulfilled") assert.fail("expected fulfilled terminal")
  assert.equal(terminal.resolution.output, output)
  assert.equal(delivery.advance({ type: "terminal_claimed" }).kind, "rejected")
  assert.ok(Object.is(delivery.state, terminal))
})

test("delivery permits pre-run cancellation and freezes its terminal", () => {
  const delivery = createAnswerDeliveryMachine()
  assert.equal(delivery.advance({ type: "runner_rejected", failure: { kind: "cancelled" } }).kind, "accepted")
  assert.equal(delivery.advance({ type: "terminal_claimed" }).kind, "accepted")
  const terminal = delivery.state
  assert.equal(delivery.advance({ type: "runner_started" }).kind, "rejected")
  assert.ok(Object.is(delivery.state, terminal))
})
