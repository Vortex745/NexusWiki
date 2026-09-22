import { randomUUID } from "node:crypto"
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
 * Ticket 08 (KB-04): thrown for a command payload that violates the public
 * contract (a blank or oversized name, an oversized description) or a command
 * the tenant's invariants forbid (archiving the default knowledge base) →
 * HTTP 400.
 */
export class InvalidKnowledgeBaseCommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidKnowledgeBaseCommandError"
  }
}

/**
 * Ticket 08 (KB-04): thrown when a knowledge base that is requested INTO a
 * retrieval scope is archived. Archived knowledge bases stop joining new
 * retrieval while remaining inspectable (list/get still return them), so this
 * is a state conflict, not a missing row → HTTP 409.
 */
export class KnowledgeBaseArchivedError extends Error {
  constructor(public readonly knowledgeBaseId: string) {
    super(`Knowledge base is archived: ${knowledgeBaseId}`)
    this.name = "KnowledgeBaseArchivedError"
  }
}

/** Ticket 08 (KB-04): validated public-contract limits for command payloads. */
export const KNOWLEDGE_BASE_NAME_MAX = 200
export const KNOWLEDGE_BASE_DESCRIPTION_MAX = 2000

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

  /**
   * Ticket 08 (KB-04): create a new ACTIVE knowledge base owned by the tenant.
   * The id is generated (never the deterministic default id). Throws
   * {@link InvalidKnowledgeBaseCommandError} for a blank/oversized name or
   * description.
   */
  create(tenantId: string, name: string, description?: string): KnowledgeBase

  /**
   * Ticket 08 (KB-04): rename a knowledge base. Returns null for
   * unknown/cross-tenant (→ 404); throws
   * {@link InvalidKnowledgeBaseCommandError} for an invalid name.
   */
  rename(id: string, tenantId: string, name: string): KnowledgeBase | null

  /** One knowledge base, scoped by tenant. Cross-tenant → null (→ 404). */
  getById(id: string, tenantId: string): KnowledgeBase | null

  /** Every knowledge base of the tenant, oldest first. */
  list(tenantId: string): KnowledgeBase[]

  /**
   * Archive a knowledge base. Returns null for unknown/cross-tenant (→ 404).
   * The tenant's DEFAULT knowledge base cannot be archived (→
   * {@link InvalidKnowledgeBaseCommandError}): every request without an
   * explicit selection resolves to it, so archiving it would silently break
   * the tenant's legacy chats.
   */
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
   * Ticket 08 (KB-04): an ARCHIVED knowledge base never joins new retrieval —
   * selecting one (or finding the default archived) throws
   * {@link KnowledgeBaseArchivedError} (→ 409).
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
    if (existing) {
      // Ticket 08 (KB-04): the default base is unarchivable by contract, so an
      // archived default row can only be pre-KB-04 legacy data. The default is
      // what every omitted selection resolves to — repair it instead of
      // failing every legacy chat with a 409.
      if (existing.status === "archived") {
        return this.activate(existing.id, tenantId) as KnowledgeBase
      }
      return existing
    }

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

  create(tenantId: string, name: string, description = ""): KnowledgeBase {
    const normalized = this.validateCommandPayload(name, description)
    const timestamp = this.now().toISOString()
    // A fresh random id: the deterministic `kb-default-<tenant>` id belongs to
    // the default base alone, so a created base can never collide with it.
    const id = `kb-${randomUUID()}`
    this.repo.insertIfAbsent({
      id,
      tenantId,
      name: normalized.name,
      description: normalized.description,
      status: "active",
      embeddingProfile: this.embeddingProfile,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    const stored = this.repo.getById(id, tenantId)
    // insertIfAbsent no-ops on an id collision — with a randomUUID id that is
    // a freak event, but a silent `knowledgeBase: null` 201 would be worse
    // than a loud failure.
    if (!stored) {
      throw new Error(`created knowledge base could not be read back: ${id}`)
    }
    return stored
  }

  rename(id: string, tenantId: string, name: string): KnowledgeBase | null {
    const { name: normalized } = this.validateCommandPayload(name)
    const timestamp = this.now().toISOString()
    if (!this.repo.setName(id, tenantId, normalized, timestamp)) return null
    return this.repo.getById(id, tenantId)
  }

  getById(id: string, tenantId: string): KnowledgeBase | null {
    return this.repo.getById(id, tenantId)
  }

  list(tenantId: string): KnowledgeBase[] {
    return this.repo.listByTenant(tenantId)
  }

  archive(id: string, tenantId: string): KnowledgeBase | null {
    // Ticket 08 (KB-04): the default base backs every request without an
    // explicit selection, so it can never be archived.
    if (id === defaultKnowledgeBaseId(tenantId)) {
      throw new InvalidKnowledgeBaseCommandError(
        "the default knowledge base cannot be archived"
      )
    }
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
      // ensureDefault repairs a legacy archived default back to active, so the
      // default path can never fail with an archived conflict.
      const knowledgeBase = this.ensureDefault(tenantId)
      return { knowledgeBaseIds: [knowledgeBase.id] }
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
      // Ticket 08 (KB-04): archived bases remain inspectable but stop joining
      // NEW retrieval — the selection fails explicitly instead of silently
      // narrowing.
      if (knowledgeBase.status === "archived") {
        throw new KnowledgeBaseArchivedError(candidate)
      }
      if (!knowledgeBaseIds.includes(candidate)) knowledgeBaseIds.push(candidate)
    }
    return { knowledgeBaseIds }
  }

  /** Ticket 08 (KB-04): the command payload's validated public contract. */
  private validateCommandPayload(
    name: string,
    description?: string
  ): { name: string; description: string } {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new InvalidKnowledgeBaseCommandError(
        "knowledge base name must be a non-empty string"
      )
    }
    if (name.trim().length > KNOWLEDGE_BASE_NAME_MAX) {
      throw new InvalidKnowledgeBaseCommandError(
        `knowledge base name must be at most ${KNOWLEDGE_BASE_NAME_MAX} characters`
      )
    }
    const descriptionValue = description ?? ""
    if (
      typeof descriptionValue !== "string" ||
      descriptionValue.length > KNOWLEDGE_BASE_DESCRIPTION_MAX
    ) {
      throw new InvalidKnowledgeBaseCommandError(
        `knowledge base description must be at most ${KNOWLEDGE_BASE_DESCRIPTION_MAX} characters`
      )
    }
    return { name: name.trim(), description: descriptionValue }
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
