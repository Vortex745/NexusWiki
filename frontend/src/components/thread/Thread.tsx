import {
  ActionBarPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react"
import type { Reference, TraceEvent } from "@core/conversation"
import {
  ArrowDown,
  BarChart3,
  Brain,
  Check,
  Copy,
  Paperclip,
  Pencil,
  RefreshCw,
  SendHorizontal,
  Square,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide"
import { useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react"

import { conversationStore } from "../../conversation/useConversation"
import { cn } from "../../lib/cn"
import {
  FEEDBACK_REASON_CODES,
  submitAnswerFeedback,
  type FeedbackRating,
  type FeedbackReasonCode,
} from "../../lib/api"
import { INSIGHT_PATH_STEPS, SUGGESTIONS, traceEventLabel } from "../../lib/constants"
import { useAppShell } from "../../runtime/AppShellContext"
import { useMemoryApi } from "../../runtime/MemoryContext"
import { Icon } from "../ui/Icon"
import { TooltipIconButton } from "../ui/TooltipIconButton"
import { MatrixLoader, ReasonStream, ShimmerText } from "../ui/transitions"
import { BranchPicker } from "./BranchPicker"
import { MarkdownText } from "./MarkdownText"
import { ReferencesPanel, useReferenceHighlight } from "./References"

/** Business payload assistant-ui carries through untouched (see convertMessage). */
interface MessageCustom {
  references?: Reference[]
  traceEvents?: TraceEvent[]
  traceStatus?: string | null
  runId?: string | null
}

export interface Attachment {
  id: string
  name: string
  content: string
  /**
   * Ticket 22 (ATT-01): the server's parse state of a SESSION attachment —
   * temporary files belong to one conversation and never to a knowledge base.
   */
  status?: "parsing" | "ready" | "failed" | "promoted" | "retired"
  error?: string | null
  promoted?: boolean
}

export interface ThreadAttachmentsProps {
  attachments: Attachment[]
  onAdd: (files: File[]) => void
  onRemove: (id: string) => void
  /** Ticket 22: promote a ready attachment into the selected knowledge base. */
  onPromote?: (id: string) => void
}

// ---------------------------------------------------------------------------
// Thread root — mem0 layout: 42rem column, scroll viewport, sticky pill dock.
// ---------------------------------------------------------------------------

export function Thread({ attachmentsProps }: { attachmentsProps: ThreadAttachmentsProps }) {
  return (
    <ThreadPrimitive.Root
      className="box-border flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-canvas"
      style={{ "--thread-max-width": "42rem" } as CSSProperties}
    >
      <ThreadPrimitive.Viewport className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto scroll-smooth px-4 pt-8">
        <ThreadWelcome />
        <ThreadPrimitive.Messages
          components={{ UserMessage, EditComposer, AssistantMessage }}
        />
        <ThreadPrimitive.If empty={false}>
          <div className="min-h-8 flex-grow" />
        </ThreadPrimitive.If>
      </ThreadPrimitive.Viewport>

      <div className="relative mx-auto flex w-full max-w-[var(--thread-max-width)] flex-col items-center justify-end px-4 pb-4">
        <ThreadScrollToBottom />
        <AttachmentChips
          attachments={attachmentsProps.attachments}
          onRemove={attachmentsProps.onRemove}
          {...(attachmentsProps.onPromote ? { onPromote: attachmentsProps.onPromote } : {})}
        />
        <Composer attachmentsProps={attachmentsProps} />
      </div>
    </ThreadPrimitive.Root>
  )
}

/** Ticket 22 (ATT-01): the temporary state a session attachment is in. */
const ATTACHMENT_STATUS_LABEL: Record<string, string> = {
  parsing: "解析中…",
  ready: "临时",
  failed: "解析失败",
  promoted: "已提升",
  retired: "已移除",
}

function AttachmentChips({
  attachments,
  onRemove,
  onPromote,
}: {
  attachments: Attachment[]
  onRemove: (id: string) => void
  onPromote?: (id: string) => void
}) {
  if (attachments.length === 0) return null
  return (
    <div className="mb-1.5 flex w-full gap-1.5 overflow-x-auto px-1" aria-live="polite">
      {attachments.map((attachment) => {
        const status = attachment.status ?? "ready"
        const promotable = status === "ready" && onPromote !== undefined
        return (
          <div
            key={attachment.id}
            className="flex min-w-0 max-w-72 flex-none animate-fade-in items-center gap-1.5 rounded-lg border border-line bg-surface py-1 pl-2.5 pr-1.5 text-xs text-muted shadow-card"
          >
            <span
              className="overflow-hidden text-ellipsis whitespace-nowrap"
              title={attachment.name}
            >
              {attachment.name}
            </span>
            <span
              className={`flex-none rounded px-1 text-[10px] ${
                status === "failed"
                  ? "bg-danger/10 text-danger"
                  : status === "promoted"
                    ? "bg-surface-subtle text-ink"
                    : "bg-surface-subtle text-muted"
              }`}
              title={attachment.error ?? ATTACHMENT_STATUS_LABEL[status] ?? status}
            >
              {ATTACHMENT_STATUS_LABEL[status] ?? status}
            </span>
            {promotable ? (
              <button
                type="button"
                onClick={() => onPromote(attachment.id)}
                aria-label={`提升附件到知识库：${attachment.name}`}
                className="flex-none cursor-pointer rounded-md px-1 text-[10px] text-muted/80 transition-colors hover:bg-surface-subtle hover:text-ink"
              >
                提升
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onRemove(attachment.id)}
              aria-label={`移除附件：${attachment.name}`}
              className="grid size-5 flex-none cursor-pointer place-items-center rounded-md text-muted/70 transition-colors hover:bg-surface-subtle hover:text-ink"
            >
              <Icon icon={X} className="size-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function ThreadWelcome() {
  const { openMemory } = useAppShell()
  const { memories } = useMemoryApi()

  return (
    <ThreadPrimitive.Empty>
      <div className="flex w-full flex-1 flex-col items-center justify-center">
        <div className="flex w-full max-w-[var(--thread-max-width)] flex-col items-center text-center">
          <h1 className="text-center text-[2rem] font-bold leading-[1] tracking-[-0.02em] text-ink md:text-4xl">
            NexusRAG · 企业知识智能助手
          </h1>
          <p className="mt-2 w-5/6 text-center text-base text-muted md:w-3/4">
            基于长期记忆与知识库多路检索，为您记住偏好、背景与历史事实
          </p>

          <button
            type="button"
            onClick={openMemory}
            className="mt-2.5 inline-flex items-center gap-1.5 rounded-full border border-brand-line bg-brand-subtle px-3 py-0.5 text-xs font-medium text-brand shadow-card transition-colors hover:bg-brand/10"
          >
            <Icon icon={Brain} className="size-3" />
            {memories.length > 0 ? `已加载 ${memories.length} 条上下文记忆` : "暂无上下文记忆"}
          </button>

          <div className="mt-10 flex w-full flex-col items-center">
            <p className="text-sm font-medium text-ink">今天有什么可以帮您的？</p>
            <ThreadWelcomeSuggestions />
          </div>
        </div>
      </div>
    </ThreadPrimitive.Empty>
  )
}

function ThreadWelcomeSuggestions() {
  return (
    <div className="mt-3 flex w-full flex-col items-center gap-3 md:flex-row md:items-stretch md:justify-center">
      {SUGGESTIONS.map((suggestion, index) => (
        <ThreadPrimitive.Suggestion
          key={suggestion.prompt}
          className="flex w-full grow basis-0 flex-col items-center justify-center rounded-[2rem] border border-line bg-surface p-3 transition-[colors,transform] ease-out hover:bg-brand-subtle active:scale-[0.97] md:max-w-sm animate-suggestion-in"
          style={{ animationDelay: `${index * 45}ms` }}
          prompt={suggestion.prompt}
          method="replace"
        >
          <span className="line-clamp-2 text-ellipsis text-sm font-semibold">
            {suggestion.label}
          </span>
        </ThreadPrimitive.Suggestion>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function Composer({ attachmentsProps }: { attachmentsProps: ThreadAttachmentsProps }) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  return (
    <ComposerPrimitive.Root className="flex w-full flex-wrap items-end rounded-full border border-line bg-surface px-2.5 shadow-composer transition-colors ease-in focus-within:border-brand/20">
      <TooltipIconButton
        tooltip="添加文本附件"
        className="mb-2.5 size-8"
        onClick={() => fileInputRef.current?.click()}
      >
        <Icon icon={Paperclip} className="size-4" />
      </TooltipIconButton>
      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,.md,.json,text/plain,application/json"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files) attachmentsProps.onAdd(Array.from(event.target.files))
          event.target.value = ""
        }}
      />
      <ComposerPrimitive.Input
        rows={1}
        autoFocus
        placeholder="输入消息，向 NexusRAG 提问…"
        className="max-h-40 flex-grow resize-none border-none bg-transparent px-2 py-4 text-sm text-ink outline-none placeholder:text-muted/60 focus:ring-0 disabled:cursor-not-allowed"
      />
      <ComposerAction />
    </ComposerPrimitive.Root>
  )
}

/**
 * One button drives both states so the icon morphs between send and stop
 * instead of swapping elements.
 */
function ComposerAction() {
  const aui = useAui()
  const isRunning = useAuiState((s) => s.thread.isRunning)
  const canSend = useAuiState((s) => s.composer.canSend)

  return (
    <button
      type="button"
      disabled={!isRunning && !canSend}
      onClick={() => {
        if (isRunning) void aui.thread.cancelRun()
        else void aui.composer.send()
      }}
      aria-label={isRunning ? "停止生成" : "发送消息"}
      title={isRunning ? "停止生成" : "发送消息"}
      className={cn(
        "my-2.5 grid size-8 flex-none cursor-pointer place-items-center rounded-full",
        "bg-brand text-white transition-[colors,transform] duration-150 ease-out hover:bg-brand-hover active:scale-[0.97]",
        "disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-brand",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
      )}
    >
      <Icon icon={isRunning ? Square : SendHorizontal} className="size-4" />
    </button>
  )
}

function ThreadScrollToBottom() {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="回到底部"
        className="absolute -top-8 rounded-full border border-line bg-surface shadow-card transition-[opacity,transform] duration-150 ease-out hover:bg-brand-subtle disabled:pointer-events-none disabled:scale-90 disabled:opacity-0"
      >
        <Icon icon={ArrowDown} className="size-4" />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  )
}

// ---------------------------------------------------------------------------
// User turn
// ---------------------------------------------------------------------------

function UserText({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap">{text}</p>
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="grid w-full max-w-[var(--thread-max-width)] auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] gap-y-2 py-4 [&:where(>*)]:col-start-2">
      <ActionBarPrimitive.Root
        hideWhenRunning
        autohide="not-last"
        className="col-start-1 row-start-2 mr-3 mt-2.5 flex flex-col items-end"
      >
        <ActionBarPrimitive.Edit asChild>
          <TooltipIconButton tooltip="编辑" className="size-6">
            <Icon icon={Pencil} className="size-3.5" />
          </TooltipIconButton>
        </ActionBarPrimitive.Edit>
      </ActionBarPrimitive.Root>

      <div className="col-start-2 row-start-2 max-w-[calc(var(--thread-max-width)*0.8)] animate-message-send break-words rounded-3xl bg-brand px-5 py-2.5 text-sm text-white">
        <MessagePrimitive.Parts components={{ Text: UserText }} />
      </div>

      <BranchPicker className="col-span-full col-start-1 row-start-3 -mr-1 justify-end" />
    </MessagePrimitive.Root>
  )
}

function EditComposer() {
  return (
    <ComposerPrimitive.Root className="my-4 flex w-full max-w-[var(--thread-max-width)] flex-col gap-2 rounded-xl bg-brand-subtle">
      <ComposerPrimitive.Input className="flex h-8 w-full resize-none bg-transparent p-4 pb-0 text-ink outline-none" />
      <div className="mx-3 mb-3 flex items-center justify-center gap-2 self-end">
        <ComposerPrimitive.Cancel asChild>
          <button
            type="button"
            className="h-8 cursor-pointer rounded-[2rem] px-3 text-xs text-muted transition-colors hover:bg-surface/80"
          >
            取消
          </button>
        </ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send asChild>
          <button
            type="button"
            className="h-8 cursor-pointer rounded-[2rem] bg-brand px-4 text-xs font-medium text-white transition-colors hover:bg-brand-hover"
          >
            发送
          </button>
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  )
}

// ---------------------------------------------------------------------------
// Assistant turn
// ---------------------------------------------------------------------------

/** Projected trace events → one line per stage, in answer-path order. */
function thinkingLines(events: readonly TraceEvent[] | undefined): string[] {
  if (!events?.length) return []
  const projected: TraceEvent[] = []
  const indexes = new Map<string, number>()
  const normalized = [...events]
    .filter((event) => event.type !== "answer_delta")
    .sort((left, right) => left.sequence - right.sequence)
  normalized.forEach((event) => {
    const key = `${event.stage}:${event.attempt || 1}:${event.round || 0}`
    const existingIndex = indexes.get(key)
    if (existingIndex === undefined) {
      indexes.set(key, projected.length)
      projected.push(event)
    } else {
      projected[existingIndex] = event
    }
  })
  return INSIGHT_PATH_STEPS.map((step) => {
    const event = [...projected].reverse().find((item) => item.stage === step.stage)
    if (!event) return null
    const marker = event.status === "running" ? "●" : event.status === "failed" || event.status === "cancelled" ? "×" : "✓"
    return `${marker} ${step.label} — ${traceEventLabel(event)}`
  }).filter((line): line is string => line !== null)
}

function ThinkingDots() {
  // assistant-ui only re-renders Parts on content changes, so trace events
  // (metadata-only updates) never reach this component through props. Reading
  // the conversation store directly keeps the transcript live.
  const snapshot = useSyncExternalStore(
    conversationStore.subscribe,
    conversationStore.getSnapshot,
  )
  const runningMessage = snapshot.messages.find(
    (message) => message.id === snapshot.runningMessageId,
  )
  const lines = useMemo(
    () => thinkingLines(runningMessage?.traceEvents),
    [runningMessage?.traceEvents],
  )
  // The running stage's label; before the first event lands, a generic hold.
  const running = [...lines].reverse().find((line) => line.startsWith("●"))
  const label = running ? running.slice(2).split(" — ")[0] : "正在思考"
  return (
    <div className="flex flex-col gap-3 py-1" role="status" aria-label={label}>
      <div className="flex h-5 items-center gap-3">
        <MatrixLoader variant="scan" label={label} />
        <ShimmerText text={`${label}…`} />
      </div>
      {lines.length > 0 && <ReasonStream lines={lines} rows={4} />}
    </div>
  )
}

function AssistantText({
  text,
  references,
  onCitationClick,
}: {
  text: string
  references: readonly Reference[]
  onCitationClick?: (referenceId: string) => void
}) {
  const isRunning = useAuiState((s) => s.message.status?.type === "running")
  const custom = useAuiState((s) => s.message.metadata?.custom as MessageCustom | undefined)
  if (!text) return isRunning ? <ThinkingDots /> : null
  return (
    <MarkdownText
      text={text}
      references={references}
      onCitationClick={onCitationClick}
      streaming={isRunning}
    />
  )
}

function AssistantMessage() {
  const { openInsight, showToast } = useAppShell()
  const messageId = useAuiState((s) => s.message.id)
  const custom = useAuiState((s) => s.message.metadata?.custom as MessageCustom | undefined)
  const references = custom?.references ?? []
  const { detailsRef, highlightedId, focusReference } = useReferenceHighlight()
  // 票 29：反馈按钮只在有 run 的完成回答上出现；提交的是"这一条消息 + 这次运行"。
  const runId = custom?.runId ?? null
  const [feedback, setFeedback] = useState<FeedbackRating | null>(null)
  const [reasonPickerOpen, setReasonPickerOpen] = useState(false)
  const [submittingFeedback, setSubmittingFeedback] = useState(false)

  const submitFeedback = async (rating: FeedbackRating, reasonCode?: FeedbackReasonCode) => {
    if (!runId || submittingFeedback) return
    setSubmittingFeedback(true)
    try {
      await submitAnswerFeedback(runId, {
        messageId,
        rating,
        ...(rating === "down" ? { reasonCode: reasonCode ?? "other" } : {}),
      })
      setFeedback(rating)
      setReasonPickerOpen(false)
      showToast("已收到反馈，谢谢")
    } catch (error) {
      showToast(error instanceof Error ? error.message : "反馈提交失败")
    } finally {
      setSubmittingFeedback(false)
    }
  }

  const parts = useMemo(
    () => ({
      Text: (props: { text: string }) => (
        <AssistantText {...props} references={references} onCitationClick={focusReference} />
      ),
    }),
    [references, focusReference],
  )

  return (
    <MessagePrimitive.Root className="relative grid w-full max-w-[var(--thread-max-width)] grid-cols-[auto_auto_1fr] grid-rows-[auto_1fr] py-4">
      <div className="col-span-2 col-start-2 row-start-1 my-1.5 max-w-[calc(var(--thread-max-width)*0.8)] animate-message-in break-words rounded-3xl border border-line bg-surface px-5 py-2.5 leading-7 text-ink shadow-card">
        <MessagePrimitive.Parts components={parts} />
        <ReferencesPanel
          references={references}
          detailsRef={detailsRef}
          highlightedId={highlightedId}
        />
      </div>

      <ActionBarPrimitive.Root
        hideWhenRunning
        autohideFloat="single-branch"
        className="col-start-3 row-start-2 ml-1 flex gap-1 text-muted data-[floating]:absolute data-[floating]:rounded-md data-[floating]:border data-[floating]:border-line data-[floating]:bg-surface data-[floating]:p-1 data-[floating]:shadow-card"
      >
        <ActionBarPrimitive.Copy asChild>
          <TooltipIconButton tooltip="复制" className="size-6">
            <MessagePrimitive.If copied>
              <Icon icon={Check} className="size-3.5" />
            </MessagePrimitive.If>
            <MessagePrimitive.If copied={false}>
              <Icon icon={Copy} className="size-3.5" />
            </MessagePrimitive.If>
          </TooltipIconButton>
        </ActionBarPrimitive.Copy>
        <ActionBarPrimitive.Reload asChild>
          <TooltipIconButton tooltip="重新生成" className="size-6">
            <Icon icon={RefreshCw} className="size-3.5" />
          </TooltipIconButton>
        </ActionBarPrimitive.Reload>
        <TooltipIconButton
          tooltip="回答分析"
          className="size-6"
          onClick={() => openInsight(messageId)}
        >
          <Icon icon={BarChart3} className="size-3.5" />
        </TooltipIconButton>
        {runId ? (
          <>
            <TooltipIconButton
              tooltip={feedback === "up" ? "已标记有帮助" : "有帮助"}
              className="size-6"
              disabled={submittingFeedback}
              onClick={() => void submitFeedback("up")}
            >
              <Icon
                icon={ThumbsUp}
                className={cn("size-3.5", feedback === "up" && "text-brand")}
              />
            </TooltipIconButton>
            <TooltipIconButton
              tooltip={reasonPickerOpen ? "选择需要改进的原因" : "需要改进"}
              className="size-6"
              disabled={submittingFeedback}
              aria-expanded={reasonPickerOpen}
              onClick={() => setReasonPickerOpen((current) => !current)}
            >
              <Icon
                icon={ThumbsDown}
                className={cn("size-3.5", feedback === "down" && "text-red-600")}
              />
            </TooltipIconButton>
          </>
        ) : null}
      </ActionBarPrimitive.Root>

      {/* 票 29：负面反馈带一个原因码（服务端支持的闭集），提交后可被审阅。 */}
      {reasonPickerOpen ? (
        <span
          role="group"
          aria-label="反馈原因"
          className="absolute right-0 bottom-8 z-10 flex flex-wrap items-center gap-1 rounded-md border border-line bg-surface p-1 shadow-card"
        >
          {FEEDBACK_REASON_CODES.map(([code, label]) => (
            <button
              key={code}
              type="button"
              onClick={() => void submitFeedback("down", code)}
              className="cursor-pointer rounded px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-brand"
            >
              {label}
            </button>
          ))}
        </span>
      ) : null}

      <BranchPicker className="col-start-2 row-start-2 -ml-2 mr-2" />
    </MessagePrimitive.Root>
  )
}
