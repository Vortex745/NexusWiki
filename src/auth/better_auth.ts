import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { jwt } from "better-auth/plugins"

import type { ActiveOidcConfig } from "../identity/oidc_config"
import {
  DEFAULT_CLAIM_MAPPING,
  DEFAULT_CLOCK_SKEW_SECONDS,
} from "../identity/oidc_config"
import { DEMO_ADMIN_GROUP, DEMO_TENANT_ID } from "../identity/demo_accounts"
import { ALL_LOCAL_SCOPES } from "../access/context"
import type { AuthDb } from "../db/client"
import { authSchema } from "../db/schema"

export const AUTH_CLIENT_IP_HEADER = "x-nexusrag-client-ip"

const SCRYPT_KEY_BYTES = 64

/** Matches the legacy local_users format: `<salt>:<scrypt hex>`. */
export function hashLocalPassword(password: string): string {
  const salt = randomBytes(16).toString("hex")
  return `${salt}:${scryptSync(password, salt, SCRYPT_KEY_BYTES).toString("hex")}`
}

export async function verifyLocalPassword({
  hash,
  password,
}: {
  hash: string
  password: string
}): Promise<boolean> {
  const [salt, digest] = hash.split(":")
  if (!salt || !digest) return false
  const expected = Buffer.from(digest, "hex")
  if (expected.length === 0) return false
  const actual = scryptSync(password, salt, expected.length)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/** A synthetic, stable email so Better Auth's email/password flow can use local IDs. */
export function localIdentityEmail(idKey: string): string {
  return `${createHash("sha256").update(idKey).digest("hex").slice(0, 32)}@local.invalid`
}

export interface BetterAuthOptions {
  db: AuthDb
  baseURL: string
  secret: string
}

export interface BetterAuthInstance {
  handler(request: Request): Promise<Response>
  api: {
    signUpEmail(args: { body: Record<string, unknown> }): Promise<unknown>
    getJwks(): Promise<unknown>
  }
}

export interface BetterAuthHandle {
  auth: BetterAuthInstance
  oidcConfig: ActiveOidcConfig
}

export function createBetterAuth(options: BetterAuthOptions): BetterAuthHandle {
  const baseURL = options.baseURL.replace(/\/+$/, "")
  if (options.secret.trim().length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters when local sign-in is enabled")
  }
  const auth = betterAuth({
    baseURL,
    secret: options.secret,
    trustedOrigins: [baseURL],
    advanced: { ipAddress: { ipAddressHeaders: [AUTH_CLIENT_IP_HEADER] } },
    database: drizzleAdapter(options.db, {
      provider: "sqlite",
      schema: authSchema,
    }),
    emailAndPassword: {
      enabled: true,
      password: {
        hash: async (password) => hashLocalPassword(password),
        verify: async ({ hash, password }) => verifyLocalPassword({ hash, password }),
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 5,
    },
    user: {
      additionalFields: {
        identityKey: { type: "string", required: true },
        tenantId: { type: "string", required: true },
        isAdmin: { type: "boolean", required: true, defaultValue: false },
        disabledAt: { type: "date", required: false },
        lastLoginAt: { type: "date", required: false },
      },
    },
    plugins: [
      jwt({
        jwks: {
          keyPairConfig: { alg: "RS256" },
        },
        jwt: {
          issuer: baseURL,
          audience: baseURL,
          expirationTime: "5d",
          getSubject: (session) => {
            const user = session.user as typeof session.user & {
              identityKey: string
              isAdmin: boolean
            }
            return user.isAdmin ? "demo-admin" : `user:${user.identityKey}`
          },
          definePayload: ({ user }) => {
            const typed = user as typeof user & {
              identityKey: string
              tenantId: string
              isAdmin: boolean
              name: string
            }
            void typed.identityKey
            return {
              tenant_id: typed.tenantId || DEMO_TENANT_ID,
              groups: typed.isAdmin ? [DEMO_ADMIN_GROUP] : [],
              scope: ALL_LOCAL_SCOPES.join(" "),
              name: typed.name,
            }
          },
        },
      }),
    ],
  })

  const oidcConfig: ActiveOidcConfig = {
    kind: "active",
    issuer: baseURL,
    audience: baseURL,
    jwksEndpoint: `${baseURL}/api/auth/jwks`,
    claimMapping: DEFAULT_CLAIM_MAPPING,
    clockSkewSeconds: DEFAULT_CLOCK_SKEW_SECONDS,
  }

  return { auth: auth as unknown as BetterAuthInstance, oidcConfig }
}
