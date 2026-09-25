import { Database, X } from "lucide"
import { useCallback, useEffect, useRef, useState } from "react"

import { fetchIngestStatus, submitUrlImport, uploadFileToIngest } from "../../lib/api"
import { cn } from "../../lib/cn"
import { formatBytes, IMPORT_CONCURRENCY, IMPORT_FILE_EXTENSIONS, IMPORT_MAX_FILES_HINT, IMPORT_POLL_MS } from "../../lib/constants"
import { useAppShell } from "../../runtime/AppShellContext"
import { Icon } from "../ui/Icon"

type ImportStatus = "queued" | "uploading" | "pending" | "processing" | "completed" | "failed"

interface ImportItem {
  id: string
  fileName: string
  filePath: string
  size: number
  status: ImportStatus
  docId: string | null
  error: string | null
  file?: File
}

const STATUS_TEXT: Record<ImportStatus, string> = {
  queued: "排队中",
  uploading: "上传中",
  pending: "处理中",
  processing: "处理中",
  completed: "已完成",
  failed: "失败",
}

function createId(prefix: string): string {
  const randomId =
    typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${randomId}`
}

export function ImportDialog({
  open,
  onClose,
  onIngested,
}: {
  open: boolean
  onClose: () => void
  onIngested?: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { showToast } = useAppShell()

  const [tab, setTab] = useState<"folder" | "url">("folder")
  const [urlMode, setUrlMode] = useState<"single" | "sitemap">("single")
  const [url, setUrl] = useState("")
  const [maxPages, setMaxPages] = useState(50)
  const [submitting, setSubmitting] = useState(false)
  const [queue, setQueue] = useState<ImportItem[]>([])

  const queueRef = useRef<ImportItem[]>([])
  queueRef.current = queue
  const pollTimer = useRef<number | null>(null)
  const runningRef = useRef(false)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  // Clear the poll timer when the dialog unmounts.
  useEffect(
    () => () => {
      if (pollTimer.current !== null) window.clearInterval(pollTimer.current)
    },
    [],
  )

  const updateItem = useCallback((id: string, patch: Partial<ImportItem>) => {
    setQueue((current) => {
      const next = current.map((item) => (item.id === id ? { ...item, ...patch } : item))
      queueRef.current = next
      return next
    })
  }, [])

  const stopPollingIfDone = useCallback(() => {
    const hasPending = queueRef.current.some(
      (item) => item.status === "pending" || item.status === "processing",
    )
    if (!hasPending && pollTimer.current !== null) {
      window.clearInterval(pollTimer.current)
      pollTimer.current = null
    }
  }, [])

  const pollSingle = useCallback(
    async (item: ImportItem) => {
      if (!item.docId) return
      try {
        const status = await fetchIngestStatus(item.docId)
        const next = status.status ?? "processing"
        if (next === "completed") updateItem(item.id, { status: "completed", error: null })
        else if (next === "failed")
          updateItem(item.id, { status: "failed", error: status.error ?? "处理失败" })
        else updateItem(item.id, { status: next as ImportStatus })
      } catch (err) {
        updateItem(item.id, {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [updateItem],
  )

  const pollItems = useCallback(async () => {
    const pending = queueRef.current.filter(
      (item) => item.status === "pending" || item.status === "processing",
    )
    if (pending.length === 0) {
      stopPollingIfDone()
      return
    }
    await Promise.all(pending.map(pollSingle))
    stopPollingIfDone()
  }, [pollSingle, stopPollingIfDone])

  const startPolling = useCallback(() => {
    if (pollTimer.current !== null) return
    pollTimer.current = window.setInterval(() => void pollItems(), IMPORT_POLL_MS)
    void pollItems()
  }, [pollItems])

  // ---------------------------------------------------------------------------
  // Folder import
  // ---------------------------------------------------------------------------

  const uploadOne = useCallback(
    async (item: ImportItem) => {
      try {
        const docId = await uploadFileToIngest(item.file as File, item.filePath)
        updateItem(item.id, { status: "pending", docId })
      } catch (err) {
        updateItem(item.id, {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [updateItem],
  )

  const handleFolderSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files
    if (!fileList || fileList.length === 0) return
    if (runningRef.current) return

    const accepted: File[] = []
    for (const file of Array.from(fileList)) {
      const dotIndex = file.name.lastIndexOf(".")
      const ext = dotIndex >= 0 ? file.name.slice(dotIndex).toLowerCase() : ""
      if (IMPORT_FILE_EXTENSIONS.has(ext)) accepted.push(file)
    }
    if (accepted.length === 0) {
      showToast("所选文件夹中没有支持的文档类型")
      setQueue([])
      return
    }
    if (accepted.length > IMPORT_MAX_FILES_HINT) {
      showToast(`共 ${accepted.length} 个文件，建议分批导入（单次 ≤ ${IMPORT_MAX_FILES_HINT}）`)
    }

    const items: ImportItem[] = accepted.map((file) => ({
      id: createId("imp"),
      fileName: file.name,
      filePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      size: file.size,
      status: "queued",
      docId: null,
      error: null,
      file,
    }))
    setQueue(items)
    queueRef.current = items
    runningRef.current = true

    const workQueue = [...items]
    const workers = Array.from({ length: Math.min(IMPORT_CONCURRENCY, items.length) }, async () => {
      while (workQueue.length > 0) {
        const item = workQueue.shift()
        if (!item) break
        updateItem(item.id, { status: "uploading" })
        await uploadOne(item)
        startPolling()
      }
    })
    await Promise.all(workers)

    runningRef.current = false
    const failed = queueRef.current.filter((item) => item.status === "failed").length
    const completed = queueRef.current.filter((item) => item.status === "completed").length
    showToast(
      failed === 0
        ? `导入完成：${completed} 个文件已入知识库`
        : `导入结束：${completed} 成功，${failed} 失败`,
    )
    onIngested?.()
  }

  // ---------------------------------------------------------------------------
  // URL import
  // ---------------------------------------------------------------------------

  const handleUrlImport = async () => {
    const trimmed = url.trim()
    if (!trimmed) {
      showToast("请输入 URL")
      return
    }
    let pages = 50
    if (urlMode === "sitemap") {
      if (!Number.isFinite(maxPages) || maxPages < 1 || maxPages > 200) {
        showToast("maxPages 必须在 1-200 之间")
        return
      }
      pages = maxPages
    }

    setSubmitting(true)
    try {
      const data = await submitUrlImport(trimmed, urlMode, pages)
      if (urlMode === "single") {
        setQueue([
          {
            id: createId("imp"),
            fileName: data.docId ?? trimmed,
            filePath: trimmed,
            size: 0,
            status: "pending",
            docId: data.docId ?? null,
            error: null,
          },
        ])
        showToast("已提交，正在处理…")
      } else {
        setQueue(
          (data.items ?? []).map((item) => ({
            id: createId("imp"),
            fileName: item.url,
            filePath: item.url,
            size: 0,
            status: item.docId ? "pending" : "failed",
            docId: item.docId ?? null,
            error: item.docId ? null : item.status ?? "提交失败",
          })),
        )
        showToast(`已提交 ${data.submitted} 个页面`)
      }
      startPolling()
    } catch (err) {
      showToast(`提交失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      aria-labelledby="import-title"
      className="m-auto h-[min(580px,calc(100dvh-48px))] w-[min(500px,calc(100vw-32px))] overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-dialog backdrop:bg-black/20 open:flex open:flex-col max-md:m-0 max-md:h-dvh max-md:w-screen max-md:rounded-none max-md:border-0"
    >
      <div className="flex h-12 flex-none items-center justify-between border-b border-line px-5 max-md:px-4">
        <div className="flex items-center gap-2">
          <Icon icon={Database} className="size-4 text-muted" />
          <h2 id="import-title" className="text-sm font-semibold text-ink">
            导入知识库文档
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          title="关闭"
          className="grid size-7 flex-none cursor-pointer place-items-center rounded-md text-muted/70 transition-colors hover:bg-surface-subtle hover:text-ink"
        >
          <Icon icon={X} className="size-3.5" />
        </button>
      </div>

      <div className="flex-none border-b border-line px-5 pt-1 max-md:px-4" role="tablist" aria-label="导入方式">
        <div className="flex items-center gap-4">
          {(
            [
              { id: "folder", label: "本地文件夹" },
              { id: "url", label: "在线网页 (URL)" },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={cn(
                "relative h-8.5 cursor-pointer bg-transparent px-1 text-xs transition-colors hover:text-ink",
                tab === item.id
                  ? "font-semibold text-ink after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-neutral-900 after:content-[''] dark:after:bg-neutral-100"
                  : "text-muted",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "folder" ? (
        <section className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-5 max-md:px-4" role="tabpanel">
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line bg-surface-subtle/50 px-4 py-8 text-center">
            <Icon icon={Database} className="mb-2.5 size-8 text-muted/50" />
            <h3 className="text-xs font-semibold text-ink">选择文档文件夹</h3>
            <p className="mt-0.5 text-[11px] text-muted/70">支持 PDF, Word, Markdown, HTML, Excel, PPT</p>
            <label className="mt-4 inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-neutral-900 px-3.5 text-xs font-medium text-white transition-colors hover:bg-neutral-800 dark:bg-neutral-200 dark:text-neutral-900 dark:hover:bg-white">
              <span>选择文件夹</span>
              <input
                type="file"
                className="hidden"
                // @ts-expect-error webkitdirectory is not in the standard React types
                webkitdirectory=""
                multiple
                accept=".pdf,.doc,.docx,.md,.txt,.html,.htm,.xls,.xlsx,.ppt,.pptx"
                onChange={(event) => void handleFolderSelect(event)}
              />
            </label>
          </div>
        </section>
      ) : (
        <section className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-5 max-md:px-4" role="tabpanel">
          <div className="mb-4 inline-flex items-center rounded-[8px] bg-surface-subtle p-1">
            {(
              [
                { id: "single", label: "单个网页" },
                { id: "sitemap", label: "网站抓取 (Sitemap)" },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setUrlMode(item.id)}
                className={cn(
                  "relative flex h-8 cursor-pointer items-center justify-center rounded-[6px] px-4 text-[13px] font-medium transition-[color,background-color,box-shadow] duration-150 ease-out",
                  urlMode === item.id
                    ? "bg-surface text-ink shadow-sm"
                    : "text-muted hover:bg-surface/50 hover:text-ink",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="import-url-input" className="text-[13px] font-medium text-ink">
                {urlMode === "single" ? "网页链接" : "Sitemap 链接"}
              </label>
              <input
                id="import-url-input"
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder={urlMode === "single" ? "https://example.com/article" : "https://example.com/sitemap.xml"}
                className="h-10 w-full rounded-[8px] border border-line bg-surface-subtle/50 px-3.5 text-[14px] text-ink outline-none transition-colors placeholder:text-muted/50 focus:border-muted/50 focus:bg-surface"
              />
            </div>

            {urlMode === "sitemap" ? (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="import-url-max-pages" className="text-[13px] font-medium text-ink">
                  最大抓取页数
                </label>
                <input
                  id="import-url-max-pages"
                  type="number"
                  min={1}
                  max={200}
                  value={maxPages}
                  onChange={(event) => setMaxPages(Number(event.target.value))}
                  className="h-10 w-full rounded-[8px] border border-line bg-surface-subtle/50 px-3.5 text-[14px] text-ink outline-none transition-colors focus:border-muted/50 focus:bg-surface"
                />
              </div>
            ) : null}

            <button
              type="button"
              disabled={submitting}
              onClick={() => void handleUrlImport()}
              className="mt-2 inline-flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-[8px] bg-neutral-900 px-4 text-[14px] font-medium text-white shadow-sm transition-[color,background-color,border-color,box-shadow,transform,translate,scale] duration-150 ease-out hover:bg-neutral-800 hover:shadow-md active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 dark:bg-neutral-200 dark:text-neutral-900 dark:hover:bg-white"
            >
              {submitting ? "导入中…" : urlMode === "single" ? "导入该网页" : "批量导入"}
            </button>
          </div>
        </section>
      )}

      {queue.length > 0 ? (
        <div className="border-t border-line px-5 py-3 max-md:px-4">
          <ul className="grid max-h-40 grid-cols-1 gap-1.5 overflow-y-auto">
            {queue.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-subtle/40 px-2.5 py-1.5 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-ink" title={item.filePath}>
                    {item.fileName}
                  </div>
                  {item.error ? (
                    <div className="truncate text-[11px] text-red-600">{item.error}</div>
                  ) : item.size > 0 ? (
                    <div className="text-[11px] text-muted/70">{formatBytes(item.size)}</div>
                  ) : null}
                </div>
                <span
                  className={cn(
                    "flex-none rounded-full px-2 py-0.5 text-[10px] font-medium",
                    item.status === "completed"
                      ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400"
                      : item.status === "failed"
                        ? "bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400"
                        : "bg-surface-subtle text-muted",
                  )}
                >
                  {STATUS_TEXT[item.status]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </dialog>
  )
}
