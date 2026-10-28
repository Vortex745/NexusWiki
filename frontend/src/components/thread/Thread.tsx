import { Message } from "../chat/message"
import { Bubble, BubbleContent } from "../chat/bubble"
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from "../chat/message-scroller"
import {
  InputGroup,
  InputGroupTextarea,
} from "../chat/input-group"
import {
  Attachment as AttachmentSurface,
  AttachmentContent,
  AttachmentTitle,
  AttachmentDescription,
  AttachmentActions,
} from "../chat/attachment"
import { TextReveal } from "../arc/text-reveal/text-reveal"
import { Popover, PopoverTrigger, PopoverContent } from "../arc/popover/popover"
import { useEvidence } from "./EvidenceContext"
import { Button as UiButton } from "@/components/ui/Button"
import {
  ActionBarPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  unstable_useComposerInput,
  useAui,
  useAuiState,
} from "@assistant-ui/react"
import { AnimatePresence, motion } from "motion/react"
import type { Reference, TraceEvent } from "@core/conversation"
import {
  ArrowUp,
  ChartColumn,
  Check,
  Copy,
  Pencil,
  Plus,
  RefreshCw,
  Square,
  ThumbsDown,
  ThumbsUp,
  X,
} from "../ui/icons"
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react"

import { useConversation } from "../../conversation/useConversation"
import { cn } from "../../lib/cn"
import { ATTACHMENT_ACCEPT } from "../../lib/constants"
import {
  FEEDBACK_REASON_CODES,
  submitAnswerFeedback,
  type FeedbackRating,
  type FeedbackReasonCode,
} from "../../lib/api"
import { useAppShell } from "../../runtime/AppShellContext"
import { Icon, SwapIcon } from "../ui/Icon"
import { TooltipIconButton } from "../ui/TooltipIconButton"
import { BranchPicker } from "./BranchPicker"
import { AnswerProcess } from "./AnswerProcess"
import { MarkdownText } from "./MarkdownText"
import { useStreamReveal } from "./useStreamReveal"

/** Business payload assistant-ui carries through untouched (see convertMessage). */
interface MessageCustom {
  references?: Reference[]
  traceEvents?: TraceEvent[]
  traceStatus?: string | null
  runId?: string | null
  /** Ticket 31 (FAQ-01B): the direct standard-answer hit, if any. */
  faq?: { entryId: string; version: number; question: string } | null
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
  /** The composer's + button adds a session attachment through this path. */
  onAdd?: (file: File) => void | Promise<void>
  onRemove: (id: string) => void | Promise<void>
  /** Ticket 22: promote a ready attachment into the selected knowledge base. */
  onPromote?: (id: string) => void
}

// ---------------------------------------------------------------------------
// Thread root — shadcn owns scrolling; assistant-ui owns the conversation.
// ---------------------------------------------------------------------------

export function Thread({
  attachmentsProps,
}: {
  attachmentsProps: ThreadAttachmentsProps
}) {
  const { activeThreadId } = useConversation()
  return (
    <ThreadPrimitive.Root
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
      style={{ "--thread-max-width": "48rem" } as CSSProperties}
    >
      {/* Empty thread: the title and composer form ONE vertically centred
          group, matching the reference. The scroller only mounts once there
          is a message, so an empty thread has nothing to scroll. */}
      <ThreadPrimitive.If empty>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-4 pb-6 md:px-8">
          <TextReveal
            as="h1"
            text="随时可以开始。"
            className="text-center text-2xl font-semibold tracking-tight md:text-3xl"
            delay={0.1}
          />
          <div className="flex w-full max-w-[var(--thread-max-width)] flex-col gap-2">
            <AttachmentChips {...attachmentsProps} />
            <Composer onAdd={attachmentsProps.onAdd} />
          </div>
        </div>
      </ThreadPrimitive.If>
      <ThreadPrimitive.If empty={false}>
        <MessageScrollerProvider
          key={activeThreadId}
          autoScroll
          defaultScrollPosition="end"
        >
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent className="mx-auto w-full max-w-[var(--thread-max-width)] px-5 py-8 md:px-8">
                <ThreadPrimitive.Messages
                  components={{ UserMessage, EditComposer, AssistantMessage }}
                />
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton aria-label="回到底部" />
          </MessageScroller>
        </MessageScrollerProvider>
        <div className="mx-auto flex w-full max-w-[var(--thread-max-width)] flex-col gap-2 px-4 pb-4 md:px-8">
          <AttachmentChips {...attachmentsProps} />
          <Composer onAdd={attachmentsProps.onAdd} />
          <p className="text-center text-xs text-faint">
            回答由知识库检索生成，请核对关键信息
          </p>
        </div>
      </ThreadPrimitive.If>
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
}: ThreadAttachmentsProps) {
  if (!attachments.length) return null
  return (
    <div className="flex w-full gap-2 overflow-x-auto" aria-live="polite">
      {attachments.map((attachment) => {
        const status = attachment.status ?? "ready"
        return (
          <AttachmentSurface
            key={attachment.id}
            size="sm"
            state={
              status === "parsing"
                ? "processing"
                : status === "failed"
                  ? "error"
                  : "done"
            }
            data-attachment-chip
          >
            <AttachmentContent>
              <AttachmentTitle title={attachment.name}>
                {attachment.name}
              </AttachmentTitle>
              <AttachmentDescription title={attachment.error ?? undefined}>
                {ATTACHMENT_STATUS_LABEL[status] ?? status}
              </AttachmentDescription>
            </AttachmentContent>
            <AttachmentActions>
              {status === "ready" && onPromote ? (
                <UiButton
                  variant="ghost"
                  size="xs"
                  aria-label={"提升附件到知识库：" + attachment.name}
                  onClick={() => onPromote(attachment.id)}
                >
                  提升
                </UiButton>
              ) : null}
              <UiButton
                variant="ghost"
                size="icon-xs"
                aria-label={"移除附件：" + attachment.name}
                onClick={() => void onRemove(attachment.id)}
              >
                <Icon data-icon="inline-start" icon={X} />
              </UiButton>
            </AttachmentActions>
          </AttachmentSurface>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

const COMPOSER_COMPLETIONS = [
  "常见问题",
  "技术排查",
  "回复草稿",
  "解决思路",
  "如何",
  "为什么",
  "请帮我",
  "总结一下",
  "对比",
  "解释",
  "检索",
  "知识库",
  "文档",
  "评测",
  "反馈",
  "专家",
  "上下文记忆",
]

function findCompletion(text: string): {
  suggestions: string[]
  prefixLength: number
} {
  const max = Math.min(8, text.length)
  for (let length = max; length > 0; length -= 1) {
    const prefix = text.slice(-length).toLowerCase()
    if (!/[\u3400-\u9fffA-Za-z0-9]/.test(prefix)) continue
    const matches = COMPOSER_COMPLETIONS.filter(
      (word) =>
        word.toLowerCase().startsWith(prefix) &&
        word.toLowerCase() !== prefix,
    )
    if (matches.length > 0) {
      return { suggestions: matches.slice(0, 3), prefixLength: length }
    }
  }
  return { suggestions: [], prefixLength: 0 }
}

function Composer({
  onAdd,
}: {
  onAdd?: (file: File) => void | Promise<void>
}) {
  return (
    <ComposerPrimitive.Root>
      <ComposerSurface onAdd={onAdd} />
    </ComposerPrimitive.Root>
  )
}

function ComposerSurface({
  onAdd,
}: {
  onAdd?: (file: File) => void | Promise<void>
}) {
  const { value, setText } = unstable_useComposerInput()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [active, setActive] = useState(-1)
  const { suggestions, prefixLength } = useMemo(
    () => findCompletion(value),
    [value],
  )

  useEffect(() => {
    setActive(-1)
  }, [value])

  const apply = (suggestion: string) => {
    const next = value.slice(0, value.length - prefixLength) + suggestion
    setText(next)
    setActive(-1)
    requestAnimationFrame(() => {
      const node = inputRef.current
      node?.focus()
      node?.setSelectionRange(next.length, next.length)
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (suggestions.length > 0) {
      if (event.key === "Tab") {
        event.preventDefault()
        setActive((current) => (current + 1) % suggestions.length)
        return
      }
      if (
        event.key === "ArrowRight" &&
        inputRef.current?.selectionStart === value.length
      ) {
        event.preventDefault()
        apply(suggestions[0])
        return
      }
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        active >= 0 &&
        suggestions[active]
      ) {
        event.preventDefault()
        apply(suggestions[active])
        return
      }
    }
    if (event.key === "Escape" && value.length > 0) {
      event.preventDefault()
      setText("")
      setActive(-1)
    }
  }

  return (
    <div className="relative w-full">
      <ComposerSuggestions
        suggestions={suggestions}
        active={active}
        onPick={apply}
      />
      <div className="flex w-full items-center gap-1 rounded-full border border-line bg-surface p-1.5 shadow-[var(--shadow-resting)] transition-shadow focus-within:ring-2 focus-within:ring-accent/25">
        <AddAttachmentButton onAdd={onAdd} />
        <ComposerPrimitive.Input asChild>
          <textarea
            ref={inputRef}
            rows={1}
            autoFocus
            aria-label="消息"
            placeholder="询问 NexusWiki"
            onKeyDown={onKeyDown}
            className="max-h-40 min-h-9 w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-6 text-ink outline-none placeholder:text-faint md:text-[15px]"
          />
        </ComposerPrimitive.Input>
        <div className="flex flex-none items-center pr-0.5">
          <ComposerAction />
        </div>
      </div>
    </div>
  )
}

function AddAttachmentButton({
  onAdd,
}: {
  onAdd?: (file: File) => void | Promise<void>
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        aria-label="选择附件"
        accept={ATTACHMENT_ACCEPT}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file && onAdd) void onAdd(file)
          event.target.value = ""
        }}
      />
      <UiButton
        variant="ghost"
        size="icon-sm"
        type="button"
        aria-label="添加附件"
        title="添加附件"
        disabled={!onAdd}
        onClick={() => inputRef.current?.click()}
        className="size-9 flex-none rounded-full text-faint disabled:opacity-30"
      >
        <Icon data-icon="inline-start" icon={Plus} />
      </UiButton>
    </>
  )
}

function ComposerSuggestions({
  suggestions,
  active,
  onPick,
}: {
  suggestions: string[]
  active: number
  onPick: (suggestion: string) => void
}) {
  return (
    <AnimatePresence>
      {suggestions.length > 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 10, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.95 }}
          transition={{ type: "spring", stiffness: 500, damping: 30 }}
          className="absolute bottom-full left-3 z-20 mb-2 flex items-center gap-0.5 rounded-xl border border-line bg-surface px-1 py-1 shadow-[var(--shadow-raised)]"
        >
          {suggestions.map((word, index) => (
            <button
              key={word}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(word)}
              className={cn(
                "whitespace-nowrap px-3 py-1 text-xs font-medium transition-colors",
                index === active ? "text-accent" : "text-faint hover:text-ink",
                index !== 0 && "border-l border-line pl-3",
              )}
            >
              {word}
            </button>
          ))}
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

/**
 * One button drives both states so the send/stop glyph springs between them
 * instead of swapping elements.
 *
 * `opacity` has to be in the transition list: the enabled/disabled swap moves
 * the whole button between 0.3 and 1, and a list that only names colors and
 * transforms snaps it instead.
 */
function ComposerAction() {
  const aui = useAui()
  const isRunning = useAuiState((s) => s.thread.isRunning)
  const canSend = useAuiState((s) => s.composer.canSend)

  return (
    <UiButton
      variant="default"
      size="icon-lg"
      type="button"
      disabled={!isRunning && !canSend}
      onClick={() => {
        if (isRunning) void aui.thread.cancelRun()
        else void aui.composer.send()
      }}
      aria-label={isRunning ? "停止生成" : "发送消息"}
      title={isRunning ? "停止生成" : "发送消息"}
      className={cn(
        "grid size-9 flex-none place-items-center rounded-full shadow-[var(--shadow-resting)]",
        // Follow the app accent instead of hardcoding the reference's blue.
        "!bg-accent !text-on-primary hover:!bg-primary-hover",
        "active:scale-[0.97]",
        "disabled:opacity-40",
      )}
    >
      <SwapIcon
        data-icon="inline-start"
        from={ArrowUp}
        to={Square}
        at={isRunning}
      />
    </UiButton>
  )
}

// ---------------------------------------------------------------------------
// User turn
// ---------------------------------------------------------------------------

function UserText({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap">{text}</p>
}

const USER_PARTS = { Text: UserText }

function UserMessage() {
  const id = useAuiState((s) => s.message.id)
  return (
    <MessageScrollerItem messageId={id} scrollAnchor>
      <MessagePrimitive.Root asChild>
        <Message align="end" className="flex-col items-end gap-2">
          <ActionBarPrimitive.Root
            hideWhenRunning
            autohide="not-last"
            className="col-start-1 row-start-2 mr-3 mt-2.5 flex flex-col items-end"
          >
            <ActionBarPrimitive.Edit asChild>
              <TooltipIconButton tooltip="编辑" className="size-6">
                <Icon data-icon="inline-start" icon={Pencil} />
              </TooltipIconButton>
            </ActionBarPrimitive.Edit>
          </ActionBarPrimitive.Root>

          {/* User messages render immediately after sending. */}
          <Bubble variant="secondary" align="end">
            <BubbleContent>
              <MessagePrimitive.Parts components={USER_PARTS} />
            </BubbleContent>
          </Bubble>

          <BranchPicker className="col-span-full col-start-1 row-start-3 -mr-1 justify-end" />
        </Message>
      </MessagePrimitive.Root>
    </MessageScrollerItem>
  )
}

function EditComposer() {
  return (
    <ComposerPrimitive.Root className="my-4 flex w-full max-w-[var(--thread-max-width)] flex-col gap-2">
      <InputGroup data-material="composer-edit">
        <ComposerPrimitive.Input asChild>
          <InputGroupTextarea
            aria-label="编辑消息"
            className="min-h-20 resize-none"
          />
        </ComposerPrimitive.Input>
      </InputGroup>
      <div className="mx-3 mb-3 flex items-center justify-center gap-2 self-end">
        <ComposerPrimitive.Cancel asChild>
          <UiButton
            variant="ghost"
            size="sm"
            type="button"
            className="h-8 px-3"
          >
            取消
          </UiButton>
        </ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send asChild>
          <UiButton
            variant="default"
            size="sm"
            type="button"
            className="h-8 px-4"
          >
            发送
          </UiButton>
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  )
}

// ---------------------------------------------------------------------------
// Assistant turn
// ---------------------------------------------------------------------------

/**
 * Hands the per-message citation handler to the text part. It travels through
 * context rather than props because the part component itself must stay a
 * module constant — see ASSISTANT_PARTS.
 */
const CitationClickContext = createContext<
  ((referenceId: string) => void) | null
>(null)

/** Whether this message's text should type in from nothing. See AssistantMessage. */
const RevealIntentContext = createContext(false)

function AssistantText({ text }: { text: string }) {
  const isRunning = useAuiState((s) => s.message.status?.type === "running")
  const custom = useAuiState((s) => s.message.metadata?.custom) as
    | MessageCustom
    | undefined
  const onCitationClick = useContext(CitationClickContext)
  // The done frame lands before assistant-ui flips the message status, so the
  // terminal trace is the earlier signal that the reply no longer has to type.
  const complete = !isRunning || custom?.traceStatus != null
  const revealed = useStreamReveal(
    text,
    useContext(RevealIntentContext),
    complete,
  )
  // Keep the per-word blur-in alive while a live stream is still revealing.
  // A closed run has already flushed to the full reply.
  const revealing = revealed.length < text.length
  // AnswerProcess owns the waiting state even before a text part exists.
  if (!text) return null
  return (
    <MarkdownText
      text={revealed}
      references={custom?.references ?? []}
      onCitationClick={onCitationClick ?? undefined}
      streaming={(isRunning && !complete) || revealing}
    />
  )
}

/**
 * Module-level, shared by every assistant message and every render.
 *
 * `MessagePrimitive.Parts` renders `components.Text` as the element type
 * directly, so a part component created inside a render is a *new type* on every
 * SSE token: React discards the fiber, `useStreamReveal` re-initialises already
 * caught up, and the answer lands as one block with no per-word blur-in. Anything
 * a part needs beyond its own text must come from `useAuiState` or context.
 */
const ASSISTANT_PARTS = { Text: AssistantText }

function CopyAction() {
  const copied = useAuiState((state) => state.message.isCopied)
  return (
    <ActionBarPrimitive.Copy asChild>
      <TooltipIconButton tooltip={copied ? "已复制" : "复制"} className="size-6">
        <span data-slot="copy-feedback" data-copied={copied} aria-hidden>
          <Icon data-icon="inline-start" data-copy-glyph="copy" icon={Copy} />
          <Icon data-icon="inline-start" data-copy-glyph="check" icon={Check} />
        </span>
      </TooltipIconButton>
    </ActionBarPrimitive.Copy>
  )
}

function AssistantMessage() {
  const { openTrace, showToast } = useAppShell()
  const openEvidence = useEvidence()
  const messageId = useAuiState((s) => s.message.id)
  const isRunning = useAuiState((s) => s.message.status?.type === "running")
  const hasError = useAuiState((s) => s.message.status?.type === "incomplete")
  // Frozen at this message's first render. A live run mounts here while it is
  // still open and has no parts at all; history and a reload mount already
  // complete. Deciding on the message instead of on the text part is what lets a
  // withheld reply that lands in one frame still type itself out: by then the
  // part mounts with the finished text in hand, and "already finished" is
  // indistinguishable from "old".
  const [revealFromZero] = useState(isRunning)
  const custom = useAuiState(
    (s) => s.message.metadata?.custom as MessageCustom | undefined,
  )
  const references = custom?.references ?? []
  // 票 29：反馈按钮只在有 run 的完成回答上出现；提交的是"这一条消息 + 这次运行"。
  const showReference = (referenceId: string) =>
    openEvidence({ messageId, referenceId })
  const runId = custom?.runId ?? null
  const [feedback, setFeedback] = useState<FeedbackRating | null>(null)
  const [reasonPickerOpen, setReasonPickerOpen] = useState(false)
  const [submittingFeedback, setSubmittingFeedback] = useState(false)

  const submitFeedback = async (
    rating: FeedbackRating,
    reasonCode?: FeedbackReasonCode,
  ) => {
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

  return (
    <MessageScrollerItem messageId={messageId}>
      <MessagePrimitive.Root asChild>
        <Message className="assistant-turn flex-col gap-3">
          {/* The message surface groups the answer, process and source actions. */}
          <Bubble variant="ghost" className="w-full">
            <BubbleContent className="w-full">
              <AnswerProcess
                events={custom?.traceEvents ?? []}
                traceStatus={custom?.traceStatus}
                references={references}
                isRunning={isRunning}
                hasError={hasError}
                onReferenceClick={showReference}
              />
              <RevealIntentContext.Provider value={revealFromZero}>
                <CitationClickContext.Provider value={showReference}>
                  <MessagePrimitive.Parts components={ASSISTANT_PARTS} />
                </CitationClickContext.Provider>
              </RevealIntentContext.Provider>
              {custom?.faq ? (
                <div className="mt-2 flex items-center gap-1.5 text-[11px] text-faint">
                  <span
                    className="rounded bg-brand-subtle px-1.5 py-0.5 text-[10px] font-medium text-brand"
                    title={`命中知识库标准问答：${custom.faq.question}`}
                  >
                    FAQ 标准答案 · v{custom.faq.version}
                  </span>
                  <span>来自知识库标准问答（FAQ），非生成内容</span>
                </div>
              ) : null}
              {references.length > 0 ? (
                <UiButton
                  variant="outline"
                  size="sm"
                  className="mt-4"
                  onClick={() => openEvidence({ messageId })}
                >
                  参考来源 {references.length}
                </UiButton>
              ) : null}
            </BubbleContent>
          </Bubble>

          <ActionBarPrimitive.Root
            autohideFloat="single-branch"
            className={cn(
              "assistant-actions col-start-3 row-start-2 ml-1 flex gap-1 text-faint",
              /* Fades in when the answer finishes landing instead of appearing by
             conditional render. The run closing is not the gate on its own: the
             knowledge routes close it while the reveal is still typing, so
             `.assistant-turn:has([data-stream-revealing])` in index.css holds the
             bar back as well. Opacity only, no slide: the bar sits in a grid cell
             so a translate would read as a nudge. */
              "transition-opacity duration-300 ease-out",
              isRunning ? "pointer-events-none opacity-0" : "opacity-100",
              "data-[floating]:absolute data-[floating]:rounded-md data-[floating]:border data-[floating]:border-line data-[floating]:bg-surface data-[floating]:p-1",
            )}
          >
            <CopyAction />
            <ActionBarPrimitive.Reload asChild>
              <TooltipIconButton tooltip="重新生成" className="size-6">
                <Icon data-icon="inline-start" icon={RefreshCw} />
              </TooltipIconButton>
            </ActionBarPrimitive.Reload>
            {/* Opens the desktop panel or the mobile Sheet for this answer. */}
            <span>
              <TooltipIconButton
                tooltip="查看链路"
                className="size-6"
                onClick={() => openTrace(messageId)}
              >
                <Icon data-icon="inline-start" icon={ChartColumn} />
              </TooltipIconButton>
            </span>
            {runId ? (
              <>
                <TooltipIconButton
                  tooltip={feedback === "up" ? "已标记有帮助" : "有帮助"}
                  className="size-6"
                  disabled={submittingFeedback}
                  onClick={() => void submitFeedback("up")}
                >
                  <Icon
                    data-icon="inline-start"
                    icon={ThumbsUp}
                    className={cn("", feedback === "up" && "text-brand")}
                  />
                </TooltipIconButton>
                <Popover
                  open={reasonPickerOpen}
                  onOpenChange={setReasonPickerOpen}
                >
                  <PopoverTrigger asChild>
                    <TooltipIconButton
                      tooltip={
                        reasonPickerOpen ? "选择需要改进的原因" : "需要改进"
                      }
                      className="size-6"
                      disabled={submittingFeedback}
                      aria-expanded={reasonPickerOpen}
                    >
                      <Icon
                        data-icon="inline-start"
                        icon={ThumbsDown}
                        className={cn("", feedback === "down" && "text-danger")}
                      />
                    </TooltipIconButton>
                  </PopoverTrigger>
                  <PopoverContent
                    side="top"
                    align="end"
                    aria-label="反馈原因"
                    className="flex-row flex-wrap gap-1"
                  >
                    {FEEDBACK_REASON_CODES.map(([code, label]) => (
                      <UiButton
                        variant="ghost"
                        size="sm"
                        key={code}
                        disabled={submittingFeedback}
                        onClick={() => void submitFeedback("down", code)}
                      >
                        {label}
                      </UiButton>
                    ))}
                  </PopoverContent>
                </Popover>
              </>
            ) : null}
          </ActionBarPrimitive.Root>

          <BranchPicker className="col-start-2 row-start-2 -ml-2 mr-2" />
        </Message>
      </MessagePrimitive.Root>
    </MessageScrollerItem>
  )
}
