import { ThreadListItemPrimitive, ThreadListPrimitive } from "@assistant-ui/react"
import { BookOpen, Brain, Check, Database, FileText, FlaskConical, MessageCircle, Moon, Plus, Sun, Trash2 } from "lucide"
import { useEffect, useState } from "react"
import type { IconProps } from "./ui/Icon"

import { useConversation } from "../conversation/useConversation"
import { cn } from "../lib/cn"
import { useAppShell } from "../runtime/AppShellContext"
import { knowledgeStore, useKnowledgeBases } from "../runtime/knowledgeStore"
import { useMemoryApi } from "../runtime/MemoryContext"
import { useSignedInSession } from "../runtime/SessionContext"
import { DocumentsDialog } from "./panels/DocumentsDialog"
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
          className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-muted/70 opacity-0 transition-[colors,opacity] hover:text-red-600 group-hover/thread:opacity-100 max-md:opacity-100 focus-visible:outline-2 focus-visible:outline-brand"
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
}: {
  icon: IconProps["icon"]
  label: string
  onClick: () => void
  trailing?: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8.5 w-full cursor-pointer items-center gap-2 rounded-lg bg-transparent px-3 text-left text-xs text-muted transition-[colors,transform] duration-150 ease-out hover:bg-surface-subtle hover:text-ink active:scale-[0.98]"
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
  const { openKnowledge } = useAppShell()
  const scopes = useSignedInSession()?.scopes ?? []
  const canAdmin = scopes.includes("admin")
  // Ticket 11 (DOC-01A): browsing a base's document catalog is for every
  // signed-in member — the server applies the tenant/group/kb scoping.
  const [browsingDocs, setBrowsingDocs] = useState<{ id: string; name: string } | null>(null)

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between px-1 text-[11px] font-semibold uppercase tracking-wider text-muted/70">
        <span>知识库</span>
        {canAdmin ? (
          <button
            type="button"
            onClick={openKnowledge}
            title="管理知识库"
            className="cursor-pointer rounded p-0.5 text-muted/70 transition-colors hover:text-ink"
          >
            <Icon icon={BookOpen} className="size-3.5" />
          </button>
        ) : null}
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
                    "flex h-8.5 w-full cursor-pointer items-center gap-2 rounded-lg px-3 text-left text-xs transition-[colors,transform] duration-150 ease-out hover:bg-surface-subtle active:scale-[0.98]",
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
                  className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-muted/70 opacity-0 transition-[colors,opacity] hover:text-ink group-hover/kb:opacity-100 max-md:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-brand"
                >
                  <Icon icon={FileText} className="size-3.5" />
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

export function Sidebar({ open, collapsed, isDark, onToggleTheme, onCloseMobile }: SidebarProps) {
  const { openImport, openMemory, openEvaluation } = useAppShell()
  const { memories } = useMemoryApi()
  const { threads } = useConversation()
  // Ticket 01: navigation mirrors what the server will actually authorize —
  // the scopes come from `GET /api/session`, never from client-side state.
  const scopes = useSignedInSession()?.scopes ?? []
  const canIngest = scopes.includes("ingest")
  const canAdmin = scopes.includes("admin")

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
          "relative z-30 flex w-64 min-w-64 flex-col border-r border-line bg-surface px-3 pb-3 pt-3 transition-[margin-left] duration-200 ease-drawer",
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
                className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-lg bg-brand px-3 text-left text-xs font-medium text-white shadow-card transition-[colors,transform] duration-150 ease-out hover:bg-brand-hover active:scale-[0.98]"
              >
                <Icon icon={Plus} className="size-3.5 text-white/90" />
                <span>新建对话</span>
              </button>
            </ThreadListPrimitive.New>
            {canIngest ? <SidebarButton icon={Database} label="导入文档" onClick={openImport} /> : null}
            {canAdmin ? (
              <SidebarButton icon={FlaskConical} label="运行评测" onClick={openEvaluation} />
            ) : null}
            <SidebarButton
              icon={isDark ? Sun : Moon}
              label={isDark ? "切换浅色模式" : "切换深色模式"}
              onClick={onToggleTheme}
            />
          </div>

          {/* Ticket 08 (KB-04): workspace knowledge-base selector */}
          <KnowledgeSelector />

          {/* Recent chats */}
          <div className="mt-4 flex items-center justify-between px-1 text-[11px] font-semibold uppercase tracking-wider text-muted/70">
            <span>最近对话</span>
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
