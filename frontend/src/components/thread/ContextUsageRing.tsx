import { useEffect, useState } from "react"
import { useReducedMotion } from "motion/react"

import { useConversation } from "../../conversation/useConversation"
import { fetchContextUsage, type ContextUsagePayload } from "../../lib/api"
import { cn } from "../../lib/cn"

const SIZE = 16
const STROKE = 2.5
const RADIUS = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const POLL_MS = 1500
const POLL_LIMIT_MS = 60_000

/**
 * Conversation-context meter (2026-10-31).
 *
 * `usedTokens` is the session footprint since the last fold into long-term
 * memory — NOT the literal prompt size (the runtime only ever sends the
 * rolling summary plus six validated pairs). Reaching the budget folds the
 * session into the account profile and drops the gauge back to the summary.
 *
 * Only the latest assistant answer renders this; it refreshes on thread
 * switch and after each run settles, and polls while a fold is in flight.
 */
export function ContextUsageRing() {
  const { activeThreadId, isRunning } = useConversation()
  const reduce = useReducedMotion()
  const [usage, setUsage] = useState<ContextUsagePayload | null>(null)

  useEffect(() => {
    if (!activeThreadId || isRunning) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let retriedAfterFull = false
    const deadline = Date.now() + POLL_LIMIT_MS

    const load = async () => {
      let next: ContextUsagePayload | null = null
      try {
        next = await fetchContextUsage(activeThreadId)
      } catch {
        // The meter is advisory: a failed read never affects chat.
        return
      }
      if (cancelled || !next) return
      setUsage(next)
      if (next.compacting && Date.now() < deadline) {
        timer = setTimeout(() => void load(), POLL_MS)
      } else if (!retriedAfterFull && next.percent >= 100) {
        // The fold starts before the response closes, but one delayed read
        // absorbs the race where this first fetch won anyway.
        retriedAfterFull = true
        timer = setTimeout(() => void load(), 800)
      }
    }
    void load()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [activeThreadId, isRunning])

  if (!usage) return null

  const warning = usage.percent >= 90
  const offset = CIRCUMFERENCE * (1 - usage.percent / 100)
  const title = usage.compacting
    ? "正在把本次会话压缩进长期记忆…"
    : `上下文用量 ${usage.percent}%（约 ${usage.usedTokens.toLocaleString()} / ${usage.budgetTokens.toLocaleString()} tokens 估算）。达到 100% 后自动压缩并写入长期记忆。`

  return (
    <span
      role="progressbar"
      aria-label="上下文用量"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={usage.percent}
      aria-valuetext={`${usage.percent}%`}
      title={title}
      data-context-usage={usage.percent}
      data-context-compacting={usage.compacting ? "true" : "false"}
      className="inline-flex h-6 items-center gap-1.5 text-faint"
    >
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        aria-hidden="true"
        className={cn("shrink-0", usage.compacting && !reduce && "animate-pulse")}
      >
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
          className="stroke-line"
        />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          className={cn(
            "transition-[stroke-dashoffset] duration-300 ease-out",
            warning ? "stroke-warning" : "stroke-ink",
            reduce && "transition-none",
          )}
        />
      </svg>
      <span className="text-[11px] leading-none tabular-nums">{usage.percent}%</span>
    </span>
  )
}
