import type { KnowledgeBase, KnowledgeBaseStatus } from "../types/knowledge_base"
import {
  DEFAULT_KNOWLEDGE_BASE_DESCRIPTION,
  DEFAULT_KNOWLEDGE_BASE_NAME,
  defaultKnowledgeBaseId,
} from "../types/knowledge_base"
import type { KnowledgeBaseRepo } from "./knowledge_base_repo"

/**
 * Ticket 02 (KB-01): the knowledge-base service — the module's public contract.
 *
 * Three rules from the approved plan (§8.1 L241-243) live here:
 *
 * 1. Exactly one DEFAULT knowledge base per tenant. The id is derived from the
 *    tenant id, so `ensureDefault` is idempotent: an empty startup creates one,
 *    and every later startup (or a second process) inserts nothing.
 *
 * 2. A request that does not carry a knowledge-base field resolves to the
 *    tenant's DEFAULT knowledge base — never to "all knowledge bases"
 *    (spec §8.1 L243 "无此字段的历史请求选择默认库，不默认搜索所有库"). An
 *    explicit empty array means "no knowledge context" and is NOT widened.
 *
 * 3. Unknown or cross-tenant knowledge bases fail loudly (a typed error the
 *    HTTP layer maps to 404) instead of silently widening or narrowing scope.
 *
 * Lifecycle (criterion #2): `archive`/`activate` change `status` only. No row
 * is deleted, no file is touched.
 */

/** Thrown for a knowledge base that does not exist or belongs to another
 * tenant. The two cases are deliberately indistinguishable (→ HTTP 404), so a
 * caller can never probe another tenant's ids. */
export class KnowledgeBaseNotFoundError extends Error {
  constructor(public readonly knowledgeBaseId: string) {
    super(`Knowledge base not found: ${knowledgeBaseId}`)
    this.name = "KnowledgeBaseNotFoundError"
  }
}

/** Thrown for a malformed scope (a non-string or blank id) → HTTP 400. */
export class InvalidKnowledgeBaseScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidKnowledgeBaseScopeError"
  }
}

/**
 * The knowledge-base part of a resolved retrieval scope (spec §8.1 L242).
 * `knowledgeBaseIds: []` is a legal, explicit "no knowledge context" — it is
 * never the same thing as "every knowledge base".
 */
export interface KnowledgeBaseScope {
  knowledgeBaseIds: string[]
}

export interface KnowledgeBaseService {
  /** Create-or-read the tenant's deterministic default knowledge base. */
  ensureDefault(tenantId: string): KnowledgeBase

  /** One knowledge base, scoped by tenant. Cross-tenant → null (→ 404). */
  getById(id: string, tenantId: string): KnowledgeBase | null

  /** Every knowledge base of the tenant, oldest first. */
  list(tenantId: string): KnowledgeBase[]

  /** Archive a knowledge base. Returns null for unknown/cross-tenant (→ 404). */
  archive(id: string, tenantId: string): KnowledgeBase | null

  /** Reactivate an archived knowledge base. Returns null for unknown/cross-tenant. */
  activate(id: string, tenantId: string): KnowledgeBase | null

  /**
   * Resolve the knowledge-base scope of a request.
   *
   * - `requested` omitted (a legacy API/CLI request without the field) →
   *   exactly the tenant's default knowledge base.
   * - `requested` = `[]` → no knowledge context.
   * - `requested` = `["kb-a", "kb-b"]` → those ids, de-duplicated in the order
   *   given, each verified to belong to this tenant.
   *
   * Throws {@link InvalidKnowledgeBaseScopeError} for malformed input and
   * {@link KnowledgeBaseNotFoundError} for an unknown or cross-tenant id.
   */
  resolveScope(tenantId: string, requested?: readonly string[]): KnowledgeBaseScope
}

export class KnowledgeBaseServiceImpl implements KnowledgeBaseService {
  constructor(
    private repo: KnowledgeBaseRepo,
    /**
     * The embedding profile stamped on a newly created knowledge base
     * (spec §8.1 L245). Injected by the composition root from the running
     * configuration instead of being read here, so this service stays free of
     * configuration I/O.
     */
    private embeddingProfile: string,
    private now: () => Date = () => new Date()
  ) {}

  ensureDefault(tenantId: string): KnowledgeBase {
    const id = defaultKnowledgeBaseId(tenantId)
    const existing = this.repo.getById(id, tenantId)
    if (existing) return existing

    const timestamp = this.now().toISOString()
    this.repo.insertIfAbsent({
      id,
      tenantId,
      name: DEFAULT_KNOWLEDGE_BASE_NAME,
      description: DEFAULT_KNOWLEDGE_BASE_DESCRIPTION,
      status: "active",
      embeddingProfile: this.embeddingProfile,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    // Re-read instead of returning the local object: if another process won
    // the insert race, the stored row is the authoritative one.
    const stored = this.repo.getById(id, tenantId)
    if (!stored) {
      throw new Error(`default knowledge base could not be read back: ${id}`)
    }
    return stored
  }

  getById(id: string, tenantId: string): KnowledgeBase | null {
    return this.repo.getById(id, tenantId)
  }

  list(tenantId: string): KnowledgeBase[] {
    return this.repo.listByTenant(tenantId)
  }

  archive(id: string, tenantId: string): KnowledgeBase | null {
    return this.setStatus(id, tenantId, "archived")
  }

  activate(id: string, tenantId: string): KnowledgeBase | null {
    return this.setStatus(id, tenantId, "active")
  }

  resolveScope(
    tenantId: string,
    requested?: readonly string[]
  ): KnowledgeBaseScope {
    if (requested === undefined) {
      return { knowledgeBaseIds: [this.ensureDefault(tenantId).id] }
    }
    const knowledgeBaseIds: string[] = []
    for (const candidate of requested) {
      if (typeof candidate !== "string" || candidate.trim().length === 0) {
        throw new InvalidKnowledgeBaseScopeError(
          "every knowledge-base id must be a non-empty string"
        )
      }
      const knowledgeBase = this.repo.getById(candidate, tenantId)
      if (!knowledgeBase) throw new KnowledgeBaseNotFoundError(candidate)
      if (!knowledgeBaseIds.includes(candidate)) knowledgeBaseIds.push(candidate)
    }
    return { knowledgeBaseIds }
  }

  private setStatus(
    id: string,
    tenantId: string,
    status: KnowledgeBaseStatus
  ): KnowledgeBase | null {
    const updatedAt = this.now().toISOString()
    if (!this.repo.setStatus(id, tenantId, status, updatedAt)) return null
    return this.repo.getById(id, tenantId)
  }
}
