/**
 * Ticket 01 (IAM-01) — identity session API.
 *
 *   GET  /api/session        who the caller is, as the server resolved them
 *   GET  /api/auth/config    whether local sign-in / registration is available
 *   POST /api/auth/register  create a local account (ID + 8-character password)
 *   POST /api/auth/login     exchange an ID + password for a token
 *
 * `GET /api/session` is the only place the browser learns its role, groups
 * and scopes. They are read from the server-resolved AccessContext — never
 * from a request body — so a client cannot widen its own authorization. In
 * single-tenant mode no identity middleware runs and the deterministic local
 * context applies, which keeps the legacy path working without a token.
 *
 * The sign-in route is a thin server-side proxy to the local issuer: the
 * browser sends an ID and a password, the server verifies them against the
 * administrator credential or the registered-user table, and asks the issuer
 * for that identity's token. The issuer URL, passwords and signing key never
 * reach the browser, and neither the password nor the issued token is ever
 * logged or echoed back.
 */

import { Router, type Request, type Response } from "express"
import {
  accessRole,
  singleTenantAccessContext,
  type AccessContext,
} from "../access/context"
import type { LocalAuthService } from "../identity/local_users"

export interface LocalAuthOptions {
  /** The demo issuer's `/token` endpoint (loopback). */
  tokenEndpoint: string
  /** Shared secret proving this proxy — and not another local process — is calling. */
  tokenAuth: string
  /** Administrator credential + registered-user store. */
  localAuth: LocalAuthService
}

function resolveContext(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

export function createSessionRouter(options: { demoAuth?: LocalAuthOptions }): Router {
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
      displayName: ctx.displayName ?? null,
    })
  })

  router.get("/auth/config", (_req: Request, res: Response) => {
    res.json({
      demoAuth: Boolean(demoAuth),
      registration: Boolean(demoAuth),
      idMaxLength: demoAuth?.localAuth.idMaxLength ?? 0,
      passwordLength: demoAuth?.localAuth.passwordLength ?? 0,
    })
  })

  router.post("/auth/register", (req: Request, res: Response) => {
    if (!demoAuth) {
      res.status(404).json({ error: "local sign-in is not enabled" })
      return
    }
    const body = (req.body ?? {}) as { id?: unknown; password?: unknown }
    const result = demoAuth.localAuth.register(body.id, body.password)
    if (!result.ok) {
      const status = result.code === "id_taken" ? 409 : 400
      res.status(status).json({ error: result.code, message: result.message })
      return
    }
    // Registration never signs the browser in: the requirement is an explicit
    // ID/password login after the account exists, and the password field is
    // cleared by the client before that step.
    res.status(201).json({ ok: true })
  })

  router.post("/auth/login", async (req: Request, res: Response) => {
    if (!demoAuth) {
      res.status(404).json({ error: "local sign-in is not enabled" })
      return
    }
    const body = (req.body ?? {}) as { id?: unknown; password?: unknown }
    const identity = demoAuth.localAuth.authenticate(body.id, body.password)
    // One response for an unknown ID and a wrong password: the endpoint never
    // reveals which accounts exist.
    if (!identity) {
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
        body: JSON.stringify({ account: identity.idKey }),
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
