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
  maxCasesPerTask: number
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
  config: { chatModel: string; rerankModel: string | null; embeddingModel: string; rerankSource: string }
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
}

/**
 * Rejected request (400/429). `issues` carries the server's per-field/per-case
 * messages so the page can point at the offending entry (ticket 05).
 */
export class EvaluationRequestError extends Error {
  constructor(message: string, readonly issues: string[] = []) {
    super(message)
    this.name = "EvaluationRequestError"
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
    throw new EvaluationRequestError(body.error || `评测任务提交失败 (${response.status})`, issues)
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

export async function fetchRunHistory(runId: string): Promise<RunHistory> {
  const response = await apiFetch(`/chat/runs/${encodeURIComponent(runId)}`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return (await response.json()) as RunHistory
}

export interface ChatRequestBody {
  message: string
  runId: string
  sessionId: string
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

  if (!response.ok) throw new Error(`服务器错误 (${response.status})`)
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

export function guessMimeFromExt(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".")
  const ext = dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : ""
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream"
}
