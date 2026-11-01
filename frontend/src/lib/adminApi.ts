import { apiFetch } from "./api"

/**
 * AC-03 (admin console): the operator's user-directory client. Every call
 * goes through the shared `apiFetch` (same bearer token, same 401 handling);
 * error text is the server's own message — the console never invents one.
 */

export interface AdminUserItem {
  id: string
  displayId: string
  createdAt: string
  lastLoginAt: string | null
  disabledAt: string | null
}

export interface AdminUsersPage {
  items: AdminUserItem[]
  page: number
  pageSize: number
  total: number
}

export class AdminApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "AdminApiError"
  }
}

async function readError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown }
    if (typeof body.message === "string" && body.message) message = body.message
    else if (typeof body.error === "string" && body.error) message = body.error
  } catch {
    // keep the fallback text
  }
  throw new AdminApiError(message, response.status)
}

export async function fetchAdminUsers(params: {
  q?: string
  status?: "all" | "active" | "disabled"
  page?: number
  pageSize?: number
}): Promise<AdminUsersPage> {
  const search = new URLSearchParams()
  if (params.q) search.set("q", params.q)
  if (params.status && params.status !== "all") search.set("status", params.status)
  if (params.page !== undefined) search.set("page", String(params.page))
  if (params.pageSize !== undefined) search.set("pageSize", String(params.pageSize))
  const query = search.toString()
  const response = await apiFetch(`/admin/users${query ? `?${query}` : ""}`)
  if (!response.ok) await readError(response, "读取用户目录失败")
  return (await response.json()) as AdminUsersPage
}

/** AC-06: the account overview — counts plus the zero-filled 14-day window. */
export interface AdminOverviewPayload {
  total: number
  active: number
  disabled: number
  newUsers: Array<{ date: string; count: number }>
}

export async function fetchAdminOverview(): Promise<AdminOverviewPayload> {
  const response = await apiFetch("/admin/overview")
  if (!response.ok) await readError(response, "读取账号概览失败")
  return (await response.json()) as AdminOverviewPayload
}

/** AC-05: set a new 8-character password; the response carries nothing else. */
export async function resetUserPassword(id: string, password: string): Promise<void> {
  const response = await apiFetch(`/admin/users/${encodeURIComponent(id)}/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  })
  if (!response.ok) await readError(response, "重置密码失败")
}

/** AC-04: disable or re-enable one account; the server returns the fresh row. */
export async function setUserDisabled(
  id: string,
  disabled: boolean,
): Promise<AdminUserItem> {
  const response = await apiFetch(
    `/admin/users/${encodeURIComponent(id)}/${disabled ? "disable" : "enable"}`,
    { method: "POST" },
  )
  if (!response.ok) {
    await readError(response, disabled ? "禁用账号失败" : "启用账号失败")
  }
  const body = (await response.json()) as { user?: AdminUserItem }
  if (!body.user) throw new AdminApiError("服务端返回缺少用户状态", response.status)
  return body.user
}
