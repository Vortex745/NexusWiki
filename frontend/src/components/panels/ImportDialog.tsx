import { Field as FormField, FieldLabel } from "@/components/ui/field"
import SegmentedControl from "../arc/segmented-control/segmented-control"
import { Input } from "@/components/arc/input/input"
import { NumberField } from "../arc/number-field/number-field"
import { Button as UiButton } from "@/components/ui/Button"
import { Select as UiSelect } from "@/components/ui/Controls"
import { InlineMessage } from "../ui/containers"
import { PanelDialog } from "../ui/Dialog"
import { useCallback, useEffect, useRef, useState } from "react"

import {
  cancelIngest,
  createKnowledgeBase,
  fetchDocumentDetail,
  fetchDocumentFolders,
  fetchIngestStatus,
  fetchKnowledgeBaseDocuments,
  ImportUploadError,
  resumeIngest,
  retireSource,
  submitUrlImport,
  uploadFileToIngest,
  type DocumentCatalogEntryPayload,
  type DocumentFolderPayload,
} from "../../lib/api"
import { cn } from "../../lib/cn"
import {
  formatBytes,
  IMPORT_CONCURRENCY,
  IMPORT_MAX_FILES_HINT,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_POLL_MS,
} from "../../lib/constants"
import {
  buildImportRows,
  categoryForPath,
  countActiveImports,
  describeImportError,
  findReusableKnowledgeBase,
  freezeWaveParams,
  IMPORT_TERMINAL_STATUSES,
  matchExistingFileNames,
  retryDecision,
  sanitizeKnowledgeBaseName,
  settleWavePrecheck,
  type ImportAdmissionKind,
  type ImportWaveParams,
  type PickedFile,
  type PickedFolder,
} from "../../lib/importBatch"
import { Alert } from "@/components/arc/alert/alert"
import { useAppShell } from "../../runtime/AppShellContext"
import { knowledgeStore, useKnowledgeBases } from "../../runtime/knowledgeStore"
import { useSignedInSession } from "../../runtime/SessionContext"
import { Icon } from "../ui/Icon"
import {
  Ban,
  CircleCheck,
  CircleX,
  Clock,
  Eye,
  History,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from "../ui/icons"
import {
  deriveIngestProgress,
  deriveRecordView,
  describeActivationReasons,
  describeActivationWarnings,
  describeAllowedOperations,
  initialImportProgress,
  type ImportProgress as Progress,
  type ImportStatus,
  type RecordDisplayState,
  type UploadProgress,
} from "../../lib/ingestProgress"
import {
  describeFailure,
  PDF_PROTECTION_GUIDANCE,
  type FailureRecordLike,
} from "../../lib/qualityReasons"
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
  /** UT-23: terminal client-side admission verdict (empty_file / file_size) —
   * the same bytes can never pass, so these rows never offer upload retry. */
  admissionKind?: ImportAdmissionKind
  /** UT-23: structured failure kind (server admission kind or transport
   * class) driving the explainable error copy and the retry gate. */
  errorKind?: string | null
  /** Byte-signature detection for type_conflict rows (e.g. "pdf"). */
  errorDetected?: string | null
  /** Per-item folder header: folder waves map each file to a category. */
  folderName?: string
  /** Pre-check hit: the row waits for 仍要导入/跳过 and is not auto-uploaded. */
  precheckHit?: boolean
  /** UT-24: false until this row's wave finished its pre-flight (admission +
   * same-name pre-check) — un-settled rows are never claimable by workers. */
  precheckSettled?: boolean
  progress?: Progress
  uploadProgress?: UploadProgress
  checkedAt?: string
  syncError?: string | null
  file?: File
  sourceUrl?: string
  processingStartedAt?: number
  lastProgressAt?: number
  timeoutWarned?: boolean
  /** Terminal rows leave the queue after the read window and live on in the
   * records tab; the flag keeps them out of the queue panel. */
  folded?: boolean
  foldedAt?: number
}

const IMPORT_STALL_MS = 5 * 60_000
/** A settled row — success, failure, cancellation or a human-review hold —
 * stays readable this long, then folds into the records tab. The queue never
 * accumulates finished outcomes. */
const TERMINAL_ROW_VISIBLE_MS = 5_000
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
  // UT-26: integrity holds and business approval are their own visible
  // states — neither reads as success nor as a failure to retry away.
  pending_review: "待校验",
  business_review: "待审中",
  failed: "失败",
  cancelled: "已取消",
}

/** UT-26: badge treatment per status — review holds render as warnings, not
 * success (they are NOT completions) and not danger (nothing to retry). */
function statusBadgeClass(status: ImportStatus): string {
  if (status === "completed") return "bg-success-subtle text-success"
  if (status === "failed") return "bg-danger-subtle text-danger"
  if (status === "pending_review" || status === "business_review")
    return "bg-warning-subtle text-warning"
  return "bg-surface text-faint"
}

/** Record badge treatment per DERIVED record state. Green is reserved for
 * rows the active pointer adopted; holds and legacy rows never read as ✅. */
function recordBadgeClass(state: RecordDisplayState): string {
  if (state === "adopted") return "bg-success-subtle text-success"
  if (state === "failed") return "bg-danger-subtle text-danger"
  if (state === "pending_review" || state === "business_review")
    return "bg-warning-subtle text-warning"
  if (state === "cancelled") return "bg-warning-subtle text-warning"
  return "bg-surface text-faint"
}

function recordIcon(state: RecordDisplayState) {
  if (state === "adopted") return CircleCheck
  if (state === "pending_review") return ShieldAlert
  if (state === "business_review") return Clock
  if (state === "inactive") return History
  if (state === "failed") return CircleX
  if (state === "cancelled") return Ban
  return LoaderCircle
}

function recordIconClass(state: RecordDisplayState): string {
  if (state === "adopted") return "text-success"
  if (state === "pending_review" || state === "business_review")
    return "text-warning"
  if (state === "inactive") return "text-faint"
  if (state === "failed") return "text-danger"
  if (state === "cancelled") return "text-warning"
  return "animate-spin text-brand"
}

/** Session-tray rows only ever settle into one of the three outcomes. */
function trayStatusIcon(status: ImportStatus) {
  if (status === "completed") return CircleCheck
  if (status === "cancelled") return Ban
  return CircleX
}

function formatRecordedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

function createId(prefix: string): string {
  const randomId =
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${randomId}`
}

function fallbackBaseName(): string {
  return `导入 ${new Date().toISOString().slice(0, 16).replace("T", " ")}`
}

function parseTags(tagsText: string): string[] {
  return tagsText
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
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
  const { showToast, openDocument, openKnowledge, openSettings } = useAppShell()
  const {
    activeKnowledgeBases: bases,
    folders,
    status: baseStatus,
  } = useKnowledgeBases()
  const session = useSignedInSession()
  const canCreate = session?.scopes.includes("admin") ?? false
  // A private workspace cannot own a knowledge base or a vector index until
  // embedding is configured. Import is the first action that needs it, so the
  // dialog intercepts here instead of failing after the upload starts.
  const requiresEmbeddingSetup = session?.requiresEmbeddingSetup === true
  const [knowledgeBaseId, setKnowledgeBaseId] = useState("")
  const [newBaseName, setNewBaseName] = useState("")
  const [creating, setCreating] = useState(false)
  const [showCreateBase, setShowCreateBase] = useState(false)
  // The directory this batch is filed into. A document folder belongs to ONE
  // knowledge base, so the picker waits for a target base.
  const [documentFolders, setDocumentFolders] = useState<
    DocumentFolderPayload[]
  >([])
  const [documentFoldersStatus, setDocumentFoldersStatus] = useState<
    "idle" | "loading" | "ready"
  >("idle")
  const [documentFolderId, setDocumentFolderId] = useState("")
  const [categoryCreatorOpen, setCategoryCreatorOpen] = useState(false)
  const [categoryDraft, setCategoryDraft] = useState("")
  const [pendingCategoryName, setPendingCategoryName] = useState("")

  const [parser, setParser] = useState("")
  const [tagsText, setTagsText] = useState("")

  const [tab, setTab] = useState<"local" | "url" | "records">("local")
  const [records, setRecords] = useState<DocumentCatalogEntryPayload[]>([])
  const [recordsStatus, setRecordsStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle")
  const [recordsError, setRecordsError] = useState<string | null>(null)
  const [urlMode, setUrlMode] = useState<"single" | "sitemap">("single")
  const [url, setUrl] = useState("")
  const [maxPages, setMaxPages] = useState(50)
  const [submitting, setSubmitting] = useState(false)
  const [waves, setWaves] = useState<ImportWave[]>([])
  const [queue, setQueue] = useState<ImportItem[]>([])
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  )

  const queueRef = useRef<ImportItem[]>([])
  queueRef.current = queue
  const wavesRef = useRef<ImportWave[]>([])
  wavesRef.current = waves
  /** Rows a worker has claimed; claims happen synchronously so two workers
   * never pick up the same row. */
  const claimedRef = useRef(new Set<string>())
  // UT-25: count of LIVE worker loops — the shared upload slot accounting.
  const liveWorkersRef = useRef(0)
  // UT-27: rows with a resume command in flight — duplicate clicks are no-ops.
  const resumingRef = useRef(new Set<string>())
  // UT-28: rows with a cancellation request in flight — duplicate clicks are no-ops.
  const cancellingRef = useRef(new Set<string>())
  // UT-29: per-row operation generation. Every command (resume / cancel /
  // cancel-intent) bumps the row's epoch; async flows capture the epoch when
  // they start and DISCARD their result if it moved — a stale poll or a late
  // upload response can never override a newer operation.
  const epochRef = useRef(new Map<string, number>())
  const bumpEpoch = useCallback((id: string): number => {
    const next = (epochRef.current.get(id) ?? 0) + 1
    epochRef.current.set(id, next)
    return next
  }, [])
  const epochOf = useCallback(
    (id: string): number => epochRef.current.get(id) ?? 0,
    [],
  )
  const pollTimer = useRef<number | null>(null)
  const pollingRef = useRef(false)
  const completionNotifiedRef = useRef(false)

  useEffect(() => {
    if (open) void knowledgeStore.refresh()
  }, [open])

  // The upload records are the server's own catalog rows (the queue above is
  // session-local): they survive a dialog close, a reload, and a device switch.
  const loadRecords = useCallback(async () => {
    if (!knowledgeBaseId) {
      setRecords([])
      setRecordsStatus("idle")
      return
    }
    setRecordsStatus("loading")
    setRecordsError(null)
    try {
      const body = await fetchKnowledgeBaseDocuments(
        knowledgeBaseId,
        { page: 1, status: "", tag: "", folder: "" },
        50,
      )
      setRecords(body.documents)
      setRecordsStatus("ready")
    } catch (reason) {
      setRecordsError(errorMessageOf(reason))
      setRecordsStatus("error")
    }
  }, [knowledgeBaseId])

  useEffect(() => {
    if (open && tab === "records") void loadRecords()
  }, [open, tab, loadRecords])

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
  const mutateQueue = useCallback(
    (mutate: (current: ImportItem[]) => ImportItem[]) => {
      queueRef.current = mutate(queueRef.current)
      setQueue(queueRef.current)
    },
    [],
  )

  // A settled row stays readable for a short window, then folds out of the
  // queue into the 上传记录 tab — server-known documents live in the catalog,
  // session-only outcomes (a rejected upload) live in the session tray.
  const hideTimers = useRef(new Map<string, number>())
  const scheduleHide = useCallback(
    (id: string) => {
      if (hideTimers.current.has(id)) return
      const timer = window.setTimeout(() => {
        hideTimers.current.delete(id)
        mutateQueue((current) =>
          current.map((item) =>
            item.id === id && !item.folded
              ? { ...item, folded: true, foldedAt: Date.now() }
              : item,
          ),
        )
        // The row is only "moved" once the records list shows it.
        if (tab === "records") void loadRecords()
      }, TERMINAL_ROW_VISIBLE_MS)
      hideTimers.current.set(id, timer)
    },
    [mutateQueue, tab, loadRecords],
  )
  const cancelHide = useCallback((id: string) => {
    const timer = hideTimers.current.get(id)
    if (timer === undefined) return
    window.clearTimeout(timer)
    hideTimers.current.delete(id)
  }, [])

  const updateItem = useCallback(
    (id: string, patch: Partial<ImportItem>) => {
      mutateQueue((current) =>
        current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      )
      // Every terminal outcome — including the two human-review holds — gets
      // the same 5s read window, then folds into 上传记录 where its own state
      // (待校验 / 待审中) is rendered from the server row.
      if (
        patch.status &&
        (IMPORT_TERMINAL_STATUSES as readonly ImportStatus[]).includes(
          patch.status,
        )
      )
        scheduleHide(id)
      else if (patch.status) cancelHide(id)
    },
    [mutateQueue, scheduleHide, cancelHide],
  )

  const appendQueue = useCallback(
    (items: ImportItem[]) => {
      mutateQueue((current) => [...current, ...items])
    },
    [mutateQueue],
  )

  useEffect(
    () => () => {
      for (const timer of hideTimers.current.values())
        window.clearTimeout(timer)
      hideTimers.current.clear()
    },
    [],
  )

  /** Registers a wave in BOTH the state and its ref: workers read the ref in
   * the same tick as enqueue, before React re-renders. */
  const appendWave = useCallback((wave: ImportWave) => {
    wavesRef.current = [...wavesRef.current, wave]
    setWaves((current) => [...current, wave])
  }, [])

  const removeItem = useCallback(
    (id: string) => {
      mutateQueue((current) => current.filter((item) => item.id !== id))
    },
    [mutateQueue],
  )

  const stopPollingIfDone = useCallback(() => {
    const hasPending = queueRef.current.some(
      (item) => item.status === "pending" || item.status === "processing",
    )
    if (!hasPending && pollTimer.current !== null) {
      window.clearInterval(pollTimer.current)
      pollTimer.current = null
    }
    const terminal = new Set<string>(IMPORT_TERMINAL_STATUSES)
    const settled =
      queueRef.current.length > 0 &&
      liveWorkersRef.current === 0 &&
      queueRef.current.every((item) => terminal.has(item.status))
    if (settled && !completionNotifiedRef.current) {
      completionNotifiedRef.current = true
      const completed = queueRef.current.filter(
        (item) => item.status === "completed",
      ).length
      const failed = queueRef.current.filter(
        (item) => item.status === "failed",
      ).length
      const cancelled = queueRef.current.filter(
        (item) => item.status === "cancelled",
      ).length
      // UT-26: review holds are terminal for polling but not "success" — they
      // get their own bucket in the summary line. Integrity holds and business
      // approval holds are separate: only the former is a content anomaly.
      const integrityHeld = queueRef.current.filter(
        (item) => item.status === "pending_review",
      ).length
      const businessHeld = queueRef.current.filter(
        (item) => item.status === "business_review",
      ).length
      showToast(
        `处理结束：${completed} 成功${integrityHeld ? `，${integrityHeld} 待校验` : ""}${businessHeld ? `，${businessHeld} 待审` : ""}${failed ? `，${failed} 失败` : ""}${cancelled ? `，${cancelled} 已取消` : ""}`,
      )
      if (completed > 0) onIngested?.()
    }
  }, [onIngested, showToast])

  const pollSingle = useCallback(
    async (item: ImportItem) => {
      if (!item.docId) return
      // UT-29: this poll's generation — a resume/cancel that lands while the
      // fetch is in flight owns the row; the stale response is discarded.
      const gen = epochOf(item.id)
      try {
        const progress = deriveIngestProgress(
          await fetchIngestStatus(item.docId),
        )
        const now = Date.now()
        const processingStartedAt =
          progress.status === "processing" && item.status !== "processing"
            ? now
            : item.processingStartedAt
        const changed =
          !item.progress ||
          progress.summary !== item.progress.summary ||
          progress.stages.some(
            (stage, index) =>
              stage.status !== item.progress?.stages[index]?.status,
          )
        const lastProgressAt = changed ? now : (item.lastProgressAt ?? now)
        const stalled =
          now - lastProgressAt >= IMPORT_STALL_MS && !item.timeoutWarned
        if (stalled)
          showToast(`${item.fileName} 处理超时，请查看文档状态或稍后重试`)
        // UT-29: a newer operation (resume/cancel) owns the row now — this
        // stale poll response must not overwrite it.
        if (epochOf(item.id) !== gen) return
        updateItem(item.id, {
          status: progress.status,
          progress,
          error: progress.status === "failed" ? progress.error : null,
          checkedAt: new Date().toISOString(),
          syncError:
            stalled || item.timeoutWarned
              ? "处理时间超过预期，服务器可能仍在运行"
              : null,
          lastProgressAt,
          timeoutWarned: stalled || item.timeoutWarned,
          processingStartedAt,
        })
      } catch (err) {
        const timedOut =
          Date.now() - (item.lastProgressAt ?? Date.now()) >= IMPORT_STALL_MS &&
          !item.timeoutWarned
        if (timedOut) showToast(`${item.fileName} 状态查询超时，请检查服务连接`)
        updateItem(item.id, {
          syncError: timedOut
            ? "状态查询持续超时，请检查服务连接"
            : errorMessageOf(err),
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
    pollTimer.current = window.setInterval(
      () => void pollItems(),
      IMPORT_POLL_MS,
    )
    void pollItems()
  }, [pollItems])

  // ---------------------------------------------------------------------------
  // Upload worker pool — rows accumulate across waves; workers pull whatever
  // is queued next (a claim is synchronous, so rows are never double-picked).
  // ---------------------------------------------------------------------------

  const uploadOne = useCallback(
    async (item: ImportItem) => {
      const wave = wavesRef.current.find(
        (candidate) => candidate.id === item.waveId,
      )
      const gen = epochOf(item.id)
      updateItem(item.id, {
        status: "uploading",
        error: null,
        uploadProgress: {
          loaded: 0,
          total: item.size,
          startedAt: Date.now(),
          updatedAt: Date.now(),
        },
      })
      try {
        const docId = await uploadFileToIngest(
          item.file as File,
          item.filePath,
          (loaded, total) => {
            updateItem(item.id, {
              uploadProgress: {
                loaded,
                total,
                startedAt: item.uploadProgress?.startedAt ?? Date.now(),
                updatedAt: Date.now(),
              },
            })
          },
          {
            knowledgeBaseId: wave?.params.knowledgeBaseId,
            folder: item.folderName ?? wave?.params.folder,
            parser: wave?.params.parser,
            tags: wave?.params.tags,
          },
        )
        // UT-29: a cancel intent landed while the upload was in flight. The
        // late identity is LINKED to the row and the backend is asked to
        // cancel the just-accepted task — a running task is never left
        // behind; if the server refuses, the row syncs to its truth.
        if (epochOf(item.id) !== gen) {
          if (!docId) {
            updateItem(item.id, {
              status: "failed",
              error: "上传失败，且取消结果未知（未能确认服务端是否已接收）",
              errorKind: "resume_refused",
            })
            return
          }
          updateItem(item.id, {
            docId,
            status: "pending",
            lastProgressAt: Date.now(),
          })
          try {
            const result = await cancelIngest(docId)
            // UT-29: polls that started while this cancel was in flight carry
            // the older generation — invalidate them before writing the
            // terminal state so the cancel is never clobbered.
            bumpEpoch(item.id)
            if (result.changed) {
              updateItem(item.id, {
                status: "cancelled",
                progress: initialImportProgress("cancelled"),
                lastProgressAt: Date.now(),
              })
            } else {
              const server = deriveIngestProgress(
                await fetchIngestStatus(docId),
              )
              bumpEpoch(item.id)
              updateItem(item.id, {
                status: server.status,
                progress: server,
                error: `服务端拒绝取消：${result.reason ?? result.status}`,
                errorKind: "resume_refused",
                lastProgressAt: Date.now(),
              })
            }
          } catch {
            bumpEpoch(item.id)
            updateItem(item.id, {
              status: "failed",
              error: "上传已完成但取消结果未知，请查看文档状态",
              errorKind: "resume_refused",
              syncError: "取消结果未知",
            })
          }
          stopPollingIfDone()
          return
        }
        if (!docId)
          throw new ImportUploadError("invalid_response", "上传响应缺少文档 ID")
        updateItem(item.id, {
          status: "pending",
          docId,
          lastProgressAt: Date.now(),
        })
        // The first poll fires immediately so the row shows real stage
        // progress instead of sitting on the upload-done placeholder.
        startPolling()
      } catch (err) {
        if (epochOf(item.id) !== gen) {
          // The transfer itself failed after a cancel intent: whether the
          // server received anything is unknowable from here — an honest
          // unknown, never a silent local cancel.
          updateItem(item.id, {
            status: "failed",
            error: errorMessageOf(err),
            syncError: "取消结果未知，请查看文档状态",
          })
        } else if (err instanceof ImportUploadError) {
          updateItem(item.id, {
            status: "failed",
            error: err.message,
            errorKind: err.kind,
            errorDetected: err.detected ?? null,
          })
        } else {
          updateItem(item.id, { status: "failed", error: errorMessageOf(err) })
        }
      }
    },
    [updateItem, startPolling, stopPollingIfDone, epochOf],
  )

  const ensureWorkers = useCallback(() => {
    // UT-25: the shared slot count is the number of LIVE worker loops. The
    // old boolean gate was zeroed by EVERY exiting run, so a wave appended
    // while one worker was still uploading spawned a full fresh set —
    // measured 4 concurrent uploads against a 3-slot limit. Top up only the
    // deficit instead: each exit frees exactly one slot, never two.
    const deficit = IMPORT_CONCURRENCY - liveWorkersRef.current
    for (let worker = 0; worker < deficit; worker += 1) {
      liveWorkersRef.current += 1
      void (async () => {
        try {
          for (;;) {
            const item = queueRef.current.find(
              (candidate) =>
                candidate.status === "queued" &&
                // UT-24: an un-settled row's wave has not finished its
                // pre-flight — a worker still running from an earlier wave must
                // never claim it before admission/same-name confirmation lands.
                candidate.precheckSettled !== false &&
                !candidate.precheckHit &&
                !claimedRef.current.has(candidate.id),
            )
            if (!item) break
            claimedRef.current.add(item.id)
            try {
              await uploadOne(item)
            } catch {
              // uploadOne settles its own failures; a bug escaping it must
              // not kill the worker loop — the slot survives and the next
              // ready row proceeds.
            } finally {
              claimedRef.current.delete(item.id)
            }
          }
        } finally {
          liveWorkersRef.current -= 1
          if (liveWorkersRef.current === 0) stopPollingIfDone()
        }
      })()
    }
  }, [uploadOne, startPolling, stopPollingIfDone])

  // ---------------------------------------------------------------------------
  // Wave builders
  // ---------------------------------------------------------------------------

  /** The pre-check reads the catalog by folder NAME; a freshly typed category
   * has no documents by definition, so those waves skip the read. */
  const precheckFolderName = useCallback(
    (params: ImportWaveParams): string | null => {
      if (
        params.folder &&
        pendingCategoryName &&
        params.folder === pendingCategoryName
      )
        return null
      if (!params.folder) return ""
      const known = documentFolders.find(
        (folder) => folder.id === params.folder,
      )
      return known?.name ?? null
    },
    [pendingCategoryName, documentFolders],
  )

  const buildRows = useCallback(
    (picked: PickedFile[], waveId: string): ImportItem[] =>
      // UT-23: client admission runs in the pure decision layer — empty and
      // oversize files fail with an admission kind BEFORE upload, the client
      // mirrors (never relaxes) the server's limits, and the server stays the
      // authority for everything the client cannot confirm.
      buildImportRows(picked, waveId, IMPORT_MAX_FILE_BYTES, () =>
        createId("imp"),
      ),
    [],
  )

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
      // Bounded duplicate pre-check BEFORE any upload of THIS wave (UT-24):
      // rows enter the queue pre-flight-held and only SETTLE — becoming
      // claimable for workers — once the same-name pre-check has finished.
      // This is what stops a worker still running from an earlier wave from
      // racing the new wave's rows before admission/confirmation completes.
      const folderName = precheckFolderName(wave.params)
      const needsPrecheck = folderName !== null
      const items = buildRows(picked, wave.id).map((item) => ({
        ...item,
        precheckSettled: !needsPrecheck,
      }))
      if (skippedCount > 0) showToast(`已跳过 ${skippedCount} 个不支持的文件`)
      if (items.length > IMPORT_MAX_FILES_HINT) {
        showToast(
          `共 ${items.length} 个文件，建议分批导入（单次 ≤ ${IMPORT_MAX_FILES_HINT}）`,
        )
      }
      appendWave(wave)
      appendQueue(items)
      completionNotifiedRef.current = false

      if (folderName !== null) {
        // The read is bounded and best-effort; on failure the wave settles
        // anyway — the server's 409 is the safety net, and rows must never be
        // stranded unclaimable by an unfinished pre-check.
        try {
          const entries = await collectCatalogEntries(
            wave.params.knowledgeBaseId,
            folderName,
          )
          const hits = matchExistingFileNames(
            entries.map((entry) => entry.fileName ?? ""),
            items.map((item) => item.fileName),
          )
          mutateQueue((current) => settleWavePrecheck(current, wave.id, hits))
          if (hits.size > 0) {
            showToast(`${hits.size} 个文件在目标库中已存在，请在队列中确认`)
          }
        } catch {
          mutateQueue((current) =>
            settleWavePrecheck(current, wave.id, new Set()),
          )
          showToast("同名预检查不可用，导入时将由服务端确认")
        }
      }
      ensureWorkers()
    },
    [
      bases,
      knowledgeBaseId,
      pendingCategoryName,
      documentFolderId,
      parser,
      tagsText,
      buildRows,
      appendQueue,
      showToast,
      precheckFolderName,
      ensureWorkers,
      mutateQueue,
    ],
  )

  const enqueueFolderWave = useCallback(
    async (folder: PickedFolder) => {
      if (folder.files.length === 0) {
        showToast(`文件夹「${folder.name}」中没有支持的文件格式`)
        return
      }
      if (folder.skipped > 0) {
        showToast(
          `文件夹「${folder.name}」已跳过 ${folder.skipped} 个不支持的文件`,
        )
      }
      const baseName = sanitizeKnowledgeBaseName(
        folder.name,
        fallbackBaseName(),
      )
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
          showToast(
            `知识库「${baseName}」创建失败：${errorMessageOf(error)}，未导入任何文件`,
          )
          return
        }
      }
      const wave: ImportWave = {
        id: createId("wave"),
        label,
        kind: "folder",
        params: freezeWaveParams({ knowledgeBaseId: waveKnowledgeBaseId }),
      }
      const items = buildRows(folder.files, wave.id).map((item) => ({
        ...item,
        // Folder waves run no per-file pre-check: rows are claimable at once.
        precheckSettled: true,
        folderName: categoryForPath(item.filePath, folder.name),
      }))
      appendWave(wave)
      appendQueue(items)
      completionNotifiedRef.current = false
      ensureWorkers()
    },
    [bases, buildRows, appendQueue, showToast, ensureWorkers],
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

  /** UT-28: cancellation authority lives on the SERVER once it has accepted
   * the upload. A confirmed cancel (changed=true) is the only path to the
   * cancelled badge; a refusal syncs the row to the server's actual terminal
   * state; a network failure is UNKNOWN — the row keeps its real state and
   * bounded polling converges it. No XHR abort exists in this flow, so a
   * client-side abort can never be mistaken for a backend cancellation. */
  const cancelItem = useCallback(
    async (item: ImportItem) => {
      if (cancellingRef.current.has(item.id)) return
      if (!item.docId) {
        // Local-only cancel: the server has never seen this row. An UPLOADING
        // row has a request in flight — its late response carries a possible
        // identity and is reconciled in uploadOne (UT-29); other rows without
        // a server identity cancel locally outright.
        bumpEpoch(item.id)
        if (item.status !== "uploading") {
          updateItem(item.id, { status: "cancelled" })
          stopPollingIfDone()
        } else {
          updateItem(item.id, { syncError: "取消已请求，等待上传结果确认" })
        }
        return
      }
      // UT-29: the cancel owns the row from this moment — in-flight polls or
      // a late resume response cannot override the cancellation.
      bumpEpoch(item.id)
      cancellingRef.current.add(item.id)
      try {
        const result = await cancelIngest(item.docId)
        // UT-29: polls started while this cancel was in flight are stale now.
        bumpEpoch(item.id)
        if (result.changed) {
          updateItem(item.id, {
            status: "cancelled",
            error: null,
            errorKind: null,
            errorDetected: null,
            progress: initialImportProgress("cancelled"),
            uploadProgress: undefined,
            lastProgressAt: Date.now(),
          })
          stopPollingIfDone()
        } else {
          // The server refused — the task already settled elsewhere. Sync the
          // row to the server's terminal truth instead of claiming cancelled.
          try {
            const server = deriveIngestProgress(
              await fetchIngestStatus(item.docId),
            )
            updateItem(item.id, {
              status: server.status,
              progress: server,
              error:
                server.status === "failed"
                  ? server.error
                  : `服务端拒绝取消：${result.reason ?? result.status}`,
              errorKind: "resume_refused",
              lastProgressAt: Date.now(),
            })
          } catch {
            updateItem(item.id, {
              error: `服务端拒绝取消（当前状态 ${result.status}）`,
              errorKind: "resume_refused",
            })
          }
          stopPollingIfDone()
        }
      } catch {
        // Network failure / timeout: the outcome is UNKNOWN. Keep the row's
        // real state (processing) and let bounded status polling converge it
        // — never announce a cancellation the server has not confirmed.
        updateItem(item.id, {
          syncError: "取消结果未知，正在与服务端同步",
          lastProgressAt: Date.now(),
        })
        startPolling()
      } finally {
        cancellingRef.current.delete(item.id)
      }
    },
    [updateItem, startPolling, stopPollingIfDone],
  )

  /** A failed URL row re-submits its page: single-page fetches fail transiently
   * (502) and the row carries the URL it needs. The wave's frozen target
   * params keep the retry on the same knowledge base and folder. */
  const resubmitUrlItem = useCallback(
    async (item: ImportItem) => {
      const wave = wavesRef.current.find(
        (candidate) => candidate.id === item.waveId,
      )
      if (!item.sourceUrl || !wave) return
      updateItem(item.id, {
        status: "pending",
        error: null,
        lastProgressAt: Date.now(),
      })
      try {
        const data = await submitUrlImport(
          item.sourceUrl,
          "single",
          50,
          wave.params.knowledgeBaseId,
          wave.params.folder,
        )
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
      // UT-23: the retry gate decides what "retry" may mean for this row.
      // Admission-rejected rows (empty/oversize) and server-accepted rows
      // (docId exists — a processing failure) must NOT re-upload: the first
      // can never pass, the second would create a NEW document dressed up as
      // a same-document resume.
      const gate = retryDecision(item)
      if (!gate.retryable) return
      // URL rows re-submit their URL (a transient fetch failure is retryable);
      // file rows re-upload from the still-held File handle.
      if (!item.file && item.sourceUrl) {
        void resubmitUrlItem(item)
        return
      }
      updateItem(item.id, {
        status: "queued",
        folded: false,
        error: null,
        errorKind: null,
        errorDetected: null,
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

  /** UT-27: resume a server-accepted row by requeueing its ORIGINAL task —
   * the retained original is re-processed under the same docId/taskId/
   * version. The File handle is irrelevant here and the server's own
   * allowed-operations gate decides whether the command is offered at all;
   * refusals (409) surface verbatim instead of faking success. */
  const resumeItem = useCallback(
    (item: ImportItem) => {
      const docId = item.docId
      if (!docId || resumingRef.current.has(item.id)) return
      // UT-29: the resume owns the row from this moment — in-flight polls
      // carry an older generation and their results are discarded.
      bumpEpoch(item.id)
      resumingRef.current.add(item.id)
      void resumeIngest(docId)
        .then((result) => {
          if (!result.changed) {
            updateItem(item.id, {
              error: `服务端拒绝恢复（当前状态 ${result.status}）`,
              errorKind: "resume_refused",
            })
            return
          }
          updateItem(item.id, {
            status: "pending",
            folded: false,
            error: null,
            errorKind: null,
            errorDetected: null,
            progress: initialImportProgress("pending"),
            uploadProgress: undefined,
            lastProgressAt: Date.now(),
          })
          startPolling()
        })
        .catch((err) => {
          // A refused or failed resume is NOT a success — the row keeps its
          // failed state and shows the server's explainable refusal.
          updateItem(item.id, {
            error: err instanceof Error ? err.message : String(err),
            errorKind: "resume_refused",
          })
        })
        .finally(() => {
          resumingRef.current.delete(item.id)
        })
    },
    [updateItem, startPolling],
  )

  const deleteItem = useCallback(
    async (item: ImportItem) => {
      if (!item.docId) return
      setConfirmingDeleteId(null)
      try {
        const detail = await fetchDocumentDetail(item.docId)
        await retireSource(
          detail.document.sourceId,
          "removed from the import dialog",
        )
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
      const wave = wavesRef.current.find(
        (candidate) => candidate.id === item.waveId,
      )
      const knowledgeBaseIdForWave = wave?.params.knowledgeBaseId
      if (!knowledgeBaseIdForWave) return
      try {
        const entries = await collectCatalogEntries(knowledgeBaseIdForWave, "")
        const normalized = item.sourceUrl ?? item.fileName
        const found = entries.find(
          (entry) =>
            entry.source === normalized ||
            entry.fileName === item.fileName ||
            entry.title === item.fileName,
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
    if (!knowledgeBaseId) {
      showToast("请先选择知识库")
      return
    }
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
      const data = await submitUrlImport(
        trimmed,
        urlMode,
        pages,
        knowledgeBaseId,
        folderArgument(),
      )
      const submittedAt = Date.now()
      completionNotifiedRef.current = false
      const wave: ImportWave = {
        id: createId("wave"),
        label:
          urlMode === "single"
            ? `网页导入「${trimmed}」`
            : `Sitemap 抓取（${data.submitted ?? 0} 页）`,
        kind: "url",
        params: freezeWaveParams({ knowledgeBaseId, folder: folderArgument() }),
      }
      const items: ImportItem[] =
        urlMode === "single"
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
              error: entry.docId ? null : (entry.status ?? "提交失败"),
              sourceUrl: entry.url,
              lastProgressAt: submittedAt,
            }))
      appendWave(wave)
      appendQueue(items)
      showToast(
        urlMode === "single"
          ? "已提交，正在处理…"
          : `已提交 ${data.submitted} 个页面`,
      )
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
        appendQueue([
          {
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
          },
        ])
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
      {/* The placeholder is a CHOICE only while nothing is chosen; once a base
          is selected it would render as a second, contradictory value. */}
      {!knowledgeBaseId ? (
        <option value="">
          {baseStatus === "loading" ? "正在加载…" : "请选择知识库"}
        </option>
      ) : null}
      {folders.map((folder) => (
        <optgroup key={folder.id} label={folder.name}>
          {bases
            .filter((base) => base.folderId === folder.id)
            .map((base) => (
              <option key={base.id} value={base.id}>
                {base.name}
              </option>
            ))}
        </optgroup>
      ))}
      {bases
        .filter(
          (base) =>
            !base.folderId ||
            !folders.some((folder) => folder.id === base.folderId),
        )
        .map((base) => (
          <option key={base.id} value={base.id}>
            {base.name}
          </option>
        ))}
    </>
  )

  const createBaseRow = (
    <div className="mt-2 flex gap-2">
      <Input
        aria-label="新知识库名称"
        value={newBaseName}
        onChange={(event) => setNewBaseName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void createBase()
        }}
        placeholder="新知识库名称"
        autoFocus
        className="h-8 min-w-0 flex-1 border px-2"
      />
      <UiButton
        variant="outline"
        size="sm"
        type="button"
        disabled={creating || !newBaseName.trim()}
        onClick={() => void createBase()}
        className="px-2 disabled:opacity-50"
      >
        {creating ? "创建中…" : "创建"}
      </UiButton>
    </div>
  )

  const visibleQueue = queue.filter((item) => !item.folded)
  const completedCount = visibleQueue.filter(
    (item) => item.status === "completed",
  ).length
  const failedCount = visibleQueue.filter(
    (item) => item.status === "failed",
  ).length
  const cancelledCount = visibleQueue.filter(
    (item) => item.status === "cancelled",
  ).length
  const pendingReviewCount = visibleQueue.filter(
    (item) => item.status === "pending_review",
  ).length

  /** UT-27: resume is admin-only and only when the server's allowed
   * operations include a fix-then-retry command. */
  const canResumeItem = (item: ImportItem): boolean =>
    Boolean(item.docId) &&
    item.status === "failed" &&
    canCreate &&
    (item.progress?.outcome?.allowedOperations ?? []).some((operation) =>
      operation.endsWith("_then_retry"),
    )

  // Session tray: folded outcomes the server catalog can never show (a
  // rejected upload owns no document) plus folded failures whose only remedy
  // (resume) the catalog row does not carry.
  const trayItems = queue.filter(
    (item) =>
      item.folded &&
      (!item.docId || (item.status === "failed" && canResumeItem(item))),
  )

  if (requiresEmbeddingSetup) {
    return (
      <PanelDialog
        open={open}
        onClose={onClose}
        titleId="import-title"
        title="导入知识库文档"
        className="sm:max-w-[640px]"
      >
        <div className="flex flex-col gap-4 px-5 py-6">
          <Alert tone="danger" title="需要先配置 Embedding 模型">
            <span className="block text-xs leading-relaxed">
              当前工作区还没有嵌入模型，导入的文件或文件夹无法建立向量索引。请先在「模型设置」里保存 Embedding 的 Base URL、模型与向量维度，再回来导入。
            </span>
          </Alert>
          <div className="flex justify-end gap-2">
            <UiButton variant="ghost" size="sm" type="button" onClick={onClose}>
              取消
            </UiButton>
            <UiButton
              variant="default"
              size="sm"
              type="button"
              onClick={() => {
                onClose()
                openSettings()
              }}
            >
              去配置
            </UiButton>
          </div>
        </div>
      </PanelDialog>
    )
  }

  return (
    <PanelDialog
      open={open}
      onClose={onClose}
      titleId="import-title"
      title="导入知识库文档"
      className="sm:max-w-[640px] h-[min(760px,calc(100dvh-64px))]"
    >
      <div className="flex-none border-b border-line px-5 py-3 max-md:px-4">
        {baseStatus === "ready" && bases.length === 0 ? (
          <div className="rounded-[14px] border border-dashed border-line bg-surface-subtle px-4 py-4 text-center">
            <p className="text-xs font-medium text-ink">暂无知识库</p>
            <p className="mt-0.5 text-[11px] text-faint/70">
              创建一个知识库后即可导入文档
            </p>
            {canCreate ? (
              showCreateBase ? (
                createBaseRow
              ) : (
                <UiButton
                  variant="default"
                  size="sm"
                  type="button"
                  onClick={() => setShowCreateBase(true)}
                  className="mt-2.5 inline-flex h-8 items-center justify-center px-3.5"
                >
                  新建知识库
                </UiButton>
              )
            ) : (
              <p className="mt-1 text-[11px] text-faint">
                当前账号无创建权限，请联系管理员
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <label
                htmlFor="import-knowledge-base"
                className="text-xs font-medium text-ink"
              >
                目标知识库
              </label>
              {canCreate ? (
                <UiButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => setShowCreateBase((previous) => !previous)}
                  className=""
                >
                  {showCreateBase ? "收起" : "＋ 新建知识库"}
                </UiButton>
              ) : null}
            </div>
            <UiSelect
              id="import-knowledge-base"
              value={knowledgeBaseId}
              onChange={(event) => setKnowledgeBaseId(event.target.value)}
              disabled={creating}
              hideSelected
              className="mt-1.5 h-9 w-full border px-2"
            >
              {baseOptions}
            </UiSelect>
            {showCreateBase ? createBaseRow : null}
            <div className="mt-2">
              {categoryCreatorOpen ? (
                <Input
                  aria-label="新文档分类名称"
                  autoFocus
                  value={categoryDraft}
                  onChange={(event) => setCategoryDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") confirmCategoryDraft()
                  }}
                  onBlur={confirmCategoryDraft}
                  onKeyDownCapture={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault()
                      setCategoryCreatorOpen(false)
                      setCategoryDraft("")
                    }
                  }}
                  placeholder="输入新分类名，回车确认"
                  className="h-8 w-full border px-2"
                />
              ) : (
                <UiSelect
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
                  hideSelected
                  disabled={
                    !knowledgeBaseId || documentFoldersStatus === "loading"
                  }
                  className="h-8 w-full border px-2 disabled:opacity-50"
                >
                  <option value="">
                    {!knowledgeBaseId
                      ? "请先选择知识库"
                      : documentFoldersStatus === "loading"
                        ? "正在加载分类…"
                        : "不归类"}
                  </option>
                  {documentFolders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}（{folder.documents} 篇）
                    </option>
                  ))}
                  {pendingCategoryName ? (
                    <option value="__pending__">
                      新分类：{pendingCategoryName}
                    </option>
                  ) : null}
                  <option value="__new__">＋ 新建分类</option>
                </UiSelect>
              )}
            </div>
          </>
        )}
      </div>

      <div className="px-5 py-3">
        <SegmentedControl
          label="导入方式"
          value={tab}
          onValueChange={(value) =>
            setTab(value as "local" | "url" | "records")
          }
          options={[
            { value: "local", label: "本地文档" },
            { value: "url", label: "在线网页 (URL)" },
            { value: "records", label: "上传记录" },
          ]}
        />
      </div>

      {tab === "local" ? (
        <section
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4 max-md:px-4"
          role="tabpanel"
        >
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
      ) : tab === "url" ? (
        <section
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-5 max-md:px-4"
          role="tabpanel"
        >
          <SegmentedControl
            className="mb-4"
            label="网页导入模式"
            value={urlMode}
            onValueChange={(value) => setUrlMode(value as "single" | "sitemap")}
            options={[
              { value: "single", label: "单个网页" },
              { value: "sitemap", label: "网站抓取 (Sitemap)" },
            ]}
          />
          <div className="flex flex-col gap-4">
            <FormField className="flex flex-col gap-1.5">
              <FieldLabel
                htmlFor="import-url-input"
                className="text-[13px] font-medium text-ink"
              >
                {urlMode === "single" ? "网页链接" : "Sitemap 链接"}
              </FieldLabel>
              <Input
                id="import-url-input"
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder={
                  urlMode === "single"
                    ? "https://example.com/article"
                    : "https://example.com/sitemap.xml"
                }
                className="h-10 w-full border px-3.5"
              />
              <p className="text-[11px] text-faint/70">
                不支持需要登录或依赖 JS 渲染的页面（SPA
                可能抓不到正文）；Sitemap 最多抓取 200 页
              </p>
            </FormField>

            {urlMode === "sitemap" ? (
              <FormField className="flex flex-col gap-1.5">
                <NumberField
                  id="import-url-max-pages"
                  label="最大抓取页数"
                  min={1}
                  max={200}
                  value={maxPages}
                  onValueChange={setMaxPages}
                  suffix=" 页"
                  locale="zh-CN"
                  limitHint={false}
                />
              </FormField>
            ) : null}

            <UiButton
              variant="default"
              size="sm"
              type="button"
              disabled={submitting || !knowledgeBaseId}
              title={!knowledgeBaseId ? "请先选择知识库" : undefined}
              onClick={() => void handleUrlImport()}
              className="mt-2 inline-flex h-10 w-full items-center justify-center gap-2 px-4 active:scale-[0.97] disabled:opacity-50 disabled:active:scale-100"
            >
              {submitting
                ? "导入中…"
                : urlMode === "single"
                  ? "导入该网页"
                  : "批量导入"}
            </UiButton>
          </div>
        </section>
      ) : (
        <section
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4 max-md:px-4"
          role="tabpanel"
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                <Icon icon={History} className="size-4 flex-none text-faint" />
                上传记录
              </p>
              <p className="mt-0.5 text-[11px] text-faint/70">
                {knowledgeBaseId
                  ? "当前知识库最近 50 条导入，已上传的文档可随时查看"
                  : "先在顶部选择目标知识库"}
              </p>
            </div>
            <UiButton
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => void loadRecords()}
              disabled={!knowledgeBaseId || recordsStatus === "loading"}
              className="shrink-0 gap-1.5"
            >
              <Icon
                icon={RefreshCw}
                className={cn(
                  "size-3.5",
                  recordsStatus === "loading" && "animate-spin",
                )}
              />
              刷新
            </UiButton>
          </div>
          {trayItems.length > 0 ? (
            <div className="mb-3">
              <p className="mb-1.5 text-[11px] font-medium text-faint">
                本次会话 · {trayItems.length} 项
              </p>
              <ul className="flex flex-col gap-1.5">
                {trayItems.map((item) => {
                  const errorView = item.error
                    ? describeImportError(item.error, {
                        kind: item.errorKind,
                        detected: item.errorDetected,
                        acceptedByServer: Boolean(item.docId),
                      })
                    : null
                  return (
                    <li
                      key={item.id}
                      className="flex items-center gap-2.5 rounded-[10px] border border-line bg-surface-subtle px-3 py-2"
                    >
                      <Icon
                        icon={trayStatusIcon(item.status)}
                        className={cn(
                          "size-4 flex-none",
                          item.status === "completed"
                            ? "text-success"
                            : item.status === "failed"
                              ? "text-danger"
                              : "text-warning",
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span
                          className="block truncate text-xs font-medium text-ink"
                          title={item.filePath}
                        >
                          {item.fileName}
                        </span>
                        <span className="block truncate text-[11px] text-faint/70">
                          {item.foldedAt
                            ? formatRecordedAt(
                                new Date(item.foldedAt).toISOString(),
                              )
                            : ""}
                          {errorView ? ` · ${errorView.text}` : ""}
                        </span>
                      </span>
                      {retryDecision(item).retryable ? (
                        <UiButton
                          variant="ghost"
                          size="sm"
                          type="button"
                          onClick={() => retryItem(item)}
                          className="px-1.5 py-0.5"
                        >
                          重试
                        </UiButton>
                      ) : null}
                      {canResumeItem(item) ? (
                        <UiButton
                          variant="ghost"
                          size="sm"
                          type="button"
                          onClick={() => resumeItem(item)}
                          title="用服务端保留的原件重新处理，同一文档与任务"
                          className="px-1.5 py-0.5"
                        >
                          恢复
                        </UiButton>
                      ) : null}
                      {errorView?.kind === "conflict" ? (
                        <UiButton
                          variant="ghost"
                          size="sm"
                          type="button"
                          onClick={() => void viewConflictDocument(item)}
                          className="px-1.5 py-0.5"
                        >
                          查看文档
                        </UiButton>
                      ) : null}
                      <span
                        className={cn(
                          "flex-none rounded-full px-2 py-0.5 text-[10px] font-medium",
                          statusBadgeClass(item.status),
                        )}
                      >
                        {STATUS_TEXT[item.status]}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : null}
          {!knowledgeBaseId ? (
            <InlineMessage>请先选择目标知识库。</InlineMessage>
          ) : recordsStatus === "error" ? (
            <InlineMessage>上传记录读取失败：{recordsError}</InlineMessage>
          ) : recordsStatus === "loading" || recordsStatus === "idle" ? (
            <InlineMessage>正在读取上传记录…</InlineMessage>
          ) : records.length === 0 ? (
            <InlineMessage>这个知识库还没有上传记录。</InlineMessage>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {records.map((record) => {
                // ✅ is the ACTIVE version only — a completed-but-unactivated
                // candidate renders its hold (待校验 / 待审中), never success.
                const view = deriveRecordView(record)
                return (
                  <li key={record.docId}>
                    <button
                      type="button"
                      onClick={() => openDocument({ documentId: record.docId })}
                      title={`查看「${record.title}」`}
                      className="group flex w-full items-center gap-2.5 rounded-[10px] border border-line bg-surface-subtle px-3 py-2 text-left transition-colors hover:bg-surface-muted"
                    >
                      <Icon
                        icon={recordIcon(view.state)}
                        className={cn(
                          "size-4 flex-none",
                          recordIconClass(view.state),
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-ink">
                          {record.title}
                        </span>
                        <span className="block truncate text-[11px] text-faint/70">
                          {formatRecordedAt(record.createdAt)} ·{" "}
                          {record.folder ?? "不归类"}
                          {record.retired ? " · 已归档" : ""}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "flex-none rounded-full px-2 py-0.5 text-[10px] font-medium",
                          recordBadgeClass(view.state),
                        )}
                      >
                        {view.label}
                      </span>
                      <Icon
                        icon={Eye}
                        className="size-3.5 flex-none text-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                      />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}

      {open && visibleQueue.length > 0 ? (
        <div className="max-h-52 flex-none overflow-y-auto border-t border-line px-5 py-3 max-md:px-4">
          <ol className="flex min-w-0 flex-col gap-2.5">
            {waves.map((wave) => {
              const waveItems = visibleQueue.filter(
                (item) => item.waveId === wave.id,
              )
              if (waveItems.length === 0) return null
              return (
                <li key={wave.id}>
                  <p
                    className="mb-1 truncate text-[11px] font-medium text-faint"
                    title={wave.label}
                  >
                    {wave.label}
                    <span className="ml-1.5 text-faint">
                      {waveItems.length} 项
                    </span>
                  </p>
                  {/* grid-cols-1 pins the single track to minmax(0,1fr): an
                      implicit auto track sizes to the widest max-content (a
                      long nowrap error line) and blows out the 520px dialog. */}
                  <ul className="grid grid-cols-1 gap-1.5">
                    {waveItems.map((item) => {
                      const errorView = item.error
                        ? describeImportError(item.error, {
                            kind: item.errorKind,
                            detected: item.errorDetected,
                            acceptedByServer: Boolean(item.docId),
                          })
                        : null
                      const retryGate = retryDecision(item)
                      const canRetry = retryGate.retryable
                      const canCancel =
                        item.status === "queued" ||
                        item.status === "uploading" ||
                        item.status === "pending" ||
                        item.status === "processing"
                      // UT-27: resume requeues the ORIGINAL server task — only
                      // for admin sessions, only on failed rows, and only when
                      // the server's allowed operations include a resume
                      // command (configure/fix-input-then-retry). Auto-retry
                      // rows (wait_for_auto_retry) wait instead.
                      const canResume = canResumeItem(item)
                      // UT-26: structured end-state details — reasons and
                      // allowed operations come from the backend's own fields.
                      // Ticket 26: failed rows report evidence-backed reasons
                      // keyed off the audit reason codes, grouped into plain
                      // categories (merged pages; a service fault never asks
                      // to replace the file) plus the password/re-export
                      // guidance; raw codes stay in technicalDetail (tooltip).
                      const outcome = item.progress?.outcome ?? null
                      const failureView =
                        outcome?.state === "failed" && outcome.reasonCode
                          ? describeFailure(outcome as FailureRecordLike)
                          : null
                      const outcomeReasons =
                        outcome?.state === "pending_review"
                          ? describeActivationReasons(outcome.blockReasons)
                          : failureView
                            ? failureView.reasons
                            : []
                      const outcomeTechnicalDetail =
                        failureView?.technicalDetail ?? []
                      const outcomeOperations =
                        outcome?.state === "capability_missing"
                          ? describeAllowedOperations(outcome.allowedOperations)
                          : []
                      return (
                        <li
                          key={item.id}
                          className="rounded-[10px] border border-line bg-surface-subtle px-2.5 py-2 text-xs"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span
                                  className="truncate font-medium text-ink"
                                  title={item.filePath}
                                >
                                  {item.fileName}
                                </span>
                                {item.precheckHit ? (
                                  <span className="flex-none rounded-full bg-warning-subtle px-1.5 py-0.5 text-[10px] font-medium text-warning">
                                    已存在
                                  </span>
                                ) : null}
                              </div>
                              {errorView ? (
                                <div
                                  className={cn(
                                    "truncate text-[11px]",
                                    errorView.kind === "generic"
                                      ? "text-danger"
                                      : "text-warning",
                                  )}
                                >
                                  {errorView.text}
                                </div>
                              ) : item.size > 0 ? (
                                <div className="text-[11px] text-faint/70">
                                  {formatBytes(item.size)}
                                </div>
                              ) : null}
                              {outcomeReasons.length > 0 ? (
                                <div
                                  className="truncate text-[11px] text-warning"
                                  title={[
                                    ...outcomeReasons,
                                    ...(outcomeTechnicalDetail.length > 0
                                      ? [
                                          `技术明细：${outcomeTechnicalDetail.join("；")}`,
                                        ]
                                      : []),
                                  ].join("；")}
                                >
                                  {outcomeReasons.join("；")}
                                </div>
                              ) : null}
                              {outcomeOperations.length > 0 ? (
                                <div
                                  className="truncate text-[11px] text-warning"
                                  title={outcomeOperations.join("；")}
                                >
                                  {outcomeOperations.join("；")}
                                </div>
                              ) : null}
                              {outcome?.userGuidance ? (
                                <div className="break-words text-[11px] text-warning">
                                  {PDF_PROTECTION_GUIDANCE}
                                </div>
                              ) : null}
                              {outcome?.oldVersionUsable ? (
                                <div className="truncate text-[11px] text-faint/70">
                                  现有版本仍可正常使用
                                </div>
                              ) : null}
                              {outcome?.state === "completed" &&
                              outcome.activationWarnings.length > 0 ? (
                                <div
                                  className="truncate text-[11px] text-faint/70"
                                  title={outcome.activationWarnings.join("；")}
                                >
                                  {describeActivationWarnings(
                                    outcome.activationWarnings,
                                  ).join("；")}
                                </div>
                              ) : null}
                            </div>
                            <div className="flex flex-none items-center gap-1">
                              {item.precheckHit && item.status === "queued" ? (
                                <>
                                  <UiButton
                                    variant="ghost"
                                    size="sm"
                                    type="button"
                                    onClick={() => {
                                      updateItem(item.id, {
                                        precheckHit: false,
                                      })
                                      ensureWorkers()
                                    }}
                                    className="px-1.5 py-0.5"
                                  >
                                    仍要导入
                                  </UiButton>
                                  <UiButton
                                    variant="ghost"
                                    size="sm"
                                    type="button"
                                    onClick={() =>
                                      updateItem(item.id, {
                                        status: "cancelled",
                                      })
                                    }
                                    className="px-1.5 py-0.5"
                                  >
                                    跳过
                                  </UiButton>
                                </>
                              ) : null}
                              {item.status === "queued" && !item.precheckHit ? (
                                <UiButton
                                  variant="ghost"
                                  size="sm"
                                  type="button"
                                  onClick={() => removeItem(item.id)}
                                  aria-label={`移除 ${item.fileName}`}
                                  className="px-1.5 py-0.5"
                                >
                                  移除
                                </UiButton>
                              ) : null}
                              {canCancel ? (
                                <UiButton
                                  variant="ghost"
                                  size="sm"
                                  type="button"
                                  onClick={() => void cancelItem(item)}
                                  className="px-1.5 py-0.5"
                                >
                                  取消
                                </UiButton>
                              ) : null}
                              {canRetry ? (
                                <UiButton
                                  variant="ghost"
                                  size="sm"
                                  type="button"
                                  onClick={() => retryItem(item)}
                                  className="px-1.5 py-0.5"
                                >
                                  重试
                                </UiButton>
                              ) : null}
                              {canResume ? (
                                <UiButton
                                  variant="ghost"
                                  size="sm"
                                  type="button"
                                  onClick={() => resumeItem(item)}
                                  title="用服务端保留的原件重新处理，同一文档与任务"
                                  className="px-1.5 py-0.5"
                                >
                                  恢复
                                </UiButton>
                              ) : null}
                              {item.status === "completed" && item.docId ? (
                                confirmingDeleteId === item.id ? (
                                  <>
                                    <UiButton
                                      variant="destructive"
                                      size="sm"
                                      type="button"
                                      onClick={() => void deleteItem(item)}
                                      className="px-1.5 py-0.5"
                                    >
                                      不可恢复，确认删除
                                    </UiButton>
                                    <UiButton
                                      variant="ghost"
                                      size="sm"
                                      type="button"
                                      onClick={() =>
                                        setConfirmingDeleteId(null)
                                      }
                                      className="px-1.5 py-0.5"
                                    >
                                      取消
                                    </UiButton>
                                  </>
                                ) : (
                                  <>
                                    <UiButton
                                      variant="ghost"
                                      size="sm"
                                      type="button"
                                      onClick={() =>
                                        openDocument({
                                          documentId: item.docId as string,
                                        })
                                      }
                                      className="gap-1 px-1.5 py-0.5"
                                    >
                                      <Icon icon={Eye} className="size-3.5" />
                                      查看
                                    </UiButton>
                                    <UiButton
                                      variant="destructive"
                                      size="sm"
                                      type="button"
                                      onClick={() =>
                                        setConfirmingDeleteId(item.id)
                                      }
                                      className="gap-1 px-1.5 py-0.5"
                                    >
                                      <Icon icon={Trash2} className="size-3.5" />
                                      删除
                                    </UiButton>
                                  </>
                                )
                              ) : null}
                              {errorView?.kind === "conflict" ? (
                                <UiButton
                                  variant="ghost"
                                  size="sm"
                                  type="button"
                                  onClick={() =>
                                    void viewConflictDocument(item)
                                  }
                                  className="px-1.5 py-0.5"
                                >
                                  查看文档
                                </UiButton>
                              ) : null}
                              <span
                                className={cn(
                                  "rounded-full px-2 py-0.5 text-[10px] font-medium",
                                  statusBadgeClass(item.status),
                                )}
                              >
                                {STATUS_TEXT[item.status]}
                              </span>
                            </div>
                          </div>
                          <ImportProgress
                            fileName={item.fileName}
                            progress={
                              item.progress ?? {
                                ...initialImportProgress(item.status),
                                error: item.error,
                              }
                            }
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
          <div
            className="mt-2 flex items-center justify-between border-t border-line pt-2 text-[11px] text-faint"
            aria-live="polite"
          >
            <span>
              {[
                `${completedCount} 成功`,
                `${failedCount} 失败`,
                `${cancelledCount} 已取消`,
                pendingReviewCount > 0 ? `${pendingReviewCount} 待校验` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <span>{visibleQueue.length} 项</span>
          </div>
        </div>
      ) : null}
    </PanelDialog>
  )
}
