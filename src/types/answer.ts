import type { RetrievalResult } from "./retrieval"
import type { TokenUsage } from "./agent"

/**
 * Ticket 07 (spec §12): read-only retrieval tool names exposed to the LLM
 * for the simple knowledge route. Duplicated from
 * `src/retrieval/tool_selector.ts` to avoid a circular type import
 * (tool_selector.ts imports from `../types`). The two definitions are
 * structurally identical — a value of one is assignable to the other.
 */
export type RetrievalToolName =
  | "semantic_lexical_hybrid"
  | "graph_navigation"
  | "pageindex_hierarchy"

export type AnswerTerminalStatus =
  | "completed"
  | "clarification_required"
  | "insufficient_retrieval"
  | "insufficient_evidence"
  | "invalid_citation"
  | "provider_error"
  | "cancelled"
  | "handoff_required"

export interface Evidence {
  id: string
  documentId: string
  documentVersionId: string
  documentVersion: number | null
  chunkId: string
  title: string
  source: string
  page?: number
  sectionPath?: string[]
  image?: {
    assetId?: string
    assetPath?: string
    sourceReference?: string
    captions: string[]
  }
  excerpt: string
  channels: RetrievalResult["source"][]
  score: number
  graphPath?: string[]
  wikilinks: RetrievalResult["wikilinks"]
  tenantId?: string
  allowedGroups?: string[]
  /**
   * Ticket 22 (ATT-01): "attachment" marks a TEMPORARY, session-scoped
   * citation. It is not a knowledge-base document and must never be presented
   * as one. Absent → the evidence came from knowledge, not from a session
   * attachment.
   */
  origin?: "attachment"
  attachmentId?: string
  attachmentName?: string
  /**
   * Ticket 22: the session the temporary evidence belongs to. The reference
   * stays inside that session; opening it elsewhere is not offered.
   */
  attachmentSessionId?: string
}

export type AnswerReference = Evidence

export type AnswerDegradationReason =
  | "no_results"
  | "no_context_evidence"
  | "no_cited_claims"
  | "coverage_not_met"
  | "resource_budget_exceeded"

export interface AnswerDegradation {
  status: "none" | "partial" | "insufficient"
  unavailableChannels: RetrievalResult["source"][]
  reason?: AnswerDegradationReason
}

export interface AnswerRunResult {
  runId: string
  status: AnswerTerminalStatus
  reply: string
  references: AnswerReference[]
  degradation: AnswerDegradation
  /**
   * Ticket 17 (MODEL-01B): the immutable, non-secret model profile snapshot
   * this run resolved at composition time (chat model id, rerank model id or
   * null, embedding profile `model:dimensions`). Stamped by the shared Answer
   * entry on the terminal event, so a persisted run trace and its references
   * always remain traceable to the exact models that produced them — without
   * ever carrying a key or a provider URL. Absent on events produced by
   * callers that predate the field.
   */
  modelProfile?: AnswerModelProfileSnapshot
  /**
   * T12 (spec issue #12 criterion #1): LLM token usage from the rolling-
   * summary step (when a Summarizer is wired and summarization was
   * attempted). Absent when no summarizer is wired, the recent-pair window
   * was not exceeded, or summarization was skipped for any other reason.
   */
  summarizationUsage?: TokenUsage
  /**
   * T12: wall-clock duration of the summarization LLM call in ms. Absent
   * when summarization was not attempted.
   */
  summarizationDurationMs?: number
  /**
   * T12: the new checkpoint turn ID written by `saveRollingSummary` (the
   * `oldestRecentTurnId - 1` boundary). Absent when summarization was not
   * attempted or failed before saving.
   */
  summarizationCheckpoint?: number
  /**
   * T12: outcome of the summarization step. "success" = summary saved;
   * "skipped" = no summarizer, recent window not exceeded, or no new work;
   * "failed" = LLM call rejected or returned empty (safe degradation).
   */
  summarizationOutcome?: "success" | "skipped" | "failed"
}

export type AnswerRunStage =
  | "route"
  | "retrieval"
  | "context"
  | "answer"
  | "validation"
  | "done"

/**
 * Ticket 17 (MODEL-01B): non-secret model identity of one Answer run. Resolved
 * ONCE per composed entry (never per request) and stamped immutably on the
 * run's terminal result — a concurrent run with a different profile can never
 * rewrite another run's snapshot, and the shared configuration is never
 * mutated to express a per-run choice.
 */
export interface AnswerModelProfileSnapshot {
  chatModel: string
  /** The dedicated reranker's model id, or null when none is configured. */
  rerankModel: string | null
  /** `embeddingModel:dimensions` — the vector space this run's KBs accept. */
  embeddingProfile: string
}

export interface AnswerRunEventBase {
  schemaVersion: 1
  sessionId: string
  runId: string
  /**
   * Eval refactor Ticket 01: optional correlation to an evaluation case.
   * Set only when the caller injected `AnswerRunOptions.caseId` (evaluation
   * runs). Normal chat never sets it, so the transport payload is unchanged.
   */
  caseId?: string
  eventId: string
  sequence: number
  createdAt: string
  stage: AnswerRunStage
  status: "running" | "completed" | "degraded" | "failed" | "cancelled"
  durationMs: number | null
  attempt: number
  round: number
  inputSummary: string
  outputSummary: string
}

export interface RouteSubQuery {
  original: string
  rewritten: string
  coverageCriteria?: string[]
}

/**
 * Ticket 08 (spec §13): stop reason for the bounded complex retrieval loop.
 * Duplicated from `src/retrieval/complex_loop.ts` to avoid a circular type
 * import (complex_loop.ts imports from `../types`). The two definitions are
 * structurally identical — a value of one is assignable to the other.
 */
export type ComplexLoopStopReason =
  | "evidence-sufficient"
  | "iteration-budget"
  | "tool-budget"
  | "provider-failure"
  | "deterministic-fallback"

export interface RouteTraceData {
  decision?: "direct" | "simple" | "ambiguous" | "complex"
  queryCount?: number
  subQueries?: RouteSubQuery[]
  modelCalls?: number
  tokens?: number
  contextualizationFailure?: string
  /**
   * T12 (spec issue #12 criterion #1): LLM token usage from the
   * contextualization step. Present only when a Contextualizer is wired
   * AND the LLM call succeeded. Absent when contextualization was skipped
   * (no contextualizer or no recent turns) or failed (see
   * contextualizationFailure).
   */
  contextualizationUsage?: TokenUsage
  /**
   * T12: wall-clock duration of the contextualization LLM call in ms.
   * Absent when contextualization was not attempted.
   */
  contextualizationDurationMs?: number
  /**
   * T12: outcome of the contextualization step. "success" = rewritten
   * query produced; "skipped" = no contextualizer or no recent turns;
   * "failed" = LLM call rejected or returned empty (see
   * contextualizationFailure for the reason).
   */
  contextualizationOutcome?: "success" | "skipped" | "failed"
  /**
   * Ticket 07 (spec §12): the read-only retrieval tool the LLM selected for
   * the simple knowledge route. Present only when (a) the route decision is
   * "simple" AND (b) a ToolSelector is wired. Direct/ambiguous/complex routes
   * never populate this field (criterion #3).
   */
  selectedTool?: RetrievalToolName
  /**
   * Ticket 07 (criterion #5): present when the LLM's original tool choice was
   * malformed, unsupported, absent, or contained forbidden args, and the
   * selector fell back to semantic_lexical_hybrid. The value is a short
   * machine-readable reason code (e.g. "no_tool_call", "unknown_tool: x",
   * "invalid_arguments: graph_navigation").
   */
  toolFallbackReason?: string
  /**
   * Ticket 08 (spec §13): present only when (a) the route decision is
   * "complex" AND (b) a ComplexLoopController is wired. Records why the
   * bounded retrieval loop terminated (criterion #6). When absent, the
   * complex route used the existing single-pass planner.decompose flow.
   */
  complexLoopStopReason?: ComplexLoopStopReason
  /**
   * Ticket 08 (criterion #1): number of LLM decision iterations actually
   * executed (≤3). Present only when complexLoopStopReason is present.
   */
  complexLoopIterations?: number
  /**
   * Ticket 08 (criterion #1): number of retrieval tool calls actually
   * executed (≤4, excludes duplicates). Present only when
   * complexLoopStopReason is present.
   */
  complexLoopToolCalls?: number
}

export interface RetrievalTraceData {
  correction?: boolean
  channelStatuses?: Partial<Record<
    RetrievalResult["source"],
    "running" | "completed" | "unavailable"
  >>
  resultCount?: number
  selectedEvidenceIds?: string[]
  degradedReasons?: string[]
  hydeUsed?: boolean
  graphSeeds?: string[]
  graphHops?: number
  graphCandidates?: number
  /**
   * Ticket 06: Channels that were not requested by the caller (omitted from
   * `SearchOptions.channels`). Distinguishable from `channelStatuses` entries
   * marked `"unavailable"` (channels that were requested but failed during
   * execution). Populated only when the caller selected a subset; omitted/
   * empty when all channels were executed.
   */
  unselectedChannels?: RetrievalResult["source"][]
  /**
   * Ticket 07 (criterion #7): the read-only retrieval tool that produced
   * these results. Same value as RouteTraceData.selectedTool, repeated here
   * so the retrieval event is self-contained (no second event stream).
   * Present only for the simple route when a ToolSelector is wired.
   */
  selectedTool?: RetrievalToolName
  /**
   * Ticket 07 (criterion #7): safe input summary of the tool call
   * (tool name + query preview + seed count). Present only when
   * selectedTool is present.
   */
  toolInputSummary?: string
  /**
   * Ticket 07 (criterion #7): same as RouteTraceData.toolFallbackReason,
   * repeated on the retrieval event for self-containment.
   */
  toolFallbackReason?: string
  /**
   * Ticket 08 (spec §13): marks this retrieval event as a complex-loop
   * iteration (emitted from inside runComplexLoop). When absent, the event
   * came from the existing single-pass retrieval loop. Complex-loop events
   * always carry `iteration`, `duplicate`, `selectedTool`, and
   * `toolInputSummary` (criterion #7 — same event stream, no second stream).
   */
  complexLoop?: boolean
  /**
   * Ticket 08: 1-based loop iteration index that produced this tool call.
   * Present only when `complexLoop === true`.
   */
  iteration?: number
  /**
   * Ticket 08 (criterion #3): true when this tool call was a duplicate of a
   * prior call (same normalized tool + query + args) and was skipped without
   * backend execution. Present only when `complexLoop === true`.
   */
  duplicate?: boolean
  /**
   * Ticket 08 (criterion #5): true when observation compression ran after
   * this tool call to bound the observation memory before the next LLM
   * decision. Present only when `complexLoop === true` AND a compressor is
   * wired AND compression succeeded for this iteration.
   */
  complexLoopCompressionRan?: boolean
  /**
   * Ticket 08: uncompressed input token count fed to the loop's observation
   * compressor for this iteration. Present only when
   * `complexLoopCompressionRan === true`.
   */
  complexLoopCompressionInputTokens?: number
  /**
   * Ticket 08: compressed output token count produced by the loop's
   * observation compressor. Present only when
   * `complexLoopCompressionRan === true`.
   */
  complexLoopCompressionOutputTokens?: number
  /**
   * Ticket 09 (criterion #5): marks a correction-round retrieval event that
   * resulted from a deterministic `searcher.search` fallback after the complex
   * loop produced 0 usable new Evidence (provider failure, budget exhaustion,
   * or loop call error). When absent, the event came from the loop itself or
   * from the legacy non-fallback path. Always paired with `correction: true`.
   */
  fallback?: boolean
  /**
   * Eval refactor Ticket 01: the ordered candidates that fed the FINAL
   * generation context — the assembler input list of the generation round
   * that produced the final reply (initial round, or the last correction
   * round that regenerated the answer). For complex routes with multiple
   * tool retrievals this is the runner's existing ordered aggregation, not
   * an arbitrary single tool call.
   *
   * Present only when a draft was accepted (the citation check passed) —
   * terminals that never accepted any draft omit the field.
   * Observers must use THIS list for retrieval ranking — the done event's
   * `references` are citation-derived and are NOT a retrieval ranking.
   * Note: across correction rounds the same chunk may be hit again on a
   * different channel; this observation keeps the FIRST hit's channels and
   * score (single-round channel merging matches the round's assembler view).
   */
  finalContextCandidates?: RankedCandidateObservation[]
  /**
   * Eval refactor Ticket 01: 1-based generation round whose context produced
   * the final reply (1 = initial draft; +1 per correction regeneration).
   * Pairs with `finalContextCandidates`.
   */
  finalContextRound?: number
  /**
   * Eval refactor Ticket 06: honest score source of that final ranking.
   * Mirrors `RetrievalOrdering` (retrieval/search/interface.ts) and adds the
   * merged case, because a multi-query runner (complex route) orders its final
   * context itself out of several retrievals — no single rerank produced it,
   * and it must not be labelled as one.
   */
  finalContextOrdering?: FinalContextOrdering
}

/**
 * Eval refactor Ticket 06: how the published final-ranking was produced.
 * `dedicated_rerank` means the configured reranker scored this order; `fused`
 * means an unscored order was published (fusion, below-threshold,
 * unavailable reranker, or the multi-query merge).
 */
export interface FinalContextOrdering {
  source: "dedicated_rerank" | "fused"
  reason?: "not_configured" | "below_threshold" | "unavailable" | "multi_query_aggregation"
}

/**
 * Eval refactor Ticket 01: one ranked retrieval candidate as observed on the
 * final generation context. Identity is the chunk/document pair the runner
 * deduplicates on; `rank` is the 1-based position in the ordered candidate
 * list fed to the context assembler.
 */
export interface RankedCandidateObservation {
  rank: number
  documentId: string
  chunkId: string
  score: number
  channels: RetrievalResult["source"][]
  /** Eval refactor Ticket 01: Evidence id assigned by buildEvidence, when built. */
  evidenceId?: string
}

export interface ContextTraceData {
  evidenceCount?: number
  contextLength?: number
  /**
   * Ticket 61 / 04 (spec §2 L1748): whether semantic Evidence-Context
   * compression ran for this context assembly step. `false` (or omitted)
   * means the deterministic assembler output was used as-is (bypass when
   * the uncompressed context fits the existing budget, or fallback after
   * a compression failure). `true` means an LLM-backed compressor produced
   * the context string from per-Evidence-group compressed blocks.
   */
  compressionRan?: boolean
  /**
   * Ticket 61 / 04: uncompressed input token count fed to the compressor
   * (sum of all Evidence group block token counts, including INTRO/SUFFIX
   * overhead). Present only when compression was attempted.
   */
  compressionInputTokens?: number
  /**
   * Ticket 61 / 04: compressed output token count produced by the compressor.
   * Present only when compression succeeded (`compressionRan === true`).
   */
  compressionOutputTokens?: number
  /**
   * Ticket 61 / 04 (spec §2 L1749): Evidence IDs whose compressed blocks
   * were retained in the final context. Present only when compression
   * succeeded. A subset of the input Evidence IDs — groups whose
   * compression failed (empty/invalid/timed-out) are recorded in
   * `compressionDroppedEvidenceIds` instead.
   */
  compressionRetainedEvidenceIds?: string[]
  /**
   * Ticket 61 / 04: Evidence IDs whose compressed blocks were dropped
   * during compression (present in the input but absent in the output
   * because their per-group LLM call failed). Present only when compression
   * was attempted. When ALL groups failed, `compressionRan` stays `false`
   * and the deterministic assembled Context is used instead.
   */
  compressionDroppedEvidenceIds?: string[]
  /**
   * T12 (spec issue #12 criterion #2): aggregated LLM token usage from the
   * compressor's per-group LLM calls (best-effort). Absent when compression
   * was not attempted or the compressor didn't return usage. Distinct from
   * compressionInputTokens/compressionOutputTokens which are deterministic
   * text token counts, not LLM API usage.
   */
  compressionUsage?: TokenUsage
}

export interface ValidationTraceData {
  round?: number
  passed?: boolean
}

export type AnswerRunEventPayload =
  | { type: "progress"; stage: "route"; message: string; data: RouteTraceData }
  | { type: "progress"; stage: "retrieval"; message: string; data: RetrievalTraceData }
  | { type: "progress"; stage: "context"; message: string; data: ContextTraceData }
  | { type: "progress"; stage: "validation"; message: string; data: ValidationTraceData }
  | { type: "answer_delta"; stage: "answer"; token: string }
  | { type: "done"; stage: "done"; result: AnswerRunResult }

export type AnswerRunEvent = AnswerRunEventBase & AnswerRunEventPayload

// ---------------------------------------------------------------------------
// Ticket 09 — Handoff and Feedback contracts (Phase C §8)
// ---------------------------------------------------------------------------

/**
 * Spec §8 L1544: Handoff states. Legal transitions:
 *   open → claimed → resolved
 *   open → cancelled
 *   claimed → cancelled
 */
export type HandoffState = "open" | "claimed" | "resolved" | "cancelled"

/**
 * Spec §8 L1542: reason the Answer run was handed off to a human.
 * - `user_request`: user explicitly requested a human
 * - `policy_review`: policy requires human review
 * - `insufficient_evidence`: bounded correction ended without sufficient Evidence
 *   and handoff is enabled
 * - `provider_error`: run failed due to a provider issue and handoff is enabled
 * - `other`: catch-all for future reason codes
 */
export type HandoffReasonCode =
  | "user_request"
  | "policy_review"
  | "insufficient_evidence"
  | "provider_error"
  | "other"

/**
 * Spec §8 L1543: A Handoff case records Tenant, subject, session ID, run ID,
 * reason code, bounded user request, validated Conversation summary, Evidence
 * IDs, trace reference, status and timestamps.
 */
export interface HandoffCase {
  id: string
  runId: string
  tenantId: string
  subjectId: string
  sessionId: string
  reasonCode: HandoffReasonCode
  userRequest: string
  conversationSummary: string
  evidenceIds: string[]
  traceReference: string
  status: HandoffState
  createdAt: string
  updatedAt: string
}

/** Spec §8 L1546: Feedback rating. */
export type FeedbackRating = "up" | "down"

/** Spec §8 L1547: Supported negative reason codes. */
export type FeedbackReasonCode =
  | "wrong_answer"
  | "wrong_citation"
  | "incomplete"
  | "stale_knowledge"
  | "unwanted_handoff"
  | "other"

/**
 * Spec §8 L1546: Feedback records Tenant, subject, run ID, rating, reason code,
 * optional bounded comment, referenced Evidence IDs and timestamps.
 * Spec §8 L1548: One current Feedback record per (tenant, subject, run ID).
 */
export interface Feedback {
  id: string
  runId: string
  tenantId: string
  subjectId: string
  rating: FeedbackRating
  reasonCode: FeedbackReasonCode | null
  comment: string | null
  evidenceIds: string[]
  createdAt: string
  updatedAt: string
}
