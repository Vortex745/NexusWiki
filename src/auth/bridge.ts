import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"

import type { AuthDb } from "../db/client"
import { account, user } from "../db/schema"
import {
  LOCAL_USER_ID_MAX_LENGTH,
  LOCAL_USER_PASSWORD_LENGTH,
  localWorkspaceTenantId,
  normalizeLocalId,
  validateLocalId,
  validateLocalPassword,
  type AdminOverview,
  type AdminUserPage,
  type AdminUserRow,
} from "../identity/local_users"
import { DEMO_TENANT_ID } from "../identity/demo_accounts"
import {
  AUTH_CLIENT_IP_HEADER,
  hashLocalPassword,
  localIdentityEmail,
  verifyLocalPassword,
  type BetterAuthHandle,
} from "./better_auth"
import { AuthUserDirectory } from "./user_directory"

export type RegisterResult =
  | { ok: true }
  | {
      ok: false
      code: "invalid_id" | "invalid_password" | "id_taken"
      message: string
    }

export type SignInResult =
  | { kind: "signed_in"; accessToken: string }
  | { kind: "invalid_credentials" }
  | { kind: "rate_limited"; retryAfter: string | null }

export interface AuthBridge {
  readonly idMaxLength: number
  readonly passwordLength: number
  register(id: unknown, password: unknown): Promise<RegisterResult>
  signIn(id: unknown, password: unknown, clientIp?: string): Promise<SignInResult>
  resetPassword(
    idKey: string,
    password: unknown,
  ): { ok: true; idKey: string } | {
    ok: false
    code: "invalid_password" | "not_found" | "disabled"
    message: string
  }
  overview(now?: Date): AdminOverview
  pageUsers(params: {
    q?: string
    status?: "all" | "active" | "disabled"
    page: number
    pageSize: number
  }): AdminUserPage
  setDisabled(idKey: string, disabledAt: Date | null): AdminUserRow | null
  rowByIdKey(idKey: string): AdminUserRow | null
  jwks(): Promise<unknown>
}

export interface AuthBridgeOptions {
  db: AuthDb
  baseURL: string
  auth: BetterAuthHandle["auth"]
  adminId: string
  adminPassword: string
}

interface LegacyUserRow {
  id_key: string
  display_id: string
  password_salt: string
  password_hash: string
  created_at: string
  last_login: string | null
  disabled_at: string | null
}

function dateOrNull(value: string | null): Date | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function dateOrNow(value: string): Date {
  return dateOrNull(value) ?? new Date()
}

/** Copy the pre-Better-Auth rows once, preserving their password hashes. */
function backfillLegacyUsers(db: AuthDb, directory: AuthUserDirectory): void {
  const columns = db.$client.prepare<[], { name: string }>("PRAGMA table_info(local_users)").all()
  if (columns.length === 0) return
  const names = new Set(columns.map(({ name }) => name))
  const rows = db.$client
    .prepare(
      `SELECT id_key, display_id, password_salt, password_hash, created_at,
         ${names.has("last_login") ? "last_login" : "NULL AS last_login"},
         ${names.has("disabled_at") ? "disabled_at" : "NULL AS disabled_at"}
       FROM local_users`,
    )
    .all() as LegacyUserRow[]
  for (const row of rows) {
    if (directory.findByIdentity(row.id_key)) continue
    const id = randomUUID()
    const createdAt = dateOrNow(row.created_at)
    const tenantId = localWorkspaceTenantId(`user:${row.id_key}`)
    db.transaction((tx) => {
      tx.insert(user)
        .values({
          id,
          name: row.display_id,
          email: localIdentityEmail(row.id_key),
          emailVerified: true,
          createdAt,
          updatedAt: new Date(),
          identityKey: row.id_key,
          tenantId,
          isAdmin: false,
          disabledAt: dateOrNull(row.disabled_at),
          lastLoginAt: dateOrNull(row.last_login),
        })
        .run()
      tx.insert(account)
        .values({
          id: randomUUID(),
          accountId: id,
          providerId: "credential",
          userId: id,
          password: `${row.password_salt}:${row.password_hash}`,
          createdAt,
          updatedAt: new Date(),
        })
        .run()
    })
  }
}

async function ensureAdmin(
  db: AuthDb,
  directory: AuthUserDirectory,
  adminId: string,
  adminPassword: string,
): Promise<void> {
  const idKey = normalizeLocalId(adminId)
  const now = new Date()
  const existing = directory.findByIdentity(idKey)
  if (!existing) {
    const id = randomUUID()
    db.transaction((tx) => {
      tx.insert(user)
        .values({
          id,
          name: adminId,
          email: localIdentityEmail(idKey),
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
          identityKey: idKey,
          tenantId: DEMO_TENANT_ID,
          isAdmin: true,
        })
        .run()
      tx.insert(account)
        .values({
          id: randomUUID(),
          accountId: id,
          providerId: "credential",
          userId: id,
          password: hashLocalPassword(adminPassword),
          createdAt: now,
          updatedAt: now,
        })
        .run()
    })
    return
  }

  if (!existing.isAdmin || existing.tenantId !== DEMO_TENANT_ID) {
    db.update(user)
      .set({ isAdmin: true, tenantId: DEMO_TENANT_ID, updatedAt: now })
      .where(eq(user.id, existing.id))
      .run()
  }
  const accountRow = db
    .select()
    .from(account)
    .where(eq(account.userId, existing.id))
    .get()
  const passwordMatches = accountRow?.password
    ? await verifyLocalPassword({ hash: accountRow.password, password: adminPassword })
    : false
  if (!passwordMatches) {
    db.update(account)
      .set({ password: hashLocalPassword(adminPassword), updatedAt: now })
      .where(eq(account.userId, existing.id))
      .run()
  }
}

export async function createAuthBridge(options: AuthBridgeOptions): Promise<AuthBridge> {
  const baseURL = options.baseURL.replace(/\/+$/, "")
  const directory = new AuthUserDirectory(options.db)
  backfillLegacyUsers(options.db, directory)
  await ensureAdmin(options.db, directory, options.adminId, options.adminPassword)

  const callAuth = async (
    path: string,
    init: { method?: string; body?: unknown; cookie?: string; clientIp?: string } = {},
  ): Promise<Response> => {
    const headers: Record<string, string> = { origin: baseURL }
    if (init.body !== undefined) headers["content-type"] = "application/json"
    if (init.cookie) headers.cookie = init.cookie
    if (init.clientIp) headers[AUTH_CLIENT_IP_HEADER] = init.clientIp
    return options.auth.handler(
      new Request(`${baseURL}/api/auth${path}`, {
        method: init.method ?? "GET",
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      }),
    )
  }

  return {
    idMaxLength: LOCAL_USER_ID_MAX_LENGTH,
    passwordLength: LOCAL_USER_PASSWORD_LENGTH,

    async register(id, password) {
      const idError = validateLocalId(id)
      if (idError) return { ok: false, code: "invalid_id", message: idError }
      const passwordError = validateLocalPassword(password)
      if (passwordError) return { ok: false, code: "invalid_password", message: passwordError }
      const displayId = id as string
      const idKey = normalizeLocalId(displayId)
      if (idKey === normalizeLocalId(options.adminId) || directory.findByIdentity(idKey)) {
        return { ok: false, code: "id_taken", message: "这个 ID 已被注册" }
      }
      try {
        await options.auth.api.signUpEmail({
          body: {
            name: displayId,
            email: localIdentityEmail(idKey),
            password: password as string,
            identityKey: idKey,
            tenantId: localWorkspaceTenantId(`user:${idKey}`),
            isAdmin: false,
          },
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/exist|unique|already/i.test(message)) {
          return { ok: false, code: "id_taken", message: "这个 ID 已被注册" }
        }
        throw error
      }
      return { ok: true }
    },

    async signIn(id, password, clientIp) {
      if (typeof id !== "string" || typeof password !== "string") return { kind: "invalid_credentials" }
      const row = directory.findByIdentity(id)
      const active = row && !row.disabledAt ? row : null
      // Unknown and disabled accounts must hit the same limiter without signing in.
      const signIn = await callAuth("/sign-in/email", {
        method: "POST",
        body: { email: active?.email ?? "unregistered@local.invalid", password },
        clientIp,
      })
      if (signIn.status === 429) {
        return { kind: "rate_limited", retryAfter: signIn.headers.get("X-Retry-After") }
      }
      if (!signIn.ok || !active) return { kind: "invalid_credentials" }
      const cookie = signIn.headers.get("set-cookie")?.split(";")[0]
      if (!cookie) throw new Error("Better Auth did not return a session cookie")
      const tokenResponse = await callAuth("/token", { cookie, clientIp })
      if (tokenResponse.status === 429) {
        return { kind: "rate_limited", retryAfter: tokenResponse.headers.get("X-Retry-After") }
      }
      if (!tokenResponse.ok) {
        throw new Error("Better Auth did not issue a JWT for the new session")
      }
      const payload = (await tokenResponse.json()) as { token?: unknown }
      if (typeof payload.token !== "string" || payload.token.length === 0) {
        throw new Error("Better Auth returned no JWT token")
      }
      options.db
        .update(user)
        .set({ lastLoginAt: new Date(), updatedAt: new Date() })
        .where(eq(user.id, active.id))
        .run()
      return { kind: "signed_in", accessToken: payload.token }
    },

    resetPassword(idKey, password) {
      const passwordError = validateLocalPassword(password)
      if (passwordError) {
        return { ok: false, code: "invalid_password", message: passwordError }
      }
      const row = directory.findByIdentity(idKey)
      if (!row) return { ok: false, code: "not_found", message: "user not found" }
      if (row.disabledAt) {
        return { ok: false, code: "disabled", message: "该账号已禁用，请先启用再重置密码" }
      }
      const updated = options.db
        .update(account)
        .set({ password: hashLocalPassword(password as string), updatedAt: new Date() })
        .where(eq(account.userId, row.id))
        .run()
      if (updated.changes === 0) {
        return { ok: false, code: "not_found", message: "user not found" }
      }
      return { ok: true, idKey: row.identityKey }
    },

    overview: (now) => directory.overview(now),
    pageUsers: (params) => directory.pageUsers(params),
    setDisabled: (idKey, disabledAt) => directory.setDisabled(idKey, disabledAt),
    rowByIdKey: (idKey) => directory.rowByIdKey(idKey),

    async jwks() {
      return options.auth.api.getJwks()
    },
  }
}
