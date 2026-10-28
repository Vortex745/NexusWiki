import assert from "node:assert/strict"
import test from "node:test"
import { createServer } from "node:net"
import express from "express"
import type { Request, Response } from "express"
import Database from "better-sqlite3"
import { createAccessMiddleware } from "./access_middleware"
import { createSessionRouter, type LocalAuthOptions } from "./session"
import { JoseIdentityAdapter } from "../identity/jose_adapter"
import { startDemoOidcIssuer, DEMO_TOKEN_TTL_SECONDS, type DemoOidcIssuerHandle } from "../identity/demo_oidc_issuer"
import { DEMO_TENANT_ID } from "../identity/demo_accounts"
import { LocalAuthService, SqliteLocalUserStore } from "../identity/local_users"
import type { AccessContext, IdentityAdapter } from "../access/context"

/**
 * Ticket 01 (IAM-01) acceptance: local ID/password identities.
 *
 * The harness wires the REAL pieces over real HTTP: the loopback issuer mints
 * real RS256 tokens for the administrator's special ID and for users
 * registered into a real SQLite table, the production JoseIdentityAdapter
 * verifies them against the issuer's real JWKS, and the real access middleware
 * + session router produce the role/groups/scopes the browser may see.
 */

const ADMIN_ID = "boss"
const ADMIN_PASSWORD = "Boss8888"
const USER_PASSWORD = "Pass1234"
const AUDIENCE = "nexusrag-demo-test"

interface Harness {
  port: number
  issuer: DemoOidcIssuerHandle
  localAuth: LocalAuthService
  demoAuth: LocalAuthOptions
  close(): Promise<void>
}

/**
 * `demoAuth: false` builds the legacy shape: single-tenant middleware, no
 * local sign-in. Everything else is identical, so the compatibility assertion
 * exercises the same server surface.
 */
async function startHarness(options: { demoAuth: boolean }): Promise<Harness> {
  const db = new Database(":memory:")
  const localAuth = new LocalAuthService(new SqliteLocalUserStore(db), {
    adminId: ADMIN_ID,
    adminPassword: ADMIN_PASSWORD,
  })
  const issuer = await startDemoOidcIssuer({
    port: 0,
    audience: AUDIENCE,
    resolveClaims: (account) => localAuth.claimsForAccount(account),
  })
  const adapter: IdentityAdapter = new JoseIdentityAdapter({
    config: {
      kind: "active",
      issuer: issuer.issuer,
      audience: AUDIENCE,
      jwksEndpoint: issuer.jwksEndpoint,
      claimMapping: { tenantClaim: "tenant_id", subjectClaim: "sub", groupsClaim: "groups" },
      clockSkewSeconds: 60,
    },
  })
  const demoAuth: LocalAuthOptions = {
    tokenEndpoint: issuer.tokenEndpoint,
    tokenAuth: issuer.tokenAuth,
    localAuth,
  }

  const app = express()
  app.use(express.json())
  const mode = options.demoAuth ? "enforced" : "single_tenant"
  const identityMiddleware = createAccessMiddleware({ mode, ...(options.demoAuth ? { adapter } : {}) })
  app.use("/api/session", identityMiddleware)
  app.use("/api", createSessionRouter(options.demoAuth ? { demoAuth } : {}))
  // Stand-in for an administrator-only mutation: the same middleware factory
  // and scope the production server mounts on /api/ingest.
  app.post(
    "/api/admin-probe",
    createAccessMiddleware({ mode, ...(options.demoAuth ? { adapter } : {}), requiredScope: "admin" }),
    (_req: Request, res: Response) => res.status(204).end()
  )

  const server = app.listen(0, "127.0.0.1")
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const port = (server.address() as { port: number }).port
  return {
    port,
    issuer,
    localAuth,
    demoAuth,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await issuer.stop()
      db.close()
    },
  }
}

async function login(port: number, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

async function register(port: number, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

async function getSession(port: number, token?: string) {
  const res = await fetch(`http://127.0.0.1:${port}/api/session`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

async function postAdminProbe(port: number, token?: string) {
  const res = await fetch(`http://127.0.0.1:${port}/api/admin-probe`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  return res.status
}

/** Call the issuer's `/token` directly, the way its only trusted client does. */
async function issuerToken(
  issuer: DemoOidcIssuerHandle,
  body: unknown,
  authorized = true
): Promise<globalThis.Response> {
  return fetch(issuer.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorized ? { authorization: `Bearer ${issuer.tokenAuth}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

test("the administrator signs in with the special ID and receives the admin role", async () => {
  const harness = await startHarness({ demoAuth: true })
  try {
    const signIn = await login(harness.port, { id: "BOSS", password: ADMIN_PASSWORD })
    assert.equal(signIn.status, 200, "the admin ID is compared case-insensitively")
    const token = signIn.json.accessToken as string
    assert.equal(typeof token, "string")
    assert.equal(token.split(".").length, 3, "the issued token must be a JWT")

    const session = await getSession(harness.port, token)
    assert.equal(session.status, 200)
    assert.equal(session.json.tenantId, DEMO_TENANT_ID)
    assert.equal(session.json.subjectId, "demo-admin")
    assert.equal(session.json.displayName, ADMIN_ID)
    assert.deepEqual(session.json.groups, ["demo-admins"])
    assert.deepEqual(session.json.scopes, ["chat", "ingest", "review", "admin"])
    assert.equal(session.json.role, "admin")
    assert.equal(await postAdminProbe(harness.port, token), 204)
  } finally {
    await harness.close()
  }
})

test("a registered user signs in with its own ID and only holds chat", async () => {
  const harness = await startHarness({ demoAuth: true })
  try {
    const created = await register(harness.port, { id: "小明", password: USER_PASSWORD })
    assert.equal(created.status, 201)
    assert.deepEqual(created.json, { ok: true }, "registration never returns a token")

    const signIn = await login(harness.port, { id: "小明", password: USER_PASSWORD })
    assert.equal(signIn.status, 200)
    const token = signIn.json.accessToken as string
    const session = await getSession(harness.port, token)
    assert.equal(session.json.tenantId, DEMO_TENANT_ID)
    assert.equal(session.json.subjectId, "user:小明")
    assert.equal(session.json.displayName, "小明")
    assert.deepEqual(session.json.groups, [])
    assert.deepEqual(session.json.scopes, ["chat"])
    assert.equal(session.json.role, "reader")
    assert.equal(await postAdminProbe(harness.port, token), 403, "a reader must not mutate")
  } finally {
    await harness.close()
  }
})

test("registration enforces the ID and password rules", async () => {
  const harness = await startHarness({ demoAuth: true })
  try {
    const cases: Array<{ body: unknown; status: number; error?: string }> = [
      { body: { id: "abcdef", password: USER_PASSWORD }, status: 400, error: "invalid_id" },
      { body: { id: "abc1", password: USER_PASSWORD }, status: 400, error: "invalid_id" },
      { body: { id: "", password: USER_PASSWORD }, status: 400, error: "invalid_id" },
      { body: { id: "张三", password: "short" }, status: 400, error: "invalid_password" },
      { body: { id: "张三", password: "123456789" }, status: 400, error: "invalid_password" },
    ]
    for (const entry of cases) {
      const result = await register(harness.port, entry.body)
      assert.equal(result.status, entry.status, JSON.stringify(entry.body))
      assert.equal(result.json.error, entry.error)
      assert.equal(typeof result.json.message, "string")
    }
    const accepted = await register(harness.port, { id: "张ab", password: USER_PASSWORD })
    assert.equal(accepted.status, 201, "mixed Chinese/Latin IDs are accepted")
  } finally {
    await harness.close()
  }
})

test("ID uniqueness is case-insensitive and login accepts any casing", async () => {
  const harness = await startHarness({ demoAuth: true })
  try {
    assert.equal((await register(harness.port, { id: "Alice", password: USER_PASSWORD })).status, 201)
    const duplicate = await register(harness.port, { id: "ALICE", password: "Other123" })
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.json.error, "id_taken")

    const signIn = await login(harness.port, { id: "alice", password: USER_PASSWORD })
    assert.equal(signIn.status, 200)
    const session = await getSession(harness.port, signIn.json.accessToken as string)
    assert.equal(session.json.displayName, "Alice", "the registered casing is what the UI shows")
  } finally {
    await harness.close()
  }
})

test("the administrator ID is reserved and cannot be registered", async () => {
  const harness = await startHarness({ demoAuth: true })
  try {
    const result = await register(harness.port, { id: "BOSS", password: USER_PASSWORD })
    assert.equal(result.status, 409)
    assert.equal(result.json.error, "id_taken")
  } finally {
    await harness.close()
  }
})

test("bad credentials fail without revealing which accounts exist", async () => {
  const harness = await startHarness({ demoAuth: true })
  try {
    const attempts = [
      await login(harness.port, { id: ADMIN_ID, password: "wrong" }),
      await login(harness.port, { id: "ghost", password: USER_PASSWORD }),
      await login(harness.port, { id: ADMIN_ID }),
      await login(harness.port, { id: "小明", password: USER_PASSWORD }),
    ]
    for (const attempt of attempts) {
      assert.equal(attempt.status, 401)
      assert.equal(attempt.json.error, "invalid credentials")
    }
  } finally {
    await harness.close()
  }
})

test("a local sign-in stays valid for five days", async () => {
  const harness = await startHarness({ demoAuth: true })
  try {
    const signIn = await login(harness.port, { id: ADMIN_ID, password: ADMIN_PASSWORD })
    assert.equal(signIn.status, 200)
    const token = signIn.json.accessToken as string
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8")
    ) as { iat: number; exp: number }
    assert.equal(DEMO_TOKEN_TTL_SECONDS, 5 * 24 * 60 * 60, "the gate lifetime is five days")
    assert.equal(claims.exp - claims.iat, DEMO_TOKEN_TTL_SECONDS)
  } finally {
    await harness.close()
  }
})

test("the issuer only mints known identities and ignores injected claims", async () => {
  const harness = await startHarness({ demoAuth: true })
  try {
    await register(harness.port, { id: "小明", password: USER_PASSWORD })
    // A caller cannot promote itself: the body's own sub/tenant/groups/scope
    // are ignored, and only the account key is resolved.
    const res = await issuerToken(harness.issuer, {
      account: "小明",
      sub: "attacker",
      tenant_id: "other-tenant",
      groups: ["demo-admins"],
      scope: "chat admin",
    })
    const { access_token } = (await res.json()) as { access_token: string }
    const session = await getSession(harness.port, access_token)
    assert.equal(session.json.subjectId, "user:小明")
    assert.equal(session.json.tenantId, DEMO_TENANT_ID)
    assert.deepEqual(session.json.groups, [])
    assert.deepEqual(session.json.scopes, ["chat"])
    assert.equal(session.json.role, "reader")

    const unknown = await issuerToken(harness.issuer, { account: "not-a-registered-user" })
    assert.equal(unknown.status, 400)
  } finally {
    await harness.close()
  }
})

test("the issuer mints no token for a caller without the shared secret", async () => {
  // Without this, the password in front of the sign-in proxy would be
  // decorative: the issuer listens on loopback, so any local process could ask
  // it for an administrator token directly.
  const harness = await startHarness({ demoAuth: true })
  try {
    const direct = await issuerToken(harness.issuer, { account: ADMIN_ID }, false)
    assert.equal(direct.status, 401, "the issuer must refuse an unauthenticated caller")
    assert.equal("access_token" in ((await direct.json()) as object), false)

    const wrongSecret = await fetch(harness.issuer.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: "Bearer not-the-secret" },
      body: JSON.stringify({ account: ADMIN_ID }),
    })
    assert.equal(wrongSecret.status, 401)

    // The proxy is the one caller that can still sign an administrator in.
    const viaProxy = await login(harness.port, { id: ADMIN_ID, password: ADMIN_PASSWORD })
    assert.equal(viaProxy.status, 200)
    assert.equal(
      (await getSession(harness.port, viaProxy.json.accessToken as string)).json.role,
      "admin"
    )
  } finally {
    await harness.close()
  }
})

test("a failed bind is reported instead of hanging the startup", async () => {
  // The issuer uses a fixed port in production, so a second run would
  // otherwise await a promise that never settles and log nothing.
  const blocker = createServer()
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve))
  const busyPort = (blocker.address() as { port: number }).port
  try {
    await assert.rejects(
      () =>
        startDemoOidcIssuer({
          port: busyPort,
          audience: AUDIENCE,
          resolveClaims: () => null,
        }),
      /EADDRINUSE/
    )
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
  }
})

test("no credential or signing material appears in any response body", async () => {
  const harness = await startHarness({ demoAuth: true })
  try {
    const signIn = await login(harness.port, { id: ADMIN_ID, password: ADMIN_PASSWORD })
    assert.deepEqual(Object.keys(signIn.json), ["accessToken"], "login returns the token and nothing else")

    const configRes = await fetch(`http://127.0.0.1:${harness.port}/api/auth/config`)
    const configBody = await configRes.text()
    assert.equal(configBody.includes(ADMIN_PASSWORD), false, "the password must never be echoed")
    assert.equal(configBody.includes(ADMIN_ID), false, "the reserved ID is not advertised")
    assert.equal(configBody.includes("tokenEndpoint"), false, "the issuer endpoint stays server-side")
    assert.deepEqual(JSON.parse(configBody), {
      demoAuth: true,
      registration: true,
      idMaxLength: 5,
      passwordLength: 8,
    })

    // The public JWKS carries public key material only.
    const jwksBody = await (await fetch(harness.issuer.jwksEndpoint)).text()
    const jwks = JSON.parse(jwksBody) as { keys: Array<Record<string, unknown>> }
    assert.equal(jwks.keys.length, 1)
    for (const key of jwks.keys) {
      assert.equal(typeof key.n, "string")
      for (const secretField of ["d", "p", "q", "dp", "dq", "qi"]) {
        assert.equal(secretField in key, false, `JWKS must not publish the private field ${secretField}`)
      }
    }
  } finally {
    await harness.close()
  }
})

test("the legacy single-tenant path still works and does not use local sign-in", async () => {
  const harness = await startHarness({ demoAuth: false })
  try {
    const session = await getSession(harness.port)
    assert.equal(session.status, 200, "single_tenant needs no token")
    assert.equal(session.json.tenantId, "default")
    assert.equal(session.json.subjectId, "local")
    assert.equal(session.json.role, "admin")
    assert.equal(session.json.displayName, null)
    assert.deepEqual(session.json.scopes, ["chat", "ingest", "review", "admin"])
    assert.equal(await postAdminProbe(harness.port), 204, "local context holds the admin scope")

    assert.equal((await login(harness.port, { id: ADMIN_ID, password: ADMIN_PASSWORD })).status, 404)
    assert.equal((await register(harness.port, { id: "小明", password: USER_PASSWORD })).status, 404)
    const config = (await (await fetch(`http://127.0.0.1:${harness.port}/api/auth/config`)).json()) as unknown
    assert.deepEqual(config, {
      demoAuth: false,
      registration: false,
      idMaxLength: 0,
      passwordLength: 0,
    })
  } finally {
    await harness.close()
  }
})

test("a resolved AccessContext is the only source of the reported identity", async () => {
  // Guards the contract that /api/session reads res.locals, not the request.
  const ctx: AccessContext = {
    tenantId: "demo",
    subjectId: "user:小明",
    groups: [],
    scopes: ["chat"],
    displayName: "小明",
  }
  const app = express()
  app.use(express.json())
  app.use("/api/session", createAccessMiddleware({ mode: "enforced", adapter: { resolve: async () => ctx } }))
  app.use("/api", createSessionRouter({}))
  const server = app.listen(0, "127.0.0.1")
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const port = (server.address() as { port: number }).port
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: "GET",
      headers: { authorization: "Bearer ignored" },
    })
    assert.deepEqual(await res.json(), {
      tenantId: "demo",
      subjectId: "user:小明",
      role: "reader",
      groups: [],
      scopes: ["chat"],
      displayName: "小明",
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
