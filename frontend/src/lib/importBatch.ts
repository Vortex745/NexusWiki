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
// Error copy mapping (tickets 06/07)
// ---------------------------------------------------------------------------

export interface ImportErrorView {
  kind: "conflict" | "profile" | "generic"
  text: string
}

/** The server's messages differ per failure class; rows show a curated line
 * plus the actions each class enables (conflict → 查看文档). The conflict
 * pattern matches the backend's real 409 text ("this source already exists
 * with different content — …", src/ingestion/lifecycle.ts). */
export function describeImportError(raw: string): ImportErrorView {
  const message = raw ?? ""
  if (/已存在|重复|duplicate|conflict|already exists/i.test(message)) {
    return { kind: "conflict", text: "文档已存在或内容冲突" }
  }
  if (/embedding|向量化|profile/i.test(message)) {
    return { kind: "profile", text: "知识库向量化配置与服务端不一致，无法导入" }
  }
  return { kind: "generic", text: message || "导入失败" }
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
