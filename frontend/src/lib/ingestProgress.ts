import type { IngestSpanNode, IngestStatus } from "./api"
import { describeFailure } from "./qualityReasons"

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
  /** Policy-accepted non-blocking warnings (e.g. OCR text not proofread). */
  activationWarnings: string[]
  /** Policy version that accepted the warnings; null when none recorded. */
  activationPolicyVersion: string | null
  /** Machine-readable operations the server allows for this failure. */
  allowedOperations: string[]
  /** A prior version remains active — the blocked candidate replaced nothing
   * usable. Only claimed when a previous version actually exists (version > 1). */
  oldVersionUsable: boolean
  /** Ticket 26: failed-state evidence — the stable classification reason code. */
  reasonCode?: string
  /** Ticket 26: the page-quality audit's own detailed reason codes. */
  reasonCodes?: string[]
  /** Ticket 26: protection-related input failures carry re-export guidance. */
  userGuidance?: string
}

/** Stable activation-gate reason codes → explainable copy (UT-26); unknown
 * codes pass through verbatim so new server reasons never render as blank. */
const ACTIVATION_REASON_TEXT: Record<string, string> = {
  activation_content_proof_pending_review: "内容完整性待校验（该版本尚未启用）",
  activation_index_proof_failed: "索引核验未通过（写入内容与来源不一致）",
  activation_proof_binding_mismatch: "完整性凭证与期望产物不一致",
  activation_not_searchable: "索引尚不可检索",
  activation_evidence_record_missing: "完整性证据缺失",
  activation_content_proof_missing: "内容完整性凭证缺失",
  activation_index_proof_missing: "索引核验凭证缺失",
  activation_evidence_schema_mismatch: "完整性证据格式不匹配",
  activation_gate_verification_not_implemented: "核验未实现",
}

/** Policy-accepted warnings → short, non-alarming copy. Unknown codes pass
 * through so a new accepted warning never renders as blank. */
const ACTIVATION_WARNING_TEXT: Record<string, string> = {
  "structural_risk: ocr_content_unverified": "来自 OCR，未逐字核对",
}

export function describeActivationWarnings(warnings: ReadonlyArray<string>): string[] {
  return warnings.map((warning) => ACTIVATION_WARNING_TEXT[warning] ?? warning)
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

/** Ticket 26: the derived PDF-quality sub-steps (span-output evidence only). */
const PDF_SUBSTEP_LABELS = {
  pdfExtract: { label: "打开与提取", shortLabel: "提取" },
  pdfAudit: { label: "质量审计", shortLabel: "审计" },
  pdfOcr: { label: "OCR 回退", shortLabel: "OCR" },
  pdfOcrAudit: { label: "OCR 审计", shortLabel: "OCR审" },
} as const

/** Classification reason codes that fail BEFORE any audit could run. */
const PARSER_SIDE_FAILURE_CODES: ReadonlySet<string> = new Set([
  "parser_capability_missing",
  "no_usable_parser",
  "malformed_parser_output",
  "unrouteable_type",
])

export interface PdfQualityWorkflow {
  gated: boolean
  /** Null when nothing was audited. */
  ocrFallbackUsed: boolean | null
  /** "pass" | "reject" | null — the chunk span output's recorded verdict. */
  verdict: string | null
}

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
    // Derived sub-steps (ticket 26) have no private estimate; they share the
    // chunk stage's budget window, so they contribute zero here.
    return remaining + (STAGE_ESTIMATE_MS[stage.name] ?? 0) * sizeFactor
  }, 0)
  const completedDuration = progress.stages.reduce((elapsed, stage) =>
    elapsed + (stage.status === "done" ? stage.durationMs ?? 0 : 0), 0)
  const currentElapsed = Math.max(0, now - processingStartedAt - completedDuration)
  const remaining = estimated - currentElapsed
  return remaining > 0 ? remaining : null
}

export function buildImportSteps(progress: ImportProgress, isLocal: boolean, uploaded: boolean): ImportStep[] {
  // Ticket 26: a gated PDF run shows its quality sub-steps in the bar — the
  // stages array already carries them (derived in deriveIngestProgress) ahead
  // of the coarse chunk stage.
  const gated = progress.stages.some((stage) => stage.name in PDF_SUBSTEP_LABELS)
  const sourceStages: ReadonlyArray<{ name: string; shortLabel: string }> = gated
    ? progress.stages.map((stage) => ({
        name: stage.name,
        shortLabel: stage.name in PDF_SUBSTEP_LABELS
          ? PDF_SUBSTEP_LABELS[stage.name as keyof typeof PDF_SUBSTEP_LABELS].shortLabel
          : STAGES.find((entry) => entry.name === stage.name)?.shortLabel ?? stage.name,
      }))
    : STAGES
  const stages = sourceStages.map(({ name, shortLabel }) => ({
    name,
    label: shortLabel,
    status: progress.stages.find((stage) => stage.name === name)?.status ?? "pending" as ImportStep["status"],
  }))
  if (progress.status === "completed" && progress.stages.every((stage) => stage.status === "pending")) {
    stages.forEach((stage) => { stage.status = "skipped" })
  }
  if (progress.status === "failed" && !stages.some((stage) => stage.status === "failed") && (uploaded || !isLocal)) {
    // Generic failure attribution: the first PENDING SPAN-BACKED stage —
    // derived sub-steps carry their own evidence-backed attribution.
    const firstPending = stages.find((stage) => stage.status === "pending" && !(stage.name in PDF_SUBSTEP_LABELS))
    if (firstPending) firstPending.status = "failed"
  }
  if (!isLocal) return stages
  const uploadStatus: ImportStep["status"] = uploaded ? "done"
    : progress.status === "failed" ? "failed"
    : progress.status === "cancelled" ? "cancelled"
    : progress.status === "uploading" ? "running" : "pending"
  return [{ name: "upload", label: "上传", status: uploadStatus }, ...stages]
}

/**
 * How a server catalog row reads in 上传记录. The row's coarse `status` only
 * says the pipeline finished — it never says retrieval adopted the version.
 * Adoption is the `active` pointer (sources.active_doc_id), while a held
 * candidate is a completed row with candidateState pending_review (business
 * approval) or a recorded activation block reason (content-integrity hold).
 */
export type RecordDisplayState =
  | "processing"
  | "adopted"
  | "pending_review"
  | "business_review"
  | "inactive"
  | "failed"
  | "cancelled"

export interface RecordDisplayView {
  state: RecordDisplayState
  label: string
}

export interface RecordDisplayInput {
  status: "pending" | "completed" | "failed" | "cancelled"
  candidateState?: string | null
  active?: boolean
  activationBlockReason?: string | null
}

/** Derive the record row presentation from the server's own fields. ✅ is
 * reserved for a completed version that the active pointer actually holds. */
export function deriveRecordView(record: RecordDisplayInput): RecordDisplayView {
  if (record.status === "failed") return { state: "failed", label: "失败" }
  if (record.status === "cancelled") return { state: "cancelled", label: "已取消" }
  if (record.status !== "completed") return { state: "processing", label: "处理中" }
  // Business approval hold: a completed candidate never became active.
  if (record.candidateState === "pending_review") {
    return { state: "business_review", label: "待审中" }
  }
  // Integrity hold: activation was denied and the reason was recorded.
  if ((record.activationBlockReason ?? "").trim() !== "") {
    return { state: "pending_review", label: "待校验" }
  }
  if (record.active) return { state: "adopted", label: "已完成" }
  // Completed but not the active pointer: an older version (superseded by a
  // newer one) or a candidate that was never enabled. Both are non-active,
  // neither is a success — no ✅, no failure ❌.
  return { state: "inactive", label: "非活动版本" }
}

export interface ImportProgress {
  status: ImportStatus
  percent: number | null
  summary: string
  error: string | null
  /** UT-26: structured end-state (null while the row is still in flight). */
  outcome: ImportOutcome | null
  /** Ticket 26: the PDF quality workflow evidence (null for non-PDF runs). */
  pdf: PdfQualityWorkflow | null
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
  const acceptanceWarnings = Array.isArray(payload.activationWarnings)
    ? payload.activationWarnings.filter((warning): warning is string => typeof warning === "string")
    : []
  const acceptancePolicyVersion =
    typeof payload.activationPolicyVersion === "string" ? payload.activationPolicyVersion : null
  const version = payload.documentVersion
  const outcome: ImportOutcome | null =
    status === "pending_review"
      ? {
          state: "pending_review",
          blockReasons,
          activationWarnings: [],
          activationPolicyVersion: null,
          allowedOperations: [],
          oldVersionUsable: version != null && !version.active && version.version > 1,
        }
      : status === "business_review"
        ? {
            state: "business_review",
            blockReasons: [],
            activationWarnings: [],
            activationPolicyVersion: null,
            allowedOperations: [],
            oldVersionUsable: version != null && !version.active && version.version > 1,
          }
        : status === "failed"
          ? {
              state: failureCategory === "capability_missing" ? "capability_missing" : "failed",
              blockReasons: [],
              activationWarnings: [],
              activationPolicyVersion: null,
              allowedOperations: payload.failure?.allowedOperations ?? [],
              oldVersionUsable: version != null && !version.active && version.version > 1,
              // Ticket 26: the raw evidence the failure copy keys off.
              reasonCode: payload.failure?.reasonCode,
              ...(payload.failure?.reasonCodes?.length ? { reasonCodes: payload.failure.reasonCodes } : {}),
              ...(payload.failure?.userGuidance ? { userGuidance: payload.failure.userGuidance } : {}),
            }
          : status === "cancelled"
            ? { state: "cancelled", blockReasons: [], activationWarnings: [], activationPolicyVersion: null, allowedOperations: [], oldVersionUsable: false }
            : status === "completed"
              ? {
                  state: "completed",
                  blockReasons: [],
                  activationWarnings: acceptanceWarnings,
                  activationPolicyVersion: acceptancePolicyVersion,
                  allowedOperations: [],
                  oldVersionUsable: false,
                }
              : null
  const retryAt = payload.task?.nextAttemptAt ?? null
  const waitingForRetry = status === "pending" && root?.span.status === "failed"
  const stages: Array<{
    name: string
    label: string
    status: IngestSpanNode["span"]["status"]
    durationMs: number | null
    output: Record<string, unknown> | null
  }> = STAGES.map(({ name, label }) => {
    const span = root?.children.find((node) => node.span.name === name)?.span
    return {
      name,
      label,
      status: span?.status ?? "pending",
      durationMs: span?.durationMs ?? null,
      output: span?.output ?? null,
    }
  })
  // Ticket 26: the PDF quality workflow evidence — the chunk span's persisted
  // input names the effective switch (available even when the stage failed
  // before any output), the output carries the audit verdict, and a
  // quality-rejection failure record names the gate outright.
  const chunkSpan = root?.children.find((node) => node.span.name === "chunk")?.span ?? null
  const chunkOutput = chunkSpan?.output ?? null
  const failureRecord = payload.failure ?? null
  const workflow = typeof chunkOutput?.pdfQualityWorkflow === "string" ? chunkOutput.pdfQualityWorkflow : null
  const pdf: PdfQualityWorkflow | null = workflow === "pdf_quality_workflow_enabled" ||
    chunkSpan?.input?.pdfOcrFallbackEnabled === true ||
    failureRecord?.reasonCode === "pdf_quality_gate_rejected"
    ? {
        gated: true,
        ocrFallbackUsed: typeof chunkOutput?.pdfQualityOcrFallbackUsed === "boolean"
          ? chunkOutput.pdfQualityOcrFallbackUsed
          : null,
        verdict: typeof chunkOutput?.pdfQualityGateVerdict === "string" ? chunkOutput.pdfQualityGateVerdict : null,
      }
    : null
  if (pdf?.gated) {
    // Derived sub-steps between upload and the coarse chunk stage: open +
    // extract, the Clef audit, and (when evidence shows it) the OCR fallback
    // with its second audit. Statuses come from evidence only — the audit
    // failing means extraction succeeded; parser-side codes fail extraction.
    const chunkStatus = stages.find((stage) => stage.name === "chunk")?.status ?? "pending"
    const failedParserSide = status === "failed" && (
      (failureRecord?.reasonCode != null && PARSER_SIDE_FAILURE_CODES.has(failureRecord.reasonCode)) ||
      failureRecord?.userGuidance != null
    )
    const auditFailed = status === "failed" && failureRecord?.reasonCode === "pdf_quality_gate_rejected"
    const auditDone = pdf.verdict === "pass"
    const substeps: Array<{ name: keyof typeof PDF_SUBSTEP_LABELS; status: IngestSpanNode["span"]["status"] }> = [
      {
        name: "pdfExtract" as const,
        status: (failedParserSide ? "failed"
          : auditFailed || auditDone || chunkStatus === "done" ? "done"
          : chunkStatus === "running" ? "running" : "pending") as IngestSpanNode["span"]["status"],
      },
      {
        name: "pdfAudit" as const,
        // While the chunk span runs we cannot tell extraction from auditing,
        // so the audit stays pending until its own evidence lands.
        status: (auditFailed ? "failed" : auditDone ? "done" : "pending") as IngestSpanNode["span"]["status"],
      },
    ]
    if (pdf.ocrFallbackUsed) {
      substeps.push(
        { name: "pdfOcr" as const, status: "done" as const },
        { name: "pdfOcrAudit" as const, status: "done" as const },
      )
    }
    stages.unshift(
      ...substeps.map(({ name, status: subStatus }) => ({
        name,
        label: PDF_SUBSTEP_LABELS[name as keyof typeof PDF_SUBSTEP_LABELS].label,
        status: subStatus,
        durationMs: null,
        output: null,
      })),
    )
  }
  const done = stages.filter((stage) => stage.status === "done").length
  const current = stages.find((stage) => stage.status === "running")
  const failed = root?.children.find((node) => node.span.status === "failed")?.span
  const chunk = root?.children.find((node) => node.span.name === "chunk")?.span
  const storeChunks = root?.children.find((node) => node.span.name === "storeChunks")?.span
  const embeddingRateLimitCount = numberOutput(storeChunks?.output ?? null, "embeddingRateLimitCount")
  const rateLimitWaitMs = numberOutput(storeChunks?.output ?? null, "rateLimitWaitMs")
  // Ticket 26: failure copy keys off the stable reason codes, never the coarse
  // error class — a quality rejection reports its plain-language categories
  // (merged pages; a service fault reports unavailability without asking to
  // replace the file, already inside the mapped reasons).
  const describedFailure = failureRecord ? describeFailure(failureRecord) : null
  const summary = status === "completed" ? "处理完成"
    : status === "pending_review" ? "处理完成，但内容待校验，尚未启用"
    : status === "business_review" ? "处理完成，等待业务审批"
    : status === "cancelled" ? "已取消"
    : status === "failed" && failureRecord?.reasonCode === "pdf_quality_gate_rejected" ? "上传失败"
    : status === "failed" ? `${stages.find((stage) => stage.status === "failed")?.label ?? "处理"}失败`
    : waitingForRetry ? "等待自动重试"
    : status === "pending" ? "等待处理"
    : current ? `正在${current.label}` : "正在完成处理"
  const failureError = status === "failed" && describedFailure
    ? describedFailure.reasons.join("；")
    : null
  return {
    status,
    percent: status === "completed" ? 100 : waitingForRetry ? 0
      : status === "processing" && !root ? null : Math.min(95, done / STAGES.length * 100),
    summary,
    error: status === "failed" || waitingForRetry
      ? failureError ?? failed?.errorMessage ?? root?.span.errorMessage ?? "处理失败"
      : null,
    outcome,
    pdf,
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
    error: null, outcome: null, pdf: null, stages: [], parser: null, chunkCount: null, retryCount: 0, retryAt: null,
    embeddingRateLimitCount: 0, rateLimitWaitMs: 0,
  }
}
