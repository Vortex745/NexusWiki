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
import type { Scope } from "../access/context"
import type { DB } from "../ingestion/tracking/db"
import { DEMO_ADMIN_GROUP, DEMO_TENANT_ID } from "./demo_accounts"

export const LOCAL_USER_ID_MAX_LENGTH = 5
export const LOCAL_USER_PASSWORD_LENGTH = 8

/** The seeded administrator's subject stays stable so demo data keeps its owner. */
const LOCAL_ADMIN_SUBJECT_ID = "demo-admin"

const ID_PATTERN = /^[\p{Script=Han}A-Za-z]+$/u
const SCRYPT_KEY_BYTES = 64

export interface LocalUserRecord {
  idKey: string
  displayId: string
  createdAt: string
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
        `SELECT id_key, display_id, created_at FROM local_users WHERE id_key = ?`,
      )
      .get(normalizeLocalId(id)) as
      | Pick<StoredLocalUser, "id_key" | "display_id" | "created_at">
      | undefined
    if (!row) return null
    return { idKey: row.id_key, displayId: row.display_id, createdAt: row.created_at }
  }

  /** Look the user up and verify the password in constant time. */
  verify(id: string, password: string): LocalUserRecord | null {
    const row = this.db
      .prepare(
        `SELECT id_key, display_id, password_salt, password_hash, created_at
         FROM local_users WHERE id_key = ?`,
      )
      .get(normalizeLocalId(id)) as StoredLocalUser | undefined
    if (!row) return null
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
    scopes: ["chat", "ingest", "review", "admin"],
  }
}

function userIdentity(record: LocalUserRecord): LocalIdentity {
  return {
    idKey: record.idKey,
    displayId: record.displayId,
    role: "user",
    subjectId: `user:${record.idKey}`,
    groups: [],
    scopes: ["chat"],
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
      tenant_id: DEMO_TENANT_ID,
      groups: [...identity.groups],
      scope: identity.scopes.join(" "),
      name: identity.displayId,
    }
  }
}
