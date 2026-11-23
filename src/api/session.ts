/**
 * Ticket 01 (IAM-01) — identity session API.
 *
 *   GET  /api/session        who the caller is, as the server resolved them
 *   GET  /api/auth/config    whether local sign-in / registration is available
 *   GET  /api/auth/jwks      Better Auth's public keys for the JWT verifier
 *   POST /api/auth/register  create a local account (ID + 8-character password)
 *   POST /api/auth/login     exchange an ID + password for a token
 *
 * `GET /api/session` is the only place the browser learns its role, groups
 * and scopes. They are read from the server-resolved AccessContext — never
 * from a request body — so a client cannot widen its own authorization. In
 * single-tenant mode no identity middleware runs and the deterministic local
 * context applies, which keeps the legacy path working without a token.
 *
 * Local sign-in now delegates credential storage, login and token issuance to
 * Better Auth. The browser still sees the same ID/password contract; the
 * Better Auth session cookie and JWT endpoints never reach it.
 */

import { Router, type Request, type Response } from "express"
import {
  accessRole,
  singleTenantAccessContext,
  type AccessContext,
} from "../access/context"
import type { AuthBridge } from "../auth/bridge"
import { requestObjectSchema } from "./schemas/auth"

export interface LocalAuthOptions {
  /** Better Auth-backed credential authority. */
  localAuth: AuthBridge
}

export interface SessionRouterOptions {
  demoAuth?: LocalAuthOptions
  /** Better Auth JWKS for the existing Jose identity verifier. */
  betterAuthJwks?: () => Promise<unknown>
  /** True when this private workspace still has to configure embedding. */
  requiresEmbeddingSetup?: (ctx: AccessContext) => boolean
}

function resolveContext(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

export function createSessionRouter(options: SessionRouterOptions): Router {
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
      // AC-01 (admin console): the browser reads the operator flag — never a
      // scope-derived role — to decide whether the admin console exists. A
      // context without the flag reads as a plain user (fail closed).
      operator: ctx.operator === true,
      ...(options.requiresEmbeddingSetup
        ? { requiresEmbeddingSetup: options.requiresEmbeddingSetup(ctx) }
        : {}),
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

  router.get("/auth/jwks", async (_req: Request, res: Response) => {
    if (!options.betterAuthJwks) {
      res.status(404).json({ error: "local sign-in is not enabled" })
      return
    }
    res.json(await options.betterAuthJwks())
  })

  router.post("/auth/register", async (req: Request, res: Response) => {
    if (!demoAuth) {
      res.status(404).json({ error: "local sign-in is not enabled" })
      return
    }
    const parsed = requestObjectSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", message: "请求格式无效" })
      return
    }
    const body = parsed.data
    const result = await demoAuth.localAuth.register(body.id, body.password)
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
    const parsed = requestObjectSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", message: "请求格式无效" })
      return
    }
    const body = parsed.data
    const result = await demoAuth.localAuth.signIn(body.id, body.password, req.ip)
    if (result.kind === "rate_limited") {
      if (result.retryAfter !== null) res.set("Retry-After", result.retryAfter)
      res.status(429).json({ error: "rate_limited", message: "登录尝试过于频繁，请稍后再试" })
      return
    }
    // One response for an unknown ID and a wrong password: the endpoint never
    // reveals which accounts exist.
    if (result.kind === "invalid_credentials") {
      res.status(401).json({ error: "invalid credentials" })
      return
    }
    res.json({ accessToken: result.accessToken })
  })

  return router
}
