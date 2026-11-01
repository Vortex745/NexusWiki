import type { Response } from "express"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"

/**
 * AC-01 (admin console): the operator boundary shared by every operator-only
 * surface — the admin user-management routes and the backend-owned entries
 * (log opener, demo-config, source sync).
 *
 * Two rules hold everywhere:
 *  - Identity first. In enforced mode the identity middleware answers 401
 *    before any handler runs, so an anonymous request never reaches this
 *    guard. Bare mounts (probes, tests) fall back to the deterministic
 *    single-tenant context, which IS the operator.
 *  - One predicate. A route never re-derives "operator" from scopes: the
 *    flag is computed once per identity source (single-tenant context, JWT
 *    adapter) and consumed here. Registered users keep the platform `admin`
 *    scope and still get 403 here — the boundary is the group, not a scope.
 */

/** The request's resolved identity, or the deterministic single-tenant operator. */
export function accessContext(res: Response): AccessContext {
  return (
    (res.locals.accessContext as AccessContext | undefined) ??
    singleTenantAccessContext()
  )
}

/**
 * Reject non-operators before any business work: 403 with a stable error,
 * no side effects. Returns the context so the caller can proceed, or null
 * after the response is written.
 */
export function requireOperator(res: Response): AccessContext | null {
  const ctx = accessContext(res)
  if (ctx.operator !== true) {
    res.status(403).json({ error: "operator access required" })
    return null
  }
  return ctx
}
