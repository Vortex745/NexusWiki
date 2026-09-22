/**
 * Ticket 30 (FAQ-01A) — FAQ lifecycle: create, version, activate, disable,
 * import.
 *
 * Rules this service owns (and the tests pin):
 *
 * 1. Knowledge scoping: every read and write is (tenant, knowledge base)
 *    scoped; an entry of another knowledge base or tenant is a 404, never a
 *    cross-base read. The API layer resolves the knowledge base first (unknown
 *    or archived is refused there), so this service can trust the id it is
 *    given.
 * 2. Versioning: an edit INSERTs a new immutable version and moves the
 *    pointer. Nothing rewrites history, so an answer cited at version 3 keeps
 *    referring to version 3. An edit that changes nothing adds no version.
 * 3. One active answer per normalized question: creating or activating an entry
 *    whose question (or one of its variants) collides with another ACTIVE
 *    entry's question/variants is a conflict (409). Disabled entries may
 *    collide — the rule is about what retrieval could serve.
 * 4. Disabled entries stay fully inspectable (list/get/versions) but are
 *    structurally absent from {@link FaqEntryService.listActive}, the only
 *    surface the answer path may use.
 * 5. Import is row-precise: a JSON array or a CSV file is applied row by row,
 *    each rejected row names its row number and reason, and valid rows are
 *    still imported (partial success, never a silent drop).
 */

import { randomUUID } from "node:crypto"
import type {
  FaqEntryStatus,
  FaqEntryVersion,
  FaqEntryWithVersion,
  FaqSource,
} from "../types/faq"
import { FAQ_LIMITS, normalizeFaqQuestion } from "../types/faq"
import type { FaqActiveIdentityRow, FaqEntryRepo } from "./faq_entry_repo"
import { parseCsvTable } from "./csv"

export class FaqEntryNotFoundError extends Error {
  constructor(message = "faq entry not found in this knowledge base") {
    super(message)
    this.name = "FaqEntryNotFoundError"
  }
}

export class InvalidFaqCommandError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid faq entry: ${issues.join("; ")}`)
    this.name = "InvalidFaqCommandError"
  }
}

/** Two active configurations would answer the same question (→ HTTP 409). */
export class FaqConflictError extends Error {
  constructor(
    message: string,
    readonly detail: {
      question: string
      normalizedQuestion: string
      conflictingEntryId: string
      viaVariant: boolean
    }
  ) {
    super(message)
    this.name = "FaqConflictError"
  }
}

export interface FaqCommandInput {
  question?: unknown
  variants?: unknown
  answer?: unknown
  source?: unknown
}

/** The validated shape a command is normalized into. */
interface FaqDraft {
  question: string
  normalizedQuestion: string
  variants: string[]
  normalizedVariants: string[]
  answer: string
  source: FaqSource | null
}

export type FaqImportFormat = "json" | "csv"

export interface FaqImportResult {
  /** Rows that became new entries. */
  imported: number
  /** Existing entries whose current version was advanced by a row. */
  versioned: number
  /** Rejected DATA rows (invalid, duplicate, conflicting, identical). */
  skipped: number
  /**
   * Every rejection reason, prefixed with its row position. Structural items
   * that never become a row at all (a JSON array element that is not an
   * object) are reported here WITHOUT entering the skipped count, so
   * imported + versioned + skipped can be smaller than the file's item count —
   * deliberately: only things that were considered as rows are accounted.
   */
  issues: string[]
}

export interface FaqEntryService {
  create(
    tenantId: string,
    knowledgeBaseId: string,
    input: FaqCommandInput,
    actor: string
  ): FaqEntryWithVersion
  edit(
    tenantId: string,
    knowledgeBaseId: string,
    id: string,
    input: FaqCommandInput,
    actor: string
  ): FaqEntryWithVersion
  activate(tenantId: string, knowledgeBaseId: string, id: string): FaqEntryWithVersion
  disable(tenantId: string, knowledgeBaseId: string, id: string): FaqEntryWithVersion
  /** Disabled entries ARE returned here: inspection never hides them. */
  list(
    tenantId: string,
    knowledgeBaseId: string,
    options?: { status?: FaqEntryStatus }
  ): FaqEntryWithVersion[]
  get(tenantId: string, knowledgeBaseId: string, id: string): FaqEntryWithVersion | null
  listVersions(
    tenantId: string,
    knowledgeBaseId: string,
    id: string
  ): FaqEntryVersion[]
  importEntries(
    tenantId: string,
    knowledgeBaseId: string,
    request: { format: FaqImportFormat; content: string },
    actor: string
  ): FaqImportResult
  /**
   * Ticket 31 seam: the ACTIVE entries of a scope, for the answer path. An
   * empty scope returns nothing (never "all knowledge bases").
   */
  listActive(
    tenantId: string,
    knowledgeBaseIds: readonly string[]
  ): FaqActiveIdentityRow[]
}

export interface FaqEntryServiceOptions {
  repo: FaqEntryRepo
  now?: () => Date
  generateId?: () => string
}

export class FaqEntryServiceImpl implements FaqEntryService {
  private readonly repo: FaqEntryRepo
  private readonly now: () => Date
  private readonly generateId: () => string

  constructor(options: FaqEntryServiceOptions) {
    this.repo = options.repo
    this.now = options.now ?? (() => new Date())
    this.generateId = options.generateId ?? (() => `faq-${randomUUID()}`)
  }

  create(
    tenantId: string,
    knowledgeBaseId: string,
    input: FaqCommandInput,
    actor: string
  ): FaqEntryWithVersion {
    const draft = this.normalize(input)
    const conflict = this.findConflict(tenantId, knowledgeBaseId, draft, null)
    if (conflict) throw this.conflictError(draft, conflict)

    const timestamp = this.now().toISOString()
    const id = this.generateId()
    this.repo.createEntryWithVersion(
      {
        id,
        tenantId,
        knowledgeBaseId,
        status: "active",
        currentVersion: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      toVersion(draft, 1, actor, timestamp)
    )
    return this.requireWithVersion(tenantId, knowledgeBaseId, id)
  }

  edit(
    tenantId: string,
    knowledgeBaseId: string,
    id: string,
    input: FaqCommandInput,
    actor: string
  ): FaqEntryWithVersion {
    const entry = this.requireEntry(tenantId, knowledgeBaseId, id)
    const current = this.repo.getVersion(entry.id, entry.currentVersion)
    if (!current) throw new FaqEntryNotFoundError("faq entry has no current version")
    // An omitted field keeps its current value (this is a PATCH, not a replace)
    // and the merge uses the version THIS call just read — never a snapshot an
    // HTTP handler took before another writer committed.
    const merged: FaqCommandInput = {
      ...(input.question === undefined ? { question: current.question } : { question: input.question }),
      ...(input.answer === undefined ? { answer: current.answer } : { answer: input.answer }),
      ...(input.variants === undefined ? { variants: current.variants } : { variants: input.variants }),
      // `null` clears the source explicitly; an absent field keeps it.
      ...(input.source === undefined ? { source: current.source } : { source: input.source }),
    }
    const draft = this.normalize(merged)

    // Ticket 30: unchanged content adds no version (an import of the same file
    // twice must not inflate history).
    if (sameDraft(draft, current)) {
      return { ...this.requireEntry(tenantId, knowledgeBaseId, id), version: current }
    }
    if (entry.status === "active") {
      const conflict = this.findConflict(tenantId, knowledgeBaseId, draft, entry.id)
      if (conflict) throw this.conflictError(draft, conflict)
    }

    const timestamp = this.now().toISOString()
    const version = entry.currentVersion + 1
    this.repo.appendVersion(entry.id, tenantId, toVersion(draft, version, actor, timestamp), timestamp)
    return this.requireWithVersion(tenantId, knowledgeBaseId, id)
  }

  activate(tenantId: string, knowledgeBaseId: string, id: string): FaqEntryWithVersion {
    const entry = this.requireEntry(tenantId, knowledgeBaseId, id)
    const current = this.repo.getVersion(entry.id, entry.currentVersion)
    if (!current) throw new FaqEntryNotFoundError("faq entry has no current version")
    const draft: FaqDraft = {
      question: current.question,
      normalizedQuestion: current.normalizedQuestion,
      variants: current.variants,
      normalizedVariants: current.variants.map(normalizeFaqQuestion),
      answer: current.answer,
      source: current.source,
    }
    // Ticket 30 acceptance: two active answers for one normalized question can
    // never both be active — the conflict is refused here, with nothing written.
    const conflict = this.findConflict(tenantId, knowledgeBaseId, draft, entry.id)
    if (conflict) throw this.conflictError(draft, conflict)

    this.repo.setStatus(entry.id, tenantId, "active", this.now().toISOString())
    return this.requireWithVersion(tenantId, knowledgeBaseId, id)
  }

  disable(tenantId: string, knowledgeBaseId: string, id: string): FaqEntryWithVersion {
    const entry = this.requireEntry(tenantId, knowledgeBaseId, id)
    this.repo.setStatus(entry.id, tenantId, "disabled", this.now().toISOString())
    return this.requireWithVersion(tenantId, knowledgeBaseId, id)
  }

  list(
    tenantId: string,
    knowledgeBaseId: string,
    options: { status?: FaqEntryStatus } = {}
  ): FaqEntryWithVersion[] {
    return this.repo
      .listByKnowledgeBase(tenantId, knowledgeBaseId, options)
      .map((entry) => this.withVersion(entry))
  }

  get(tenantId: string, knowledgeBaseId: string, id: string): FaqEntryWithVersion | null {
    const entry = this.repo.getEntry(id, tenantId)
    if (!entry || entry.knowledgeBaseId !== knowledgeBaseId) return null
    return this.withVersion(entry)
  }

  listVersions(
    tenantId: string,
    knowledgeBaseId: string,
    id: string
  ): FaqEntryVersion[] {
    const entry = this.requireEntry(tenantId, knowledgeBaseId, id)
    return this.repo.listVersions(entry.id)
  }

  importEntries(
    tenantId: string,
    knowledgeBaseId: string,
    request: { format: FaqImportFormat; content: string },
    actor: string
  ): FaqImportResult {
    const rows =
      request.format === "csv"
        ? parseCsvRows(request.content)
        : parseJsonRows(request.content)
    const result: FaqImportResult = { imported: 0, versioned: 0, skipped: 0, issues: [...rows.issues] }
    if (rows.rows.length > FAQ_LIMITS.maxImportRows) {
      result.issues.push(
        `the file has ${rows.rows.length} rows; one import handles at most ${FAQ_LIMITS.maxImportRows}`
      )
      result.skipped += rows.rows.length
      return result
    }

    const seen = new Map<string, number>()
    for (const row of rows.rows) {
      const label = `row ${row.rowNumber}`
      let draft: FaqDraft
      try {
        draft = this.normalize(row.input)
      } catch (error) {
        result.skipped += 1
        result.issues.push(
          `${label}: ${error instanceof InvalidFaqCommandError ? error.issues.join("; ") : String(error)}`
        )
        continue
      }
      const previousRow = seen.get(draft.normalizedQuestion)
      if (previousRow !== undefined) {
        result.skipped += 1
        result.issues.push(
          `${label}: duplicate question "${draft.question}" (already imported at row ${previousRow})`
        )
        continue
      }
      seen.set(draft.normalizedQuestion, row.rowNumber)

      const existing = this.findByNormalizedQuestion(tenantId, knowledgeBaseId, draft.normalizedQuestion)
      if (existing) {
        const current = this.repo.getVersion(existing.id, existing.currentVersion)
        if (current && sameDraft(draft, current)) {
          result.skipped += 1
          result.issues.push(
            `${label}: identical to the current version of entry ${existing.id}; nothing to import`
          )
          continue
        }
        if (existing.status === "active") {
          const conflict = this.findConflict(tenantId, knowledgeBaseId, draft, existing.id)
          if (conflict) {
            result.skipped += 1
            result.issues.push(`${label}: ${this.conflictMessage(draft, conflict)}`)
            continue
          }
        }
        const timestamp = this.now().toISOString()
        const version = existing.currentVersion + 1
        this.repo.appendVersion(existing.id, tenantId, toVersion(draft, version, actor, timestamp), timestamp)
        result.versioned += 1
        continue
      }

      const conflict = this.findConflict(tenantId, knowledgeBaseId, draft, null)
      if (conflict) {
        result.skipped += 1
        result.issues.push(`${label}: ${this.conflictMessage(draft, conflict)}`)
        continue
      }
      const timestamp = this.now().toISOString()
      const id = this.generateId()
      this.repo.createEntryWithVersion(
        {
          id,
          tenantId,
          knowledgeBaseId,
          status: "active",
          currentVersion: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        toVersion(draft, 1, actor, timestamp)
      )
      result.imported += 1
    }
    return result
  }

  listActive(
    tenantId: string,
    knowledgeBaseIds: readonly string[]
  ): FaqActiveIdentityRow[] {
    return this.repo.listActiveIdentities(tenantId, knowledgeBaseIds)
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireEntry(tenantId: string, knowledgeBaseId: string, id: string) {
    const entry = this.repo.getEntry(id, tenantId)
    if (!entry || entry.knowledgeBaseId !== knowledgeBaseId) {
      throw new FaqEntryNotFoundError()
    }
    return entry
  }

  private requireWithVersion(
    tenantId: string,
    knowledgeBaseId: string,
    id: string
  ): FaqEntryWithVersion {
    return this.withVersion(this.requireEntry(tenantId, knowledgeBaseId, id))
  }

  private withVersion(entry: ReturnType<FaqEntryRepo["getEntry"]> & object): FaqEntryWithVersion {
    const version = this.repo.getVersion(entry.id, entry.currentVersion)
    if (!version) {
      throw new FaqEntryNotFoundError(`faq entry ${entry.id} is missing version ${entry.currentVersion}`)
    }
    return { ...entry, version }
  }

  /** Any entry of the knowledge base whose CURRENT question normalizes equal. */
  private findByNormalizedQuestion(
    tenantId: string,
    knowledgeBaseId: string,
    normalizedQuestion: string
  ) {
    return this.repo
      .listByKnowledgeBase(tenantId, knowledgeBaseId)
      .find((entry) => {
        const version = this.repo.getVersion(entry.id, entry.currentVersion)
        return version?.normalizedQuestion === normalizedQuestion
      })
  }

  private normalize(input: FaqCommandInput): FaqDraft {
    const issues: string[] = []
    const question = typeof input.question === "string" ? input.question.trim() : ""
    if (!question) issues.push("question is required")
    else if (question.length > FAQ_LIMITS.maxQuestionChars) {
      issues.push(`question must be at most ${FAQ_LIMITS.maxQuestionChars} characters`)
    }
    const answer = typeof input.answer === "string" ? input.answer.trim() : ""
    if (!answer) issues.push("answer is required")
    else if (answer.length > FAQ_LIMITS.maxAnswerChars) {
      issues.push(`answer must be at most ${FAQ_LIMITS.maxAnswerChars} characters`)
    }

    const rawVariants = input.variants ?? []
    if (!Array.isArray(rawVariants)) {
      issues.push("variants must be an array of strings")
    } else if (rawVariants.length > FAQ_LIMITS.maxVariants) {
      issues.push(`variants must hold at most ${FAQ_LIMITS.maxVariants} entries`)
    }
    const variants: string[] = []
    if (Array.isArray(rawVariants)) {
      rawVariants.forEach((value, index) => {
        if (typeof value !== "string" || !value.trim()) {
          issues.push(`variants[${index}] must be a non-empty string`)
          return
        }
        const variant = value.trim()
        if (variant.length > FAQ_LIMITS.maxVariantChars) {
          issues.push(`variants[${index}] must be at most ${FAQ_LIMITS.maxVariantChars} characters`)
          return
        }
        if (!variants.includes(variant)) variants.push(variant)
      })
    }

    let source: FaqSource | null = null
    if (input.source !== undefined && input.source !== null) {
      if (typeof input.source !== "object" || Array.isArray(input.source)) {
        issues.push("source must be an object with title/uri")
      } else {
        const raw = input.source as Record<string, unknown>
        const title = typeof raw.title === "string" ? raw.title.trim() : ""
        const uri = typeof raw.uri === "string" ? raw.uri.trim() : ""
        if (!title) issues.push("source.title is required when source is provided")
        if (title.length > FAQ_LIMITS.maxSourceTitleChars) {
          issues.push(`source.title must be at most ${FAQ_LIMITS.maxSourceTitleChars} characters`)
        }
        if (uri.length > FAQ_LIMITS.maxSourceUriChars) {
          issues.push(`source.uri must be at most ${FAQ_LIMITS.maxSourceUriChars} characters`)
        }
        if (title) source = { title, uri: uri || null }
      }
    }

    if (issues.length > 0) throw new InvalidFaqCommandError(issues)
    return {
      question,
      normalizedQuestion: normalizeFaqQuestion(question),
      variants,
      normalizedVariants: variants.map(normalizeFaqQuestion),
      answer,
      source,
    }
  }

  /**
   * The single conflict rule: an ACTIVE entry already answering this normalized
   * question — as its question or as one of its variants — blocks this draft.
   * `excludeEntryId` keeps an entry from conflicting with itself.
   */
  private findConflict(
    tenantId: string,
    knowledgeBaseId: string,
    draft: FaqDraft,
    excludeEntryId: string | null
  ): { entryId: string; viaVariant: boolean; question: string } | null {
    const rows = this.repo.listActiveIdentities(tenantId, [knowledgeBaseId])
    for (const row of rows) {
      if (row.entryId === excludeEntryId) continue
      if (row.normalizedQuestion === draft.normalizedQuestion) {
        return { entryId: row.entryId, viaVariant: false, question: row.question }
      }
      if (row.variants.some((variant) => normalizeFaqQuestion(variant) === draft.normalizedQuestion)) {
        return { entryId: row.entryId, viaVariant: true, question: row.question }
      }
      for (const variant of draft.normalizedVariants) {
        if (row.normalizedQuestion === variant) {
          return { entryId: row.entryId, viaVariant: false, question: row.question }
        }
        const viaVariant = row.variants.find(
          (candidate) => normalizeFaqQuestion(candidate) === variant
        )
        if (viaVariant) {
          return { entryId: row.entryId, viaVariant: true, question: row.question }
        }
      }
    }
    return null
  }

  private conflictMessage(
    draft: FaqDraft,
    conflict: { entryId: string; viaVariant: boolean; question: string }
  ): string {
    return `"${draft.question}" conflicts with active entry ${conflict.entryId} ("${conflict.question}"${conflict.viaVariant ? ", matched via variant" : ""})`
  }

  private conflictError(
    draft: FaqDraft,
    conflict: { entryId: string; viaVariant: boolean; question: string }
  ): FaqConflictError {
    return new FaqConflictError(this.conflictMessage(draft, conflict), {
      question: draft.question,
      normalizedQuestion: draft.normalizedQuestion,
      conflictingEntryId: conflict.entryId,
      viaVariant: conflict.viaVariant,
    })
  }
}

function toVersion(
  draft: FaqDraft,
  version: number,
  actor: string,
  createdAt: string
): FaqEntryVersion {
  return {
    version,
    question: draft.question,
    normalizedQuestion: draft.normalizedQuestion,
    variants: [...draft.variants],
    answer: draft.answer,
    source: draft.source,
    createdBy: actor,
    createdAt,
  }
}

function sameDraft(draft: FaqDraft, version: FaqEntryVersion): boolean {
  return (
    draft.question === version.question &&
    draft.answer === version.answer &&
    JSON.stringify(draft.variants) === JSON.stringify(version.variants) &&
    JSON.stringify(draft.source) === JSON.stringify(version.source)
  )
}

/** One parsed import row: the 1-based row number for messages + its fields. */
interface ParsedRow {
  rowNumber: number
  input: FaqCommandInput
}

function parseJsonRows(content: string): { rows: ParsedRow[]; issues: string[] } {
  const issues: string[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    return {
      rows: [],
      issues: [`the JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`],
    }
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries)
      ? ((parsed as { entries: unknown[] }).entries)
      : null
  if (!list) {
    return {
      rows: [],
      issues: ["JSON imports must be an array of entries or an object with an entries array"],
    }
  }
  const rows: ParsedRow[] = []
  list.forEach((item, index) => {
    // The row number matches what a user sees in the file: 1-based, offset by
    // nothing (a JSON array has no header row).
    const rowNumber = index + 1
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      issues.push(`row ${rowNumber}: each entry must be an object`)
      return
    }
    rows.push({ rowNumber, input: item as FaqCommandInput })
  })
  return { rows, issues }
}

/** CSV columns: question, answer (required) + variants, source_title, source_uri. */
function parseCsvRows(content: string): { rows: ParsedRow[]; issues: string[] } {
  const table = parseCsvTable(content)
  const issues = [...table.issues]
  if (table.header.length === 0) return { rows: [], issues }
  const column = (name: string) => table.header.indexOf(name)
  const questionAt = column("question")
  const answerAt = column("answer")
  if (questionAt < 0 || answerAt < 0) {
    issues.push(`the CSV header must include "question" and "answer" (saw: ${table.header.join(", ")})`)
    return { rows: [], issues }
  }
  const variantsAt = column("variants")
  const titleAt = column("source_title")
  const uriAt = column("source_uri")
  const rows: ParsedRow[] = []
  table.rows.forEach((row, index) => {
    // The parser reports the record position a row occupies, so a quoted field
    // spanning lines stays one row and blank lines cost their own number
    // without ever becoming one.
    const rowNumber = table.rowLines[index] ?? index + 2
    const question = row[questionAt] ?? ""
    const answer = row[answerAt] ?? ""
    if (!question.trim() && !answer.trim()) return // a blank line is not a row
    const variantsRaw = variantsAt >= 0 ? (row[variantsAt] ?? "") : ""
    const title = titleAt >= 0 ? (row[titleAt] ?? "").trim() : ""
    const uri = uriAt >= 0 ? (row[uriAt] ?? "").trim() : ""
    rows.push({
      rowNumber,
      input: {
        question,
        answer,
        variants: variantsRaw
          ? variantsRaw.split("|").map((value) => value.trim()).filter(Boolean)
          : [],
        ...(title ? { source: { title, uri } } : {}),
      },
    })
  })
  return { rows, issues }
}
