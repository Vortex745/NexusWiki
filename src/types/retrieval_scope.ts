/**
 * Ticket 05 (KB-03A, spec §8.1 L241): the RetrievalScope contract.
 *
 * A retrieval request never carries storage filters (no raw Elasticsearch,
 * Cypher or SQL). It carries a knowledge selection — which knowledge bases the
 * caller wants searched — and the server intersects that selection with the
 * identity it computed for the request (see `createRetrievalScopeResolver`).
 * This type is the result of that intersection: the only dimension the
 * retrieval channels are allowed to filter by.
 *
 * `knowledgeBaseIds: []` is a legal, explicit "no knowledge context"
 * (spec §8.1 L242). It is never "every knowledge base", so a channel that
 * receives an empty scope must return no evidence rather than fall back to an
 * unfiltered read.
 */
export interface RetrievalScope {
  knowledgeBaseIds: readonly string[]
}
