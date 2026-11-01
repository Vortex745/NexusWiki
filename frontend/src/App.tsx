import { useCallback, useEffect, useMemo, useState } from "react"

import { AdminConsole } from "./components/admin/AdminConsole"
import { AppShell } from "./components/AppShell"
import { Alert } from "./components/arc/alert/alert"
import { Skeleton } from "./components/arc/skeleton/skeleton"
import { LoginScreen } from "./components/LoginScreen"
import { AssistantsDialog } from "./components/panels/AssistantsDialog"
import {
  DocumentViewerDialog,
  type DocumentViewTarget,
} from "./components/panels/DocumentViewerDialog"
import { ImportDialog } from "./components/panels/ImportDialog"
import { KnowledgeDialog } from "./components/panels/KnowledgeDialog"
import { MemoryDialog } from "./components/panels/MemoryDialog"
import { SettingsDialog } from "./components/panels/SettingsDialog"
import type { Attachment } from "./components/thread/Thread"
import { Toast, type ToastMessage } from "./components/Toast"
import {
  conversationStore,
  useConversation,
} from "./conversation/useConversation"
import {
  listSessionAttachments,
  promoteSessionAttachment,
  removeSessionAttachment,
  uploadSessionAttachment,
  type SessionAttachmentPayload,
} from "./lib/api"
import { knowledgeStore } from "./runtime/knowledgeStore"
import { useTheme } from "./lib/theme"
import { IMPORT_POLL_MS } from "./lib/constants"
import {
  AppShellProvider,
  type AppShellActions,
  type AppShellState,
} from "./runtime/AppShellContext"
import { MemoryProvider } from "./runtime/MemoryContext"
import { PromptComposerProvider } from "./runtime/PromptComposerContext"
import { ConversationRuntimeProvider } from "./runtime/ConversationRuntimeProvider"
import { SessionProvider, useSession, useSignedInSession } from "./runtime/SessionContext"

export function App() {
  useEffect(() => {
    const root = document.documentElement
    const previous = root.getAttribute("data-motion-input")
    const pointer = () => root.setAttribute("data-motion-input", "pointer")
    const keyboard = () => root.setAttribute("data-motion-input", "keyboard")
    keyboard()
    document.addEventListener("pointerdown", pointer, true)
    document.addEventListener("keydown", keyboard, true)
    return () => {
      document.removeEventListener("pointerdown", pointer, true)
      document.removeEventListener("keydown", keyboard, true)
      if (previous === null) root.removeAttribute("data-motion-input")
      else root.setAttribute("data-motion-input", previous)
    }
  }, [])
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
        <div role="status" className="flex w-64 flex-col gap-3">
          <Skeleton lines={2} label="正在确认身份" />
          <p className="text-sm text-faint">正在确认身份…</p>
        </div>
      </div>
    )
  }

  if (state.status === "anonymous") {
    return <LoginScreen authConfig={state.authConfig} onSignIn={signIn} />
  }

  if (state.status === "error") {
    return (
      <div className="grid min-h-dvh place-items-center bg-canvas px-4">
        <Alert tone="danger" title="无法进入应用" className="max-w-sm">
          {state.message}
        </Alert>
      </div>
    )
  }

  return (
    <MemoryProvider>
      <AppRoot />
    </MemoryProvider>
  )
}

/** Ticket 22 (ATT-01): a server attachment row in the composer's chip shape. */
function toChipAttachment(attachment: SessionAttachmentPayload): Attachment {
  return {
    id: attachment.id,
    name: attachment.name,
    content: "",
    status: attachment.status,
    error: attachment.error,
    promoted: attachment.status === "promoted",
  }
}

function AppRoot() {
  const { isDark, toggleTheme } = useTheme()
  const session = useSignedInSession()

  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const [memoryOpen, setMemoryOpen] = useState(false)
  // AC-02 (admin console), user decision 2026-10-31: signing in AS the
  // operator lands DIRECTLY in the back-office console — a separate
  // interface, not the chat with an extra entry. 「进入对话」 exposes the
  // chat shell (which stays mounted underneath, so nothing is lost); the
  // sidebar entry switches back. Everyone else lands in the chat as before.
  const [adminOpen, setAdminOpen] = useState(() => session?.operator === true)
  const [importOpen, setImportOpen] = useState(false)
  // Ticket 08: import rows still owing an outcome — the sidebar 导入中 N badge.
  const [activeImportCount, setActiveImportCount] = useState(0)
  const [knowledgeOpen, setKnowledgeOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [assistantsOpen, setAssistantsOpen] = useState(false)
  const [documentView, setDocumentView] = useState<{
    open: boolean
    target: DocumentViewTarget | null
  }>({
    open: false,
    target: null,
  })
  const [trace, setTrace] = useState<{
    open: boolean
    messageId: string | null
  }>({
    open: false,
    messageId: null,
  })

  const showToast = useCallback(
    (text: string, tone: "success" | "error" = "success") =>
      setToast({ text, tone, key: Date.now() }),
    [],
  )
  const openTrace = useCallback((messageId: string) => {
    setTrace((previous) =>
      previous.open && previous.messageId === messageId
        ? { open: false, messageId: null }
        : { open: true, messageId },
    )
  }, [])
  const closeTrace = useCallback(
    () => setTrace({ open: false, messageId: null }),
    [],
  )
  const openMemory = useCallback(() => setMemoryOpen(true), [])
  const openImport = useCallback(() => setImportOpen(true), [])
  const openKnowledge = useCallback(() => setKnowledgeOpen(true), [])
  const openSettings = useCallback(() => setSettingsOpen(true), [])
  const openAssistants = useCallback(() => setAssistantsOpen(true), [])
  const openAdmin = useCallback(() => setAdminOpen(true), [])
  const openDocument = useCallback(
    (target: DocumentViewTarget) => setDocumentView({ open: true, target }),
    [],
  )

  const shellActions = useMemo<AppShellActions & AppShellState>(
    () => ({
      activeImportCount,
      openTrace,
      openMemory,
      openImport,
      openKnowledge,
      openSettings,
      openAssistants,
      openAdmin,
      openDocument,
      showToast,
    }),
    [
      activeImportCount,
      openTrace,
      openMemory,
      openImport,
      openKnowledge,
      openSettings,
      openAssistants,
      openAdmin,
      openDocument,
      showToast,
    ],
  )

  // Replay server-side trace history for runs persisted before this page load.
  useEffect(() => {
    void conversationStore.restoreTraceHistories()
  }, [])

  const { activeThreadId, messages } = useConversation()

  // A pin is a look back at one past answer, not a filter that hides the answer
  // currently streaming: whenever the newest assistant message changes (a new run
  // opens, or the thread switches) the panel drops back to the live chain.
  const latestAssistantId =
    [...messages].reverse().find((message) => message.role === "assistant")
      ?.id ?? null
  useEffect(() => {
    setTrace((previous) =>
      previous.messageId ? { ...previous, messageId: null } : previous,
    )
  }, [latestAssistantId])

  // Ticket 22 (ATT-01): attachments are SERVER-owned rows of the current
  // conversation. The list is re-read whenever the conversation changes, so
  // the chips always show what this session can actually retrieve and cite.
  useEffect(() => {
    if (!activeThreadId) {
      setAttachments([])
      return
    }
    let cancelled = false
    void listSessionAttachments(activeThreadId)
      .then((payload) => {
        if (!cancelled)
          setAttachments(payload.attachments.map(toChipAttachment))
      })
      .catch(() => {
        if (!cancelled) setAttachments([])
      })
    return () => {
      cancelled = true
    }
  }, [activeThreadId])

  const refreshAttachments = useCallback(async () => {
    if (!activeThreadId) return
    try {
      const payload = await listSessionAttachments(activeThreadId)
      setAttachments(payload.attachments.map(toChipAttachment))
    } catch {
      // The chips keep their last known state; the server stays the source.
    }
  }, [activeThreadId])

  // Binary documents are extracted server-side after the upload returns, so the
  // chips poll while any row is still parsing — the same cadence as the import
  // queue. Nothing polls once every attachment settled.
  const hasParsingAttachment = attachments.some(
    (attachment) => attachment.status === "parsing",
  )
  useEffect(() => {
    if (!hasParsingAttachment) return
    const timer = setInterval(() => void refreshAttachments(), IMPORT_POLL_MS)
    return () => clearInterval(timer)
  }, [hasParsingAttachment, refreshAttachments])

  // Ticket 33 (MEM-01B): the prompt carries ONLY what the user typed —
  // long-term memories are recalled SERVER-side now (owner-scoped, traceable,
  // disableable per run), so the client no longer pastes them into the message.
  const composePrompt = useCallback((displayText: string) => displayText, [])

  const handleAddAttachment = useCallback(
    async (file: File) => {
      const sessionId = conversationStore.getActiveThread()?.id
      if (!sessionId) {
        showToast("请先开始一个对话", "error")
        return
      }
      try {
        await uploadSessionAttachment(sessionId, file)
        await refreshAttachments()
        showToast(`已添加附件「${file.name}」`)
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : "附件上传失败",
          "error",
        )
      }
    },
    [refreshAttachments, showToast],
  )

  const handleRemoveAttachment = useCallback(
    async (id: string) => {
      const sessionId = conversationStore.getActiveThread()?.id
      if (!sessionId) return
      try {
        await removeSessionAttachment(sessionId, id)
      } catch (error) {
        showToast(error instanceof Error ? error.message : "移除附件失败")
      }
      await refreshAttachments()
    },
    [refreshAttachments, showToast],
  )

  /**
   * Promotion is explicit: it files the attachment into the knowledge base the
   * user has SELECTED in the workspace, through the normal ingestion rules.
   */
  const handlePromoteAttachment = useCallback(
    async (id: string) => {
      const sessionId = conversationStore.getActiveThread()?.id
      const target = knowledgeStore.getSnapshot().selectedIds[0]
      if (!sessionId) return
      if (!target) {
        showToast("请先在知识库面板中选择要提升到的知识库")
        return
      }
      try {
        await promoteSessionAttachment(sessionId, id, target)
        showToast("附件已提升到知识库")
      } catch (error) {
        showToast(error instanceof Error ? error.message : "提升失败")
      }
      await refreshAttachments()
    },
    [refreshAttachments, showToast],
  )

  return (
    <AppShellProvider value={shellActions}>
      <PromptComposerProvider value={composePrompt}>
        <ConversationRuntimeProvider>
          <AppShell
            isDark={isDark}
            onToggleTheme={toggleTheme}
            traceOpen={trace.open}
            traceMessageId={trace.messageId}
            onCloseTrace={closeTrace}
            attachmentsProps={{
              attachments,
              onAdd: handleAddAttachment,
              onRemove: handleRemoveAttachment,
              onPromote: handlePromoteAttachment,
            }}
          />
          <AdminConsole open={adminOpen} onClose={() => setAdminOpen(false)} />
          <MemoryDialog
            open={memoryOpen}
            onClose={() => setMemoryOpen(false)}
          />
          <ImportDialog
            open={importOpen}
            onClose={() => setImportOpen(false)}
            onActiveCountChange={setActiveImportCount}
          />
          <KnowledgeDialog
            open={knowledgeOpen}
            onClose={() => setKnowledgeOpen(false)}
          />
          <SettingsDialog
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
          />
          <AssistantsDialog
            open={assistantsOpen}
            onClose={() => setAssistantsOpen(false)}
          />
          <DocumentViewerDialog
            open={documentView.open}
            target={documentView.target}
            onClose={() =>
              setDocumentView((previous) => ({ ...previous, open: false }))
            }
          />
          <Toast toast={toast} />
        </ConversationRuntimeProvider>
      </PromptComposerProvider>
    </AppShellProvider>
  )
}
