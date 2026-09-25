import { ChevronRight, RefreshCw } from "lucide"
import { useEffect, useRef, useState } from "react"

import type { StatusChannel, StatusPayload } from "../lib/api"
import { cn } from "../lib/cn"
import { CHANNEL_LABELS, STATUS_LABELS } from "../lib/constants"
import { useStatus } from "../lib/useStatus"
import { Icon } from "./ui/Icon"

interface ConnectionView {
  offline: boolean
  degraded: boolean
  label: string
  summary: string
  checkedAt: string
}

function deriveConnection(payload: StatusPayload | null, error: string | null): ConnectionView {
  if (error && !payload) {
    const message = error.length > 80 ? `${error.slice(0, 80)}…` : error
    return {
      offline: true,
      degraded: false,
      label: "服务连接异常",
      summary: "无法探测",
      checkedAt: `检查失败：${message}`,
    }
  }
  if (!payload) {
    return {
      offline: false,
      degraded: false,
      label: "知识库检测中…",
      summary: "检查中…",
      checkedAt: "正在连接…",
    }
  }

  const { elasticsearch, neo4j, chat } = payload.channels
  const hasContent = payload.hasKnowledgeBaseContent === true
  // 与后端 mode 同语义：只看两个核心基础设施通道（Chat 探测 degraded 时
  // 回答仍然工作，不据此拉低整个演示的状态）。
  const allOk = elasticsearch.status === "connected" && neo4j.status === "connected"
  const anyDown = [elasticsearch, neo4j].some((channel) => channel.status === "disconnected")

  const label = !hasContent
    ? "知识库暂无内容"
    : anyDown
      ? "知识库部分离线"
      : !allOk
        ? "知识库降级运行"
        : "知识库已就绪"

  const summary: string[] = []
  if (elasticsearch.status === "connected") summary.push(CHANNEL_LABELS.elasticsearch.short)
  if (neo4j.status === "connected") summary.push(CHANNEL_LABELS.neo4j.short)
  if (chat.status === "connected") summary.push(CHANNEL_LABELS.chat.short)

  return {
    offline: !hasContent,
    degraded: hasContent && !allOk && !anyDown,
    label,
    summary: summary.length ? summary.join(" · ") : "降级运行",
    checkedAt: `检查时间：${new Date(payload.checkedAt).toLocaleTimeString()}`,
  }
}

const DOT_CLASS: Record<string, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-600",
  gray: "bg-neutral-300",
}

function StatusChannelRow({
  channelKey,
  channel,
  config,
}: {
  channelKey: string
  channel: StatusChannel
  config: StatusPayload["config"]
}) {
  const meta = CHANNEL_LABELS[channelKey] ?? { name: channelKey, short: channelKey }
  // Ticket 44: the diagnostics config carries HOST-ONLY endpoints — never a
  // raw URL or credential. Optional channels (rerank/mcp/webSearch/langfuse)
  // have no endpoint line at all; their detail lives in channel.detail.
  const urlKey =
    channelKey === "elasticsearch"
      ? "esNodeHost"
      : channelKey === "neo4j"
        ? "neo4jUriHost"
        : channelKey === "chat"
          ? "chatBaseUrlHost"
          : null
  const url = urlKey ? (config?.[urlKey as keyof typeof config] ?? "") : ""
  const status = STATUS_LABELS[channel.status] ?? { text: channel.status, dot: "gray" as const }

  const parts: string[] = []
  if (url) parts.push(url)
  if (typeof channel.responseTimeMs === "number") parts.push(`${channel.responseTimeMs} ms`)
  if (channelKey === "chat" && config?.chatModel) parts.push(`默认 ${config.chatModel}`)
  if (!url && channel.detail) parts.push(channel.detail)

  return (
    <li className="rounded-xl border border-line bg-surface p-3 shadow-card">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={cn("size-[6px] flex-none rounded-full", DOT_CLASS[status.dot])} aria-hidden />
          <span className="text-xs font-semibold text-ink">{meta.name}</span>
        </div>
        <span
          className={cn(
            "font-mono text-[10px] font-semibold uppercase",
            status.dot === "green"
              ? "text-green-700 dark:text-green-400"
              : status.dot === "amber"
                ? "text-amber-700 dark:text-amber-400"
                : status.dot === "red"
                  ? "text-red-600 dark:text-red-400"
                  : "text-muted/70",
          )}
        >
          {status.text}
        </span>
      </div>
      <p className="font-mono text-[11px] text-muted/80">{parts.join(" · ") || "—"}</p>
      {channel.error ? (
        <p className="mt-1 text-[11px] text-red-600">
          {channel.error.length > 160 ? `${channel.error.slice(0, 160)}…` : channel.error}
        </p>
      ) : null}
    </li>
  )
}

export function StatusPopover() {
  const { payload, error, refresh } = useStatus()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onEscape)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onEscape)
    }
  }, [open])

  const connection = deriveConnection(payload, error)
  const dotClass = connection.offline
    ? "bg-red-600"
    : connection.degraded
      ? "bg-amber-500"
      : "bg-emerald-500"

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-left text-xs text-muted transition-colors hover:bg-surface-subtle hover:text-ink"
      >
        <span className={cn("size-1.75 flex-none rounded-full", dotClass)} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{connection.label}</span>
        <span className="font-mono text-[10px] text-muted/60" aria-hidden>
          {connection.summary}
        </span>
        <Icon icon={ChevronRight} className="size-3 shrink-0 rotate-90 text-muted/60" />
      </button>

      <div
        role="dialog"
        aria-label="知识库连接详情"
        inert={!open}
        className={cn(
          "absolute bottom-[calc(100%+6px)] left-0 right-0 z-50 max-h-[min(60vh,380px)]",
          "origin-bottom-left overflow-y-auto rounded-xl border border-line bg-surface p-3.5 shadow-dialog",
          "transition-[opacity,scale] duration-150 ease-out",
          open ? "scale-100 opacity-100" : "pointer-events-none scale-[0.97] opacity-0",
        )}
      >
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-ink">服务状态</h3>
            <button
              type="button"
              onClick={() => void refresh()}
              aria-label="刷新连接状态"
              title="刷新"
              className="grid size-6 cursor-pointer place-items-center rounded text-muted/60 transition-colors hover:bg-surface-subtle hover:text-ink"
            >
              <Icon icon={RefreshCw} className="size-3.5" />
            </button>
          </div>
          <p className="mb-2 font-mono text-[11px] text-muted/70">{connection.checkedAt}</p>
          {payload ? (
            <ul className="grid gap-2">
              {Object.entries(payload.channels).map(([channelKey, channel]) => (
                <StatusChannelRow
                  key={channelKey}
                  channelKey={channelKey}
                  channel={channel}
                  config={payload.config}
                />
              ))}
            </ul>
          ) : null}
      </div>
    </div>
  )
}
