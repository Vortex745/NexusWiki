import type { Response } from "express"
import type { AccessContext } from "../access/context"
import {
  InvalidKnowledgeBaseScopeError,
  KnowledgeBaseArchivedError,
  KnowledgeBaseNotFoundError,
} from "../knowledge/knowledge_base_service"
import type { RetrievalScopeResolver } from "../retrieval/scope"
import type { RetrievalScope } from "../types/retrieval_scope"

/**
 * Ticket 14 (RET-01): the ONE HTTP mapping for the server-side knowledge-scope
 * resolution — chat (ticket 05) and the retrieval-debug run (this ticket) must
 * answer identically: 404 for an unknown or cross-tenant id, 409 for an
 * archived base, 400 for a malformed selection. Returns the resolved scope, or
 * null when the error response has been sent.
 */
export function resolveScopeOrRespond(
  res: Response,
  resolver: RetrievalScopeResolver,
  context: AccessContext,
  requested: unknown
): RetrievalScope | null {
  try {
    return resolver(context, requested)
  } catch (error) {
    if (error instanceof KnowledgeBaseNotFoundError) {
      res.status(404).json({ error: "knowledge base not found" })
      return null
    }
    if (error instanceof KnowledgeBaseArchivedError) {
      // Ticket 08 (KB-04): archived bases remain inspectable but stop joining
      // NEW retrieval — the selection is a state conflict, not a missing row,
      // so the client can restore or reselect.
      res.status(409).json({ error: "knowledge base is archived" })
      return null
    }
    if (error instanceof InvalidKnowledgeBaseScopeError) {
      res.status(400).json({ error: error.message })
      return null
    }
    throw error
  }
}
