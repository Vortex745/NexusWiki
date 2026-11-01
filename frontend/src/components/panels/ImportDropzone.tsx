import { Button as UiButton } from "@/components/ui/Button"
import { useRef, useState } from "react"

import {
  IMPORT_FILE_EXTENSIONS,
  IMPORT_FORMAT_GROUPS,
  IMPORT_MAX_FILES_HINT,
  IMPORT_MAX_FILE_BYTES,
} from "../../lib/constants"
import {
  flattenFolderNode,
  partitionLooseFiles,
  type FolderNode,
  type PickedFile,
  type PickedFolder,
} from "../../lib/importBatch"
import { FileDropzone } from "../arc/file-dropzone/file-dropzone"
import { FolderOpen } from "../ui/icons"
import { Icon } from "../ui/Icon"

/**
 * The import dropzone (ticket 02): the arc FileDropzone is the visible target,
 * while this wrapper keeps the behaviour the importer needs on top of it —
 * directory drags are expanded through `lib/importBatch`, the folder picker
 * feeds the same `onPick` callback, and unsupported entries are filtered with
 * a visible skip count. Picks never stay in the arc component's own list: the
 * import queue is the single list of record, so every pick remounts it empty.
 */

export interface DropzonePick {
  /** Loose supported files (button multi-select or a plain file drop). */
  files: PickedFile[]
  /** Folder batches; paths are root-prefixed for the category mapping. */
  folders: PickedFolder[]
  /** Unsupported entries filtered out — surfaced as "已跳过 N 个". */
  skipped: number
}

type Phase = "idle" | "scanning"

const FORMAT_SUMMARY = IMPORT_FORMAT_GROUPS.map(
  (group) => `${group.label}：${group.items}`,
).join("；")

const LIMIT_NOTE = `单个 ≤ ${Math.round(
  IMPORT_MAX_FILE_BYTES / 1024 / 1024,
)}MB · 建议单次 ≤ ${IMPORT_MAX_FILES_HINT} 个 · 自动过滤不支持的文件`

/** readEntries pages; keep calling until it returns an empty batch. */
function readDirectoryEntries(
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
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

async function directoryEntryToNode(
  entry: FileSystemDirectoryEntry,
): Promise<FolderNode> {
  const node: FolderNode = { name: entry.name, files: [], dirs: [] }
  const children = await readDirectoryEntries(entry.createReader())
  for (const child of children) {
    if (child.isFile) {
      const fileEntry = child as FileSystemFileEntry
      try {
        node.files.push({
          name: fileEntry.name,
          file: await entryFile(fileEntry),
        })
      } catch {
        node.files.push({ name: fileEntry.name })
      }
    } else if (child.isDirectory) {
      node.dirs.push(
        await directoryEntryToNode(child as FileSystemDirectoryEntry),
      )
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
  // Bumped after every pick so the arc dropzone mounts with an empty list.
  const [epoch, setEpoch] = useState(0)
  const folderInputRef = useRef<HTMLInputElement>(null)

  const commitPick = (pick: DropzonePick) => {
    onPick(pick)
    setEpoch((value) => value + 1)
  }

  const handleFiles = (files: File[]) => {
    const { files: picked, skipped } = partitionLooseFiles(
      files.map((file) => ({ file })),
    )
    commitPick({ files: picked, folders: [], skipped })
  }

  /** The arc component's native input would filter by accept and show its own
   * English copy; the pick is handled here instead so unsupported entries
   * still reach the Chinese skip count. */
  const handleFileInputChange = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const selected = Array.from(event.target.files ?? [])
    event.target.value = ""
    event.stopPropagation()
    handleFiles(selected)
  }

  /** Drops bypass the arc dropzone's own handler — entries must be read
   * synchronously here, and a plain-file drop still needs the Chinese skip
   * count. Stopping the drop also leaves the arc target dragging, so each
   * drop remounts it. */
  const handleDropCapture = (event: React.DragEvent) => {
    const transfer = event.dataTransfer
    if (!transfer) return
    const entries = Array.from(transfer.items ?? [])
      .map((item) =>
        typeof item.webkitGetAsEntry === "function"
          ? item.webkitGetAsEntry()
          : null,
      )
      .filter((entry): entry is FileSystemEntry => Boolean(entry))
    const fallbackFiles = Array.from(transfer.files ?? [])

    event.preventDefault()
    event.stopPropagation()
    // Drop data is cleared once the entries were captured so a re-drop of the
    // same payload always fires a fresh cycle.
    transfer.clearData()

    if (!entries.some((entry) => entry.isDirectory)) {
      handleFiles(fallbackFiles)
      return
    }

    setPhase("scanning")
    setEpoch((value) => value + 1)

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
            const node = await directoryEntryToNode(
              entry as FileSystemDirectoryEntry,
            )
            const flattened = flattenFolderNode(node)
            folders.push(flattened.folder)
            skipped += flattened.skipped
          }
        }
      } finally {
        setPhase("idle")
      }
      commitPick({ files, folders, skipped })
    })()
  }

  const handleFolderInputChange = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const selected = Array.from(event.target.files ?? [])
    event.target.value = ""
    if (selected.length === 0) return
    // webkitdirectory paths look like "root/sub/a.pdf" — every file shares the
    // same first segment, which names the folder batch.
    const rootName =
      (
        selected[0] as File & { webkitRelativePath?: string }
      ).webkitRelativePath?.split("/")[0] ?? ""
    const { files, skipped } = partitionLooseFiles(
      selected.map((file) => ({
        file,
        relativePath:
          (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
          file.name,
      })),
    )
    commitPick({
      files: [],
      folders: [{ name: rootName, files, skipped }],
      skipped,
    })
  }

  const acceptedTypes = Array.from(IMPORT_FILE_EXTENSIONS).join(",")

  const label =
    phase === "scanning"
      ? "正在扫描文件夹…"
      : filesDisabled
        ? "选择文件前请先选择知识库"
        : "拖入文件或文件夹，或点击选择文件"

  return (
    <div className="flex flex-col gap-1.5" onDropCapture={handleDropCapture}>
      <div
        onClickCapture={(event) => {
          if (!filesDisabled) return
          // Only the file path needs a target base; folders keep working.
          event.preventDefault()
          event.stopPropagation()
          onPick({ files: [], folders: [], skipped: 0 })
        }}
        onChangeCapture={handleFileInputChange}
      >
        <FileDropzone
          key={epoch}
          multiple
          accept={acceptedTypes}
          // The import queue owns admission and format filtering; the arc
          // component must not cap the batch or reject files on its own.
          maxFiles={Number.MAX_SAFE_INTEGER}
          label={label}
          dropLabel="松开以添加文件或文件夹"
          description={FORMAT_SUMMARY}
          note={LIMIT_NOTE}
          onFilesChange={handleFiles}
        />
      </div>
      <div className="flex justify-center">
        <UiButton
          variant="outline"
          size="sm"
          type="button"
          onClick={() => folderInputRef.current?.click()}
          className="inline-flex h-8 items-center justify-center gap-1.5 px-3.5"
        >
          <Icon icon={FolderOpen} className="size-4" />
          选择文件夹
        </UiButton>
      </div>
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
