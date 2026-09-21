import { BarChart3, Brain, Menu, PanelLeft, Share2, ShieldCheck, Sparkles, X } from "lucide"

import { conversationStore, useConversation } from "../conversation/useConversation"
import { copyText } from "../lib/clipboard"
import { cn } from "../lib/cn"
import { useAppShell } from "../runtime/AppShellContext"
import { useMemoryApi } from "../runtime/MemoryContext"
import { useSession, useSignedInSession } from "../runtime/SessionContext"
import { Icon } from "./ui/Icon"
import { TooltipIconButton } from "./ui/TooltipIconButton"

interface TopBarProps {
  sidebarOpen: boolean
  sidebarCollapsed: boolean
  isMobile: boolean
  onToggleSidebar: () => void
  traceOpen: boolean
  onToggleTrace: () => void
}

export function TopBar({
  sidebarOpen,
  sidebarCollapsed,
  isMobile,
  onToggleSidebar,
  traceOpen,
  onToggleTrace,
}: TopBarProps) {
  const { activeThreadTitle } = useConversation()
  const { memories } = useMemoryApi()
  const { openMemory, openInsight, showToast } = useAppShell()
  const session = useSignedInSession()
  const { signOut } = useSession()

  const toggleLabel = isMobile
    ? sidebarOpen
      ? "关闭侧栏"
      : "打开侧栏"
    : sidebarCollapsed
      ? "展开侧栏"
      : "收起侧栏"

  const share = async () => {
    const thread = conversationStore.getActiveThread()
    if (!thread || thread.messages.length === 0) {
      showToast("当前对话还没有可分享的内容")
      return
    }
    const transcript = thread.messages
      .map((message) => `${message.role === "user" ? "我" : "NexusRAG"}：${message.content}`)
      .join("\n\n")
    try {
      await copyText(`${thread.title}\n\n${transcript}`)
      showToast("对话内容已复制")
    } catch {
      showToast("复制失败，请检查浏览器权限")
    }
  }

  return (
    <header className="flex h-12 items-center justify-between border-b border-line bg-surface/95 px-4 backdrop-blur-sm">
      <div className="flex min-w-0 items-center gap-2">
        <TooltipIconButton tooltip={toggleLabel} onClick={onToggleSidebar} className="size-7">
          {isMobile ? (
            <Icon icon={sidebarOpen ? X : Menu} className="size-4" />
          ) : (
            <Icon icon={PanelLeft} className="size-4" />
          )}
        </TooltipIconButton>
        <span className="max-w-70 truncate text-xs font-medium text-ink">{activeThreadTitle}</span>
      </div>

      <div className="flex items-center gap-1.5">
        {session ? (
          <button
            type="button"
            onClick={signOut}
            aria-label="退出登录"
            title={`${session.subjectId} · ${session.groups.join("、") || "无分组"} · 点击退出登录`}
            className="flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface-subtle px-2.5 text-xs text-muted shadow-card transition-colors hover:bg-surface-subtle/80 hover:text-ink"
          >
            <Icon icon={ShieldCheck} className="size-3 text-brand" />
            <span className="text-xs font-medium">
              {session.role === "admin" ? "管理员" : "读者"}
            </span>
          </button>
        ) : null}

        <button
          type="button"
          onClick={openMemory}
          aria-label="管理上下文记忆"
          className="flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface-subtle px-2.5 text-xs text-muted shadow-card transition-colors hover:bg-surface-subtle/80 hover:text-ink"
        >
          <Icon icon={Brain} className="size-3 text-brand" />
          <span className="text-xs font-medium">记忆 ({memories.length})</span>
        </button>

        <TooltipIconButton
          tooltip="回答分析"
          onClick={() => openInsight()}
          className="size-7"
          aria-label="回答分析"
        >
          <Icon icon={BarChart3} className="size-3.5" />
        </TooltipIconButton>

        <TooltipIconButton
          tooltip="链路追踪"
          onClick={onToggleTrace}
          aria-pressed={traceOpen}
          className={cn("size-7", traceOpen && "bg-surface-subtle text-ink")}
          aria-label="链路追踪"
        >
          <Icon icon={Sparkles} className="size-3.5" />
        </TooltipIconButton>

        <TooltipIconButton tooltip="分享对话" onClick={() => void share()} className="size-7" aria-label="分享对话">
          <Icon icon={Share2} className="size-3.5" />
        </TooltipIconButton>
      </div>
    </header>
  )
}
