// UT-07 / UT-08：摄取错误分类——能力缺失、永久输入、暂时故障与取消。
//
// 契约（UP-03 / UT-07、UT-08）：
// - 缺少解析命令（能力缺失）与永久输入问题绝不被自动反复执行；
// - 只有有依据的暂时故障进入有界重试（未知错误不得无依据归为暂时）；
// - 取消保留取消语义，绝不落入普通重试；
// - 分类是机器可读的稳定理由码，供任务状态返回原因与允许操作；
// - 不自动安装软件，理由里不携带凭据或正文。

export type IngestionFailureCategory =
  | "capability_missing"
  | "permanent_input"
  | "transient"
  | "cancelled"

export interface IngestionErrorClassification {
  category: IngestionFailureCategory
  /** 稳定机器可读理由码。 */
  reasonCode: string
  /** 只有暂时故障为 true——即唯一允许进入 2s/4s/8s 有界重试的类别。 */
  retryable: boolean
}

export const INGESTION_FAILURE_REASON_CODES = {
  cancelled: "ingestion_cancelled",
  parserCapabilityMissing: "parser_capability_missing",
  noUsableParser: "no_usable_parser",
  malformedParserOutput: "malformed_parser_output",
  unrouteableType: "unrouteable_type",
  transientServiceError: "transient_service_error",
  unclassifiedTreatedPermanent: "unclassified_error_no_transient_basis",
} as const

/** 允许操作（机器可读，状态 API 直接返回）。 */
export function allowedOperationsFor(category: IngestionFailureCategory): string[] {
  switch (category) {
    case "capability_missing":
      return ["configure_parser_then_retry", "cancel"]
    case "permanent_input":
      return ["fix_input_then_retry", "cancel"]
    case "transient":
      return ["wait_for_auto_retry", "cancel"]
    case "cancelled":
      return []
  }
}

function classify(message: string): IngestionErrorClassification {
  // 1) 取消：语义优先于一切，绝不进入重试。
  if (
    message.includes("Parser process was cancelled") ||
    message.includes("was cancelled") ||
    message.toLowerCase().includes("aborterror") ||
    message.includes("operation was aborted")
  ) {
    return {
      category: "cancelled",
      reasonCode: INGESTION_FAILURE_REASON_CODES.cancelled,
      retryable: false,
    }
  }
  // 2) 能力缺失：解析器可执行文件不存在（process.ts ENOENT 包装），以及
  //    路由候选全部不可用（"No usable parser"）。不自动安装、不重试。
  if (message.includes("executable is unavailable") || message.includes("No usable parser")) {
    return {
      category: "capability_missing",
      reasonCode: message.includes("No usable parser")
        ? INGESTION_FAILURE_REASON_CODES.noUsableParser
        : INGESTION_FAILURE_REASON_CODES.parserCapabilityMissing,
      retryable: false,
    }
  }
  // 3) 永久输入/结构问题：同样字节重跑结论不变，重试是纯浪费。
  if (
    /malformed (markitdown|builtin-pdf|mineru|marker) output/i.test(message) ||
    message.includes("has no text layer") ||
    message.includes("No parser route") ||
    message.includes("Cannot confirm type compatibility") ||
    /exceeded \d+ bytes/.test(message) ||
    message.includes("type_conflict") ||
    message.includes("unsupported_type")
  ) {
    return {
      category: "permanent_input",
      reasonCode: INGESTION_FAILURE_REASON_CODES.malformedParserOutput,
      retryable: false,
    }
  }
  // 4) 有依据的暂时故障：限流、超时、连接抖动、明确的暂时性措辞或 5xx。
  if (
    /rate limit|too many requests|\b429\b/i.test(message) ||
    /timed? ?out|timeout/i.test(message) ||
    /econn(refused|reset|aborted)|etimedout|eai_again|socket hang up|network error/i.test(message) ||
    /\b5\d\d\b|(service|temporarily) unavailable/i.test(message) ||
    message.includes("temporary")
  ) {
    return {
      category: "transient",
      reasonCode: INGESTION_FAILURE_REASON_CODES.transientServiceError,
      retryable: true,
    }
  }
  // 5) 未知错误：没有暂时性依据时不归为暂时——立即终止，人工可经 /retry
  //    复核后再试（分类保守但可解释）。
  return {
    category: "permanent_input",
    reasonCode: INGESTION_FAILURE_REASON_CODES.unclassifiedTreatedPermanent,
    retryable: false,
  }
}

export function classifyIngestionError(error: unknown): IngestionErrorClassification {
  const message = error instanceof Error ? error.message : String(error)
  return classify(message)
}

/** 脱敏摘要：状态可见的错误说明（截断，绝不带正文/凭据语义字段）。 */
export function redactedFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const redacted = message.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]*@[^\s]+/gi, "***@***")
  return redacted.length > 300 ? `${redacted.slice(0, 300)}…` : redacted
}
