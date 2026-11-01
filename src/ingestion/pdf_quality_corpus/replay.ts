/**
 * Ticket 02：Clef / OCR 响应的确定性回放。
 *
 * 场景是 `golden/pdf-quality-corpus/replay/*.json` 里的纯本地脚本：没有网络、
 * 没有真实计时器、没有随机数。时间由注入的虚拟时钟推进，因此"两次运行完全一致"
 * 是可断言的性质。答案可以逐字写在脚本里，也可以声明 `answersSource.kind =
 * "corpus-expectations"`，由语料的逐页独立标注派生——后者保证回放绑定页面真值。
 *
 * 结果约定（供后续票使用）：
 * - `answered` / `answered-from-durable-evidence`：返回页面裁决；复用路径 0 次远程调用。
 * - `malformed` / `invalid` / `timeout` / `service-error`：结构化返回，便于把协议失败、
 *   语义质量失败与服务故障区分开。
 * - 取消：抛出 `DOMException(name = "AbortError")`，与真实 fetch 的取消行为一致。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import {
  PDF_QUALITY_CORPUS_ROOT,
  PDF_QUALITY_DIMENSIONS,
  PDF_QUALITY_ISSUE_LABELS,
  PDF_QUALITY_VERDICTS,
  loadPdfQualityCorpus,
  pdfQualityFixture,
  type DimensionAssessment,
  type PdfQualityDimension,
  type PdfQualityIssueLabel,
  type PdfQualityVerdict,
} from "./corpus"

const REPLAY_DIR = join(PDF_QUALITY_CORPUS_ROOT, "replay")

/** 票面要求必须能回放的场景种类。 */
export const REQUIRED_REPLAY_CASE_KINDS = [
  "pass",
  "fail",
  "uncertain",
  "malformed",
  "timeout",
  "cancellation",
  "recovery",
] as const

/** 语料实际使用的场景种类（票面 7 类 + 服务故障族）。 */
export const REPLAY_CASE_KINDS = [...REQUIRED_REPLAY_CASE_KINDS, "service-fault"] as const

export type ReplayCaseKind = (typeof REPLAY_CASE_KINDS)[number]

export type ReplayAttemptOutcome =
  | "answered"
  | "answered-from-durable-evidence"
  | "malformed"
  | "invalid"
  | "timeout"
  | "service-error"
  | "cancelled"

export interface ReplayAnswerPage {
  page: number
  verdict?: string
  issueLabels?: string[]
  probability?: number
  confidence?: number
  text?: string
}

export interface ReplayAttempt {
  attempt: number
  outcome: ReplayAttemptOutcome
  latencyMs: number
  httpStatus?: number
  bodyRaw?: string
  invalidReason?: string
  reusedFromAttempt?: number
  pages?: ReplayAnswerPage[]
}

export interface ReplayScenario {
  schemaVersion: string
  scenarioId: string
  service: "clef" | "ocr"
  stage: "local-audit" | "ocr-audit" | "ocr-fallback"
  fixture: string
  caseKinds: ReplayCaseKind[]
  coversPages: number[]
  maxImagesPerRequest: number
  timeoutMs: number
  externalServiceDependency: string
  authoredFrom: string
  answersSource?: { kind: string; fixture?: string; stage?: string; defect?: string }
  attempts: ReplayAttempt[]
}

export interface ServedAnswerPage {
  page: number
  verdict: PdfQualityVerdict
  issueLabels: PdfQualityIssueLabel[]
  dimensions: Record<PdfQualityDimension, DimensionAssessment>
  probability: number
  confidence: number
}

export type ReplayClefOutcome =
  | { kind: "answered"; attempt: number; model: string; pages: ServedAnswerPage[]; usage: ReplayUsage; virtualMs: number; reusedDurableEvidence: false }
  | { kind: "answered-from-durable-evidence"; attempt: number; reusedFromAttempt: number; model: string; pages: ServedAnswerPage[]; usage: ReplayUsage; virtualMs: number; reusedDurableEvidence: true }
  | { kind: "malformed"; attempt: number; bodyRaw: string; httpStatus: number; virtualMs: number }
  | { kind: "invalid"; attempt: number; invalidReason: string; body: { pages: ReplayAnswerPage[] }; httpStatus: number; virtualMs: number }
  | { kind: "timeout"; attempt: number; timeoutMs: number; virtualMs: number }
  | { kind: "service-error"; attempt: number; httpStatus: number; virtualMs: number }

export interface ReplayUsage {
  inputTokens: number
  outputTokens: number
}

export type ReplayOcrOutcome =
  | { kind: "candidate"; attempt: number; requestId: string; pages: Array<{ page: number; text: string }>; virtualMs: number; reusedDurableEvidence: false }
  | { kind: "candidate-from-durable-evidence"; attempt: number; reusedFromAttempt: number; requestId: string; pages: Array<{ page: number; text: string }>; virtualMs: number; reusedDurableEvidence: true }
  | { kind: "malformed"; attempt: number; bodyRaw: string; httpStatus: number; virtualMs: number }
  | { kind: "timeout"; attempt: number; timeoutMs: number; virtualMs: number }
  | { kind: "service-error"; attempt: number; httpStatus: number; virtualMs: number }

export interface ReplayAuditRequestPage {
  page: number
  /** `undefined` 表示调用方没有给出该页文本证据；空串表示"该页确实没有文本层"。 */
  text?: string
  imageBase64?: string
  imageBytes?: Uint8Array
}

export interface ReplayAuditRequest {
  stage: string
  fixtureId: string
  candidateId?: string
  pages: ReplayAuditRequestPage[]
  signal?: AbortSignal
}

export interface ReplayOcrRequest {
  fixtureId: string
  pageCount: number
  pdfBytesBase64?: string
  signal?: AbortSignal
}

export type ReplayViolationCode =
  | "missing-page-image"
  | "missing-page-text"
  | "over-image-limit"
  | "metadata-only-request"

export interface ReplayContractViolation {
  code: ReplayViolationCode
  page: number | null
  detail: string
}

export interface ReplayLedgerEntry {
  attempt: number | null
  kind: string
  virtualMs: number
  requestedPages: number[]
}

export interface RecordedRequest {
  pages: number[]
  imagePresent: boolean[]
  textPresent: boolean[]
  candidateId?: string
}

export class ReplayRequestMismatchError extends Error {
  override readonly name = "ReplayRequestMismatchError"
}

export interface ReplayClock {
  now(): number
  advance(ms: number): number
}

/** 虚拟时钟：回放里所有"耗时"都通过它推进，所以两次运行完全一致。 */
export function createReplayVirtualClock(startMs = 0): ReplayClock {
  let current = startMs
  return {
    now: () => current,
    advance: (ms: number) => {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new TypeError(`replay latency must be a non-negative number, got ${ms}`)
      }
      current += ms
      return current
    },
  }
}

let scenarioCache: ReplayScenario[] | null = null

/** 回放脚本按服务分成若干分组文件，每个文件是 `{ schemaVersion, scenarios: [...] }`。 */
interface ReplayScenarioFile {
  schemaVersion: string
  scenarios: ReplayScenario[]
}

/** 按文件名升序载入全部回放场景（纯本地，无外部服务依赖）。 */
export function listReplayScenarios(): ReplayScenario[] {
  if (scenarioCache) return scenarioCache
  if (!existsSync(REPLAY_DIR)) {
    throw new Error(`pdf quality replay fixtures are missing: ${REPLAY_DIR}`)
  }
  const names = readdirSync(REPLAY_DIR).filter((name) => name.endsWith(".json")).sort()
  scenarioCache = names.flatMap((name) => {
    const parsed = JSON.parse(readFileSync(join(REPLAY_DIR, name), "utf8")) as ReplayScenarioFile
    if (!Array.isArray(parsed.scenarios)) {
      throw new Error(`replay fixture file ${name} does not carry a scenarios array`)
    }
    return parsed.scenarios
  })
  return scenarioCache
}

export function replayScenarioIds(service?: "clef" | "ocr"): string[] {
  return listReplayScenarios()
    .filter((scenario) => !service || scenario.service === service)
    .map((scenario) => scenario.scenarioId)
}

export function loadReplayScenario(scenarioId: string): ReplayScenario {
  const scenario = listReplayScenarios().find((entry) => entry.scenarioId === scenarioId)
  if (!scenario) {
    throw new Error(`unknown pdf quality replay scenario: ${scenarioId}`)
  }
  return scenario
}

/** 由闭集标签推导四维评估：任一标签在该维度 fail 即 fail，否则取最保守的 uncertain。 */
export function dimensionsForLabels(labels: readonly string[]): Record<PdfQualityDimension, DimensionAssessment> {
  const map = loadPdfQualityCorpus().manifest.labelDimensionMap
  const result = {} as Record<PdfQualityDimension, DimensionAssessment>
  for (const dimension of PDF_QUALITY_DIMENSIONS) {
    const perLabel = labels.map((label) => map[label]?.[dimension] as DimensionAssessment | undefined)
    if (perLabel.some((value) => value === undefined)) {
      throw new Error(`issue label has no dimension mapping: ${labels.join(",")}`)
    }
    result[dimension] = perLabel.includes("fail")
      ? "fail"
      : perLabel.includes("uncertain")
        ? "uncertain"
        : "pass"
  }
  return result
}

/**
 * 校验一份 Clef 回答是否满足逐页契约。返回 null 表示合法，否则返回第一个违规原因。
 * 判定顺序是固定的，因此同一份脚本永远得到同一个 invalidReason。
 */
export function answerSetViolationReason(
  scenario: ReplayScenario,
  requestedPages: readonly number[],
  answers: readonly ReplayAnswerPage[]
): string | null {
  const fixture = pdfQualityFixture(scenario.fixture)
  for (const answer of answers) {
    if (!Number.isInteger(answer.page) || answer.page < 1 || answer.page > fixture.pageCount) return "page-out-of-range"
    if (!requestedPages.includes(answer.page)) return "page-out-of-range"
  }
  const seen = new Set<number>()
  for (const answer of answers) {
    if (seen.has(answer.page)) return "duplicate-page"
    seen.add(answer.page)
  }
  if (answers.some((answer) => !PDF_QUALITY_VERDICTS.includes(answer.verdict as PdfQualityVerdict))) return "unknown-verdict"
  if (
    answers.some((answer) =>
      (answer.issueLabels ?? []).some((label) => !PDF_QUALITY_ISSUE_LABELS.includes(label as PdfQualityIssueLabel))
    )
  ) {
    return "unknown-issue-label"
  }
  if (requestedPages.some((page) => !seen.has(page))) return "missing-page"
  return null
}

function serveAnswerSet(
  scenario: ReplayScenario,
  attempt: ReplayAttempt,
  requestedPages: readonly number[]
): { served: ServedAnswerPage[]; invalidReason: string | null } | { served: null; invalidReason: string } {
  const answers = attempt.pages ?? []
  const reason = answerSetViolationReason(scenario, requestedPages, answers) ?? (attempt.outcome === "invalid" ? attempt.invalidReason ?? "unknown-verdict" : null)
  if (reason) return { served: null, invalidReason: reason }
  const served = answers.map((answer) => {
    const labels = (answer.issueLabels ?? ["none"]) as PdfQualityIssueLabel[]
    return {
      page: answer.page,
      verdict: answer.verdict as PdfQualityVerdict,
      issueLabels: labels,
      dimensions: dimensionsForLabels(labels),
      probability: answer.probability ?? 0,
      confidence: answer.confidence ?? 0,
    }
  })
  return { served, invalidReason: null }
}

function imagePresent(page: ReplayAuditRequestPage): boolean {
  if (typeof page.imageBase64 === "string" && page.imageBase64.length > 0) return true
  return page.imageBytes !== undefined && page.imageBytes.byteLength > 0
}

function checkAuditRequest(scenario: ReplayScenario, request: ReplayAuditRequest): void {
  if (!Array.isArray(request.pages) || request.pages.length === 0) {
    throw new TypeError(`replay audit request for ${scenario.scenarioId} must list at least one page`)
  }
  if (request.fixtureId !== scenario.fixture) {
    throw new ReplayRequestMismatchError(
      `replay scenario ${scenario.scenarioId} is bound to fixture ${scenario.fixture}, got ${request.fixtureId}`
    )
  }
  if (request.stage !== scenario.stage) {
    throw new ReplayRequestMismatchError(
      `replay scenario ${scenario.scenarioId} serves stage ${scenario.stage}, got ${request.stage}`
    )
  }
  const requested = request.pages.map((page) => page.page).sort((a, b) => a - b)
  const declared = [...scenario.coversPages].sort((a, b) => a - b)
  if (new Set(requested).size !== requested.length) {
    throw new ReplayRequestMismatchError(`replay request for ${scenario.scenarioId} repeats page numbers`)
  }
  if (requested.length !== declared.length || requested.some((page, index) => page !== declared[index])) {
    throw new ReplayRequestMismatchError(
      `replay scenario ${scenario.scenarioId} covers pages [${declared.join(",")}], request asked [${requested.join(",")}]`
    )
  }
}

function abortError(scenarioId: string): DOMException {
  return new DOMException(`replay service call for ${scenarioId} was cancelled`, "AbortError")
}

export interface ReplayClefService {
  readonly scenarioId: string
  /** 回放一次 Clef 逐页审计调用。 */
  auditPages(request: ReplayAuditRequest): Promise<ReplayClefOutcome>
  /** 真正到达（伪造）传输层的次数；复用证据与派发前取消不计。 */
  invocations(): number
  /** 被调用的总次数（含派发前取消）。 */
  callsReceived(): number
  /** 已消费的脚本尝试数。 */
  servedAttempts(): number
  requests(): RecordedRequest[]
  contractViolations(): ReplayContractViolation[]
  ledger(): ReplayLedgerEntry[]
}

export interface ReplayOcrService {
  readonly scenarioId: string
  /** 回放一次整篇 OCR 兜底调用。 */
  recognizeDocument(request: ReplayOcrRequest): Promise<ReplayOcrOutcome>
  invocations(): number
  callsReceived(): number
  servedAttempts(): number
  requests(): Array<{ fixtureId: string; pageCount: number }>
  contractViolations(): ReplayContractViolation[]
  ledger(): ReplayLedgerEntry[]
}

interface ServiceState {
  attemptsConsumed: number
  dispatches: number
  calls: number
  violations: ReplayContractViolation[]
  ledger: ReplayLedgerEntry[]
}

function nextAttempt(scenario: ReplayScenario, state: ServiceState): ReplayAttempt {
  if (state.attemptsConsumed >= scenario.attempts.length) {
    throw new Error(
      `replay scenario ${scenario.scenarioId} is exhausted after ${scenario.attempts.length} scripted attempt(s); create a new service to replay it again`
    )
  }
  return scenario.attempts[state.attemptsConsumed]
}

export function createReplayClefService(options: { scenarioId: string; clock?: ReplayClock }): ReplayClefService {
  const scenario = loadReplayScenario(options.scenarioId)
  if (scenario.service !== "clef") {
    throw new Error(`scenario ${scenario.scenarioId} is a ${scenario.service} scenario, not a Clef scenario`)
  }
  const clock = options.clock ?? createReplayVirtualClock(0)
  const state: ServiceState = { attemptsConsumed: 0, dispatches: 0, calls: 0, violations: [], ledger: [] }
  const requests: RecordedRequest[] = []

  return {
    scenarioId: scenario.scenarioId,
    callsReceived: () => state.calls,
    invocations: () => state.dispatches,
    servedAttempts: () => state.attemptsConsumed,
    requests: () => requests,
    contractViolations: () => state.violations,
    ledger: () => state.ledger,
    auditPages: async (request) => {
      checkAuditRequest(scenario, request)
      state.calls += 1
      const requestedPages = request.pages.map((page) => page.page)

      if (request.signal?.aborted) {
        state.ledger.push({ attempt: null, kind: "aborted-before-dispatch", virtualMs: clock.now(), requestedPages })
        throw abortError(scenario.scenarioId)
      }

      const attempt = nextAttempt(scenario, state)
      state.attemptsConsumed += 1
      state.dispatches += 1

      const images = request.pages.map((page) => imagePresent(page))
      const texts = request.pages.map((page) => page.text !== undefined)
      requests.push({ pages: requestedPages, imagePresent: images, textPresent: texts, candidateId: request.candidateId })

      if (requestedPages.length > scenario.maxImagesPerRequest) {
        state.violations.push({
          code: "over-image-limit",
          page: null,
          detail: `request carried ${requestedPages.length} page images but maxImagesPerRequest is ${scenario.maxImagesPerRequest}; over-limit input must be split, never silently truncated`,
        })
      }
      request.pages.forEach((page, index) => {
        if (!images[index]) {
          state.violations.push({
            code: "missing-page-image",
            page: page.page,
            detail: `page ${page.page} carried no page image; metadata-only evidence cannot satisfy the quality contract`,
          })
        }
        if (page.text === undefined) {
          state.violations.push({
            code: "missing-page-text",
            page: page.page,
            detail: `page ${page.page} carried no text field; use "" for a page that genuinely has no text layer`,
          })
        }
      })
      if (images.every((present) => !present) && texts.every((present) => !present)) {
        state.violations.push({
          code: "metadata-only-request",
          page: null,
          detail: "neither page images nor page text were submitted",
        })
      }

      const virtualMs = clock.advance(attempt.latencyMs)
      const record = (kind: string, attemptNumber: number | null): void => {
        state.ledger.push({ attempt: attemptNumber, kind, virtualMs, requestedPages })
      }

      if (attempt.outcome === "malformed") {
        record("malformed", attempt.attempt)
        return { kind: "malformed", attempt: attempt.attempt, bodyRaw: attempt.bodyRaw ?? "", httpStatus: attempt.httpStatus ?? 200, virtualMs }
      }
      if (attempt.outcome === "timeout") {
        record("timeout", attempt.attempt)
        return { kind: "timeout", attempt: attempt.attempt, timeoutMs: scenario.timeoutMs, virtualMs }
      }
      if (attempt.outcome === "service-error") {
        record("service-error", attempt.attempt)
        return { kind: "service-error", attempt: attempt.attempt, httpStatus: attempt.httpStatus ?? 503, virtualMs }
      }
      if (attempt.outcome === "cancelled") {
        record("cancelled", attempt.attempt)
        throw abortError(scenario.scenarioId)
      }

      const { served, invalidReason } = serveAnswerSet(scenario, attempt, requestedPages)
      if (served === null) {
        record("invalid", attempt.attempt)
        return {
          kind: "invalid",
          attempt: attempt.attempt,
          invalidReason,
          body: { pages: attempt.pages ?? [] },
          httpStatus: attempt.httpStatus ?? 200,
          virtualMs,
        }
      }
      const usage = { inputTokens: 900 + served.length * 320, outputTokens: 40 + served.length * 12 }
      if (attempt.outcome === "answered-from-durable-evidence") {
        // 复用已持久证据：不产生新的远程调用，因此 invocations() 归零回退。
        state.dispatches -= 1
        record("answered-from-durable-evidence", attempt.attempt)
        return {
          kind: "answered-from-durable-evidence",
          attempt: attempt.attempt,
          reusedFromAttempt: attempt.reusedFromAttempt ?? attempt.attempt,
          model: "@cf/cloudflare/clef",
          pages: served,
          usage,
          virtualMs,
          reusedDurableEvidence: true,
        }
      }
      record("answered", attempt.attempt)
      return { kind: "answered", attempt: attempt.attempt, model: "@cf/cloudflare/clef", pages: served, usage, virtualMs, reusedDurableEvidence: false }
    },
  }
}

export function createReplayOcrService(options: { scenarioId: string; clock?: ReplayClock }): ReplayOcrService {
  const scenario = loadReplayScenario(options.scenarioId)
  if (scenario.service !== "ocr") {
    throw new Error(`scenario ${scenario.scenarioId} is a ${scenario.service} scenario, not an OCR scenario`)
  }
  const clock = options.clock ?? createReplayVirtualClock(0)
  const state: ServiceState = { attemptsConsumed: 0, dispatches: 0, calls: 0, violations: [], ledger: [] }
  const requests: Array<{ fixtureId: string; pageCount: number }> = []

  return {
    scenarioId: scenario.scenarioId,
    callsReceived: () => state.calls,
    invocations: () => state.dispatches,
    servedAttempts: () => state.attemptsConsumed,
    requests: () => requests,
    contractViolations: () => state.violations,
    ledger: () => state.ledger,
    recognizeDocument: async (request) => {
      if (!request || typeof request.fixtureId !== "string" || request.fixtureId.length === 0) {
        throw new TypeError(`replay OCR request for ${scenario.scenarioId} must name a fixture`)
      }
      if (!Number.isInteger(request.pageCount) || request.pageCount < 1) {
        throw new TypeError(`replay OCR request for ${scenario.scenarioId} must declare a positive pageCount`)
      }
      if (request.fixtureId !== scenario.fixture) {
        throw new ReplayRequestMismatchError(
          `replay scenario ${scenario.scenarioId} is bound to fixture ${scenario.fixture}, got ${request.fixtureId}`
        )
      }
      if (request.pageCount !== scenario.coversPages.length) {
        throw new ReplayRequestMismatchError(
          `replay scenario ${scenario.scenarioId} covers ${scenario.coversPages.length} page(s), request declared ${request.pageCount}`
        )
      }
      state.calls += 1
      requests.push({ fixtureId: request.fixtureId, pageCount: request.pageCount })

      if (request.signal?.aborted) {
        state.ledger.push({ attempt: null, kind: "aborted-before-dispatch", virtualMs: clock.now(), requestedPages: scenario.coversPages })
        throw abortError(scenario.scenarioId)
      }

      const attempt = nextAttempt(scenario, state)
      state.attemptsConsumed += 1
      state.dispatches += 1
      const virtualMs = clock.advance(attempt.latencyMs)
      const record = (kind: string): void => {
        state.ledger.push({ attempt: attempt.attempt, kind, virtualMs, requestedPages: scenario.coversPages })
      }

      if (attempt.outcome === "malformed") {
        record("malformed")
        return { kind: "malformed", attempt: attempt.attempt, bodyRaw: attempt.bodyRaw ?? "", httpStatus: attempt.httpStatus ?? 200, virtualMs }
      }
      if (attempt.outcome === "timeout") {
        record("timeout")
        return { kind: "timeout", attempt: attempt.attempt, timeoutMs: scenario.timeoutMs, virtualMs }
      }
      if (attempt.outcome === "service-error") {
        record("service-error")
        return { kind: "service-error", attempt: attempt.attempt, httpStatus: attempt.httpStatus ?? 503, virtualMs }
      }
      if (attempt.outcome === "cancelled") {
        record("cancelled")
        throw abortError(scenario.scenarioId)
      }

      const pages = (attempt.pages ?? []).map((page) => ({ page: page.page, text: page.text ?? "" }))
      const missing = scenario.coversPages.filter((page) => !pages.some((entry) => entry.page === page))
      if (missing.length > 0) {
        state.violations.push({
          code: "missing-page-text",
          page: missing[0],
          detail: `OCR candidate does not cover page ${missing.join(", ")} of the declared page set`,
        })
      }
      const requestId = `replay-ocr-${scenario.scenarioId}-${attempt.attempt}`
      if (attempt.outcome === "answered-from-durable-evidence") {
        state.dispatches -= 1
        record("candidate-from-durable-evidence")
        return {
          kind: "candidate-from-durable-evidence",
          attempt: attempt.attempt,
          reusedFromAttempt: attempt.reusedFromAttempt ?? attempt.attempt,
          requestId,
          pages,
          virtualMs,
          reusedDurableEvidence: true,
        }
      }
      record("candidate")
      return { kind: "candidate", attempt: attempt.attempt, requestId, pages, virtualMs, reusedDurableEvidence: false }
    },
  }
}
