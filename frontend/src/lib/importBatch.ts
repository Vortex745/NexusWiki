import { IMPORT_FILE_EXTENSIONS } from "./constants"

/**
 * The import flow's decision layer, kept pure so node:test can cover it
 * without a browser (the seam agreed in docs/specs/import-dialog-v2.spec.md):
 * format filtering, folder flattening, target-reuse checks, category mapping,
 * wave snapshots, duplicate pre-checks, error copy and the active-count
 * projection the sidebar badge renders. The dialog and the dropzone only
 * consume these results — no branching logic lives in the components.
 */

export interface PickedFile {
  file: File
  /** Path relative to the batch root; segments joined with "/". A loose file
   * is its own name. Used verbatim as the upload's source id. */
  relativePath: string
}

export interface PickedFolder {
  name: string
  /** Files that survived the extension filter; paths start at the folder name. */
  files: PickedFile[]
  /** Unsupported entries filtered out of THIS folder — surfaced per folder. */
  skipped: number
}

/** A plain-node model of a dropped directory tree. The dropzone maps browser
 * entry trees onto this shape so the flattening below runs — and tests —
 * without a DOM. */
export interface FolderNode {
  name: string
  files: Array<{ name: string; file?: File }>
  dirs: FolderNode[]
}

// ---------------------------------------------------------------------------
// Format filtering (ticket 02)
// ---------------------------------------------------------------------------

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".")
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : ""
}

export function isSupportedFileName(fileName: string): boolean {
  return IMPORT_FILE_EXTENSIONS.has(extensionOf(fileName))
}

/** Filter a loose-file selection (button multi-select or a plain file drop).
 * Unsupported entries are counted, not surfaced one by one. */
export function partitionLooseFiles(
  files: Array<{ file: File; relativePath?: string }>,
): { files: PickedFile[]; skipped: number } {
  const picked: PickedFile[] = []
  let skipped = 0
  for (const { file, relativePath } of files) {
    if (isSupportedFileName(file.name)) {
      picked.push({ file, relativePath: relativePath || file.name })
    } else {
      skipped += 1
    }
  }
  return { files: picked, skipped }
}

/** Flatten a dropped directory tree into one picked folder. Relative paths
 * start at the folder name — that prefix is what the category mapping (below)
 * reads as "the direct parent directory". */
export function flattenFolderNode(
  node: FolderNode,
): { folder: PickedFolder; skipped: number } {
  const files: PickedFile[] = []
  let skipped = 0

  const walk = (current: FolderNode, prefix: string) => {
    const path = prefix ? `${prefix}/${current.name}` : current.name
    for (const entry of current.files) {
      if (entry.file && isSupportedFileName(entry.name)) {
        files.push({ file: entry.file, relativePath: `${path}/${entry.name}` })
      } else {
        skipped += 1
      }
    }
    for (const dir of current.dirs) walk(dir, path)
  }

  walk(node, "")
  return { folder: { name: node.name, files, skipped }, skipped }
}

// ---------------------------------------------------------------------------
// Folder-import target decisions (ticket 05)
// ---------------------------------------------------------------------------

/** The knowledge base a folder import creates is named after the folder;
 * whitespace collapses, and an empty result falls back to the caller's
 * timestamped name. */
export function sanitizeKnowledgeBaseName(raw: string, fallback: string): string {
  const cleaned = raw.replace(/\s+/g, " ").trim()
  return cleaned || fallback
}

export interface KnowledgeBaseRef {
  id: string
  name: string
  status?: string
}

/** The backend creates knowledge bases with random ids and NO name-uniqueness
 * check, so re-importing the same folder must resolve to an existing ACTIVE
 * base here — otherwise every re-import would silently duplicate a base. */
export function findReusableKnowledgeBase(
  bases: ReadonlyArray<KnowledgeBaseRef>,
  name: string,
): KnowledgeBaseRef | null {
  const target = name.trim().toLowerCase()
  return (
    bases.find(
      (base) => base.status !== "archived" && base.name.trim().toLowerCase() === target,
    ) ?? null
  )
}

/** A file's document folder is its DIRECT parent directory in the relative
 * path; root-level files land in the folder-named category. Same-named
 * subfolders across branches merge naturally: the server keys folders by
 * (knowledge base, name) and creates them idempotently. */
export function categoryForPath(relativePath: string, rootName: string): string {
  const segments = relativePath.split("/").filter(Boolean)
  return segments.length >= 2 ? segments[segments.length - 2] : rootName
}

// ---------------------------------------------------------------------------
// Wave snapshots (ticket 06)
// ---------------------------------------------------------------------------

export interface ImportWaveParams {
  knowledgeBaseId: string
  /** Upload folder header: an existing folder id/name or a freshly typed name. */
  folder?: string
  parser?: string
  tags?: string[]
}

/** A wave freezes its target at start; later edits to the form must not
 * redefine what an in-flight batch uploads against. Empty values are dropped
 * so "default" stays absent on the wire. */
export function freezeWaveParams(input: {
  knowledgeBaseId: string
  folder?: string
  parser?: string
  tags?: string[]
}): ImportWaveParams {
  const params: ImportWaveParams = { knowledgeBaseId: input.knowledgeBaseId }
  const folder = input.folder?.trim()
  if (folder) params.folder = folder
  const parser = input.parser?.trim()
  if (parser) params.parser = parser
  if (input.tags && input.tags.length > 0) params.tags = input.tags
  return params
}

// ---------------------------------------------------------------------------
// Duplicate pre-check (ticket 06)
// ---------------------------------------------------------------------------

/** Compare by base file name, case- and slash-insensitive; returns the subset
 * of `incoming` names that already exist. A pre-check hit only MARKS a row —
 * re-importing changed content is a legitimate update path, never blocked. */
export function matchExistingFileNames(existing: string[], incoming: string[]): Set<string> {
  const normalize = (name: string) => name.trim().toLowerCase()
  const known = new Set(existing.map((name) => normalize(baseFileName(name))))
  const hits = new Set<string>()
  for (const name of incoming) {
    if (known.has(normalize(baseFileName(name)))) hits.add(name)
  }
  return hits
}

function baseFileName(name: string): string {
  return name.split(/[\\/]/).pop() ?? name
}

// ---------------------------------------------------------------------------
// Error copy mapping (tickets 06/07, UT-23)
// ---------------------------------------------------------------------------

export interface ImportErrorView {
  kind: "conflict" | "profile" | "admission" | "generic"
  text: string
}

export interface ImportErrorContext {
  /** Structured kind from the server's admission contract (empty_file /
   * file_size / type_conflict / unsupported_type) or the transport class
   * (network / timeout / invalid_response / server). */
  kind?: string | null
  /** Byte-signature detection for type_conflict rows (e.g. "pdf"). */
  detected?: string | null
  /** True when the server ACCEPTED this upload (docId exists): the failure
   * happened in processing, and re-uploading would create a NEW document. */
  acceptedByServer?: boolean
}

const ADMISSION_KIND_TEXT: Record<string, string> = {
  empty_file: "空文件无法导入：文件内容为 0 字节",
  file_size: "文件超过服务端单文件大小上限（20MB）",
  unsupported_type: "文件类型不受支持",
}

/** The server's messages differ per failure class; rows show a curated line
 * plus the actions each class enables (conflict → 查看文档). Structured
 * admission kinds (UT-23) map to stable copy so empty/oversize/type rows
 * explain themselves instead of pasting raw HTTP text. The conflict pattern
 * matches the backend's real 409 text ("this source already exists with
 * different content — …", src/ingestion/lifecycle.ts). */
export function describeImportError(raw: string, context?: ImportErrorContext): ImportErrorView {
  const message = raw ?? ""
  const kind = context?.kind ?? null
  if (kind === "type_conflict") {
    const detected = context?.detected ? `（检测到 ${context.detected} 内容）` : ""
    return { kind: "admission", text: `文件类型与声明不符${detected}，已按服务端准入拒绝` }
  }
  if (kind && ADMISSION_KIND_TEXT[kind]) {
    return { kind: "admission", text: ADMISSION_KIND_TEXT[kind] }
  }
  if (/已存在|重复|duplicate|conflict|already exists/i.test(message)) {
    return { kind: "conflict", text: "文档已存在或内容冲突" }
  }
  if (/embedding|向量化|profile/i.test(message)) {
    return { kind: "profile", text: "知识库向量化配置与服务端不一致，无法导入" }
  }
  // Task failure on an ACCEPTED row: the guard sentence states honestly that
  // re-uploading is a new document, never a same-document resume (UT-23 AC4;
  // the real resume command arrives with UT-27).
  if (context?.acceptedByServer) {
    const base = message || "导入失败"
    return {
      kind: "generic",
      text: `${base}（文件已被服务端接收；重新上传会创建新文档，不会恢复原任务）`,
    }
  }
  return { kind: "generic", text: message || "导入失败" }
}

// ---------------------------------------------------------------------------
// Row admission & retry gating (UT-23)
// ---------------------------------------------------------------------------

/** Client-side admission verdicts that are terminal for the FILE itself: the
 * same bytes can never pass, so these rows must never offer upload retry. */
export type ImportAdmissionKind = "empty_file" | "file_size" | null

export interface ImportRowInit {
  id: string
  waveId: string
  fileName: string
  filePath: string
  size: number
  status: "queued" | "failed"
  docId: null
  error: string | null
  admissionKind: ImportAdmissionKind
  file: File
}

/** Build queue rows from a picked file list (UT-23): empty and oversize files
 * are rejected BEFORE upload with an admission kind — the client mirrors the
 * server's admission contract (never relaxes it), and the server stays the
 * authority for everything the client cannot confirm. One rejected row is
 * terminal for that row only; the queued rows flow into the workers unchanged. */
export function buildImportRows(
  picked: ReadonlyArray<PickedFile>,
  waveId: string,
  maxBytes: number,
  makeId: () => string,
): ImportRowInit[] {
  const maxMb = Math.round(maxBytes / 1024 / 1024)
  return picked.map(({ file, relativePath }) => {
    if (file.size === 0) {
      return {
        id: makeId(), waveId, fileName: file.name, filePath: relativePath,
        size: 0, status: "failed", docId: null,
        error: ADMISSION_KIND_TEXT.empty_file, admissionKind: "empty_file", file,
      }
    }
    if (file.size > maxBytes) {
      return {
        id: makeId(), waveId, fileName: file.name, filePath: relativePath,
        size: file.size, status: "failed", docId: null,
        error: `文件超过 ${maxMb}MB 上限`, admissionKind: "file_size", file,
      }
    }
    return {
      id: makeId(), waveId, fileName: file.name, filePath: relativePath,
      size: file.size, status: "queued", docId: null, error: null,
      admissionKind: null, file,
    }
  })
}

export interface RetryDecision {
  retryable: boolean
  /** Why retry is withheld — rows may render the reason:
   * file_invalid → the same bytes can never pass (empty/oversize);
   * server_accepted → the failure is a processing failure on an accepted
   * upload; re-uploading would create a NEW document (UT-27 adds the real
   * same-document resume command). */
  reason?: "file_invalid" | "server_accepted"
}

export interface RetryGateInput {
  status: string
  file?: unknown
  sourceUrl?: string
  docId?: string | null
  admissionKind?: ImportAdmissionKind
}

/** Whether a failed row may retry, and which recovery that retry means
 * (UT-23): URL rows re-submit their URL; unaccepted file rows re-upload
 * their still-held File handle; admission-rejected and server-accepted rows
 * get NO re-upload — the first can never pass, the second would silently
 * fabricate a "resume" that is really a new document. */
export function retryDecision(item: RetryGateInput): RetryDecision {
  if (item.status !== "failed") return { retryable: false }
  if (item.admissionKind) return { retryable: false, reason: "file_invalid" }
  if (item.docId) return { retryable: false, reason: "server_accepted" }
  if (!item.file && item.sourceUrl) return { retryable: true }
  if (item.file) return { retryable: true }
  return { retryable: false }
}

// ---------------------------------------------------------------------------
// PDF-only parser override (UT-23)
// ---------------------------------------------------------------------------

/** The advanced parser option is a PDF-adapter choice; PDF-only parameters
 * ride only on files the client can confirm ARE PDFs (declared mime or the
 * .pdf extension). A type the client cannot confirm (octet-stream, unknown)
 * rides WITHOUT the override — the server decides. TXT therefore never
 * carries PDF settings (UT-23 AC2). */
export function isPdfLike(fileName: string, mimeType?: string): boolean {
  if (mimeType === "application/pdf") return true
  return extensionOf(fileName) === ".pdf"
}

// ---------------------------------------------------------------------------
// Wave pre-flight settlement (UT-24)
// ---------------------------------------------------------------------------

export interface PrecheckSettleRow {
  id: string
  waveId: string
  status: string
  fileName: string
  precheckHit?: boolean
  precheckSettled?: boolean
}

/** Mark a wave's queued rows as pre-flight-settled once its admission +
 * same-name pre-check has finished (or failed — failure settles too, the
 * server's 409 is the safety net; rows must never wait forever). Only THIS
 * wave's rows are touched: a stale pre-check callback from an earlier wave
 * must never release a later wave's rows, and terminal rows (cancelled /
 * skipped) stay terminal. Same-name hits additionally stay flagged so the
 * worker claim ignores them until the user decides (仍要导入/跳过). */
export function settleWavePrecheck<T extends PrecheckSettleRow>(
  items: ReadonlyArray<T>,
  waveId: string,
  hits: ReadonlySet<string>,
): Array<T> {
  return items.map((item) => {
    if (item.waveId !== waveId || item.status !== "queued") return item
    return {
      ...item,
      precheckSettled: true,
      precheckHit: hits.has(item.fileName) ? true : (item.precheckHit ?? false),
    }
  })
}

// ---------------------------------------------------------------------------
// Active-count projection (ticket 08)
// ---------------------------------------------------------------------------

export const IMPORT_ACTIVE_STATUSES = ["queued", "uploading", "pending", "processing"] as const

/** Rows whose outcome the user has seen; the batch summary waits for these. */
export const IMPORT_TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const

/** The sidebar badge counts every row that still owes the user an outcome. */
export function countActiveImports(items: ReadonlyArray<{ status: string }>): number {
  const active = new Set<string>(IMPORT_ACTIVE_STATUSES)
  return items.filter((item) => active.has(item.status)).length
}
