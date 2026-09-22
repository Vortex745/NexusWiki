import { useCallback, useEffect, useMemo, useState } from "react"

import { AppShell } from "./components/AppShell"
import { LoginScreen } from "./components/LoginScreen"
import { AssistantsDialog } from "./components/panels/AssistantsDialog"
import { DocumentViewerDialog, type DocumentViewTarget } from "./components/panels/DocumentViewerDialog"
import { EvaluationDialog } from "./components/panels/EvaluationDialog"
import { ImportDialog } from "./components/panels/ImportDialog"
import { InsightDialog } from "./components/panels/InsightDialog"
import { KnowledgeDialog } from "./components/panels/KnowledgeDialog"
import { MemoryDialog } from "./components/panels/MemoryDialog"
import { SettingsDialog } from "./components/panels/SettingsDialog"
import type { Attachment } from "./components/thread/Thread"
import { Toast, type ToastMessage } from "./components/Toast"
import { conversationStore, useConversation } from "./conversation/useConversation"
import {
  listSessionAttachments,
  promoteSessionAttachment,
  removeSessionAttachment,
  uploadSessionAttachment,
  type SessionAttachmentPayload,
} from "./lib/api"
import { getMemoriesPromptContext } from "./lib/memory"
import { knowledgeStore } from "./runtime/knowledgeStore"
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
  const { memories } = useMemoryApi()
  const { isDark, toggleTheme } = useTheme()

  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [evaluationOpen, setEvaluationOpen] = useState(false)
  const [knowledgeOpen, setKnowledgeOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [assistantsOpen, setAssistantsOpen] = useState(false)
  const [documentView, setDocumentView] = useState<{ open: boolean; target: DocumentViewTarget | null }>({
    open: false,
    target: null,
  })
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
  const openKnowledge = useCallback(() => setKnowledgeOpen(true), [])
  const openSettings = useCallback(() => setSettingsOpen(true), [])
  const openAssistants = useCallback(() => setAssistantsOpen(true), [])
  const openDocument = useCallback(
    (target: DocumentViewTarget) => setDocumentView({ open: true, target }),
    [],
  )

  const shellActions = useMemo<AppShellActions>(
    () => ({ openInsight, openMemory, openImport, openEvaluation, openKnowledge, openSettings, openAssistants, openDocument, showToast }),
    [openInsight, openMemory, openImport, openEvaluation, openKnowledge, openSettings, openAssistants, openDocument, showToast],
  )

  // Replay server-side trace history for runs persisted before this page load.
  useEffect(() => {
    void conversationStore.restoreTraceHistories()
  }, [])

  const activeThreadId = useConversation().activeThreadId

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
        if (!cancelled) setAttachments(payload.attachments.map(toChipAttachment))
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

  const composePrompt = useCallback(
    (displayText: string) => {
      // Ticket 22: attachment text is NOT pasted into the prompt anymore —
      // the run retrieves the session's own attachments through the
      // attachment search channel, so they can be retrieved and cited.
      const memoryContext = getMemoriesPromptContext(memories)
      return `${displayText}${memoryContext}`.trim()
    },
    [memories],
  )

  const handleAddAttachments = useCallback(
    async (files: File[]) => {
      const sessionId = conversationStore.getActiveThread()?.id
      if (!sessionId) {
        showToast("请先新建一个对话，再添加附件")
        return
      }
      for (const file of files) {
        try {
          const attachment = await uploadSessionAttachment(sessionId, file)
          if (attachment.status === "failed") {
            showToast(`${file.name} 解析失败：${attachment.error ?? "未知原因"}`)
          }
        } catch (error) {
          showToast(error instanceof Error ? error.message : `${file.name} 上传失败`)
        }
      }
      await refreshAttachments()
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
            traceOpen={traceOpen}
            onToggleTrace={() => setTraceOpen((previous) => !previous)}
            attachmentsProps={{
              attachments,
              onAdd: handleAddAttachments,
              onRemove: handleRemoveAttachment,
              onPromote: handlePromoteAttachment,
            }}
          />
          <MemoryDialog open={memoryOpen} onClose={() => setMemoryOpen(false)} />
          <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
          <EvaluationDialog open={evaluationOpen} onClose={() => setEvaluationOpen(false)} />
          <KnowledgeDialog open={knowledgeOpen} onClose={() => setKnowledgeOpen(false)} />
          <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
          <AssistantsDialog open={assistantsOpen} onClose={() => setAssistantsOpen(false)} />
          <DocumentViewerDialog
            open={documentView.open}
            target={documentView.target}
            onClose={() => setDocumentView((previous) => ({ ...previous, open: false }))}
          />
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
