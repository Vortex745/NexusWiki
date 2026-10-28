import { Button as UiButton } from "@/components/ui/Button"
import { Alert } from "@/components/arc/alert/alert"
import { Input } from "@/components/arc/input/input"
import { ConfirmDialog, PanelBody, PanelDialog } from "../ui/Dialog"
import { DangerNote, InlineMessage } from "../ui/containers"
import { FileText, NotebookPen, RefreshCw } from "../ui/icons"
import { useEffect, useState } from "react"

import { Icon } from "../ui/Icon"
import { Button, Select, StatusBadge } from "../ui/Controls"
import { cn } from "../../lib/cn"
import { useSignedInSession } from "../../runtime/SessionContext"
import { useAppShell } from "../../runtime/AppShellContext"
import { SyncDialog } from "./SyncDialog"
import { WikiDialog } from "./WikiDialog"
import {
  cancelDocument,
  createDocumentFolder,
  deleteDocumentFolder,
  fetchDocumentFolders,
  fetchDocumentStatus,
  fetchKnowledgeBaseDocuments,
  renameDocumentFolder,
  reprocessDocument,
  retireSource,
  retryDocument,
  type DocumentCatalogEntryPayload,
  type DocumentCatalogPayload,
  type DocumentCatalogView,
  type DocumentFolderPayload,
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

/** The delete action asks for no reason, but the tombstone requires one. */
const DELETION_REASON = "文档目录删除"

const STATUS_LABELS: Record<string, string> = {
  pending: "处理中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
}

/**
 * The processing state carries the colour, because it is the one fact per row
 * the user acts on. It used to be a grey pill identical to the retired marker and
 * the version number, so a row of four looked like a row of four pills.
 */
const STATUS_TONES: Record<
  string,
  "neutral" | "success" | "warning" | "danger"
> = {
  pending: "neutral",
  completed: "success",
  failed: "danger",
  cancelled: "warning",
}

const PAGE_SIZE = 20

function readStoredView(kbId: string): DocumentCatalogView {
  try {
    const raw = window.localStorage.getItem(VIEW_STORAGE_KEY)
    const parsed =
      raw === null
        ? null
        : (JSON.parse(raw) as Partial<DocumentCatalogView> & { kbId?: string })
    if (parsed && parsed.kbId === kbId) {
      return {
        page:
          typeof parsed.page === "number" && parsed.page >= 1 ? parsed.page : 1,
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
    window.localStorage.setItem(
      VIEW_STORAGE_KEY,
      JSON.stringify({ kbId, ...view }),
    )
  } catch {
    // ignore
  }
}

const rowButtonClass =
  "inline-flex h-7 cursor-pointer items-center gap-1 rounded-lg border border-line px-2 text-[11px] text-faint transition-colors hover:bg-surface-subtle hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"

/**
 * Ticket 12 (DOC-01B): administrator actions reuse the server's lifecycle —
 * cancel (pending), retry (failed/cancelled), reprocess (completed) and
 * delete (whole source, every version). Durable errors are read from the
 * ingest status endpoint on demand.
 */
function DocumentRow({
  doc,
  canAdmin,
  busy,
  onAction,
  onView,
  onDelete,
}: {
  doc: DocumentCatalogEntryPayload
  canAdmin: boolean
  busy: boolean
  onAction: (action: () => Promise<void>, successText: string) => void
  onView: (doc: DocumentCatalogEntryPayload) => void
  onDelete: (doc: DocumentCatalogEntryPayload) => void
}) {
  const [errorDetail, setErrorDetail] = useState<string | null>(null)

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
      .catch((err: unknown) =>
        setErrorDetail(err instanceof Error ? err.message : String(err)),
      )
  }

  const statusTone = STATUS_TONES[doc.status] ?? "neutral"
  // The subtitle only earns its line when it says something the title does not:
  // the catalog echoes the file name back as the title, so rendering both made
  // every row repeat itself.
  const distinctFileName =
    doc.fileName && doc.fileName !== doc.title ? doc.fileName : null
  const subtitle = [
    doc.folder,
    distinctFileName,
    doc.tags.length > 0 ? doc.tags.join("、") : null,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <li
      className={cn(
        "rounded-[10px] border px-3 py-2.5 transition-colors",
        // "Which version answers now" is a property of the row, so the row says
        // it. It used to be one more grey pill in a pile of identical grey pills.
        doc.active ? "border-brand-line bg-brand-subtle/25" : "border-line",
      )}
    >
      <div className="flex items-center gap-3 max-md:flex-wrap">
        <Icon
          icon={FileText}
          className="size-4 flex-none text-faint"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-xs font-medium text-ink">
              {doc.title}
            </span>
            <StatusBadge tone={statusTone}>
              {STATUS_LABELS[doc.status] ?? doc.status}
            </StatusBadge>
            {/* Metadata, not status: no border, no fill. */}
            <span className="flex-none font-mono text-[10px] text-faint/60">
              v{doc.version}
            </span>
            {doc.active ? (
              <span className="flex-none text-[10px] text-brand">活动版本</span>
            ) : null}
          </div>
          {subtitle ? (
            <p className="mt-0.5 truncate text-[11px] text-faint/80">
              {subtitle}
            </p>
          ) : null}
        </div>
        {/* One right-aligned group, fixed order, one shared button style — the
            ragged right edge came from 查看 sitting outside the admin group. */}
        <div className="flex flex-none flex-wrap items-center justify-end gap-1.5">
          <UiButton
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => onView(doc)}
            title="查看该版本"
            className={rowButtonClass}
          >
            查看
          </UiButton>
          {canAdmin ? (
            <>
              {doc.status === "pending" ? (
                <UiButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={busy}
                  className={rowButtonClass}
                  onClick={() =>
                    onAction(() => cancelDocument(doc.docId), "已请求取消")
                  }
                >
                  取消
                </UiButton>
              ) : null}
              {doc.status === "failed" || doc.status === "cancelled" ? (
                <>
                  <UiButton
                    variant="ghost"
                    size="sm"
                    type="button"
                    disabled={busy}
                    className={rowButtonClass}
                    onClick={showError}
                  >
                    {errorDetail !== null ? "收起错误" : "查看错误"}
                  </UiButton>
                  <UiButton
                    variant="ghost"
                    size="sm"
                    type="button"
                    disabled={busy}
                    className={rowButtonClass}
                    onClick={() =>
                      onAction(() => retryDocument(doc.docId), "已重新排队")
                    }
                  >
                    重试
                  </UiButton>
                </>
              ) : null}
              {doc.status === "completed" ? (
                <UiButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={busy}
                  className={rowButtonClass}
                  onClick={() =>
                    onAction(() => reprocessDocument(doc.docId), "已重新处理")
                  }
                >
                  重新处理
                </UiButton>
              ) : null}
              <UiButton
                variant="ghost"
                size="sm"
                type="button"
                disabled={busy}
                className={rowButtonClass}
                title="删除该文档的全部版本"
                onClick={() => onDelete(doc)}
              >
                删除
              </UiButton>
            </>
          ) : null}
        </div>
      </div>

      {errorDetail !== null ? (
        <Alert tone="danger" title="发生错误"
          className="mt-2 border px-2 py-1.5"
        >
          {errorDetail}
        </Alert>
      ) : null}
    </li>
  )
}

/**
 * The catalog's delete. It runs the server's one destructive document command
 * — source retirement — so it destroys the retrieval content and keeps the
 * version rows, which is what makes a citation from a past answer still open.
 * The catalog no longer lists retired sources, so from here it reads as deleted.
 *
 * No reason field: the tombstone requires a non-empty one, so the command
 * supplies a fixed string and the actor comes from the session, not the form.
 */
function DeleteSourceDialog({
  target,
  busy,
  onClose,
  onConfirm,
}: {
  target: DocumentCatalogEntryPayload | null
  busy: boolean
  onClose: () => void
  onConfirm: (target: DocumentCatalogEntryPayload) => void
}) {
  return (
    <ConfirmDialog
      open={target !== null}
      onClose={onClose}
      title={target ? `删除「${target.title}」` : "删除文档"}
      titleId="documents-delete-title"
      confirmLabel="确认删除"
      onConfirm={() => target && onConfirm(target)}
      busy={busy}
      confirmDisabled={target === null}
    >
      <p>将删除这个文档的全部版本，它将不再参与检索。</p>
      <DangerNote hint="分块、图谱关系、页索引节点与图片资产交给后台队列清理，命令返回只代表已排队。文档的版本记录和删除墓碑保留，历史回答里的引用仍可追溯。">
        此操作不可恢复。
      </DangerNote>
    </ConfirmDialog>
  )
}

function collectErrors(
  payload: Awaited<ReturnType<typeof fetchDocumentStatus>>,
): string {
  const messages: string[] = []
  const walk = (
    nodes: Array<{
      span: { name: string; status: string; errorMessage: string | null }
      children: unknown[]
    }>,
  ) => {
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
  const kbId = knowledgeBase?.id ?? null
  // The browse session: (kbId, view) is restored from storage exactly once
  // per open/switch, so opening the dialog never fetches twice.
  const [session, setSession] = useState<{
    kbId: string
    view: DocumentCatalogView
  } | null>(null)
  const view = session?.kbId === kbId ? session.view : null
  const [catalog, setCatalog] = useState<DocumentCatalogPayload | null>(null)
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(
    "idle",
  )
  const [error, setError] = useState<string | null>(null)
  // Ticket 12 (DOC-01B): bumped after an admin action so the list refetches.
  const [refreshTick, setRefreshTick] = useState(0)
  const [busy, setBusy] = useState(false)
  const scopes = useSignedInSession()?.scopes ?? []
  const canAdmin = scopes.includes("admin")
  const { showToast, openDocument } = useAppShell()
  // Ticket 38 (WIKI-01): the administrator Wiki surface for this knowledge base.
  const [wikiOpen, setWikiOpen] = useState(false)
  // Ticket 39 (SYNC-01A): the administrator sync data-source surface.
  const [syncOpen, setSyncOpen] = useState(false)
  // The row awaiting its confirmation. Owned here, not per row, so one dialog
  // serves the whole list.
  const [deleteTarget, setDeleteTarget] =
    useState<DocumentCatalogEntryPayload | null>(null)

  // The directories of this knowledge base, read from the REGISTRY rather than
  // the catalog facets: an empty folder is still a folder someone can name,
  // file into, or delete.
  const [folders, setFolders] = useState<DocumentFolderPayload[]>([])
  const [creatingFolder, setCreatingFolder] = useState(false)
  /** The folder whose name is being edited, or null while nothing is renaming. */
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  const [folderDraft, setFolderDraft] = useState("")
  const [folderToDelete, setFolderToDelete] =
    useState<DocumentFolderPayload | null>(null)

  useEffect(() => {
    if (!open || !kbId) {
      setFolders([])
      return
    }
    let discarded = false
    void fetchDocumentFolders(kbId)
      .then((list) => {
        if (!discarded) setFolders(list)
      })
      .catch(() => {
        // A failed directory list must not hide the documents: the filter simply
        // falls back to the names the catalog itself reports.
        if (!discarded) setFolders([])
      })
    return () => {
      discarded = true
    }
  }, [open, kbId, refreshTick])

  const selectedFolderName = view?.folder ?? ""
  const selectedFolder =
    folders.find((folder) => folder.name === selectedFolderName) ?? null
  const editingFolder = creatingFolder || renamingFolder !== null
  /**
   * Registry names first, plus any name the catalog still reports as a facet —
   * a document can carry a label whose directory was created before the registry
   * existed, and a filter that could not reach it would hide real content.
   */
  const folderOptions = [
    ...new Set([
      ...folders.map((folder) => folder.name),
      ...(catalog?.folders ?? []),
    ]),
  ].sort((left, right) => left.localeCompare(right, "zh-Hans-CN"))

  const stopFolderEditing = () => {
    setCreatingFolder(false)
    setRenamingFolder(null)
    setFolderDraft("")
  }

  const saveFolderDraft = () => {
    if (!kbId) return
    const name = folderDraft.trim()
    if (!name) return
    if (renamingFolder !== null) {
      const previous = renamingFolder
      runAction(async () => {
        await renameDocumentFolder(
          folders.find((folder) => folder.name === previous)?.id ?? "",
          name,
        )
        // Follow the rename: staying filtered on the old name would read as the
        // folder losing every document it had.
        if (view?.folder === previous) setFilter({ folder: name })
        showToast(`已重命名分类「${name}」`)
      }, "")
    } else {
      runAction(async () => {
        await createDocumentFolder(kbId, name)
        showToast(`已创建分类「${name}」`)
      }, "")
    }
    stopFolderEditing()
  }

  const confirmFolderDelete = () => {
    const target = folderToDelete
    if (!target) return
    setFolderToDelete(null)
    if (view?.folder === target.name) setFilter({ folder: "" })
    runAction(
      () =>
        deleteDocumentFolder(target.id, DELETION_REASON).then(() => undefined),
      `已删除分类「${target.name}」和其中的 ${target.documents} 篇文档`,
    )
  }

  const runAction = (action: () => Promise<void>, successText: string) => {
    setBusy(true)
    action()
      .then(() => {
        // An empty text means the action announced itself (a rename needs the
        // new name, which is only known inside the callback).
        if (successText) showToast(successText)
        setRefreshTick((tick) => tick + 1)
      })
      .catch((err: unknown) => {
        showToast(err instanceof Error ? err.message : "操作失败")
        setRefreshTick((tick) => tick + 1)
      })
      .finally(() => setBusy(false))
  }

  const deleteDocument = (doc: DocumentCatalogEntryPayload) => {
    setDeleteTarget(null)
    runAction(
      () => retireSource(doc.sourceId, DELETION_REASON),
      `已删除「${doc.title}」`,
    )
  }

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
        if (
          payload.documents.length === 0 &&
          payload.total > 0 &&
          view.page > 1
        ) {
          setSession({
            kbId,
            view: {
              ...view,
              page: Math.max(1, Math.ceil(payload.total / PAGE_SIZE)),
            },
          })
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

  const totalPages = catalog
    ? Math.max(1, Math.ceil(catalog.total / PAGE_SIZE))
    : 1
  const setViewPage = (page: number) =>
    view &&
    setSession({
      kbId: kbId ?? "",
      view: { ...view, page: Math.min(Math.max(1, page), totalPages) },
    })
  const setFilter = (patch: Partial<DocumentCatalogView>) =>
    view &&
    setSession({ kbId: kbId ?? "", view: { ...view, ...patch, page: 1 } })

  return (
    <PanelDialog
      open={open && Boolean(kbId)}
      onClose={onClose}
      titleId="documents-title"
      title={`文档目录${knowledgeBase ? ` · ${knowledgeBase.name}` : ""}`}
      className="sm:max-w-3xl"
    >
      <div className="flex h-12 flex-none items-center justify-end gap-1.5 border-b border-line px-5 max-md:px-4">
        <UiButton
          variant="outline"
          size="sm"
          type="button"
          onClick={() => setWikiOpen(true)}
          title="浏览 Wiki 页面"
          className="inline-flex h-7 items-center gap-1 px-2"
        >
          <Icon data-icon="inline-start" icon={NotebookPen} />
          Wiki
        </UiButton>
        {canAdmin ? (
          <UiButton
            variant="outline"
            size="sm"
            type="button"
            onClick={() => setSyncOpen(true)}
            title="管理同步数据源"
            className="inline-flex h-7 items-center gap-1 px-2"
          >
            <Icon data-icon="inline-start" icon={RefreshCw} />
            同步
          </UiButton>
        ) : null}
      </div>
      {/* Ticket 38 (WIKI-01): the per-knowledge-base Wiki workshop. */}
      <WikiDialog
        open={wikiOpen}
        knowledgeBase={knowledgeBase}
        canAdmin={canAdmin}
        onClose={() => setWikiOpen(false)}
      />
      {/* Ticket 39 (SYNC-01A): the per-knowledge-base sync data-source panel. */}
      <SyncDialog
        open={syncOpen}
        knowledgeBase={knowledgeBase}
        onClose={() => setSyncOpen(false)}
      />
      <DeleteSourceDialog
        target={deleteTarget}
        busy={busy}
        onClose={() => setDeleteTarget(null)}
        onConfirm={deleteDocument}
      />

      {/* Deleting a directory deletes what is inside it — the one place in this
          panel where a single click retires many documents at once, so the
          count is in the sentence rather than in a tooltip. */}
      <ConfirmDialog
        open={folderToDelete !== null}
        onClose={() => setFolderToDelete(null)}
        title={
          folderToDelete ? `删除分类「${folderToDelete.name}」` : "删除文档分类"
        }
        titleId="documents-folder-delete-title"
        confirmLabel="确认删除"
        onConfirm={confirmFolderDelete}
        busy={busy}
      >
        <p>
          这个分类下有
          {folderToDelete ? ` ${folderToDelete.documents} ` : " 0 "}
          篇文档。删除分类会同时删除这些文档，它们不再参与检索。
        </p>
        <DangerNote hint="每篇文档各自记录一次删除并交给后台队列清理分块、图谱关系与页索引节点，命令返回只代表已排队。版本记录和删除墓碑保留，历史回答里的引用仍可追溯。">
          此操作不可恢复。要留下这些文档的话请点取消。
        </DangerNote>
      </ConfirmDialog>

      {/* Filters. Each Select is sized by its own wrapper rather than by a
          `wrapperClassName="flex-none"`: the component's base `flex-1` would
          otherwise fight it at equal specificity (cn is a plain join). */}
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-line px-5 py-3 max-md:px-4">
        <div className="w-32 flex-none">
          <Select
            size="sm"
            aria-label="按处理状态筛选"
            value={view?.status ?? ""}
            onChange={(event) => setFilter({ status: event.target.value })}
          >
            <option value="">全部状态</option>
            <option value="pending">处理中</option>
            <option value="completed">已完成</option>
            <option value="failed">失败</option>
            <option value="cancelled">已取消</option>
          </Select>
        </div>
        <div className="w-32 flex-none">
          <Select
            size="sm"
            aria-label="按标签筛选"
            value={view?.tag ?? ""}
            onChange={(event) => setFilter({ tag: event.target.value })}
          >
            <option value="">全部标签</option>
            {(catalog?.tags ?? []).map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-32 flex-none">
          {editingFolder ? (
            <Input
              autoFocus
              aria-label={
                renamingFolder
                  ? `重命名分类「${renamingFolder}」`
                  : "新分类名称"
              }
              value={folderDraft}
              disabled={busy}
              onChange={(event) => setFolderDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  saveFolderDraft()
                } else if (event.key === "Escape") {
                  stopFolderEditing()
                }
              }}
              placeholder={renamingFolder ? "新名称" : "输入分类名"}
              className="h-8 w-full border px-2"
            />
          ) : (
            <Select
              size="sm"
              aria-label="按文件夹筛选"
              value={view?.folder ?? ""}
              onChange={(event) => setFilter({ folder: event.target.value })}
            >
              <option value="">全部文件夹</option>
              {folderOptions.map((folder) => (
                <option key={folder} value={folder}>
                  {folder}
                </option>
              ))}
            </Select>
          )}
        </div>
        {canAdmin ? (
          <div className="flex flex-none items-center gap-1">
            {editingFolder ? (
              <>
                <Button
                  size="sm"
                  onClick={saveFolderDraft}
                  disabled={busy || !folderDraft.trim()}
                >
                  保存
                </Button>
                <Button size="sm" onClick={stopFolderEditing} disabled={busy}>
                  取消
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setRenamingFolder(null)
                    setCreatingFolder(true)
                    setFolderDraft("")
                  }}
                >
                  新建分类
                </Button>
                {selectedFolder ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setCreatingFolder(false)
                      setRenamingFolder(selectedFolder.name)
                      setFolderDraft(selectedFolder.name)
                    }}
                  >
                    改名
                  </Button>
                ) : null}
                {selectedFolder ? (
                  <Button
                    size="sm"
                    tone="danger"
                    disabled={busy}
                    onClick={() => setFolderToDelete(selectedFolder)}
                  >
                    删除分类
                  </Button>
                ) : null}
              </>
            )}
          </div>
        ) : null}
        <span className="ml-auto font-mono text-[11px] text-faint/70">
          {catalog ? `${catalog.total} 篇` : ""}
        </span>
      </div>

      {/* List: loading / error / empty / rows */}
      <PanelBody>
        {status === "loading" || status === "idle" ? (
          <InlineMessage>正在加载文档目录…</InlineMessage>
        ) : status === "error" ? (
          <Alert tone="danger" title="发生错误" className="border p-3">

              <p className="text-xs text-danger">文档目录读取失败：{error}</p>
              <UiButton
                variant="ghost"
                size="sm"
                type="button"
                onClick={() =>
                  view && setSession({ kbId: kbId ?? "", view: { ...view } })
                }
                className="mt-2 hover:underline"
              >
                重试
              </UiButton>

          </Alert>
        ) : (catalog?.documents.length ?? 0) === 0 ? (
          <InlineMessage>
            {view?.status || view?.tag || view?.folder
              ? "没有符合筛选条件的文档。"
              : "这个知识库还没有文档，先去导入一些吧。"}
          </InlineMessage>
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
                  onView={(target) =>
                    openDocument({ documentId: target.docId })
                  }
                  onDelete={setDeleteTarget}
                />
              ))}
            </ul>
            {totalPages > 1 ? (
              <div className="mt-4 flex flex-none items-center justify-center gap-3">
                <UiButton
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => setViewPage((view?.page ?? 1) - 1)}
                  disabled={(view?.page ?? 1) <= 1}
                  className="inline-flex h-8 items-center px-3 disabled:opacity-50"
                >
                  上一页
                </UiButton>
                <span className="font-mono text-[11px] text-faint">
                  {view?.page ?? 1} / {totalPages}
                </span>
                <UiButton
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => setViewPage((view?.page ?? 1) + 1)}
                  disabled={(view?.page ?? 1) >= totalPages}
                  className="inline-flex h-8 items-center px-3 disabled:opacity-50"
                >
                  下一页
                </UiButton>
              </div>
            ) : null}
          </>
        )}
      </PanelBody>
    </PanelDialog>
  )
}
