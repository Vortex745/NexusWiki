import type { RunHistory, SseEventData } from "@core/conversation"

import { MIME_BY_EXTENSION } from "./constants"
import { isPdfLike } from "./importBatch"

const API_BASE = "/api"

/**
 * Ticket 01: the bearer token lives in this module for the lifetime of the
 * page. It is deliberately NOT part of any bundle or build-time constant —
 * it is obtained at runtime from the server after a sign-in.
 */
let accessToken: string | null = null

export function setAccessToken(token: string | null): void {
  accessToken = token
}

/**
 * Every API call goes through here so the Authorization header is attached in
 * exactly one place. A 401 is reported to the session layer through
 * `onUnauthorized` so the app can fall back to the sign-in screen.
 */
let onUnauthorized: (() => void) | null = null

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const sentToken = accessToken
  if (sentToken) headers.set("Authorization", `Bearer ${sentToken}`)
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers })
  // Only a rejected TOKEN means the session is gone. A 401 on a request that
  // carried no token is simply "not signed in yet" — reporting that would make
  // the session probe below re-enter itself without end.
  if (response.status === 401 && sentToken) onUnauthorized?.()
  return response
}

// ---------------------------------------------------------------------------
// Identity session (ticket 01)
// ---------------------------------------------------------------------------

export interface SessionPayload {
  tenantId: string
  subjectId: string
  /** Derived server-side from the granted scopes. */
  role: "admin" | "reader"
  groups: string[]
  scopes: string[]
}

export interface AuthConfigPayload {
  demoAuth: boolean
  accounts: Array<{ key: string; label: string }>
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super("账号或密码不正确")
    this.name = "InvalidCredentialsError"
  }
}

export async function fetchAuthConfig(): Promise<AuthConfigPayload> {
  const response = await apiFetch("/auth/config")
  if (!response.ok) throw new Error(`登录配置读取失败 (${response.status})`)
  return (await response.json()) as AuthConfigPayload
}

/** Sign in and keep the returned token for subsequent calls. */
export async function signIn(account: string, password: string): Promise<void> {
  const response = await apiFetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account, password }),
  })
  if (response.status === 401) throw new InvalidCredentialsError()
  if (!response.ok) throw new Error(`登录失败 (${response.status})`)
  const body = (await response.json()) as { accessToken?: string }
  if (!body.accessToken) throw new Error("登录失败：服务器未返回凭证")
  setAccessToken(body.accessToken)
}

/** Who the server says the caller is. 401 means "not signed in". */
export async function fetchSession(): Promise<SessionPayload | null> {
  const response = await apiFetch("/session")
  if (response.status === 401) return null
  if (!response.ok) throw new Error(`身份读取失败 (${response.status})`)
  return (await response.json()) as SessionPayload
}

export interface StatusChannel {
  status: string
  detail?: string
  responseTimeMs?: number
  error?: string
}

export interface StatusPayload {
  checkedAt: string
  hasKnowledgeBaseContent?: boolean
  channels: {
    elasticsearch: StatusChannel
    neo4j: StatusChannel
    chat: StatusChannel
    embedding: StatusChannel
    rerank: StatusChannel
    parsers: StatusChannel
    mcp: StatusChannel
    webSearch: StatusChannel
    langfuse: StatusChannel
  }
  config?: {
    esNodeHost?: string
    neo4jUriHost?: string
    chatBaseUrlHost?: string
    chatModel?: string
  }
}

export interface IngestSubmission {
  docId?: string
  submitted?: number
  items?: Array<{ url: string; docId?: string; status?: string }>
}

export interface IngestSpanNode {
  span: {
    id: number
    name: string
    kind: "root" | "stage"
    status: "pending" | "running" | "done" | "failed" | "skipped" | "cancelled"
    errorMessage: string | null
    durationMs: number | null
    output: Record<string, unknown> | null
  }
  children: IngestSpanNode[]
}

export interface IngestStatus {
  documentStatus: "pending" | "completed" | "failed" | "cancelled" | null
  lifecycleOutcome: string | null
  task: {
    status: "pending" | "running" | "completed" | "failed" | "cancelled"
    failCount: number
    nextAttemptAt: string | null
  } | null
  spanTree: IngestSpanNode[]
  /** UT-26: which version this document is — active=false means a blocked
   * candidate did NOT replace the currently usable version. */
  documentVersion?: { version: number; contentHash: string; active: boolean }
  /** UT-26: activation-gate denial reason codes joined by ";" (null = active
   * or never attempted). A completed candidate can still be blocked. */
  activationBlockReason?: string | null
  /** UT-26: candidate pipeline state ('pending_review' = held for business
   * approval under ACTIVATION_MODE=review). */
  candidateState?: string | null
  /** UT-26: machine-readable failure classification with allowed operations. */
  failure?: {
    category: string
    reasonCode: string
    retryable: boolean
    allowedOperations: string[]
    message: string
    failedAt: string
  } | null
}

async function readError(response: Response): Promise<string> {
  const body = await response.text().catch(() => "")
  // JSON error bodies carry a curated human message — prefer it over raw text,
  // which for unmapped raw-parser errors used to be an entire HTML error page
  // pasted into toasts and popups.
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    if (typeof parsed.error === "string") return `HTTP ${response.status}: ${parsed.error}`
    const nested = parsed.error as { message?: unknown } | undefined
    if (nested && typeof nested.message === "string") return `HTTP ${response.status}: ${nested.message}`
  } catch {
    // not JSON — fall through to the raw-text path
  }
  return `HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`
}

export async function fetchStatus(): Promise<StatusPayload> {
  const response = await apiFetch("/status")
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return (await response.json()) as StatusPayload
}

// ---------------------------------------------------------------------------
// Evaluation tasks (in-process, memory-only — ticket 04)
// ---------------------------------------------------------------------------

export interface EvaluationDatasetSummary {
  id: string
  name: string
  version: string
  description: string
  contentDigest: string
  caseCount: number
  passageCount: number
}

export interface EvaluationDatasetsPayload {
  datasets: EvaluationDatasetSummary[]
  defaults: { chatModel: string; rerankModel: string | null; embeddingModel: string }
  /** Ticket 11: ids a task may pick instead of the server default. */
  allowedModels: { chat: string[]; rerank: string[] }
  /** Ticket 28: the built-in Rerank on/off pair and the sample it runs on. */
  comparisonAssistants?: EvaluationAssistantSnapshot[]
  comparisonDatasetId?: string
  maxCasesPerTask: number
}

/** Ticket 28: the immutable assistant configuration a task ran with. */
export interface EvaluationAssistantSnapshot {
  assistantId: string
  version: number
  name: string
  configDigest: string
  systemPrompt: string
  rerankModelProfileId: string | null
}

export type EvaluationTaskStage =
  | "queued"
  | "preparing"
  | "running"
  | "cleaning"
  | "completed"
  | "completed_with_errors"
  | "failed"

export interface EvaluationRankedCandidate {
  rank: number
  passageId: string | null
  documentId: string
  chunkId: string
  score: number
  channels: string[]
  relevant: boolean
}

export interface EvaluationCaseResult {
  caseId: string
  question: string
  referenceAnswer: string
  outcome: "answered" | "failed"
  answer: string
  terminalStatus?: string
  error?: string
  /**
   * Ticket 06: how the scored ranking was produced. `dedicated_rerank` means
   * the configured reranker scored it; `fused` means an unscored order was
   * published (fusion, below-threshold, unavailable reranker, or a multi-query
   * merge) — never displayed as a dedicated-rerank success.
   */
  ordering?: { source: "dedicated_rerank" | "fused"; reason?: string }
  runId?: string
  /** Ticket 27/28: the frozen model snapshot this case ran with. */
  modelProfile?: { chatModel: string; rerankModel: string | null; embeddingProfile: string }
  durationMs: number
  metrics: Record<string, number | null>
  retrievedPassageIds: string[]
  /** Ticket 13: which generation round produced the scored context. */
  finalContextRound?: number
  candidates: EvaluationRankedCandidate[]
  unmappedCandidates: number
}

export interface EvaluationTaskSummary {
  id: string
  dataset: {
    id?: string
    name: string
    version: string
    contentDigest: string
    caseCount: number
    passageCount: number
  }
  stage: EvaluationTaskStage
  progress: { finished: number; total: number }
  /** Ticket 10: answered / failed / degraded among the settled cases. */
  counts: { answered: number; failed: number; degraded: number }
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

export interface EvaluationTaskDetail extends EvaluationTaskSummary {
  config: {
    chatModel: string
    rerankModel: string | null
    embeddingModel: string
    rerankSource: string
    /** Ticket 28: present when the task named an assistant configuration. */
    assistant?: EvaluationAssistantSnapshot
  }
  cases: EvaluationCaseResult[]
  metrics: {
    version: string
    /** Ticket 07/08: the answer-similarity metrics and the text rules they share. */
    generation?: { bleuVersion: string; rougeVersion: string; textRuleVersion: string }
    metrics: Record<string, { value: number | null; sampleSize: number; notApplicable: number }>
  }
  cleanup: { esIndex: string; esError?: string; graphProvenance: string; graphError?: string; dbClosed: boolean } | null
  error?: string
}

export async function fetchEvaluationDatasets(): Promise<EvaluationDatasetsPayload> {
  const response = await apiFetch("/evaluation-datasets")
  if (!response.ok) throw new Error(`评测样例读取失败 (${response.status})`)
  return (await response.json()) as EvaluationDatasetsPayload
}

/**
 * Built-in sample id or an inline dataset payload — exactly one of the two —
 * plus the optional per-run model ids (ticket 11). Model ids are the ONLY
 * provider setting a request may carry: no base URL, key or endpoint.
 */
export type EvaluationTaskInput = ({ datasetId: string } | { dataset: unknown }) & {
  chatModel?: string
  rerankModel?: string
  /** Ticket 28: run an immutable assistant configuration (built-in id or stored). */
  assistantId?: string
}

/**
 * Rejected request (400/429). `issues` carries the server's per-field/per-case
 * messages so the page can point at the offending entry (ticket 05).
 */
export class EvaluationRequestError extends Error {
  constructor(message: string, readonly issues: string[] = [], readonly status = 0) {
    super(message)
    this.name = "EvaluationRequestError"
  }
}

/**
 * Ticket 26 (EVAL-01B1): a cancel can be refused for a STATE reason — 404 when
 * the record is gone from this process, 409 when the task already settled (a
 * cancel never rewrites a result). The status is kept so the page can refresh
 * the settled record instead of showing a failure for a normal outcome.
 */
export class EvaluationCancelError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = "EvaluationCancelError"
  }
}

export async function createEvaluationTask(input: EvaluationTaskInput): Promise<EvaluationTaskSummary> {
  const response = await apiFetch("/evaluations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; issues?: unknown }
    const issues = Array.isArray(body.issues) ? body.issues.map((issue) => String(issue)) : []
    throw new EvaluationRequestError(
      body.error || `评测任务提交失败 (${response.status})`,
      issues,
      response.status
    )
  }
  return (await response.json()) as EvaluationTaskSummary
}

/** Ticket 12: the evaluation records retained by this process. */
export async function listEvaluationTasks(): Promise<EvaluationTaskSummary[]> {
  const response = await apiFetch("/evaluations")
  if (!response.ok) throw new Error(`评测记录读取失败 (${response.status})`)
  const body = (await response.json()) as { tasks?: EvaluationTaskSummary[] }
  return Array.isArray(body.tasks) ? body.tasks : []
}

/** 404 → null（任务只存在于当前服务进程，重启后不可查询）。 */
export async function fetchEvaluationTask(id: string): Promise<EvaluationTaskDetail | null> {
  const response = await apiFetch(`/evaluations/${encodeURIComponent(id)}`)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`评测任务查询失败 (${response.status})`)
  return (await response.json()) as EvaluationTaskDetail
}

/**
 * Ticket 25 (EVAL-01A): cancel a running task. 404 → the task is gone from
 * this process; 409 → it already finished and its result stands.
 */
export async function cancelEvaluationTask(id: string): Promise<EvaluationTaskDetail> {
  const response = await apiFetch(`/evaluations/${encodeURIComponent(id)}/cancel`, { method: "POST" })
  if (response.status === 404) throw new EvaluationCancelError("任务不在当前服务进程中", 404)
  if (response.status === 409) throw new EvaluationCancelError("任务已经结束，结果不会被取消改写", 409)
  if (!response.ok) throw new EvaluationCancelError(`取消失败 (${response.status})`, response.status)
  return (await response.json()) as EvaluationTaskDetail
}

// ---------------------------------------------------------------------------
// Ticket 28 (EVAL-02A): report export and comparison of two configurations
// ---------------------------------------------------------------------------

export interface EvaluationComparisonSide {
  taskId: string
  stage: EvaluationTaskStage
  assistant?: EvaluationAssistantSnapshot
  config: EvaluationTaskDetail["config"]
  metrics: EvaluationTaskDetail["metrics"]
}

export interface EvaluationComparisonCase {
  caseId: string
  question: string
  left: {
    outcome: "answered" | "failed"
    answer: string
    ordering?: { source: string; reason?: string }
    metrics: Record<string, number | null>
  }
  right: EvaluationComparisonCase["left"]
}

export interface EvaluationComparison {
  formatVersion: number
  dataset: { name: string; version: string; contentDigest: string }
  left: EvaluationComparisonSide
  right: EvaluationComparisonSide
  metrics: Record<string, { left: number | null; right: number | null; delta: number | null }>
  cases: EvaluationComparisonCase[]
  /** True when the two configurations differ only in the rerank binding. */
  rerankComparison: boolean
}

/**
 * Ticket 28: a settled report as JSON or CSV. The server sends it as an
 * attachment with both an ASCII and a UTF-8 filename; the latter wins.
 */
export async function exportEvaluationTask(
  id: string,
  format: "json" | "csv"
): Promise<{ filename: string; text: string }> {
  const response = await apiFetch(`/evaluations/${encodeURIComponent(id)}/export?format=${format}`)
  if (response.status === 404) throw new Error("任务不在当前服务进程中")
  if (response.status === 409) throw new Error("任务尚未结束，报告还不完整")
  if (!response.ok) throw new Error(`导出失败 (${response.status})`)
  const disposition = response.headers.get("Content-Disposition") ?? ""
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
  const fallback = /filename="([^"]+)"/i.exec(disposition)?.[1]
  return {
    filename: utf8 ? decodeURIComponent(utf8) : (fallback ?? `evaluation-${id.slice(0, 8)}.${format}`),
    text: await response.text(),
  }
}

/** Ticket 28: compare two settled tasks that ran the same dataset. */
export async function compareEvaluationTasks(
  leftTaskId: string,
  rightTaskId: string
): Promise<EvaluationComparison> {
  const response = await apiFetch("/evaluations/compare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ leftTaskId, rightTaskId }),
  })
  if (response.status === 404) throw new Error("参与对比的任务不在当前服务进程中")
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new EvaluationRequestError(body.error || `对比失败 (${response.status})`, [], response.status)
  }
  return (await response.json()) as EvaluationComparison
}

/**
 * Ticket 28: run the built-in Rerank enabled/disabled example — two tasks over
 * one dataset, differing only in the immutable rerank binding.
 */
export async function createEvaluationComparisonExample(
  datasetId?: string
): Promise<{ datasetId: string; left: EvaluationTaskSummary; right: EvaluationTaskSummary }> {
  const response = await apiFetch("/evaluations/comparison-example", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(datasetId ? { datasetId } : {}),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; issues?: unknown }
    const issues = Array.isArray(body.issues) ? body.issues.map((issue) => String(issue)) : []
    throw new EvaluationRequestError(
      body.error || `内置对照任务创建失败 (${response.status})`,
      issues,
      response.status
    )
  }
  return (await response.json()) as {
    datasetId: string
    left: EvaluationTaskSummary
    right: EvaluationTaskSummary
  }
}

// ---------------------------------------------------------------------------
// Ticket 29 (EVAL-02B): answer feedback — submit your own, review as admin
// ---------------------------------------------------------------------------

export type FeedbackRating = "up" | "down"
export type FeedbackStatus = "open" | "reviewed" | "dismissed"
export type FeedbackReasonCode =
  | "wrong_answer"
  | "wrong_citation"
  | "incomplete"
  | "stale_knowledge"
  | "unwanted_handoff"
  | "other"

/** The reason codes the server accepts, in display order. */
export const FEEDBACK_REASON_CODES: ReadonlyArray<[FeedbackReasonCode, string]> = [
  ["wrong_answer", "答案错误"],
  ["wrong_citation", "引用错误"],
  ["incomplete", "不完整"],
  ["stale_knowledge", "知识过时"],
  ["unwanted_handoff", "不该转人工"],
  ["other", "其他"],
]

export interface FeedbackPayload {
  id: string
  runId: string
  tenantId: string
  subjectId: string
  /** The answered message this rating belongs to. */
  messageId: string
  /** The session of the answered run (server-derived). */
  sessionId: string
  rating: FeedbackRating
  reasonCode: FeedbackReasonCode | null
  comment: string | null
  evidenceIds: string[]
  status: FeedbackStatus
  createdAt: string
  updatedAt: string
}

export interface FeedbackSubmission {
  messageId: string
  rating: FeedbackRating
  reasonCode?: FeedbackReasonCode | null
  comment?: string
  evidenceIds?: string[]
}

export interface FeedbackFilter {
  status?: FeedbackStatus
  rating?: FeedbackRating
  subjectId?: string
  runId?: string
}

/**
 * Submit (or replace) the caller's rating of one answered run. The run must
 * belong to the caller and must have completed: a foreign run answers 404 and
 * an unfinished one 409.
 */
export async function submitAnswerFeedback(
  runId: string,
  input: FeedbackSubmission
): Promise<FeedbackPayload> {
  const response = await apiFetch(`/chat/runs/${encodeURIComponent(runId)}/feedback`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  if (response.status === 404) throw new Error("这条回答已不可提交反馈（不在当前服务进程中）")
  if (response.status === 409) throw new Error("这条回答还没有结束，稍后再提交反馈")
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; issues?: unknown }
    const issues = Array.isArray(body.issues) ? body.issues.map((issue) => String(issue)) : []
    throw new Error(issues.length > 0 ? `${body.error ?? "提交失败"}：${issues.join("；")}` : (body.error ?? `提交失败 (${response.status})`))
  }
  return (await response.json()) as FeedbackPayload
}

/** Reviewer list (review/admin scope) — tenant-scoped, filtered server-side. */
export async function fetchFeedbackList(filter: FeedbackFilter = {}): Promise<FeedbackPayload[]> {
  const params = new URLSearchParams()
  if (filter.status) params.set("status", filter.status)
  if (filter.rating) params.set("rating", filter.rating)
  if (filter.subjectId) params.set("subjectId", filter.subjectId)
  if (filter.runId) params.set("runId", filter.runId)
  const query = params.toString()
  const response = await apiFetch(`/feedback${query ? `?${query}` : ""}`)
  if (response.status === 403) throw new Error("需要审核或管理员权限")
  if (!response.ok) throw new Error(`反馈列表读取失败 (${response.status})`)
  const body = (await response.json()) as { feedback?: FeedbackPayload[] }
  return Array.isArray(body.feedback) ? body.feedback : []
}

export async function updateFeedbackStatus(
  id: string,
  status: FeedbackStatus
): Promise<FeedbackPayload> {
  const response = await apiFetch(`/feedback/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  })
  if (response.status === 403) throw new Error("需要审核或管理员权限")
  if (response.status === 404) throw new Error("反馈不在当前租户中")
  if (!response.ok) throw new Error(`反馈状态更新失败 (${response.status})`)
  return (await response.json()) as FeedbackPayload
}

// ---------------------------------------------------------------------------
// Ticket 30 (FAQ-01A): versioned FAQ entries inside one knowledge base
// ---------------------------------------------------------------------------

export type FaqEntryStatus = "active" | "disabled"

export interface FaqSourcePayload {
  title: string
  uri: string | null
}

export interface FaqEntryVersionPayload {
  version: number
  question: string
  normalizedQuestion: string
  variants: string[]
  answer: string
  source: FaqSourcePayload | null
  createdBy: string
  createdAt: string
}

export interface FaqEntryPayload {
  id: string
  tenantId: string
  knowledgeBaseId: string
  status: FaqEntryStatus
  currentVersion: number
  createdAt: string
  updatedAt: string
  version: FaqEntryVersionPayload
}

export interface FaqCommandBody {
  question?: string
  answer?: string
  variants?: string[]
  source?: FaqSourcePayload | null
}

export interface FaqImportResultPayload {
  imported: number
  versioned: number
  skipped: number
  issues: string[]
}

/** A rejected FAQ command: 400 with per-field issues, 409 with the conflict. */
export class FaqCommandError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
    readonly status = 0,
    readonly conflict: Record<string, unknown> | null = null
  ) {
    super(message)
    this.name = "FaqCommandError"
  }
}

async function faqCommand(
  knowledgeBaseId: string,
  path: string,
  method: string,
  body?: unknown
): Promise<Record<string, any>> {
  const response = await apiFetch(
    `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/faqs${path}`,
    {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }
  )
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string
      issues?: unknown
      conflict?: Record<string, unknown>
    }
    const issues = Array.isArray(payload.issues) ? payload.issues.map((issue) => String(issue)) : []
    throw new FaqCommandError(
      payload.error ?? `FAQ 操作失败 (${response.status})`,
      issues,
      response.status,
      payload.conflict ?? null
    )
  }
  return (await response.json()) as Record<string, any>
}

/** Entries of one knowledge base — DISABLED entries are listed too. */
export async function fetchFaqEntries(
  knowledgeBaseId: string,
  status?: FaqEntryStatus
): Promise<FaqEntryPayload[]> {
  const payload = await faqCommand(
    knowledgeBaseId,
    status ? `?status=${status}` : "",
    "GET"
  )
  return Array.isArray(payload.entries) ? (payload.entries as FaqEntryPayload[]) : []
}

export async function createFaqEntry(
  knowledgeBaseId: string,
  body: FaqCommandBody
): Promise<FaqEntryPayload> {
  const payload = await faqCommand(knowledgeBaseId, "", "POST", body)
  return payload.entry as FaqEntryPayload
}

/** An edit adds an immutable version; omitted fields keep their value. */
export async function editFaqEntry(
  knowledgeBaseId: string,
  id: string,
  body: FaqCommandBody
): Promise<FaqEntryPayload> {
  const payload = await faqCommand(knowledgeBaseId, `/${encodeURIComponent(id)}`, "PATCH", body)
  return payload.entry as FaqEntryPayload
}

export async function setFaqEntryStatus(
  knowledgeBaseId: string,
  id: string,
  status: FaqEntryStatus
): Promise<FaqEntryPayload> {
  const payload = await faqCommand(
    knowledgeBaseId,
    `/${encodeURIComponent(id)}/${status === "active" ? "activate" : "disable"}`,
    "POST"
  )
  return payload.entry as FaqEntryPayload
}

export async function fetchFaqEntryVersions(
  knowledgeBaseId: string,
  id: string
): Promise<FaqEntryVersionPayload[]> {
  const payload = await faqCommand(
    knowledgeBaseId,
    `/${encodeURIComponent(id)}/versions`,
    "GET"
  )
  return Array.isArray(payload.versions) ? (payload.versions as FaqEntryVersionPayload[]) : []
}

/** Row-precise import: valid rows are applied, rejected rows are reported. */
export async function importFaqEntries(
  knowledgeBaseId: string,
  format: "json" | "csv",
  content: string
): Promise<FaqImportResultPayload> {
  const payload = await faqCommand(knowledgeBaseId, "/import", "POST", { format, content })
  return payload.result as FaqImportResultPayload
}

export async function fetchRunHistory(runId: string): Promise<RunHistory> {
  const response = await apiFetch(`/chat/runs/${encodeURIComponent(runId)}`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return (await response.json()) as RunHistory
}

export interface ChatRequestBody {
  message: string
  runId: string
  sessionId: string
  /**
   * Ticket 08 (KB-04): the caller's knowledge SELECTION — which knowledge
   * bases a new chat may search. Omitted → the tenant's default base; the
   * server validates every id against the session's tenant (404/409/400), so
   * the client can narrow the scope but never widen it.
   */
  knowledgeBaseIds?: string[]
  /**
   * Ticket 19 (AST-01B): which assistant to run. The id is the only input —
   * prompt, scope, rerank binding and tool policy are resolved server-side
   * from the stored immutable version. Omitted → the legacy default path.
   */
  assistantId?: string
  /**
   * Ticket 21 (CONV-01B): the run this request REPLACES. Edit and regenerate
   * name the branch's assistant run so the server drops it — and everything
   * recorded after it — before the new run starts. Omitted on a normal send.
   */
  truncateFromRunId?: string
}

/**
 * Streams one answer run. SSE *line parsing* lives here (transport); the
 * per-event merge is delegated to Conversation.processSseEvent by the caller.
 */
export async function streamChat(
  body: ChatRequestBody,
  onEvent: (data: SseEventData) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await apiFetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    // Ticket 08 (KB-04): a rejected knowledge selection (400/404/409) carries
    // the server's reason — surface it instead of a bare status code, so the
    // user learns the selected knowledge base is archived or unknown.
    const payload = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(payload.error || `服务器错误 (${response.status})`)
  }
  if (!response.body) throw new Error("浏览器不支持流式响应")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let streamDone = false

  const processLine = (rawLine: string) => {
    const line = rawLine.trimEnd()
    if (!line.startsWith("data:")) return
    const payload = line.slice(5).trim()
    if (!payload || payload === "[DONE]") {
      streamDone = payload === "[DONE]"
      return
    }
    try {
      onEvent(JSON.parse(payload) as SseEventData)
    } catch {
      // Ignore non-JSON SSE keepalive lines.
    }
  }

  while (!streamDone) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ""
    lines.forEach(processLine)
    if (done) break
  }

  if (buffer.trim()) processLine(buffer)
}

/** UT-23: the upload's failure taxonomy. Admission rejections carry the
 * server's stable kind (empty_file / file_size / type_conflict /
 * unsupported_type — src/api/ingest.ts) plus the byte-signature detection for
 * type conflicts; transport classes (network / timeout / invalid_response)
 * distinguish "the server never received this upload" from task failures,
 * which is what the retry gate keys on. */
export class ImportUploadError extends Error {
  readonly kind: string
  readonly detected?: string

  constructor(kind: string, message: string, detected?: string) {
    super(message)
    this.name = "ImportUploadError"
    this.kind = kind
    this.detected = detected
  }
}

export function uploadFileToIngest(
  file: File,
  relativePath: string,
  onProgress?: (loaded: number, total: number) => void,
  options?: {
    /** Target knowledge base; the server rejects unknown ids. */
    knowledgeBaseId?: string
    /** Document folder name or registered id — unknown names self-register. */
    folder?: string
    /** PDF parser override: markitdown | marker | mineru | builtin-pdf.
     * Sent ONLY for files the client confirms are PDFs — TXT never carries
     * PDF settings, and an unconfirmed type rides without it (the server
     * decides; UT-23). */
    parser?: string
    /** Catalog tags; comma-joined into one header. */
    tags?: string[]
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const sentToken = accessToken
    xhr.open("POST", `${API_BASE}/ingest/file`)
    xhr.timeout = 120_000
    xhr.setRequestHeader("content-type", "application/octet-stream")
    // Header values must be Latin-1; paths are decoded by the server.
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name))
    const declaredMime = file.type || guessMimeFromExt(file.name)
    xhr.setRequestHeader("x-file-mime-type", declaredMime)
    xhr.setRequestHeader("x-source-kind", "file")
    xhr.setRequestHeader("x-source-id", encodeURIComponent(relativePath || file.name))
    xhr.setRequestHeader("x-source-namespace", "local-folder")
    if (options?.knowledgeBaseId) xhr.setRequestHeader("x-knowledge-base-id", options.knowledgeBaseId)
    // Header values must be Latin-1, and a folder name is usually Chinese: the
    // server decodes this the same way it decodes the file name.
    if (options?.folder) xhr.setRequestHeader("x-document-folder", encodeURIComponent(options.folder))
    // Same Latin-1 constraint for the advanced options: the parser value is
    // ASCII, tags go percent-encoded like the file name.
    if (options?.parser && isPdfLike(file.name, declaredMime)) {
      xhr.setRequestHeader("x-parser", options.parser)
    }
    if (options?.tags?.length) {
      xhr.setRequestHeader("x-document-tags", encodeURIComponent(options.tags.join(",")))
    }
    if (sentToken) xhr.setRequestHeader("Authorization", `Bearer ${sentToken}`)
    xhr.upload.onprogress = (event) => onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size)
    xhr.onload = () => {
      if (xhr.status === 401 && sentToken) onUnauthorized?.()
      if (xhr.status < 200 || xhr.status >= 300) {
        void parseUploadError(xhr.responseText, xhr.status).then(reject)
        return
      }
      try {
        const data = JSON.parse(xhr.responseText) as { docId?: string }
        resolve(data.docId ?? "")
      } catch {
        reject(new ImportUploadError("invalid_response", "上传响应无效"))
      }
    }
    xhr.onerror = () => reject(new ImportUploadError("network", "上传网络连接失败"))
    xhr.ontimeout = () => reject(new ImportUploadError("timeout", "上传超时，请检查网络后重试；如已开始处理，请先查看知识库文档"))
    xhr.onabort = () => reject(new DOMException("上传已取消", "AbortError"))
    xhr.send(file)
  })
}

/** Parse an admission rejection into a typed error: the structured kind and
 * byte-signature detection ride along when the body carries the contract
 * shape ({error:{kind,detected,message}}); anything else degrades to a
 * plain server error with the curated message. */
async function parseUploadError(responseText: string, status: number): Promise<ImportUploadError> {
  const fallback = await readError(new Response(responseText, { status: status || 500 })).catch(
    () => `HTTP ${status || 500}`,
  )
  try {
    const parsed = JSON.parse(responseText) as {
      error?: { kind?: unknown; detected?: unknown; message?: unknown }
    }
    const nested = parsed.error
    if (nested && typeof nested === "object" && typeof nested.kind === "string") {
      const message = typeof nested.message === "string" ? nested.message : fallback
      const detected = typeof nested.detected === "string" ? nested.detected : undefined
      return new ImportUploadError(nested.kind, message, detected)
    }
  } catch {
    // not JSON — fall through to the plain server error
  }
  return new ImportUploadError("server", fallback)
}

export interface IngestResumeResult {
  docId: string
  taskId: number
  status: string
  changed: boolean
}

/** UT-27: resume a server-accepted document by requeueing its ORIGINAL task
 * (POST /ingest/:docId/retry) — no re-upload, no new version, no File needed.
 * The server owns the semantics: a non-retryable state answers 409 with an
 * explainable message, which surfaces verbatim in the row. */
export async function resumeIngest(docId: string): Promise<IngestResumeResult> {
  const response = await apiFetch(`/ingest/${docId}/retry`, { method: "POST" })
  const body = await response.text().catch(() => "")
  let parsed: IngestResumeResult | null = null
  try {
    parsed = body ? (JSON.parse(body) as IngestResumeResult) : null
  } catch {
    parsed = null
  }
  if (response.status < 200 || response.status >= 300) {
    const message = await readError(new Response(body || response.statusText, { status: response.status }))
    throw new Error(message)
  }
  if (!parsed || !parsed.docId) throw new Error("恢复响应无效")
  return parsed
}

export async function submitUrlImport(
  url: string,
  mode: "single" | "sitemap",
  maxPages: number,
  knowledgeBaseId?: string,
  folder?: string,
): Promise<IngestSubmission> {
  const body = {
    url,
    mode,
    ...(mode === "sitemap" ? { maxPages } : {}),
    ...(knowledgeBaseId ? { knowledgeBaseId } : {}),
    ...(folder ? { folder } : {}),
  }
  const response = await apiFetch("/ingest/url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) {
    const err = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error || `HTTP ${response.status}`)
  }
  return (await response.json()) as IngestSubmission
}

export async function fetchIngestStatus(docId: string): Promise<IngestStatus> {
  const response = await apiFetch(`/ingest/${encodeURIComponent(docId)}/status`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`状态查询失败 HTTP ${response.status}`)
  return (await response.json()) as IngestStatus
}

export async function cancelIngest(docId: string): Promise<void> {
  await apiFetch(`/ingest/${encodeURIComponent(docId)}/cancel`, { method: "POST" })
}

// ---------------------------------------------------------------------------
// Ticket 22 (ATT-01): temporary session attachments. The session id is the
// thread id; the server scopes every read/write to (session, tenant, subject)
// and answers each file with its own status or its own typed rejection.
// ---------------------------------------------------------------------------

export type SessionAttachmentStatus = "parsing" | "ready" | "failed" | "promoted" | "retired"

export interface SessionAttachmentPayload {
  id: string
  sessionId: string
  name: string
  mimeType: string | null
  bytes: number
  status: SessionAttachmentStatus
  error: string | null
  promotedDocumentId: string | null
  promotedKnowledgeBaseId: string | null
}

export interface SessionAttachmentLimits {
  maxFiles: number
  maxFileBytes: number
  maxSessionBytes: number
  supportedExtensions: string[]
}

export interface SessionAttachmentList {
  attachments: SessionAttachmentPayload[]
  limits: SessionAttachmentLimits
  usage: { live: number; bytes: number }
}

/** A refused attachment carries the server's typed reason (limit, type, …). */
export class AttachmentRejectedError extends Error {
  constructor(message: string, readonly kind: string, readonly status: number) {
    super(message)
    this.name = "AttachmentRejectedError"
  }
}

async function attachmentError(response: Response): Promise<AttachmentRejectedError> {
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string | { kind?: string; message?: string }
  }
  if (payload.error && typeof payload.error === "object") {
    return new AttachmentRejectedError(
      payload.error.message || `附件被拒绝 (${response.status})`,
      payload.error.kind || "unknown",
      response.status,
    )
  }
  return new AttachmentRejectedError(
    typeof payload.error === "string" ? payload.error : `附件请求失败 (${response.status})`,
    "unknown",
    response.status,
  )
}

export async function uploadSessionAttachment(
  sessionId: string,
  file: File,
): Promise<SessionAttachmentPayload> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const response = await apiFetch(
    `/chat/sessions/${encodeURIComponent(sessionId)}/attachments`,
    {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(file.name),
        "x-file-mime-type": file.type || guessMimeFromExt(file.name),
      },
      body: bytes,
    },
  )
  if (!response.ok) throw await attachmentError(response)
  const data = (await response.json()) as { attachment: SessionAttachmentPayload }
  return data.attachment
}

export async function listSessionAttachments(sessionId: string): Promise<SessionAttachmentList> {
  const response = await apiFetch(`/chat/sessions/${encodeURIComponent(sessionId)}/attachments`)
  if (!response.ok) throw new Error(`附件列表加载失败 (${response.status})`)
  return (await response.json()) as SessionAttachmentList
}

export async function promoteSessionAttachment(
  sessionId: string,
  attachmentId: string,
  knowledgeBaseId: string,
): Promise<SessionAttachmentPayload> {
  const response = await apiFetch(
    `/chat/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}/promote`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ knowledgeBaseId }),
    },
  )
  if (!response.ok) throw await attachmentError(response)
  const data = (await response.json()) as { attachment: SessionAttachmentPayload }
  return data.attachment
}

export async function removeSessionAttachment(sessionId: string, attachmentId: string): Promise<void> {
  const response = await apiFetch(
    `/chat/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`,
    { method: "DELETE" },
  )
  if (!response.ok) throw await attachmentError(response)
}

export function guessMimeFromExt(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".")
  const ext = dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : ""
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream"
}

// ---------------------------------------------------------------------------
// Ticket 08 (KB-04): the knowledge-base workspace client. The server derives
// the tenant from the session (never the body); a reader's list contains only
// ACTIVE bases while an admin also sees archived ones.
// ---------------------------------------------------------------------------

export interface KnowledgeBasePayload {
  id: string
  tenantId: string
  name: string
  description: string
  status: "active" | "archived"
  embeddingProfile: string
  /** The folder this base is filed under, or null when ungrouped. */
  folderId: string | null
  createdAt: string
  updatedAt: string
}

/**
 * A knowledge-base folder. Grouping only: a folder is never sent as a retrieval
 * scope, and deleting one releases its members rather than touching them.
 */
export interface KnowledgeBaseFolderPayload {
  id: string
  tenantId: string
  name: string
  createdAt: string
  updatedAt: string
}

/** 400/403/404/409 with the server's message (e.g. archiving the default). */
export class KnowledgeBaseCommandError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = "KnowledgeBaseCommandError"
  }
}

async function knowledgeBaseCommand(
  path: string,
  method: "POST" | "PATCH",
  body?: unknown,
): Promise<KnowledgeBasePayload> {
  const response = await apiFetch(`/knowledge-bases${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string }
    throw new KnowledgeBaseCommandError(
      payload.error || `知识库操作失败 (${response.status})`,
      response.status,
    )
  }
  return ((await response.json()) as { knowledgeBase: KnowledgeBasePayload }).knowledgeBase
}

export async function fetchKnowledgeBases(): Promise<KnowledgeBasePayload[]> {
  const response = await apiFetch("/knowledge-bases")
  if (!response.ok) throw new Error(`知识库读取失败 (${response.status})`)
  const body = (await response.json()) as { knowledgeBases?: KnowledgeBasePayload[] }
  return Array.isArray(body.knowledgeBases) ? body.knowledgeBases : []
}

export function createKnowledgeBase(name: string, description?: string): Promise<KnowledgeBasePayload> {
  return knowledgeBaseCommand("", "POST", { name, ...(description ? { description } : {}) })
}

export function renameKnowledgeBase(id: string, name: string): Promise<KnowledgeBasePayload> {
  return knowledgeBaseCommand(`/${encodeURIComponent(id)}`, "PATCH", { name })
}

export function archiveKnowledgeBase(id: string): Promise<KnowledgeBasePayload> {
  return knowledgeBaseCommand(`/${encodeURIComponent(id)}/archive`, "POST")
}

export function restoreKnowledgeBase(id: string): Promise<KnowledgeBasePayload> {
  return knowledgeBaseCommand(`/${encodeURIComponent(id)}/restore`, "POST")
}

/** What one knowledge-base-wide wipe did. */
export interface KnowledgeBaseContentWipeResult {
  knowledgeBaseId: string
  sources: number
  retired: number
  alreadyRetired: number
  cleanupTasksQueued: number
}

/**
 * Retire every source of a knowledge base. Irreversible: the ES chunks, graph
 * relations, page-index nodes and unreferenced image assets are destroyed by the
 * background cleanup queue. The knowledge base itself, its metadata rows and the
 * retirement tombstones survive, so past citations stay traceable.
 *
 * A 200 means the cleanup was QUEUED, not that it finished.
 */
export async function retireKnowledgeBaseContents(
  id: string,
  reason: string,
): Promise<KnowledgeBaseContentWipeResult> {
  const response = await apiFetch(`/knowledge-bases/${encodeURIComponent(id)}/retire-contents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string }
    throw new KnowledgeBaseCommandError(
      payload.error || `清空知识库内容失败 (${response.status})`,
      response.status,
    )
  }
  return (await response.json()) as KnowledgeBaseContentWipeResult
}

/**
 * The folder workspace client. One helper for the whole surface because the
 * move route lives under `/knowledge-bases/:id/folder` (the server-side
 * operation needs both repositories) while the folder CRUD lives under its own
 * prefix — the caller passes the full path.
 */
async function folderRequest<T>(
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown,
  fallbackMessage = "知识库分类操作失败",
): Promise<T> {
  const response = await apiFetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string }
    throw new KnowledgeBaseCommandError(
      payload.error || `${fallbackMessage} (${response.status})`,
      response.status,
    )
  }
  return (await response.json()) as T
}

/**
 * One directory inside a knowledge base. `documents` is how many catalog-visible
 * documents carry its name, so an unfiled directory reads as 0 rather than
 * disappearing.
 */
export interface DocumentFolderPayload {
  id: string
  tenantId: string
  knowledgeBaseId: string
  name: string
  documents: number
  createdAt: string
  updatedAt: string
}

const DOCUMENT_FOLDER_FALLBACK = "文档分类操作失败"

export async function fetchDocumentFolders(
  knowledgeBaseId: string,
): Promise<DocumentFolderPayload[]> {
  const body = await folderRequest<{ folders?: DocumentFolderPayload[] }>(
    `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/document-folders`,
    "GET",
    undefined,
    DOCUMENT_FOLDER_FALLBACK,
  )
  return Array.isArray(body.folders) ? body.folders : []
}

/** Creating a name that already exists returns that folder rather than failing. */
export async function createDocumentFolder(
  knowledgeBaseId: string,
  name: string,
): Promise<DocumentFolderPayload> {
  const body = await folderRequest<{ folder: DocumentFolderPayload }>(
    `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/document-folders`,
    "POST",
    { name },
    DOCUMENT_FOLDER_FALLBACK,
  )
  return body.folder
}

/** Renaming moves every document inside it. */
export async function renameDocumentFolder(
  id: string,
  name: string,
): Promise<DocumentFolderPayload> {
  const body = await folderRequest<{ folder: DocumentFolderPayload }>(
    `/document-folders/${encodeURIComponent(id)}`,
    "PATCH",
    { name },
    DOCUMENT_FOLDER_FALLBACK,
  )
  return body.folder
}

/** What one cascade delete did. The cleanup it queues is still asynchronous. */
export interface DocumentFolderRemovalPayload {
  folderId: string
  documents: number
  sources: number
  retired: number
  alreadyRetired: number
  cleanupTasksQueued: number
}

/**
 * Delete a directory AND every document inside it. Irreversible: the documents
 * go through the same per-source retirement the catalog's delete button uses, so
 * the caller must have put a confirmation dialog in front of this already.
 */
export async function deleteDocumentFolder(
  id: string,
  reason: string,
): Promise<DocumentFolderRemovalPayload> {
  return folderRequest<DocumentFolderRemovalPayload>(
    `/document-folders/${encodeURIComponent(id)}`,
    "DELETE",
    { reason },
    DOCUMENT_FOLDER_FALLBACK,
  )
}

export async function fetchKnowledgeBaseFolders(): Promise<KnowledgeBaseFolderPayload[]> {
  const body = await folderRequest<{ folders?: KnowledgeBaseFolderPayload[] }>(
    "/knowledge-base-folders",
    "GET",
  )
  return Array.isArray(body.folders) ? body.folders : []
}

export async function createKnowledgeBaseFolder(name: string): Promise<KnowledgeBaseFolderPayload> {
  const body = await folderRequest<{ folder: KnowledgeBaseFolderPayload }>(
    "/knowledge-base-folders",
    "POST",
    { name },
  )
  return body.folder
}

export async function renameKnowledgeBaseFolder(
  id: string,
  name: string,
): Promise<KnowledgeBaseFolderPayload> {
  const body = await folderRequest<{ folder: KnowledgeBaseFolderPayload }>(
    `/knowledge-base-folders/${encodeURIComponent(id)}`,
    "PATCH",
    { name },
  )
  return body.folder
}

/** Deletes the folder; its members become ungrouped and stay active. */
export async function deleteKnowledgeBaseFolder(id: string): Promise<number> {
  const body = await folderRequest<{ ungrouped?: number }>(
    `/knowledge-base-folders/${encodeURIComponent(id)}`,
    "DELETE",
  )
  return body.ungrouped ?? 0
}

/** `null` takes the knowledge base out of every folder. */
export async function moveKnowledgeBaseToFolder(
  id: string,
  folderId: string | null,
): Promise<KnowledgeBasePayload> {
  const body = await folderRequest<{ knowledgeBase: KnowledgeBasePayload }>(
    `/knowledge-bases/${encodeURIComponent(id)}/folder`,
    "PATCH",
    { folderId },
  )
  return body.knowledgeBase
}

// ---------------------------------------------------------------------------
// Knowledge-base document catalog (ticket 11 DOC-01A)
// ---------------------------------------------------------------------------

export interface DocumentCatalogEntryPayload {
  docId: string
  sourceId: string
  title: string
  source: string
  fileName: string | null
  mimeType: string | null
  status: "pending" | "completed" | "failed" | "cancelled"
  candidateState: string
  version: number
  active: boolean
  tags: string[]
  folder: string | null
  retired: boolean
  createdAt: string
  updatedAt: string
}

export interface DocumentCatalogPayload {
  documents: DocumentCatalogEntryPayload[]
  total: number
  page: number
  pageSize: number
  tags: string[]
  folders: string[]
}

export interface DocumentCatalogView {
  page: number
  status: string
  tag: string
  folder: string
}

export async function fetchKnowledgeBaseDocuments(
  kbId: string,
  view: DocumentCatalogView,
  pageSize = 20,
): Promise<DocumentCatalogPayload> {
  const params = new URLSearchParams({
    page: String(view.page),
    pageSize: String(pageSize),
  })
  if (view.status) params.set("status", view.status)
  if (view.tag) params.set("tag", view.tag)
  if (view.folder) params.set("folder", view.folder)
  const response = await apiFetch(
    `/knowledge-bases/${encodeURIComponent(kbId)}/documents?${params.toString()}`,
  )
  if (!response.ok) throw new Error(`文档目录读取失败 (${response.status})`)
  const body = (await response.json()) as Partial<DocumentCatalogPayload>
  return {
    documents: Array.isArray(body.documents) ? body.documents : [],
    total: typeof body.total === "number" ? body.total : 0,
    page: typeof body.page === "number" ? body.page : view.page,
    pageSize: typeof body.pageSize === "number" ? body.pageSize : pageSize,
    tags: Array.isArray(body.tags) ? body.tags : [],
    folders: Array.isArray(body.folders) ? body.folders : [],
  }
}

// ---------------------------------------------------------------------------
// Document operations (ticket 12 DOC-01B) — administrators only
// ---------------------------------------------------------------------------

/** A shared error carrying the server's status for the operate endpoints. */
export class DocumentOperationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = "DocumentOperationError"
  }
}

async function documentCommand(docId: string, action: "retry" | "cancel" | "reprocess"): Promise<void> {
  const response = await apiFetch(`/ingest/${encodeURIComponent(docId)}/${action}`, { method: "POST" })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new DocumentOperationError(body.error || `操作失败 (${response.status})`, response.status)
  }
}

export function retryDocument(docId: string): Promise<void> {
  return documentCommand(docId, "retry")
}

export function cancelDocument(docId: string): Promise<void> {
  return documentCommand(docId, "cancel")
}

export function reprocessDocument(docId: string): Promise<void> {
  return documentCommand(docId, "reprocess")
}

/**
 * The document catalog's delete, named for the server command it runs: retiring
 * a whole source (all its versions) is what removes it from the knowledge base.
 * The reason is mandatory server-side because it lands in the tombstone.
 */
export async function retireSource(sourceId: string, reason: string): Promise<void> {
  const response = await apiFetch(`/sources/${encodeURIComponent(sourceId)}/retire`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new DocumentOperationError(body.error || `删除失败 (${response.status})`, response.status)
  }
}

export interface DocumentStatusPayload {
  documentStatus: string | null
  lifecycleOutcome: string | null
  spanTree: Array<{
    span: { name: string; status: string; errorMessage: string | null }
    children: unknown[]
  }>
}

/** Durable status/error detail for one document (the ingest status endpoint). */
export async function fetchDocumentStatus(docId: string): Promise<DocumentStatusPayload> {
  const response = await apiFetch(`/ingest/${encodeURIComponent(docId)}/status`)
  if (!response.ok) {
    throw new DocumentOperationError(`状态读取失败 (${response.status})`, response.status)
  }
  return (await response.json()) as DocumentStatusPayload
}

// ---------------------------------------------------------------------------
// Document version view (ticket 13 DOC-02) — catalog and citation paths
// ---------------------------------------------------------------------------

export interface DocumentVersionPayload {
  docId: string
  sourceId: string
  title: string
  source: string
  fileName: string | null
  mimeType: string
  status: string
  candidateState: string
  version: number
  active: boolean
  retired: boolean
  createdAt: string
  updatedAt: string
}

export interface DocumentSectionPayload {
  nodeId: string
  title: string
  sectionPath: string[]
  pageStart: number | null
  pageEnd: number | null
}

export interface DocumentDetailPayload {
  document: DocumentVersionPayload
  sections: DocumentSectionPayload[]
}

export interface DocumentPreviewPayload {
  available: boolean
  text?: string
  reason?: string
}

export interface DocumentChunkPayload {
  chunk: {
    chunkId: string
    kind: string
    index: number | null
    sectionPath: string[] | null
    page: number | null
    content: string
  }
  document: { docId: string; title: string; version: number; active: boolean; retired: boolean }
  neighbors: Array<{ chunkId: string; index: number | null; excerpt: string }>
}

export async function fetchDocumentDetail(docId: string): Promise<DocumentDetailPayload> {
  const response = await apiFetch(`/documents/${encodeURIComponent(docId)}`)
  if (!response.ok) throw new Error(`文档详情读取失败 (${response.status})`)
  return (await response.json()) as DocumentDetailPayload
}

export async function fetchDocumentPreview(docId: string): Promise<DocumentPreviewPayload> {
  const response = await apiFetch(`/documents/${encodeURIComponent(docId)}/preview`)
  if (!response.ok) throw new Error(`文档预览读取失败 (${response.status})`)
  return (await response.json()) as DocumentPreviewPayload
}

/** 410 means the chunk text is gone (retired cleanup) or not authorized. */
export async function fetchDocumentChunk(docId: string, chunkId: string): Promise<DocumentChunkPayload> {
  const response = await apiFetch(
    `/documents/${encodeURIComponent(docId)}/chunks/${encodeURIComponent(chunkId)}`,
  )
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new DocumentOperationError(body.error || `引用内容读取失败 (${response.status})`, response.status)
  }
  return (await response.json()) as DocumentChunkPayload
}

// ---------------------------------------------------------------------------
// Retrieval laboratory (ticket 15 RET-02) — read-only debug runs
// ---------------------------------------------------------------------------

export interface LabCandidatePayload {
  rank: number
  chunkId: string
  documentId: string
  title: string
  excerpt: string
  score: number | null
}

export interface LabStagePayload {
  channel: string
  ok: boolean
  error?: string
  elapsedMs: number
  candidates: LabCandidatePayload[]
}

export interface LabRunPayload {
  status: "ok" | "degraded" | "insufficient"
  ordering: { source: "dedicated_rerank" | "fused"; reason?: string } | null
  unavailableChannels: string[]
  unselectedChannels?: string[]
  degradationReasons?: string[]
  debug: {
    channels: LabStagePayload[]
    fused: {
      elapsedMs: number
      rawCandidateCount: number
      distinctCount: number
      candidates: LabCandidatePayload[]
    }
    rerank?: {
      applied: boolean
      reason?: string
      elapsedMs: number
      candidates?: LabCandidatePayload[]
    }
    totalMs: number
  } | null
}

/** A client-side timeout is its own distinct state (criterion 2). */
export class LabTimeoutError extends Error {
  constructor() {
    super("检索请求超时，请稍后重试或缩小范围")
    this.name = "LabTimeoutError"
  }
}

const LAB_TIMEOUT_MS = 45_000

export async function runRetrievalDebug(
  query: string,
  channels: string[],
): Promise<LabRunPayload> {
  const response = await apiFetch("/retrieval-debug", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, channels }),
    signal: AbortSignal.timeout(LAB_TIMEOUT_MS),
  }).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === "TimeoutError") throw new LabTimeoutError()
    throw error
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new DocumentOperationError(body.error || `检索调试失败 (${response.status})`, response.status)
  }
  return (await response.json()) as LabRunPayload
}

// ---------------------------------------------------------------------------
// Model profiles (ticket 16 MODEL-01A) — administrators only
// ---------------------------------------------------------------------------

export interface ModelProfilePayload {
  id: "chat" | "embedding" | "rerank"
  kind: "chat" | "embedding" | "rerank"
  model: string
  baseUrlHost: string
  dimensions?: number
  configured: boolean
  enabled: boolean
  selectable: boolean
}

export interface ModelProfileTestResult {
  ok: boolean
  latencyMs: number | null
  error: string | null
  hint: string | null
}

export async function fetchModelProfiles(): Promise<ModelProfilePayload[]> {
  const response = await apiFetch("/models/profiles")
  if (!response.ok) throw new Error(`模型配置读取失败 (${response.status})`)
  const body = (await response.json()) as { profiles?: ModelProfilePayload[] }
  return Array.isArray(body.profiles) ? body.profiles : []
}

export async function setModelProfileEnabled(
  id: string,
  enabled: boolean,
): Promise<ModelProfilePayload> {
  const response = await apiFetch(`/models/profiles/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; hint?: string }
    throw new DocumentOperationError(
      body.hint ? `${body.error} — ${body.hint}` : body.error || `操作失败 (${response.status})`,
      response.status,
    )
  }
  return (await response.json()) as { profile: ModelProfilePayload }["profile"]
}

export async function testModelProfile(id: string): Promise<ModelProfileTestResult> {
  const response = await apiFetch(`/models/profiles/${encodeURIComponent(id)}/test`, {
    method: "POST",
  })
  if (!response.ok) throw new DocumentOperationError(`测试失败 (${response.status})`, response.status)
  return (await response.json()) as ModelProfileTestResult
}

// ---------------------------------------------------------------------------
// Assistants workspace (ticket 18 AST-01A) — readers see safe metadata only
// ---------------------------------------------------------------------------

export interface AssistantConfigPayload {
  systemPrompt: string
  knowledgeBaseIds: string[]
  chatModelProfileId: string
  rerankModelProfileId: string | null
  toolPolicy: "none" | "read_only_retrieval"
  memoryEnabled: boolean
}

export interface AssistantPayload {
  id: string
  name: string
  description: string
  status: "active" | "archived"
  /** Sidebar curation; absent on stale payloads = shown (pre-column behavior). */
  sidebarVisible?: boolean
  currentVersion: number
  createdAt: string
  updatedAt: string
  /** Admin only — readers never receive the execution config. */
  allowedGroups?: string[]
  config?: AssistantConfigPayload
  version?: { version: number; createdAt: string; createdBy: string }
}

export async function fetchAssistants(): Promise<AssistantPayload[]> {
  const response = await apiFetch("/assistants")
  if (!response.ok) throw new Error(`助手列表读取失败 (${response.status})`)
  const body = (await response.json()) as { assistants?: AssistantPayload[] }
  return Array.isArray(body.assistants) ? body.assistants : []
}

export interface AssistantCommandInput {
  name: string
  description?: string
  allowedGroups?: string[]
  config: AssistantConfigPayload
}

export async function createAssistant(input: AssistantCommandInput): Promise<AssistantPayload> {
  const response = await apiFetch("/assistants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new DocumentOperationError(body.error || `创建失败 (${response.status})`, response.status)
  }
  return (await response.json()) as { assistant: AssistantPayload }["assistant"]
}

export async function editAssistant(
  id: string,
  input: Partial<AssistantCommandInput>,
): Promise<AssistantPayload> {
  const response = await apiFetch(`/assistants/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new DocumentOperationError(body.error || `保存失败 (${response.status})`, response.status)
  }
  return (await response.json()) as { assistant: AssistantPayload }["assistant"]
}

export async function archiveAssistant(id: string): Promise<AssistantPayload> {
  const response = await apiFetch(`/assistants/${encodeURIComponent(id)}/archive`, { method: "POST" })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new DocumentOperationError(body.error || `归档失败 (${response.status})`, response.status)
  }
  return (await response.json()) as { assistant: AssistantPayload }["assistant"]
}

export async function restoreAssistant(id: string): Promise<AssistantPayload> {
  const response = await apiFetch(`/assistants/${encodeURIComponent(id)}/restore`, { method: "POST" })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new DocumentOperationError(body.error || `恢复失败 (${response.status})`, response.status)
  }
  return (await response.json()) as { assistant: AssistantPayload }["assistant"]
}

/** Physical delete — custom assistants only; the server refuses the default with 409. */
export async function deleteAssistant(id: string): Promise<void> {
  const response = await apiFetch(`/assistants/${encodeURIComponent(id)}`, { method: "DELETE" })
  if (!response.ok && response.status !== 404) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new DocumentOperationError(body.error || `删除失败 (${response.status})`, response.status)
  }
}

/** Sidebar curation toggle — server refuses the default assistant with 409. */
export async function setAssistantSidebarVisible(id: string, visible: boolean): Promise<AssistantPayload> {
  const response = await apiFetch(`/assistants/${encodeURIComponent(id)}/sidebar-visible`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ visible }),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new DocumentOperationError(body.error || `更新侧边栏显示失败 (${response.status})`, response.status)
  }
  return (await response.json()) as { assistant: AssistantPayload }["assistant"]
}

// ---------------------------------------------------------------------------
// Server-owned conversation history (ticket 20 CONV-01A)
// ---------------------------------------------------------------------------

export interface ConversationDirectoryPayload {
  id: string
  title: string
  imported: boolean
  createdAt: string
  updatedAt: string
  messageCount: number
}

export interface HistoryTurnPayload {
  role: "user" | "assistant"
  content: string
  runId: string
  terminalStatus: string | null
  createdAt: string
}

export async function fetchConversationDirectories(): Promise<ConversationDirectoryPayload[]> {
  const response = await apiFetch("/conversations")
  if (!response.ok) throw new Error(`会话目录读取失败 (${response.status})`)
  const body = (await response.json()) as { directories?: ConversationDirectoryPayload[] }
  return Array.isArray(body.directories) ? body.directories : []
}

export async function fetchConversationHistory(
  id: string,
): Promise<HistoryTurnPayload[]> {
  const response = await apiFetch(`/conversations/${encodeURIComponent(id)}`)
  if (!response.ok) throw new Error(`会话历史读取失败 (${response.status})`)
  const body = (await response.json()) as { turns?: HistoryTurnPayload[] }
  return Array.isArray(body.turns) ? body.turns : []
}

export interface ImportThreadInput {
  id: string
  title?: string
  messages?: Array<{ role: "user" | "assistant"; content: string }>
}

/**
 * One-time import of browser-local threads. Idempotent by thread id — a
 * repeated call only reports the already-imported ones as skipped; browser
 * local storage is never cleared by the server.
 */
export async function importConversations(
  threads: ImportThreadInput[],
): Promise<{ imported: number; skipped: number }> {
  const response = await apiFetch("/conversations/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threads }),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new DocumentOperationError(body.error || `导入失败 (${response.status})`, response.status)
  }
  return (await response.json()) as { imported: number; skipped: number }
}

// ---------------------------------------------------------------------------
// Long-term memories (ticket 32, MEM-01A) — user-owned durable preferences.
// The server owns the list; the browser never seeds or persists it.
// ---------------------------------------------------------------------------

export interface ServerMemory {
  id: string
  /** null → applies across the user's assistants; otherwise pinned. */
  assistantId: string | null
  content: string
  createdAt: string
  updatedAt: string
}

export async function fetchMemories(): Promise<ServerMemory[]> {
  const response = await apiFetch("/memories")
  if (!response.ok) throw new Error(`记忆读取失败 (${response.status})`)
  const body = (await response.json()) as { memories?: ServerMemory[] }
  return Array.isArray(body.memories) ? body.memories : []
}

export async function createMemory(content: string, assistantId?: string): Promise<ServerMemory> {
  const response = await apiFetch("/memories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, ...(assistantId ? { assistantId } : {}) }),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `记忆添加失败 (${response.status})`)
  }
  return ((await response.json()) as { memory: ServerMemory }).memory
}

export async function updateMemory(id: string, content: string): Promise<ServerMemory> {
  const response = await apiFetch(`/memories/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `记忆更新失败 (${response.status})`)
  }
  return ((await response.json()) as { memory: ServerMemory }).memory
}

export async function forgetMemory(id: string): Promise<void> {
  const response = await apiFetch(`/memories/${encodeURIComponent(id)}`, { method: "DELETE" })
  if (!response.ok && response.status !== 404) {
    throw new Error(`记忆删除失败 (${response.status})`)
  }
}

export async function forgetAllMemories(): Promise<number> {
  const response = await apiFetch("/memories", { method: "DELETE" })
  if (!response.ok) throw new Error(`记忆清空失败 (${response.status})`)
  return ((await response.json()) as { forgotten: number }).forgotten
}

// ---------------------------------------------------------------------------
// Memory extraction suggestions (ticket 33, MEM-01B) — the review queue.
// ---------------------------------------------------------------------------

export type MemorySuggestionStatus = "pending" | "accepted" | "dismissed"

export interface ServerMemorySuggestion {
  id: string
  assistantId: string | null
  sourceRunId: string
  content: string
  status: MemorySuggestionStatus
  createdAt: string
}

export async function fetchMemorySuggestions(
  status: MemorySuggestionStatus = "pending",
): Promise<ServerMemorySuggestion[]> {
  const response = await apiFetch(`/memory-suggestions?status=${encodeURIComponent(status)}`)
  if (!response.ok) throw new Error(`记忆建议读取失败 (${response.status})`)
  const body = (await response.json()) as { suggestions?: ServerMemorySuggestion[] }
  return Array.isArray(body.suggestions) ? body.suggestions : []
}

export async function acceptMemorySuggestion(id: string): Promise<void> {
  const response = await apiFetch(`/memory-suggestions/${encodeURIComponent(id)}/accept`, {
    method: "POST",
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `记忆建议采纳失败 (${response.status})`)
  }
}

export async function dismissMemorySuggestion(id: string): Promise<void> {
  const response = await apiFetch(`/memory-suggestions/${encodeURIComponent(id)}/dismiss`, {
    method: "POST",
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `记忆建议忽略失败 (${response.status})`)
  }
}

// ---------------------------------------------------------------------------
// Ticket 37 (GRAPH-01): knowledge-scoped graph browse (read-only)
// ---------------------------------------------------------------------------

export interface GraphEntityPayload {
  name: string
  type: string
  aliases: string[]
  relationCount: number
}

export interface GraphProvenancePayload {
  documentId: string
  chunkId: string
  available: boolean
  title?: string
  documentVersion?: number
}

export interface GraphRelationPayload {
  sourceName: string
  targetName: string
  relation: string
  weight: number
  provenance: GraphProvenancePayload[]
}

export interface GraphEntitiesPayload {
  entities: GraphEntityPayload[]
  page: { limit: number; offset: number; truncated: boolean }
}

export interface GraphRelationsPayload {
  entity: { name: string; type: string; aliases: string[] }
  relations: GraphRelationPayload[]
  page: { limit: number; offset: number; truncated: boolean; outOfScopeRows?: number }
}

export async function fetchGraphEntities(
  kbId: string,
  view: { query?: string; limit?: number; offset?: number } = {},
): Promise<GraphEntitiesPayload> {
  const params = new URLSearchParams()
  if (view.query) params.set("query", view.query)
  if (view.limit !== undefined) params.set("limit", String(view.limit))
  if (view.offset !== undefined) params.set("offset", String(view.offset))
  const response = await apiFetch(
    `/knowledge-bases/${encodeURIComponent(kbId)}/graph/entities?${params.toString()}`,
  )
  if (!response.ok) throw new Error(`图谱实体读取失败 (${response.status})`)
  const body = (await response.json()) as Partial<GraphEntitiesPayload>
  return {
    entities: Array.isArray(body.entities) ? body.entities : [],
    page: body.page ?? { limit: view.limit ?? 20, offset: view.offset ?? 0, truncated: false },
  }
}

export async function fetchGraphRelations(
  kbId: string,
  entity: string,
  view: { limit?: number; offset?: number } = {},
): Promise<GraphRelationsPayload> {
  const params = new URLSearchParams({ entity })
  if (view.limit !== undefined) params.set("limit", String(view.limit))
  if (view.offset !== undefined) params.set("offset", String(view.offset))
  const response = await apiFetch(
    `/knowledge-bases/${encodeURIComponent(kbId)}/graph/relations?${params.toString()}`,
  )
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `图谱关系读取失败 (${response.status})`)
  }
  const body = (await response.json()) as Partial<GraphRelationsPayload>
  return {
    entity: body.entity ?? { name: entity, type: "", aliases: [] },
    relations: Array.isArray(body.relations) ? body.relations : [],
    page: body.page ?? { limit: view.limit ?? 20, offset: view.offset ?? 0, truncated: false },
  }
}

// ---------------------------------------------------------------------------
// Knowledge-base Wiki pages, revisions and background generation jobs.
// ---------------------------------------------------------------------------

export interface WikiPagePayload {
  id: string
  tenantId: string
  knowledgeBaseId: string
  slug: string
  title: string
  pageType: string
  status: "draft" | "published" | "archived"
  content: string
  summary: string
  aliases: string[]
  folderId: string
  sourceRefs: string[]
  chunkRefs: string[]
  inLinks: string[]
  outLinks: string[]
  version: number
  lastEditSource: "pipeline" | "user" | "agent" | "revert"
  createdAt: string
  updatedAt: string
}

export interface WikiRevisionPayload {
  pageId: string
  version: number
  title: string
  content: string
  summary: string
  status: WikiPagePayload["status"]
  sourceRefs: string[]
  chunkRefs: string[]
  editSource: WikiPagePayload["lastEditSource"]
  createdAt: string
}

export interface WikiProposalPayload {
  pageId: string
  baseVersion: number
  title: string
  content: string
  summary: string
  sourceRefs: string[]
  chunkRefs: string[]
  createdAt: string
}

export interface WikiFolderPayload {
  id: string
  parentId: string
  name: string
  sortOrder: number
}

export interface WikiJobPayload {
  id: number
  documentId: string
  op: "ingest" | "retract"
  status: "pending" | "running" | "completed" | "failed"
  attempts: number
  error: string | null
  updatedAt: string
}

export interface WikiIssuePayload {
  id: string
  pageId: string
  kind: string
  message: string
  status: string
}

async function wikiRequest<T>(kbId: string, path: string, method = "GET",
  payload?: unknown): Promise<T> {
  const response = await apiFetch(
    `/knowledge-bases/${encodeURIComponent(kbId)}/wiki${path}`,
    { method, ...(payload === undefined ? {} : {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    }) },
  )
  const body = (await response.json().catch(() => ({}))) as { error?: string }
  if (!response.ok) {
    throw new Error(body.error || `Wiki 请求失败 (${response.status})`)
  }
  return body as T
}

export const wikiApi = {
  agent: (kbId: string, message: string) => wikiRequest<{
    reply: string; toolCalls: Array<{ tool: string; outcome: string }>; stoppedBy: string
  }>(kbId, "/agent", "POST", { message }),
  settings: (kbId: string) => wikiRequest<{ enabled: boolean }>(kbId, "/settings"),
  setEnabled: (kbId: string, enabled: boolean) =>
    wikiRequest<{ enabled: boolean }>(kbId, "/settings", "PUT", { enabled }),
  rebuild: (kbId: string) =>
    wikiRequest<{ enqueued: number }>(kbId, "/rebuild", "POST"),
  pages: (kbId: string, query = "", includeArchived = false, offset = 0, limit = 100) =>
    wikiRequest<{ pages: WikiPagePayload[]; total: number; offset: number; limit: number }>(kbId,
      `/pages?q=${encodeURIComponent(query)}&includeArchived=${includeArchived}&offset=${offset}&limit=${limit}`),
  index: (kbId: string) => wikiRequest<{ groups: Array<{ type: string; pages: Array<{
    slug: string; title: string; summary: string; folderId: string
  }> }> }>(kbId, "/index"),
  page: (kbId: string, slug: string) =>
    wikiRequest<{ page: WikiPagePayload; proposal: WikiProposalPayload | null;
      sources: Array<{ id: string; title: string }> }>(
      kbId, `/pages/${encodeURIComponent(slug)}`),
  createPage: (kbId: string, data: { slug: string; title: string; content: string }) =>
    wikiRequest<{ page: WikiPagePayload }>(kbId, "/pages", "POST", data),
  updatePage: (kbId: string, slug: string, data: Partial<WikiPagePayload> & {
    expectedVersion: number
  }) => wikiRequest<{ page: WikiPagePayload }>(
    kbId, `/pages/${encodeURIComponent(slug)}`, "PATCH", data),
  archivePage: (kbId: string, slug: string) =>
    wikiRequest<{ page: WikiPagePayload }>(kbId, `/pages/${encodeURIComponent(slug)}`, "DELETE"),
  revisions: (kbId: string, slug: string) =>
    wikiRequest<{ revisions: WikiRevisionPayload[] }>(kbId,
      `/pages/${encodeURIComponent(slug)}/revisions`),
  revert: (kbId: string, slug: string, version: number) =>
    wikiRequest<{ page: WikiPagePayload }>(kbId,
      `/pages/${encodeURIComponent(slug)}/revert`, "POST", { version }),
  acceptProposal: (kbId: string, slug: string) =>
    wikiRequest<{ page: WikiPagePayload }>(kbId,
      `/pages/${encodeURIComponent(slug)}/accept-proposal`, "POST"),
  folders: (kbId: string) =>
    wikiRequest<{ folders: WikiFolderPayload[] }>(kbId, "/folders"),
  createFolder: (kbId: string, name: string, parentId = "") =>
    wikiRequest<{ folder: WikiFolderPayload }>(kbId, "/folders", "POST", { name, parentId }),
  updateFolder: (kbId: string, id: string, name: string, parentId = "") =>
    wikiRequest<{ status: string }>(kbId, `/folders/${encodeURIComponent(id)}`,
      "PATCH", { name, parentId }),
  deleteFolder: (kbId: string, id: string) =>
    wikiRequest<{ status: string }>(kbId, `/folders/${encodeURIComponent(id)}`, "DELETE"),
  movePage: (kbId: string, slug: string, folderId: string) =>
    wikiRequest<{ status: string }>(kbId,
      `/pages/${encodeURIComponent(slug)}/move`, "POST", { folderId }),
  graph: (kbId: string) => wikiRequest<{ nodes: Array<{
    slug: string; title: string; pageType: string
  }>; edges: Array<{ source: string; target: string }> }>(kbId, "/graph"),
  lint: (kbId: string) => wikiRequest<{ findings: Array<{
    slug: string; kind: string; target?: string
  }> }>(kbId, "/lint"),
  issues: (kbId: string) => wikiRequest<{ issues: WikiIssuePayload[] }>(kbId, "/issues"),
  createIssue: (kbId: string, slug: string, message: string, kind = "content") =>
    wikiRequest<{ issue: WikiIssuePayload }>(kbId,
      `/pages/${encodeURIComponent(slug)}/issues`, "POST", { message, kind }),
  updateIssue: (kbId: string, id: string, status: string) =>
    wikiRequest<{ status: string }>(kbId, `/issues/${encodeURIComponent(id)}`,
      "PATCH", { status }),
  jobs: (kbId: string) => wikiRequest<{ jobs: WikiJobPayload[] }>(kbId, "/jobs"),
  retryJob: (kbId: string, id: number) =>
    wikiRequest<{ status: string }>(kbId, `/jobs/${id}/retry`, "POST"),
}

// ---------------------------------------------------------------------------
// Ticket 39 (SYNC-01A): URL/sitemap sync data sources (admin, read + operate)
// ---------------------------------------------------------------------------

export interface SyncDataSourcePayload {
  id: string
  knowledgeBaseId: string
  kind: "url" | "sitemap"
  uri: string
  interval: "manual" | "1h" | "6h" | "24h"
  state: "active" | "paused"
  title: string
  lastSyncAt: string | null
  lastSyncStatus: string | null
  createdAt: string
}

export interface SyncRunReportPayload {
  dataSourceId: string
  kind: "url" | "sitemap"
  pages: Array<{
    uri: string
    status: "submitted" | "unchanged" | "failed"
    detail?: string
    documentId?: string
    version?: number
  }>
  truncated?: boolean
}

export async function fetchSyncSources(kbId: string): Promise<SyncDataSourcePayload[]> {
  const response = await apiFetch(`/knowledge-bases/${encodeURIComponent(kbId)}/sync-data-sources`)
  if (!response.ok) throw new Error(`同步源读取失败 (${response.status})`)
  const body = (await response.json()) as { sources?: SyncDataSourcePayload[] }
  return Array.isArray(body.sources) ? body.sources : []
}

export async function createSyncSource(
  kbId: string,
  input: { kind: "url" | "sitemap"; uri: string; interval?: string; title?: string },
): Promise<SyncDataSourcePayload> {
  const response = await apiFetch(`/knowledge-bases/${encodeURIComponent(kbId)}/sync-data-sources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  const body = (await response.json().catch(() => ({}))) as {
    source?: SyncDataSourcePayload
    error?: string
  }
  if (!response.ok || !body.source) {
    throw new Error(body.error || `同步源创建失败 (${response.status})`)
  }
  return body.source
}

export async function updateSyncSource(
  id: string,
  patch: { interval?: string; state?: "active" | "paused" },
): Promise<SyncDataSourcePayload> {
  const response = await apiFetch(`/sync-data-sources/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  })
  const body = (await response.json().catch(() => ({}))) as {
    source?: SyncDataSourcePayload
    error?: string
  }
  if (!response.ok || !body.source) {
    throw new Error(body.error || `同步源更新失败 (${response.status})`)
  }
  return body.source
}

export async function deleteSyncSource(id: string): Promise<void> {
  const response = await apiFetch(`/sync-data-sources/${encodeURIComponent(id)}`, {
    method: "DELETE",
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `同步源删除失败 (${response.status})`)
  }
}

export async function runSyncSource(id: string): Promise<SyncRunReportPayload> {
  const response = await apiFetch(`/sync-data-sources/${encodeURIComponent(id)}/run`, {
    method: "POST",
  })
  const body = (await response.json().catch(() => ({}))) as {
    report?: SyncRunReportPayload
    error?: string
  }
  if (!response.ok || !body.report) {
    throw new Error(body.error || `同步执行失败 (${response.status})`)
  }
  return body.report
}
