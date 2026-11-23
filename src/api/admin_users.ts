import { Router, type Request, type Response } from "express"
import type { SqliteAdminAuditStore } from "../identity/admin_audit"
import type { AdminUserDirectory, AdminUserRow } from "../identity/local_users"
import type { AuthBridge } from "../auth/bridge"
import { adminUsersQuerySchema, requestObjectSchema } from "./schemas/auth"
import { requireOperator } from "./operator_guard"

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
  localUsers: AdminUserDirectory
  audit: SqliteAdminAuditStore
  /**
   * AC-05: the credential authority behind reset-password. Absent in bare
   * mounts without local sign-in — the route then answers 503, since there
   * is no credential store to reset against.
   */
  localAuth?: AuthBridge
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
    const parsed = adminUsersQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "page must be a positive integer; pageSize must be 1-100" })
      return
    }
    const { q, status, page, pageSize } = parsed.data
    const result = options.localUsers.pageUsers({
      q,
      status,
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
    const parsed = requestObjectSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_password", message: "请输入密码" })
      return
    }
    const result = options.localAuth.resetPassword(String(req.params.id), parsed.data.password)
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

