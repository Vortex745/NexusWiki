import { useEffect, useRef, useState } from "react"
import { BookOpen, Bot, Settings } from "lucide-react"
import {
  conversationStore,
  useConversation,
} from "../conversation/useConversation"
import { SidebarProvider, useSidebar } from "./primitives/sidebar"
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
  const { openKnowledge, openAssistants, openSettings } = useAppShell()
  const canAdmin = useSignedInSession()?.scopes.includes("admin") ?? false
  const managementButton = useRef<HTMLButtonElement>(null)
  const pendingManagement = useRef<(() => void) | null>(null)
  const openManagement = (action: () => void) => {
    pendingManagement.current = action
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
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <header className="flex h-14 shrink-0 items-center justify-end px-4">
          {canAdmin ? (
            <DropdownMenu
              label="管理工作区"
              icon={<Settings size={16} strokeWidth={1.75} />}
              triggerRef={managementButton}
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
                  label: "助手管理",
                  icon: <Bot size={16} strokeWidth={1.75} />,
                  onSelect: () => openManagement(openAssistants),
                },
                {
                  label: "模型设置",
                  icon: <Settings size={16} strokeWidth={1.75} />,
                  onSelect: () => openManagement(openSettings),
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
