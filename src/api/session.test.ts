import assert from "node:assert/strict"
import test from "node:test"
import { createServer } from "node:net"
import express from "express"
import type { Request, Response } from "express"
import { createAccessMiddleware } from "./access_middleware"
import { createSessionRouter, type DemoAuthOptions } from "./session"
import { JoseIdentityAdapter } from "../identity/jose_adapter"
import { startDemoOidcIssuer, DEMO_TOKEN_TTL_SECONDS, type DemoOidcIssuerHandle } from "../identity/demo_oidc_issuer"
import { DEMO_ACCOUNTS, DEMO_TENANT_ID } from "../identity/demo_accounts"
import type { AccessContext, IdentityAdapter } from "../access/context"

/**
 * Ticket 01 (IAM-01) acceptance: three real local OIDC identities.
 *
 * The harness wires the REAL pieces over real HTTP: the loopback demo issuer
 * mints real RS256 tokens, the production JoseIdentityAdapter verifies them
 * against the issuer's real JWKS, and the real access middleware + session
 * router produce the role/group/scopes the browser is allowed to see.
 */

const DEMO_PASSWORD = "correct-horse-battery"
const AUDIENCE = "nexusrag-demo-test"

interface Harness {
  port: number
  issuer: DemoOidcIssuerHandle
  demoAuth: DemoAuthOptions
  close(): Promise<void>
}

/**
 * `demoAuth: false` builds the legacy shape: single-tenant middleware, no
 * demo sign-in. Everything else is identical, so the compatibility assertion
 * exercises the same server surface.
 */
async function startHarness(options: { demoAuth: boolean }): Promise<Harness> {
  const issuer = await startDemoOidcIssuer({ port: 0, audience: AUDIENCE })
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
  const demoAuth: DemoAuthOptions = {
    tokenEndpoint: issuer.tokenEndpoint,
    password: DEMO_PASSWORD,
    tokenAuth: issuer.tokenAuth,
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
    demoAuth,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await issuer.stop()
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

test("Ticket 01: all three demo accounts receive the expected role, groups and scopes", async () => {
  const harness = await startHarness({ demoAuth: true })
  try {
    for (const account of DEMO_ACCOUNTS) {
      const signIn = await login(harness.port, { account: account.key, password: DEMO_PASSWORD })
      assert.equal(signIn.status, 200, `${account.key} must be able to sign in`)
      const token = signIn.json.accessToken as string
      assert.equal(typeof token, "string")
      assert.equal(token.split(".").length, 3, "the issued token must be a JWT")

      const session = await getSession(harness.port, token)
      assert.equal(session.status, 200, `${account.key} session must resolve`)
      assert.equal(session.json.tenantId, DEMO_TENANT_ID)
      assert.equal(session.json.subjectId, account.subjectId)
      assert.deepEqual(session.json.groups, account.groups, `${account.key} group membership`)
      assert.deepEqual(session.json.scopes, account.scopes, `${account.key} scopes`)
      assert.equal(
        session.json.role,
        account.scopes.includes("admin") ? "admin" : "reader",
        `${account.key} role is derived from the granted scopes`
      )
    }
  } finally {
    await harness.close()
  }
})

test("Ticket 01: a demo sign-in stays valid for seven days", async () => {
  const harness = await startHarness({ demoAuth: true })
  try {
    const signIn = await login(harness.port, { account: "admin", password: DEMO_PASSWORD })
    assert.equal(signIn.status, 200)
    const token = signIn.json.accessToken as string
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8")
    ) as { iat: number; exp: number }
    assert.equal(DEMO_TOKEN_TTL_SECONDS, 7 * 24 * 60 * 60, "the gate lifetime is seven days")
    assert.equal(claims.exp - claims.iat, DEMO_TOKEN_TTL_SECONDS)
  } finally {
    await harness.close()
  }
})

test("Ticket 01: readers are rejected from administrator mutations, the administrator is not", async () => {
  const harness = await startHarness({ demoAuth: true })
  try {
    const adminToken = (await login(harness.port, { account: "admin", password: DEMO_PASSWORD }))
      .json.accessToken as string
    assert.equal(await postAdminProbe(harness.port, adminToken), 204)

    for (const key of ["technical-reader", "policy-reader"]) {
      const token = (await login(harness.port, { account: key, password: DEMO_PASSWORD }))
        .json.accessToken as string
      assert.equal(await postAdminProbe(harness.port, token), 403, `${key} must not mutate`)
    }
  } finally {
    await harness.close()
  }
})

test("Ticket 01: a missing or unverifiable token is rejected before any handler runs", async () => {
  const harness = await startHarness({ demoAuth: true })
  try {
    assert.equal((await getSession(harness.port)).status, 401)
    assert.equal((await getSession(harness.port, "not-a-jwt")).status, 401)
    // Signed by the issuer, but for an audience the adapter does not trust.
    const foreign = await startDemoOidcIssuer({ port: 0, audience: "another-audience" })
    try {
      const res = await issuerToken(foreign, { account: "admin" })
      const { access_token } = (await res.json()) as { access_token: string }
      assert.equal((await getSession(harness.port, access_token)).status, 401)
    } finally {
      await foreign.stop()
    }
  } finally {
    await harness.close()
  }
})

test("Ticket 01: the issuer only mints the preset accounts and ignores injected claims", async () => {
  const harness = await startHarness({ demoAuth: true })
  try {
    // A caller cannot promote itself: the body's own sub/groups/scope are ignored.
    const res = await issuerToken(harness.issuer, {
      account: "policy-reader",
      sub: "attacker",
      tenant_id: "other-tenant",
      groups: ["demo-admins"],
      scope: "chat admin",
    })
    const { access_token } = (await res.json()) as { access_token: string }
    const session = await getSession(harness.port, access_token)
    assert.equal(session.json.subjectId, "demo-policy-reader")
    assert.equal(session.json.tenantId, DEMO_TENANT_ID)
    assert.deepEqual(session.json.groups, ["demo-policy-readers"])
    assert.deepEqual(session.json.scopes, ["chat"])
    assert.equal(session.json.role, "reader")

    const unknown = await issuerToken(harness.issuer, { account: "not-a-demo-account" })
    assert.equal(unknown.status, 400)
  } finally {
    await harness.close()
  }
})

test("Ticket 01: the issuer mints no token for a caller without the shared secret", async () => {
  // Without this, the password in front of the sign-in proxy would be
  // decorative: the issuer listens on loopback, so any local process could ask
  // it for an administrator token directly.
  const harness = await startHarness({ demoAuth: true })
  try {
    const direct = await issuerToken(harness.issuer, { account: "admin" }, false)
    assert.equal(direct.status, 401, "the issuer must refuse an unauthenticated caller")
    assert.equal("access_token" in ((await direct.json()) as object), false)

    const wrongSecret = await fetch(harness.issuer.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: "Bearer not-the-secret" },
      body: JSON.stringify({ account: "admin" }),
    })
    assert.equal(wrongSecret.status, 401)

    // The proxy is the one caller that can still sign an administrator in.
    const viaProxy = await login(harness.port, { account: "admin", password: DEMO_PASSWORD })
    assert.equal(viaProxy.status, 200)
    assert.equal(
      (await getSession(harness.port, viaProxy.json.accessToken as string)).json.role,
      "admin"
    )
  } finally {
    await harness.close()
  }
})

test("Ticket 01: a failed bind is reported instead of hanging the startup", async () => {
  // The demo issuer uses a fixed port by default, so a second run would
  // otherwise await a promise that never settles and log nothing.
  const blocker = createServer()
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve))
  const busyPort = (blocker.address() as { port: number }).port
  try {
    await assert.rejects(
      () => startDemoOidcIssuer({ port: busyPort, audience: AUDIENCE }),
      /EADDRINUSE/
    )
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
  }
})

test("Ticket 01: bad credentials fail without revealing which accounts exist", async () => {
  const harness = await startHarness({ demoAuth: true })
  try {
    const wrongPassword = await login(harness.port, { account: "admin", password: "wrong" })
    const unknownAccount = await login(harness.port, { account: "ghost", password: DEMO_PASSWORD })
    const missingPassword = await login(harness.port, { account: "admin" })
    for (const attempt of [wrongPassword, unknownAccount, missingPassword]) {
      assert.equal(attempt.status, 401)
      assert.equal(attempt.json.error, "invalid credentials")
    }
  } finally {
    await harness.close()
  }
})

test("Ticket 01: no credential or signing material appears in any response body", async () => {
  const harness = await startHarness({ demoAuth: true })
  try {
    const signIn = await login(harness.port, { account: "admin", password: DEMO_PASSWORD })
    assert.deepEqual(Object.keys(signIn.json), ["accessToken"], "login returns the token and nothing else")

    const configRes = await fetch(`http://127.0.0.1:${harness.port}/api/auth/config`)
    const configBody = await configRes.text()
    assert.equal(configBody.includes(DEMO_PASSWORD), false, "the password must never be echoed")
    assert.equal(configBody.includes("tokenEndpoint"), false, "the issuer endpoint stays server-side")
    const config = JSON.parse(configBody) as { demoAuth: boolean; accounts: unknown[] }
    assert.equal(config.demoAuth, true)
    assert.equal(config.accounts.length, DEMO_ACCOUNTS.length)

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

test("Ticket 01: the legacy single-tenant path still works and does not use the demo sign-in", async () => {
  const harness = await startHarness({ demoAuth: false })
  try {
    const session = await getSession(harness.port)
    assert.equal(session.status, 200, "single_tenant needs no token")
    assert.equal(session.json.tenantId, "default")
    assert.equal(session.json.subjectId, "local")
    assert.equal(session.json.role, "admin")
    assert.deepEqual(session.json.scopes, ["chat", "ingest", "review", "admin"])
    assert.equal(await postAdminProbe(harness.port), 204, "local context holds the admin scope")

    assert.equal((await login(harness.port, { account: "admin", password: DEMO_PASSWORD })).status, 404)
    const config = (await (await fetch(`http://127.0.0.1:${harness.port}/api/auth/config`)).json()) as {
      demoAuth: boolean
      accounts: unknown[]
    }
    assert.deepEqual(config, { demoAuth: false, accounts: [] })
  } finally {
    await harness.close()
  }
})

test("Ticket 01: a resolved AccessContext is the only source of the reported identity", async () => {
  // Guards the contract that /api/session reads res.locals, not the request.
  const ctx: AccessContext = {
    tenantId: "demo",
    subjectId: "demo-policy-reader",
    groups: ["demo-policy-readers"],
    scopes: ["chat"],
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
      subjectId: "demo-policy-reader",
      role: "reader",
      groups: ["demo-policy-readers"],
      scopes: ["chat"],
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
