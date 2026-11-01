/**
 * Ticket 30 (FAQ-01A) — the versioned FAQ contract.
 *
 * A FAQ entry is a canonical question with optional variants and ONE sourced
 * standard answer, owned by exactly one knowledge base. Lifecycle rules live in
 * the service (`src/faq/faq_entry_service.ts`); the tables live in the
 * repository; everything a consumer may rely on is defined here.
 *
 * Versioning: an edit never mutates a version — it adds one. `currentVersion`
 * on the entry is the pointer a reader follows, so a run that cited version 3
 * keeps referring to version 3 forever.
 *
 * Retrieval: only ACTIVE entries are ever offered to the answer path. A
 * disabled entry stays fully inspectable (every version, its status) but is
 * invisible to retrieval — this is the axis the ticket's acceptance pins.
 */

export type FaqEntryStatus = "active" | "disabled"

/** Where a standard answer comes from (kept non-secret: no credentials). */
export interface FaqSource {
  title: string
  /** Optional locator (URL, document name, ticket id). Never a credential. */
  uri: string | null
}

export interface FaqEntryVersion {
  version: number
  question: string
  /** Ticket 30: normalized form the conflict rule compares. */
  normalizedQuestion: string
  variants: string[]
  answer: string
  source: FaqSource | null
  createdBy: string
  createdAt: string
}

export interface FaqEntry {
  id: string
  tenantId: string
  knowledgeBaseId: string
  status: FaqEntryStatus
  currentVersion: number
  createdAt: string
  updatedAt: string
}

export interface FaqEntryWithVersion extends FaqEntry {
  version: FaqEntryVersion
}

/** A bounded, explicit input envelope — service constants, not page settings. */
export const FAQ_LIMITS = {
  maxQuestionChars: 500,
  maxVariantChars: 300,
  maxVariants: 20,
  maxAnswerChars: 8_000,
  maxSourceTitleChars: 200,
  maxSourceUriChars: 500,
  /** Rows one JSON/CSV import may carry. */
  maxImportRows: 500,
} as const

/**
 * Normalization version. The conflict rule ("one active answer per normalized
 * question") is only stable while every stored entry was normalized by the same
 * rules, so the rule set is versioned like the evaluation text rules are.
 */
export const FAQ_NORMALIZE_VERSION = "faq-norm-v1"

/**
 * Deterministic normalization of a FAQ question: NFKC, folded to lower case,
 * whitespace collapsed, trailing/leading punctuation dropped. Two questions
 * that differ only in spacing, width or case are the same question.
 */
export function normalizeFaqQuestion(question: string): string {
  const normalized = question
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s"'“”‘’「」【】()（）]+/, "")
    .replace(/[\s"'“”‘’「」【】()（）?!？!。.,，、;；:：]+$/, "")
  return normalized
}

/** Error message shape for a conflicting activation (→ HTTP 409). */
export interface FaqConflictDetail {
  question: string
  normalizedQuestion: string
  /** The active entry that already answers this question. */
  conflictingEntryId: string
  /** True when the clash is with a VARIANT of the other entry. */
  viaVariant: boolean
}
