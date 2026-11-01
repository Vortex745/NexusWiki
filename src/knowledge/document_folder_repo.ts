import type { DB } from "../ingestion/tracking/db"
import type { DocumentFolder } from "../types/knowledge_base"

/**
 * The document-folder registry.
 *
 * `document_folders` is owned by this module (the rule `knowledge_base_folder_repo.ts`
 * states for its table): no other module may query it. A row is ONE directory
 * inside one knowledge base, and it is only the registry — which documents are
 * inside it lives in `documents.metadata.folder` as the folder's name, because
 * that is what the document catalog already filters and facets over. So this
 * repository never touches `documents`; the service composes the two, and
 * `DocumentRepo` keeps ownership of the membership write.
 *
 * Every read and write is scoped by tenant and knowledge base, and another
 * tenant's folder is indistinguishable from a missing one (null → HTTP 404), so
 * a caller cannot probe which directories exist elsewhere.
 */
export interface DocumentFolderRepo {
  /** Insert unless the id already exists. Idempotent by primary key. */
  insertIfAbsent(folder: DocumentFolder): void

  /** Read one folder, scoped by tenant. Cross-tenant → null. */
  getById(id: string, tenantId: string): DocumentFolder | null

  /** The folder of one knowledge base under this exact name, or null. */
  getByName(knowledgeBaseId: string, tenantId: string, name: string): DocumentFolder | null

  /** Every folder of one knowledge base, oldest first (deterministic order). */
  listByKnowledgeBase(knowledgeBaseId: string, tenantId: string): DocumentFolder[]

  /** Rename. Returns false when no row matched (→ 404). */
  setName(id: string, tenantId: string, name: string, updatedAt: string): boolean

  /** Delete the registry row itself. Returns false when no row matched. */
  remove(id: string, tenantId: string): boolean
}

interface StoredDocumentFolder {
  id: string
  tenant_id: string
  knowledge_base_id: string
  name: string
  created_at: string
  updated_at: string
}

const SELECT_COLUMNS = `id, tenant_id, knowledge_base_id, name, created_at, updated_at`

function rowToFolder(row: StoredDocumentFolder): DocumentFolder {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    knowledgeBaseId: row.knowledge_base_id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class SqliteDocumentFolderRepo implements DocumentFolderRepo {
  constructor(private db: DB) {}

  insertIfAbsent(folder: DocumentFolder): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO document_folders (
        id, tenant_id, knowledge_base_id, name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      folder.id,
      folder.tenantId,
      folder.knowledgeBaseId,
      folder.name,
      folder.createdAt,
      folder.updatedAt
    )
  }

  getById(id: string, tenantId: string): DocumentFolder | null {
    const row = this.db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM document_folders
       WHERE id = ? AND tenant_id = ?`
    ).get(id, tenantId) as StoredDocumentFolder | undefined
    return row ? rowToFolder(row) : null
  }

  getByName(knowledgeBaseId: string, tenantId: string, name: string): DocumentFolder | null {
    const row = this.db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM document_folders
       WHERE knowledge_base_id = ? AND tenant_id = ? AND name = ?`
    ).get(knowledgeBaseId, tenantId, name) as StoredDocumentFolder | undefined
    return row ? rowToFolder(row) : null
  }

  listByKnowledgeBase(knowledgeBaseId: string, tenantId: string): DocumentFolder[] {
    const rows = this.db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM document_folders
       WHERE tenant_id = ? AND knowledge_base_id = ?
       ORDER BY created_at ASC, id ASC`
    ).all(tenantId, knowledgeBaseId) as StoredDocumentFolder[]
    return rows.map(rowToFolder)
  }

  setName(id: string, tenantId: string, name: string, updatedAt: string): boolean {
    const result = this.db.prepare(
      `UPDATE document_folders SET name = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`
    ).run(name, updatedAt, id, tenantId)
    return result.changes > 0
  }

  remove(id: string, tenantId: string): boolean {
    const result = this.db.prepare(
      `DELETE FROM document_folders WHERE id = ? AND tenant_id = ?`
    ).run(id, tenantId)
    return result.changes > 0
  }
}
