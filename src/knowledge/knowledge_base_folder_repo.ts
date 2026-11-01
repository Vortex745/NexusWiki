import type { DB } from "../ingestion/tracking/db"
import type { KnowledgeBaseFolder } from "../types/knowledge_base"

/**
 * The knowledge-base folder repository.
 *
 * `knowledge_base_folders` is owned by this module (the same rule
 * `knowledge_base_repo.ts` states for `knowledge_bases`): no other module may
 * query it. A folder is a TENANT-SHARED naming aid for a set of knowledge
 * bases — one level deep, never nested — so:
 *
 * - it is not an ownership boundary. A base's own `tenant_id` stays the only
 *   isolation axis, and a folder id is never part of a retrieval scope;
 * - every read is scoped by tenant, and another tenant's folder is
 *   indistinguishable from a missing one (null → HTTP 404), so a caller cannot
 *   probe which folders exist elsewhere.
 */
export interface KnowledgeBaseFolderRepo {
  /** Insert unless the id already exists. Idempotent by primary key. */
  insertIfAbsent(folder: KnowledgeBaseFolder): void

  /** Read one folder, scoped by tenant. Cross-tenant → null. */
  getById(id: string, tenantId: string): KnowledgeBaseFolder | null

  /** Every folder of one tenant, oldest first (deterministic order). */
  listByTenant(tenantId: string): KnowledgeBaseFolder[]

  /** Rename. Returns false when no row matched (→ 404). */
  setName(id: string, tenantId: string, name: string, updatedAt: string): boolean

  /**
   * Delete the folder row itself. Returns false when no row matched.
   * Callers must release the members first — see
   * `KnowledgeBaseRepo.clearFolderChildren` — so a folder is never removed out
   * from under knowledge bases that still point at it.
   */
  remove(id: string, tenantId: string): boolean
}

interface StoredFolder {
  id: string
  tenant_id: string
  name: string
  created_at: string
  updated_at: string
}

const SELECT_COLUMNS = `id, tenant_id, name, created_at, updated_at`

function rowToFolder(row: StoredFolder): KnowledgeBaseFolder {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class SqliteKnowledgeBaseFolderRepo implements KnowledgeBaseFolderRepo {
  constructor(private db: DB) {}

  insertIfAbsent(folder: KnowledgeBaseFolder): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO knowledge_base_folders (
        id, tenant_id, name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)`
    ).run(
      folder.id,
      folder.tenantId,
      folder.name,
      folder.createdAt,
      folder.updatedAt
    )
  }

  getById(id: string, tenantId: string): KnowledgeBaseFolder | null {
    const row = this.db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM knowledge_base_folders
       WHERE id = ? AND tenant_id = ?`
    ).get(id, tenantId) as StoredFolder | undefined
    return row ? rowToFolder(row) : null
  }

  listByTenant(tenantId: string): KnowledgeBaseFolder[] {
    const rows = this.db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM knowledge_base_folders
       WHERE tenant_id = ?
       ORDER BY created_at ASC, id ASC`
    ).all(tenantId) as StoredFolder[]
    return rows.map(rowToFolder)
  }

  setName(id: string, tenantId: string, name: string, updatedAt: string): boolean {
    const result = this.db.prepare(
      `UPDATE knowledge_base_folders SET name = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`
    ).run(name, updatedAt, id, tenantId)
    return result.changes > 0
  }

  remove(id: string, tenantId: string): boolean {
    const result = this.db.prepare(
      `DELETE FROM knowledge_base_folders WHERE id = ? AND tenant_id = ?`
    ).run(id, tenantId)
    return result.changes > 0
  }
}
