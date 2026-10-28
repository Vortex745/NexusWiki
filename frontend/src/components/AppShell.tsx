import { useEffect, useRef, useState } from "react"
import { BookOpen, Bot, Brain, ScrollText, Settings } from "./ui/icons"
import { openProjectLog, type ProjectLogStream } from "../lib/api"
import {
  conversationStore,
  useConversation,
} from "../conversation/useConversation"
import { SidebarProvider, useSidebar } from "./ui/sidebar-shell"
import { Sidebar } from "./Sidebar"
import { Thread, type ThreadAttachmentsProps } from "./thread/Thread"
import { EvidenceContext, type EvidenceTarget } from "./thread/EvidenceContext"
import { TracePanel } from "./panels/TracePanel"
import { useAppShell } from "../runtime/AppShellContext"
import { useSignedInSession } from "../runtime/SessionContext"
import { DropdownMenu } from "./arc/dropdown-menu/dropdown-menu"
interface AppShellProps {
  isDark: boolean
  onToggleTheme: () => void
  traceOpen: boolean
  traceMessageId: string | null
  onCloseTrace: () => void
  attachmentsProps: ThreadAttachmentsProps
}
export function AppShell(props: AppShellProps) {
  const { sidebarCollapsed } = useConversation()
  return (
    <SidebarProvider
      open={!sidebarCollapsed}
      onOpenChange={(open) => {
        if (open === sidebarCollapsed) conversationStore.toggleSidebar()
      }}
      className="h-dvh min-h-0"
    >
      <ShellFrame {...props} />
    </SidebarProvider>
  )
}
function ShellFrame({
  isDark,
  onToggleTheme,
  traceOpen,
  traceMessageId,
  onCloseTrace,
  attachmentsProps,
}: AppShellProps) {
  const { isMobile, openMobile, setOpenMobile } = useSidebar()
  const { sidebarCollapsed, activeThreadId } = useConversation()
  const { openKnowledge, openAssistants, openSettings, openMemory, showToast } =
    useAppShell()
  const canAdmin = useSignedInSession()?.scopes.includes("admin") ?? false
  const managementButton = useRef<HTMLButtonElement>(null)
  const pendingManagement = useRef<(() => void) | null>(null)
  const openManagement = (action: () => void) => {
    pendingManagement.current = action
  }
  // The server opens the file on ITS OWN machine — the documented boundary of
  // this local-first action. Errors come back verbatim instead of a fake toast.
  const openLog = async (stream: ProjectLogStream) => {
    try {
      const result = await openProjectLog(stream)
      showToast(`已用系统默认程序打开 ${result.file}`)
    } catch (reason) {
      showToast(
        reason instanceof Error ? reason.message : String(reason),
        "error",
      )
    }
  }
  const [sources, setSources] = useState<EvidenceTarget | null>(null)
  useEffect(() => setSources(null), [traceOpen, traceMessageId, activeThreadId])
  return (
    <EvidenceContext.Provider value={setSources}>
      <Sidebar
        open={openMobile}
        collapsed={sidebarCollapsed && !isMobile}
        isDark={isDark}
        onToggleTheme={onToggleTheme}
        onCloseMobile={() => setOpenMobile(false)}
      />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-canvas">
        {/* The menu is wider than its trigger and centred on it, so the extra
            padding keeps its right half inside the viewport. */}
        <header className="flex h-14 shrink-0 items-center justify-end pl-4 pr-16">
          {canAdmin ? (
            <DropdownMenu
              label="更多设置"
              icon={<Settings size={16} strokeWidth={1.75} />}
              triggerRef={managementButton}
              align="center"
              sideOffset={0}
              onCloseAutoFocus={(event) => {
                const action = pendingManagement.current
                if (!action) return
                event.preventDefault()
                pendingManagement.current = null
                managementButton.current?.focus()
                action()
              }}
              items={[
                {
                  label: "知识库管理",
                  icon: <BookOpen size={16} strokeWidth={1.75} />,
                  onSelect: () => openManagement(openKnowledge),
                },
                {
                  label: "专家管理",
                  icon: <Bot size={16} strokeWidth={1.75} />,
                  onSelect: () => openManagement(openAssistants),
                },
                {
                  label: "模型设置",
                  icon: <Settings size={16} strokeWidth={1.75} />,
                  onSelect: () => openManagement(openSettings),
                },
                {
                  label: "上下文记忆",
                  icon: <Brain size={16} strokeWidth={1.75} />,
                  onSelect: () => openManagement(openMemory),
                },
                {
                  label: "查看系统日志",
                  icon: <ScrollText size={16} strokeWidth={1.75} />,
                  separatorBefore: true,
                  onSelect: () => void openLog("system"),
                },
                {
                  label: "查看 Agent 日志",
                  icon: <ScrollText size={16} strokeWidth={1.75} />,
                  onSelect: () => void openLog("agent"),
                },
              ]}
            />
          ) : null}
        </header>
        <div className="flex min-h-0 flex-1">
          <Thread attachmentsProps={attachmentsProps} />
          <TracePanel
            open={traceOpen || sources !== null}
            messageId={sources?.messageId ?? traceMessageId}
            initialTab={sources ? "sources" : "trace"}
            referenceId={sources?.referenceId}
            onClose={() => {
              setSources(null)
              onCloseTrace()
            }}
          />
        </div>
      </main>
    </EvidenceContext.Provider>
  )
}
