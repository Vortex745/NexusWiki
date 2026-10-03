import { useRef, useState } from "react"

import { IMPORT_FILE_EXTENSIONS, IMPORT_FORMAT_GROUPS, IMPORT_MAX_FILES_HINT, IMPORT_MAX_FILE_BYTES } from "../../lib/constants"
import {
  flattenFolderNode,
  partitionLooseFiles,
  type FolderNode,
  type PickedFile,
  type PickedFolder,
} from "../../lib/importBatch"
import { cn } from "../../lib/cn"
import { Upload } from "../ui/icons"
import { Icon } from "../ui/Icon"

/**
 * The import dropzone (ticket 02): the dashed affordance is a REAL drop
 * target — files and whole directories drag in, unsupported entries are
 * filtered with a visible skip count, and the two pick buttons feed the same
 * `onPick` callback so behavior depends on what was given, never on the
 * entry point. Browser entry trees are mapped onto the pure `FolderNode`
 * model so the flattening/filtering logic stays in `lib/importBatch` and
 * covered by node:test.
 */

export interface DropzonePick {
  /** Loose supported files (button multi-select or a plain file drop). */
  files: PickedFile[]
  /** Folder batches; paths are root-prefixed for the category mapping. */
  folders: PickedFolder[]
  /** Unsupported entries filtered out — surfaced as "已跳过 N 个". */
  skipped: number
}

type Phase = "idle" | "over" | "scanning"

/** readEntries pages; keep calling until it returns an empty batch. */
function readDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const collected: FileSystemEntry[] = []
    const readNext = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(collected)
          return
        }
        collected.push(...batch)
        readNext()
      }, reject)
    }
    readNext()
  })
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

async function directoryEntryToNode(entry: FileSystemDirectoryEntry): Promise<FolderNode> {
  const node: FolderNode = { name: entry.name, files: [], dirs: [] }
  const children = await readDirectoryEntries(entry.createReader())
  for (const child of children) {
    if (child.isFile) {
      const fileEntry = child as FileSystemFileEntry
      try {
        node.files.push({ name: fileEntry.name, file: await entryFile(fileEntry) })
      } catch {
        node.files.push({ name: fileEntry.name })
      }
    } else if (child.isDirectory) {
      node.dirs.push(await directoryEntryToNode(child as FileSystemDirectoryEntry))
    }
  }
  return node
}

export function ImportDropzone({
  filesDisabled,
  onPick,
}: {
  /** File picking waits for a target knowledge base; folder picking never does
   * (a folder import creates its own base — ticket 05). */
  filesDisabled?: boolean
  onPick: (pick: DropzonePick) => void
}) {
  const [phase, setPhase] = useState<Phase>("idle")
  const dragDepth = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault()
    dragDepth.current = 0
    setPhase("idle")
    const dataTransfer = event.dataTransfer
    if (!dataTransfer) return

    // Entries must be pulled SYNCHRONOUSLY — the list dies with the event.
    const entries = Array.from(dataTransfer.items ?? [])
      .map((item) =>
        typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null,
      )
      .filter((entry): entry is FileSystemEntry => Boolean(entry))
    // Plain-file fallback, captured before the transfer is cleared below.
    const fallbackFiles = Array.from(dataTransfer.files ?? [])
    // Drop data is cleared once captured so a re-drop of the same payload
    // always fires a fresh change/drop cycle.
    dataTransfer.clearData()

    if (entries.length === 0) {
      // No entry API (or plain OS shortcut drag): files only.
      const { files, skipped } = partitionLooseFiles(
        fallbackFiles.map((file) => ({ file })),
      )
      onPick({ files, folders: [], skipped })
      return
    }

    setPhase("scanning")
    void (async () => {
      const files: PickedFile[] = []
      const folders: PickedFolder[] = []
      let skipped = 0
      try {
        for (const entry of entries) {
          if (entry.isFile) {
            try {
              const file = await entryFile(entry as FileSystemFileEntry)
              const picked = partitionLooseFiles([{ file }])
              files.push(...picked.files)
              skipped += picked.skipped
            } catch {
              skipped += 1
            }
          } else if (entry.isDirectory) {
            const node = await directoryEntryToNode(entry as FileSystemDirectoryEntry)
            const flattened = flattenFolderNode(node)
            folders.push(flattened.folder)
            skipped += flattened.skipped
          }        }
      } finally {
        setPhase("idle")
      }
      onPick({ files, folders, skipped })
    })()
  }

  const handleLooseInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? [])
    event.target.value = ""
    const { files, skipped } = partitionLooseFiles(selected.map((file) => ({ file })))
    onPick({ files, folders: [], skipped })
  }

  const handleFolderInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? [])
    event.target.value = ""
    if (selected.length === 0) return
    // webkitdirectory paths look like "root/sub/a.pdf" — every file shares the
    // same first segment, which names the folder batch.
    const rootName =
      (selected[0] as File & { webkitRelativePath?: string }).webkitRelativePath?.split("/")[0] ??
      ""
    const { files, skipped } = partitionLooseFiles(
      selected.map((file) => ({
        file,
        relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      })),
    )
    onPick({ files: [], folders: [{ name: rootName, files, skipped }], skipped })
  }

  const acceptedTypes = Array.from(IMPORT_FILE_EXTENSIONS).join(",")

  return (
    <div
      onDragEnter={(event) => {
        event.preventDefault()
        dragDepth.current += 1
        setPhase("over")
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setPhase("idle")
      }}
      onDrop={handleDrop}
      className={cn(
        "flex flex-col items-center justify-center rounded-[14px] border border-dashed px-4 py-6 text-center transition-colors",
        phase === "over"
          ? "border-brand bg-brand-subtle"
          : "border-line bg-surface-subtle",
      )}
    >
      <Icon
        icon={Upload}
        className={cn(
          "mb-2 size-8",
          phase === "over" ? "text-brand" : "text-muted/50",
        )}
      />
      <h3 className="text-xs font-semibold text-ink">
        {phase === "scanning" ? "正在扫描文件夹…" : "拖入文件或文件夹，或点击下方按钮选择"}
      </h3>
      <div className="mt-1.5 space-y-0.5 text-[11px] leading-4 text-muted/70">
        {IMPORT_FORMAT_GROUPS.map((group) => (
          <p key={group.label}>
            <span className="font-medium text-muted">{group.label}：</span>
            {group.items}
          </p>
        ))}
        <p className="pt-0.5 text-faint">
          单个 ≤ {Math.round(IMPORT_MAX_FILE_BYTES / 1024 / 1024)}MB · 建议单次 ≤ {IMPORT_MAX_FILES_HINT} 个 · 自动过滤不支持的文件
        </p>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          disabled={filesDisabled}
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex h-8 cursor-pointer items-center justify-center rounded-lg bg-primary px-3.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          选择文件
        </button>
        <button
          type="button"
          onClick={() => folderInputRef.current?.click()}
          className="inline-flex h-8 cursor-pointer items-center justify-center rounded-lg border border-line bg-surface px-3.5 text-xs font-medium text-ink transition-colors hover:bg-surface-subtle focus-visible:ring-2 focus-visible:ring-primary"
        >
          选择文件夹
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        className="sr-only"
        multiple
        accept={acceptedTypes}
        onChange={handleLooseInputChange}
      />
      <input
        ref={folderInputRef}
        type="file"
        className="sr-only"
        // @ts-expect-error webkitdirectory is not in the standard React types
        webkitdirectory=""
        multiple
        accept={acceptedTypes}
        onChange={handleFolderInputChange}
      />
    </div>
  )
}
