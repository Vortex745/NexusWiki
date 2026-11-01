/**
 * Local ID/password accounts.
 *
 * The local issuer only mints tokens for identities this module knows: the
 * administrator credential supplied by the deployment environment (never
 * stored) and the users registered into the process database. Passwords are
 * kept as scrypt hashes with a per-user salt — the plaintext never leaves the
 * request and is never written to a log.
 *
 * ID rule: 1–5 characters, Chinese or Latin letters, uniqueness is
 * case-insensitive after NFKC normalisation. Password rule (registration
 * only): exactly 8 characters, compared case-sensitively.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { ALL_LOCAL_SCOPES, type Scope } from "../access/context"
import type { DB } from "../ingestion/tracking/db"
import { DEMO_ADMIN_GROUP, DEMO_TENANT_ID } from "./demo_accounts"

export const LOCAL_USER_ID_MAX_LENGTH = 5
export const LOCAL_USER_PASSWORD_LENGTH = 8

/** The seeded administrator's subject stays stable so demo data keeps its owner. */
const LOCAL_ADMIN_SUBJECT_ID = "demo-admin"

/**
 * A local account owns a private workspace. Deriving a tenant id from the
 * subject lets the existing tenant-scoped isolation (documents, knowledge
 * bases, assistants, graph, wiki) apply without a second ownership axis.
 * The administrator keeps the seeded demo tenant.
 */
export const LOCAL_WORKSPACE_TENANT_PREFIX = "w-"

export function localWorkspaceTenantId(subjectId: string): string {
  return `${LOCAL_WORKSPACE_TENANT_PREFIX}${createHash("sha256")
    .update(subjectId)
    .digest("hex")
    .slice(0, 16)}`
}

/** The tenant a local identity signs into: demo for the administrator, its own workspace otherwise. */
export function tenantIdForIdentity(identity: LocalIdentity): string {
  return identity.role === "admin" ? DEMO_TENANT_ID : localWorkspaceTenantId(identity.subjectId)
}

const ID_PATTERN = /^[\p{Script=Han}A-Za-z]+$/u
const SCRYPT_KEY_BYTES = 64

/** The local calendar day (YYYY-MM-DD) an instant falls into. */
function localDateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function startOfLocalDay(date: Date): Date {
  const start = new Date(date)
  start.setHours(0, 0, 0, 0)
  return start
}

/** The snake_case row shape every local_users read returns. */
interface StoredLocalUserRow {
  id_key: string
  display_id: string
  created_at: string
  last_login: string | null
  disabled_at: string | null
}

function mapStoredUserRow(row: StoredLocalUserRow): AdminUserRow {
  return {
    idKey: row.id_key,
    displayId: row.display_id,
    createdAt: row.created_at,
    lastLoginAt: row.last_login,
    disabledAt: row.disabled_at,
  }
}

export interface LocalUserRecord {
  idKey: string
  displayId: string
  createdAt: string
}

/**
 * One row of the operator's user directory (AC-03). `lastLoginAt` stays null
 * until the account's first successful sign-in after this column shipped;
 * `disabledAt` is null until AC-04 adds the column.
 */
export interface AdminUserRow {
  idKey: string
  displayId: string
  createdAt: string
  lastLoginAt: string | null
  disabledAt: string | null
}

export interface AdminUserPage {
  items: AdminUserRow[]
  total: number
}

/** AC-06: the account overview behind the operator's chart. */
export interface AdminOverview {
  total: number
  active: number
  disabled: number
  /** The last 14 LOCAL days, ascending, every date present (0 when none). */
  newUsers: Array<{ date: string; count: number }>
}

export interface LocalIdentity {
  idKey: string
  displayId: string
  role: "admin" | "user"
  subjectId: string
  groups: string[]
  scopes: Scope[]
}

export type RegisterResult =
  | { ok: true; identity: LocalIdentity }
  | {
      ok: false
      code: "invalid_id" | "invalid_password" | "id_taken"
      message: string
    }

/** The uniqueness key: NFKC-normalised and lower-cased. */
export function normalizeLocalId(id: string): string {
  return id.normalize("NFKC").toLowerCase()
}

/** Returns a human-readable reason, or null when the ID is acceptable. */
export function validateLocalId(id: unknown): string | null {
  if (typeof id !== "string" || id.length === 0) return "请输入账号 ID"
  const normalized = id.normalize("NFKC")
  if (!ID_PATTERN.test(normalized)) return "ID 只能包含中文或英文字母"
  if ([...normalized].length > LOCAL_USER_ID_MAX_LENGTH) {
    return `ID 最多 ${LOCAL_USER_ID_MAX_LENGTH} 个字符`
  }
  return null
}

/** Returns a human-readable reason, or null when the password is acceptable. */
export function validateLocalPassword(password: unknown): string | null {
  if (typeof password !== "string" || password.length === 0) return "请输入密码"
  if ([...password].length !== LOCAL_USER_PASSWORD_LENGTH) {
    return `密码必须是 ${LOCAL_USER_PASSWORD_LENGTH} 位`
  }
  return null
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, SCRYPT_KEY_BYTES).toString("hex")
}

function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest()
  const b = createHash("sha256").update(expected, "utf8").digest()
  return timingSafeEqual(a, b)
}

interface StoredLocalUser {
  id_key: string
  display_id: string
  password_salt: string
  password_hash: string
  created_at: string
}

/** SQLite-backed registry of registered users. Synchronous by design. */
export class SqliteLocalUserStore {
  constructor(private readonly db: DB) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS local_users (
        id_key TEXT PRIMARY KEY,
        display_id TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `)
    this.migrate()
  }

  /**
   * AC-03/AC-04: additive, repeatable column migrations. Existing databases
   * gain the nullable columns; every existing account keeps its row with
   * NULL for the new attributes. Re-running is a no-op.
   */
  private migrate(): void {
    const columns = this.db.pragma("table_info(local_users)") as Array<{ name: string }>
    const names = new Set(columns.map((column) => column.name))
    if (!names.has("last_login")) {
      this.db.exec("ALTER TABLE local_users ADD COLUMN last_login TEXT")
    }
    if (!names.has("disabled_at")) {
      this.db.exec("ALTER TABLE local_users ADD COLUMN disabled_at TEXT")
    }
  }

  /** Insert a new user. Returns null when the ID is already taken. */
  create(displayId: string, password: string): LocalUserRecord | null {
    const idKey = normalizeLocalId(displayId)
    const salt = randomBytes(16).toString("hex")
    const createdAt = new Date().toISOString()
    try {
      this.db
        .prepare(
          `INSERT INTO local_users (id_key, display_id, password_salt, password_hash, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(idKey, displayId, salt, hashPassword(password, salt), createdAt)
    } catch (error) {
      if ((error as { code?: unknown }).code === "SQLITE_CONSTRAINT_PRIMARYKEY") return null
      throw error
    }
    return { idKey, displayId, createdAt }
  }

  find(id: string): LocalUserRecord | null {
    const row = this.db
      .prepare(
        `SELECT id_key, display_id, created_at, disabled_at FROM local_users WHERE id_key = ?`,
      )
      .get(normalizeLocalId(id)) as
      | (Pick<StoredLocalUser, "id_key" | "display_id" | "created_at"> & {
          disabled_at: string | null
        })
      | undefined
    if (!row) return null
    // AC-04: the issuer's closed lookup never resolves a disabled account,
    // so no token can be minted for one through any path.
    if (row.disabled_at !== null) return null
    return { idKey: row.id_key, displayId: row.display_id, createdAt: row.created_at }
  }

  /**
   * AC-03: stamp a successful sign-in. Failures never reach this method; the
   * administrator is not a table row, so the update is a harmless no-op for
   * that identity.
   */
  touchLastLogin(idKey: string, when: Date = new Date()): void {
    this.db
      .prepare(`UPDATE local_users SET last_login = ? WHERE id_key = ?`)
      .run(when.toISOString(), idKey)
  }

  /**
   * AC-04: disable or re-enable an account. Idempotent — the same state
   * written twice leaves the same row; the caller gets the fresh record.
   * Disabling never deletes anything: the row, its workspace, documents and
   * conversations all stay (v1 has no hard delete). Returns null when the
   * account does not exist.
   */
  setDisabled(idKey: string, disabledAt: Date | null): AdminUserRow | null {
    const key = normalizeLocalId(idKey)
    // Disabling keeps the FIRST disable timestamp (COALESCE), so repeating
    // the action is genuinely idempotent and the operator sees when the
    // account was actually locked, not when the click last happened.
    const statement = this.db.prepare(
      disabledAt
        ? `UPDATE local_users SET disabled_at = COALESCE(disabled_at, ?) WHERE id_key = ?`
        : `UPDATE local_users SET disabled_at = NULL WHERE id_key = ?`,
    )
    const info = statement.run(
      ...(disabledAt ? [disabledAt.toISOString(), key] : [key]),
    )
    if (info.changes === 0) return null
    return this.rowByIdKey(key)
  }

  /** The directory row for one account, or null when it does not exist. */
  rowByIdKey(idKey: string): AdminUserRow | null {
    const row = this.db
      .prepare(
        `SELECT id_key, display_id, created_at, last_login, disabled_at
         FROM local_users WHERE id_key = ?`,
      )
      .get(idKey) as
      | StoredLocalUserRow
      | undefined
    if (!row) return null
    return mapStoredUserRow(row)
  }

  /**
   * AC-06: the account overview. Only what this data can honestly support:
   * the registry knows when an account was created and whether it is
   * disabled — there is no login-event table, so the answer carries no
   * "daily active" fiction. The 14-day window is LOCAL calendar days with
   * zero-filled gaps, computed here so every caller sees the same shape.
   */
  overview(now: Date = new Date()): AdminOverview {
    const counts = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN disabled_at IS NULL THEN 1 ELSE 0 END) AS active
         FROM local_users`,
      )
      .get() as { total: number; active: number | null }
    const total = counts.total
    const active = counts.active ?? 0

    const windowStart = startOfLocalDay(now)
    windowStart.setDate(windowStart.getDate() - 13)
    const created = this.db
      .prepare(`SELECT created_at FROM local_users WHERE created_at >= ?`)
      .all(windowStart.toISOString()) as Array<{ created_at: string }>
    const perDay = new Map<string, number>()
    for (const row of created) {
      const parsed = new Date(row.created_at)
      if (Number.isNaN(parsed.getTime())) continue
      const key = localDateKey(parsed)
      perDay.set(key, (perDay.get(key) ?? 0) + 1)
    }
    const newUsers: AdminOverview["newUsers"] = []
    for (let index = 0; index < 14; index += 1) {
      const day = new Date(windowStart)
      day.setDate(windowStart.getDate() + index)
      const key = localDateKey(day)
      newUsers.push({ date: key, count: perDay.get(key) ?? 0 })
    }
    return { total, active, disabled: total - active, newUsers }
  }

  /**
   * AC-05: replace the credential with a fresh salt/hash. The old password
   * fails on the very next attempt; the plaintext is hashed here and never
   * stored, logged or returned.
   */
  setPassword(idKey: string, password: string): void {
    const key = normalizeLocalId(idKey)
    const salt = randomBytes(16).toString("hex")
    this.db
      .prepare(
        `UPDATE local_users SET password_salt = ?, password_hash = ? WHERE id_key = ?`,
      )
      .run(salt, hashPassword(password, salt), key)
  }

  /**
   * AC-03: the operator's user directory page. `q` matches the account ID
   * case-insensitively (both sides go through the same normalization the
   * registry itself uses) anywhere in the ID; ordering is newest first with
   * the stable id as tiebreaker. Out-of-range offsets simply page past the
   * end while `total` stays correct.
   */
  pageUsers(params: {
    q?: string
    status?: "all" | "active" | "disabled"
    page: number
    pageSize: number
  }): AdminUserPage {
    const needle = normalizeLocalId(params.q ?? "")
    // Parameterized containment match on the normalized id — the caller's
    // string never becomes SQL syntax.
    const clauses: string[] = []
    const bindings: Array<string | number> = []
    if (needle) {
      clauses.push("instr(id_key, ?) > 0")
      bindings.push(needle)
    }
    if (params.status === "active") clauses.push("disabled_at IS NULL")
    if (params.status === "disabled") clauses.push("disabled_at IS NOT NULL")
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
    const countStatement = this.db.prepare(
      `SELECT COUNT(*) AS n FROM local_users ${where}`,
    )
    const total = (countStatement.get(...bindings) as { n: number }).n
    const listStatement = this.db.prepare(
      `SELECT id_key, display_id, created_at, last_login, disabled_at
       FROM local_users ${where}
       ORDER BY created_at DESC, id_key DESC
       LIMIT ? OFFSET ?`,
    )
    const rows = listStatement.all(
      ...bindings,
      params.pageSize,
      (params.page - 1) * params.pageSize,
    ) as StoredLocalUserRow[]
    return { items: rows.map(mapStoredUserRow), total }
  }

  /**
   * Look the user up and verify the password in constant time. A disabled
   * account (AC-04) reads exactly like a wrong password — the caller cannot
   * distinguish "no such account", "wrong password" and "disabled", and no
   * token is ever minted for a disabled row.
   */
  verify(id: string, password: string): LocalUserRecord | null {
    const row = this.db
      .prepare(
        `SELECT id_key, display_id, password_salt, password_hash, created_at, disabled_at
         FROM local_users WHERE id_key = ?`,
      )
      .get(normalizeLocalId(id)) as
      | (StoredLocalUser & { disabled_at: string | null })
      | undefined
    if (!row) return null
    if (row.disabled_at !== null) return null
    const expected = Buffer.from(row.password_hash, "hex")
    const actual = Buffer.from(hashPassword(password, row.password_salt), "hex")
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
    return {
      idKey: row.id_key,
      displayId: row.display_id,
      createdAt: row.created_at,
    }
  }
}

export interface LocalAuthOptions {
  /** The administrator's special ID; compared case-insensitively. */
  adminId: string
  /** The administrator's password; kept in server config only. */
  adminPassword: string
}

function adminIdentity(adminId: string): LocalIdentity {
  return {
    idKey: normalizeLocalId(adminId),
    displayId: adminId,
    role: "admin",
    subjectId: LOCAL_ADMIN_SUBJECT_ID,
    groups: [DEMO_ADMIN_GROUP],
    scopes: [...ALL_LOCAL_SCOPES],
  }
}

function userIdentity(record: LocalUserRecord): LocalIdentity {
  return {
    idKey: record.idKey,
    displayId: record.displayId,
    role: "user",
    subjectId: `user:${record.idKey}`,
    groups: [],
    // Local sign-in has no second authorization tier: registered accounts get
    // the same capabilities as the administrator.
    scopes: [...ALL_LOCAL_SCOPES],
  }
}

/**
 * Credential authority for the local sign-in. One instance is shared by the
 * sign-in proxy (password check + registration) and the issuer (claims for an
 * account the proxy just accepted), so both sides agree on who exists.
 */
export class LocalAuthService {
  private readonly admin: LocalIdentity

  constructor(
    private readonly store: SqliteLocalUserStore,
    private readonly options: LocalAuthOptions,
  ) {
    this.admin = adminIdentity(options.adminId)
  }

  get idMaxLength(): number {
    return LOCAL_USER_ID_MAX_LENGTH
  }

  get passwordLength(): number {
    return LOCAL_USER_PASSWORD_LENGTH
  }

  /**
   * AC-03: the sign-in proxy calls this after `authenticate` accepted the
   * credentials — failed attempts never reach it. A no-op for the
   * administrator, who is not a registered row.
   */
  noteSuccessfulLogin(idKey: string, when: Date = new Date()): void {
    this.store.touchLastLogin(idKey, when)
  }

  /**
   * AC-05: the operator's password reset. Exactly the registration rule —
   * precisely 8 characters — with a fresh salt, so the old password dies
   * immediately. The result names the reason so the router can map it to
   * one stable HTTP contract: 400 invalid, 404 unknown, 409 disabled.
   */
  resetPassword(
    idKey: string,
    password: unknown,
  ): { ok: true; idKey: string } | { ok: false; code: "invalid_password" | "not_found" | "disabled"; message: string } {
    const passwordError = validateLocalPassword(password)
    if (passwordError) {
      return { ok: false, code: "invalid_password", message: passwordError }
    }
    const row = this.store.rowByIdKey(normalizeLocalId(idKey))
    if (!row) {
      return { ok: false, code: "not_found", message: "user not found" }
    }
    if (row.disabledAt !== null) {
      return {
        ok: false,
        code: "disabled",
        message: "该账号已禁用，请先启用再重置密码",
      }
    }
    this.store.setPassword(row.idKey, password as string)
    return { ok: true, idKey: row.idKey }
  }

  /** Admin first: its ID is reserved and never lives in the user table. */
  authenticate(id: unknown, password: unknown): LocalIdentity | null {
    if (typeof id !== "string" || typeof password !== "string") return null
    if (
      normalizeLocalId(id) === this.admin.idKey &&
      secretsMatch(password, this.options.adminPassword)
    ) {
      return this.admin
    }
    const record = this.store.verify(id, password)
    return record ? userIdentity(record) : null
  }

  register(id: unknown, password: unknown): RegisterResult {
    const idError = validateLocalId(id)
    if (idError) return { ok: false, code: "invalid_id", message: idError }
    const passwordError = validateLocalPassword(password)
    if (passwordError) {
      return { ok: false, code: "invalid_password", message: passwordError }
    }
    const displayId = id as string
    // The administrator's ID is reserved, but the response is identical to a
    // registered ID: registration must not become an account-existence oracle.
    if (normalizeLocalId(displayId) === this.admin.idKey) {
      return { ok: false, code: "id_taken", message: "这个 ID 已被注册" }
    }
    const record = this.store.create(displayId, password as string)
    if (!record) {
      return { ok: false, code: "id_taken", message: "这个 ID 已被注册" }
    }
    return { ok: true, identity: userIdentity(record) }
  }

  /**
   * The issuer's closed lookup: a normalised account key resolves only to the
   * administrator or a registered user. Anything else is rejected.
   */
  identityForAccount(account: string): LocalIdentity | null {
    if (account === this.admin.idKey) return this.admin
    const record = this.store.find(account)
    return record ? userIdentity(record) : null
  }

  /** Token claims for an account the sign-in proxy already authenticated. */
  claimsForAccount(account: string): {
    sub: string
    tenant_id: string
    groups: string[]
    scope: string
    name: string
  } | null {
    const identity = this.identityForAccount(account)
    if (!identity) return null
    return {
      sub: identity.subjectId,
      tenant_id: tenantIdForIdentity(identity),
      groups: [...identity.groups],
      scope: identity.scopes.join(" "),
      name: identity.displayId,
    }
  }
}
