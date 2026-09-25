import { ThreadListItemPrimitive, ThreadListPrimitive } from "@assistant-ui/react"
import { BookOpen, Bot, Brain, Check, ChevronDown, Database, FileText, FlaskConical, HelpCircle, LayoutGrid, MessageCircle, MessageSquareWarning, Moon, Network, Plus, Settings, Sun, Trash2 } from "lucide"
import { useEffect, useState } from "react"
import type { IconProps } from "./ui/Icon"

import { useConversation } from "../conversation/useConversation"
import { cn } from "../lib/cn"
import { useAppShell } from "../runtime/AppShellContext"
import { assistantStore, useAssistants } from "../runtime/assistantStore"
import { conversationStore } from "../conversation/useConversation"
import { importConversations } from "../lib/api"
import { knowledgeStore, useKnowledgeBases } from "../runtime/knowledgeStore"
import { useMemoryApi } from "../runtime/MemoryContext"
import { useSignedInSession } from "../runtime/SessionContext"
import { DocumentsDialog } from "./panels/DocumentsDialog"
import { GraphBrowseDialog } from "./panels/GraphBrowseDialog"
import { LaboratoryDialog } from "./panels/LaboratoryDialog"
import { StatusPopover } from "./StatusPopover"
import { Icon } from "./ui/Icon"

function ThreadListItem() {
  return (
    <ThreadListItemPrimitive.Root className="group/thread relative flex h-9 w-full items-center rounded-lg transition-colors hover:bg-surface-subtle data-[active]:bg-brand-subtle data-[active]:font-medium data-[active]:text-ink">
      <ThreadListItemPrimitive.Trigger className="h-full min-w-0 flex-1 cursor-pointer overflow-hidden bg-transparent pl-2.5 pr-7 text-left text-xs">
        <span className="block w-full truncate">
          <ThreadListItemPrimitive.Title fallback="新对话" />
        </span>
      </ThreadListItemPrimitive.Trigger>
      <ThreadListItemPrimitive.Delete asChild>
        {/* 原生 title 代替自绘 tooltip：自绘的 nowrap 气泡会横向伸出滚动容器，
            既被裁剪又撑出侧栏横向滚动条 */}
        <button
          type="button"
          title="删除对话"
          className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-muted/70 opacity-0 transition-[color,opacity] hover:text-red-600 group-hover/thread:opacity-100 max-md:opacity-100 focus-visible:outline-2 focus-visible:outline-brand"
        >
          <Icon icon={Trash2} className="size-3.5" />
        </button>
      </ThreadListItemPrimitive.Delete>
    </ThreadListItemPrimitive.Root>
  )
}

function SidebarButton({
  icon,
  label,
  onClick,
  trailing,
  ariaExpanded,
}: {
  icon: IconProps["icon"]
  label: string
  onClick: () => void
  trailing?: React.ReactNode
  ariaExpanded?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={ariaExpanded}
      className="flex h-8.5 w-full cursor-pointer items-center gap-2 rounded-lg bg-transparent px-3 text-left text-xs text-muted transition-[color,background-color,border-color,transform,translate,scale] duration-150 ease-out hover:bg-surface-subtle hover:text-ink active:scale-[0.98]"
    >
      <Icon icon={icon} className="size-3.5" />
      <span>{label}</span>
      {trailing}
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
          <p className="text-xs text-red-600 dark:text-red-400">知识库读取失败：{error}</p>
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
                    "flex h-8.5 w-full cursor-pointer items-center gap-2 rounded-lg px-3 text-left text-xs transition-[color,background-color,border-color,transform,translate,scale] duration-150 ease-out hover:bg-surface-subtle active:scale-[0.98]",
                    selected ? "text-ink" : "text-muted",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-4 flex-none place-items-center rounded border transition-colors",
                      selected ? "border-brand bg-brand text-white" : "border-line bg-transparent",
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
                  className="absolute top-1/2 right-8.5 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-muted/70 opacity-0 transition-[color,opacity] hover:text-ink group-hover/kb:opacity-100 max-md:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-brand"
                >
                  <Icon icon={FileText} className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setBrowsingGraph({ id: base.id, name: base.name })}
                  title={`浏览「${base.name}」的知识图谱`}
                  className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-muted/70 opacity-0 transition-[color,opacity] hover:text-ink group-hover/kb:opacity-100 max-md:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-brand"
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
  useEffect(() => {
    assistantStore.ensureLoaded()
  }, [])
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between px-1 text-[11px] font-semibold uppercase tracking-wider text-muted/70">
        <span>助手</span>
      </div>
      {status === "loading" || (status === "idle" && assistants.length === 0) ? (
        <p className="px-3 py-2 text-xs text-muted/70">正在加载助手…</p>
      ) : status === "error" ? (
        <p className="px-3 py-2 text-xs text-red-600 dark:text-red-400">助手读取失败</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-0.5">
          <li>
            <button
              type="button"
              onClick={() => assistantStore.select(null)}
              title="使用默认助手（不加任何额外设定）"
              aria-pressed={selectedId === null}
              className={cn(
                "flex h-8.5 w-full cursor-pointer items-center gap-2 rounded-lg px-3 text-left text-xs transition-[color,background-color,border-color,transform,translate,scale] duration-150 ease-out hover:bg-surface-subtle active:scale-[0.98]",
                selectedId === null ? "text-ink" : "text-muted",
              )}
            >
              <span
                className={cn(
                  "grid size-4 flex-none place-items-center rounded-full border transition-colors",
                  selectedId === null ? "border-brand" : "border-line bg-transparent",
                )}
              >
                {selectedId === null ? <span className="size-2 rounded-full bg-brand" /> : null}
              </span>
              <span className="truncate">默认助手</span>
            </button>
          </li>
          {assistants
            .filter((assistant) => assistant.status === "active")
            .map((assistant) => {
              const selected = selectedId === assistant.id
              return (
                <li key={assistant.id}>
                  <button
                    type="button"
                    onClick={() => assistantStore.select(assistant.id)}
                    title={`新对话将由「${assistant.name}」接答`}
                    aria-pressed={selected}
                    className={cn(
                      "flex h-8.5 w-full cursor-pointer items-center gap-2 rounded-lg px-3 text-left text-xs transition-[color,background-color,border-color,transform,translate,scale] duration-150 ease-out hover:bg-surface-subtle active:scale-[0.98]",
                      selected ? "text-ink" : "text-muted",
                    )}
                  >
                    <span
                      className={cn(
                        "grid size-4 flex-none place-items-center rounded-full border transition-colors",
                        selected ? "border-brand" : "border-line bg-transparent",
                      )}
                    >
                      {selected ? <span className="size-2 rounded-full bg-brand" /> : null}
                    </span>
                    <span className="truncate">{assistant.name}</span>
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
      className="cursor-pointer rounded px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-muted transition-colors hover:bg-surface-subtle hover:text-ink disabled:opacity-50"
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
function WorkspaceMenu() {
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
        ariaExpanded={expanded}
        onClick={() => setExpanded((previous) => !previous)}
        trailing={
          <Icon
            icon={ChevronDown}
            className={cn("ml-auto size-3.5 transition-transform", expanded && "rotate-180")}
          />
        }
      />
      {expanded ? (
        <div className="mx-1 rounded-lg border border-line bg-surface-subtle/50 p-1">
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
  const { threads } = useConversation()

  // Ticket 08 (KB-04): load the knowledge-base list once per sign-in.
  useEffect(() => {
    knowledgeStore.ensureLoaded()
  }, [])

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
        aria-label="对话列表"
        className={cn(
          "relative z-30 flex w-64 min-w-64 flex-col border-r border-line bg-surface px-3 pb-3 pt-3",
          collapsed && "-ml-64",
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:ml-0 max-md:w-[min(84vw,280px)] max-md:min-w-[min(84vw,280px)] max-md:shadow-lg max-md:transition-transform",
          open ? "max-md:translate-x-0" : "max-md:-translate-x-full",
        )}
      >
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col transition-opacity duration-160",
            collapsed && "pointer-events-none opacity-0 max-md:pointer-events-auto max-md:opacity-100",
          )}
        >
          {/* Title + Mem0 badge */}
          <div className="flex h-9 items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <span className="grid size-6.5 place-items-center rounded-lg bg-neutral-900 text-white shadow-card dark:bg-neutral-700">
                <Icon icon={MessageCircle} className="size-3.5" />
              </span>
              <span className="text-[13px] font-semibold tracking-tight text-ink">NexusRAG</span>
            </div>
            <span className="rounded-full border border-brand-line bg-brand-subtle px-2 py-0.5 font-mono text-[10px] font-semibold text-brand">
              Mem0
            </span>
          </div>

          {/* Primary actions */}
          <div className="mt-2.5 flex flex-col gap-1">
            <ThreadListPrimitive.New asChild>
              <button
                type="button"
                className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-lg bg-brand px-3 text-left text-xs font-medium text-white shadow-card transition-[color,background-color,border-color,transform,translate,scale] duration-150 ease-out hover:bg-brand-hover active:scale-[0.98]"
              >
                <Icon icon={Plus} className="size-3.5 text-white/90" />
                <span>新建对话</span>
              </button>
            </ThreadListPrimitive.New>
            <WorkspaceMenu />
            <SidebarButton
              icon={isDark ? Sun : Moon}
              label={isDark ? "切换浅色模式" : "切换深色模式"}
              onClick={onToggleTheme}
            />
          </div>

          {/* Ticket 08 (KB-04): workspace knowledge-base selector */}
          <KnowledgeSelector />

          {/* Ticket 19 (AST-01B): the assistant selector for new chats */}
          <AssistantSelector />

          {/* Recent chats */}
          <div className="mt-4 flex items-center justify-between px-1 text-[11px] font-semibold uppercase tracking-wider text-muted/70">
            <span>最近对话</span>
            {threads.length > 0 ? <ImportHistoryButton /> : null}
          </div>
          <ThreadListPrimitive.Root
            aria-label="历史对话"
            className="mt-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-x-hidden overflow-y-auto"
          >
            {threads.length === 0 ? (
              <p className="whitespace-nowrap px-3 py-2 text-xs text-muted/70">暂无历史对话</p>
            ) : (
              <ThreadListPrimitive.Items components={{ ThreadListItem }} />
            )}
          </ThreadListPrimitive.Root>

          {/* Memory entry + service status */}
          <div className="mt-auto flex flex-col gap-1 border-t border-line pt-2">
            <button
              type="button"
              onClick={openMemory}
              title="查看并管理会话记忆"
              className="flex h-8.5 w-full cursor-pointer items-center justify-between rounded-lg px-2.5 text-xs text-muted transition-colors hover:bg-surface-subtle hover:text-ink"
            >
              <div className="flex items-center gap-2">
                <Icon icon={Brain} className="size-3.5 text-brand" />
                <span>上下文记忆</span>
              </div>
              <span className="rounded-full border border-brand-line bg-brand-subtle px-2 py-0.5 font-mono text-[10px] font-medium text-brand">
                {memories.length} 条
              </span>
            </button>
            <StatusPopover />
          </div>
        </div>
      </aside>
    </>
  )
}
