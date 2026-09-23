import type { RunHistory, SseEventData } from "@core/conversation"

import { MIME_BY_EXTENSION } from "./constants"

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
  responseTimeMs?: number
  error?: string
}

export interface StatusPayload {
  checkedAt: string
  hasKnowledgeBaseContent?: boolean
  channels: {
    elasticsearch: StatusChannel
    neo4j: StatusChannel
    openai: StatusChannel
  }
  config?: {
    esNode?: string
    neo4jUri?: string
    openaiBaseUrl?: string
    openaiChatModel?: string
  }
}

export interface IngestSubmission {
  docId?: string
  submitted?: number
  items?: Array<{ url: string; docId?: string; status?: string }>
}

export interface IngestStatus {
  status?: string
  error?: string
}

async function readError(response: Response): Promise<string> {
  const body = await response.text().catch(() => "")
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

export async function uploadFileToIngest(file: File, relativePath: string): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const response = await apiFetch("/ingest/file", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-name": file.name,
      "x-file-mime-type": file.type || guessMimeFromExt(file.name),
      "x-source-kind": "file",
      "x-source-id": relativePath || file.name,
      "x-source-namespace": "local-folder",
    },
    body: bytes,
  })
  if (!response.ok) throw new Error(await readError(response))
  const data = (await response.json()) as { docId?: string }
  return data.docId ?? ""
}

export async function submitUrlImport(
  url: string,
  mode: "single" | "sitemap",
  maxPages: number,
): Promise<IngestSubmission> {
  const body = mode === "sitemap" ? { url, mode, maxPages } : { url, mode }
  const response = await apiFetch("/ingest/url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const err = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error || `HTTP ${response.status}`)
  }
  return (await response.json()) as IngestSubmission
}

export async function fetchIngestStatus(docId: string): Promise<IngestStatus> {
  const response = await apiFetch(`/ingest/${encodeURIComponent(docId)}/status`)
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
        "x-file-name": file.name,
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
  return (await response.json()) as KnowledgeBasePayload
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

/** Retire a whole source (all its versions) with a required reason. */
export async function retireSource(sourceId: string, reason: string): Promise<void> {
  const response = await apiFetch(`/sources/${encodeURIComponent(sourceId)}/retire`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new DocumentOperationError(body.error || `退役失败 (${response.status})`, response.status)
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
// Ticket 38 (WIKI-01): generate, validate, publish and restore Wiki pages
// ---------------------------------------------------------------------------

export interface WikiSourceCandidatePayload {
  documentId: string
  title: string
  version: number
  updatedAt: string
}

export interface WikiSourceStalenessPayload {
  documentId: string
  version: number
  title: string
  stale: "missing" | "updated" | "retired" | null
  currentVersion?: number
}

export interface WikiPagePayload {
  documentId: string
  title: string
  version: number
  active: boolean
  updatedAt: string
  sources: WikiSourceStalenessPayload[]
  versions: Array<{ documentId: string; version: number; createdAt: string; active: boolean }>
}

export interface WikiPublishedPayload {
  status: "published"
  documentId: string
  ingestion: string
  version: number
  title: string
  sources: Array<{ documentId: string; version: number; title: string }>
}

export async function fetchWikiSources(kbId: string): Promise<WikiSourceCandidatePayload[]> {
  const response = await apiFetch(`/knowledge-bases/${encodeURIComponent(kbId)}/wiki/sources`)
  if (!response.ok) throw new Error(`Wiki 来源读取失败 (${response.status})`)
  const body = (await response.json()) as { sources?: WikiSourceCandidatePayload[] }
  return Array.isArray(body.sources) ? body.sources : []
}

export async function fetchWikiPages(kbId: string): Promise<WikiPagePayload[]> {
  const response = await apiFetch(`/knowledge-bases/${encodeURIComponent(kbId)}/wiki/pages`)
  if (!response.ok) throw new Error(`Wiki 页面读取失败 (${response.status})`)
  const body = (await response.json()) as { pages?: WikiPagePayload[] }
  return Array.isArray(body.pages) ? body.pages : []
}

export async function generateWikiPage(
  kbId: string,
  title: string,
  documentIds: string[],
): Promise<WikiPublishedPayload> {
  const response = await apiFetch(`/knowledge-bases/${encodeURIComponent(kbId)}/wiki/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, documentIds }),
  })
  const body = (await response.json().catch(() => ({}))) as {
    status?: string
    reasons?: string[]
    error?: string
  }
  if (!response.ok) {
    if (response.status === 422 && Array.isArray(body.reasons)) {
      throw new Error(`生成结果未通过校验：${body.reasons.join("；")}`)
    }
    throw new Error(body.error || `Wiki 生成失败 (${response.status})`)
  }
  return body as unknown as WikiPublishedPayload
}

export async function restoreWikiPage(kbId: string, docId: string): Promise<{ version: number }> {
  const response = await apiFetch(
    `/knowledge-bases/${encodeURIComponent(kbId)}/wiki/pages/${encodeURIComponent(docId)}/restore`,
    { method: "POST" },
  )
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `Wiki 页面恢复失败 (${response.status})`)
  }
  return (await response.json()) as { version: number }
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
