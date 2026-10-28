/**
 * Ticket 01 (IAM-01): the local demo OIDC issuer.
 *
 * Starts a real HTTP issuer on loopback that serves a real JWKS document and
 * mints real RS256 tokens for the three demo accounts. The RSA key pair is
 * generated in-process at startup: it is never written to disk and never
 * leaves this process, so no signing material can reach the browser bundle,
 * a trace, or a log.
 *
 * `POST /token` is deliberately closed: it accepts only an account key and
 * mints that preset's claims. Caller-supplied `sub`, `groups` or `scope`
 * values are ignored, so the issuer cannot be asked for an identity it does
 * not already know about. It also requires a per-process shared secret, so
 * the only caller that can mint a token is the server-side sign-in proxy —
 * otherwise the password check in front of it would be decorative, since any
 * local process could reach the loopback endpoint directly.
 *
 * The issuer is bound to 127.0.0.1 — it is a demo identity provider, not a
 * deployable one.
 */

import { randomBytes } from "node:crypto"

import { LocalOidcServer, type IssueTokenClaims } from "./local_oidc_server"
import { DEMO_ACCOUNTS, DEMO_TENANT_ID, resolveDemoAccount } from "./demo_accounts"

export interface DemoOidcIssuerOptions {
  /** Loopback port to listen on. */
  port: number
  /** Expected audience claim; the adapter must be configured with the same value. */
  audience: string
}

/**
 * How long a demo sign-in stays valid: seven days. The gate is meant to keep
 * the app behind a password, not to make the operator retype it every hour.
 */
export const DEMO_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60

export interface DemoOidcIssuerHandle {
  /** Issuer URL, including the bound port. */
  issuer: string
  jwksEndpoint: string
  tokenEndpoint: string
  /**
   * Shared secret the sign-in proxy presents to `POST /token`. Generated per
   * process and never sent to the browser.
   */
  tokenAuth: string
  /** Stop the issuer and release the port. Idempotent. */
  stop(): Promise<void>
}

/**
 * Map a `/token` request body to the preset claims of a known demo account.
 * Anything else — including unknown keys and injected `sub`/`groups`/`scope`
 * values — is rejected.
 */
function presetClaims(body: unknown): IssueTokenClaims | null {
  if (typeof body !== "object" || body === null) return null
  const account = resolveDemoAccount((body as { account?: unknown }).account)
  if (!account) return null
  return {
    sub: account.subjectId,
    tenant_id: DEMO_TENANT_ID,
    groups: [...account.groups],
    scope: account.scopes.join(" "),
  }
}

export async function startDemoOidcIssuer(
  options: DemoOidcIssuerOptions
): Promise<DemoOidcIssuerHandle> {
  const tokenAuth = randomBytes(32).toString("base64url")
  const server = new LocalOidcServer({
    issuer: "http://127.0.0.1",
    audience: options.audience,
    port: options.port,
    kid: "demo-key",
    tokenClaimsResolver: presetClaims,
    tokenAuth,
    tokenTtlSeconds: DEMO_TOKEN_TTL_SECONDS,
  })
  await server.start()
  return {
    issuer: server.issuer,
    jwksEndpoint: server.jwksEndpoint,
    tokenEndpoint: `${server.issuer}/token`,
    tokenAuth,
    stop: () => server.stop(),
  }
}

/** Account keys the demo issuer accepts — safe to expose to the sign-in screen. */
export function demoAccountChoices(): Array<{ key: string; label: string }> {
  return DEMO_ACCOUNTS.map((account) => ({ key: account.key, label: account.label }))
}
