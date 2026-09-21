/**
 * Eval refactor Ticket 04 — versioned evaluation dataset contract.
 *
 * One dataset carries the FULL corpus (relevant passages AND distractors) plus
 * the cases that reference it. Server-side validation is authoritative: the
 * HTTP layer never lets an invalid dataset reach a paid model or index call
 * (ticket 05 acceptance), and every issue is reported per field/case so the
 * page can point at the offending entry.
 *
 * Ground truth (referenceAnswer / relevantPassageIds) is ONLY an input to the
 * scorer — it is never handed to the answering agents (spec "参考答案与相关
 * 证据标注只交给评分器，不进入问答上下文").
 */

import { createHash } from "node:crypto"

export const EVAL_DATASET_SCHEMA_VERSION = 1

export interface EvalDatasetPassage {
  passageId: string
  title?: string
  content: string
}

export interface EvalDatasetCase {
  caseId: string
  question: string
  referenceAnswer: string
  relevantPassageIds: string[]
  tags?: string[]
}

export interface EvalDataset {
  schemaVersion: number
  name: string
  version: string
  corpus: EvalDatasetPassage[]
  cases: EvalDatasetCase[]
}

/**
 * Size limits — a bounded-but-generous envelope. They are service constants,
 * not page settings (spec: "上限属于服务配置，不扩展成页面调参平台").
 */
export const EVAL_DATASET_LIMITS = {
  maxPassages: 200,
  maxCases: 100,
  maxPassageChars: 20_000,
  maxQuestionChars: 2_000,
  maxReferenceAnswerChars: 8_000,
  maxNameChars: 120,
  maxVersionChars: 64,
  maxRelevantPassagesPerCase: 50,
} as const

/**
 * Dataset rejection with every issue found (not just the first), so the page
 * can render field- and case-level messages before any provider call.
 */
export class EvalDatasetValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid evaluation dataset: ${issues.join("; ")}`)
    this.name = "EvalDatasetValidationError"
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/**
 * Validate an untrusted dataset payload. Returns the normalized dataset (only
 * the contract fields — unknown fields are dropped) or throws
 * {@link EvalDatasetValidationError} listing all issues.
 */
export function validateEvalDataset(input: unknown): EvalDataset {
  const issues: string[] = []
  const root = asRecord(input)
  if (!root) {
    throw new EvalDatasetValidationError(["dataset must be a JSON object"])
  }

  const schemaVersion = root.schemaVersion
  if (schemaVersion !== EVAL_DATASET_SCHEMA_VERSION) {
    issues.push(
      `schemaVersion must be ${EVAL_DATASET_SCHEMA_VERSION} (got ${JSON.stringify(schemaVersion)})`
    )
  }

  const name = root.name
  if (!isNonEmptyString(name)) issues.push("name must be a non-empty string")
  else if (name.length > EVAL_DATASET_LIMITS.maxNameChars) {
    issues.push(`name must be at most ${EVAL_DATASET_LIMITS.maxNameChars} characters`)
  }

  const version = root.version
  if (!isNonEmptyString(version)) issues.push("version must be a non-empty string")
  else if (version.length > EVAL_DATASET_LIMITS.maxVersionChars) {
    issues.push(`version must be at most ${EVAL_DATASET_LIMITS.maxVersionChars} characters`)
  }

  const passages = normalizeCorpus(root.corpus, issues)
  const cases = normalizeCases(root.cases, passages.byId, issues)

  if (issues.length > 0) throw new EvalDatasetValidationError(issues)

  return {
    schemaVersion: EVAL_DATASET_SCHEMA_VERSION,
    name: (name as string).trim(),
    version: (version as string).trim(),
    corpus: passages.list,
    cases,
  }
}

function normalizeCorpus(
  raw: unknown,
  issues: string[]
): { list: EvalDatasetPassage[]; byId: Set<string> } {
  const byId = new Set<string>()
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push("corpus must be a non-empty array of passages")
    return { list: [], byId }
  }
  if (raw.length > EVAL_DATASET_LIMITS.maxPassages) {
    issues.push(`corpus must contain at most ${EVAL_DATASET_LIMITS.maxPassages} passages`)
    return { list: [], byId }
  }
  const list: EvalDatasetPassage[] = []
  raw.forEach((entry, index) => {
    const passage = asRecord(entry)
    if (!passage) {
      issues.push(`corpus[${index}] must be an object`)
      return
    }
    const passageId = passage.passageId
    if (!isNonEmptyString(passageId)) {
      issues.push(`corpus[${index}].passageId must be a non-empty string`)
      return
    }
    if (byId.has(passageId)) {
      issues.push(`corpus[${index}].passageId duplicates an earlier id: ${passageId}`)
      return
    }
    const content = passage.content
    if (!isNonEmptyString(content)) {
      issues.push(`corpus[${index}].content must be a non-empty string`)
      return
    }
    if (content.length > EVAL_DATASET_LIMITS.maxPassageChars) {
      issues.push(
        `corpus[${index}].content must be at most ${EVAL_DATASET_LIMITS.maxPassageChars} characters`
      )
      return
    }
    const title = passage.title
    if (title !== undefined && typeof title !== "string") {
      issues.push(`corpus[${index}].title must be a string when present`)
      return
    }
    byId.add(passageId)
    list.push({
      passageId,
      content,
      ...(typeof title === "string" && title.trim() ? { title: title.trim() } : {}),
    })
  })
  return { list, byId }
}

function normalizeCases(
  raw: unknown,
  knownPassageIds: Set<string>,
  issues: string[]
): EvalDatasetCase[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push("cases must be a non-empty array of cases")
    return []
  }
  if (raw.length > EVAL_DATASET_LIMITS.maxCases) {
    issues.push(`cases must contain at most ${EVAL_DATASET_LIMITS.maxCases} cases`)
    return []
  }
  const seen = new Set<string>()
  const list: EvalDatasetCase[] = []
  raw.forEach((entry, index) => {
    const item = asRecord(entry)
    if (!item) {
      issues.push(`cases[${index}] must be an object`)
      return
    }
    const caseId = item.caseId
    if (!isNonEmptyString(caseId)) {
      issues.push(`cases[${index}].caseId must be a non-empty string`)
      return
    }
    if (seen.has(caseId)) {
      issues.push(`cases[${index}].caseId duplicates an earlier id: ${caseId}`)
      return
    }
    const question = item.question
    if (!isNonEmptyString(question)) {
      issues.push(`cases[${index}].question must be a non-empty string`)
      return
    }
    if (question.length > EVAL_DATASET_LIMITS.maxQuestionChars) {
      issues.push(
        `cases[${index}].question must be at most ${EVAL_DATASET_LIMITS.maxQuestionChars} characters`
      )
      return
    }
    const referenceAnswer = item.referenceAnswer
    if (!isNonEmptyString(referenceAnswer)) {
      issues.push(`cases[${index}].referenceAnswer must be a non-empty string`)
      return
    }
    if (referenceAnswer.length > EVAL_DATASET_LIMITS.maxReferenceAnswerChars) {
      issues.push(
        `cases[${index}].referenceAnswer must be at most ${EVAL_DATASET_LIMITS.maxReferenceAnswerChars} characters`
      )
      return
    }
    const rawRelevant = item.relevantPassageIds
    if (!Array.isArray(rawRelevant) || rawRelevant.length === 0) {
      issues.push(`cases[${index}].relevantPassageIds must be a non-empty array`)
      return
    }
    if (rawRelevant.length > EVAL_DATASET_LIMITS.maxRelevantPassagesPerCase) {
      issues.push(
        `cases[${index}].relevantPassageIds must contain at most ${EVAL_DATASET_LIMITS.maxRelevantPassagesPerCase} ids`
      )
      return
    }
    const relevantPassageIds: string[] = []
    let caseIssues = 0
    rawRelevant.forEach((value, position) => {
      if (!isNonEmptyString(value)) {
        issues.push(`cases[${index}].relevantPassageIds[${position}] must be a non-empty string`)
        caseIssues += 1
        return
      }
      if (!knownPassageIds.has(value)) {
        issues.push(
          `cases[${index}].relevantPassageIds[${position}] references unknown passageId: ${value}`
        )
        caseIssues += 1
        return
      }
      if (relevantPassageIds.includes(value)) {
        issues.push(
          `cases[${index}].relevantPassageIds[${position}] duplicates an earlier id: ${value}`
        )
        caseIssues += 1
        return
      }
      relevantPassageIds.push(value)
    })
    if (caseIssues > 0) return
    const rawTags = item.tags
    if (rawTags !== undefined && (!Array.isArray(rawTags) || rawTags.some((t) => typeof t !== "string"))) {
      issues.push(`cases[${index}].tags must be an array of strings when present`)
      return
    }
    seen.add(caseId)
    list.push({
      caseId,
      question,
      referenceAnswer,
      relevantPassageIds,
      ...(Array.isArray(rawTags) && rawTags.length > 0 ? { tags: rawTags as string[] } : {}),
    })
  })
  return list
}

/**
 * Content digest: distinguishes same-name/version datasets with different
 * content (spec "运行时生成内容摘要用于区分同版本不同内容"). Stable across
 * key order — the canonical form is built from the normalized contract.
 */
export function evalDatasetDigest(dataset: EvalDataset): string {
  const canonical = JSON.stringify({
    schemaVersion: dataset.schemaVersion,
    name: dataset.name,
    version: dataset.version,
    corpus: dataset.corpus.map((passage) => [
      passage.passageId,
      passage.title ?? "",
      passage.content,
    ]),
    cases: dataset.cases.map((item) => [
      item.caseId,
      item.question,
      item.referenceAnswer,
      item.relevantPassageIds,
    ]),
  })
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}
