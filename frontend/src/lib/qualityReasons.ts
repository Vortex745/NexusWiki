// Ticket 26: the reason-code → user-facing copy mapping for PDF quality
// failures.
//
// The backend classifies every ingestion failure into a coarse category, but a
// quality rejection and a gate service fault are BOTH `permanent_input` — the
// coarse class cannot tell "this file's pages failed the audit" from "the
// audit service is temporarily down". Components therefore key off the stable
// reason codes: the failure record's `reasonCode` plus, for quality
// rejections, the audit's own detailed codes (`reasonCodes`, e.g.
// `quality_failed:3`, `service_failure:timeout:5`).
//
// Exhaustiveness: the classification-code map below is typed as
// `Record<ClassificationReasonCode, string>` over a literal union mirroring the
// backend's closed vocabulary — adding a code to the union without a mapping
// fails the type check, and the test pins every known code to non-verbatim
// copy. Audit codes follow the documented grammar; an unknown label passes
// through with its page number instead of rendering blank.

/** Mirrors INGESTION_FAILURE_REASON_CODES (src/ingestion/error_classification.ts). */
export type ClassificationReasonCode =
  | "ingestion_cancelled"
  | "parser_capability_missing"
  | "no_usable_parser"
  | "malformed_parser_output"
  | "unrouteable_type"
  | "transient_service_error"
  | "unclassified_error_no_transient_basis"
  | "pdf_quality_gate_rejected"
  | "ocr_api_not_configured_or_unauthorized"
  | "ocr_api_transient_error"
  | "ocr_api_invalid_input_or_output"
  | "ocr_empty_page_unverified"
  | "docreader_unavailable"
  | "docreader_deadline_exceeded"
  | "docreader_capability_missing"
  | "docreader_message_too_large"
  | "docreader_invalid_request"
  | "docreader_parse_failed"
  | "docreader_cancelled"
  | "docreader_invalid_stream"
  | "docreader_image_missing"
  | "docreader_ocr_required"
  | "docreader_no_extractable_text"

/** Mirrors QUALITY_ISSUE_TYPES + the `quality_failed` fallback label (contract.ts). */
export const QUALITY_FAIL_LABELS = [
  "quality_failed",
  "missing_content",
  "text_corruption",
  "reading_order",
  "structure_loss",
] as const

/** Mirrors QualityContractErrorCode (contract.ts) — the invalid-response codes. */
export const QUALITY_CONTRACT_CODES = [
  "empty_page_set",
  "page_number_invalid",
  "page_not_declared",
  "page_out_of_document",
  "duplicate_page",
  "duplicate_page_verdict",
  "verdict_invalid",
  "issue_label_invalid",
  "issue_label_conflict",
  "observation_missing",
  "image_bytes_missing",
  "image_base64_invalid",
  "image_size_mismatch",
  "image_digest_mismatch",
  "image_media_type_invalid",
  "image_media_type_mismatch",
  "image_content_invalid",
  "image_content_truncated",
  "image_page_mismatch",
  "image_resolution_mismatch",
  "image_resolution_invalid",
  "image_resolution_too_large",
  "image_too_large",
  "image_aggregate_too_large",
  "text_declaration_conflict",
  "text_placeholder",
  "batch_page_limit_exceeded",
  "request_body_too_large",
  "response_envelope_invalid",
  "response_usage_invalid",
  "answer_missing",
  "answer_question_invalid",
  "answer_page_unrequested",
  "answer_page_missing",
  "answer_issue_missing",
  "answer_type_invalid",
  "answer_verdict_invalid",
  "answer_issue_label_invalid",
  "answer_probability_invalid",
  "answer_confidence_invalid",
  "answer_verdict_incoherent",
  "answer_issue_incoherent",
] as const

/** The failure record's shape the status API serves (frontend projection). */
export interface FailureRecordLike {
  reasonCode: string
  reasonCodes?: string[]
  userGuidance?: string
}

/** One parsed audit reason code. */
export type ParsedAuditReasonCode =
  | { kind: "page_fail"; label: string; page: number }
  | { kind: "uncertain"; page: number }
  | { kind: "service_failure"; classification: string; page: number }
  | { kind: "missing_evidence"; page: number }
  | { kind: "invalid_response"; code: string; page: number }
  | { kind: "unknown" }

/**
 * The audit reason-code grammar (pdf_page_quality_gate.rejectionReasonCodes):
 * `<failLabel>:<page>`, `uncertain:<page>`, `service_failure:<class>:<page>`,
 * `missing_evidence:<page>`, `<contractCode>:<page>`. Anything else is unknown.
 */
export function parseAuditReasonCode(code: string): ParsedAuditReasonCode {
  const parts = code.split(":")
  const last = parts[parts.length - 1]
  const page = Number(last)
  const head = parts.slice(0, -1).join(":")
  if (!Number.isInteger(page) || page <= 0 || head === "") return { kind: "unknown" }
  if (head === "uncertain") return { kind: "uncertain", page }
  if (head === "missing_evidence") return { kind: "missing_evidence", page }
  if (head.startsWith("service_failure:")) {
    return { kind: "service_failure", classification: head.slice("service_failure:".length), page }
  }
  if ((QUALITY_FAIL_LABELS as readonly string[]).includes(head)) {
    return { kind: "page_fail", label: head, page }
  }
  if ((QUALITY_CONTRACT_CODES as readonly string[]).includes(head)) {
    return { kind: "invalid_response", code: head, page }
  }
  return { kind: "unknown" }
}

/** Copy for one parsed audit code; unknown labels keep their page, verbatim label. */
export function describeAuditReasonCode(code: string): string {
  const parsed = parseAuditReasonCode(code)
  switch (parsed.kind) {
    case "page_fail":
      return parsed.label === "quality_failed"
        ? `第 ${parsed.page} 页未通过质量审计`
        : `第 ${parsed.page} 页质量未通过（${parsed.label}）`
    case "uncertain":
      return `第 ${parsed.page} 页质量无法确定`
    case "missing_evidence":
      return `第 ${parsed.page} 页缺少审计证据`
    case "service_failure":
      return `第 ${parsed.page} 页审计请求失败（${parsed.classification}）`
    case "invalid_response":
      return `第 ${parsed.page} 页审计响应异常（${parsed.code}）`
    case "unknown":
      return code
  }
}

/**
 * The classification-code copy, exhaustive over the mirrored vocabulary — a
 * new code without an entry here fails the type check.
 */
const CLASSIFICATION_REASON_TEXT: Record<ClassificationReasonCode, string> = {
  ingestion_cancelled: "处理已取消",
  parser_capability_missing: "解析组件不可用，需要先配置解析器",
  no_usable_parser: "没有可用的解析器路由，需要先配置解析器",
  malformed_parser_output: "文件内容无法被解析为可用文本",
  unrouteable_type: "无法识别的文件类型",
  transient_service_error: "外部服务暂时不可用，请等待自动重试",
  unclassified_error_no_transient_basis: "导入失败，请重试；若反复出现请联系管理员",
  pdf_quality_gate_rejected: "PDF 页面质量审计未通过",
  ocr_api_not_configured_or_unauthorized: "OCR 服务未配置或未授权",
  ocr_api_transient_error: "OCR 服务暂时不可用，请等待自动重试",
  ocr_api_invalid_input_or_output: "OCR 服务无法处理该输入或返回了无效结果",
  ocr_empty_page_unverified: "OCR 返回了未验证的空内容；请核对原始页面并重新导出 PDF 后重试，空结果不代表页面已确认为空白",
  docreader_unavailable: "DocReader 服务不可用；请确认本机 127.0.0.1:50051 已启动后重试",
  docreader_deadline_exceeded: "PDF 解析超过总预算；请稍后重试或拆分文件",
  docreader_capability_missing: "DocReader 缺少所需的 PDF 解析能力，请检查服务构建",
  docreader_message_too_large: "PDF 页面超过 DocReader 消息上限，请压缩或拆分文件",
  docreader_invalid_request: "DocReader 拒绝了该 PDF 输入",
  docreader_parse_failed: "PDF 解析失败",
  docreader_cancelled: "处理已取消",
  docreader_invalid_stream: "DocReader 流式响应中断或不完整",
  docreader_image_missing: "PDF 页面图片未完整传输",
  docreader_ocr_required: "该 PDF 需要 OCR；请选择“强制 OCR”或配置 OCR 凭证",
  docreader_no_extractable_text: "PDF 没有可索引文字；请确认文件内容或选择强制 OCR",
}

/** Ticket 17/26: the password / re-export guidance the frontend owns. */
export const PDF_PROTECTION_GUIDANCE =
  "该 PDF 无法打开或解码：如果设置了密码保护或已加密，请先解除密码，或将文件重新导出为普通 PDF 后重试"

export interface DescribedFailure {
  /** One Chinese sentence per user-meaningful category (merged page numbers). */
  reasons: string[]
  /** True when the failure is a Clef/OCR service fault, NOT a bad file. */
  serviceUnavailable: boolean
  /** Password / re-export guidance lines (protection-related input failures). */
  guidance: string[]
  /** Raw audit reason codes, for support tooltips — never shown inline. */
  technicalDetail?: string[]
}

/** Service-fault classification codes (never ask the user to replace the file). */
const SERVICE_FAULT_CODES: ReadonlySet<ClassificationReasonCode> = new Set([
  "transient_service_error",
  "ocr_api_transient_error",
  "docreader_unavailable",
  "docreader_deadline_exceeded",
] as ClassificationReasonCode[])

/**
 * Merges page numbers into one readable span ("第 1、3 页"); beyond 8 pages
 * the list is capped with "等" so the line stays readable.
 */
function formatAuditPages(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b)
  const capped = sorted.length > 8
  const shown = capped ? sorted.slice(0, 8) : sorted
  return `第 ${shown.join("、")} 页${capped ? "等" : ""}`
}

/**
 * Maps a persisted failure record onto user-facing copy, keyed off the stable
 * reason codes — never the coarse error category. Quality rejections are
 * grouped into at most three plain-language categories (content → service →
 * system), one sentence each; raw audit codes move to `technicalDetail`.
 */
export function describeFailure(failure: FailureRecordLike): DescribedFailure {
  const guidance = failure.userGuidance ? [PDF_PROTECTION_GUIDANCE] : []
  // Quality rejection: the audit's detailed codes are the evidence.
  if (failure.reasonCode === "pdf_quality_gate_rejected") {
    const codes = failure.reasonCodes ?? []
    if (codes.length === 0) {
      return {
        reasons: [CLASSIFICATION_REASON_TEXT.pdf_quality_gate_rejected],
        serviceUnavailable: false,
        guidance,
      }
    }
    const contentPages: number[] = []
    let hasPageFail = false
    let hasServiceFault = false
    let hasSystemFault = false
    for (const code of codes) {
      const parsed = parseAuditReasonCode(code)
      switch (parsed.kind) {
        case "page_fail":
          contentPages.push(parsed.page)
          hasPageFail = true
          break
        case "uncertain":
          contentPages.push(parsed.page)
          break
        case "service_failure":
          hasServiceFault = true
          break
        // Ticket 26 AC3: a service fault is NOT a bad file — no replace-file
        // ask. Evidence/contract/unknown codes are system-side anomalies.
        case "missing_evidence":
        case "invalid_response":
        case "unknown":
          hasSystemFault = true
          break
      }
    }
    const reasons: string[] = []
    if (contentPages.length > 0) {
      reasons.push(
        hasPageFail
          ? `${formatAuditPages(contentPages)}内容检查未通过：文件可能不清晰或有乱码、缺页，建议重新导出后再试`
          : `${formatAuditPages(contentPages)}内容无法确认，建议重新导出后再试`,
      )
    }
    if (hasServiceFault) {
      reasons.push("系统服务暂时不可用，文件本身没有问题，请稍后重试")
    }
    if (hasSystemFault) {
      reasons.push("系统检查这份文件时出现异常，请重试；若反复失败请联系管理员")
    }
    return {
      reasons,
      serviceUnavailable: hasServiceFault,
      guidance,
      technicalDetail: codes,
    }
  }
  const known = failure.reasonCode in CLASSIFICATION_REASON_TEXT
  return {
    reasons: known ? [CLASSIFICATION_REASON_TEXT[failure.reasonCode as ClassificationReasonCode]] : [failure.reasonCode],
    serviceUnavailable: SERVICE_FAULT_CODES.has(failure.reasonCode as ClassificationReasonCode),
    guidance,
  }
}
