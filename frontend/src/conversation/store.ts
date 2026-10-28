import type { Conversation, Message, Thread } from "@core/conversation"
import { ConversationImpl, LocalStorageConversationStorage } from "@core/conversation"
import type { ReasoningEffort } from "../../../src/types/answer"

import { fetchReasoningCapability, fetchRunHistory, streamChat } from "../lib/api"
import { knowledgeStore } from "../runtime/knowledgeStore"
import { assistantStore } from "../runtime/assistantStore"

export type ReasoningStatus = "unknown" | "loading" | "ready" | "unavailable"

/**
 * The page-level reasoning-effort state. `ready` includes a normal
 * `supported: false` response — the selector is hidden then, but the state is
 * resolved, not failed. `unavailable` is a network/non-OK/malformed read.
 */
export interface ReasoningSnapshot {
  status: ReasoningStatus
  /** Non-empty only on ready + supported. */
  levels: readonly ReasoningEffort[]
  /** The page's current choice; non-null only on ready + supported. */
  effort: ReasoningEffort | null
}

export interface ThreadSummary {
  id: string
  title: string
  updatedAt: string
}

export interface ConversationSnapshot {
  /** Threads that already hold at least one message, newest activity first. */
  threads: ThreadSummary[]
  activeThreadId: string
  activeThreadTitle: string
  /** Immutable views of the active thread's messages. */
  messages: Message[]
  isRunning: boolean
  runningMessageId: string | null
  sidebarCollapsed: boolean
  online: boolean
  /** The page-level reasoning-effort selection (shared by every composer). */
  reasoning: ReasoningSnapshot
}

function createRunId(): string {
  const randomId =
    typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `run-${randomId}`
}

/**
 * Bridges the framework-agnostic `Conversation` state core to React.
 *
 * `Conversation` mutates message objects in place, so this store keeps a cache
 * of immutable per-message views and invalidates only what actually changed —
 * a streamed token rebuilds one message object, not the whole thread. State
 * ownership stays in `Conversation`; this class only owns subscription plumbing
 * and the fetch lifecycle.
 */
export class ConversationStore {
  private readonly conversation: Conversation
  private readonly listeners = new Set<() => void>()
  private readonly views = new Map<Message, Message>()
  private snapshot: ConversationSnapshot | null = null
  private abortController: AbortController | null = null
  private runningMessage: Message | null = null
  private online = true
  /**
   * Page-level (NOT per-thread, NOT persisted): refresh restores the default.
   * Sending never mutates this; the run freezes whatever is current.
   */
  private reasoningStatus: ReasoningStatus = "unknown"
  private reasoningLevels: readonly ReasoningEffort[] = []
  private reasoningEffort: ReasoningEffort | null = null
  /** Fires once per new prompt (after the composer has read staged attachments). */
  onSendStart?: () => void

  constructor(conversation: Conversation) {
    this.conversation = conversation
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): ConversationSnapshot => {
    if (!this.snapshot) this.snapshot = this.build()
    return this.snapshot
  }

  // -------------------------------------------------------------------------
  // Read helpers used by panels that need the live source object
  // -------------------------------------------------------------------------

  getActiveThread(): Thread | null {
    return this.conversation.getActiveThread()
  }

  /**
   * Ticket 20 (CONV-01A): snapshot the browser-local threads for the one-time
   * server import. Local storage is NEVER cleared by this — the server marks
   * each thread as imported by its id, and a repeated import only skips.
   */
  exportThreads(): Array<{
    id: string
    title?: string
    messages: Array<{ role: "user" | "assistant"; content: string }>
  }> {
    return this.conversation.listThreads().map((thread) => ({
      id: thread.id,
      title: thread.title,
      messages: thread.messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => ({
          role: message.role as "user" | "assistant",
          content:
            typeof message.content === "string" ? message.content : String(message.content ?? ""),
        })),
    }))
  }

  // -------------------------------------------------------------------------
  // Run lifecycle
  // -------------------------------------------------------------------------

  async sendPrompt(displayText: string, prompt: string): Promise<void> {
    if (this.conversation.isRunning()) return
    const thread = this.conversation.getActiveThread()
    if (!thread) return

    this.conversation.addUserMessage(thread.id, { content: displayText, prompt })
    this.onSendStart?.()
    const assistant = this.conversation.startAssistantRun(thread.id, { runId: createRunId() })
    this.runningMessage = assistant
    this.invalidate()
    await this.executeRun(thread, assistant, prompt)
  }

  /** Regenerates the answer that follows `parentId` (the preceding user turn). */
  async regenerate(parentId: string | null): Promise<void> {
    if (this.conversation.isRunning()) return
    const thread = this.conversation.getActiveThread()
    if (!thread) return

    const anchor = parentId
      ? thread.messages.find((message) => message.id === parentId)
      : [...thread.messages].reverse().find((message) => message.role === "user")
    if (!anchor) return

    const prompt = anchor.prompt || anchor.content
    if (!prompt.trim()) return

    // Ticket 21 (CONV-01B): name the branch being replaced BEFORE the local
    // truncation removes it, so the server drops the same branch.
    const replacedRunId = this.replacedRunId(thread, anchor.id)
    this.conversation.truncateMessages(thread.id, anchor.id, false)
    const assistant = this.conversation.startAssistantRun(thread.id, { runId: createRunId() })
    this.runningMessage = assistant
    this.invalidate()
    await this.executeRun(thread, assistant, prompt, replacedRunId)
  }

  async editMessage(userMessageId: string, displayText: string, prompt: string): Promise<void> {
    if (this.conversation.isRunning()) return
    const thread = this.conversation.getActiveThread()
    if (!thread) return
    if (!thread.messages.some((message) => message.id === userMessageId)) return

    const replacedRunId = this.replacedRunId(thread, userMessageId)
    this.conversation.truncateMessages(thread.id, userMessageId, true)
    this.conversation.addUserMessage(thread.id, { content: displayText, prompt })
    const assistant = this.conversation.startAssistantRun(thread.id, { runId: createRunId() })
    this.runningMessage = assistant
    this.invalidate()
    await this.executeRun(thread, assistant, prompt, replacedRunId)
  }

  /**
   * Ticket 21 (CONV-01B): the first assistant reply after `messageId` — the
   * run an edit or regenerate replaces. Undefined when the branch was never
   * answered, so the server truncates nothing (there is nothing to drop).
   */
  private replacedRunId(thread: Thread, messageId: string): string | undefined {
    const index = thread.messages.findIndex((message) => message.id === messageId)
    if (index === -1) return undefined
    return thread.messages
      .slice(index + 1)
      .find((message) => message.role === "assistant" && message.runId)?.runId
  }

  cancel(): void {
    this.abortController?.abort()
  }

  // -------------------------------------------------------------------------
  // Reasoning effort (page-level)
  // -------------------------------------------------------------------------

  /**
   * Load the running model's capability ONCE. Any resolved state — ready or
   * unavailable — is final for this page: no retry, no polling. A failed read
   * only hides the selector; chat keeps sending without the field.
   */
  async loadReasoningCapability(): Promise<void> {
    if (this.reasoningStatus !== "unknown") return
    this.reasoningStatus = "loading"
    this.invalidate()
    try {
      const capability = await fetchReasoningCapability()
      this.reasoningStatus = "ready"
      this.reasoningLevels = capability.supported ? capability.levels : []
      this.reasoningEffort = capability.supported ? capability.defaultEffort : null
    } catch {
      this.reasoningStatus = "unavailable"
      this.reasoningLevels = []
      this.reasoningEffort = null
    }
    this.invalidate()
  }

  /**
   * Narrowing-only page preference: only a ready+supported model accepts a
   * level, only an advertised level is accepted, and a run in flight locks it.
   */
  setReasoningEffort(effort: ReasoningEffort): void {
    if (this.conversation.isRunning()) return
    if (this.reasoningStatus !== "ready") return
    if (!this.reasoningLevels.includes(effort)) return
    if (this.reasoningEffort === effort) return
    this.reasoningEffort = effort
    this.invalidate()
  }

  /** The level this page would send right now; undefined = omit the field. */
  private currentReasoningEffort(): ReasoningEffort | undefined {
    if (this.reasoningStatus !== "ready") return undefined
    return this.reasoningEffort ?? undefined
  }

  private async executeRun(
    thread: Thread,
    assistant: Message,
    prompt: string,
    truncateFromRunId?: string,
  ): Promise<void> {
    // Freeze BEFORE the first await: a capability load that lands mid-run, or
    // a selection made while this request is in flight, can never rewrite it.
    const reasoningEffort = this.currentReasoningEffort()
    const controller = new AbortController()
    this.abortController = controller
    this.conversation.startRun()
    this.invalidate()

    try {
      await streamChat(
        {
          message: prompt,
          runId: assistant.runId ?? "",
          sessionId: thread.id,
          // Ticket 08 (KB-04): a selection narrows the chat's knowledge scope;
          // empty = the server's default base. The server validates every id.
          ...(knowledgeStore.getSnapshot().selectedIds.length > 0
            ? { knowledgeBaseIds: knowledgeStore.getSnapshot().selectedIds }
            : {}),
          // Ticket 19 (AST-01B): the selected assistant, if any — the server
          // resolves prompt/scope/tool/rerank from its stored version.
          ...(assistantStore.getSnapshot().selectedId
            ? { assistantId: assistantStore.getSnapshot().selectedId as string }
            : {}),
          // Ticket 21 (CONV-01B): edit and regenerate name the replaced branch.
          ...(truncateFromRunId ? { truncateFromRunId } : {}),
          // The frozen page selection for THIS run (omitted = never asked).
          ...(reasoningEffort ? { reasoningEffort } : {}),
        },
        (data) => {
          // Merge policy belongs to Conversation; this store only re-renders.
          this.conversation.processSseEvent(assistant, data)
          this.invalidate(assistant)
        },
        controller.signal,
      )
      // Stream finished cleanly; Conversation decides the terminal status.
      this.conversation.finalizeStreamRun(assistant)
      this.online = true
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        this.conversation.finalizeAbortedRun(assistant)
      } else {
        this.conversation.finalizeConnectionError(assistant)
        this.online = false
        // Ticket 08 (KB-04): a refused knowledge selection (archived/unknown
        // base) leaves the persisted selection stale — the archived base no
        // longer renders as a row to uncheck, so refresh immediately to drop
        // it and let the user reselect.
        void knowledgeStore.refresh()
      }
      this.invalidate(assistant)
    } finally {
      this.conversation.completeRun()
      this.abortController = null
      if (assistant.status === "running") this.conversation.finalizeRun(assistant, "complete")
      thread.updatedAt = new Date().toISOString()
      this.conversation.save()
      this.runningMessage = null
      this.invalidate(assistant)
    }
  }

  /** Replays server-side trace history for runs persisted before a reload. */
  async restoreTraceHistories(): Promise<void> {
    const runs: Message[] = []
    for (const thread of this.conversation.listThreads()) {
      for (const message of thread.messages) {
        if (message.role === "assistant" && message.runId) runs.push(message)
      }
    }

    await Promise.all(
      runs.map(async (message) => {
        try {
          const history = await fetchRunHistory(message.runId as string)
          this.conversation.applyRunHistory(message, history)
          this.invalidate(message)
        } catch {
          // Keep the last locally persisted projection when history is unavailable.
        }
      }),
    )
  }

  // -------------------------------------------------------------------------
  // Thread management
  // -------------------------------------------------------------------------

  newThread(): void {
    if (this.conversation.isRunning()) this.cancel()
    const current = this.conversation.getActiveThread()
    if (current && current.messages.length === 0) return
    this.conversation.createThread()
    this.invalidate()
  }

  switchThread(threadId: string): void {
    this.conversation.setActiveThread(threadId)
    this.invalidate()
  }

  deleteThread(threadId: string): void {
    this.conversation.deleteThread(threadId)
    this.invalidate()
  }

  renameThread(threadId: string, title: string): void {
    this.conversation.renameThread(threadId, title)
    this.invalidate()
  }

  toggleSidebar(): void {
    this.conversation.setSidebarCollapsed(!this.conversation.getSidebarCollapsed())
    this.invalidate()
  }

  // -------------------------------------------------------------------------
  // Snapshot plumbing
  // -------------------------------------------------------------------------

  private build(): ConversationSnapshot {
    const thread = this.conversation.getActiveThread()
    const source = thread?.messages ?? []

    return {
      threads: this.conversation
        .listThreads()
        .filter((item) => item.messages.length > 0)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .map((item) => ({ id: item.id, title: item.title, updatedAt: item.updatedAt })),
      activeThreadId: thread?.id ?? "",
      activeThreadTitle: thread?.title ?? "新对话",
      messages: source.map((message) => this.viewOf(message)),
      isRunning: this.conversation.isRunning(),
      runningMessageId: this.runningMessage?.id ?? null,
      sidebarCollapsed: this.conversation.getSidebarCollapsed(),
      online: this.online,
      reasoning: {
        status: this.reasoningStatus,
        levels: this.reasoningLevels,
        effort: this.reasoningEffort,
      },
    }
  }

  private viewOf(source: Message): Message {
    const cached = this.views.get(source)
    if (cached) return cached
    const view: Message = {
      ...source,
      traceEvents: [...source.traceEvents],
      references: [...source.references],
    }
    this.views.set(source, view)
    return view
  }

  private invalidate(message?: Message): void {
    if (message) this.views.delete(message)
    this.snapshot = null
    for (const listener of this.listeners) listener()
  }
}

export function createConversationStore(): ConversationStore {
  return new ConversationStore(
    new ConversationImpl({ storage: new LocalStorageConversationStorage() }),
  )
}
