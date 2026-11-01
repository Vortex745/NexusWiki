import type { DB } from "../ingestion/tracking/db"

/**
 * AC-04/AC-05 (admin console): the account-action audit trail.
 *
 * One row per operator action — actor (the operator's stable subject id),
 * target (the account's normalized id), action (disable / enable /
 * reset_password) and time. Passwords and tokens never enter this table;
 * a reset is visible as "a reset happened", never as what was set.
 *
 * The store owns its table and nothing else: it has no knowledge of users,
 * HTTP or the operator guard, so any future admin action can record here
 * without touching the user registry.
 */

export type AdminAuditAction = "disable" | "enable" | "reset_password"

export interface AdminAuditEntry {
  actor: string
  target: string
  action: AdminAuditAction
  createdAt: string
}

export class SqliteAdminAuditStore {
  constructor(private readonly db: DB) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        target TEXT NOT NULL,
        action TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `)
  }

  /** Append one immutable audit row. Never records secrets. */
  record(entry: {
    actor: string
    target: string
    action: AdminAuditAction
  }): void {
    this.db
      .prepare(
        `INSERT INTO admin_audit_log (actor, target, action, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(entry.actor, entry.target, entry.action, new Date().toISOString())
  }

  /** The audit rows for one account, oldest first. Test/inspection seam. */
  listForTarget(target: string): AdminAuditEntry[] {
    return this.db
      .prepare(
        `SELECT actor, target, action, created_at
         FROM admin_audit_log WHERE target = ? ORDER BY id ASC`,
      )
      .all(target) as AdminAuditEntry[]
  }
}
