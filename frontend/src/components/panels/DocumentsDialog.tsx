import { BookOpen, FileText, NotebookPen, X } from "lucide"
import { useEffect, useRef, useState } from "react"

import { Icon } from "../ui/Icon"
import { useSignedInSession } from "../../runtime/SessionContext"
import { useAppShell } from "../../runtime/AppShellContext"
import { WikiDialog } from "./WikiDialog"
import {
  cancelDocument,
  fetchDocumentStatus,
  fetchKnowledgeBaseDocuments,
  reprocessDocument,
  retireSource,
  retryDocument,
  type DocumentCatalogEntryPayload,
  type DocumentCatalogPayload,
  type DocumentCatalogView,
} from "../../lib/api"

/**
 * Ticket 11 (DOC-01A): the knowledge-base document catalog. Every signed-in
 * member may browse what they are authorized to see (the server applies the
 * tenant, group and knowledge-base scoping — the UI only renders its answer).
 *
 * The route is read-only: no administrator action exists here (ticket 12 adds
 * them). The filters/page survive a refresh through localStorage, and every
 * render's data comes from the document service over HTTP — the persisted
 * state is only the view (page + filters), never the list itself.
 */

const VIEW_STORAGE_KEY = "nexusrag.documents.view"

const STATUS_LABELS: Record<string, string> = {
  pending: "处理中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
}

const PAGE_SIZE = 20

function readStoredView(kbId: string): DocumentCatalogView {
  try {
    const raw = window.localStorage.getItem(VIEW_STORAGE_KEY)
    const parsed = raw === null ? null : (JSON.parse(raw) as Partial<DocumentCatalogView> & { kbId?: string })
    if (parsed && parsed.kbId === kbId) {
      return {
        page: typeof parsed.page === "number" && parsed.page >= 1 ? parsed.page : 1,
        status: typeof parsed.status === "string" ? parsed.status : "",
        tag: typeof parsed.tag === "string" ? parsed.tag : "",
        folder: typeof parsed.folder === "string" ? parsed.folder : "",
      }
    }
  } catch {
    // Unavailable storage — the view simply does not survive a reload.
  }
  return { page: 1, status: "", tag: "", folder: "" }
}

function persistView(kbId: string, view: DocumentCatalogView): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({ kbId, ...view }))
  } catch {
    // ignore
  }
}

const selectClass =
  "h-8 min-w-0 rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none focus:border-brand disabled:opacity-50"

const rowButtonClass =
  "inline-flex h-7 cursor-pointer items-center gap-1 rounded-lg border border-line px-2 text-[11px] text-muted transition-colors hover:bg-surface-subtle hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"

/**
 * Ticket 12 (DOC-01B): administrator actions reuse the server's lifecycle —
 * cancel (pending), retry (failed/cancelled), reprocess (completed) and
 * retire (whole source, requires a reason). Durable errors are read from the
 * ingest status endpoint on demand.
 */
function DocumentRow({
  doc,
  canAdmin,
  busy,
  onAction,
  onView,
}: {
  doc: DocumentCatalogEntryPayload
  canAdmin: boolean
  busy: boolean
  onAction: (action: () => Promise<void>, successText: string) => void
  onView: (doc: DocumentCatalogEntryPayload) => void
}) {
  const [errorDetail, setErrorDetail] = useState<string | null>(null)
  const [retiring, setRetiring] = useState(false)
  const [reason, setReason] = useState("")

  const showError = () => {
    if (errorDetail !== null) {
      setErrorDetail(null)
      return
    }
    void fetchDocumentStatus(doc.docId)
      .then((payload) => {
        const failed = collectErrors(payload)
        setErrorDetail(failed.length > 0 ? failed : "没有记录到错误信息")
      })
      .catch((err: unknown) => setErrorDetail(err instanceof Error ? err.message : String(err)))
  }

  return (
    <li className="rounded-lg border border-line px-3 py-2.5">
      <div className="flex items-center gap-3 max-md:flex-wrap">
        <Icon icon={FileText} className="size-4 flex-none text-muted" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-xs font-medium text-ink">{doc.title}</span>
            {doc.retired ? (
              <span className="flex-none rounded-full border border-line bg-surface-subtle px-1.5 py-0.5 font-mono text-[10px] text-muted">
                已退役
              </span>
            ) : null}
            {doc.active ? (
              <span className="flex-none rounded-full border border-brand-line bg-brand-subtle px-1.5 py-0.5 font-mono text-[10px] text-brand">
                活动版本
              </span>
            ) : null}
            <span className="flex-none rounded-full border border-line bg-surface-subtle px-1.5 py-0.5 font-mono text-[10px] text-muted">
              {STATUS_LABELS[doc.status] ?? doc.status}
            </span>
            <span className="flex-none rounded-full border border-line bg-surface-subtle px-1.5 py-0.5 font-mono text-[10px] text-muted">
              v{doc.version}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted/80">
            {doc.folder ? `${doc.folder} · ` : ""}
            {doc.fileName ?? doc.source}
            {doc.tags.length > 0 ? ` · ${doc.tags.join("、")}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onView(doc)}
          title="查看该版本"
          className="flex-none cursor-pointer rounded-lg border border-line px-2 py-1 text-[11px] text-muted transition-colors hover:bg-surface-subtle hover:text-ink"
        >
          查看
        </button>
        {canAdmin && !doc.retired ? (
          <div className="flex flex-none flex-wrap items-center justify-end gap-1.5">
            {doc.status === "pending" ? (
              <button type="button" disabled={busy} className={rowButtonClass}
                onClick={() => onAction(() => cancelDocument(doc.docId), "已请求取消")}>
                取消
              </button>
            ) : null}
            {doc.status === "failed" || doc.status === "cancelled" ? (
              <>
                <button type="button" disabled={busy} className={rowButtonClass} onClick={showError}>
                  {errorDetail !== null ? "收起错误" : "查看错误"}
                </button>
                <button type="button" disabled={busy} className={rowButtonClass}
                  onClick={() => onAction(() => retryDocument(doc.docId), "已重新排队")}>
                  重试
                </button>
              </>
            ) : null}
            {doc.status === "completed" ? (
              <button type="button" disabled={busy} className={rowButtonClass}
                onClick={() => onAction(() => reprocessDocument(doc.docId), "已重新处理")}>
                重新处理
              </button>
            ) : null}
            {retiring ? (
              <span className="flex items-center gap-1">
                <input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="退役原因"
                  maxLength={200}
                  className="h-7 w-32 rounded-md border border-line bg-surface px-2 text-[11px] outline-none focus:border-brand"
                />
                <button
                  type="button"
                  disabled={busy || !reason.trim()}
                  className={rowButtonClass}
                  onClick={() => {
                    const finalReason = reason.trim()
                    setRetiring(false)
                    setReason("")
                    onAction(() => retireSource(doc.sourceId, finalReason), "已退役该文档的全部版本")
                  }}
                >
                  确认退役
                </button>
              </span>
            ) : (
              <button type="button" disabled={busy} className={rowButtonClass}
                title="退役该文档的全部版本，历史引用保持可追溯"
                onClick={() => setRetiring(true)}>
                退役
              </button>
            )}
          </div>
        ) : null}
      </div>
      {errorDetail !== null ? (
        <p role="alert" className="mt-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {errorDetail}
        </p>
      ) : null}
    </li>
  )
}

function collectErrors(payload: Awaited<ReturnType<typeof fetchDocumentStatus>>): string {
  const messages: string[] = []
  const walk = (nodes: Array<{ span: { name: string; status: string; errorMessage: string | null }; children: unknown[] }>) => {
    for (const node of nodes) {
      if (
        (node.span.status === "failed" || node.span.status === "cancelled") &&
        node.span.errorMessage
      ) {
        messages.push(`${node.span.name}: ${node.span.errorMessage}`)
      }
      if (Array.isArray(node.children)) walk(node.children as typeof nodes)
    }
  }
  walk(payload.spanTree ?? [])
  return messages.join("；") || "没有记录到错误信息"
}

export function DocumentsDialog({
  open,
  knowledgeBase,
  onClose,
}: {
  open: boolean
  knowledgeBase: { id: string; name: string } | null
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const kbId = knowledgeBase?.id ?? null
  // The browse session: (kbId, view) is restored from storage exactly once
  // per open/switch, so opening the dialog never fetches twice.
  const [session, setSession] = useState<{ kbId: string; view: DocumentCatalogView } | null>(null)
  const view = session?.kbId === kbId ? session.view : null
  const [catalog, setCatalog] = useState<DocumentCatalogPayload | null>(null)
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle")
  const [error, setError] = useState<string | null>(null)
  // Ticket 12 (DOC-01B): bumped after an admin action so the list refetches.
  const [refreshTick, setRefreshTick] = useState(0)
  const [busy, setBusy] = useState(false)
  const scopes = useSignedInSession()?.scopes ?? []
  const canAdmin = scopes.includes("admin")
  const { showToast, openDocument } = useAppShell()
  // Ticket 38 (WIKI-01): the administrator Wiki surface for this knowledge base.
  const [wikiOpen, setWikiOpen] = useState(false)

  const runAction = (action: () => Promise<void>, successText: string) => {
    setBusy(true)
    action()
      .then(() => {
        showToast(successText)
        setRefreshTick((tick) => tick + 1)
      })
      .catch((err: unknown) => {
        showToast(err instanceof Error ? err.message : "操作失败")
        setRefreshTick((tick) => tick + 1)
      })
      .finally(() => setBusy(false))
  }

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && kbId && !dialog.open) {
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open, kbId])

  useEffect(() => {
    if (!open || !kbId) return
    if (view === null) {
      setSession({ kbId, view: readStoredView(kbId) })
      setStatus("loading")
      return
    }
    let discarded = false
    setStatus("loading")
    setError(null)
    fetchKnowledgeBaseDocuments(kbId, view, PAGE_SIZE)
      .then((payload) => {
        if (discarded) return
        setCatalog(payload)
        setStatus("ready")
        // A persisted page can fall off the end after deletions — snap back
        // to the true last page instead of rendering a misleading empty state.
        if (payload.documents.length === 0 && payload.total > 0 && view.page > 1) {
          setSession({ kbId, view: { ...view, page: Math.max(1, Math.ceil(payload.total / PAGE_SIZE)) } })
        }
      })
      .catch((err: unknown) => {
        if (discarded) return
        setError(err instanceof Error ? err.message : String(err))
        setStatus("error")
      })
    persistView(kbId, view)
    return () => {
      discarded = true
    }
  }, [open, kbId, view, refreshTick])

  const totalPages = catalog ? Math.max(1, Math.ceil(catalog.total / PAGE_SIZE)) : 1
  const setViewPage = (page: number) =>
    view && setSession({ kbId: kbId ?? "", view: { ...view, page: Math.min(Math.max(1, page), totalPages) } })
  const setFilter = (patch: Partial<DocumentCatalogView>) =>
    view && setSession({ kbId: kbId ?? "", view: { ...view, ...patch, page: 1 } })

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      aria-labelledby="documents-title"
      className="m-auto h-[min(640px,calc(100dvh-48px))] w-[min(680px,calc(100vw-32px))] grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-dialog backdrop:bg-black/20 open:grid open:animate-dialog-enter max-md:m-0 max-md:h-dvh max-md:w-screen max-md:rounded-none max-md:border-0"
    >
      <div className="flex h-13 flex-none items-center justify-between border-b border-line px-5 max-md:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Icon icon={BookOpen} className="size-4 flex-none text-muted" />
          <h2 id="documents-title" className="truncate text-sm font-semibold text-ink">
            文档目录{knowledgeBase ? ` · ${knowledgeBase.name}` : ""}
          </h2>
        </div>
        <div className="flex flex-none items-center gap-1.5">
          {canAdmin ? (
            <button
              type="button"
              onClick={() => setWikiOpen(true)}
              title="生成与管理 Wiki 页面"
              className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-line px-2 text-xs text-muted transition-colors hover:bg-surface-subtle hover:text-ink"
            >
              <Icon icon={NotebookPen} className="size-3.5" />
              Wiki
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭文档目录"
            title="关闭"
            className="grid size-7 flex-none cursor-pointer place-items-center rounded-md text-muted/70 transition-colors hover:bg-surface-subtle hover:text-ink"
          >
            <Icon icon={X} className="size-4" />
          </button>
        </div>
      </div>
      {/* Ticket 38 (WIKI-01): the per-knowledge-base Wiki workshop. */}
      <WikiDialog
        open={wikiOpen}
        knowledgeBase={knowledgeBase}
        onClose={() => setWikiOpen(false)}
      />

      {/* Filters */}
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-line px-5 py-3 max-md:px-4">
        <select
          aria-label="按处理状态筛选"
          value={view?.status ?? ""}
          onChange={(event) => setFilter({ status: event.target.value })}
          className={selectClass}
        >
          <option value="">全部状态</option>
          <option value="pending">处理中</option>
          <option value="completed">已完成</option>
          <option value="failed">失败</option>
          <option value="cancelled">已取消</option>
        </select>
        <select
          aria-label="按标签筛选"
          value={view?.tag ?? ""}
          onChange={(event) => setFilter({ tag: event.target.value })}
          className={selectClass}
        >
          <option value="">全部标签</option>
          {(catalog?.tags ?? []).map((tag) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </select>
        <select
          aria-label="按文件夹筛选"
          value={view?.folder ?? ""}
          onChange={(event) => setFilter({ folder: event.target.value })}
          className={selectClass}
        >
          <option value="">全部文件夹</option>
          {(catalog?.folders ?? []).map((folder) => (
            <option key={folder} value={folder}>
              {folder}
            </option>
          ))}
        </select>
        <span className="ml-auto font-mono text-[11px] text-muted/70">
          {catalog ? `${catalog.total} 篇` : ""}
        </span>
      </div>

      {/* List: loading / error / empty / rows */}
      <div className="flex min-h-0 flex-col overflow-y-auto px-5 py-4 max-md:px-4">
        {status === "loading" || status === "idle" ? (
          <p className="px-1 py-6 text-center text-xs text-muted">正在加载文档目录…</p>
        ) : status === "error" ? (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/40">
            <p className="text-xs text-red-700 dark:text-red-300">文档目录读取失败：{error}</p>
            <button
              type="button"
              onClick={() => view && setSession({ kbId: kbId ?? "", view: { ...view } })}
              className="mt-2 cursor-pointer text-xs font-medium text-brand hover:underline"
            >
              重试
            </button>
          </div>
        ) : (catalog?.documents.length ?? 0) === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted">
            {view?.status || view?.tag || view?.folder
              ? "没有符合筛选条件的文档。"
              : "这个知识库还没有文档，先去导入一些吧。"}
          </p>
        ) : (
          <>
            <ul className="flex flex-col gap-2">
              {catalog?.documents.map((doc) => (
                <DocumentRow
                  key={doc.docId}
                  doc={doc}
                  canAdmin={canAdmin}
                  busy={busy}
                  onAction={runAction}
                  onView={(target) => openDocument({ documentId: target.docId })}
                />
              ))}
            </ul>
            {totalPages > 1 ? (
              <div className="mt-4 flex flex-none items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => setViewPage((view?.page ?? 1) - 1)}
                  disabled={(view?.page ?? 1) <= 1}
                  className="inline-flex h-8 cursor-pointer items-center rounded-lg border border-line px-3 text-xs text-muted transition-colors hover:bg-surface-subtle hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                >
                  上一页
                </button>
                <span className="font-mono text-[11px] text-muted">
                  {view?.page ?? 1} / {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setViewPage((view?.page ?? 1) + 1)}
                  disabled={(view?.page ?? 1) >= totalPages}
                  className="inline-flex h-8 cursor-pointer items-center rounded-lg border border-line px-3 text-xs text-muted transition-colors hover:bg-surface-subtle hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                >
                  下一页
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </dialog>
  )
}
