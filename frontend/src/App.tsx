import { useCallback, useEffect, useMemo, useState } from "react"

import { AppShell } from "./components/AppShell"
import { LoginScreen } from "./components/LoginScreen"
import { EvaluationDialog } from "./components/panels/EvaluationDialog"
import { ImportDialog } from "./components/panels/ImportDialog"
import { InsightDialog } from "./components/panels/InsightDialog"
import { MemoryDialog } from "./components/panels/MemoryDialog"
import type { Attachment } from "./components/thread/Thread"
import { Toast, type ToastMessage } from "./components/Toast"
import { conversationStore } from "./conversation/useConversation"
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "./lib/constants"
import { createId } from "./lib/id"
import { getMemoriesPromptContext } from "./lib/memory"
import { useTheme } from "./lib/theme"
import { AppShellProvider, type AppShellActions } from "./runtime/AppShellContext"
import { MemoryProvider, useMemoryApi } from "./runtime/MemoryContext"
import { PromptComposerProvider } from "./runtime/PromptComposerContext"
import { ConversationRuntimeProvider } from "./runtime/ConversationRuntimeProvider"
import { SessionProvider, useSession } from "./runtime/SessionContext"

export function App() {
  return (
    <SessionProvider>
      <SessionGate />
    </SessionProvider>
  )
}

/**
 * Ticket 01 (IAM-01): the app only mounts once the server has confirmed who
 * the caller is. While the session is unresolved there is no application UI,
 * and an anonymous caller only ever sees the sign-in screen.
 */
function SessionGate() {
  const { state, signIn } = useSession()

  if (state.status === "loading") {
    return (
      <div className="grid min-h-dvh place-items-center bg-canvas">
        <p className="text-xs text-muted">正在确认身份…</p>
      </div>
    )
  }

  if (state.status === "anonymous") {
    return <LoginScreen authConfig={state.authConfig} onSignIn={signIn} />
  }

  if (state.status === "error") {
    return (
      <div className="grid min-h-dvh place-items-center bg-canvas px-4">
        <div
          role="alert"
          className="w-full max-w-sm rounded-xl border border-line bg-surface p-6 shadow-card"
        >
          <p className="text-sm font-medium text-ink">无法进入应用</p>
          <p className="mt-2 text-xs leading-relaxed text-muted">{state.message}</p>
        </div>
      </div>
    )
  }

  return (
    <MemoryProvider>
      <AppRoot />
    </MemoryProvider>
  )
}

function AppRoot() {
  const { memories } = useMemoryApi()
  const { isDark, toggleTheme } = useTheme()

  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [evaluationOpen, setEvaluationOpen] = useState(false)
  const [insight, setInsight] = useState<{ open: boolean; messageId: string | null }>({
    open: false,
    messageId: null,
  })
  const [traceOpen, setTraceOpen] = useState(false)

  const showToast = useCallback((text: string) => setToast({ text, key: Date.now() }), [])
  const openInsight = useCallback(
    (messageId?: string) => setInsight({ open: true, messageId: messageId ?? null }),
    [],
  )
  const openMemory = useCallback(() => setMemoryOpen(true), [])
  const openImport = useCallback(() => setImportOpen(true), [])
  const openEvaluation = useCallback(() => setEvaluationOpen(true), [])

  const shellActions = useMemo<AppShellActions>(
    () => ({ openInsight, openMemory, openImport, openEvaluation, showToast }),
    [openInsight, openMemory, openImport, openEvaluation, showToast],
  )

  // Staged attachments are consumed the moment a prompt actually goes out.
  useEffect(() => {
    conversationStore.onSendStart = () => setAttachments([])
    return () => {
      conversationStore.onSendStart = undefined
    }
  }, [])

  // Replay server-side trace history for runs persisted before this page load.
  useEffect(() => {
    void conversationStore.restoreTraceHistories()
  }, [])

  const composePrompt = useCallback(
    (displayText: string) => {
      const attachmentContext = attachments
        .map((file) => `\n\n[附件：${file.name}]\n${file.content}`)
        .join("")
      const memoryContext = getMemoriesPromptContext(memories)
      return `${displayText}${attachmentContext}${memoryContext}`.trim()
    },
    [attachments, memories],
  )

  const handleAddAttachments = useCallback(
    async (files: File[]) => {
      let count = attachments.length
      for (const file of files) {
        if (count >= MAX_ATTACHMENTS) {
          showToast(`最多添加 ${MAX_ATTACHMENTS} 个文本附件`)
          break
        }
        if (file.size > MAX_ATTACHMENT_BYTES) {
          showToast(`${file.name} 超过 128 KB，未添加`)
          continue
        }
        try {
          const content = await file.text()
          setAttachments((previous) => [
            ...previous,
            { id: createId("attachment"), name: file.name, content },
          ])
          count += 1
        } catch {
          showToast(`${file.name} 读取失败`)
        }
      }
    },
    [attachments.length, showToast],
  )

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((previous) => previous.filter((attachment) => attachment.id !== id))
  }, [])

  return (
    <AppShellProvider value={shellActions}>
      <PromptComposerProvider value={composePrompt}>
        <ConversationRuntimeProvider>
          <AppShell
            isDark={isDark}
            onToggleTheme={toggleTheme}
            traceOpen={traceOpen}
            onToggleTrace={() => setTraceOpen((previous) => !previous)}
            attachmentsProps={{
              attachments,
              onAdd: handleAddAttachments,
              onRemove: handleRemoveAttachment,
            }}
          />
          <MemoryDialog open={memoryOpen} onClose={() => setMemoryOpen(false)} />
          <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
          <EvaluationDialog open={evaluationOpen} onClose={() => setEvaluationOpen(false)} />
          <InsightDialog
            open={insight.open}
            messageId={insight.messageId}
            onClose={() => setInsight((previous) => ({ ...previous, open: false }))}
          />
          <Toast toast={toast} />
        </ConversationRuntimeProvider>
      </PromptComposerProvider>
    </AppShellProvider>
  )
}
