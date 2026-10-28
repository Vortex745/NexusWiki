import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { JoseIdentityAdapter } from "./jose_adapter"
import { startDemoOidcIssuer, type DemoOidcIssuerHandle } from "./demo_oidc_issuer"
import type { IssueTokenClaims } from "./local_oidc_server"

const AUDIENCE = "local-auth-persistence"

function claimsFor(account: string): IssueTokenClaims | null {
  if (account !== "root") return null
  return {
    sub: "demo-admin",
    tenant_id: "demo",
    groups: ["demo-admins"],
    scope: "chat ingest review admin",
    name: "root",
  }
}

async function issueToken(handle: DemoOidcIssuerHandle): Promise<string> {
  const response = await fetch(handle.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${handle.tokenAuth}`,
    },
    body: JSON.stringify({ account: "root" }),
  })
  assert.equal(response.status, 200)
  return ((await response.json()) as { access_token: string }).access_token
}

async function jwks(handle: DemoOidcIssuerHandle) {
  return (await (await fetch(handle.jwksEndpoint)).json()) as {
    keys: Array<Record<string, unknown>>
  }
}

test("a persisted signing key keeps a cached token verifiable after a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "local-oidc-key-"))
  const keyPath = join(dir, "local-oidc-key.json")
  let first: DemoOidcIssuerHandle | undefined
  try {
    first = await startDemoOidcIssuer({
      port: 0,
      audience: AUDIENCE,
      keyPath,
      resolveClaims: claimsFor,
    })
    const originalIssuer = first.issuer
    const before = await jwks(first)
    const token = await issueToken(first)
    await first.stop()
    first = undefined

    const restarted = await startDemoOidcIssuer({
      port: 0,
      audience: AUDIENCE,
      keyPath,
      resolveClaims: claimsFor,
    })
    try {
      const after = await jwks(restarted)
      assert.equal(after.keys[0]?.n, before.keys[0]?.n, "the RSA key survives the restart")
      assert.equal(after.keys[0]?.kid, before.keys[0]?.kid)

      // The token's issuer is the original loopback URL; the JWKS comes from
      // the restarted issuer. The adapter must accept the old token because
      // the signing key was reused.
      const adapter = new JoseIdentityAdapter({
        config: {
          kind: "active",
          issuer: originalIssuer,
          audience: AUDIENCE,
          jwksEndpoint: restarted.jwksEndpoint,
          claimMapping: {
            tenantClaim: "tenant_id",
            subjectClaim: "sub",
            groupsClaim: "groups",
          },
          clockSkewSeconds: 60,
        },
      })
      const context = await adapter.resolve({
        headers: { authorization: `Bearer ${token}` },
      })
      assert.equal(context?.subjectId, "demo-admin")
      assert.equal(context?.displayName, "root")
    } finally {
      await restarted.stop()
    }
  } finally {
    if (first) await first.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a corrupt signing key fails startup instead of silently rotating", async () => {
  const dir = mkdtempSync(join(tmpdir(), "local-oidc-key-"))
  const keyPath = join(dir, "local-oidc-key.json")
  try {
    writeFileSync(keyPath, "{not-json", "utf8")
    await assert.rejects(
      () =>
        startDemoOidcIssuer({
          port: 0,
          audience: AUDIENCE,
          keyPath,
          resolveClaims: claimsFor,
        }),
      /invalid local signing key/
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
