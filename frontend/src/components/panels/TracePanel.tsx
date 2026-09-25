import { X } from "lucide"

import { useConversation } from "../../conversation/useConversation"
import { cn } from "../../lib/cn"
import { Icon } from "../ui/Icon"
import { TraceSteps } from "./TraceSteps"

export function TracePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { messages } = useConversation()
  // Bind to the latest assistant message so the chain updates live while streaming.
  const message = [...messages].reverse().find((item) => item.role === "assistant") ?? null
  const events = message?.traceEvents ?? []

  return (
    <aside
      data-open={open}
      aria-label="实时回答追踪"
      className={cn(
        "flex min-h-0 flex-none flex-col overflow-hidden border-l border-line bg-surface-subtle/50",
        open ? "w-65" : "w-0",
        "max-md:hidden",
      )}
    >
      <div className="flex h-12 items-center justify-between border-b border-line px-3.5">
        <h2 className="text-xs font-semibold text-ink">执行链路</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭追踪面板"
          title="关闭"
          className="grid size-6 cursor-pointer place-items-center rounded text-muted/70 transition-colors hover:bg-surface-subtle hover:text-ink"
        >
          <Icon icon={X} className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4" aria-live="polite">
        {events.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted/70">
            {message?.status === "running" ? "正在准备回答步骤…" : "发起提问后将实时展示回答步骤"}
          </p>
        ) : (
          <TraceSteps events={events} />
        )}
      </div>
    </aside>
  )
}
