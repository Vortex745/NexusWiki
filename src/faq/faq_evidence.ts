/**
 * Ticket 31 (FAQ-01B) — the bridge from FAQ entries to the answer path.
 *
 * Two surfaces, one identity rule:
 *
 *  - `createFaqEvidenceOperations` adapts `FaqEntryService.listActive` into
 *    the `FaqEvidenceOperations` seam the searcher's "faq" channel calls:
 *    fuzzy matches of the query become ordinary RetrievalResults that flow
 *    through fusion, rerank, citation checks and validation like any other
 *    evidence — they never bypass generation checks.
 *  - `buildFaqEvidence` builds the single reference the EXACT-match path
 *    attaches to the direct standard answer.
 *
 * Both go through the same synthetic chunk identity
 * (`<entryId>` + `faq:<entryId>:v<version>`), so the reference for a given
 * entry version has the SAME stable evidence id on both paths.
 */

import type {
  FaqEvidenceOperations,
  RetrievalResult,
} from "../types/retrieval"
import type { Evidence } from "../types"
import { buildEvidence } from "../answer/evidence"
import type { FaqEntryService } from "./faq_entry_service"
import type { FaqActiveIdentityRow } from "./faq_entry_repo"
import { matchFuzzyFaqs } from "./faq_matcher"

/** The stable synthetic identity of one FAQ entry version as evidence. */
export function faqChunkIdentity(row: FaqActiveIdentityRow): {
  documentId: string
  chunkId: string
} {
  return { documentId: row.entryId, chunkId: `faq:${row.entryId}:v${row.version}` }
}

/**
 * The FAQ entry version as a retrieval result. `content` carries question AND
 * answer (the generator needs both to cite a standard answer); the metadata
 * mirrors the attachment provenance pattern so buildEvidence emits an
 * `origin: "faq"` citation.
 */
export function faqRetrievalResult(row: FaqActiveIdentityRow): RetrievalResult {
  const { documentId, chunkId } = faqChunkIdentity(row)
  return {
    chunk: {
      id: chunkId,
      documentId,
      content: `问题：${row.question}\n标准答案：${row.answer}`,
      childrenIds: [],
      metadata: {
        title: `FAQ：${row.question}`,
        source: "faq",
        origin: "faq",
        faqEntryId: row.entryId,
        faqVersion: row.version,
        documentVersion: row.version,
      },
    },
    score: 1,
    source: "faq",
    channels: ["faq"],
    wikilinks: [],
  }
}

/** The Evidence for one FAQ entry version (exact-match direct answer path). */
export function buildFaqEvidence(row: FaqActiveIdentityRow): Evidence {
  return buildEvidence([faqRetrievalResult(row)])[0]
}

/**
 * The searcher-side FAQ channel. Fails closed per scope (an empty knowledge
 * scope returns nothing) and never widens: only `listActive` of the exact
 * (tenant, knowledge ids) is read — disabled, conflicting and cross-knowledge
 * entries are structurally absent by ticket 30's contract.
 */
export function createFaqEvidenceOperations(service: FaqEntryService): FaqEvidenceOperations {
  return {
    search(request) {
      if (request.knowledgeBaseIds.length === 0) return Promise.resolve([])
      const rows = service.listActive(request.tenantId, request.knowledgeBaseIds)
      const matches = matchFuzzyFaqs(rows, request.query, request.limit)
      return Promise.resolve(matches.map(faqRetrievalResult))
    },
  }
}
