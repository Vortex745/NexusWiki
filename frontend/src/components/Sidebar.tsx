import { BookOpen, Bot, Brain, Check, ChevronDown, Database, FileText, FlaskConical, HelpCircle, LayoutGrid, MessageSquareWarning, Moon, Network, PanelLeft, PanelLeftClose, Plus, Search, Settings, Sun, Trash2, X } from "lucide"
import { useEffect, useRef, useState } from "react"
import type { IconProps } from "./ui/Icon"

import { useConversation } from "../conversation/useConversation"
import { cn } from "../lib/cn"
import { useAppShell } from "../runtime/AppShellContext"
import { assistantStore, useAssistants } from "../runtime/assistantStore"
import { conversationStore } from "../conversation/useConversation"
import { importConversations } from "../lib/api"
import { useSlidingHighlight } from "../lib/useSlidingHighlight"
import { knowledgeStore, useKnowledgeBases } from "../runtime/knowledgeStore"
import { useMemoryApi } from "../runtime/MemoryContext"
import { useSignedInSession } from "../runtime/SessionContext"
import { DocumentsDialog } from "./panels/DocumentsDialog"
import { GraphBrowseDialog } from "./panels/GraphBrowseDialog"
import { LaboratoryDialog } from "./panels/LaboratoryDialog"
import { StatusPopover } from "./StatusPopover"
import { Icon } from "./ui/Icon"

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
      className={cn("group/thread relative z-10 flex h-8.5 w-full items-center rounded-[8px] transition-colors")}
    >
      <button
        type="button"
        title={title}
        aria-current={active ? "page" : undefined}
        onClick={() => conversationStore.switchThread(id)}
      className={cn(
        // pr-9 reserves the hover-only delete button's slot (right-1.5 + size-6)
        // plus a 6px breath so the title never slides under it.
        "min-w-0 flex-1 cursor-pointer overflow-hidden rounded-[8px] pl-2.5 pr-9 text-left text-xs text-muted transition-[color,background-color] duration-150 hover:text-ink",
        active && "font-medium text-ink",
        collapsed && "px-0 text-center",
      )}
      >
        <span className="sidebar-copy block truncate">{title || "新对话"}</span>
      </button>
      {!collapsed ? (
        <button
          type="button"
          title="删除对话"
          aria-label={`删除对话：${title || "新对话"}`}
          onClick={() => conversationStore.deleteThread(id)}
          className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-full text-muted/70 opacity-0 transition-[color,opacity] hover:text-danger group-hover/thread:opacity-100 max-md:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-brand"
        >
          <Icon icon={Trash2} className="size-3.5" />
        </button>
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
  collapsed = false,
}: {
  icon: IconProps["icon"]
  label: string
  onClick: () => void
  trailing?: React.ReactNode
  ariaExpanded?: boolean
  collapsed?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={ariaExpanded}
      title={collapsed ? label : undefined}
      className={cn(
        "flex h-8.5 w-full cursor-pointer items-center gap-2 rounded-[8px] bg-transparent text-left text-xs text-muted transition-[color,background-color,border-color,transform,translate,scale] duration-150 ease-out hover:bg-surface-subtle hover:text-ink active:scale-[0.98]",
        collapsed ? "justify-center px-0" : "px-3",
      )}
    >
      <Icon icon={icon} className="size-3.5" />
      <span className="sidebar-copy min-w-0 truncate">{label}</span>
      <span className="sidebar-copy ml-auto shrink-0">{trailing}</span>
    </button>
  )
}

/**
 * Ticket 08 (KB-04): the workspace knowledge-base selector. Browsing is for
 * every signed-in member; the list shows ACTIVE bases only (archived ones are
 * the admin dialog's concern). An empty selection means the server default —
 * a selection can only ever NARROW the chat's knowledge scope, and the server
 * validates every id against the session's tenant regardless.
 */
function KnowledgeSelector() {
  const { status, activeKnowledgeBases: bases, selectedIds, error } = useKnowledgeBases()
  // Ticket 11 (DOC-01A): browsing a base's document catalog is for every
  // signed-in member — the server applies the tenant/group/kb scoping.
  const [browsingDocs, setBrowsingDocs] = useState<{ id: string; name: string } | null>(null)
  // Ticket 37 (GRAPH-01): browsing a base's knowledge-scoped graph relations
  // is for every signed-in member — the server authorizes every relation and
  // every provenance record.
  const [browsingGraph, setBrowsingGraph] = useState<{ id: string; name: string } | null>(null)
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between px-1 text-[11px] font-semibold uppercase tracking-wider text-muted/70">
        <span>知识库</span>
      </div>
      {status === "loading" || (status === "idle" && bases.length === 0) ? (
        <p className="px-3 py-2 text-xs text-muted/70">正在加载知识库…</p>
      ) : status === "error" ? (
        <div className="px-3 py-2">
          <p className="text-xs text-danger">知识库读取失败：{error}</p>
          <button
            type="button"
            onClick={() => void knowledgeStore.refresh()}
            className="mt-1 cursor-pointer text-xs font-medium text-brand hover:underline"
          >
            重试
          </button>
        </div>
      ) : bases.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted/70">暂无可用知识库</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-0.5">
          {bases.map((base) => {
            const selected = selectedIds.includes(base.id)
            return (
              <li key={base.id} className="group/kb relative">
                <button
                  type="button"
                  onClick={() => knowledgeStore.toggleSelected(base.id)}
                  title={selected ? "取消选择（回到默认知识库）" : "选入新对话的检索范围"}
                  aria-pressed={selected}
                  className={cn(
                    // pr-16 keeps the truncate edge clear of the two hover-only
                    // action buttons parked at right-1.5/right-8.5.
                    "flex h-8.5 w-full cursor-pointer items-center gap-2 rounded-full pl-3 pr-16 text-left text-xs transition-[color,background-color,border-color,transform,translate,scale] duration-150 ease-out hover:bg-surface-subtle active:scale-[0.98]",
                    selected ? "text-ink" : "text-muted",
                  )}
                >
                  <span
                    className={cn(
"grid size-4 flex-none place-items-center rounded-[6px] border transition-colors",
                      selected ? "border-primary bg-primary text-on-primary" : "border-line bg-transparent",
                    )}
                  >
                    {selected ? <Icon icon={Check} className="size-3" /> : null}
                  </span>
                  <span className="truncate">{base.name}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setBrowsingDocs({ id: base.id, name: base.name })}
                  title={`浏览「${base.name}」的文档目录`}
                  className="absolute top-1/2 right-8.5 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-full text-muted/70 opacity-0 transition-[color,opacity] hover:text-ink group-hover/kb:opacity-100 max-md:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-brand"
                >
                  <Icon icon={FileText} className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setBrowsingGraph({ id: base.id, name: base.name })}
                  title={`浏览「${base.name}」的知识图谱`}
                  className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-full text-muted/70 opacity-0 transition-[color,opacity] hover:text-ink group-hover/kb:opacity-100 max-md:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-brand"
                >
                  <Icon icon={Network} className="size-3.5" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <p className="px-3 pt-1 text-[10px] leading-relaxed text-muted/60">
        {selectedIds.length > 0
          ? `新对话将检索选中的 ${selectedIds.length} 个知识库`
          : "未选择时检索默认知识库"}
      </p>
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
  const [hovered, setHovered] = useState<number | null>(null)
  const [focused, setFocused] = useState<number | null>(null)
  useEffect(() => {
    assistantStore.ensureLoaded()
  }, [])
  // The default entry is row 0 so the highlight has one index space to work in;
  // it used to be a hand-copied `<li>` above the mapped ones.
  const rows: { id: string | null; name: string }[] = [
    { id: null, name: "默认助手" },
    ...assistants
      .filter((assistant) => assistant.status === "active")
      .map((assistant) => ({ id: assistant.id, name: assistant.name })),
  ]
  const selectedIndex = rows.findIndex((row) => row.id === selectedId)
  const { registerRow, box } = useSlidingHighlight(
    hovered ?? focused ?? (selectedIndex >= 0 ? selectedIndex : null),
  )
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between px-1 text-[11px] font-semibold uppercase tracking-wider text-muted/70">
        <span>助手</span>
      </div>
      {status === "loading" || (status === "idle" && assistants.length === 0) ? (
        <p className="px-3 py-2 text-xs text-muted/70">正在加载助手…</p>
      ) : status === "error" ? (
        <p className="px-3 py-2 text-xs text-danger">助手读取失败</p>
      ) : (
        <ul className="relative mt-1 flex flex-col gap-0.5" onPointerLeave={() => setHovered(null)}>
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
                <button
                  type="button"
                  ref={registerRow(index)}
                  onClick={() => {
                    assistantStore.select(row.id)
                  }}
                  onPointerEnter={() => setHovered(index)}
                  onFocus={() => setFocused(index)}
                  onBlur={() => setFocused((current) => (current === index ? null : current))}
                  title={
                    row.id === null
                      ? "使用默认助手（不加任何额外设定）"
                      : `新对话将由「${row.name}」接答`
                  }
                  aria-pressed={selected}
                  className={cn(
"relative z-10 flex h-8.5 w-full cursor-pointer items-center gap-2 rounded-full px-3 text-left text-xs transition-[color,transform,translate,scale] duration-150 ease-out active:scale-[0.98]",
                    selected ? "text-ink" : "text-muted",
                  )}
                >
                  <span
                    className={cn(
"grid size-4 flex-none place-items-center rounded-full border transition-colors",
                      selected ? "border-primary" : "border-line bg-transparent",
                    )}
                  >
                    {selected ? <span className="size-2 rounded-full bg-primary" /> : null}
                  </span>
                  <span className="truncate">{row.name}</span>
                </button>
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
      return window.localStorage.getItem("nexusrag.conversations.imported") === "1"
    } catch {
      return false
    }
  })
  if (imported) return null
  const handleImport = async () => {
    setImporting(true)
    try {
      const result = await importConversations(conversationStore.exportThreads())
      try {
        window.localStorage.setItem("nexusrag.conversations.imported", "1")
      } catch {
        // Storage unavailable — the button simply reappears next load.
      }
      setImported(true)
      showToast(`已导入 ${result.imported} 个对话${result.skipped > 0 ? `，跳过 ${result.skipped} 个已存在` : ""}`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : "导入失败")
    } finally {
      setImporting(false)
    }
  }
  return (
    <button
      type="button"
      onClick={() => void handleImport()}
      disabled={importing}
      title="把浏览器里的本地对话导入服务器（只上传，不清除本地）"
      className="cursor-pointer rounded-full px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-muted transition-colors hover:bg-surface-subtle hover:text-ink disabled:opacity-50"
    >
      {importing ? "导入中…" : "导入历史"}
    </button>
  )
}

/**
 * Keep the chat workspace quiet by grouping secondary tools behind one entry.
 * The actions themselves stay in their existing dialogs and retain the server
 * scope checks that decide which rows are visible.
 */
function WorkspaceMenu({ collapsed = false }: { collapsed?: boolean }) {
  const {
    openImport,
    openEvaluation,
    openKnowledge,
    openSettings,
    openAssistants,
    openFeedback,
    openFaqs,
  } = useAppShell()
  const scopes = useSignedInSession()?.scopes ?? []
  const canIngest = scopes.includes("ingest")
  const canAdmin = scopes.includes("admin")
  const [expanded, setExpanded] = useState(false)
  const [laboratoryOpen, setLaboratoryOpen] = useState(false)

  const openModule = (action: () => void) => {
    setExpanded(false)
    action()
  }

  return (
    <>
      <SidebarButton
        icon={LayoutGrid}
        label="工作区"
        collapsed={collapsed}
        ariaExpanded={expanded}
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
            className={cn("ml-auto size-3.5 transition-transform", expanded && "rotate-180")}
          />
        }
      />
      {expanded && !collapsed ? (
        <div className="mx-1 rounded-3xl border border-line bg-surface-subtle/50 p-1">
          {canIngest || canAdmin ? (
            <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted/60">
              数据
            </p>
          ) : null}
          {canIngest ? (
            <SidebarButton icon={Database} label="导入文档" onClick={() => openModule(openImport)} />
          ) : null}
          {canAdmin ? (
            <SidebarButton icon={BookOpen} label="知识库管理" onClick={() => openModule(openKnowledge)} />
          ) : null}

          <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted/60">
            分析
          </p>
          <SidebarButton
            icon={FlaskConical}
            label="检索实验室"
            onClick={() => {
              setExpanded(false)
              setLaboratoryOpen(true)
            }}
          />
          {canAdmin ? (
            <SidebarButton icon={FlaskConical} label="运行评测" onClick={() => openModule(openEvaluation)} />
          ) : null}
          {canAdmin ? (
            <SidebarButton
              icon={MessageSquareWarning}
              label="反馈审阅"
              onClick={() => openModule(openFeedback)}
            />
          ) : null}

          {canAdmin ? (
            <>
              <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted/60">
                管理
              </p>
              <SidebarButton icon={HelpCircle} label="标准问答" onClick={() => openModule(openFaqs)} />
              <SidebarButton icon={Settings} label="模型设置" onClick={() => openModule(openSettings)} />
              <SidebarButton icon={Bot} label="助手管理" onClick={() => openModule(openAssistants)} />
            </>
          ) : null}
        </div>
      ) : null}
      <LaboratoryDialog open={laboratoryOpen} onClose={() => setLaboratoryOpen(false)} />
    </>
  )
}

export function Sidebar({ open, collapsed, isDark, onToggleTheme, onCloseMobile }: SidebarProps) {
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
    const frame = requestAnimationFrame(() => chatSearchInputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [chatSearchOpen])

  const visibleThreads = threads.filter((thread) =>
    thread.title.toLowerCase().includes(chatQuery.trim().toLowerCase()),
  )
  const activeThreadIndex = visibleThreads.findIndex((thread) => thread.id === activeThreadId)
  const { registerRow, box } = useSlidingHighlight(activeThreadIndex >= 0 ? activeThreadIndex : null)

  return (
    <>
      {/* Mobile backdrop */}
      <div
        className={cn(
"pointer-events-none fixed inset-0 z-20 bg-black/20 opacity-0 transition-opacity duration-180 md:hidden",
          open && "pointer-events-auto opacity-100",
        )}
        onClick={onCloseMobile}
      />

      <aside
        aria-label="工作区导航"
        data-collapsed={collapsed ? "true" : "false"}
        className={cn(
          "sidebar-shell relative z-30 flex min-h-0 flex-col overflow-x-hidden border-r border-line bg-surface pb-3 pt-3",
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:ml-0 max-md:shadow-lg max-md:transition-transform",
          open ? "max-md:translate-x-0" : "max-md:-translate-x-full",
        )}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <div className={cn("relative mb-2.5 flex h-10 shrink-0 items-center", collapsed ? "justify-center" : "justify-between px-1")}>
            <div className="sidebar-brand flex min-w-0 items-center gap-2">
              <span className="sidebar-copy text-[13px] font-semibold tracking-tight text-ink">NexusRAG</span>
              <span className="sidebar-copy rounded-full border border-line bg-surface-subtle px-2 py-0.5 font-mono text-[10px] font-semibold text-muted">Mem0</span>
            </div>
            <button
              type="button"
              aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
              title={collapsed ? "展开侧栏" : "收起侧栏"}
              onClick={() => conversationStore.toggleSidebar()}
              className="grid size-8 cursor-pointer place-items-center rounded-[8px] text-muted transition-[color,background-color,scale] duration-150 hover:bg-surface-subtle hover:text-ink active:scale-[0.97]"
            >
              <Icon icon={collapsed ? PanelLeft : PanelLeftClose} className="size-4" />
            </button>
          </div>

          {/* Primary actions */}
          <div className="sidebar-primary flex flex-col gap-1">
            <button
              type="button"
              title={collapsed ? "新建对话" : undefined}
              onClick={() => conversationStore.newThread()}
              className={cn(
                "flex h-9 w-full cursor-pointer items-center gap-2 rounded-[8px] text-left text-xs font-medium transition-[color,background-color,border-color,transform,translate,scale,opacity] duration-150 ease-out active:scale-[0.98]",
                collapsed ? "justify-center px-0" : "px-3",
                "bg-transparent text-muted hover:bg-surface-subtle hover:text-ink",
              )}
            >
              <Icon icon={Plus} className="size-3.5" />
              <span className="sidebar-copy min-w-0 truncate">新建对话</span>
            </button>
            <WorkspaceMenu collapsed={collapsed} />
            <SidebarButton
              icon={isDark ? Sun : Moon}
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
          <div className={cn("sidebar-recent mt-4 min-h-0 flex-1 overflow-x-hidden overflow-y-auto", collapsed && "mt-3")}>
            <div className={cn("sidebar-search-row relative mb-1 h-8", collapsed && "justify-center")}>
              <span className="sidebar-copy sidebar-search-label absolute inset-0 flex items-center px-1 text-[11px] font-semibold uppercase tracking-wider text-muted/70">
                最近对话
              </span>
              {!collapsed ? (
                <div className="absolute inset-y-0 right-0 flex items-center gap-1">
                  {threads.length > 0 ? <ImportHistoryButton /> : null}
                  <button
                    type="button"
                    aria-label={chatSearchOpen ? "关闭历史搜索" : "搜索历史对话"}
                    title={chatSearchOpen ? "关闭历史搜索" : "搜索历史对话"}
                    onClick={() => {
                      setChatSearchOpen((current) => !current)
                      if (chatSearchOpen) setChatQuery("")
                    }}
                    className="grid size-7 cursor-pointer place-items-center rounded-[8px] text-muted transition-[color,background-color,scale] hover:bg-surface-subtle hover:text-ink active:scale-[0.96]"
                  >
                    {chatSearchOpen ? <Icon icon={X} className="size-3.5" /> : <Icon icon={Search} className="size-3.5" />}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  aria-label="展开侧栏并搜索历史对话"
                  title="展开侧栏并搜索历史对话"
                  onClick={() => {
                    conversationStore.toggleSidebar()
                    setChatSearchOpen(true)
                  }}
                  className="absolute inset-0 grid cursor-pointer place-items-center rounded-[8px] text-muted transition-[color,background-color,scale] hover:bg-surface-subtle hover:text-ink active:scale-[0.96]"
                >
                  <Icon icon={Search} className="size-3.5" />
                </button>
              )}
              <div className={cn("sidebar-search-field absolute inset-y-0 right-0 flex items-center gap-1.5 rounded-[8px] bg-surface-subtle px-2 text-muted", chatSearchOpen && "sidebar-search-field-open")}>
                <Icon icon={Search} className="size-3.5" />
                <input
                  ref={chatSearchInputRef}
                  value={chatQuery}
                  onChange={(event) => setChatQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setChatSearchOpen(false)
                      setChatQuery("")
                    }
                  }}
                  placeholder="搜索对话"
                  aria-label="搜索历史对话"
                  tabIndex={chatSearchOpen && !collapsed ? 0 : -1}
                  className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-muted/70"
                />
                <button
                  type="button"
                  aria-label="关闭历史搜索"
                  tabIndex={chatSearchOpen && !collapsed ? 0 : -1}
                  onClick={() => {
                    setChatSearchOpen(false)
                    setChatQuery("")
                  }}
                  className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-[7px] text-muted hover:bg-surface hover:text-ink"
                >
                  <Icon icon={X} className="size-3.5" />
                </button>
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
                  transition: "top 220ms var(--ease-out), height 220ms var(--ease-out), opacity 150ms var(--ease-out)",
                }}
              />
              {visibleThreads.length === 0 ? (
                <p className="sidebar-copy px-2.5 py-2 text-xs text-muted/70">{chatQuery ? "没有匹配的对话" : "暂无历史对话"}</p>
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

          {/* Memory entry + service status */}
          <div className="mt-3 flex flex-col gap-1 border-t border-line pt-2">
            <button
              type="button"
              onClick={openMemory}
              title="查看并管理会话记忆"
              className={cn("flex h-8.5 w-full cursor-pointer items-center rounded-[8px] px-2.5 text-xs text-muted transition-[color,background-color] hover:bg-surface-subtle hover:text-ink", collapsed ? "justify-center px-0" : "justify-between")}
            >
              <div className="flex items-center gap-2">
                <Icon icon={Brain} className="size-3.5 text-muted" />
                <span className="sidebar-copy min-w-0 truncate">上下文记忆</span>
              </div>
              <span className="sidebar-copy rounded-full border border-line bg-surface-subtle px-2 py-0.5 font-mono text-[10px] font-medium text-muted">
                {memories.length} 条
              </span>
            </button>
            <div className="sidebar-module"><StatusPopover /></div>
          </div>
        </div>
      </aside>
    </>
  )
}
