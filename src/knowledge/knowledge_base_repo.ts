import type { DB } from "../ingestion/tracking/db"
import type { KnowledgeBase, KnowledgeBaseStatus } from "../types/knowledge_base"

/**
 * Ticket 02 (KB-01): the knowledge-base repository.
 *
 * The `knowledge_bases` table is owned by this module (spec §8.1 "Keep
 * repositories and tables module-owned; other modules must not access them
 * directly"): every read/write goes through this interface, and no other
 * module may query the table itself. The table is declared in the shared
 * SCHEMA in `src/ingestion/tracking/db.ts` because that is where this project
 * creates its SQLite schema — one place, additive migrations only.
 *
 * Cross-tenant isolation follows the same rule as the other stores in this
 * project (`SqliteSourceLifecycleStore`, `SqliteHandoffStore`): every read is
 * scoped by tenant_id, and a knowledge base owned by another tenant is
 * indistinguishable from a missing one (`null` → HTTP 404), so this layer never
 * reveals that a cross-tenant knowledge base exists.
 */
export interface KnowledgeBaseRepo {
  /**
   * Insert a knowledge base unless its id already exists. Idempotent by
   * construction — the primary key makes a repeated default-knowledge-base
   * initialization a no-op instead of a duplicate row.
   */
  insertIfAbsent(knowledgeBase: KnowledgeBase): void

  /** Read one knowledge base, scoped by tenant. Cross-tenant → null. */
  getById(id: string, tenantId: string): KnowledgeBase | null

  /** Every knowledge base of one tenant, oldest first (deterministic order). */
  listByTenant(tenantId: string): KnowledgeBase[]

  /**
   * Set the lifecycle status, scoped by tenant. Returns false when no row
   * matched (unknown id or another tenant's knowledge base → 404). Status is
   * the ONLY thing changed: archiving never removes the row and never touches
   * any file (spec §8.1 "active/archived", ticket criterion #2).
   */
  setStatus(
    id: string,
    tenantId: string,
    status: KnowledgeBaseStatus,
    updatedAt: string
  ): boolean

  /**
   * Ticket 08 (KB-04): rename a knowledge base, scoped by tenant. Returns
   * false when no row matched (unknown id or another tenant's base → 404).
   * Name is the ONLY thing changed besides updated_at.
   */
  setName(id: string, tenantId: string, name: string, updatedAt: string): boolean

  /**
   * Ticket 43 (DEMO-01B): update the description, scoped by tenant. Returns
   * false when no row matched. Description is the ONLY thing changed besides
   * updated_at.
   */
  setDescription(
    id: string,
    tenantId: string,
    description: string,
    updatedAt: string
  ): boolean

  /**
   * Move a knowledge base into a folder, or out of every folder when
   * `folderId` is null. Scoped by tenant; returns false when no row matched
   * (→ 404). The caller validates the target folder belongs to the same
   * tenant — this method only writes the reference.
   */
  setFolderId(
    id: string,
    tenantId: string,
    folderId: string | null,
    updatedAt: string
  ): boolean

  /**
   * Ungroup every knowledge base of one folder, used when the folder itself is
   * deleted. Returns how many rows were released. Membership is a naming aid,
   * so this never archives, never deletes, and never touches a base's own
   * status or scope.
   */
  clearFolderChildren(folderId: string, tenantId: string, updatedAt: string): number
}

interface StoredKnowledgeBase {
  id: string
  tenant_id: string
  name: string
  description: string
  status: string
  embedding_profile: string
  folder_id: string | null
  created_at: string
  updated_at: string
}

const SELECT_COLUMNS = `id, tenant_id, name, description, status,
       embedding_profile, folder_id, created_at, updated_at`

function rowToKnowledgeBase(row: StoredKnowledgeBase): KnowledgeBase {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    status: row.status as KnowledgeBaseStatus,
    embeddingProfile: row.embedding_profile,
    // An old row (pre-ALTER) and a deliberately ungrouped one are the same
    // thing to the read path: no folder.
    folderId: row.folder_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class SqliteKnowledgeBaseRepo implements KnowledgeBaseRepo {
  constructor(private db: DB) {}

  insertIfAbsent(knowledgeBase: KnowledgeBase): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO knowledge_bases (
        id, tenant_id, name, description, status,
        embedding_profile, folder_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      knowledgeBase.id,
      knowledgeBase.tenantId,
      knowledgeBase.name,
      knowledgeBase.description,
      knowledgeBase.status,
      knowledgeBase.embeddingProfile,
      knowledgeBase.folderId,
      knowledgeBase.createdAt,
      knowledgeBase.updatedAt
    )
  }

  getById(id: string, tenantId: string): KnowledgeBase | null {
    const row = this.db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM knowledge_bases
       WHERE id = ? AND tenant_id = ?`
    ).get(id, tenantId) as StoredKnowledgeBase | undefined
    return row ? rowToKnowledgeBase(row) : null
  }

  listByTenant(tenantId: string): KnowledgeBase[] {
    const rows = this.db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM knowledge_bases
       WHERE tenant_id = ?
       ORDER BY created_at ASC, id ASC`
    ).all(tenantId) as StoredKnowledgeBase[]
    return rows.map(rowToKnowledgeBase)
  }

  setStatus(
    id: string,
    tenantId: string,
    status: KnowledgeBaseStatus,
    updatedAt: string
  ): boolean {
    const result = this.db.prepare(
      `UPDATE knowledge_bases SET status = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`
    ).run(status, updatedAt, id, tenantId)
    return result.changes > 0
  }

  setName(id: string, tenantId: string, name: string, updatedAt: string): boolean {
    const result = this.db.prepare(
      `UPDATE knowledge_bases SET name = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`
    ).run(name, updatedAt, id, tenantId)
    return result.changes > 0
  }

  setDescription(
    id: string,
    tenantId: string,
    description: string,
    updatedAt: string
  ): boolean {
    const result = this.db.prepare(
      `UPDATE knowledge_bases SET description = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`
    ).run(description, updatedAt, id, tenantId)
    return result.changes > 0
  }

  setFolderId(
    id: string,
    tenantId: string,
    folderId: string | null,
    updatedAt: string
  ): boolean {
    const result = this.db.prepare(
      `UPDATE knowledge_bases SET folder_id = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`
    ).run(folderId, updatedAt, id, tenantId)
    return result.changes > 0
  }

  clearFolderChildren(folderId: string, tenantId: string, updatedAt: string): number {
    const result = this.db.prepare(
      `UPDATE knowledge_bases SET folder_id = NULL, updated_at = ?
       WHERE folder_id = ? AND tenant_id = ?`
    ).run(updatedAt, folderId, tenantId)
    return result.changes
  }
}
