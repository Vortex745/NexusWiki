import { randomUUID } from "node:crypto"
import type { KnowledgeBase, KnowledgeBaseFolder } from "../types/knowledge_base"
import {
  InvalidKnowledgeBaseCommandError,
  KnowledgeBaseNotFoundError,
  KNOWLEDGE_BASE_NAME_MAX,
} from "./knowledge_base_service"
import type { KnowledgeBaseFolderRepo } from "./knowledge_base_folder_repo"
import type { KnowledgeBaseRepo } from "./knowledge_base_repo"

/**
 * The knowledge-base folder service — the module's public contract.
 *
 * Three rules, all consequences of a folder being a NAMING AID rather than an
 * ownership boundary:
 *
 * 1. A folder never enters a retrieval scope. `resolveScope` keeps receiving
 *    plain knowledge-base ids, so the chat path, the assistant-bound scope and
 *    the conversation-locked scope are all untouched by this feature.
 *
 * 2. Deleting a folder releases its members, it never archives or deletes
 *    them. Members are cleared BEFORE the row is removed: better-sqlite3 is
 *    synchronous, so within one process no other request can observe the
 *    half-way state, and the only remaining window is a crash between the two
 *    statements — whose outcome is an empty folder (benign, and a retry
 *    removes it) rather than knowledge bases pointing at a row that is gone.
 *
 * 3. Folders are tenant-shared, exactly like the knowledge bases they group:
 *    every read and write is scoped by the server-computed tenant, and
 *    unknown/cross-tenant ids fail as 404 so a caller cannot probe them.
 */

/** Thrown for a folder that does not exist or belongs to another tenant (→ 404). */
export class KnowledgeBaseFolderNotFoundError extends Error {
  constructor(public readonly folderId: string) {
    super(`Knowledge base folder not found: ${folderId}`)
    this.name = "KnowledgeBaseFolderNotFoundError"
  }
}

export interface KnowledgeBaseFolderService {
  /** Create an ACTIVE folder for the tenant. Throws for a blank/long name. */
  create(tenantId: string, name: string): KnowledgeBaseFolder

  /** Every folder of the tenant, oldest first. */
  list(tenantId: string): KnowledgeBaseFolder[]

  /** One folder, scoped by tenant. Cross-tenant → null (→ 404). */
  getById(id: string, tenantId: string): KnowledgeBaseFolder | null

  /** Rename. Returns null for unknown/cross-tenant (→ 404). */
  rename(id: string, tenantId: string, name: string): KnowledgeBaseFolder | null

  /**
   * Delete a folder and ungroup its members. Returns the number of knowledge
   * bases released, or null when the folder does not exist for this tenant.
   */
  remove(id: string, tenantId: string): { ungrouped: number } | null

  /**
   * Move one knowledge base into a folder, or out of every folder when
   * `folderId` is null. An unknown/cross-tenant base throws
   * {@link KnowledgeBaseNotFoundError} and an unknown/cross-tenant target
   * folder {@link KnowledgeBaseFolderNotFoundError} — both → 404, so neither
   * case reveals that the id exists somewhere else. Grouping an
   * ARCHIVED base is legal: membership and lifecycle are orthogonal, and the
   * admin workspace lists archived bases precisely so they can be filed away.
   */
  moveKnowledgeBase(
    knowledgeBaseId: string,
    tenantId: string,
    folderId: string | null
  ): KnowledgeBase
}

export class KnowledgeBaseFolderServiceImpl implements KnowledgeBaseFolderService {
  constructor(
    private folders: KnowledgeBaseFolderRepo,
    private knowledgeBases: KnowledgeBaseRepo,
    private now: () => Date = () => new Date()
  ) {}

  create(tenantId: string, name: string): KnowledgeBaseFolder {
    const normalized = validateFolderName(name)
    const timestamp = this.now().toISOString()
    const folder: KnowledgeBaseFolder = {
      id: `kbf-${randomUUID()}`,
      tenantId,
      name: normalized,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.folders.insertIfAbsent(folder)
    const stored = this.folders.getById(folder.id, tenantId)
    if (!stored) {
      throw new Error(`created knowledge base folder could not be read back: ${folder.id}`)
    }
    return stored
  }

  list(tenantId: string): KnowledgeBaseFolder[] {
    return this.folders.listByTenant(tenantId)
  }

  getById(id: string, tenantId: string): KnowledgeBaseFolder | null {
    return this.folders.getById(id, tenantId)
  }

  rename(id: string, tenantId: string, name: string): KnowledgeBaseFolder | null {
    const normalized = validateFolderName(name)
    const timestamp = this.now().toISOString()
    if (!this.folders.setName(id, tenantId, normalized, timestamp)) return null
    return this.folders.getById(id, tenantId)
  }

  remove(id: string, tenantId: string): { ungrouped: number } | null {
    if (!this.folders.getById(id, tenantId)) return null
    const ungrouped = this.knowledgeBases.clearFolderChildren(
      id,
      tenantId,
      this.now().toISOString()
    )
    if (!this.folders.remove(id, tenantId)) return null
    return { ungrouped }
  }

  moveKnowledgeBase(
    knowledgeBaseId: string,
    tenantId: string,
    folderId: string | null
  ): KnowledgeBase {
    const knowledgeBase = this.knowledgeBases.getById(knowledgeBaseId, tenantId)
    if (!knowledgeBase) {
      throw new KnowledgeBaseNotFoundError(knowledgeBaseId)
    }
    if (folderId !== null && !this.folders.getById(folderId, tenantId)) {
      throw new KnowledgeBaseFolderNotFoundError(folderId)
    }
    const timestamp = this.now().toISOString()
    if (!this.knowledgeBases.setFolderId(knowledgeBaseId, tenantId, folderId, timestamp)) {
      // The row existed one statement ago and the write is scoped by the same
      // tenant, so this can only mean it went away in between.
      throw new KnowledgeBaseNotFoundError(knowledgeBaseId)
    }
    const moved = this.knowledgeBases.getById(knowledgeBaseId, tenantId)
    if (!moved) {
      throw new Error(`moved knowledge base could not be read back: ${knowledgeBaseId}`)
    }
    return moved
  }
}

/**
 * A folder name follows the same public-contract ceiling as a knowledge base
 * name, and the same trimmed-storage rule — one limit, one definition.
 */
function validateFolderName(name: string): string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new InvalidKnowledgeBaseCommandError(
      "knowledge base folder name must be a non-empty string"
    )
  }
  if (name.trim().length > KNOWLEDGE_BASE_NAME_MAX) {
    throw new InvalidKnowledgeBaseCommandError(
      `knowledge base folder name must be at most ${KNOWLEDGE_BASE_NAME_MAX} characters`
    )
  }
  return name.trim()
}
