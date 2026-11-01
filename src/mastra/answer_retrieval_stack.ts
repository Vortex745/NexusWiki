/**
 * Ticket 49 (ARCH-01B) — the Answer retrieval stack.
 *
 * `createSharedAnswerEntry` is the one composition seam chat and evaluation
 * share. This module owns the part of it that answers "how does an Answer run
 * read the knowledge base": the dedicated reranker, the search operations, the
 * optional evidence channels, and the searcher factory the knowledge routes
 * call. The entry keeps the request-facing behavior — observers, budgets,
 * cancellation, the frozen model snapshot — and never learns how a searcher is
 * assembled.
 *
 * The stack takes a narrow context of already-resolved collaborators, not the
 * entry's options object, so its dependencies stay one-directional: entry →
 * stack → retrieval implementation. `createSearcher(assistant)` is the whole
 * retrieval surface a route needs; which operations an assistant gets (and
 * why a rerank-free snapshot must not see the dedicated reranker) is decided
 * here, behind that one call.
 *
 * Boundary (T02 #5): lives in src/mastra/* and MUST NOT import `src/api/*`,
 * `src/evaluation/*` or `src/index`.
 */

import type { Client as ElasticsearchClient } from "@elastic/elasticsearch"
import type OpenAI from "openai"
import { resolveChunkIndexName, type AppConfig } from "../config"
import type { DB } from "../ingestion/tracking/db"
import { PageIndexRepository } from "../ingestion/tracking/page_index_repo"
import { ActiveVersionRepository } from "../ingestion/tracking/active_version_repo"
import {
  RuntimeSearchOperations,
  SearcherImpl,
  type SearchOperations,
} from "../retrieval/search/searcher"
import {
  createDedicatedReranker,
  type Reranker,
} from "../retrieval/search/dedicated_reranker"
import type { AttachmentSearchOperations, WebEvidenceOperations } from "../types/retrieval"
import type { FaqEntryService } from "../faq/faq_entry_service"
import { createFaqEvidenceOperations } from "../faq/faq_evidence"
import type { AssistantRunSnapshot } from "../assistants/assistant_service"
import type { TracingRuntime } from "../tracing/contract"

export interface AnswerRetrievalStackContext {
  /** Read for the RERANK_* surface and the embedding profile only. */
  config: AppConfig
  db: DB
  elasticsearch: ElasticsearchClient
  embeddingClient: OpenAI
  /** LO-12: the process-wide tracing runtime, so rerank calls are observed. */
  tracing?: TracingRuntime
  /**
   * Retrieval operations (ES + embedding + PageIndex/ActiveVersion repos).
   * Default: RuntimeSearchOperations on the shared clients.
   */
  searchOperations?: SearchOperations
  /**
   * Dedicated reranker (Ticket 03). Default: built from the RERANK_* config
   * (undefined when no key is configured). Injected by evaluation when a task
   * overrides the rerank model (Ticket 11).
   */
  reranker?: Reranker
  /** Ticket 22 (ATT-01): the session-scoped attachment channel. */
  attachments?: AttachmentSearchOperations
  /** Ticket 31 (FAQ-01B): the versioned FAQ service (fuzzy evidence channel). */
  faq?: FaqEntryService
  /** Ticket 36 (WEB-01): the web-evidence adapter. */
  web?: WebEvidenceOperations
}

export interface AnswerRetrievalStack {
  /**
   * Ticket 14 (RET-01): the operations chat retrieves with. The entry hands
   * this SAME object to its callers so debug tooling shares chat's
   * configuration and implementation.
   */
  searchOperations: SearchOperations
  /** The searcher factory the knowledge routes call, per assistant snapshot. */
  createSearcher(assistant?: AssistantRunSnapshot): SearcherImpl
  /** Model name for the frozen profile snapshot, or null when unrouted. */
  rerankModel: string | null
}

export function createAnswerRetrievalStack(
  context: AnswerRetrievalStackContext
): AnswerRetrievalStack {
  const { config: cfg, db, elasticsearch, embeddingClient } = context
  const { attachments, faq, web } = context

  // Ticket 03: the dedicated reranker is shared by normal chat and evaluation.
  // No key configured → undefined → retrieval degrades visibly
  // (`rerank.reason = "not_configured"`), never a different scorer.
  const reranker =
    context.reranker ??
    createDedicatedReranker({
      baseUrl: cfg.rerankBaseUrl,
      apiKey: cfg.rerankApiKey,
      model: cfg.rerankModel,
      timeoutMs: cfg.rerankTimeoutMs,
      maxDocumentChars: cfg.rerankMaxDocumentChars,
      ...(context.tracing ? { tracing: context.tracing } : {}),
    })
  const pageIndexRepo = new PageIndexRepository(db)
  const activeVersionRepo = new ActiveVersionRepository(db)
  const searchOperations =
    context.searchOperations ??
    new RuntimeSearchOperations({
      es: elasticsearch,
      embeddingClient,
      embeddingModel: cfg.embeddingModel,
      indexName: resolveChunkIndexName(undefined, cfg),
      pageIndexRepo,
      activeVersionRepo,
      ...(reranker ? { reranker } : {}),
    })
  // Ticket 19 (AST-01B): the rerank-free variant — an assistant whose
  // immutable snapshot pins `rerankModelProfileId: null` runs WITHOUT the
  // dedicated reranker (fused order + explicit reason), never with it. Only
  // derivable when this stack built its own operations; injected operations
  // (evaluation scopes) never carry assistant overlays.
  // Ticket 31 (FAQ-01B): both searcher variants share the FAQ evidence
  // channel; optional params accept undefined explicitly.
  const faqEvidence = faq ? createFaqEvidenceOperations(faq) : undefined
  // Ticket 36 (WEB-01): the web-evidence channel. Like attachments and FAQ,
  // it exists only when the composition wires it — the production root
  // (src/index.ts) passes the shared safe fetcher + the config's server-side
  // Tavily key; evaluation scopes and probes omit it entirely.
  const buildSearcher = (operations: SearchOperations) =>
    new SearcherImpl(operations, attachments, faqEvidence, web, context.tracing)
  const searchOperationsWithoutRerank = context.searchOperations
    ? undefined
    : new RuntimeSearchOperations({
        es: elasticsearch,
        embeddingClient,
        embeddingModel: cfg.embeddingModel,
        indexName: resolveChunkIndexName(undefined, cfg),
        pageIndexRepo,
        activeVersionRepo,
      })
  const searcherOperationsFor = (assistant?: AssistantRunSnapshot) =>
    assistant?.rerankModelProfileId === null && searchOperationsWithoutRerank
      ? searchOperationsWithoutRerank
      : searchOperations

  return {
    searchOperations,
    createSearcher: (assistant) => buildSearcher(searcherOperationsFor(assistant)),
    rerankModel: reranker?.model ?? null,
  }
}
