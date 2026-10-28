import assert from "node:assert/strict"
import test from "node:test"
import Database from "better-sqlite3"

import {
  LOCAL_USER_ID_MAX_LENGTH,
  LOCAL_USER_PASSWORD_LENGTH,
  LocalAuthService,
  SqliteLocalUserStore,
  normalizeLocalId,
  validateLocalId,
  validateLocalPassword,
} from "./local_users"
import { DEMO_TENANT_ID } from "./demo_accounts"

const ADMIN_ID = "boss"
const ADMIN_PASSWORD = "Boss8888"
const USER_PASSWORD = "Pass1234"

function service() {
  const db = new Database(":memory:")
  const store = new SqliteLocalUserStore(db)
  return {
    db,
    store,
    auth: new LocalAuthService(store, {
      adminId: ADMIN_ID,
      adminPassword: ADMIN_PASSWORD,
    }),
  }
}

test("local ID rules: 1-5 Chinese or Latin letters, no digits", () => {
  assert.equal(LOCAL_USER_ID_MAX_LENGTH, 5)
  for (const id of ["a", "小明", "张ab", "ABCDE", "李"]) {
    assert.equal(validateLocalId(id), null, `${id} is a valid ID`)
  }
  assert.match(validateLocalId("abcdef") ?? "", /最多 5 个字符/)
  assert.match(validateLocalId("abc1") ?? "", /中文或英文字母/)
  assert.match(validateLocalId("a b") ?? "", /中文或英文字母/)
  assert.match(validateLocalId("") ?? "", /请输入/)
  assert.match(validateLocalId(123) ?? "", /请输入/)
})

test("local password rule: exactly eight characters", () => {
  assert.equal(LOCAL_USER_PASSWORD_LENGTH, 8)
  assert.equal(validateLocalPassword("Abcd1234"), null)
  assert.equal(validateLocalPassword("中文密码八个字啊"), null)
  assert.match(validateLocalPassword("Abc1234") ?? "", /8 位/)
  assert.match(validateLocalPassword("Abcd12345") ?? "", /8 位/)
  assert.match(validateLocalPassword("") ?? "", /请输入/)
})

test("the store keeps passwords hashed and compares them case-sensitively", () => {
  const { store } = service()
  const created = store.create("Alice", USER_PASSWORD)
  assert.equal(created?.idKey, "alice")
  assert.equal(store.find("ALICE")?.displayId, "Alice")
  assert.equal(store.verify("alice", USER_PASSWORD)?.displayId, "Alice")
  assert.equal(store.verify("alice", "pass1234"), null, "password casing matters")
  assert.equal(store.verify("alice", "Wrong123"), null)
  assert.equal(store.create("alice", USER_PASSWORD), null, "the ID is already taken")

  const row = new Database(":memory:")
  const other = new SqliteLocalUserStore(row)
  other.create("小华", "Abcd1234")
  const stored = row
    .prepare("SELECT password_hash, password_salt FROM local_users WHERE id_key = ?")
    .get("小华") as { password_hash: string; password_salt: string }
  assert.equal(stored.password_hash.includes("Abcd1234"), false)
  assert.ok(stored.password_hash.length >= 64)
  assert.ok(stored.password_salt.length >= 16)
})

test("case-insensitive uniqueness survives a new store on the same database", () => {
  const { db, auth } = service()
  assert.equal(auth.register("Alice", USER_PASSWORD).ok, true)
  const restarted = new LocalAuthService(new SqliteLocalUserStore(db), {
    adminId: ADMIN_ID,
    adminPassword: ADMIN_PASSWORD,
  })
  const duplicate = restarted.register("ALICE", "Other123")
  assert.equal(duplicate.ok, false)
  assert.equal(duplicate.ok ? "" : duplicate.code, "id_taken")
  assert.equal(restarted.authenticate("alice", USER_PASSWORD)?.displayId, "Alice")
})

test("the administrator signs in with its special ID and cannot be registered", () => {
  const { auth } = service()
  const admin = auth.authenticate("Boss", ADMIN_PASSWORD)
  assert.equal(admin?.role, "admin")
  assert.equal(admin?.displayId, ADMIN_ID)
  assert.deepEqual(admin?.scopes, ["chat", "ingest", "review", "admin"])
  assert.equal(auth.authenticate(ADMIN_ID, "wrong-password"), null)
  const reserved = auth.register("BOSS", USER_PASSWORD)
  assert.equal(reserved.ok, false)
  assert.equal(reserved.ok ? "" : reserved.code, "id_taken")
})

test("registered users are readers and their claims carry the display ID", () => {
  const { auth } = service()
  const registered = auth.register("小明", USER_PASSWORD)
  assert.equal(registered.ok, true)
  assert.equal(registered.ok ? registered.identity.role : "", "user")
  assert.deepEqual(registered.ok ? registered.identity.scopes : [], ["chat"])

  const identity = auth.authenticate("小明", USER_PASSWORD)
  assert.equal(identity?.subjectId, "user:小明")
  const claims = auth.claimsForAccount(normalizeLocalId("小明"))
  assert.deepEqual(claims, {
    sub: "user:小明",
    tenant_id: DEMO_TENANT_ID,
    groups: [],
    scope: "chat",
    name: "小明",
  })
})
