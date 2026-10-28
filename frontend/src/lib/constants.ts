import type { TraceEvent } from "@core/conversation"
import { answerProcessEventLabel } from "../../../src/frontend/answer_process"

export const MAX_ATTACHMENT_BYTES = 128 * 1024
export const MAX_ATTACHMENTS = 4

/** The five answer-path stages the 执行链路 panel draws. */
export const TRACE_PATH_STEPS = [
  { stage: "route", label: "理解问题" },
  { stage: "retrieval", label: "查找资料" },
  { stage: "context", label: "整理证据" },
  { stage: "validation", label: "核对答案" },
  { stage: "done", label: "完成回答" },
] as const

export const TRACE_STATUS_LABELS: Record<string, string> = {
  completed: "已完成",
  clarification_required: "等待补充",
  insufficient_retrieval: "检索不足",
  insufficient_evidence: "证据不足",
  invalid_citation: "引用无效",
  provider_error: "运行失败",
  cancelled: "已取消",
  handoff_required: "已转人工",
}

/** Mirrors the backend parser router (src/ingestion/parser/router.ts): this
 * set is the single format source of truth for the import flow — no component
 * keeps a second whitelist. */
export const IMPORT_FILE_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".md",
  ".markdown",
  ".txt",
  ".html",
  ".htm",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".csv",
  ".epub",
  ".rtf",
  ".json",
  ".xml",
  ".bmp",
  ".heic",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
])
/** The composer's attachment picker accepts exactly the importable formats. */
export const ATTACHMENT_ACCEPT = Array.from(IMPORT_FILE_EXTENSIONS).join(",")

export const IMPORT_CONCURRENCY = 3
export const IMPORT_POLL_MS = 1500
export const IMPORT_MAX_FILES_HINT = 500
/** Mirrors the server's RAW_FILE_LIMIT (src/api/ingest.ts) — oversized files
 * fail at queue time so the upload never leaves the browser. */
export const IMPORT_MAX_FILE_BYTES = 20 * 1024 * 1024

/** Dropzone copy: formats grouped the way the parser router groups them, so
 * the limits are visible BEFORE a failed upload teaches them. */
export const IMPORT_FORMAT_GROUPS = [
  { label: "文档", items: "PDF · Word · Markdown · TXT · HTML · EPUB · RTF · JSON · XML" },
  { label: "表格", items: "Excel · CSV" },
  { label: "图片", items: "JPG · PNG · BMP · HEIC · TIFF（自动 OCR）" },
] as const

/** PDF parser overrides the backend accepts on `x-parser`; empty = auto
 * routing (the header is not sent). Mirrors src/api/ingest.ts:370. */
export const IMPORT_PARSER_OPTIONS = [
  { value: "", label: "默认（自动路由）" },
  { value: "markitdown", label: "markitdown" },
  { value: "ocr-api", label: "OCR API（扫描件与复杂 PDF）" },
  { value: "builtin-pdf", label: "builtin-pdf" },
] as const

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
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".csv": "text/csv",
  ".epub": "application/epub+zip",
  ".rtf": "application/rtf",
  ".json": "application/json",
  ".xml": "application/xml",
  ".bmp": "image/bmp",
  ".heic": "image/heic",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
}

export function traceStatusLabel(status?: string): string {
  return TRACE_STATUS_LABELS[status ?? ""] ?? "已记录"
}

/** Human-readable one-liner for a projected trace event, per stage. */
export function traceEventLabel(event: TraceEvent): string {
  if (event.stage === "done") return traceStatusLabel(event.result?.status)
  return answerProcessEventLabel(event)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
