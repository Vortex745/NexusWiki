import type { Chunk, Wikilink } from "./document"

export interface Query {
  text: string
  subQueries?: string[]
  context?: Record<string, unknown>
  coverageCriteria?: string[]
}

export interface RetrievalResult {
  chunk: Chunk
  parentChunk?: Chunk
  score: number
  /**
   * Ticket 22 (ATT-01): "attachment" is the session-scoped temporary channel.
   * It is NOT one of the four selectable knowledge channels — a caller cannot
   * ask for it and cannot ask for it to be skipped; it runs exactly when the
   * request carries a session that has live attachments.
   */
  source: "vector" | "bm25" | "graph" | "pageIndex" | "attachment"
  channels?: Array<"vector" | "bm25" | "graph" | "pageIndex" | "attachment">
  wikilinks: Wikilink[]
}

/**
 * Ticket 22 (ATT-01): the session-scoped attachment channel. The caller
 * passes the session identity it was authorized for; the implementation MUST
 * only ever read that (sessionId, tenantId, subjectId) triple, so one
 * session's attachments are unreachable from another — even for the same
 * user. Results carry `metadata.origin = "attachment"` so the citation layer
 * can label temporary provenance instead of public knowledge membership.
 */
export interface AttachmentSearchRequest {
  sessionId: string
  tenantId: string
  subjectId: string
  query: string
  limit: number
}

export interface AttachmentSearchOperations {
  search(request: AttachmentSearchRequest): Promise<RetrievalResult[]>
}

export interface RerankInput {
  query: string
  results: RetrievalResult[]
}

export interface RerankOutput {
  results: RetrievalResult[]
}
