import type { ExternalStoreThreadListAdapter, ThreadMessageLike } from "@assistant-ui/react"
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
} from "@assistant-ui/react"
import type { Thread } from "@core/conversation"
import { useCallback, useMemo, type ReactNode } from "react"

import { conversationStore, useConversation } from "../conversation/useConversation"
import { usePromptComposer } from "./PromptComposerContext"

type MaybeId = { id?: string }
type AppendContentPart = AppendMessage["content"][number]

function appendText(message: AppendMessage): string {
  return message.content
    .map((part: AppendContentPart) => (part.type === "text" ? part.text : ""))
    .join("")
}

/**
 * Maps a chat message onto assistant-ui's shape. Business data (references,
 * trace events, run id) rides along in `metadata` so the message components
 * can read it back with `useMessage`.
 */
const convertMessage = (message: import("@core/conversation").Message): ThreadMessageLike => {
  // assistant-ui (v0.15+) throws "status is only supported for assistant
  // messages" when a user message carries one, so only assistant messages
  // get a status mapped.
  const status: ThreadMessageLike["status"] =
    message.status === "running"
      ? { type: "running" }
      : message.status === "error"
        ? { type: "incomplete", reason: "error" }
        : { type: "complete", reason: "unknown" }
  return {
    role: message.role,
    content: [{ type: "text", text: message.content }],
    id: message.id,
    createdAt: new Date(message.createdAt),
    ...(message.role === "assistant" ? { status } : {}),
    // `custom` is assistant-ui's slot for host data; the message components read
    // references/trace back out of it with `useMessage(m => m.metadata.custom)`.
    metadata: {
      custom: {
        references: message.references,
        traceEvents: message.traceEvents,
        traceStatus: message.traceStatus ?? null,
        runId: message.runId ?? null,
        faq: message.faq ?? null,
        memoryUsed: message.memoryUsed ?? null,
      },
    },
  }
}

/** assistant-ui hands us the parent of the message being edited, not its id. */
function resolveEditedMessageId(thread: Thread | null, append: AppendMessage): string | null {
  if (!thread) return null
  const messages = thread.messages
  const candidateId = (append as MaybeId).id
  if (candidateId && messages.some((m) => m.id === candidateId && m.role === "user")) {
    return candidateId
  }
  if (append.parentId) {
    const index = messages.findIndex((m) => m.id === append.parentId)
    return index >= 0 ? (messages[index + 1]?.id ?? null) : null
  }
  return messages.find((m) => m.role === "user")?.id ?? null
}

export function ConversationRuntimeProvider({ children }: { children: ReactNode }) {
  const { messages, isRunning, activeThreadId, threads } = useConversation()
  const composePrompt = usePromptComposer()

  const onNew = useCallback(
    async (append: AppendMessage) => {
      const text = appendText(append)
      if (!text.trim()) return
      await conversationStore.sendPrompt(text, composePrompt(text))
    },
    [composePrompt],
  )

  const onEdit = useCallback(
    async (append: AppendMessage) => {
      const text = appendText(append)
      if (!text.trim()) return
      const messageId = resolveEditedMessageId(conversationStore.getActiveThread(), append)
      if (!messageId) return
      await conversationStore.editMessage(messageId, text, composePrompt(text))
    },
    [composePrompt],
  )

  const onReload = useCallback(async (parentId: string | null) => {
    await conversationStore.regenerate(parentId)
  }, [])

  const onCancel = useCallback(async () => {
    conversationStore.cancel()
  }, [])

  const threadList = useMemo<ExternalStoreThreadListAdapter>(
    () => ({
      threadId: activeThreadId,
      threads: threads.map((thread) => ({
        id: thread.id,
        threadId: thread.id,
        title: thread.title,
        status: "regular" as const,
      })),
      onSwitchToNewThread: () => {
        conversationStore.newThread()
      },
      onSwitchToThread: (threadId: string) => {
        conversationStore.switchThread(threadId)
      },
      onRename: (threadId: string, title: string) => {
        conversationStore.renameThread(threadId, title)
      },
      onArchive: () => {},
      onUnarchive: () => {},
      onDelete: (threadId: string) => {
        conversationStore.deleteThread(threadId)
      },
    }),
    [activeThreadId, threads],
  )

  const runtime = useExternalStoreRuntime({
    messages,
    isRunning,
    convertMessage,
    onNew,
    onEdit,
    onReload,
    onCancel,
    adapters: { threadList },
  })

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}
