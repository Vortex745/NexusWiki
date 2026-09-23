/**
 * Ticket 32 (MEM-01A) — user-owned long-term memories: scope, CRUD,
 * forgetting, persistence.
 *
 * Everything runs against the real store on an in-memory database: the
 * acceptance criteria are about owned rows (another user's record is the
 * same missing row as an unknown id), the recall scoping rule, and clearing
 * that stays cleared.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { openDb } from "../ingestion/tracking/db"
import {
  LongTermMemoryStore,
  MemoryContentError,
  MemoryQuotaError,
  MEMORY_LIMITS,
} from "./long_term_memory_store"

function build() {
  const db = openDb(":memory:")
  let counter = 0
  const store = new LongTermMemoryStore({
    db,
    now: () => new Date(Date.UTC(2026, 8, 23, 0, 0, 0, ++counter)),
    generateId: () => `mem-${++counter}`,
  })
  return { db, store }
}

test("Ticket 32: a record is owned by one user, optionally pinned to one assistant", () => {
  const { store } = build()
  const global = store.create({
    tenantId: "t1",
    subjectId: "alice",
    content: "回答风格：条理清晰、结论先行",
  })
  assert.equal(global.assistantId, null)
  const pinned = store.create({
    tenantId: "t1",
    subjectId: "alice",
    assistantId: "ast-1",
    content: "技术问答附上 TypeScript 示例",
  })
  assert.equal(pinned.assistantId, "ast-1")

  const list = store.list("t1", "alice")
  assert.equal(list.length, 2)
  assert.deepEqual(list.map(({ id }) => id), [pinned.id, global.id], "newest first")
})

test("Ticket 32: the owner can add, edit and forget through the store; unknown ids are null", () => {
  const { store } = build()
  const memory = store.create({ tenantId: "t1", subjectId: "alice", content: "偏好 A" })
  const edited = store.edit("t1", "alice", memory.id, "偏好 A（已更新）")
  assert.ok(edited)
  assert.equal(edited.content, "偏好 A（已更新）")
  assert.equal(edited.updatedAt > memory.updatedAt, true)
  assert.equal(store.edit("t1", "alice", "mem-unknown", "x"), null)
  assert.equal(store.forget("t1", "alice", memory.id), true)
  assert.equal(store.forget("t1", "alice", memory.id), false, "already forgotten")
  assert.equal(store.list("t1", "alice").length, 0)
})

test("Ticket 32: another user cannot list, change or recall those records", () => {
  const { store } = build()
  const memory = store.create({
    tenantId: "t1",
    subjectId: "alice",
    content: "alice 的私有偏好",
  })
  // Another user in the same tenant.
  assert.equal(store.list("t1", "bob").length, 0)
  assert.equal(store.get("t1", "bob", memory.id), null)
  assert.equal(store.edit("t1", "bob", memory.id, "篡改"), null)
  assert.equal(store.forget("t1", "bob", memory.id), false)
  assert.equal(store.recall("t1", "bob", null).length, 0)
  // The record is untouched.
  assert.equal(store.get("t1", "alice", memory.id)?.content, "alice 的私有偏好")
  // Cross-tenant is equally invisible.
  assert.equal(store.get("t2", "alice", memory.id), null)
})

test("Ticket 32: recall reads global records plus the pinned assistant's, nothing else", () => {
  const { store } = build()
  store.create({ tenantId: "t1", subjectId: "alice", content: "全局偏好" })
  store.create({ tenantId: "t1", subjectId: "alice", assistantId: "ast-1", content: "助手 1 偏好" })
  store.create({ tenantId: "t1", subjectId: "alice", assistantId: "ast-2", content: "助手 2 偏好" })

  assert.deepEqual(
    store.recall("t1", "alice", null).map(({ content }) => content),
    ["全局偏好"],
    "legacy/default assistant reads global records only"
  )
  assert.deepEqual(
    store.recall("t1", "alice", "ast-1").map(({ content }) => content),
    ["助手 1 偏好", "全局偏好"],
    "newest first, global records included"
  )
})

test("Ticket 32: clearing stays cleared — a fresh store on the same db restores nothing", () => {
  const { db, store } = build()
  store.create({ tenantId: "t1", subjectId: "alice", content: "将被清空的偏好" })
  assert.equal(store.forgetAll("t1", "alice"), 1)
  // The product restarts, a new store opens the same db: still cleared.
  const reopened = new LongTermMemoryStore({ db })
  assert.equal(reopened.list("t1", "alice").length, 0)
  assert.equal(reopened.recall("t1", "alice", "ast-1").length, 0)
})

test("Ticket 32: content is validated and the owner's records are bounded", () => {
  const { store } = build()
  assert.throws(() => store.create({ tenantId: "t1", subjectId: "a", content: "   " }), MemoryContentError)
  assert.throws(
    () => store.create({ tenantId: "t1", subjectId: "a", content: "x".repeat(MEMORY_LIMITS.maxContentChars + 1) }),
    MemoryContentError
  )
  assert.throws(() => store.create({ tenantId: "t1", subjectId: "a", content: 42 }), MemoryContentError)
  for (let index = 0; index < MEMORY_LIMITS.maxRecordsPerOwner; index += 1) {
    store.create({ tenantId: "t1", subjectId: "a", content: `记忆 ${index}` })
  }
  assert.throws(
    () => store.create({ tenantId: "t1", subjectId: "a", content: "超出配额" }),
    MemoryQuotaError
  )
  // Content is trimmed.
  const memory = store.create({ tenantId: "t1", subjectId: "b", content: "  首尾空白  " })
  assert.equal(memory.content, "首尾空白")
})
