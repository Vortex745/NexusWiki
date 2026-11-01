import { Router, type Request, type Response } from "express"
import type { SqliteAdminAuditStore } from "../identity/admin_audit"
import type { LocalAuthService, AdminUserRow, SqliteLocalUserStore } from "../identity/local_users"
import { accessContext, requireOperator } from "./operator_guard"

/**
 * AC-03/04/05 (admin console): the operator's account management surface.
 *
 *   GET    /api/admin/users?q=&status=&page=&pageSize=
 *   POST   /api/admin/users/:id/disable
 *   POST   /api/admin/users/:id/enable
 *   POST   /api/admin/users/:id/reset-password   { password }
 *
 * Every route answers through the shared operator guard after the identity
 * middleware's 401, before any store work — an unauthorized request never
 * touches the registry and never writes an audit row. The stores are
 * injected, so this router owns no database of its own and the HTTP payload
 * shapes stay here.
 */
export function createAdminUsersRouter(options: {
  localUsers: SqliteLocalUserStore
  audit: SqliteAdminAuditStore
  /**
   * AC-05: the credential authority behind reset-password. Absent in bare
   * mounts without local sign-in — the route then answers 503, since there
   * is no credential store to reset against.
   */
  localAuth?: LocalAuthService
}): Router {
  const router = Router()

  const rowPayload = (row: AdminUserRow) => ({
    id: row.idKey,
    displayId: row.displayId,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
    disabledAt: row.disabledAt,
  })

  router.get("/admin/overview", (_req: Request, res: Response) => {
    if (!requireOperator(res)) return
    const overview = options.localUsers.overview()
    res.json({
      total: overview.total,
      active: overview.active,
      disabled: overview.disabled,
      newUsers: overview.newUsers,
    })
  })

  router.get("/admin/users", (req: Request, res: Response) => {
    if (!requireOperator(res)) return
    const page = parsePageInt(req.query.page, 1, Number.MAX_SAFE_INTEGER)
    const pageSize = parsePageInt(req.query.pageSize, 20, 100)
    if (page === null || pageSize === null) {
      res.status(400).json({ error: "page must be a positive integer; pageSize must be 1-100" })
      return
    }
    const rawStatus = typeof req.query.status === "string" ? req.query.status : "all"
    if (rawStatus !== "all" && rawStatus !== "active" && rawStatus !== "disabled") {
      res.status(400).json({ error: "status must be all, active or disabled" })
      return
    }
    const q = typeof req.query.q === "string" ? req.query.q : ""
    const result = options.localUsers.pageUsers({
      q,
      status: rawStatus,
      page,
      pageSize,
    })
    res.json({
      items: result.items.map(rowPayload),
      page,
      pageSize,
      total: result.total,
    })
  })

  const setDisabled = (disabled: boolean) => (req: Request, res: Response) => {
    const operator = requireOperator(res)
    if (!operator) return
    const row = options.localUsers.setDisabled(
      String(req.params.id),
      disabled ? new Date() : null,
    )
    if (!row) {
      // An unknown target is the same 404 whether the id never existed or
      // belongs to another deployment's account.
      res.status(404).json({ error: "user not found" })
      return
    }
    // The administrator is not a table row, so an id can never name them.
    options.audit.record({
      actor: operator.subjectId,
      target: row.idKey,
      action: disabled ? "disable" : "enable",
    })
    res.json({ user: rowPayload(row) })
  }

  router.post("/admin/users/:id/disable", setDisabled(true))
  router.post("/admin/users/:id/enable", setDisabled(false))

  router.post("/admin/users/:id/reset-password", (req: Request, res: Response) => {
    const operator = requireOperator(res)
    if (!operator) return
    if (!options.localAuth) {
      res.status(503).json({ error: "local sign-in is not enabled" })
      return
    }
    const body = (req.body ?? {}) as { password?: unknown }
    const result = options.localAuth.resetPassword(String(req.params.id), body.password)
    if (!result.ok) {
      const status = result.code === "invalid_password" ? 400 : result.code === "disabled" ? 409 : 404
      res.status(status).json({ error: result.code, message: result.message })
      return
    }
    // The response carries no password and the audit no secret: the trail
    // shows that a reset happened, never what was set. The service returns
    // the canonical id, so the router never re-normalizes anything.
    options.audit.record({
      actor: operator.subjectId,
      target: result.idKey,
      action: "reset_password",
    })
    res.json({ ok: true })
  })

  return router
}

/**
 * Strict positive-integer query param with an inclusive ceiling, or null
 * when malformed. One parser for every paging field.
 */
function parsePageInt(raw: unknown, fallback: number, max: number): number | null {
  if (raw === undefined || raw === "") return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > max) return null
  return value
}

