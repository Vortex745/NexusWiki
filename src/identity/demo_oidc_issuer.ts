/**
 * Ticket 01 (IAM-01): the local demo OIDC issuer.
 *
 * Starts a real HTTP issuer on loopback that serves a real JWKS document and
 * mints real RS256 tokens. Without a `keyPath` the RSA key pair is generated
 * in-process. The local sign-in deployment passes a `keyPath`, so the key is
 * persisted in the server's data directory: a backend restart then keeps the
 * tokens cached in the browser valid until their five-day expiry. The private
 * key never reaches the browser bundle, a trace, or a log.
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

import { generateKeyPairSync, randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { LocalOidcServer, type IssueTokenClaims } from "./local_oidc_server"

export interface DemoOidcIssuerOptions {
  /** Loopback port to listen on. */
  port: number
  /** Expected audience claim; the adapter must be configured with the same value. */
  audience: string
  /**
   * Persist the RSA signing key at this path and reuse it on the next start.
   * Omit it for tests that want a fresh throwaway key each time.
   */
  keyPath?: string
  /**
   * Resolve an account key the sign-in proxy already authenticated to the
   * claims of that identity. Returning null rejects the request.
   */
  resolveClaims(account: string): IssueTokenClaims | null
}

/**
 * How long a local sign-in stays valid: five days. The gate is meant to keep
 * the app behind a password, not to make the operator retype it every day.
 */
export const DEMO_TOKEN_TTL_SECONDS = 5 * 24 * 60 * 60

/** The stable key ID for the persisted local signing key. */
const LOCAL_SIGNING_KID = "demo-key"

interface StoredSigningKey {
  kid: string
  privateKeyPem: string
  publicKeyPem: string
}

/**
 * Load the persisted signing key, or generate and persist one on first use.
 * A corrupt file fails startup instead of silently minting a new key that
 * would invalidate every cached browser session.
 */
function loadOrCreateSigningKey(keyPath: string): StoredSigningKey {
  let raw: string
  try {
    raw = readFileSync(keyPath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`cannot read local signing key ${keyPath}: ${(error as Error).message}`)
    }
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    })
    const created: StoredSigningKey = {
      kid: LOCAL_SIGNING_KID,
      privateKeyPem: privateKey,
      publicKeyPem: publicKey,
    }
    mkdirSync(dirname(keyPath), { recursive: true })
    const tempPath = `${keyPath}.${process.pid}.tmp`
    writeFileSync(tempPath, `${JSON.stringify(created, null, 2)}\n`, { mode: 0o600 })
    renameSync(tempPath, keyPath)
    return created
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredSigningKey>
    if (
      typeof parsed.kid !== "string" ||
      typeof parsed.privateKeyPem !== "string" ||
      typeof parsed.publicKeyPem !== "string"
    ) {
      throw new Error("missing kid, privateKeyPem or publicKeyPem")
    }
    return parsed as StoredSigningKey
  } catch (error) {
    throw new Error(`invalid local signing key ${keyPath}: ${(error as Error).message}`)
  }
}

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
  const signingKey = options.keyPath ? loadOrCreateSigningKey(options.keyPath) : undefined
  const server = new LocalOidcServer({
    issuer: "http://127.0.0.1",
    audience: options.audience,
    port: options.port,
    kid: signingKey?.kid ?? LOCAL_SIGNING_KID,
    ...(signingKey
      ? {
          privateKeyPem: signingKey.privateKeyPem,
          publicKeyPem: signingKey.publicKeyPem,
        }
      : {}),
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
