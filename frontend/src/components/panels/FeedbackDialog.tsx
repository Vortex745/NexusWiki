import { MessageSquareWarning, X } from "lucide"
import { useCallback, useEffect, useRef, useState } from "react"

import {
  FEEDBACK_REASON_CODES,
  fetchFeedbackList,
  updateFeedbackStatus,
  type FeedbackPayload,
  type FeedbackRating,
  type FeedbackStatus,
} from "../../lib/api"
import { cn } from "../../lib/cn"
import { useAppShell } from "../../runtime/AppShellContext"
import { Icon } from "../ui/Icon"

const STATUS_LABELS: Record<FeedbackStatus, string> = {
  open: "待审阅",
  reviewed: "已审阅",
  dismissed: "已忽略",
}

const RATING_LABELS: Record<FeedbackRating, string> = {
  up: "有帮助",
  down: "需改进",
}

const REASON_LABELS = new Map(FEEDBACK_REASON_CODES)

/**
 * 票 29（EVAL-02B）：答案反馈的审阅面。列表与详情都只读服务端（租户作用域）；
 * 状态流转是唯一的写操作。读者账号没有 review/admin 作用域，服务端 403。
 */
export function FeedbackDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { showToast } = useAppShell()
  const [records, setRecords] = useState<FeedbackPayload[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<"" | FeedbackStatus>("")
  const [ratingFilter, setRatingFilter] = useState<"" | FeedbackRating>("")
  const [runFilter, setRunFilter] = useState("")
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setRecords(
        await fetchFeedbackList({
          ...(statusFilter ? { status: statusFilter } : {}),
          ...(ratingFilter ? { rating: ratingFilter } : {}),
          ...(runFilter.trim() ? { runId: runFilter.trim() } : {}),
        })
      )
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [statusFilter, ratingFilter, runFilter])

  useEffect(() => {
    if (!open) return
    void refresh()
  }, [open, refresh])

  const review = async (record: FeedbackPayload, status: FeedbackStatus) => {
    if (busyId) return
    setBusyId(record.id)
    try {
      const updated = await updateFeedbackStatus(record.id, status)
      setRecords((current) =>
        current.map((item) => (item.id === updated.id ? updated : item))
      )
      showToast(`已标记为${STATUS_LABELS[status]}`)
    } catch (reviewError) {
      showToast(reviewError instanceof Error ? reviewError.message : "反馈状态更新失败")
    } finally {
      setBusyId(null)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      aria-labelledby="feedback-title"
      className="m-auto h-[min(680px,calc(100dvh-48px))] w-[min(720px,calc(100vw-32px))] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-dialog backdrop:bg-black/20 open:grid open:animate-dialog-enter max-md:m-0 max-md:h-dvh max-md:w-screen max-md:rounded-none max-md:border-0"
    >
      <div className="flex h-13 flex-none items-center justify-between border-b border-line px-5 max-md:px-4">
        <div className="flex items-center gap-2">
          <Icon icon={MessageSquareWarning} className="size-4 text-muted" />
          <h2 id="feedback-title" className="text-sm font-semibold text-ink">
            答案反馈审阅
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭反馈审阅"
          title="关闭"
          className="grid size-7 flex-none cursor-pointer place-items-center rounded-md text-muted/70 transition-colors hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-brand"
        >
          <Icon icon={X} className="size-3.5" />
        </button>
      </div>

      <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4 max-md:px-4">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-[11px] text-muted/70">
            <span>状态</span>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as "" | FeedbackStatus)}
              className="cursor-pointer rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-ink outline-none focus:border-brand focus-visible:outline-2 focus-visible:outline-brand"
            >
              <option value="">全部</option>
              <option value="open">待审阅</option>
              <option value="reviewed">已审阅</option>
              <option value="dismissed">已忽略</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted/70">
            <span>评分</span>
            <select
              value={ratingFilter}
              onChange={(event) => setRatingFilter(event.target.value as "" | FeedbackRating)}
              className="cursor-pointer rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-ink outline-none focus:border-brand focus-visible:outline-2 focus-visible:outline-brand"
            >
              <option value="">全部</option>
              <option value="up">有帮助</option>
              <option value="down">需改进</option>
            </select>
          </label>
          <label className="flex flex-1 flex-col gap-1 text-[11px] text-muted/70">
            <span>运行 id（provenance）</span>
            <input
              value={runFilter}
              onChange={(event) => setRunFilter(event.target.value)}
              placeholder="run-…"
              className="w-full rounded-md border border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-brand focus-visible:outline-2 focus-visible:outline-brand"
            />
          </label>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="h-7 cursor-pointer rounded-md border border-line bg-surface px-2.5 text-[11px] text-muted transition-colors hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "读取中…" : "应用筛选"}
          </button>
        </div>

        {error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400" role="alert">
            {error}
          </p>
        ) : null}
        {!loading && !error && records.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted/70">没有符合条件的反馈。</p>
        ) : null}

        <ul className="flex flex-col gap-2">
          {records.map((record) => (
            <li
              key={record.id}
              className="rounded-lg border border-line bg-surface-subtle/40 px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-[11px]">
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-medium",
                      record.rating === "up"
                        ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400"
                        : "bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400",
                    )}
                  >
                    {RATING_LABELS[record.rating]}
                  </span>
                  <span className="rounded-full bg-surface-subtle px-2 py-0.5 text-[10px] text-muted">
                    {STATUS_LABELS[record.status]}
                  </span>
                  {record.reasonCode ? (
                    <span className="text-muted/70">
                      原因：{REASON_LABELS.get(record.reasonCode) ?? record.reasonCode}
                    </span>
                  ) : null}
                </span>
                <span className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busyId !== null || record.status === "reviewed"}
                    onClick={() => void review(record, "reviewed")}
                    className="cursor-pointer rounded-md border border-line bg-surface px-2 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    标记已审阅
                  </button>
                  <button
                    type="button"
                    disabled={busyId !== null || record.status === "dismissed"}
                    onClick={() => void review(record, "dismissed")}
                    className="cursor-pointer rounded-md border border-line bg-surface px-2 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    忽略
                  </button>
                  <button
                    type="button"
                    disabled={busyId !== null || record.status === "open"}
                    onClick={() => void review(record, "open")}
                    className="cursor-pointer rounded-md border border-line bg-surface px-2 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    重新打开
                  </button>
                </span>
              </div>
              {record.comment ? (
                <p className="mt-1.5 text-xs leading-relaxed text-ink">{record.comment}</p>
              ) : null}
              <p
                className="mt-1 truncate font-mono text-[10px] text-muted/50"
                title={`run ${record.runId} · message ${record.messageId} · session ${record.sessionId}`}
              >
                运行 {record.runId} · 消息 {record.messageId} · 会话 {record.sessionId} · 主体{" "}
                {record.subjectId}
              </p>
              <p className="mt-0.5 font-mono text-[10px] text-muted/40">
                更新于 {record.updatedAt}
                {record.evidenceIds.length > 0 ? ` · 证据 ${record.evidenceIds.length} 条` : ""}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </dialog>
  )
}
