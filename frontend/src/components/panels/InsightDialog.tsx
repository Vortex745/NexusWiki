import { BarChart3, X } from "lucide"
import { useEffect, useMemo, useRef } from "react"

import { useConversation } from "../../conversation/useConversation"
import { Icon } from "../ui/Icon"
import { TraceSteps } from "./TraceSteps"

// ---------------------------------------------------------------------------
// Insight dialog
//
// Ticket 16: the old RAGAS tab (a file-backed metric read) is gone — the
// evaluation surface is the dedicated 运行评测 entry (EvaluationDialog), and
// this dialog keeps only the answer-path view it was named for.
// ---------------------------------------------------------------------------

export function InsightDialog({
  open,
  messageId,
  onClose,
}: {
  open: boolean
  messageId: string | null
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { messages } = useConversation()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  const message = useMemo(() => {
    if (messageId) {
      const selected = messages.find((item) => item.id === messageId && item.role === "assistant")
      if (selected) return selected
    }
    return (
      [...messages].reverse().find((item) => item.role === "assistant" && item.traceEvents?.length) ??
      [...messages].reverse().find((item) => item.role === "assistant") ??
      null
    )
  }, [messages, messageId])

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      aria-labelledby="insight-title"
      className="m-auto h-[min(620px,calc(100dvh-48px))] w-[min(540px,calc(100vw-32px))] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-dialog backdrop:bg-black/20 open:grid open:animate-dialog-enter max-md:m-0 max-md:h-dvh max-md:w-screen max-md:rounded-none max-md:border-0"
    >
      <div className="flex h-13 items-center justify-between border-b border-line px-5 max-md:px-4">
        <div className="flex items-center gap-2">
          <Icon icon={BarChart3} className="size-4 text-muted" />
          <h2 id="insight-title" className="text-sm font-semibold text-ink">
            回答分析
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭回答分析"
          title="关闭"
          className="grid size-7 flex-none cursor-pointer place-items-center rounded-md text-muted/70 transition-colors hover:bg-surface-subtle hover:text-ink"
        >
          <Icon icon={X} className="size-3.5" />
        </button>
      </div>

      <section className="min-h-0 overflow-y-auto px-5 py-4 max-md:px-4" aria-label="回答路径">
        {message?.traceEvents?.length ? (
          <div className="mx-auto w-[min(100%,420px)] py-1">
            <TraceSteps events={message.traceEvents} />
          </div>
        ) : (
          <p className="px-4 py-10 text-center text-xs text-muted/70">当前还没有可查看的回答路径</p>
        )}
      </section>
    </dialog>
  )
}
