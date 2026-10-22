/**
 * Ticket 46 (DEMO-02B) + DR-03 — the 20-case quality gate.
 *
 * Drives the RUNNING local demo (DEMO_OIDC=1) through the versioned case
 * file `golden/demo-release-cases.v2.json` over the real chat entry, then
 * decides pass/fail ONLY by the prewritten v2 rules:
 *
 *   - answer cases: every answer point must appear (NFKC + lowercase +
 *     whitespace-collapsed), the reply must carry at least one exactly
 *     parseable inline `[cite:<id>]` that resolves to a returned reference,
 *     no reviewed prohibited assertion may appear, and forbidden reference
 *     content must not appear in the references;
 *   - refuse cases: the run must end in an honest refusal or coverage-gap
 *     admission (marker or insufficient_retrieval/insufficient_evidence).
 *     `clarification_required` alone is NOT a refusal: a generic
 *     clarification must not pass a clear question with a non-empty scope
 *     (hard-05). An explicit empty scope additionally forbids any returned
 *     reference or inline citation - no knowledge context at all (hard-03);
 *   - memory-not-cited: the done event's references never contain the
 *     memory content. The reply may repeat the memory (the owner viewing
 *     their own memory is allowed) and no citation is required.
 *
 * HARD cases (isolation/refusal) must ALL pass; at least 10 of the other 14
 * and at least 16 overall. BLEU/ROUGE and the retrieval metrics are NOT
 * consulted — they stay diagnostic.
 *
 * The v1 source stays on disk untouched; reports produced against v1 are
 * not comparable with v2 pass rates.
 *
 * Usage:
 *   npm run release:quality-gate                 # writes release-quality-results.json
 *
 * Exit codes: 0 gate passed, 1 gate failed / run error, 2 invalid usage.
 */

import "dotenv/config"
import { readFileSync, writeFileSync } from "node:fs"

export type GateKind = "answer" | "refuse" | "memory-not-cited"

export interface MemoryConstraints {
  citationRule: string
  viewingRule: string
}

export interface GateCase {
  id: string
  hard: boolean
  kind: GateKind
  message: string
  /** Missing → server default scope; [] → explicitly no knowledge context. */
  knowledgeBaseIds?: string[]
  answerPoints?: string[]
  prohibitedAssertions?: string[]
  forbiddenReferenceContent?: string
  memoryConstraints?: MemoryConstraints
  reason?: string
}

export interface GateRules {
  hardMustPass: string
  othersMinPass: number
  overallMinPass: number
}

export interface GateDataset {
  schema: string
  version: number
  contract?: {
    kindRules: Record<GateKind, string>
    prohibitedAssertionsPolicy: string
    memoryConstraints?: MemoryConstraints
  }
  rules: GateRules
  cases: GateCase[]
}

export interface CaseResult {
  id: string
  hard: boolean
  kind: string
  pass: boolean
  terminalStatus: string | null
  replyExcerpt: string
  referenceCount: number
  missingAnswerPoints?: string[]
  detail: string
}

export interface DoneEvent {
  status?: string
  reply?: string
  references?: Array<{
    id?: string
    content?: string
    excerpt?: string
    title?: string
    origin?: string
    docId?: string
  }>
  memoryUsed?: { ids?: string[]; count?: number }
}

/** The exact normalization shared with tests/evals/contracts.py. */
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
}

/** Substring containment over normalized text. Not a semantic proof. */
export function containsNormalized(haystack: string, needle: string): boolean {
  return normalize(haystack).includes(normalize(needle))
}

export const REFUSAL_MARKERS = [
  "未找到相关证据",
  "无法生成可靠回答",
  "无法回答",
  "无法作答",
  "证据不足",
  "未能找到",
  "根据现有知识库",
] as const

/**
 * Reviewed clarification-only expressions. They are not refusals: for a
 * clear question with a non-empty scope the corpus, not the user's input,
 * is the gap (hard-05).
 */
export const CLARIFICATION_MARKERS = [
  "请提供更多",
  "请补充",
  "请说明",
  "请明确",
  "能否提供",
  "需要更多信息",
  "需要进一步信息",
  "请问您想",
] as const

const GAP_STATUSES = new Set([
  "insufficient_retrieval",
  "insufficient_evidence",
  "rejected",
])

const NON_ANSWER_STATUSES = new Set([
  "clarification_required",
  "insufficient_retrieval",
  "insufficient_evidence",
  "invalid_citation",
  "provider_error",
  "cancelled",
  "handoff_required",
  "rejected",
])

export interface InlineCitationCheck {
  present: boolean
  ids: string[]
  malformed: string[]
  unresolved: string[]
}

/**
 * Parse every inline `[cite:<id>]` occurrence. A citation is exactly
 * parseable only when the token is `[cite:` + non-empty id without brackets
 * or whitespace + `]`; every id must resolve to a returned reference id.
 */
export function inspectInlineCitations(
  reply: string,
  references: DoneEvent["references"] | undefined
): InlineCitationCheck {
  const exact = /\[cite:([^\[\]\s]+)\]/g
  const ids: string[] = []
  let exactCount = 0
  for (const match of reply.matchAll(exact)) {
    exactCount += 1
    ids.push(match[1])
  }
  const markerCount = (reply.match(/\[cite:/g) ?? []).length
  const malformed: string[] = []
  if (markerCount !== exactCount) {
    for (const match of reply.matchAll(/\[cite:[^\]]*\]?/g)) {
      if (!/^\[cite:[^\[\]\s]+\]$/.test(match[0])) malformed.push(match[0])
    }
    if (malformed.length === 0) malformed.push("[cite:...]")
  }
  const referenceIds = new Set(
    (references ?? [])
      .map((reference) => reference.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
  )
  const unresolved = [...new Set(ids.filter((id) => !referenceIds.has(id)))]
  return {
    present: ids.length > 0,
    ids,
    malformed,
    unresolved,
  }
}

function referenceText(
  reference: NonNullable<DoneEvent["references"]>[number]
): string {
  return [reference.content, reference.excerpt, reference.title]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
}

function statusOf(done: DoneEvent | null): string {
  return (done?.status ?? "").toLowerCase()
}

function baseResult(
  cs: GateCase,
  done: DoneEvent | null,
  error: string | null
): CaseResult {
  return {
    id: cs.id,
    hard: cs.hard,
    kind: cs.kind,
    pass: false,
    terminalStatus: done?.status ?? null,
    replyExcerpt: (done?.reply ?? "").slice(0, 160),
    referenceCount: done?.references?.length ?? 0,
    detail: error ? `run error: ${error}` : "",
  }
}

function judgeAnswer(cs: GateCase, done: DoneEvent): CaseResult {
  const base = baseResult(cs, done, null)
  const basePoints = cs.answerPoints ?? []
  if (basePoints.length === 0) {
    return {
      ...base,
      detail:
        "FAIL: invalid case - an answer case requires non-empty answerPoints (an empty set cannot pass)",
    }
  }

  const status = statusOf(done)
  const reply = done.reply ?? ""
  const missing = basePoints
    .map((point) => normalize(point))
    .filter((point) => !normalize(reply).includes(point))
  const citations = inspectInlineCitations(reply, done.references)
  const prohibited = (cs.prohibitedAssertions ?? []).filter((assertion) =>
    containsNormalized(reply, assertion)
  )
  const forbiddenReference =
    cs.forbiddenReferenceContent !== undefined &&
    (done.references ?? []).some((reference) =>
      containsNormalized(
        referenceText(reference),
        cs.forbiddenReferenceContent as string
      )
    )
  const nonAnswerStatus = NON_ANSWER_STATUSES.has(status)

  const failures: string[] = []
  if (nonAnswerStatus) {
    failures.push(`expected an answer, got terminal status ${status}`)
  }
  if (missing.length > 0) {
    failures.push(`missing answer points: ${missing.join(" | ")}`)
  }
  if (!citations.present && citations.malformed.length === 0) {
    failures.push("no inline [cite:<id>] in the reply")
  }
  if (citations.malformed.length > 0) {
    failures.push(
      `malformed inline citation(s): ${citations.malformed.join(" | ")}`
    )
  }
  if (citations.unresolved.length > 0) {
    failures.push(
      `inline citation id(s) not in the returned references: ${citations.unresolved.join(" | ")}`
    )
  }
  if (prohibited.length > 0) {
    failures.push(`prohibited assertion(s) present: ${prohibited.join(" | ")}`)
  }
  if (forbiddenReference) {
    failures.push("forbidden reference content appeared in the references")
  }

  return {
    ...base,
    pass: failures.length === 0,
    missingAnswerPoints: missing.length > 0 ? missing : undefined,
    detail:
      failures.length === 0
        ? `all answer points present; ${citations.ids.length} inline citation(s) resolved`
        : `FAIL: ${failures.join("; ")}`,
  }
}

function judgeRefuse(cs: GateCase, done: DoneEvent): CaseResult {
  const base = baseResult(cs, done, null)
  const status = statusOf(done)
  const reply = done.reply ?? ""
  const normalizedReply = normalize(reply)
  const referenceCount = done.references?.length ?? 0

  const gapMarker = REFUSAL_MARKERS.some((marker) =>
    normalizedReply.includes(normalize(marker))
  )
  const gapStatus = GAP_STATUSES.has(status)
  const clarificationMarker = CLARIFICATION_MARKERS.some((marker) =>
    normalizedReply.includes(normalize(marker))
  )
  // "Generic clarification-only" never satisfies a clear, answerable case:
  // the gap is in the corpus, not in the user's input.
  const clarificationOnly =
    status === "clarification_required" ||
    (clarificationMarker && !gapMarker)

  const emptyScope = cs.knowledgeBaseIds !== undefined && cs.knowledgeBaseIds.length === 0
  const scopeViolation = emptyScope
    ? referenceCount > 0 || /\[cite:/.test(reply)
    : false

  const refused = (gapMarker || gapStatus) && !clarificationOnly
  const pass = refused && !scopeViolation && reply.length < 1200

  const failures: string[] = []
  if (clarificationOnly) {
    failures.push(
      "generic clarification-only reply does not satisfy a clear, answerable refusal case"
    )
  }
  if (!gapMarker && !gapStatus) {
    failures.push(
      `expected an honest refusal or coverage-gap admission, got status ${status || "none"}`
    )
  }
  if (scopeViolation) {
    failures.push(
      "explicit empty scope must not return references or inline citations"
    )
  }
  if (reply.length >= 1200) {
    failures.push("refusal reply is too long to be an honest refusal")
  }

  return {
    ...base,
    pass,
    detail:
      pass
        ? emptyScope
          ? "honest coverage-gap refusal observed with no knowledge context"
          : "honest refusal observed"
        : `FAIL: ${failures.join("; ")}`,
  }
}

function judgeMemory(cs: GateCase, done: DoneEvent): CaseResult {
  const base = baseResult(cs, done, null)
  const forbidden = cs.forbiddenReferenceContent?.trim() ?? ""
  if (forbidden.length === 0) {
    return {
      ...base,
      detail:
        "FAIL: invalid case - memory-not-cited requires forbiddenReferenceContent",
    }
  }
  const cited = (done.references ?? []).some((reference) =>
    containsNormalized(referenceText(reference), forbidden)
  )
  return {
    ...base,
    pass: !cited,
    detail: cited
      ? "FAIL: the long-term memory content appeared in the references"
      : "memory content is absent from the references (it may inform the prompt, never a citation)",
  }
}

/** Judge one case from its v2 standard and the observed chat result. */
export function judgeCase(
  cs: GateCase,
  done: DoneEvent | null,
  error: string | null
): CaseResult {
  if (error || !done) {
    return baseResult(cs, done, error ?? "no done event")
  }
  if (cs.kind === "answer") return judgeAnswer(cs, done)
  if (cs.kind === "refuse") return judgeRefuse(cs, done)
  if (cs.kind === "memory-not-cited") return judgeMemory(cs, done)
  return {
    ...baseResult(cs, done, null),
    detail: `FAIL: unknown case kind ${String(cs.kind)}`,
  }
}

async function login(baseUrl: string): Promise<string> {
  const password = process.env.ADMIN_LOGIN_PASSWORD || process.env.DEMO_OIDC_PASSWORD
  if (!password) throw new Error("ADMIN_LOGIN_PASSWORD or DEMO_OIDC_PASSWORD must be set for the gate")
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: process.env.ADMIN_LOGIN_ID || "admin", password }),
  })
  if (!response.ok) throw new Error(`login failed: HTTP ${response.status}`)
  const body = (await response.json()) as { accessToken: string }
  return body.accessToken
}

/** Send one chat turn and resolve the SSE stream's terminal done event. */
async function runCase(
  baseUrl: string,
  token: string,
  cs: GateCase
): Promise<{ done: DoneEvent | null; error: string | null }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 90_000)
  try {
    const body: Record<string, unknown> = {
      message: cs.message,
      sessionId: `gate-${cs.id}`.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 100),
    }
    // A missing scope means the server default; an explicit [] means no
    // knowledge context at all. The two must not collapse into one.
    if (cs.knowledgeBaseIds !== undefined) {
      body.knowledgeBaseIds = cs.knowledgeBaseIds
    }
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok || !response.body) {
      return { done: null, error: `chat failed: HTTP ${response.status}` }
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let done: DoneEvent | null = null
    for (;;) {
      const { value, done: streamDone } = await reader.read()
      if (streamDone) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.startsWith("data:")) continue
        try {
          // The transport nests the run event: data: {sessionId, runId, event:{type, result}}.
          const payload = JSON.parse(line.slice(5).trim()) as {
            event?: { type?: string; result?: DoneEvent }
          }
          if (payload.event?.type === "done" && payload.event.result) {
            done = {
              status: payload.event.result.status,
              reply: payload.event.result.reply,
              references: payload.event.result.references,
              memoryUsed: payload.event.result.memoryUsed,
            }
          }
        } catch {
          // partial frame — the next chunk completes it
        }
      }
    }
    return { done, error: done ? null : "the stream ended without a done event" }
  } catch (error) {
    return {
      done: null,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}

const GATE_KINDS: GateKind[] = ["answer", "refuse", "memory-not-cited"]

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => isNonEmptyString(entry))
  )
}

function validateCases(cases: unknown): asserts cases is GateCase[] {
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error("the gate dataset requires a non-empty cases array")
  }
  const ids = new Set<string>()
  for (const [index, candidate] of cases.entries()) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`cases[${index}] must be an object`)
    }
    const cs = candidate as Partial<GateCase>
    if (!isNonEmptyString(cs.id)) {
      throw new Error(`cases[${index}].id must be a non-empty string`)
    }
    if (ids.has(cs.id)) {
      throw new Error(`duplicate case id: ${cs.id}`)
    }
    ids.add(cs.id)
    if (!GATE_KINDS.includes(cs.kind as GateKind)) {
      throw new Error(`${cs.id}: unknown kind ${String(cs.kind)}`)
    }
    if (typeof cs.hard !== "boolean") {
      throw new Error(`${cs.id}: hard must be a boolean`)
    }
    if (!isNonEmptyString(cs.message)) {
      throw new Error(`${cs.id}: message must be a non-empty string`)
    }
    if (
      cs.knowledgeBaseIds !== undefined &&
      (!Array.isArray(cs.knowledgeBaseIds) ||
        cs.knowledgeBaseIds.some((entry) => !isNonEmptyString(entry)))
    ) {
      throw new Error(
        `${cs.id}: knowledgeBaseIds must be an array of non-empty strings`
      )
    }
    if (
      cs.answerPoints !== undefined &&
      !isStringArray(cs.answerPoints)
    ) {
      throw new Error(`${cs.id}: answerPoints must be an array of non-empty strings`)
    }
    if (
      cs.prohibitedAssertions !== undefined &&
      !isStringArray(cs.prohibitedAssertions)
    ) {
      throw new Error(
        `${cs.id}: prohibitedAssertions must be an array of non-empty strings`
      )
    }
    if (
      cs.forbiddenReferenceContent !== undefined &&
      !isNonEmptyString(cs.forbiddenReferenceContent)
    ) {
      throw new Error(
        `${cs.id}: forbiddenReferenceContent must be a non-empty string`
      )
    }
    if (
      cs.kind === "answer" &&
      (!isStringArray(cs.answerPoints) || cs.answerPoints.length === 0)
    ) {
      throw new Error(`${cs.id}: answer case requires non-empty answerPoints`)
    }
    if (cs.kind === "memory-not-cited" && !isNonEmptyString(cs.forbiddenReferenceContent)) {
      throw new Error(
        `${cs.id}: memory-not-cited case requires forbiddenReferenceContent`
      )
    }
  }
}

/** Load and minimally fail-closed validate the v2 case file. */
export function loadDataset(path = "golden/demo-release-cases.v2.json"): GateDataset {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("the gate dataset must be a JSON object")
  }
  const dataset = raw as Partial<GateDataset>
  if (dataset.version !== 2) {
    throw new Error(
      `the gate consumes the v2 standard; found version ${String(dataset.version)}`
    )
  }
  if (
    !dataset.rules ||
    typeof dataset.rules.othersMinPass !== "number" ||
    typeof dataset.rules.overallMinPass !== "number"
  ) {
    throw new Error("the gate dataset requires rules.othersMinPass/overallMinPass")
  }
  validateCases(dataset.cases)
  return dataset as GateDataset
}

export interface GateSummary {
  hardPassed: number
  hardTotal: number
  othersPassed: number
  othersTotal: number
  overallPassed: number
  overallTotal: number
  gate: "passed" | "failed"
}

/**
 * The unchanged release thresholds: every hard case, at least 10 of the 14
 * others and at least 16 of 20 overall. A relaxed rule would change this
 * function, never the outcome of an individual case.
 */
export function summarizeResults(
  results: CaseResult[],
  rules: GateRules
): { passed: boolean; summary: GateSummary } {
  const hard = results.filter((result) => result.hard)
  const others = results.filter((result) => !result.hard)
  const hardPassed = hard.filter((result) => result.pass).length
  const othersPassed = others.filter((result) => result.pass).length
  const overallPassed = results.filter((result) => result.pass).length
  const passed =
    hardPassed === hard.length &&
    othersPassed >= rules.othersMinPass &&
    overallPassed >= rules.overallMinPass
  return {
    passed,
    summary: {
      hardPassed,
      hardTotal: hard.length,
      othersPassed,
      othersTotal: others.length,
      overallPassed,
      overallTotal: results.length,
      gate: passed ? "passed" : "failed",
    },
  }
}

export interface ResultsReport {
  schema: "release-quality-results"
  datasetVersion: number
  checkedAt: string
  rules: GateRules
  summary: GateSummary
  results: CaseResult[]
}

/** Assemble the unchanged release-quality-results report shape. */
export function buildReport(
  dataset: GateDataset,
  results: CaseResult[],
  checkedAt = new Date().toISOString()
): ResultsReport {
  return {
    schema: "release-quality-results",
    datasetVersion: dataset.version,
    checkedAt,
    rules: dataset.rules,
    summary: summarizeResults(results, dataset.rules).summary,
    results,
  }
}

export async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.length > 0) {
    console.error("usage: npm run release:quality-gate")
    return 2
  }
  const baseUrl = process.env.GATE_BASE_URL ?? "http://localhost:3001"
  const dataset = loadDataset()

  console.log(
    `release quality gate: ${dataset.cases.length} cases (dataset v${dataset.version})`
  )
  const token = await login(baseUrl)

  const results: CaseResult[] = []
  for (const [index, cs] of dataset.cases.entries()) {
    const { done: doneEvent, error } = await runCase(baseUrl, token, cs)
    const result = judgeCase(cs, doneEvent, error)
    results.push(result)
    console.log(
      `  [${index + 1}/${dataset.cases.length}] ${result.pass ? "PASS" : "FAIL"} ${cs.id}${cs.hard ? " (HARD)" : ""} — ${result.detail}`
    )
  }

  const report = buildReport(dataset, results)
  const passed = report.summary.gate === "passed"
  writeFileSync("release-quality-results.json", JSON.stringify(report, null, 2))
  console.log(
    `hard ${report.summary.hardPassed}/${report.summary.hardTotal} · others ${report.summary.othersPassed}/${report.summary.othersTotal} · overall ${report.summary.overallPassed}/${report.summary.overallTotal} → gate ${passed ? "PASSED" : "FAILED"}`
  )
  console.log("results written to release-quality-results.json")
  return passed ? 0 : 1
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      console.error(
        "[release-quality-gate] failed:",
        error instanceof Error ? error.message : String(error)
      )
      process.exitCode = 1
    })
}
