import type { IngestSpanNode, IngestStatus } from "./api"

export type ImportStatus =
  | "queued"
  | "uploading"
  | "pending"
  | "processing"
  | "completed"
  | /** UT-26: content-integrity hold — the candidate did not activate. */ "pending_review"
  | /** UT-26: held for business approval (ACTIVATION_MODE=review). */ "business_review"
  | "failed"
  | "cancelled"

/** UT-26: the structured end-state of a polled document, derived ONLY from
 * the backend's own fields (activationBlockReason / candidateState / failure
 * / documentVersion) — never from heuristics like extraction length. */
export type ImportOutcomeState =
  | "completed"
  | "pending_review"
  | "business_review"
  | "capability_missing"
  | "failed"
  | "cancelled"

export interface ImportOutcome {
  state: ImportOutcomeState
  /** Stable activation-gate reason codes (raw, ";"-joined upstream). */
  blockReasons: string[]
  /** Machine-readable operations the server allows for this failure. */
  allowedOperations: string[]
  /** A prior version remains active — the blocked candidate replaced nothing
   * usable. Only claimed when a previous version actually exists (version > 1). */
  oldVersionUsable: boolean
}

/** Stable activation-gate reason codes → explainable copy (UT-26); unknown
 * codes pass through verbatim so new server reasons never render as blank. */
const ACTIVATION_REASON_TEXT: Record<string, string> = {
  activation_content_proof_pending_review: "内容完整性待校验（复杂或存在疑点的文件不会静默替换现有版本）",
  activation_index_proof_failed: "索引核验未通过（写入内容与来源不一致）",
  activation_proof_binding_mismatch: "完整性凭证与期望产物不一致",
  activation_not_searchable: "索引尚不可检索",
  activation_evidence_record_missing: "完整性证据缺失",
  activation_content_proof_missing: "内容完整性凭证缺失",
  activation_index_proof_missing: "索引核验凭证缺失",
  activation_evidence_schema_mismatch: "完整性证据格式不匹配",
  activation_gate_verification_not_implemented: "核验未实现",
}

export function describeActivationReasons(reasons: ReadonlyArray<string>): string[] {
  return reasons.map((reason) => ACTIVATION_REASON_TEXT[reason] ?? reason)
}

/** Machine-readable failure operations → explainable copy (UT-26). */
const ALLOWED_OPERATION_TEXT: Record<string, string> = {
  configure_parser_then_retry: "配置解析器后可恢复",
  fix_input_then_retry: "修正输入后可恢复",
  wait_for_auto_retry: "等待自动重试",
  cancel: "可取消",
}

export function describeAllowedOperations(operations: ReadonlyArray<string>): string[] {
  return operations.map((operation) => ALLOWED_OPERATION_TEXT[operation] ?? operation)
}

const STAGES = [
  { name: "chunk", label: "解析与切分", shortLabel: "解析" },
  { name: "wikify", label: "实体与关联准备", shortLabel: "关联" },
  { name: "storeChunks", label: "向量与索引写入", shortLabel: "向量" },
  { name: "storeGraph", label: "关联数据写入", shortLabel: "图谱" },
] as const

export interface UploadProgress {
  loaded: number
  total: number
  startedAt: number
  updatedAt: number
}

export interface ImportStep {
  name: string
  label: string
  status: IngestSpanNode["span"]["status"]
}

export function estimateUploadRemainingMs(upload: UploadProgress, now: number): number | null {
  const elapsed = upload.updatedAt - upload.startedAt
  if (upload.total <= 0 || upload.loaded <= 0 || upload.loaded >= upload.total ||
    elapsed < 800 || now - upload.updatedAt > 5_000) return null
  const remaining = (upload.total - upload.loaded) * elapsed / upload.loaded
  return Number.isFinite(remaining) && remaining > 0 ? Math.min(remaining, 24 * 60 * 60 * 1_000) : null
}

const STAGE_ESTIMATE_MS: Record<string, number> = {
  chunk: 5_000, wikify: 12_000, storeChunks: 15_000, storeGraph: 4_000,
}

export function estimateImportRemainingMs(
  progress: ImportProgress,
  processingStartedAt: number | undefined,
  now: number,
  fileSize: number,
): number | null {
  if (!processingStartedAt || progress.status !== "processing") return null
  const sizeFactor = Math.max(0.5, Math.min(4, fileSize / 1_000_000 || 1))
  const estimated = progress.stages.reduce((remaining, stage) => {
    if (stage.status === "done" || stage.status === "skipped") return remaining
    return remaining + STAGE_ESTIMATE_MS[stage.name] * sizeFactor
  }, 0)
  const completedDuration = progress.stages.reduce((elapsed, stage) =>
    elapsed + (stage.status === "done" ? stage.durationMs ?? 0 : 0), 0)
  const currentElapsed = Math.max(0, now - processingStartedAt - completedDuration)
  const remaining = estimated - currentElapsed
  return remaining > 0 ? remaining : null
}

export function buildImportSteps(progress: ImportProgress, isLocal: boolean, uploaded: boolean): ImportStep[] {
  const stages = STAGES.map(({ name, shortLabel }) => ({
    name,
    label: shortLabel,
    status: progress.stages.find((stage) => stage.name === name)?.status ?? "pending" as ImportStep["status"],
  }))
  if (progress.status === "completed" && progress.stages.every((stage) => stage.status === "pending")) {
    stages.forEach((stage) => { stage.status = "skipped" })
  }
  if (progress.status === "failed" && !stages.some((stage) => stage.status === "failed") && (uploaded || !isLocal)) {
    const firstPending = stages.find((stage) => stage.status === "pending")
    if (firstPending) firstPending.status = "failed"
  }
  if (!isLocal) return stages
  const uploadStatus: ImportStep["status"] = uploaded ? "done"
    : progress.status === "failed" ? "failed"
    : progress.status === "cancelled" ? "cancelled"
    : progress.status === "uploading" ? "running" : "pending"
  return [{ name: "upload", label: "上传", status: uploadStatus }, ...stages]
}

export interface ImportProgress {
  status: ImportStatus
  percent: number | null
  summary: string
  error: string | null
  /** UT-26: structured end-state (null while the row is still in flight). */
  outcome: ImportOutcome | null
  stages: Array<{
    name: string
    label: string
    status: IngestSpanNode["span"]["status"]
    durationMs: number | null
    output: Record<string, unknown> | null
  }>
  parser: string | null
  chunkCount: number | null
  retryCount: number
  retryAt: string | null
  embeddingRateLimitCount: number
  rateLimitWaitMs: number
}

function numberOutput(output: Record<string, unknown> | null, key: string): number {
  const value = output?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

export function deriveIngestProgress(payload: IngestStatus): ImportProgress {
  // Every retry appends another root. Progress belongs to the latest attempt.
  const latestRoot = payload.spanTree.filter((node) => node.span.name === "ingest")
    .reduce<IngestSpanNode | null>((latest, node) =>
      !latest || node.span.id > latest.span.id ? node : latest, null)
  const taskStatus = payload.task?.status
  const root = taskStatus === "pending" && latestRoot?.span.status === "done" ? null : latestRoot
  // UT-26: the joint gate keeps stage success and ACTIVATION independent — a
  // completed candidate with a gate denial (or held for business approval) is
  // NOT a completion, whatever its document status says.
  const blocked = payload.activationBlockReason != null && payload.activationBlockReason !== ""
  const status: ImportStatus = taskStatus === "cancelled" || payload.documentStatus === "cancelled"
    ? "cancelled"
    : taskStatus === "running" ? "processing"
    : taskStatus === "pending" ? "pending"
    : payload.candidateState === "pending_review" ? "business_review"
    : blocked && (payload.documentStatus === "completed" || taskStatus === "completed") ? "pending_review"
    : payload.documentStatus === "completed" || taskStatus === "completed" ? "completed"
    : payload.documentStatus === "failed" || taskStatus === "failed" ? "failed" : "pending"
  // UT-26: outcome derived ONLY from structured fields — never from
  // heuristics (extraction length, text presence, stage labels).
  const failureCategory = payload.failure?.category ?? null
  const blockReasons = blocked ? (payload.activationBlockReason as string).split(";").filter(Boolean) : []
  const version = payload.documentVersion
  const outcome: ImportOutcome | null =
    status === "pending_review"
      ? {
          state: "pending_review",
          blockReasons,
          allowedOperations: [],
          oldVersionUsable: version != null && !version.active && version.version > 1,
        }
      : status === "business_review"
        ? {
            state: "business_review",
            blockReasons: [],
            allowedOperations: [],
            oldVersionUsable: version != null && !version.active && version.version > 1,
          }
        : status === "failed"
          ? {
              state: failureCategory === "capability_missing" ? "capability_missing" : "failed",
              blockReasons: [],
              allowedOperations: payload.failure?.allowedOperations ?? [],
              oldVersionUsable: version != null && !version.active && version.version > 1,
            }
          : status === "cancelled"
            ? { state: "cancelled", blockReasons: [], allowedOperations: [], oldVersionUsable: false }
            : status === "completed"
              ? { state: "completed", blockReasons: [], allowedOperations: [], oldVersionUsable: false }
              : null
  const retryAt = payload.task?.nextAttemptAt ?? null
  const waitingForRetry = status === "pending" && root?.span.status === "failed"
  const stages = STAGES.map(({ name, label }) => {
    const span = root?.children.find((node) => node.span.name === name)?.span
    return {
      name,
      label,
      status: span?.status ?? "pending",
      durationMs: span?.durationMs ?? null,
      output: span?.output ?? null,
    }
  })
  const done = stages.filter((stage) => stage.status === "done").length
  const current = stages.find((stage) => stage.status === "running")
  const failed = root?.children.find((node) => node.span.status === "failed")?.span
  const chunk = root?.children.find((node) => node.span.name === "chunk")?.span
  const storeChunks = root?.children.find((node) => node.span.name === "storeChunks")?.span
  const embeddingRateLimitCount = numberOutput(storeChunks?.output ?? null, "embeddingRateLimitCount")
  const rateLimitWaitMs = numberOutput(storeChunks?.output ?? null, "rateLimitWaitMs")
  const summary = status === "completed" ? "处理完成"
    : status === "pending_review" ? "处理完成，但内容待校验，未替换现有版本"
    : status === "business_review" ? "处理完成，等待业务审批"
    : status === "cancelled" ? "已取消"
    : status === "failed" ? `${stages.find((stage) => stage.status === "failed")?.label ?? "处理"}失败`
    : waitingForRetry ? "等待自动重试"
    : status === "pending" ? "等待处理"
    : current ? `正在${current.label}` : "正在完成处理"
  return {
    status,
    percent: status === "completed" ? 100 : waitingForRetry ? 0
      : status === "processing" && !root ? null : Math.min(95, done / STAGES.length * 100),
    summary,
    error: status === "failed" || waitingForRetry ? failed?.errorMessage ?? root?.span.errorMessage ?? "处理失败" : null,
    outcome,
    stages,
    parser: typeof chunk?.output?.parser === "string" ? chunk.output.parser : null,
    chunkCount: typeof chunk?.output?.chunkCount === "number" ? chunk.output.chunkCount : null,
    retryCount: payload.task?.failCount ?? 0,
    retryAt,
    embeddingRateLimitCount,
    rateLimitWaitMs,
  }
}

export function initialImportProgress(status: ImportStatus): ImportProgress {
  return {
    status,
    percent: status === "uploading" || status === "processing" ? null : status === "completed" ? 100 : 0,
    summary: status === "queued" ? "等待上传" : status === "uploading" ? "正在上传文件"
      : status === "completed" ? "处理完成" : status === "failed" ? "上传失败"
      : status === "cancelled" ? "已取消" : status === "processing" ? "正在处理" : "等待处理",
    error: null, outcome: null, stages: [], parser: null, chunkCount: null, retryCount: 0, retryAt: null,
    embeddingRateLimitCount: 0, rateLimitWaitMs: 0,
  }
}
