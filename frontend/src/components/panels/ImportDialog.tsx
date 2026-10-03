import { Database, X } from "../ui/icons"
import { useCallback, useEffect, useRef, useState } from "react"

import {
  cancelIngest,
  createKnowledgeBase,
  fetchDocumentDetail,
  fetchDocumentFolders,
  fetchIngestStatus,
  fetchKnowledgeBaseDocuments,
  retireSource,
  submitUrlImport,
  uploadFileToIngest,
  type DocumentCatalogEntryPayload,
  type DocumentFolderPayload,
} from "../../lib/api"
import { cn } from "../../lib/cn"
import { formatBytes, IMPORT_CONCURRENCY, IMPORT_MAX_FILES_HINT, IMPORT_MAX_FILE_BYTES, IMPORT_POLL_MS } from "../../lib/constants"
import {
  categoryForPath,
  countActiveImports,
  describeImportError,
  findReusableKnowledgeBase,
  freezeWaveParams,
  IMPORT_TERMINAL_STATUSES,
  matchExistingFileNames,
  sanitizeKnowledgeBaseName,
  type ImportWaveParams,
  type PickedFile,
  type PickedFolder,
} from "../../lib/importBatch"
import { useAppShell } from "../../runtime/AppShellContext"
import { knowledgeStore, useKnowledgeBases } from "../../runtime/knowledgeStore"
import { useSignedInSession } from "../../runtime/SessionContext"
import { Icon } from "../ui/Icon"
import { deriveIngestProgress, initialImportProgress, type ImportProgress as Progress, type ImportStatus, type UploadProgress } from "../../lib/ingestProgress"
import { ImportProgress } from "./ImportProgress"
import { ImportDropzone, type DropzonePick } from "./ImportDropzone"
import { ImportAdvancedOptions } from "./ImportAdvancedOptions"


/**
 * The import dialog (tickets 03/05/06/07): a two-path importer. What the user
 * GIVES decides the path — a folder import creates (or reuses) its own
 * knowledge base and maps subfolders to document folders; loose files go to
 * the selected base; URLs stay a secondary tab. Every pick starts a WAVE that
 * freezes its target params, rows accumulate across waves, and each row owns
 * its lifecycle actions (remove / cancel / retry / delete / view). The
 * decision logic lives in lib/importBatch; this component is IO + rendering.
 */

interface ImportWave {
  id: string
  /** Queue section label, e.g. 「将创建知识库「X」」/「复用现有知识库「X」」. */
  label: string
  kind: "files" | "folder" | "url"
  params: ImportWaveParams
}

interface ImportItem {
  id: string
  waveId: string
  fileName: string
  filePath: string
  size: number
  status: ImportStatus
  docId: string | null
  error: string | null
  /** Per-item folder header: folder waves map each file to a category. */
  folderName?: string
  /** Pre-check hit: the row waits for 仍要导入/跳过 and is not auto-uploaded. */
  precheckHit?: boolean
  progress?: Progress
  uploadProgress?: UploadProgress
  checkedAt?: string
  syncError?: string | null
  file?: File
  sourceUrl?: string
  processingStartedAt?: number
  lastProgressAt?: number
  timeoutWarned?: boolean
}

const IMPORT_STALL_MS = 5 * 60_000
/** The pre-check catalog read is bounded: 5 pages × 100 rows, aligned with the
 * ≤500-per-batch hint; past the cap (or on error) the import proceeds and the
 * server's 409 is the safety net. */
const PRECHECK_MAX_PAGES = 5
const PRECHECK_PAGE_SIZE = 100

const STATUS_TEXT: Record<ImportStatus, string> = {
  queued: "排队中",
  uploading: "上传中",
  pending: "处理中",
  processing: "处理中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
}

function createId(prefix: string): string {
  const randomId =
    typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${randomId}`
}

function fallbackBaseName(): string {
  return `导入 ${new Date().toISOString().slice(0, 16).replace("T", " ")}`
}

function parseTags(tagsText: string): string[] {
  return tagsText.split(",").map((tag) => tag.trim()).filter(Boolean)
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Paged catalog read for the pre-check and conflict lookups. */
async function collectCatalogEntries(
  knowledgeBaseId: string,
  folderName: string,
): Promise<DocumentCatalogEntryPayload[]> {
  const collected: DocumentCatalogEntryPayload[] = []
  for (let page = 1; page <= PRECHECK_MAX_PAGES; page += 1) {
    const body = await fetchKnowledgeBaseDocuments(
      knowledgeBaseId,
      { page, status: "", tag: "", folder: folderName },
      PRECHECK_PAGE_SIZE,
    )
    collected.push(...body.documents)
    if (body.documents.length < PRECHECK_PAGE_SIZE) break
    if (body.total > 0 && collected.length >= body.total) break
  }
  return collected
}

export function ImportDialog({
  open,
  onClose,
  onIngested,
  onActiveCountChange,
}: {
  open: boolean
  onClose: () => void
  onIngested?: () => void
  /** Sidebar badge (ticket 08): rows that still owe the user an outcome. */
  onActiveCountChange?: (activeCount: number) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { showToast, openDocument, openKnowledge } = useAppShell()
  const { activeKnowledgeBases: bases, folders, status: baseStatus } = useKnowledgeBases()
  const canCreate = useSignedInSession()?.scopes.includes("admin") ?? false
  const [knowledgeBaseId, setKnowledgeBaseId] = useState("")
  const [newBaseName, setNewBaseName] = useState("")
  const [creating, setCreating] = useState(false)
  const [showCreateBase, setShowCreateBase] = useState(false)
  // The directory this batch is filed into. A document folder belongs to ONE
  // knowledge base, so the picker waits for a target base.
  const [documentFolders, setDocumentFolders] = useState<DocumentFolderPayload[]>([])
  const [documentFoldersStatus, setDocumentFoldersStatus] = useState<"idle" | "loading" | "ready">("idle")
  const [documentFolderId, setDocumentFolderId] = useState("")
  const [categoryCreatorOpen, setCategoryCreatorOpen] = useState(false)
  const [categoryDraft, setCategoryDraft] = useState("")
  const [pendingCategoryName, setPendingCategoryName] = useState("")

  const [parser, setParser] = useState("")
  const [tagsText, setTagsText] = useState("")

  const [tab, setTab] = useState<"local" | "url">("local")
  const [urlMode, setUrlMode] = useState<"single" | "sitemap">("single")
  const [url, setUrl] = useState("")
  const [maxPages, setMaxPages] = useState(50)
  const [submitting, setSubmitting] = useState(false)
  const [waves, setWaves] = useState<ImportWave[]>([])
  const [queue, setQueue] = useState<ImportItem[]>([])
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)

  const queueRef = useRef<ImportItem[]>([])
  queueRef.current = queue
  const wavesRef = useRef<ImportWave[]>([])
  wavesRef.current = waves
  /** Rows a worker has claimed; claims happen synchronously so two workers
   * never pick up the same row. */
  const claimedRef = useRef(new Set<string>())
  const workersRunningRef = useRef(false)
  const pollTimer = useRef<number | null>(null)
  const pollingRef = useRef(false)
  const completionNotifiedRef = useRef(false)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  useEffect(() => {
    if (open) void knowledgeStore.refresh()
  }, [open])

  useEffect(() => {
    onActiveCountChange?.(countActiveImports(queue))
  }, [queue, onActiveCountChange])

  useEffect(() => {
    if (!knowledgeBaseId) {
      setDocumentFolders([])
      setDocumentFoldersStatus("idle")
      setDocumentFolderId("")
      setPendingCategoryName("")
      setCategoryCreatorOpen(false)
      return
    }
    let cancelled = false
    setDocumentFoldersStatus("loading")
    void fetchDocumentFolders(knowledgeBaseId)
      .then((list) => {
        if (cancelled) return
        setDocumentFolders(list)
        setDocumentFoldersStatus("ready")
      })
      .catch(() => {
        if (cancelled) return
        // The picker simply offers "新建" only; the upload path still registers
        // whatever name is typed, so a failed list is not a blocked import.
        setDocumentFolders([])
        setDocumentFoldersStatus("ready")
      })
    return () => {
      cancelled = true
    }
  }, [knowledgeBaseId])

  // Clear the poll timer when the dialog unmounts.
  useEffect(
    () => () => {
      if (pollTimer.current !== null) window.clearInterval(pollTimer.current)
    },
    [],
  )

  /** Every queue write goes through here. The REF is the source of truth and
   * is written EAGERLY — React defers state updaters until render, but workers
   * and row actions read the ref in the same tick as the mutation, so the
   * updater form silently starved the upload scheduler (found in live testing). */
  const mutateQueue = useCallback((mutate: (current: ImportItem[]) => ImportItem[]) => {
    queueRef.current = mutate(queueRef.current)
    setQueue(queueRef.current)
  }, [])

  const updateItem = useCallback((id: string, patch: Partial<ImportItem>) => {
    mutateQueue((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }, [mutateQueue])

  const appendQueue = useCallback((items: ImportItem[]) => {
    mutateQueue((current) => [...current, ...items])
  }, [mutateQueue])

  /** Registers a wave in BOTH the state and its ref: workers read the ref in
   * the same tick as enqueue, before React re-renders. */
  const appendWave = useCallback((wave: ImportWave) => {
    wavesRef.current = [...wavesRef.current, wave]
    setWaves((current) => [...current, wave])
  }, [])

  const removeItem = useCallback((id: string) => {
    mutateQueue((current) => current.filter((item) => item.id !== id))
  }, [mutateQueue])

  const stopPollingIfDone = useCallback(() => {
    const hasPending = queueRef.current.some(
      (item) => item.status === "pending" || item.status === "processing",
    )
    if (!hasPending && pollTimer.current !== null) {
      window.clearInterval(pollTimer.current)
      pollTimer.current = null
    }
    const terminal = new Set<string>(IMPORT_TERMINAL_STATUSES)
    const settled = queueRef.current.length > 0 && !workersRunningRef.current &&
      queueRef.current.every((item) => terminal.has(item.status))
    if (settled && !completionNotifiedRef.current) {
      completionNotifiedRef.current = true
      const completed = queueRef.current.filter((item) => item.status === "completed").length
      const failed = queueRef.current.filter((item) => item.status === "failed").length
      const cancelled = queueRef.current.filter((item) => item.status === "cancelled").length
      showToast(`处理结束：${completed} 成功${failed ? `，${failed} 失败` : ""}${cancelled ? `，${cancelled} 已取消` : ""}`)
      if (completed > 0) onIngested?.()
    }
  }, [onIngested, showToast])

  const pollSingle = useCallback(
    async (item: ImportItem) => {
      if (!item.docId) return
      try {
        const progress = deriveIngestProgress(await fetchIngestStatus(item.docId))
        const now = Date.now()
        const processingStartedAt = progress.status === "processing" && item.status !== "processing"
          ? now : item.processingStartedAt
        const changed = !item.progress || progress.summary !== item.progress.summary ||
          progress.stages.some((stage, index) => stage.status !== item.progress?.stages[index]?.status)
        const lastProgressAt = changed ? now : item.lastProgressAt ?? now
        const stalled = now - lastProgressAt >= IMPORT_STALL_MS && !item.timeoutWarned
        if (stalled) showToast(`${item.fileName} 处理超时，请查看文档状态或稍后重试`)
        updateItem(item.id, {
          status: progress.status, progress, error: progress.status === "failed" ? progress.error : null,
          checkedAt: new Date().toISOString(), syncError: stalled || item.timeoutWarned ? "处理时间超过预期，服务器可能仍在运行" : null,
          lastProgressAt, timeoutWarned: stalled || item.timeoutWarned, processingStartedAt,
        })
      } catch (err) {
        const timedOut = Date.now() - (item.lastProgressAt ?? Date.now()) >= IMPORT_STALL_MS && !item.timeoutWarned
        if (timedOut) showToast(`${item.fileName} 状态查询超时，请检查服务连接`)
        updateItem(item.id, {
          syncError: timedOut ? "状态查询持续超时，请检查服务连接" : errorMessageOf(err),
          timeoutWarned: timedOut || item.timeoutWarned,
        })
      }
    },
    [updateItem, showToast],
  )

  const pollItems = useCallback(async () => {
    if (pollingRef.current) return
    const pending = queueRef.current.filter(
      (item) => item.status === "pending" || item.status === "processing",
    )
    if (pending.length === 0) {
      stopPollingIfDone()
      return
    }
    pollingRef.current = true
    try {
      await Promise.all(pending.map(pollSingle))
      stopPollingIfDone()
    } finally {
      pollingRef.current = false
    }
  }, [pollSingle, stopPollingIfDone])

  const startPolling = useCallback(() => {
    if (pollTimer.current !== null) return
    pollTimer.current = window.setInterval(() => void pollItems(), IMPORT_POLL_MS)
    void pollItems()
  }, [pollItems])

  // ---------------------------------------------------------------------------
  // Upload worker pool — rows accumulate across waves; workers pull whatever
  // is queued next (a claim is synchronous, so rows are never double-picked).
  // ---------------------------------------------------------------------------

  const uploadOne = useCallback(
    async (item: ImportItem) => {
      const wave = wavesRef.current.find((candidate) => candidate.id === item.waveId)
      updateItem(item.id, {
        status: "uploading",
        error: null,
        uploadProgress: { loaded: 0, total: item.size, startedAt: Date.now(), updatedAt: Date.now() },
      })
      try {
        const docId = await uploadFileToIngest(
          item.file as File,
          item.filePath,
          (loaded, total) => {
            updateItem(item.id, { uploadProgress: {
              loaded, total, startedAt: item.uploadProgress?.startedAt ?? Date.now(), updatedAt: Date.now(),
            } })
          },
          {
            knowledgeBaseId: wave?.params.knowledgeBaseId,
            folder: item.folderName ?? wave?.params.folder,
            parser: wave?.params.parser,
            tags: wave?.params.tags,
          },
        )
        if (!docId) throw new Error("上传响应缺少文档 ID")
        updateItem(item.id, { status: "pending", docId, lastProgressAt: Date.now() })
        // The first poll fires immediately so the row shows real stage
        // progress instead of sitting on the upload-done placeholder.
        startPolling()
      } catch (err) {
        updateItem(item.id, {
          status: "failed",
          error: errorMessageOf(err),
        })
      }
    },
    [updateItem, startPolling],
  )

  const ensureWorkers = useCallback(() => {
    if (workersRunningRef.current) return
    workersRunningRef.current = true
    const run = async () => {
      try {
        for (;;) {
          const item = queueRef.current.find(
            (candidate) =>
              candidate.status === "queued" &&
              !candidate.precheckHit &&
              !claimedRef.current.has(candidate.id),
          )
          if (!item) break
          claimedRef.current.add(item.id)
          try {
            await uploadOne(item)
          } finally {
            claimedRef.current.delete(item.id)
          }
        }
      } finally {
        workersRunningRef.current = false
        stopPollingIfDone()
      }
    }
    for (let worker = 0; worker < IMPORT_CONCURRENCY; worker += 1) void run()
  }, [uploadOne, startPolling, stopPollingIfDone])

  // ---------------------------------------------------------------------------
  // Wave builders
  // ---------------------------------------------------------------------------

  /** The pre-check reads the catalog by folder NAME; a freshly typed category
   * has no documents by definition, so those waves skip the read. */
  const precheckFolderName = useCallback((params: ImportWaveParams): string | null => {
    if (params.folder && pendingCategoryName && params.folder === pendingCategoryName) return null
    if (!params.folder) return ""
    const known = documentFolders.find((folder) => folder.id === params.folder)
    return known?.name ?? null
  }, [pendingCategoryName, documentFolders])

  const oversizeItems = useCallback((picked: PickedFile[], waveId: string): ImportItem[] => {
    const maxMb = IMPORT_MAX_FILE_BYTES / 1024 / 1024
    return picked.map(({ file, relativePath }) => {
      const oversized = file.size > IMPORT_MAX_FILE_BYTES
      return {
        id: createId("imp"),
        waveId,
        fileName: file.name,
        filePath: relativePath,
        size: file.size,
        status: oversized ? "failed" : "queued",
        docId: null,
        error: oversized ? `文件超过 ${maxMb}MB 上限` : null,
        file,
      }
    })
  }, [])

  const enqueueFileWave = useCallback(
    async (picked: PickedFile[], skippedCount: number) => {
      const wave: ImportWave = {
        id: createId("wave"),
        label: `导入到「${bases.find((base) => base.id === knowledgeBaseId)?.name ?? "知识库"}」`,
        kind: "files",
        params: freezeWaveParams({
          knowledgeBaseId,
          folder: pendingCategoryName || documentFolderId || undefined,
          parser,
          tags: parseTags(tagsText),
        }),
      }
      const items = oversizeItems(picked, wave.id)
      if (skippedCount > 0) showToast(`已跳过 ${skippedCount} 个不支持的文件`)
      if (items.length > IMPORT_MAX_FILES_HINT) {
        showToast(`共 ${items.length} 个文件，建议分批导入（单次 ≤ ${IMPORT_MAX_FILES_HINT}）`)
      }
      appendWave(wave)
      appendQueue(items)
      completionNotifiedRef.current = false

      // Bounded duplicate pre-check BEFORE the first upload: the point of the
      // mark is to let the user decide, so workers must not outrun it (live
      // testing showed millisecond uploads beating the catalog read). The read
      // is bounded and best-effort — a failure here proceeds straight to
      // upload, with the server's 409 as the safety net.
      const folderName = precheckFolderName(wave.params)
      if (folderName !== null) {
        try {
          const entries = await collectCatalogEntries(wave.params.knowledgeBaseId, folderName)
          const hits = matchExistingFileNames(
            entries.map((entry) => entry.fileName ?? ""),
            items.map((item) => item.fileName),
          )
          if (hits.size > 0) {
            mutateQueue((current) => current.map((item) =>
              item.waveId === wave.id && item.status === "queued" && hits.has(item.fileName)
                ? { ...item, precheckHit: true }
                : item,
            ))
            showToast(`${hits.size} 个文件在目标库中已存在，请在队列中确认`)
          }
        } catch {
          // Best-effort: the server's 409 covers whatever the pre-check missed.
        }
      }
      ensureWorkers()
    },
    [
      bases, knowledgeBaseId, pendingCategoryName, documentFolderId, parser, tagsText,
      oversizeItems, appendQueue, showToast, precheckFolderName, ensureWorkers, mutateQueue,
    ],
  )

  const enqueueFolderWave = useCallback(
    async (folder: PickedFolder) => {
      if (folder.files.length === 0) {
        showToast(`文件夹「${folder.name}」中没有支持的文件格式`)
        return
      }
      if (folder.skipped > 0) {
        showToast(`文件夹「${folder.name}」已跳过 ${folder.skipped} 个不支持的文件`)
      }
      const baseName = sanitizeKnowledgeBaseName(folder.name, fallbackBaseName())
      const reusable = findReusableKnowledgeBase(bases, baseName)
      let waveKnowledgeBaseId: string
      let label: string
      if (reusable) {
        waveKnowledgeBaseId = reusable.id
        label = `复用现有知识库「${reusable.name}」`
        showToast(`已导入到现有知识库「${reusable.name}」`)
      } else {
        try {
          const created = await createKnowledgeBase(baseName)
          waveKnowledgeBaseId = created.id
          label = `将创建知识库「${created.name}」`
          await knowledgeStore.refresh()
          showToast(`已创建知识库「${created.name}」`)
        } catch (error) {
          showToast(`知识库「${baseName}」创建失败：${errorMessageOf(error)}，未导入任何文件`)
          return
        }
      }
      const wave: ImportWave = {
        id: createId("wave"),
        label,
        kind: "folder",
        params: freezeWaveParams({ knowledgeBaseId: waveKnowledgeBaseId }),
      }
      const items = oversizeItems(folder.files, wave.id).map((item) => ({
        ...item,
        folderName: categoryForPath(item.filePath, folder.name),
      }))
      appendWave(wave)
      appendQueue(items)
      completionNotifiedRef.current = false
      ensureWorkers()
    },
    [bases, oversizeItems, appendQueue, showToast, ensureWorkers],
  )

  const handlePick = useCallback(
    (pick: DropzonePick) => {
      if (pick.files.length > 0 || pick.folders.length === 0) {
        if (!knowledgeBaseId) {
          showToast("请先选择知识库")
        } else if (pick.files.length > 0) {
          void enqueueFileWave(pick.files, pick.skipped)
        } else if (pick.skipped > 0) {
          showToast(`已跳过 ${pick.skipped} 个不支持的文件`)
        }
      }
      for (const folder of pick.folders) {
        void enqueueFolderWave(folder)
      }
    },
    [knowledgeBaseId, enqueueFileWave, enqueueFolderWave, showToast],
  )

  // ---------------------------------------------------------------------------
  // Row actions
  // ---------------------------------------------------------------------------

  const cancelItem = useCallback(
    async (item: ImportItem) => {
      if (item.docId) {
        try {
          await cancelIngest(item.docId)
        } catch {
          // The task already settled server-side; the row reflects the local
          // cancelled state either way.
        }
      }
      updateItem(item.id, { status: "cancelled" })
      stopPollingIfDone()
    },
    [updateItem, stopPollingIfDone],
  )

  /** A failed URL row re-submits its page: single-page fetches fail transiently
   * (502) and the row carries the URL it needs. The wave's frozen target
   * params keep the retry on the same knowledge base and folder. */
  const resubmitUrlItem = useCallback(
    async (item: ImportItem) => {
      const wave = wavesRef.current.find((candidate) => candidate.id === item.waveId)
      if (!item.sourceUrl || !wave) return
      updateItem(item.id, { status: "pending", error: null, lastProgressAt: Date.now() })
      try {
        const data = await submitUrlImport(item.sourceUrl, "single", 50, wave.params.knowledgeBaseId, wave.params.folder)
        updateItem(item.id, {
          status: data.docId ? "pending" : "failed",
          docId: data.docId ?? null,
          error: data.docId ? null : "提交失败",
          lastProgressAt: Date.now(),
        })
        startPolling()
      } catch (err) {
        updateItem(item.id, { status: "failed", error: errorMessageOf(err) })
      }
    },
    [updateItem, startPolling],
  )

  const retryItem = useCallback(
    (item: ImportItem) => {
      // URL rows re-submit their URL (a transient fetch failure is retryable);
      // file rows re-upload from the still-held File handle.
      if (!item.file && item.sourceUrl) {
        void resubmitUrlItem(item)
        return
      }
      updateItem(item.id, {
        status: "queued",
        error: null,
        docId: null,
        progress: initialImportProgress("queued"),
        uploadProgress: undefined,
        syncError: null,
        timeoutWarned: false,
        lastProgressAt: Date.now(),
      })
      ensureWorkers()
    },
    [updateItem, ensureWorkers, resubmitUrlItem],
  )

  const deleteItem = useCallback(
    async (item: ImportItem) => {
      if (!item.docId) return
      setConfirmingDeleteId(null)
      try {
        const detail = await fetchDocumentDetail(item.docId)
        await retireSource(detail.document.sourceId, "removed from the import dialog")
        removeItem(item.id)
        showToast(`已删除「${item.fileName}」，文档已退役且不可恢复`)
      } catch (error) {
        showToast(`删除失败：${errorMessageOf(error)}`)
      }
    },
    [removeItem, showToast],
  )

  /** A conflict row has no docId of its own (the submit was rejected); locate
   * the existing document in the target catalog by name or source URL. */
  const viewConflictDocument = useCallback(
    async (item: ImportItem) => {
      const wave = wavesRef.current.find((candidate) => candidate.id === item.waveId)
      const knowledgeBaseIdForWave = wave?.params.knowledgeBaseId
      if (!knowledgeBaseIdForWave) return
      try {
        const entries = await collectCatalogEntries(knowledgeBaseIdForWave, "")
        const normalized = item.sourceUrl ?? item.fileName
        const found = entries.find((entry) =>
          entry.source === normalized || entry.fileName === item.fileName || entry.title === item.fileName,
        )
        if (found) {
          openDocument({ documentId: found.docId })
          return
        }
      } catch {
        // Fall through to the catalog page.
      }
      openKnowledge()
    },
    [openDocument, openKnowledge],
  )

  // ---------------------------------------------------------------------------
  // Create knowledge base (secondary entry / empty state)
  // ---------------------------------------------------------------------------

  const createBase = async () => {
    const name = newBaseName.trim()
    if (!name) return
    setCreating(true)
    try {
      const base = await createKnowledgeBase(name)
      setKnowledgeBaseId(base.id)
      await knowledgeStore.refresh()
      setNewBaseName("")
      setShowCreateBase(false)
      showToast(`已创建知识库「${base.name}」`)
    } catch (error) {
      await knowledgeStore.refresh()
      showToast(errorMessageOf(error) || "知识库创建失败")
    } finally {
      setCreating(false)
    }
  }

  const confirmCategoryDraft = () => {
    const name = categoryDraft.trim()
    setCategoryCreatorOpen(false)
    setCategoryDraft("")
    if (name) {
      setPendingCategoryName(name)
      setDocumentFolderId("")
    }
  }

  /** The folder header a file upload carries: a freshly typed name wins over
   * the picked directory; the server registers unknown names on arrival. */
  const folderArgument = (): string | undefined => {
    if (pendingCategoryName) return pendingCategoryName
    if (!documentFolderId) return undefined
    return documentFolderId
  }

  // ---------------------------------------------------------------------------
  // URL import
  // ---------------------------------------------------------------------------

  const handleUrlImport = async () => {
    if (!knowledgeBaseId) { showToast("请先选择知识库"); return }
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
      const data = await submitUrlImport(trimmed, urlMode, pages, knowledgeBaseId, folderArgument())
      const submittedAt = Date.now()
      completionNotifiedRef.current = false
      const wave: ImportWave = {
        id: createId("wave"),
        label: urlMode === "single" ? `网页导入「${trimmed}」` : `Sitemap 抓取（${data.submitted ?? 0} 页）`,
        kind: "url",
        params: freezeWaveParams({ knowledgeBaseId, folder: folderArgument() }),
      }
      const items: ImportItem[] = urlMode === "single"
        ? [
          {
            id: createId("imp"),
            waveId: wave.id,
            fileName: data.docId ?? trimmed,
            filePath: trimmed,
            size: 0,
            status: data.docId ? "pending" : "failed",
            docId: data.docId ?? null,
            error: data.docId ? null : "提交失败",
            sourceUrl: trimmed,
            lastProgressAt: submittedAt,
          },
        ]
        : (data.items ?? []).map((entry) => ({
            id: createId("imp"),
            waveId: wave.id,
            fileName: entry.url,
            filePath: entry.url,
            size: 0,
            status: entry.docId ? "pending" : "failed",
            docId: entry.docId ?? null,
            error: entry.docId ? null : entry.status ?? "提交失败",
            sourceUrl: entry.url,
            lastProgressAt: submittedAt,
          }))
      appendWave(wave)
      appendQueue(items)
      showToast(urlMode === "single" ? "已提交，正在处理…" : `已提交 ${data.submitted} 个页面`)
      startPolling()
    } catch (err) {
      const message = errorMessageOf(err)
      const view = describeImportError(message)
      if (view.kind === "conflict") {
        // A rejected duplicate is not a failure: surface it as a row the user
        // can inspect instead of a dead-end toast.
        const wave: ImportWave = {
          id: createId("wave"),
          label: `网页导入「${trimmed}」`,
          kind: "url",
          params: freezeWaveParams({ knowledgeBaseId }),
        }
        appendWave(wave)
        appendQueue([{
          id: createId("imp"),
          waveId: wave.id,
          fileName: trimmed,
          filePath: trimmed,
          size: 0,
          status: "failed",
          docId: null,
          error: message,
          sourceUrl: trimmed,
          lastProgressAt: Date.now(),
        }])
        showToast("该网页已导入过")
      } else {
        showToast(`提交失败：${message}`)
      }
    } finally {
      setSubmitting(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  const baseOptions = (
    <>
      <option value="">{baseStatus === "loading" ? "正在加载…" : "请选择知识库"}</option>
      {folders.map((folder) => <optgroup key={folder.id} label={folder.name}>
        {bases.filter((base) => base.folderId === folder.id).map((base) => <option key={base.id} value={base.id}>{base.name}</option>)}
      </optgroup>)}
      {bases.filter((base) => !base.folderId || !folders.some((folder) => folder.id === base.folderId))
        .map((base) => <option key={base.id} value={base.id}>{base.name}</option>)}
    </>
  )

  const createBaseRow = (
    <div className="mt-2 flex gap-2">
      <input
        aria-label="新知识库名称"
        value={newBaseName}
        onChange={(event) => setNewBaseName(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") void createBase() }}
        placeholder="新知识库名称"
        autoFocus
        className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none placeholder:text-faint focus:border-brand"
      />
      <button
        type="button"
        disabled={creating || !newBaseName.trim()}
        onClick={() => void createBase()}
        className="rounded-md border border-line px-2 text-xs text-ink transition-colors hover:bg-surface-subtle disabled:opacity-50"
      >
        {creating ? "创建中…" : "创建"}
      </button>
    </div>
  )

  const completedCount = queue.filter((item) => item.status === "completed").length
  const failedCount = queue.filter((item) => item.status === "failed").length
  const cancelledCount = queue.filter((item) => item.status === "cancelled").length

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      aria-labelledby="import-title"
      className="m-auto max-h-[min(640px,calc(100dvh-48px))] w-[min(520px,calc(100vw-32px))] overflow-hidden rounded-dialog border border-line bg-surface text-ink shadow-dialog open:flex open:flex-col max-md:m-0 max-md:h-dvh max-md:w-screen max-md:rounded-none max-md:border-0"
    >
      <div className="flex h-13 flex-none items-center justify-between border-b border-line px-5 max-md:px-4">
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

      <div className="flex-none border-b border-line px-5 py-3 max-md:px-4">
        {baseStatus === "ready" && bases.length === 0 ? (
          <div className="rounded-[14px] border border-dashed border-line bg-surface-subtle px-4 py-4 text-center">
            <p className="text-xs font-medium text-ink">暂无知识库</p>
            <p className="mt-0.5 text-[11px] text-muted/70">创建一个知识库后即可导入文档</p>
            {canCreate ? (
              showCreateBase ? createBaseRow : (
                <button
                  type="button"
                  onClick={() => setShowCreateBase(true)}
                  className="mt-2.5 inline-flex h-8 items-center justify-center rounded-lg bg-primary px-3.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-primary"
                >
                  新建知识库
                </button>
              )
            ) : (
              <p className="mt-1 text-[11px] text-faint">当前账号无创建权限，请联系管理员</p>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <label htmlFor="import-knowledge-base" className="text-xs font-medium text-ink">目标知识库</label>
              {canCreate ? (
                <button
                  type="button"
                  onClick={() => setShowCreateBase((previous) => !previous)}
                  className="text-[11px] text-brand transition-colors hover:text-brand-hover focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none"
                >
                  {showCreateBase ? "收起" : "＋ 新建知识库"}
                </button>
              ) : null}
            </div>
            <select
              id="import-knowledge-base"
              value={knowledgeBaseId}
              onChange={(event) => setKnowledgeBaseId(event.target.value)}
              disabled={creating}
              className="mt-1.5 h-9 w-full rounded-md border border-line bg-surface px-2 text-xs text-ink"
            >
              {baseOptions}
            </select>
            {showCreateBase ? createBaseRow : null}
            <div className="mt-2">
              {categoryCreatorOpen ? (
                <input
                  aria-label="新文档分类名称"
                  autoFocus
                  value={categoryDraft}
                  onChange={(event) => setCategoryDraft(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") confirmCategoryDraft() }}
                  onBlur={confirmCategoryDraft}
                  onKeyDownCapture={(event) => { if (event.key === "Escape") { event.preventDefault(); setCategoryCreatorOpen(false); setCategoryDraft("") } }}
                  placeholder="输入新分类名，回车确认"
                  className="h-8 w-full rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none placeholder:text-faint focus:border-brand"
                />
              ) : (
                <select
                  aria-label="文档分类"
                  value={pendingCategoryName ? "__pending__" : documentFolderId}
                  onChange={(event) => {
                    const value = event.target.value
                    if (value === "__new__") {
                      setCategoryCreatorOpen(true)
                      setCategoryDraft("")
                      return
                    }
                    setPendingCategoryName("")
                    setDocumentFolderId(value === "__pending__" ? "" : value)
                  }}
                  disabled={!knowledgeBaseId || documentFoldersStatus === "loading"}
                  className="h-8 w-full rounded-md border border-line bg-surface px-2 text-xs text-ink disabled:opacity-50"
                >
                  <option value="">
                    {!knowledgeBaseId
                      ? "请先选择知识库"
                      : documentFoldersStatus === "loading" ? "正在加载分类…" : "不归类"}
                  </option>
                  {documentFolders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}（{folder.documents} 篇）
                    </option>
                  ))}
                  {pendingCategoryName ? (
                    <option value="__pending__">新分类：{pendingCategoryName}</option>
                  ) : null}
                  <option value="__new__">＋ 新建分类</option>
                </select>
              )}
            </div>
          </>
        )}
      </div>

      <div className="flex-none border-b border-line px-5 pt-1 max-md:px-4" role="tablist" aria-label="导入方式">
        <div className="flex items-center gap-4">
          {(
            [
              { id: "local", label: "本地文档" },
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
                  ? "font-semibold text-ink after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-primary after:content-['']"
                  : "text-muted",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "local" ? (
        <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4 max-md:px-4" role="tabpanel">
          <ImportDropzone
            filesDisabled={!knowledgeBaseId}
            onPick={handlePick}
          />
          {/* Advanced options belong to the FILE path only (ticket 04) — the
              URL tab never reads them. */}
          <ImportAdvancedOptions
            parser={parser}
            onParserChange={setParser}
            tagsText={tagsText}
            onTagsChange={setTagsText}
          />
        </section>
      ) : (
        <section className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-5 max-md:px-4" role="tabpanel">
          <div className="mb-4 inline-flex items-center rounded-[14px] bg-surface-subtle p-1">
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
                  "relative flex h-8 cursor-pointer items-center justify-center rounded-[10px] px-4 text-[13px] font-medium transition-[color,background-color] duration-150 ease-out",
                  urlMode === item.id
                    ? "bg-surface text-ink"
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
                className="h-10 w-full rounded-[10px] border border-line bg-surface-subtle px-3.5 text-[14px] text-ink outline-none transition-colors placeholder:text-faint focus:border-brand focus:bg-surface"
              />
              <p className="text-[11px] text-muted/70">
                不支持需要登录或依赖 JS 渲染的页面（SPA 可能抓不到正文）；Sitemap 最多抓取 200 页
              </p>
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
                  className="h-10 w-full rounded-[10px] border border-line bg-surface-subtle px-3.5 text-[14px] text-ink outline-none transition-colors focus:border-brand focus:bg-surface"
                />
              </div>
            ) : null}

            <button
              type="button"
              disabled={submitting || !knowledgeBaseId}
              title={!knowledgeBaseId ? "请先选择知识库" : undefined}
              onClick={() => void handleUrlImport()}
              className="mt-2 inline-flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-[10px] bg-primary px-4 text-[14px] font-medium text-on-primary transition-[color,background-color,border-color,transform,translate,scale] duration-150 ease-out hover:bg-primary-hover active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
            >
              {submitting ? "导入中…" : urlMode === "single" ? "导入该网页" : "批量导入"}
            </button>
          </div>
        </section>
      )}

      {open && queue.length > 0 ? (
        <div className="max-h-52 flex-none overflow-y-auto border-t border-line px-5 py-3 max-md:px-4">
          <ol className="flex min-w-0 flex-col gap-2.5">
            {waves.map((wave) => {
              const waveItems = queue.filter((item) => item.waveId === wave.id)
              if (waveItems.length === 0) return null
              return (
                <li key={wave.id}>
                  <p className="mb-1 truncate text-[11px] font-medium text-muted" title={wave.label}>
                    {wave.label}
                    <span className="ml-1.5 text-faint">{waveItems.length} 项</span>
                  </p>
                  {/* grid-cols-1 pins the single track to minmax(0,1fr): an
                      implicit auto track sizes to the widest max-content (a
                      long nowrap error line) and blows out the 520px dialog. */}
                  <ul className="grid grid-cols-1 gap-1.5">
                    {waveItems.map((item) => {
                      const errorView = item.error ? describeImportError(item.error) : null
                      const canRetry = item.status === "failed" && (item.file !== undefined || item.sourceUrl !== undefined)
                      const canCancel = item.status === "queued" || item.status === "pending" || item.status === "processing"
                      return (
                        <li
                          key={item.id}
                          className="rounded-[10px] border border-line bg-surface-subtle px-2.5 py-2 text-xs"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate font-medium text-ink" title={item.filePath}>
                                  {item.fileName}
                                </span>
                                {item.precheckHit ? (
                                  <span className="flex-none rounded-full bg-warning-subtle px-1.5 py-0.5 text-[10px] font-medium text-warning">
                                    已存在
                                  </span>
                                ) : null}
                              </div>
                              {errorView ? (
                                <div className={cn("truncate text-[11px]", errorView.kind === "generic" ? "text-danger" : "text-warning")}>
                                  {errorView.text}
                                </div>
                              ) : item.size > 0 ? (
                                <div className="text-[11px] text-muted/70">{formatBytes(item.size)}</div>
                              ) : null}
                            </div>
                            <div className="flex flex-none items-center gap-1">
                              {item.precheckHit && item.status === "queued" ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      updateItem(item.id, { precheckHit: false })
                                      ensureWorkers()
                                    }}
                                    className="rounded-md px-1.5 py-0.5 text-[10px] font-medium text-brand transition-colors hover:bg-brand-subtle"
                                  >
                                    仍要导入
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => updateItem(item.id, { status: "cancelled" })}
                                    className="rounded-md px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface hover:text-ink"
                                  >
                                    跳过
                                  </button>
                                </>
                              ) : null}
                              {item.status === "queued" && !item.precheckHit ? (
                                <button
                                  type="button"
                                  onClick={() => removeItem(item.id)}
                                  aria-label={`移除 ${item.fileName}`}
                                  className="rounded-md px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface hover:text-ink"
                                >
                                  移除
                                </button>
                              ) : null}
                              {canCancel ? (
                                <button
                                  type="button"
                                  onClick={() => void cancelItem(item)}
                                  className="rounded-md px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface hover:text-ink"
                                >
                                  取消
                                </button>
                              ) : null}
                              {canRetry ? (
                                <button
                                  type="button"
                                  onClick={() => retryItem(item)}
                                  className="rounded-md px-1.5 py-0.5 text-[10px] font-medium text-brand transition-colors hover:bg-brand-subtle"
                                >
                                  重试
                                </button>
                              ) : null}
                              {item.status === "completed" && item.docId ? (
                                confirmingDeleteId === item.id ? (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => void deleteItem(item)}
                                      className="rounded-md bg-danger-subtle px-1.5 py-0.5 text-[10px] font-medium text-danger"
                                    >
                                      不可恢复，确认删除
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setConfirmingDeleteId(null)}
                                      className="rounded-md px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface hover:text-ink"
                                    >
                                      取消
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => openDocument({ documentId: item.docId as string })}
                                      className="rounded-md px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface hover:text-ink"
                                    >
                                      查看
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setConfirmingDeleteId(item.id)}
                                      className="rounded-md px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface hover:text-danger"
                                    >
                                      删除
                                    </button>
                                  </>
                                )
                              ) : null}
                              {errorView?.kind === "conflict" ? (
                                <button
                                  type="button"
                                  onClick={() => void viewConflictDocument(item)}
                                  className="rounded-md px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface hover:text-ink"
                                >
                                  查看文档
                                </button>
                              ) : null}
                              <span
                                className={cn(
                                  "rounded-full px-2 py-0.5 text-[10px] font-medium",
                                  item.status === "completed"
                                    ? "bg-success-subtle text-success"
                                    : item.status === "failed"
                                      ? "bg-danger-subtle text-danger"
                                      : "bg-surface text-muted",
                                )}
                              >
                                {STATUS_TEXT[item.status]}
                              </span>
                            </div>
                          </div>
                          <ImportProgress
                            fileName={item.fileName}
                            progress={item.progress ?? { ...initialImportProgress(item.status), error: item.error }}
                            checkedAt={item.checkedAt}
                            syncError={item.syncError}
                            isLocal={Boolean(item.file)}
                            uploaded={Boolean(item.docId)}
                            uploadProgress={item.uploadProgress}
                            processingStartedAt={item.processingStartedAt}
                            fileSize={item.size}
                          />
                        </li>
                      )
                    })}
                  </ul>
                </li>
              )
            })}
          </ol>
          <div className="mt-2 flex items-center justify-between border-t border-line pt-2 text-[11px] text-muted" aria-live="polite">
            <span>
              {completedCount} 成功 · {failedCount} 失败 · {cancelledCount} 已取消
            </span>
            <span>{queue.length} 项</span>
          </div>
        </div>
      ) : null}
    </dialog>
  )
}
