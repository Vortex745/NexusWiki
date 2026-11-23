import { and, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm"

import type { AuthDb } from "../db/client"
import { user } from "../db/schema"
import type {
  AdminOverview,
  AdminUserDirectory,
  AdminUserPage,
  AdminUserRow,
} from "../identity/local_users"
import { normalizeLocalId } from "../identity/local_users"

function localDateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function startOfLocalDay(date: Date): Date {
  const start = new Date(date)
  start.setHours(0, 0, 0, 0)
  return start
}

type UserRow = typeof user.$inferSelect

function toAdminRow(row: UserRow): AdminUserRow {
  return {
    idKey: row.identityKey,
    displayId: row.name,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    disabledAt: row.disabledAt?.toISOString() ?? null,
  }
}

/**
 * The operator directory over the Better Auth user table. The administrator
 * is excluded: it is an operator identity, not a registered account.
 */
export class AuthUserDirectory implements AdminUserDirectory {
  constructor(private readonly db: AuthDb) {}

  findByIdentity(idKey: string): UserRow | null {
    return (
      this.db
        .select()
        .from(user)
        .where(eq(user.identityKey, normalizeLocalId(idKey)))
        .get() ?? null
    )
  }

  rowByIdKey(idKey: string): AdminUserRow | null {
    const row = this.findByIdentity(idKey)
    return row && !row.isAdmin ? toAdminRow(row) : null
  }

  overview(now: Date = new Date()): AdminOverview {
    const counts = this.db
      .select({
        total: sql<number>`count(*)`,
        active: sql<number>`sum(case when ${user.disabledAt} is null then 1 else 0 end)`,
      })
      .from(user)
      .where(eq(user.isAdmin, false))
      .get()
    const total = Number(counts?.total ?? 0)
    const active = Number(counts?.active ?? 0)

    const windowStart = startOfLocalDay(now)
    windowStart.setDate(windowStart.getDate() - 13)
    const created = this.db
      .select({ createdAt: user.createdAt })
      .from(user)
      .where(and(eq(user.isAdmin, false), gte(user.createdAt, windowStart)))
      .all()
    const perDay = new Map<string, number>()
    for (const row of created) {
      const key = localDateKey(row.createdAt)
      perDay.set(key, (perDay.get(key) ?? 0) + 1)
    }
    const newUsers: AdminOverview["newUsers"] = []
    for (let index = 0; index < 14; index += 1) {
      const day = new Date(windowStart)
      day.setDate(windowStart.getDate() + index)
      const key = localDateKey(day)
      newUsers.push({ date: key, count: perDay.get(key) ?? 0 })
    }
    return { total, active, disabled: total - active, newUsers }
  }

  pageUsers(params: {
    q?: string
    status?: "all" | "active" | "disabled"
    page: number
    pageSize: number
  }): AdminUserPage {
    const needle = normalizeLocalId(params.q ?? "")
    const clauses = [eq(user.isAdmin, false)]
    if (needle) clauses.push(sql`instr(${user.identityKey}, ${needle}) > 0`)
    if (params.status === "active") clauses.push(isNull(user.disabledAt))
    if (params.status === "disabled") clauses.push(isNotNull(user.disabledAt))
    const where = and(...clauses)

    const total = Number(
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(user)
        .where(where)
        .get()?.n ?? 0,
    )
    const rows = this.db
      .select()
      .from(user)
      .where(where)
      .orderBy(desc(user.createdAt), desc(user.identityKey))
      .limit(params.pageSize)
      .offset((params.page - 1) * params.pageSize)
      .all()
    return { items: rows.map(toAdminRow), total }
  }

  setDisabled(idKey: string, disabledAt: Date | null): AdminUserRow | null {
    const existing = this.findByIdentity(idKey)
    if (!existing || existing.isAdmin) return null
    // Keep the FIRST disable timestamp so repeating the action is idempotent.
    const next = disabledAt ? existing.disabledAt ?? disabledAt : null
    const rows = this.db
      .update(user)
      .set({ disabledAt: next, updatedAt: new Date() })
      .where(and(eq(user.identityKey, normalizeLocalId(idKey)), eq(user.isAdmin, false)))
      .returning()
      .all()
    return rows[0] ? toAdminRow(rows[0]) : null
  }
}
