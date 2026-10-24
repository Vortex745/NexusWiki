import { Sidebar as ShadcnSidebar, useSidebar } from "./primitives/sidebar"
import { Button as UiButton } from "@/components/primitives/button"
import { Input } from "@/components/primitives/input"
import { SearchField } from "./arc/search-field/search-field"
import {
  Brain,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  FileText,
  FlaskConical,
  Folder,
  FolderOpen,
  LayoutGrid,
  MessageSquareWarning,
  Minus,
  Moon,
  Network,
  PanelLeft,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Sun,
  Trash2,
  Upload,
  X,
} from "./ui/icons"
import { useEffect, useRef, useState } from "react"
import type { IconProps, SwapIconProps } from "./ui/Icon"

import { useConversation } from "../conversation/useConversation"
import { cn } from "../lib/cn"
import { useAppShell } from "../runtime/AppShellContext"
import {
  assistantStore,
  isDefaultAssistantId,
  useAssistants,
} from "../runtime/assistantStore"
import { conversationStore } from "../conversation/useConversation"
import {
  fetchKnowledgeBaseDocuments,
  importConversations,
  KnowledgeBaseCommandError,
  type DocumentCatalogEntryPayload,
  type KnowledgeBasePayload,
} from "../lib/api"
import { useSlidingHighlight } from "../lib/useSlidingHighlight"
import { knowledgeStore, useKnowledgeBases } from "../runtime/knowledgeStore"
import { useMemoryApi } from "../runtime/MemoryContext"
import { useSignedInSession } from "../runtime/SessionContext"
import { DocumentsDialog } from "./panels/DocumentsDialog"
import { Dialog } from "./ui/Dialog"
import { Button } from "./ui/Controls"
import { GraphBrowseDialog } from "./panels/GraphBrowseDialog"
import { LaboratoryDialog } from "./panels/LaboratoryDialog"
import { Icon, SwapIcon } from "./ui/Icon"

function ThreadRow({
  id,
  title,
  active,
  collapsed,
  index,
  registerRow,
}: {
  id: string
  title: string
  active: boolean
  collapsed: boolean
  index: number
  registerRow: (index: number) => (element: HTMLElement | null) => void
}) {
  return (
    <div
      ref={registerRow(index)}
      className={cn(
        "group/thread relative z-10 flex h-8.5 w-full items-center rounded-[8px] transition-colors",
      )}
    >
      <UiButton
        variant="ghost"
        size="icon-sm"
        type="button"
        title={title}
        aria-current={active ? "page" : undefined}
        onClick={() => conversationStore.switchThread(id)}
        className={cn(
          // pr-9 reserves the hover-only delete button's slot (right-1.5 + size-6)
          // plus a 6px breath so the title never slides under it.
          "min-w-0 flex-1 justify-start overflow-hidden pl-12 pr-9 text-left",
          collapsed && "px-0 text-center",
        )}
      >
        <span className="sidebar-copy block truncate">{title || "新对话"}</span>
      </UiButton>
      {!collapsed ? (
        <UiButton
          variant="destructive"
          size="icon-sm"
          type="button"
          title="删除对话"
          aria-label={`删除对话：${title || "新对话"}`}
          onClick={() => conversationStore.deleteThread(id)}
          className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center opacity-0 group-hover/thread:opacity-100 max-md:opacity-100 focus-visible:opacity-100"
        >
          <Icon data-icon="inline-start" icon={Trash2} />
        </UiButton>
      ) : null}
    </div>
  )
}

function SidebarButton({
  icon,
  label,
  onClick,
  trailing,
  ariaExpanded,
  ariaControls,
  active = false,
  collapsed = false,
}: {
  /** A single glyph, or a state pair to spring between. */
  icon: IconProps["icon"] | SwapIconProps
  label: string
  onClick: () => void
  trailing?: React.ReactNode
  ariaExpanded?: boolean
  ariaControls?: string
  active?: boolean
  collapsed?: boolean
}) {
  return (
    <UiButton
      variant="ghost"
      size="sm"
      type="button"
      onClick={onClick}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      aria-pressed={active || undefined}
      title={collapsed ? label : undefined}
      className={cn(
        "flex h-8.5 w-full items-center gap-2 text-left active:scale-[0.98]",
        collapsed ? "justify-center px-0" : "px-3",
      )}
    >
      {"from" in icon ? (
        <SwapIcon data-icon="inline-start" {...icon} />
      ) : (
        <Icon data-icon="inline-start" icon={icon} />
      )}
      <span className="sidebar-copy min-w-0 truncate">{label}</span>
      <span className="sidebar-copy ml-auto shrink-0">{trailing}</span>
    </UiButton>
  )
}

/** How much of a folder's membership is currently selected. */
type FolderSelection = "none" | "some" | "all"

/**
 * One knowledge base row: the check box, the name, and the two hover-only
 * browsing actions parked in the reserved right gutter. Module-level so the
 * rows keep their identity across renders.
 */
function KnowledgeBaseRow({
  base,
  selected,
  onToggle,
  onBrowseDocs,
  onBrowseGraph,
}: {
  base: KnowledgeBasePayload
  selected: boolean
  onToggle: (id: string) => void
  onBrowseDocs: (base: KnowledgeBasePayload) => void
  onBrowseGraph: (base: KnowledgeBasePayload) => void
}) {
  const { openDocument } = useAppShell()
  const [expanded, setExpanded] = useState(false)
  const [documents, setDocuments] = useState<DocumentCatalogEntryPayload[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleDocuments = async () => {
    if (expanded) {
      setExpanded(false)
      return
    }
    setExpanded(true)
    setLoading(true)
    setError(null)
    try {
      const result = await fetchKnowledgeBaseDocuments(
        base.id,
        { page: 1, status: "", tag: "", folder: "" },
        10,
      )
      setDocuments(result.documents)
      setTotal(result.total)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }
  return (
    <li className="group/kb relative">
      <UiButton
        variant="ghost"
        size="icon-sm"
        type="button"
        onClick={() => void toggleDocuments()}
        aria-expanded={expanded}
        aria-label={`${expanded ? "收起" : "展开"}「${base.name}」的文档`}
        className="absolute left-0 top-1 grid size-6 place-items-center"
      >
        <Icon
          data-icon="inline-start"
          icon={ChevronRight}
          className={cn(" transition-transform", expanded && "rotate-90")}
        />
      </UiButton>
      <UiButton
        variant="ghost"
        size="sm"
        type="button"
        onClick={() => onToggle(base.id)}
        title={selected ? "取消选择（回到默认知识库）" : "选入新对话的检索范围"}
        aria-pressed={selected}
        className={cn(
          // pr-16 keeps the truncate edge clear of the two hover-only
          // action buttons parked at right-1.5/right-8.5.
          "flex h-8.5 w-full items-center justify-start gap-2 pl-6 pr-16 text-left active:scale-[0.98]",
        )}
      >
        <span
          className={cn(
            "grid size-4 flex-none place-items-center rounded-[6px] border transition-colors",
            selected
              ? "border-primary bg-primary text-on-primary"
              : "border-line bg-transparent",
          )}
        >
          {selected ? <Icon data-icon="inline-start" icon={Check} /> : null}
        </span>
        <span className="truncate">{base.name}</span>
      </UiButton>
      <UiButton
        variant="ghost"
        size="icon-sm"
        type="button"
        onClick={() => onBrowseDocs(base)}
        title={`浏览「${base.name}」的文档目录`}
        className="absolute top-1 right-8.5 grid size-6 place-items-center opacity-0 group-hover/kb:opacity-100 max-md:opacity-100 focus-visible:opacity-100"
      >
        <Icon data-icon="inline-start" icon={FileText} />
      </UiButton>
      <UiButton
        variant="ghost"
        size="icon-sm"
        type="button"
        onClick={() => onBrowseGraph(base)}
        title={`浏览「${base.name}」的知识图谱`}
        className="absolute top-1 right-1.5 grid size-6 place-items-center opacity-0 group-hover/kb:opacity-100 max-md:opacity-100 focus-visible:opacity-100"
      >
        <Icon data-icon="inline-start" icon={Network} />
      </UiButton>
      {expanded ? (
        <ul className="ml-5 border-l border-line pl-2 text-[11px] text-muted-foreground">
          {loading ? (
            <li className="py-1">正在读取文档…</li>
          ) : error ? (
            <li className="py-1 text-danger">{error}</li>
          ) : documents.length === 0 ? (
            <li className="py-1">暂无文档</li>
          ) : (
            documents.map((doc) => (
              <li key={doc.docId}>
                <UiButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => openDocument({ documentId: doc.docId })}
                  title={doc.title}
                  className="flex h-7 w-full items-center gap-1.5 px-1 text-left"
                >
                  <Icon
                    data-icon="inline-start"
                    icon={FileText}
                    className=" flex-none"
                  />
                  <span className="min-w-0 truncate">
                    {doc.title || doc.fileName || doc.docId}
                  </span>
                </UiButton>
              </li>
            ))
          )}
          {total > documents.length ? (
            <li>
              <UiButton
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => onBrowseDocs(base)}
                className="py-1 hover:underline"
              >
                查看全部 {total} 篇
              </UiButton>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  )
}

/**
 * One folder row: a tri-state check that acts on its whole membership, plus a
 * separate chevron that only folds the children.
 *
 * `role="checkbox"` + `aria-checked="mixed"` rather than the `aria-pressed` the
 * base rows use: pressed/toggled cannot express "some of these", and a folder
 * that silently reads as un-pressed while two of its five bases are selected
 * would be a lie to a screen reader.
 */
/**
 * A 404 on a folder command means the row acted on no longer exists server-side
 * (the database was rebuilt under this session, or another tab deleted it). The
 * store re-reads the taxonomy after any failure, so the ghost row disappears on
 * its own — say that rather than echoing the server's id-level string.
 */
function folderCommandFailure(error: unknown, fallback: string): string {
  if (error instanceof KnowledgeBaseCommandError && error.status === 404) {
    return "这个分类已经不存在了，列表已重新读取"
  }
  return error instanceof Error && error.message ? error.message : fallback
}

function FolderRow({
  name,
  memberCount,
  selection,
  open,
  canManage,
  onToggleSelection,
  onToggleOpen,
  onRename,
  onDelete,
}: {
  name: string
  memberCount: number
  selection: FolderSelection
  open: boolean
  canManage: boolean
  onToggleSelection: () => void
  onToggleOpen: () => void
  onRename: (name: string) => Promise<void> | void
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const [busy, setBusy] = useState(false)

  const commit = async () => {
    const next = draft.trim()
    if (!next || next === name) {
      setEditing(false)
      setDraft(name)
      return
    }
    setBusy(true)
    try {
      await onRename(next)
      setEditing(false)
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    // A separate row rather than an input inside the checkbox button: nesting a
    // control in a control is not addressable, and the browser repairs it in
    // ways that silently break the click targets.
    return (
      <li className="flex h-8.5 items-center gap-1 rounded-full pr-1">
        <Input
          autoFocus
          aria-label={`重命名分类「${name}」`}
          value={draft}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              void commit()
            } else if (event.key === "Escape") {
              setDraft(name)
              setEditing(false)
            }
          }}
          className="h-7 min-w-0 flex-1 border px-2"
        />
        <UiButton
          variant="ghost"
          size="icon-sm"
          type="button"
          onClick={() => void commit()}
          disabled={busy || !draft.trim()}
          title="保存名称（Enter）"
          className="grid size-6 flex-none place-items-center disabled:opacity-50"
        >
          <Icon data-icon="inline-start" icon={Check} />
        </UiButton>
        <UiButton
          variant="ghost"
          size="icon-sm"
          type="button"
          onClick={() => {
            setDraft(name)
            setEditing(false)
          }}
          disabled={busy}
          title="取消（Esc）"
          className="grid size-6 flex-none place-items-center disabled:opacity-50"
        >
          <Icon data-icon="inline-start" icon={X} />
        </UiButton>
      </li>
    )
  }

  return (
    <li className="group/folder relative flex h-8.5 items-center gap-0.5 rounded-full pr-1 transition-colors hover:bg-surface-subtle">
      <UiButton
        variant="ghost"
        size="icon-sm"
        type="button"
        onClick={onToggleOpen}
        aria-expanded={open}
        title={open ? `收起「${name}」` : `展开「${name}」`}
        className="grid size-6 flex-none place-items-center"
      >
        <Icon
          data-icon="inline-start"
          icon={ChevronRight}
          className={cn(
            " transition-transform duration-200",
            open && "rotate-90",
          )}
        />
      </UiButton>
      <UiButton
        variant="ghost"
        size="sm"
        type="button"
        role="checkbox"
        aria-checked={
          selection === "all" ? true : selection === "some" ? "mixed" : false
        }
        onClick={onToggleSelection}
        disabled={memberCount === 0}
        title={
          memberCount === 0
            ? "这个分类还没有知识库"
            : selection === "all"
              ? "取消该分类下的全部知识库"
              : "选中该分类下的全部知识库"
        }
        className={cn(
          // pr-16 keeps the truncate edge clear of the two hover-only actions
          // parked at right-1.5/right-8.5, exactly as the base rows do.
          "flex min-w-0 flex-1 items-center justify-start gap-2 py-1",
          canManage ? "pr-16" : "pr-2",
        )}
      >
        <span
          className={cn(
            "grid size-4 flex-none place-items-center rounded-[6px] border transition-colors",
            selection === "none"
              ? "border-line bg-transparent"
              : "border-primary bg-primary text-on-primary",
          )}
        >
          {selection === "all" ? (
            <Icon data-icon="inline-start" icon={Check} />
          ) : selection === "some" ? (
            <Icon data-icon="inline-start" icon={Minus} />
          ) : null}
        </span>
        <Icon
          data-icon="inline-start"
          icon={open ? FolderOpen : Folder}
          className=" flex-none opacity-70"
        />
        <span className="truncate">{name}</span>
        <span className="ml-auto flex-none font-mono text-[10px] text-muted-foreground/70">
          {memberCount}
        </span>
      </UiButton>
      {canManage ? (
        <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center opacity-0 transition-opacity group-hover/folder:opacity-100 focus-within:opacity-100 max-md:opacity-100">
          <UiButton
            variant="ghost"
            size="icon-sm"
            type="button"
            onClick={() => {
              setDraft(name)
              setEditing(true)
            }}
            title={`重命名分类「${name}」`}
            aria-label={`重命名分类「${name}」`}
            className="grid size-6 place-items-center"
          >
            <Icon data-icon="inline-start" icon={Pencil} />
          </UiButton>
          <UiButton
            variant="destructive"
            size="icon-sm"
            type="button"
            onClick={onDelete}
            title={`删除分类「${name}」（其中的知识库回到未分类，不会被删除）`}
            aria-label={`删除分类「${name}」`}
            className="grid size-6 place-items-center"
          >
            <Icon data-icon="inline-start" icon={Trash2} />
          </UiButton>
        </div>
      ) : null}
    </li>
  )
}

/**
 * Ticket 08 (KB-04): the workspace knowledge-base selector. Browsing is for
 * every signed-in member; the list shows ACTIVE bases only (archived ones are
 * the admin dialog's concern). An empty selection means the server default —
 * a selection can only ever NARROW the chat's knowledge scope, and the server
 * validates every id against the session's tenant regardless.
 *
 * Bases are grouped under the tenant's folders. A folder is a selection
 * shortcut and nothing more: checking one writes its current members into the
 * per-base selection, so the chat request still carries only knowledge-base ids
 * and no folder id ever reaches the retrieval layer as a scope.
 */
function KnowledgeSelector() {
  const { showToast } = useAppShell()
  const {
    status,
    activeKnowledgeBases: bases,
    folders,
    selectedIds,
    collapsed,
    error,
  } = useKnowledgeBases()
  // Ticket 11 (DOC-01A): browsing a base's document catalog is for every
  // signed-in member — the server applies the tenant/group/kb scoping.
  const [browsingDocs, setBrowsingDocs] = useState<{
    id: string
    name: string
  } | null>(null)
  // Ticket 37 (GRAPH-01): browsing a base's knowledge-scoped graph relations
  // is for every signed-in member — the server authorizes every relation and
  // every provenance record.
  const [browsingGraph, setBrowsingGraph] = useState<{
    id: string
    name: string
  } | null>(null)
  // A folder starts open exactly when it is already doing something (it holds a
  // selected base); an explicit click then wins. Deriving the default instead of
  // seeding it keeps the async list load from needing an effect.
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({})
  // Filing knowledge bases into directories is the same admin door the bases
  // themselves sit behind; deleting one only releases its members, so the
  // confirm is a guard against a mis-click rather than a data-loss warning.
  const canManageFolders =
    useSignedInSession()?.scopes.includes("admin") ?? false
  const [newFolderName, setNewFolderName] = useState("")
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [folderToDelete, setFolderToDelete] = useState<{
    id: string
    name: string
  } | null>(null)

  const createKbFolder = async () => {
    const name = newFolderName.trim()
    if (!name) return
    setCreatingFolder(true)
    try {
      await knowledgeStore.createFolder(name)
      setNewFolderName("")
      showToast(`已创建知识库分类「${name}」`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : "分类创建失败")
    } finally {
      setCreatingFolder(false)
    }
  }

  const membersOf = (folderId: string) =>
    bases.filter((base) => base.folderId === folderId)
  // A base whose folder is not in the rendered list must still be reachable —
  // every visible base appears in exactly one group.
  const knownFolders = new Set(folders.map((folder) => folder.id))
  const ungrouped = bases.filter(
    (base) => base.folderId === null || !knownFolders.has(base.folderId),
  )
  const selectionOf = (ids: readonly string[]): FolderSelection => {
    const hit = ids.filter((id) => selectedIds.includes(id)).length
    if (hit === 0) return "none"
    return hit === ids.length ? "all" : "some"
  }

  return (
    <div className="mt-4">
      <UiButton
        variant="ghost"
        size="sm"
        type="button"
        onClick={() => knowledgeStore.toggleCollapsed()}
        aria-expanded={!collapsed}
        aria-controls="knowledge-base-tree"
        title={collapsed ? "展开知识库" : "折叠知识库"}
        className={cn(
          // The button's 1px border has to be paid for, or this label lands
          // 1px right of the static 助手 / 最近对话 labels next to it.
          "flex h-7 w-full items-center justify-between pl-[3px] pr-1 text-left",
        )}
      >
        <span>知识库</span>
        <Icon
          data-icon="inline-end"
          icon={ChevronDown}
          className={cn(
            " transition-transform duration-200",
            !collapsed && "rotate-180",
          )}
        />
      </UiButton>
      <div
        id="knowledge-base-tree"
        className="sidebar-disclosure"
        data-open={collapsed ? "false" : "true"}
        inert={collapsed}
      >
        <div>
          {status === "loading" || (status === "idle" && bases.length === 0) ? (
            <p className="px-3 py-2 text-xs text-muted-foreground/70">
              正在加载知识库…
            </p>
          ) : status === "error" ? (
            <div className="px-3 py-2">
              <p className="text-xs text-danger">知识库读取失败：{error}</p>
              <UiButton
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => void knowledgeStore.refresh()}
                className="mt-1 hover:underline"
              >
                重试
              </UiButton>
            </div>
          ) : bases.length === 0 && folders.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground/70">
              暂无可用知识库
            </p>
          ) : (
            <>
              {folders.map((folder) => {
                const members = membersOf(folder.id)
                const open =
                  openFolders[folder.id] ??
                  members.some((base) => selectedIds.includes(base.id))
                return (
                  <div key={folder.id} className="mt-0.5">
                    <FolderRow
                      name={folder.name}
                      memberCount={members.length}
                      selection={selectionOf(members.map((base) => base.id))}
                      open={open}
                      onToggleSelection={() => {
                        knowledgeStore.toggleFolder(folder.id)
                        showToast(
                          selectionOf(members.map((base) => base.id)) === "all"
                            ? `已取消知识库分类「${folder.name}」`
                            : `已载入知识库分类「${folder.name}」`,
                        )
                      }}
                      onToggleOpen={() =>
                        setOpenFolders((current) => ({
                          ...current,
                          [folder.id]: !open,
                        }))
                      }
                      canManage={canManageFolders}
                      onRename={async (next) => {
                        try {
                          await knowledgeStore.renameFolder(folder.id, next)
                          showToast(`已重命名知识库分类「${next}」`)
                        } catch (error) {
                          showToast(folderCommandFailure(error, "重命名失败"))
                        }
                      }}
                      onDelete={() =>
                        setFolderToDelete({ id: folder.id, name: folder.name })
                      }
                    />
                    <div
                      className="sidebar-folder-tree"
                      data-open={open}
                      inert={!open}
                    >
                      <div>
                        <ul className="ml-4 mt-0.5 flex flex-col gap-0.5 border-l border-line pl-1">
                          {members.length === 0 ? (
                            <li className="px-2 py-1 text-[11px] text-muted-foreground">
                              暂无知识库
                            </li>
                          ) : null}
                          {members.map((base) => (
                            <KnowledgeBaseRow
                              key={base.id}
                              base={base}
                              selected={selectedIds.includes(base.id)}
                              onToggle={(id) => {
                                knowledgeStore.toggleSelected(id)
                                showToast(
                                  selectedIds.includes(id)
                                    ? `已取消知识库「${base.name}」`
                                    : `已载入知识库「${base.name}」`,
                                )
                              }}
                              onBrowseDocs={(target) =>
                                setBrowsingDocs({
                                  id: target.id,
                                  name: target.name,
                                })
                              }
                              onBrowseGraph={(target) =>
                                setBrowsingGraph({
                                  id: target.id,
                                  name: target.name,
                                })
                              }
                            />
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                )
              })}
              {canManageFolders ? (
                <div className="mt-1 flex items-center gap-1 px-1">
                  <Input
                    aria-label="新知识库分类名称"
                    value={newFolderName}
                    disabled={creatingFolder}
                    onChange={(event) => setNewFolderName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault()
                        void createKbFolder()
                      }
                    }}
                    placeholder="新分类名称"
                    className="h-7 min-w-0 flex-1 border px-2"
                  />
                  <UiButton
                    variant="ghost"
                    size="icon-sm"
                    type="button"
                    onClick={() => void createKbFolder()}
                    disabled={creatingFolder || !newFolderName.trim()}
                    title="创建知识库分类"
                    aria-label="创建知识库分类"
                    className="grid size-6 flex-none place-items-center disabled:opacity-50"
                  >
                    <Icon data-icon="inline-start" icon={Plus} />
                  </UiButton>
                </div>
              ) : null}
              {ungrouped.length > 0 ? (
                <>
                  {folders.length > 0 ? (
                    <p className="px-3 pt-1.5 text-[10px] text-muted-foreground/60">
                      未分类
                    </p>
                  ) : null}
                  <ul className="mt-0.5 flex flex-col gap-0.5">
                    {ungrouped.map((base) => (
                      <KnowledgeBaseRow
                        key={base.id}
                        base={base}
                        selected={selectedIds.includes(base.id)}
                        onToggle={(id) => {
                          knowledgeStore.toggleSelected(id)
                          showToast(
                            selectedIds.includes(id)
                              ? `已取消知识库「${base.name}」`
                              : `已载入知识库「${base.name}」`,
                          )
                        }}
                        onBrowseDocs={(target) =>
                          setBrowsingDocs({ id: target.id, name: target.name })
                        }
                        onBrowseGraph={(target) =>
                          setBrowsingGraph({ id: target.id, name: target.name })
                        }
                      />
                    ))}
                  </ul>
                </>
              ) : null}
            </>
          )}
          <p className="px-3 pt-1 text-[10px] leading-relaxed text-muted-foreground/60">
            {selectedIds.length > 0
              ? `新对话将检索选中的 ${selectedIds.length} 个知识库`
              : "未选择时检索默认知识库"}
          </p>
        </div>
      </div>
      <DocumentsDialog
        open={browsingDocs !== null}
        knowledgeBase={browsingDocs}
        onClose={() => setBrowsingDocs(null)}
      />
      {/* Ticket 37 (GRAPH-01): the knowledge-scoped graph browse panel. */}
      <GraphBrowseDialog
        open={browsingGraph !== null}
        knowledgeBase={browsingGraph}
        onClose={() => setBrowsingGraph(null)}
      />
      <Dialog
        open={folderToDelete !== null}
        onClose={() => setFolderToDelete(null)}
        title={
          folderToDelete
            ? `删除分类「${folderToDelete.name}」`
            : "删除知识库分类"
        }
        titleId="sidebar-kb-folder-delete-title"
        icon={Trash2}
        tier="confirm"
      >
        <div className="flex flex-col gap-2 text-xs leading-relaxed text-muted-foreground">
          <p>
            这个分类下有
            {folderToDelete
              ? ` ${membersOf(folderToDelete.id).length} `
              : " 0 "}
            个知识库。删除分类只解除归组：知识库本身、它们的内容和已选检索范围都不受影响，只是回到未分类。
          </p>
          <p>要连文档一起删的是知识库本身或文档分类，这里不会碰它们。</p>
        </div>
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={() => setFolderToDelete(null)}>
            取消
          </Button>
          <Button
            size="sm"
            tone="danger"
            disabled={folderToDelete === null}
            onClick={async () => {
              if (!folderToDelete) return
              const target = folderToDelete
              try {
                await knowledgeStore.deleteFolder(target.id)
                showToast(`已删除知识库分类「${target.name}」`)
              } catch (error) {
                showToast(folderCommandFailure(error, "分类删除失败"))
              } finally {
                setFolderToDelete(null)
              }
            }}
          >
            确认删除
          </Button>
        </div>
      </Dialog>
    </div>
  )
}

interface SidebarProps {
  open: boolean
  collapsed: boolean
  isDark: boolean
  onToggleTheme: () => void
  onCloseMobile: () => void
}

/**
 * Ticket 19 (AST-01B): the assistant selector. One assistant runs each new
 * chat; the server resolves prompt/scope/tool/rerank from its stored version.
 * Empty selection = the legacy default path. The list shows the server-side
 * group-visible assistants for this session's role.
 */
function AssistantSelector() {
  const { status, assistants, selectedId, error } = useAssistants()
  const { showToast } = useAppShell()
  const [hovered, setHovered] = useState<number | null>(null)
  const [focused, setFocused] = useState<number | null>(null)
  useEffect(() => {
    assistantStore.ensureLoaded()
  }, [])
  // The default entry is row 0 so the highlight has one index space to work in;
  // it used to be a hand-copied `<li>` above the mapped ones. The server-seeded
  // default assistant (assistant-default-*) IS that entry — it runs the same
  // legacy path as the null selection, so mapping it again would paint a second
  // 默认助手 row. Admin curation (sidebar-visible flag) hides unchecked
  // assistants; a payload without the flag still shows, matching the
  // pre-column behavior.
  const rows: { id: string | null; name: string }[] = [
    { id: null, name: "默认助手" },
    ...assistants
      .filter(
        (assistant) =>
          assistant.status === "active" &&
          assistant.sidebarVisible !== false &&
          !isDefaultAssistantId(assistant.id),
      )
      .map((assistant) => ({ id: assistant.id, name: assistant.name })),
  ]
  const selectedIndex = rows.findIndex((row) => row.id === selectedId)
  const { registerRow, box } = useSlidingHighlight(
    hovered ?? focused ?? (selectedIndex >= 0 ? selectedIndex : null),
  )
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between px-1 text-[11px] font-semibold text-muted-foreground">
        <span>助手</span>
      </div>
      {status === "loading" ||
      (status === "idle" && assistants.length === 0) ? (
        <p className="px-3 py-2 text-xs text-muted-foreground/70">
          正在加载助手…
        </p>
      ) : status === "error" ? (
        <p className="px-3 py-2 text-xs text-danger">助手读取失败</p>
      ) : (
        <ul
          className="relative mt-1 flex flex-col gap-0.5"
          onPointerLeave={() => setHovered(null)}
        >
          {/* Sits behind the row text (`inset-x-0` before `relative z-10` rows) and
              travels instead of each row repainting its own fill. It only shows once
              the pointer or the keyboard is actually on the list; at rest it parks on
              the selected row so the first appearance never slides in from the top. */}
          <span
            aria-hidden
            className="t-row-glider pointer-events-none absolute inset-x-0 rounded-full bg-surface-subtle"
            style={{
              top: box?.top ?? 0,
              height: box?.height ?? 0,
              opacity: box && (hovered !== null || focused !== null) ? 1 : 0,
              transition: `top 220ms var(--ease-out), height 220ms var(--ease-out), opacity 150ms var(--ease-out)`,
            }}
          />
          {rows.map((row, index) => {
            const selected = row.id === selectedId
            return (
              <li key={row.id ?? "default"}>
                <UiButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  ref={registerRow(index)}
                  onClick={() => {
                    // Re-clicking the active row is a no-op — no toast noise.
                    if (row.id === selectedId) return
                    assistantStore.select(row.id)
                    showToast(
                      row.id === null
                        ? "已切换到默认助手"
                        : `已切换到「${row.name}」`,
                    )
                  }}
                  onPointerEnter={() => setHovered(index)}
                  onFocus={() => setFocused(index)}
                  onBlur={() =>
                    setFocused((current) =>
                      current === index ? null : current,
                    )
                  }
                  title={
                    row.id === null
                      ? "使用默认助手（不加任何额外设定）"
                      : `新对话将由「${row.name}」接答`
                  }
                  aria-pressed={selected}
                  className={cn(
                    "relative z-10 flex h-8.5 w-full items-center justify-start gap-2 pl-6 pr-3 text-left active:scale-[0.98]",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-4 flex-none place-items-center rounded-full border transition-colors",
                      selected
                        ? "border-primary"
                        : "border-line bg-transparent",
                    )}
                  >
                    {selected ? (
                      <span className="size-2 rounded-full bg-primary" />
                    ) : null}
                  </span>
                  <span className="truncate">{row.name}</span>
                </UiButton>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * Ticket 20 (CONV-01A): one-time import of the browser-local threads into the
 * server-owned directory. Idempotent by thread id (a repeat only skips), and
 * the browser's local storage is NEVER cleared — the flag only hides the
 * button, the data stays.
 */
function ImportHistoryButton() {
  const { showToast } = useAppShell()
  const [importing, setImporting] = useState(false)
  const [imported, setImported] = useState(() => {
    try {
      return (
        window.localStorage.getItem("nexusrag.conversations.imported") === "1"
      )
    } catch {
      return false
    }
  })
  if (imported) return null
  const handleImport = async () => {
    setImporting(true)
    try {
      const result = await importConversations(
        conversationStore.exportThreads(),
      )
      try {
        window.localStorage.setItem("nexusrag.conversations.imported", "1")
      } catch {
        // Storage unavailable — the button simply reappears next load.
      }
      setImported(true)
      showToast(
        `已导入 ${result.imported} 个对话${result.skipped > 0 ? `，跳过 ${result.skipped} 个已存在` : ""}`,
      )
    } catch (error) {
      showToast(error instanceof Error ? error.message : "导入失败")
    } finally {
      setImporting(false)
    }
  }
  return (
    <UiButton
      variant="ghost"
      size="sm"
      type="button"
      onClick={() => void handleImport()}
      disabled={importing}
      title="把浏览器里的本地对话导入服务器（只上传，不清除本地）"
      className="px-2 py-0.5 normal-case tracking-normal disabled:opacity-50"
    >
      {importing ? "导入中…" : "导入历史"}
    </UiButton>
  )
}

/**
 * A row inside the workspace panel. Deliberately not SidebarButton: that one
 * hard-codes h-8.5 / rounded-[8px] / px-3, and `cn` here is a plain join with no
 * tailwind-merge, so appending `h-8` after `h-8.5` would lose to Tailwind's
 * ascending source order rather than override it.
 */
function WorkspaceItem({
  icon,
  label,
  hint,
  onClick,
  trailing,
  disabledReason,
}: {
  icon: IconProps["icon"]
  label: string
  hint: string
  onClick: () => void
  /** Optional right-aligned marker — the import entry's 导入中 N badge. */
  trailing?: React.ReactNode
  disabledReason?: string
}) {
  return (
    <UiButton
      variant="ghost"
      size="sm"
      type="button"
      disabled={Boolean(disabledReason)}
      onClick={disabledReason ? undefined : onClick}
      title={disabledReason ? hint + "（" + disabledReason + "）" : hint}
      className="flex h-8 w-full items-center justify-start gap-2.5 px-2.5 text-left active:scale-[0.98]"
    >
      <Icon data-icon="inline-start" icon={icon} />
      <span className="min-w-0 truncate">{label}</span>
      {disabledReason ? (
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          {disabledReason}
        </span>
      ) : trailing}
    </UiButton>
  )
}

/** One raised block in the recessed panel; the shared `aria-labelledby` target. */
function WorkspaceSection({
  id,
  title,
  children,
}: {
  id: string
  title: string
  children: React.ReactNode
}) {
  return (
    <div
      role="group"
      aria-labelledby={id}
      className="workspace-section rounded-[14px] bg-surface p-0.5"
    >
      <p
        id={id}
        className="px-3.5 pt-1.5 pb-0.5 text-[10px] font-medium leading-4 text-muted-foreground"
      >
        {title}
      </p>
      {children}
    </div>
  )
}

/**
 * Keep the chat workspace quiet by grouping secondary tools behind one entry.
 * Keep all tools discoverable; server scopes decide which rows are enabled.
 * The actions themselves stay in their existing dialogs.
 */
function WorkspaceMenu({ collapsed = false }: { collapsed?: boolean }) {
  const {
    openImport,
    openEvaluation,
    openFeedback,
    openFaqs,
    activeImportCount,
  } = useAppShell()
  const scopes = useSignedInSession()?.scopes ?? []
  const canIngest = scopes.includes("ingest")
  const canAdmin = scopes.includes("admin")
  const [expanded, setExpanded] = useState(false)
  const [laboratoryOpen, setLaboratoryOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // The panel is inline, so it only goes away when someone asks for the chat
  // back: clicking outside it, or Escape.
  useEffect(() => {
    if (!expanded) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setExpanded(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [expanded])

  const openModule = (action: () => void) => {
    rootRef.current?.querySelector<HTMLButtonElement>("button")?.focus()
    setExpanded(false)
    action()
  }

  // The rail never shows the panel: its button expands the sidebar instead.
  const panelOpen = expanded && !collapsed

  return (
    <div ref={rootRef} className="flex flex-col">
      <SidebarButton
        icon={LayoutGrid}
        label="工作区"
        collapsed={collapsed}
        ariaExpanded={panelOpen}
        ariaControls="workspace-menu"
        onClick={() => {
          if (collapsed) {
            conversationStore.toggleSidebar()
            return
          }
          setExpanded((previous) => !previous)
        }}
        trailing={
          <Icon
            icon={ChevronDown}
            className={cn(
              "ml-auto size-3.5 transition-transform duration-200",
              expanded && "rotate-180",
            )}
          />
        }
      />
      {/* Stays mounted so the close animates as well as the open; `inert` keeps
          the clipped rows out of the tab order while the track is at 0fr. */}
      <div
        className="sidebar-disclosure"
        data-open={panelOpen ? "true" : "false"}
        inert={!panelOpen}
      >
        <div>
          <div
            id="workspace-menu"
            className="mx-1 flex flex-col gap-1 rounded-[20px] border border-line bg-surface-subtle p-1"
          >
            <WorkspaceSection id="workspace-section-data" title="数据">
              <WorkspaceItem
                icon={Upload}
                label="导入文档"
                hint="上传文件或网页，切分后写入知识库"
                disabledReason={canIngest ? undefined : "需导入权限"}
                onClick={() => openModule(openImport)}
                trailing={
                  activeImportCount > 0 ? (
                    <span
                      aria-label={`导入中 ${activeImportCount} 项`}
                      title={`导入中 ${activeImportCount} 项，点击查看`}
                      className="ml-auto flex-none rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium leading-none text-on-primary"
                    >
                      {activeImportCount}
                    </span>
                  ) : undefined
                }
              />
              <WorkspaceItem
                icon={BookOpen}
                label="标准问答"
                hint="维护版本化 FAQ，逐行导入自动校验"
                disabledReason={canIngest || canAdmin ? undefined : "需维护权限"}
                onClick={() => openModule(openFaqs)}
              />
            </WorkspaceSection>

            <WorkspaceSection id="workspace-section-analysis" title="分析">
              <WorkspaceItem
                icon={FlaskConical}
                label="检索实验室"
                hint="单条查询试跑，对比召回与重排的结果"
                onClick={() => {
                  openModule(() => setLaboratoryOpen(true))
                }}
              />
              <WorkspaceItem
                icon={ClipboardCheck}
                label="运行评测"
                hint="用数据集批量打分，看答案质量的变化"
                disabledReason={canAdmin ? undefined : "需管理员权限"}
                onClick={() => openModule(openEvaluation)}
              />
              <WorkspaceItem
                icon={MessageSquareWarning}
                label="反馈审阅"
                hint="处理用户标记出来的坏答案"
                disabledReason={canAdmin ? undefined : "需管理员权限"}
                onClick={() => openModule(openFeedback)}
              />
            </WorkspaceSection>
          </div>
        </div>
      </div>
      <LaboratoryDialog
        open={laboratoryOpen}
        onClose={() => setLaboratoryOpen(false)}
      />
    </div>
  )
}

export function Sidebar({ collapsed, isDark, onToggleTheme }: SidebarProps) {
  const { toggleSidebar } = useSidebar()
  const { openMemory } = useAppShell()
  const { memories } = useMemoryApi()
  const { threads, activeThreadId } = useConversation()
  const [chatSearchOpen, setChatSearchOpen] = useState(false)
  const [chatQuery, setChatQuery] = useState("")
  const chatSearchInputRef = useRef<HTMLInputElement>(null)

  // Ticket 08 (KB-04): load the knowledge-base list once per sign-in.
  useEffect(() => {
    knowledgeStore.ensureLoaded()
  }, [])

  useEffect(() => {
    if (collapsed) {
      setChatSearchOpen(false)
      setChatQuery("")
    }
  }, [collapsed])

  useEffect(() => {
    if (!chatSearchOpen) return
    const frame = requestAnimationFrame(() =>
      chatSearchInputRef.current?.focus(),
    )
    return () => cancelAnimationFrame(frame)
  }, [chatSearchOpen])

  const visibleThreads = threads.filter((thread) =>
    thread.title.toLowerCase().includes(chatQuery.trim().toLowerCase()),
  )
  const activeThreadIndex = visibleThreads.findIndex(
    (thread) => thread.id === activeThreadId,
  )
  const { registerRow, box } = useSlidingHighlight(
    activeThreadIndex >= 0 ? activeThreadIndex : null,
  )

  return (
    <>
      <ShadcnSidebar collapsible="icon" aria-label="工作区导航">
        <div
          data-collapsed={collapsed ? "true" : "false"}
          className="sidebar-shell flex h-full min-h-0 flex-col overflow-x-hidden px-3 py-3"
        >
          <div className="flex min-h-0 flex-1 flex-col">
            <div
              className={cn(
                "relative mb-2.5 flex h-10 shrink-0 items-center",
                collapsed ? "justify-center" : "justify-between px-1",
              )}
            >
              <div className="sidebar-brand flex min-w-0 items-center gap-2">
                <span className="sidebar-copy text-[13px] font-semibold tracking-tight text-ink">
                  NexusWiki
                </span>
              </div>
              <UiButton
                variant="ghost"
                size="icon-sm"
                type="button"
                aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
                title={collapsed ? "展开侧栏" : "收起侧栏"}
                onClick={toggleSidebar}
                className="grid size-8 place-items-center active:scale-[0.97]"
              >
                <SwapIcon
                  data-icon="inline-start"
                  from={PanelLeftClose}
                  to={PanelLeft}
                  at={collapsed}
                />
              </UiButton>
            </div>

            {/* Primary actions */}
            <div className="sidebar-primary flex flex-col gap-1">
              <UiButton
                variant="ghost"
                size="sm"
                type="button"
                title={collapsed ? "新建对话" : undefined}
                onClick={() => conversationStore.newThread()}
                className={cn(
                  "flex h-9 w-full items-center gap-2 text-left active:scale-[0.98]",
                  collapsed ? "justify-center px-0" : "px-3",
                  "",
                )}
              >
                <Icon data-icon="inline-start" icon={Plus} />
                <span className="sidebar-copy min-w-0 truncate">新建对话</span>
              </UiButton>
              <WorkspaceMenu collapsed={collapsed} />
              <SidebarButton
                icon={{ from: Moon, to: Sun, at: isDark }}
                label={isDark ? "切换浅色模式" : "切换深色模式"}
                onClick={onToggleTheme}
                collapsed={collapsed}
              />
            </div>

            {/* Ticket 08 (KB-04): workspace knowledge-base selector */}
            <div className="sidebar-module">
              <KnowledgeSelector />
            </div>

            {/* Ticket 19 (AST-01B): the assistant selector for new chats */}
            <div className="sidebar-module">
              <AssistantSelector />
            </div>

            {/* Recent chats */}
            <div
              className={cn(
                "sidebar-recent scrollbar-hidden mt-4 min-h-0 flex-1 overflow-x-hidden overflow-y-auto",
                collapsed && "mt-3",
              )}
            >
              <div
                className={cn(
                  "sidebar-search-row relative mb-1 h-8",
                  collapsed && "justify-center",
                )}
              >
                <span className="sidebar-copy sidebar-search-label absolute inset-0 flex items-center px-1 text-[11px] font-semibold text-muted-foreground">
                  最近对话
                </span>
                {!collapsed ? (
                  <div className="absolute inset-y-0 right-0 flex items-center gap-1">
                    {threads.length > 0 ? <ImportHistoryButton /> : null}
                    <UiButton
                      variant="ghost"
                      size="icon-sm"
                      type="button"
                      aria-label={
                        chatSearchOpen ? "关闭历史搜索" : "搜索历史对话"
                      }
                      title={chatSearchOpen ? "关闭历史搜索" : "搜索历史对话"}
                      onClick={() => {
                        setChatSearchOpen((current) => !current)
                        if (chatSearchOpen) setChatQuery("")
                      }}
                      className="grid size-7 place-items-center active:scale-[0.96]"
                    >
                      {chatSearchOpen ? (
                        <Icon data-icon="inline-start" icon={X} />
                      ) : (
                        <Icon data-icon="inline-start" icon={Search} />
                      )}
                    </UiButton>
                  </div>
                ) : (
                  <UiButton
                    variant="ghost"
                    size="sm"
                    type="button"
                    aria-label="展开侧栏并搜索历史对话"
                    title="展开侧栏并搜索历史对话"
                    onClick={() => {
                      conversationStore.toggleSidebar()
                      setChatSearchOpen(true)
                    }}
                    className="absolute inset-0 grid place-items-center active:scale-[0.96]"
                  >
                    <Icon data-icon="inline-start" icon={Search} />
                  </UiButton>
                )}
                <div
                  className={cn(
                    "sidebar-search-field absolute inset-y-0 right-0 flex items-center gap-1.5 rounded-[8px] bg-surface-subtle px-2 text-muted-foreground",
                    chatSearchOpen && "sidebar-search-field-open",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <SearchField
                      ref={chatSearchInputRef}
                      value={chatQuery}
                      onValueChange={setChatQuery}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          setChatSearchOpen(false)
                          setChatQuery("")
                        }
                      }}
                      placeholder="搜索对话"
                      aria-label="搜索历史对话"
                      clearLabel="清空历史搜索"
                      tabIndex={chatSearchOpen && !collapsed ? 0 : -1}
                    />
                  </div>
                  <UiButton
                    variant="ghost"
                    size="icon-sm"
                    type="button"
                    aria-label="关闭历史搜索"
                    tabIndex={chatSearchOpen && !collapsed ? 0 : -1}
                    onClick={() => {
                      setChatSearchOpen(false)
                      setChatQuery("")
                    }}
                    className="grid size-6 shrink-0 place-items-center"
                  >
                    <Icon data-icon="inline-start" icon={X} />
                  </UiButton>
                </div>
              </div>
              <div className="relative flex flex-col gap-0.5">
                <span
                  aria-hidden
                  className="t-row-glider pointer-events-none absolute inset-x-0 rounded-[8px] bg-surface-subtle"
                  style={{
                    top: box?.top ?? 0,
                    height: box?.height ?? 0,
                    opacity: box ? 1 : 0,
                    transition:
                      "top 220ms var(--ease-out), height 220ms var(--ease-out), opacity 150ms var(--ease-out)",
                  }}
                />
                {visibleThreads.length === 0 ? (
                  <p className="sidebar-copy px-2.5 py-2 text-xs text-muted-foreground/70">
                    {chatQuery ? "没有匹配的对话" : "暂无历史对话"}
                  </p>
                ) : collapsed ? null : (
                  visibleThreads.map((thread, index) => (
                    <ThreadRow
                      key={thread.id}
                      id={thread.id}
                      title={thread.title}
                      active={thread.id === activeThreadId}
                      collapsed={collapsed}
                      index={index}
                      registerRow={registerRow}
                    />
                  ))
                )}
              </div>
            </div>

            {/* Utility zone */}
            <div className="mt-3 flex flex-col gap-1 border-t border-line pt-2">
              <UiButton
                variant="ghost"
                size="sm"
                type="button"
                onClick={openMemory}
                title="查看并管理会话记忆"
                className={cn(
                  "flex h-8.5 w-full items-center px-3",
                  collapsed ? "justify-center px-0" : "justify-between",
                )}
              >
                <div className="flex items-center gap-2">
                  <Icon
                    data-icon="inline-start"
                    icon={Brain}
                    className=" text-muted-foreground"
                  />
                  <span className="sidebar-copy min-w-0 truncate">
                    上下文记忆
                  </span>
                </div>
                <span className="sidebar-copy rounded-full border border-line bg-surface-subtle px-2 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
                  {memories.length} 条
                </span>
              </UiButton>
            </div>
          </div>
        </div>
      </ShadcnSidebar>
    </>
  )
}
