/**
 * Ticket 01 (IAM-01) — identity session API.
 *
 *   GET  /api/session       who the caller is, as the server resolved them
 *   GET  /api/auth/config   whether the local demo sign-in is available
 *   POST /api/auth/login    exchange a demo account + password for a token
 *
 * `GET /api/session` is the only place the browser learns its role, groups
 * and scopes. They are read from the server-resolved AccessContext — never
 * from a request body — so a client cannot widen its own authorization. In
 * single-tenant mode no identity middleware runs and the deterministic local
 * context applies, which keeps the legacy path working without a token.
 *
 * `POST /api/auth/login` is a thin server-side proxy to the local demo
 * issuer: the browser sends an account key and a password, the server
 * verifies the password and asks the issuer for that preset's token. The
 * issuer URL, the password and the signing key never reach the browser, and
 * neither the password nor the issued token is ever logged or echoed back.
 */

import { Router, type Request, type Response } from "express"
import { createHash, timingSafeEqual } from "node:crypto"
import {
  accessRole,
  singleTenantAccessContext,
  type AccessContext,
} from "../access/context"
import { demoAccountChoices } from "../identity/demo_oidc_issuer"

export interface DemoAuthOptions {
  /** The demo issuer's `/token` endpoint (loopback). */
  tokenEndpoint: string
  /** Password every demo account signs in with; compared server-side only. */
  password: string
  /** Shared secret proving this proxy — and not another local process — is calling. */
  tokenAuth: string
}

/** Length-independent constant-time comparison of two secrets. */
function secretsMatch(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false
  const a = createHash("sha256").update(provided, "utf8").digest()
  const b = createHash("sha256").update(expected, "utf8").digest()
  return timingSafeEqual(a, b)
}

function resolveContext(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

export function createSessionRouter(options: { demoAuth?: DemoAuthOptions }): Router {
  const router = Router()
  const demoAuth = options.demoAuth

  router.get("/session", (_req: Request, res: Response) => {
    const ctx = resolveContext(res)
    res.json({
      tenantId: ctx.tenantId,
      subjectId: ctx.subjectId,
      role: accessRole(ctx),
      groups: ctx.groups,
      scopes: ctx.scopes,
    })
  })

  router.get("/auth/config", (_req: Request, res: Response) => {
    res.json({
      demoAuth: Boolean(demoAuth),
      accounts: demoAuth ? demoAccountChoices() : [],
    })
  })

  router.post("/auth/login", async (req: Request, res: Response) => {
    if (!demoAuth) {
      res.status(404).json({ error: "demo sign-in is not enabled" })
      return
    }
    const body = (req.body ?? {}) as { account?: unknown; password?: unknown }
    const account = demoAccountChoices().find((entry) => entry.key === body.account)
    // One response for an unknown account and a wrong password: the endpoint
    // never reveals which accounts exist.
    if (!account || !secretsMatch(body.password, demoAuth.password)) {
      res.status(401).json({ error: "invalid credentials" })
      return
    }
    try {
      const response = await fetch(demoAuth.tokenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${demoAuth.tokenAuth}`,
        },
        body: JSON.stringify({ account: account.key }),
      })
      if (!response.ok) {
        res.status(502).json({ error: "identity provider rejected the request" })
        return
      }
      const payload = (await response.json()) as { access_token?: unknown }
      if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
        res.status(502).json({ error: "identity provider returned no token" })
        return
      }
      res.json({ accessToken: payload.access_token })
    } catch {
      res.status(502).json({ error: "identity provider unavailable" })
    }
  })

  return router
}
