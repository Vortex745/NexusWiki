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
   * Ticket 31 (FAQ-01B): "faq" is the knowledge-scoped standard-answer
   * channel. It is likewise not selectable: it runs exactly when the run's
   * knowledge scope contains FAQ entries whose question or a variant matches
   * the query. Results carry `metadata.origin = "faq"` so the citation layer
   * labels them as standard answers, never as knowledge-base documents.
   * Ticket 36 (WEB-01): "web" is the web-evidence channel. Also not
   * selectable: it runs exactly when the run's message carries a URL (safe
   * server-side fetch) or the run opted into configured Tavily search.
   * Results carry `metadata.origin = "web"` so citations stay distinct from
   * knowledge-base citations.
   */
  source: "vector" | "bm25" | "graph" | "pageIndex" | "attachment" | "faq" | "web"
  channels?: Array<
    "vector" | "bm25" | "graph" | "pageIndex" | "attachment" | "faq" | "web"
  >
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

/**
 * Ticket 31 (FAQ-01B): the FAQ evidence channel boundary. The caller passes
 * the run's server-computed (tenant, knowledge scope) — the implementation
 * MUST only ever return ACTIVE entries of exactly that scope, so a disabled,
 * conflicting or cross-knowledge entry can never surface. Results carry
 * `metadata.origin = "faq"` plus the entry id and version so citations stay
 * traceable to an immutable FAQ version.
 */
export interface FaqEvidenceRequest {
  tenantId: string
  knowledgeBaseIds: string[]
  query: string
  limit: number
}

export interface FaqEvidenceOperations {
  search(request: FaqEvidenceRequest): Promise<RetrievalResult[]>
}

/**
 * Ticket 36 (WEB-01): the web-evidence channel boundary. The adapter extracts
 * URLs server-side from the run's own message and (when configured) searches
 * Tavily with the server-side key. Results carry `metadata.origin = "web"`
 * plus `webUrl`/`fetchedAt` so citations stay traceable to a URL and its
 * fetch time, distinct from knowledge-base documents.
 */
export interface WebEvidenceRequest {
  /** The run's own message text — the only source of user-supplied URLs. */
  message: string
  /** The effective query text for Tavily search. */
  query: string
  /** True when the run explicitly opted into web search (`useWeb: true`). */
  requested: boolean
  signal?: AbortSignal
}

/**
 * "unconfigured" is an HONEST outcome, not a failure: the run asked for web
 * search but the deployment has no Tavily key. The searcher records it in the
 * degradation trace while the run proceeds with everything else it has.
 */
export type WebEvidenceStatus = "ok" | "unconfigured" | "skipped"

export interface WebEvidenceOutcome {
  status: WebEvidenceStatus
  results: RetrievalResult[]
  /** Bounded reason detail (unconfigured / policy-denied / skipped notes). */
  detail?: string
}

export interface WebEvidenceOperations {
  search(request: WebEvidenceRequest): Promise<WebEvidenceOutcome>
}

export interface RerankInput {
  query: string
  results: RetrievalResult[]
}

export interface RerankOutput {
  results: RetrievalResult[]
}
