import type { TraceEvent } from "@core/conversation"

export const MAX_ATTACHMENT_BYTES = 128 * 1024
export const MAX_ATTACHMENTS = 4
export const STATUS_REFRESH_MS = 30_000

/** The five answer-path stages shared by the trace panel and the insight dialog. */
export const INSIGHT_PATH_STEPS = [
  { stage: "route", label: "理解问题" },
  { stage: "retrieval", label: "查找资料" },
  { stage: "context", label: "整理证据" },
  { stage: "validation", label: "核对答案" },
  { stage: "done", label: "完成回答" },
] as const

export const CHANNEL_LABELS: Record<string, { name: string; short: string }> = {
  elasticsearch: { name: "Elasticsearch 检索", short: "ES" },
  neo4j: { name: "Neo4j 知识图谱", short: "Neo4j" },
  chat: { name: "Chat 对话模型", short: "Chat" },
  embedding: { name: "Embedding 向量模型", short: "向量" },
  rerank: { name: "Rerank 重排模型（可选）", short: "重排" },
  parsers: { name: "文档解析器", short: "解析" },
  mcp: { name: "MCP 能力服务器（可选）", short: "MCP" },
  webSearch: { name: "网络搜索（可选）", short: "网络" },
  langfuse: { name: "Langfuse 追踪（可选）", short: "追踪" },
}

export const STATUS_LABELS: Record<string, { text: string; dot: "green" | "amber" | "red" | "gray" }> = {
  connected: { text: "已连接", dot: "green" },
  degraded: { text: "部分降级", dot: "amber" },
  disconnected: { text: "未连接", dot: "red" },
  // Ticket 44: an optional capability the deployment deliberately did not
  // configure is NEITHER failed nor successful — it is simply not there.
  unconfigured: { text: "未配置", dot: "gray" },
  // Configured but not probed live by this page — no liveness claim either way.
  configured: { text: "已配置", dot: "gray" },
}

export const TRACE_STATUS_LABELS: Record<string, string> = {
  completed: "已完成",
  clarification_required: "等待补充",
  insufficient_retrieval: "检索不足",
  insufficient_evidence: "证据不足",
  invalid_citation: "引用无效",
  provider_error: "运行失败",
  cancelled: "已取消",
}

/** Starter prompts on the empty thread, in the composer's own voice. */
export const SUGGESTIONS = [
  { label: "常见问题", prompt: "今天有哪些常见客户问题需要优先处理？" },
  { label: "技术排查", prompt: "请根据知识库帮我排查这个技术问题：" },
  { label: "回复草稿", prompt: "请帮我写一份清晰、专业的客户回复：" },
  { label: "解决思路", prompt: "请围绕这个客户需求提供几个解决思路：" },
] as const

export const IMPORT_FILE_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".md",
  ".txt",
  ".html",
  ".htm",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
])
export const IMPORT_CONCURRENCY = 3
export const IMPORT_POLL_MS = 1500
export const IMPORT_MAX_FILES_HINT = 500

/** Evaluation task polling interval (ticket 04). */
export const EVALUATION_POLL_MS = 1000

export const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentation.presentation",
}

export function traceStatusLabel(status?: string): string {
  return TRACE_STATUS_LABELS[status ?? ""] ?? "已记录"
}

/** Human-readable one-liner for a projected trace event, per stage. */
export function traceEventLabel(event: TraceEvent): string {
  const data = event.data ?? {}
  if (event.stage === "route") {
    if (data.decision === "complex") return "识别为复杂问题"
    if (data.decision === "ambiguous") return "需要补充问题信息"
    return "识别为直接问答"
  }
  if (event.stage === "retrieval") {
    const prefix = data.correction ? "补充检索" : "检索知识库"
    const count = Number.isInteger(data.resultCount) ? ` · ${data.resultCount} 条结果` : ""
    const degraded =
      Array.isArray(data.degradedReasons) && data.degradedReasons.length
        ? ` · ${data.degradedReasons.length} 个通道降级`
        : ""
    return `${prefix}${count}${degraded}`
  }
  if (event.stage === "context") return `整理 ${data.evidenceCount || 0} 条证据`
  if (event.stage === "validation") return data.passed ? "证据校验通过" : "检查证据缺口"
  if (event.stage === "done") return traceStatusLabel(event.result?.status)
  return "处理回答"
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
