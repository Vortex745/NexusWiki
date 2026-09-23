/**
 * Ticket 33 (MEM-01B) — extraction suggestions: pending only, reviewable,
 * deduplicated, settle-once, owner-scoped.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { openDb } from "../ingestion/tracking/db"
import {
  MemorySuggestionStore,
  extractMemorySuggestions,
} from "./memory_suggestion_store"
import { LongTermMemoryStore } from "./long_term_memory_store"

function build() {
  const db = openDb(":memory:")
  let counter = 0
  const suggestions = new MemorySuggestionStore({
    db,
    now: () => new Date(Date.UTC(2026, 8, 23, 0, 0, 0, ++counter)),
    generateId: () => `memsug-${++counter}`,
  })
  const memories = new LongTermMemoryStore({ db })
  return { db, suggestions, memories }
}

test("Ticket 33: extraction picks explicit preference sentences, bounded and deduplicated", () => {
  const extracted = extractMemorySuggestions(
    "请记住我喜欢简洁的回答。今天天气不错！以后每次都用中文回答，我的名字是李明",
    2
  )
  assert.deepEqual(extracted, ["请记住我喜欢简洁的回答", "以后每次都用中文回答，我的名字是李明"])
  // Neutral sentences never produce suggestions.
  assert.deepEqual(extractMemorySuggestions("退款政策是什么？帮我查一下"), [])
  // Bound respected (the default per-run limit the wrapper relies on).
  const many = extractMemorySuggestions("记住A。记住B。记住C。记住D。")
  assert.ok(many.length <= 2)
})

test("Ticket 33: suggestions are created PENDING and only the owner sees them", () => {
  const { suggestions } = build()
  const created = suggestions.createPending({
    tenantId: "t1",
    subjectId: "alice",
    assistantId: null,
    sourceRunId: "run-1",
    content: "请记住我喜欢简洁的回答",
  })
  assert.ok(created)
  assert.equal(created.status, "pending")
  assert.equal(suggestions.list("t1", "alice").length, 1)
  assert.equal(suggestions.list("t1", "bob").length, 0)
  assert.equal(suggestions.get("t1", "bob", created.id), null)
})

test("Ticket 33: identical suggestions are deduplicated — reruns never flood the queue", () => {
  const { suggestions } = build()
  const first = suggestions.createPending({
    tenantId: "t1",
    subjectId: "alice",
    assistantId: null,
    sourceRunId: "run-1",
    content: "记住：偏好 TypeScript",
  })
  assert.ok(first)
  const duplicate = suggestions.createPending({
    tenantId: "t1",
    subjectId: "alice",
    assistantId: null,
    sourceRunId: "run-2",
    content: "记住：偏好 TypeScript",
  })
  assert.equal(duplicate, null)
  assert.equal(suggestions.list("t1", "alice").length, 1)
})

test("Ticket 33: accepting publishes a memory and settles once; dismiss likewise", () => {
  const { suggestions, memories } = build()
  const suggestion = suggestions.createPending({
    tenantId: "t1",
    subjectId: "alice",
    assistantId: null,
    sourceRunId: "run-1",
    content: "记住：回答结论先行",
  })!
  const memory = memories.create({ tenantId: "t1", subjectId: "alice", content: suggestion.content })
  assert.ok(suggestions.markAccepted("t1", "alice", suggestion.id))
  // Settled suggestions cannot settle again.
  assert.equal(suggestions.markAccepted("t1", "alice", suggestion.id), null)
  assert.equal(suggestions.dismiss("t1", "alice", suggestion.id), null)
  assert.equal(suggestions.list("t1", "alice", "pending").length, 0)
  assert.deepEqual(
    memories.recall("t1", "alice", null).map(({ id }) => id),
    [memory.id]
  )

  const other = suggestions.createPending({
    tenantId: "t1",
    subjectId: "alice",
    assistantId: null,
    sourceRunId: "run-2",
    content: "记住：不要术语堆砌",
  })!
  assert.ok(suggestions.dismiss("t1", "alice", other.id))
  assert.equal(suggestions.list("t1", "alice", "dismissed").length, 1)
  // A dismissed suggestion can be re-suggested later (dedupe only covers
  // pending/accepted) — dismissing is not remembering.
  const again = suggestions.createPending({
    tenantId: "t1",
    subjectId: "alice",
    assistantId: null,
    sourceRunId: "run-3",
    content: "记住：不要术语堆砌",
  })
  assert.ok(again)
})
