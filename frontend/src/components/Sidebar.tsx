import { SidebarShell as ShadcnSidebar, useSidebar } from "./ui/sidebar-shell"
import { Button as ArcButton } from "./arc/button/button"
import { Checkbox } from "./arc/checkbox/checkbox"
import { RadioGroup } from "./arc/radio-group/radio-group"
import { ThemeSwitch } from "./arc/theme-switch/theme-switch"
import { Button as UiButton } from "@/components/ui/Button"
import { Input } from "@/components/arc/input/input"
import { ExpandingSearch } from "./arc/expanding-search/expanding-search"
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  LayoutGrid,
  MessageSquareWarning,
  Minus,
  Network,
  PanelLeft,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from "./ui/icons"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
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
import { useSession, useSignedInSession } from "../runtime/SessionContext"
import { UserMenu } from "./arc/user-menu/user-menu"
import { DocumentsDialog } from "./panels/DocumentsDialog"
import { ConfirmDialog } from "./ui/Dialog"
import { Button } from "./ui/Controls"
import { GraphBrowseDialog } from "./panels/GraphBrowseDialog"
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
      {/* A plain button, not the Arc one: its label slot centres the text, so
          short titles drift to the middle and long ones overflow instead of
          ellipsizing. pr-11 keeps the title 14px clear of the hover-only
          delete button (right-1.5 + size-6) and truncates right there. */}
      <button
        type="button"
        title={title || "新对话"}
        aria-current={active ? "page" : undefined}
        onClick={() => conversationStore.switchThread(id)}
        className={cn(
          "flex h-7 min-w-0 flex-1 items-center overflow-hidden rounded-[8px] pr-11 pl-3 text-left text-[0.8rem] font-medium leading-[1.4] text-[color:var(--text-secondary)] transition-colors hover:bg-surface-muted hover:text-ink active:bg-surface-muted active:text-ink",
          collapsed && "justify-center px-0 text-center",
        )}
      >
        <span className="sidebar-copy block min-w-0 truncate">
          {title || "新对话"}
        </span>
      </button>
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
  variant = "ghost",
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
  variant?: "primary" | "secondary" | "ghost" | "danger"
}) {
  return (
    <div className="relative w-full">
      <ArcButton
        variant={variant}
        size="sm"
        type="button"
        onClick={onClick}
        aria-expanded={ariaExpanded}
        aria-controls={ariaControls}
        aria-pressed={active || undefined}
        title={collapsed ? label : undefined}
        className={cn(
          "w-full text-left",
          collapsed ? "justify-center px-0" : "justify-start",
          !collapsed && trailing ? "pr-9" : "",
        )}
      >
        {"from" in icon ? (
          <SwapIcon data-icon="inline-start" {...icon} />
        ) : (
          <Icon data-icon="inline-start" icon={icon} />
        )}
        <span className="sidebar-copy min-w-0 truncate">{label}</span>
      </ArcButton>
      {trailing && !collapsed ? (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
          {trailing}
        </span>
      ) : null}
    </div>
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
      // This tree is the knowledge the base can actually answer from: a failed
      // or unactivated upload owns no active version and must not appear.
      const result = await fetchKnowledgeBaseDocuments(
        base.id,
        { page: 1, status: "", tag: "", folder: "", active: true },
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
  const selectId = `kb-select-${base.id}`
  const nameId = `kb-name-${base.id}`
  return (
    <li className="group/kb relative">
      <div className="flex min-h-8.5 items-center gap-1.5 pr-16">
        <UiButton
          variant="ghost"
          size="icon-sm"
          type="button"
          onClick={() => void toggleDocuments()}
          aria-expanded={expanded}
          aria-controls={`kb-docs-${base.id}`}
          aria-label={`${expanded ? "收起" : "展开"}「${base.name}」的文档`}
          className="grid size-6 flex-none place-items-center"
        >
          <Icon
            data-icon="inline-start"
            icon={ChevronRight}
            className={cn(" transition-transform", expanded && "rotate-90")}
          />
        </UiButton>
        <Checkbox
          id={selectId}
          aria-labelledby={nameId}
          checked={selected}
          onCheckedChange={() => onToggle(base.id)}
          className="size-7 flex-none"
        />
        <label
          id={nameId}
          htmlFor={selectId}
          title={selected ? "取消选择（回到默认知识库）" : "选入新对话的检索范围"}
          className="min-w-0 flex-1 cursor-pointer truncate text-left text-[0.8rem] text-ink"
        >
          {base.name}
        </label>
      </div>
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
      {/* Kept mounted so the fold animates both ways; the grid-track collapse
          lives in index.css, and `inert` keeps clipped rows out of the tab
          order while closed. */}
      <div
        id={`kb-docs-${base.id}`}
        className="sidebar-folder-tree"
        data-open={expanded ? "true" : "false"}
        inert={!expanded}
      >
        <div>
          <ul className="kb-doc-list ml-5 border-l border-line pl-2 text-[11px] text-faint">
            {loading ? (
              <li className="py-1">正在读取文档…</li>
            ) : error ? (
              <li className="py-1 text-danger">{error}</li>
            ) : documents.length === 0 ? (
              <li className="py-1">暂无文档</li>
            ) : (
              documents.map((doc, index) => (
                <li
                  key={doc.docId}
                  style={
                    {
                      "--kb-doc-index": index,
                    } as React.CSSProperties
                  }
                >
                  <button
                    type="button"
                    onClick={() => openDocument({ documentId: doc.docId })}
                    title={doc.title}
                    className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-lg px-1 text-left text-[11px] text-faint transition-colors hover:bg-surface-muted hover:text-ink"
                  >
                    <Icon
                      data-icon="inline-start"
                      icon={FileText}
                      className="size-4 flex-none"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {doc.title || doc.fileName || doc.docId}
                    </span>
                  </button>
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
                  className="justify-start px-1 py-1 text-left hover:underline"
                >
                  查看全部 {total} 篇
                </UiButton>
              </li>
            ) : null}
          </ul>
        </div>
      </div>
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
              : "border-accent bg-accent-subtle text-on-primary",
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
        <span className="ml-auto flex-none font-mono text-[10px] text-faint/70">
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
  // Renaming/deleting directories is the same admin door the bases themselves
  // sit behind; deleting one only releases its members, so the confirm is a
  // guard against a mis-click rather than a data-loss warning.
  const canManageFolders =
    useSignedInSession()?.scopes.includes("admin") ?? false
  const [folderToDelete, setFolderToDelete] = useState<{
    id: string
    name: string
  } | null>(null)

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
        <span className="font-semibold">知识库</span>
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
            <p className="px-3 py-2 text-xs text-faint/70">
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
            <p className="px-3 py-2 text-xs text-faint/70">
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
                            <li className="px-2 py-1 text-[11px] text-faint">
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
              {ungrouped.length > 0 ? (
                <>
                  {folders.length > 0 ? (
                    <p className="px-3 pt-1.5 text-[10px] text-faint/60">
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
          <p className="px-3 pt-1 text-[10px] leading-relaxed text-faint/60">
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
      <ConfirmDialog
        open={folderToDelete !== null}
        onClose={() => setFolderToDelete(null)}
        title={
          folderToDelete
            ? `删除分类「${folderToDelete.name}」`
            : "删除知识库分类"
        }
        titleId="sidebar-kb-folder-delete-title"
        confirmLabel="确认删除"
        confirmDisabled={folderToDelete === null}
        onConfirm={async () => {
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
        <p>
          这个分类下有
          {folderToDelete
            ? ` ${membersOf(folderToDelete.id).length} `
            : " 0 "}
          个知识库。删除分类只解除归组：知识库本身、它们的内容和已选检索范围都不受影响，只是回到未分类。
        </p>
        <p>要连文档一起删的是知识库本身或文档分类，这里不会碰它们。</p>
      </ConfirmDialog>
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
 * Ticket 19 (AST-01B): experts are the stored assistants. One expert's system
 * prompt shapes each new chat; the server resolves the rest from its stored
 * version. Empty selection = the legacy default path.
 */
function AssistantSelector() {
  const { status, assistants, selectedId, error } = useAssistants()
  const { showToast } = useAppShell()
  const [open, setOpen] = useState(true)
  useEffect(() => {
    assistantStore.ensureLoaded()
  }, [])
  const rows: { id: string | null; name: string }[] = [
    { id: null, name: "默认专家" },
    ...assistants
      .filter(
        (assistant) =>
          assistant.status === "active" &&
          assistant.sidebarVisible !== false &&
          !isDefaultAssistantId(assistant.id),
      )
      .map((assistant) => ({ id: assistant.id, name: assistant.name })),
  ]
  const options = rows.map((row) => ({
    value: row.id ?? "__default__",
    label: row.name,
  }))
  const value = selectedId ?? "__default__"
  const pick = (next: string) => {
    if (next === value) return
    const row = rows.find(
      (candidate) => (candidate.id ?? "__default__") === next,
    )
    if (!row) return
    assistantStore.select(row.id)
    showToast(row.id === null ? "已切换到默认专家" : `已切换到「${row.name}」`)
  }
  return (
    <div>
      {/* Sticky, so the fold control survives however far the list scrolls. The
          fieldset keeps its legend for the accessible name; this is the visible
          title. */}
      <div className="sticky top-0 z-20 bg-surface pt-4">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          aria-controls="expert-picker"
          title={open ? "折叠专家" : "展开专家"}
          className="flex h-7 w-full items-center gap-1 pr-1 pl-[3px] text-left text-[0.8rem] font-semibold text-[color:var(--text-secondary)] transition-colors hover:text-ink"
        >
          <span>专家</span>
          <Icon
            icon={ChevronDown}
            className={cn(
              "transition-transform duration-200",
              open && "rotate-180",
            )}
          />
        </button>
      </div>
      <div
        id="expert-picker"
        className="sidebar-disclosure"
        data-open={open ? "true" : "false"}
        inert={!open}
      >
        <div>
          {status === "loading" ||
          (status === "idle" && assistants.length === 0) ? (
            <p className="px-3 py-2 text-xs text-faint/70">正在加载专家…</p>
          ) : status === "error" ? (
            <p className="px-3 py-2 text-xs text-danger">专家读取失败</p>
          ) : (
            <div className="expert-radio">
              <RadioGroup
                label="专家"
                options={options}
                value={value}
                onValueChange={pick}
              />
            </div>
          )}
        </div>
      </div>
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
 * A workspace action row. Separate from SidebarButton because it carries the
 * secondary-emphasis row, a right-aligned status marker and a permission-based
 * disabled state; SidebarButton owns the rail-level disclosure actions.
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
  const marker = disabledReason ? (
    <span className="text-[10px] text-faint">{disabledReason}</span>
  ) : (
    trailing
  )
  return (
    <div className="relative w-full">
      <ArcButton
        variant="secondary"
        size="sm"
        type="button"
        disabled={Boolean(disabledReason)}
        onClick={disabledReason ? undefined : onClick}
        title={disabledReason ? hint + "（" + disabledReason + "）" : hint}
        className={cn(
          "w-full justify-start text-left",
          marker ? "pr-20" : "",
        )}
      >
        <Icon data-icon="inline-start" icon={icon} />
        <span className="min-w-0 truncate">{label}</span>
      </ArcButton>
      {marker ? (
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
          {marker}
        </span>
      ) : null}
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
    openFeedback,
    openAssistants,
    activeImportCount,
  } = useAppShell()
  const scopes = useSignedInSession()?.scopes ?? []
  const canIngest = scopes.includes("ingest")
  const canAdmin = scopes.includes("admin")
  const [expanded, setExpanded] = useState(false)
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
        variant="secondary"
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
            className="mx-1 flex flex-col gap-2 rounded-[20px] border border-line bg-surface-subtle p-1.5"
          >
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
                    className="ml-auto flex-none rounded-full bg-accent-subtle px-1.5 py-0.5 text-[10px] font-medium leading-none text-on-primary"
                  >
                    {activeImportCount}
                  </span>
                ) : undefined
              }
            />
            <WorkspaceItem
              icon={MessageSquareWarning}
              label="反馈审阅"
              hint="处理用户标记出来的坏答案"
              disabledReason={canAdmin ? undefined : "需管理员权限"}
              onClick={() => openModule(openFeedback)}
            />
            <WorkspaceItem
              icon={Bot}
              label="专家"
              hint="用系统提示词定义回答风格与性格"
              disabledReason={canAdmin ? undefined : "需管理员权限"}
              onClick={() => openModule(openAssistants)}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

export function Sidebar({ collapsed, isDark, onToggleTheme }: SidebarProps) {
  const { toggleSidebar } = useSidebar()
  const { threads, activeThreadId } = useConversation()
  const session = useSignedInSession()
  const { signOut } = useSession()

  // Ticket 08 (KB-04): load the knowledge-base list once per sign-in.
  useEffect(() => {
    knowledgeStore.ensureLoaded()
  }, [])

  const searchLaneRef = useRef<HTMLDivElement>(null)
  // Cap the results panel to the space under the field, so it never runs past
  // the sidebar's bottom edge (and never gives the sidebar scroll of its own).
  useLayoutEffect(() => {
    const lane = searchLaneRef.current
    const recent = lane?.parentElement?.parentElement
    if (!lane || !recent) return
    const update = () => {
      const space = window.innerHeight - lane.getBoundingClientRect().bottom - 24
      lane.style.setProperty("--es-panel-max", `${Math.max(120, space)}px`)
    }
    update()
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update)
    observer?.observe(recent)
    window.addEventListener("resize", update)
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", update)
    }
  }, [collapsed])

  const searchItems = useMemo(
    () => threads.map((thread) => ({ id: thread.id, title: thread.title || "新对话" })),
    [threads],
  )
  const activeThreadIndex = threads.findIndex(
    (thread) => thread.id === activeThreadId,
  )
  const { registerRow, box } = useSlidingHighlight(
    activeThreadIndex >= 0 ? activeThreadIndex : null,
  )

  return (
    <>
      <ShadcnSidebar aria-label="工作区导航">
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
            <div className="sidebar-primary flex flex-col gap-2">
              <ArcButton
                variant="primary"
                size="sm"
                type="button"
                title={collapsed ? "新建对话" : undefined}
                onClick={() => conversationStore.newThread()}
                className={cn(
                  "w-full text-left",
                  collapsed ? "justify-center px-0" : "justify-start",
                )}
              >
                <Icon data-icon="inline-start" icon={Plus} />
                <span className="sidebar-copy min-w-0 truncate">新建对话</span>
              </ArcButton>
              <WorkspaceMenu collapsed={collapsed} />
              <ThemeSwitch
                theme={isDark ? "dark" : "light"}
                label={isDark ? "切换浅色模式" : "切换深色模式"}
                text={isDark ? "切换浅色模式" : "切换深色模式"}
                iconOnly={collapsed}
                onThemeChange={() => onToggleTheme()}
                className={cn(
                  collapsed ? "mx-auto" : "w-full justify-start",
                )}
              />
            </div>

            {/* Ticket 08 (KB-04): workspace knowledge-base selector */}
            <div className="sidebar-module sidebar-module-scroll sidebar-module-shrink">
              <KnowledgeSelector />
            </div>

            {/* Ticket 19 (AST-01B): the expert selector for new chats. The
                bottom padding keeps the selected row's border off the module's
                scroll edge — flush against it, fractional font metrics clip
                the 1px bottom border at non-100% display scaling. */}
            <div className="sidebar-module sidebar-module-scroll pb-0.5">
              <AssistantSelector />
            </div>

            {/* Recent chats */}
            <div
              className={cn(
                "sidebar-recent mt-4 flex min-h-0 flex-1 flex-col",
                collapsed && "mt-3",
              )}
            >
              {/* The search lane lives outside the list's scroll box: the
                  results panel is absolutely positioned under the field and
                  must not be clipped by the list. */}
              <div
                className={cn(
                  "sidebar-search-row relative mb-1 h-9 shrink-0",
                  collapsed && "justify-center",
                )}
              >
                <span className="sidebar-copy sidebar-search-label absolute inset-0 flex items-center px-1 font-semibold">
                  最近对话
                </span>
                {!collapsed ? (
                  <>
                    {threads.length > 0 ? (
                      <div className="absolute inset-y-0 right-12 flex items-center">
                        <ImportHistoryButton />
                      </div>
                    ) : null}
                    {/* Above the thread rows (z-10): the results panel has to
                        paint over the list it overlaps, not under it. */}
                    <div
                      ref={searchLaneRef}
                      className="sidebar-search-lane pointer-events-none absolute inset-0 z-20"
                    >
                      <ExpandingSearch
                        label="搜索历史对话"
                        placeholder="搜索对话"
                        items={searchItems}
                        onSelect={(item) =>
                          conversationStore.switchThread(item.id)
                        }
                        emptyTitle="没有找到“{query}”的对话"
                        emptyHint="换个关键词，或直接新建对话。"
                      />
                    </div>
                  </>
                ) : (
                  <UiButton
                    variant="ghost"
                    size="sm"
                    type="button"
                    aria-label="展开侧栏"
                    title="展开侧栏"
                    onClick={() => conversationStore.toggleSidebar()}
                    className="absolute inset-0 grid place-items-center active:scale-[0.96]"
                  >
                    <Icon data-icon="inline-start" icon={Search} />
                  </UiButton>
                )}
              </div>
              <div className="scrollbar-hidden min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
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
                  {threads.length === 0 ? (
                    <p className="sidebar-copy px-2.5 py-2 text-xs text-faint/70">
                      暂无历史对话
                    </p>
                  ) : collapsed ? null : (
                    threads.map((thread, index) => (
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
            </div>
          </div>

          {session?.displayName ? (
            <div className="sidebar-account mt-2 flex shrink-0 items-center pt-2">
              <UserMenu
                user={{
                  name: session.displayName,
                  caption: session.role === "admin" ? "管理员" : "普通用户",
                }}
                showName={!collapsed}
                align="start"
                onSignOut={() => signOut()}
                rootClassName="w-full"
                className={cn("w-full", collapsed ? "justify-center" : "justify-start")}
              />
            </div>
          ) : null}
        </div>
      </ShadcnSidebar>
    </>
  )
}
