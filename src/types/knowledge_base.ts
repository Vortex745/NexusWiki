/**
 * Ticket 02 (KB-01, spec §8.1 L239-241): the KnowledgeBase contract.
 *
 * A knowledge base is the ownership boundary for knowledge: one Source and one
 * Document belong to exactly one knowledge base, and every retrieval path must
 * be scoped by it (spec §8.1 L238, L244). This file carries only the contract —
 * the module-owned SQLite table lives in `src/knowledge/knowledge_base_repo.ts`
 * and the lifecycle rules in `src/knowledge/knowledge_base_service.ts`.
 *
 * The DEFAULT knowledge base of a tenant is identified by a DETERMINISTIC id
 * derived from the tenant id (see {@link defaultKnowledgeBaseId}). That is what
 * makes "empty and repeated startup create exactly one default knowledge base
 * per tenant" true without a scan or a lock: the same tenant always computes
 * the same id, so the second startup inserts nothing.
 */

export type KnowledgeBaseStatus = "active" | "archived"

export interface KnowledgeBase {
  id: string
  tenantId: string
  name: string
  description: string
  status: KnowledgeBaseStatus
  /**
   * The embedding model + dimensions this knowledge base was created with
   * (spec §8.1 L245). Recorded per knowledge base because a vector space
   * cannot be swapped in place — changing it means a new knowledge base and a
   * full re-ingestion.
   */
  embeddingProfile: string
  /**
   * The knowledge-base folder this base is grouped under, or null when it is
   * ungrouped. A presentation aid only: it is NOT an ownership boundary, it is
   * never part of a retrieval scope, and a folder row that disappears leaves
   * its members active and ungrouped.
   */
  folderId: string | null
  createdAt: string
  updatedAt: string
}

/**
 * A tenant-shared folder that groups knowledge bases one level deep. Folders do
 * not nest and a knowledge base belongs to at most one of them, so this is a
 * flat (id, name) taxonomy plus the `folderId` back-reference on each base.
 */
export interface KnowledgeBaseFolder {
  id: string
  tenantId: string
  name: string
  createdAt: string
  updatedAt: string
}

/**
 * A document folder: one directory inside ONE knowledge base. Membership is not
 * stored here — a document carries the folder's `name` in its own
 * `documents.metadata.folder`, which is what the catalog filters and facets
 * already read. This row is what lets an empty directory exist and gives
 * rename/delete something to address.
 */
export interface DocumentFolder {
  id: string
  tenantId: string
  knowledgeBaseId: string
  name: string
  createdAt: string
  updatedAt: string
}

export const DEFAULT_KNOWLEDGE_BASE_NAME = "Default knowledge base"
export const DEFAULT_KNOWLEDGE_BASE_DESCRIPTION =
  "The knowledge base that knowledge without an explicit knowledge-base scope belongs to."

const DEFAULT_KNOWLEDGE_BASE_ID_PREFIX = "kb-default-"

/**
 * The deterministic id of a tenant's default knowledge base. Pure and stable:
 * the same tenant id always yields the same id, which is what makes startup
 * initialization idempotent.
 */
export function defaultKnowledgeBaseId(tenantId: string): string {
  return `${DEFAULT_KNOWLEDGE_BASE_ID_PREFIX}${tenantId}`
}

/**
 * The embedding profile recorded on a knowledge base: model id + dimensions.
 * One format, one place, so a stored profile can be compared against the
 * running configuration instead of being re-parsed ad hoc.
 */
export function knowledgeBaseEmbeddingProfile(
  embeddingModel: string,
  embeddingDimensions: number
): string {
  return `${embeddingModel}:${embeddingDimensions}`
}
