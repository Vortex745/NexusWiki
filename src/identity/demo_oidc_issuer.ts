/**
 * Ticket 01 (IAM-01): the local demo OIDC issuer.
 *
 * Starts a real HTTP issuer on loopback that serves a real JWKS document and
 * mints real RS256 tokens. The RSA key pair is generated in-process at
 * startup: it is never written to disk and never leaves this process, so no
 * signing material can reach the browser bundle, a trace, or a log.
 *
 * `POST /token` is deliberately closed: it accepts only an account key and
 * asks `resolveClaims` for that identity. Caller-supplied `sub`, `groups` or
 * `scope` values are ignored, so the issuer cannot be asked for an identity
 * it does not already know about. It also requires a per-process shared
 * secret, so the only caller that can mint a token is the server-side
 * sign-in proxy — otherwise the password check in front of it would be
 * decorative, since any local process could reach the loopback endpoint
 * directly.
 *
 * The issuer is bound to 127.0.0.1 — it is a demo identity provider, not a
 * deployable one.
 */

import { randomBytes } from "node:crypto"

import { LocalOidcServer, type IssueTokenClaims } from "./local_oidc_server"

export interface DemoOidcIssuerOptions {
  /** Loopback port to listen on. */
  port: number
  /** Expected audience claim; the adapter must be configured with the same value. */
  audience: string
  /**
   * Resolve an account key the sign-in proxy already authenticated to the
   * claims of that identity. Returning null rejects the request.
   */
  resolveClaims(account: string): IssueTokenClaims | null
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
 * Map a `/token` request body to the claims of a known identity. Anything
 * else — including injected `sub`/`groups`/`scope` values — is rejected.
 */
function accountClaims(
  body: unknown,
  resolveClaims: DemoOidcIssuerOptions["resolveClaims"],
): IssueTokenClaims | null {
  if (typeof body !== "object" || body === null) return null
  const account = (body as { account?: unknown }).account
  if (typeof account !== "string" || account.length === 0) return null
  return resolveClaims(account)
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
    tokenClaimsResolver: (body) => accountClaims(body, options.resolveClaims),
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
