import { drizzle } from "drizzle-orm/better-sqlite3"

import type { DB } from "../ingestion/tracking/db"
import { authSchema } from "./schema"

export function createAuthDb(db: DB) {
  return drizzle(db, { schema: authSchema })
}

export type AuthDb = ReturnType<typeof createAuthDb>
