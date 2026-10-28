import type { DB } from "./db"

export class ActiveVersionRepository {
  constructor(private db: DB) {}

  getActiveDocIds(): string[] {
    const rows = this.db.prepare(
      "SELECT active_doc_id FROM sources WHERE lifecycle_state = 'active' AND active_doc_id IS NOT NULL"
    ).all() as Array<{ active_doc_id: string }>
    return rows.map((row) => row.active_doc_id)
  }
}
