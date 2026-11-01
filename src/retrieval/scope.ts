import type { AccessContext } from "../access/context"
import {
  InvalidKnowledgeBaseScopeError,
  type KnowledgeBaseService,
} from "../knowledge/knowledge_base_service"
import type { RetrievalScope } from "../types/retrieval_scope"

/**
 * Ticket 05 (KB-03A, spec §8.1 L241-242): resolve the retrieval scope of one
 * request, on the server.
 *
 * The caller contributes only a knowledge SELECTION (which knowledge-base ids
 * it wants, or nothing at all). The tenant comes from the AccessContext the
 * server computed for the request — never from the request body. A client
 * therefore cannot widen its scope by naming another tenant's knowledge base,
 * and it cannot name a storage filter at all: this contract has no field for
 * one.
 *
 * `requested` semantics are the KnowledgeBaseService's (spec §8.1 L242):
 * - omitted → exactly the caller's authorized DEFAULT knowledge base.
 * - `[]` → no knowledge context (never "all knowledge bases").
 * - ids → those ids, each verified to belong to the caller's tenant.
 *
 * Throws {@link InvalidKnowledgeBaseScopeError} for malformed input and
 * {@link KnowledgeBaseNotFoundError} for an unknown or cross-tenant id. The
 * HTTP mapping (400/404) lives in the API layer so this module stays
 * transport-free.
 */
export type RetrievalScopeResolver = (
  accessContext: AccessContext,
  requested?: unknown
) => RetrievalScope

export function createRetrievalScopeResolver(
  service: KnowledgeBaseService
): RetrievalScopeResolver {
  return (accessContext, requested) => {
    if (requested !== undefined && !Array.isArray(requested)) {
      // A non-array (a bare string, a number, an object) is malformed input.
      // It must not be iterated: a string would silently resolve one
      // knowledge base per character instead of failing.
      throw new InvalidKnowledgeBaseScopeError(
        "knowledgeBaseIds must be an array of non-empty strings"
      )
    }
    // Element-level validation (non-string, blank) and tenant ownership are
    // the service's job — this resolver only supplies the identity.
    const { knowledgeBaseIds } = service.resolveScope(
      accessContext.tenantId,
      requested as readonly string[] | undefined
    )
    return { knowledgeBaseIds }
  }
}
