import { join } from "node:path"
import { migrate } from "drizzle-orm/better-sqlite3/migrator"

import type { AuthDb } from "./client"

/** Apply the committed auth migrations once at startup. */
export function runAuthMigrations(
  db: AuthDb,
  migrationsFolder: string = join(__dirname, "..", "..", "drizzle"),
): void {
  migrate(db, { migrationsFolder })
}
