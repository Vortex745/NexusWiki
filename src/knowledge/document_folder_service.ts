import { randomUUID } from "node:crypto"
import type { DB } from "../ingestion/tracking/db"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import { TaskRepo } from "../ingestion/tracking/task_repo"
import { SqliteKnowledgeBaseRepo } from "./knowledge_base_repo"
import type { KnowledgeBaseRepo } from "./knowledge_base_repo"
import { KnowledgeBaseNotFoundError } from "./knowledge_base_service"
import { RetirementServiceImpl, type RetirementService } from "./retirement"
import { SqliteSourceLifecycleStore } from "./source_lifecycle_store"
import { SqliteDocumentFolderRepo, type DocumentFolderRepo } from "./document_folder_repo"
import type { DocumentFolder } from "../types/knowledge_base"
import type { TaskTraceContext } from "../tracing/contract"

/**
 * The document-folder service — the module's public contract.
 *
 * A document folder is a directory INSIDE one knowledge base. The registry row
 * says the directory exists; the documents themselves say which directory they
 * are in, through `documents.metadata.folder` (the folder's NAME). That split is
 * what keeps the catalog's existing filter and facets untouched, and it costs
 * one rule: a rename must rewrite its members, which is what `rename` does
 * here.
 *
 * Deleting a folder deletes what is in it. Each member goes through the SAME
 * per-source retirement the document catalog's own delete button uses — own
 * tombstone, own idempotency check, own cleanup enqueue — so there is exactly
 * one destruction path in this codebase and past citations stay traceable.
 */

/** The catalog ceiling on a folder name; one definition, shared with ingest. */
export const DOCUMENT_FOLDER_NAME_MAX = 200

/**
 * The id prefix of a document folder. Exported because an import may address a
 * directory by id or name, and the caller needs this to tell the two apart.
 */
export const DOCUMENT_FOLDER_ID_PREFIX = "docf-"

/** Thrown for a blank / nested / over-long name, or a name already taken (→ 400). */
export class InvalidDocumentFolderCommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidDocumentFolderCommandError"
  }
}

/** Thrown for a folder that does not exist or belongs to another tenant (→ 404). */
export class DocumentFolderNotFoundError extends Error {
  constructor(public readonly folderId: string) {
    super(`Document folder not found: ${folderId}`)
    this.name = "DocumentFolderNotFoundError"
  }
}

/**
 * The one folder-name rule, used by both the registry and the ingest path so
 * the two cannot drift: a non-empty single-level name within
 * {@link DOCUMENT_FOLDER_NAME_MAX}.
 */
export function normalizeDocumentFolderName(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new InvalidDocumentFolderCommandError("folder name must be a non-empty string")
  }
  const name = raw.trim()
  if (name.includes("/") || name.includes("\\")) {
    throw new InvalidDocumentFolderCommandError("folder must be a single level (no separators)")
  }
  if (name.length > DOCUMENT_FOLDER_NAME_MAX) {
    throw new InvalidDocumentFolderCommandError(
      `folder must be at most ${DOCUMENT_FOLDER_NAME_MAX} characters`
    )
  }
  return name
}

/** One folder plus how many catalog-visible documents it holds. */
export interface DocumentFolderWithCount {
  folder: DocumentFolder
  documents: number
}

/** What one cascade delete actually did. */
export interface DocumentFolderRemovalResult {
  folderId: string
  /** Catalog-visible document rows that were in the folder. */
  documents: number
  /** Distinct sources those rows came from. */
  sources: number
  /** Sources this call moved to retired. */
  retired: number
  /** Sources that were already retired before this call. */
  alreadyRetired: number
  /** Cleanup tasks newly enqueued across every source. */
  cleanupTasksQueued: number
}

export interface DocumentFolderService {
  /**
   * Create a directory, or return the one that already carries this name in the
   * same knowledge base. Idempotent by name so the ingest path can file a
   * document into a folder the caller typed without a separate create call.
   * An unknown/cross-tenant knowledge base throws {@link KnowledgeBaseNotFoundError}.
   */
  create(tenantId: string, knowledgeBaseId: string, name: string): DocumentFolder

  /** Every directory of one knowledge base, oldest first, with member counts. */
  list(tenantId: string, knowledgeBaseId: string): DocumentFolderWithCount[]

  /** One folder, scoped by tenant. Cross-tenant → null (→ 404). */
  getById(id: string, tenantId: string): DocumentFolder | null

  /** Rename, rewriting the members. Null for unknown/cross-tenant (→ 404). */
  rename(id: string, tenantId: string, name: string): DocumentFolder | null

  /**
   * Delete a directory and retire every document inside it. Null when the
   * folder does not exist for this tenant.
   */
  remove(
    id: string,
    tenantId: string,
    reason: string,
    actor: string,
    trace?: TaskTraceContext
  ): DocumentFolderRemovalResult | null
}

export class DocumentFolderServiceImpl implements DocumentFolderService {
  constructor(
    private folders: DocumentFolderRepo,
    private documents: DocumentRepo,
    private knowledgeBases: KnowledgeBaseRepo,
    private retirement: RetirementService,
    private now: () => Date = () => new Date()
  ) {}

  create(tenantId: string, knowledgeBaseId: string, name: string): DocumentFolder {
    const normalized = normalizeDocumentFolderName(name)
    if (!this.knowledgeBases.getById(knowledgeBaseId, tenantId)) {
      throw new KnowledgeBaseNotFoundError(knowledgeBaseId)
    }
    const existing = this.folders.getByName(knowledgeBaseId, tenantId, normalized)
    if (existing) return existing
    const timestamp = this.now().toISOString()
    this.folders.insertIfAbsent({
      id: `${DOCUMENT_FOLDER_ID_PREFIX}${randomUUID()}`,
      tenantId,
      knowledgeBaseId,
      name: normalized,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    const stored = this.folders.getByName(knowledgeBaseId, tenantId, normalized)
    if (!stored) {
      throw new Error(`created document folder could not be read back: ${normalized}`)
    }
    return stored
  }

  list(tenantId: string, knowledgeBaseId: string): DocumentFolderWithCount[] {
    // A knowledge base the caller cannot see is a 404, not an empty directory
    // list: the document catalog answers the same request with 404, and two
    // different shapes would let a caller probe which bases exist.
    if (!this.knowledgeBases.getById(knowledgeBaseId, tenantId)) {
      throw new KnowledgeBaseNotFoundError(knowledgeBaseId)
    }
    return this.folders.listByKnowledgeBase(knowledgeBaseId, tenantId).map((folder) => ({
      folder,
      documents: this.documents.folderContents(knowledgeBaseId, tenantId, folder.name).documents,
    }))
  }

  getById(id: string, tenantId: string): DocumentFolder | null {
    return this.folders.getById(id, tenantId)
  }

  rename(id: string, tenantId: string, name: string): DocumentFolder | null {
    const folder = this.folders.getById(id, tenantId)
    if (!folder) return null
    const normalized = normalizeDocumentFolderName(name)
    if (normalized === folder.name) return folder
    if (this.folders.getByName(folder.knowledgeBaseId, tenantId, normalized)) {
      throw new InvalidDocumentFolderCommandError(
        `a document folder named "${normalized}" already exists in this knowledge base`
      )
    }
    const timestamp = this.now().toISOString()
    // Members first, registry second. better-sqlite3 is synchronous, so within
    // one process nothing observes the half-way state; the only window is a
    // crash between the two statements, whose outcome is a directory that reads
    // as empty while its documents still carry the old name — and re-running the
    // rename repairs it. The other order strands the documents under a label no
    // registry row owns.
    this.documents.renameFolderMembers(
      tenantId,
      folder.knowledgeBaseId,
      folder.name,
      normalized,
      timestamp
    )
    if (!this.folders.setName(id, tenantId, normalized, timestamp)) return null
    return this.folders.getById(id, tenantId)
  }

  remove(
    id: string,
    tenantId: string,
    reason: string,
    actor: string,
    trace?: TaskTraceContext
  ): DocumentFolderRemovalResult | null {
    const folder = this.folders.getById(id, tenantId)
    if (!folder) return null
    const contents = this.documents.folderContents(
      folder.knowledgeBaseId,
      tenantId,
      folder.name
    )
    // Retire everything inside BEFORE dropping the registry row: a cascade that
    // fails half-way leaves the directory visible and the rest retryable, where
    // the opposite order would hide the surviving documents behind a folder
    // that no longer exists.
    let retired = 0
    let alreadyRetired = 0
    let cleanupTasksQueued = 0
    for (const sourceId of contents.sourceIds) {
      const result = this.retirement.retire(sourceId, tenantId, reason, actor, trace)
      if (!result) continue
      if (result.idempotent) alreadyRetired += 1
      else retired += 1
      cleanupTasksQueued += result.enqueuedCleanupTasks
    }
    if (!this.folders.remove(id, tenantId)) return null
    return {
      folderId: id,
      documents: contents.documents,
      sources: contents.sourceIds.length,
      retired,
      alreadyRetired,
      cleanupTasksQueued,
    }
  }
}

/**
 * Wire the service over one database handle.
 *
 * The workspace routes pass the SAME retirement service the per-source delete
 * uses. The ingest path has no stores of its own (it opens them per request), so
 * it takes the default — the same class over the same handle, therefore the same
 * tombstone and cleanup-enqueue behaviour rather than a second implementation.
 */
export function createDocumentFolderService(
  db: DB,
  retirement?: RetirementService
): DocumentFolderService {
  return new DocumentFolderServiceImpl(
    new SqliteDocumentFolderRepo(db),
    new DocumentRepo(db),
    new SqliteKnowledgeBaseRepo(db),
    retirement ??
      new RetirementServiceImpl(db, new SqliteSourceLifecycleStore(db), new TaskRepo(db))
  )
}
