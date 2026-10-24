import { Alert, AlertDescription } from "@/components/primitives/alert"
import { Button as UiButton } from "@/components/primitives/button"
import { MessageSquareWarning } from "../ui/icons"
import { useCallback, useState } from "react"

import {
  FEEDBACK_REASON_CODES,
  fetchFeedbackList,
  updateFeedbackStatus,
  type FeedbackPayload,
  type FeedbackRating,
  type FeedbackStatus,
} from "../../lib/api"
import { cn } from "../../lib/cn"
import { copyText } from "../../lib/clipboard"
import { useAppShell } from "../../runtime/AppShellContext"
import { Dialog } from "../ui/Dialog"
import {
  Button,
  EmptyState,
  Field,
  Select,
  StatusBadge,
  TextInput,
} from "../ui/Controls"

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
export function FeedbackDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const { showToast } = useAppShell()
  const [records, setRecords] = useState<FeedbackPayload[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<"" | FeedbackStatus>("")
  const [ratingFilter, setRatingFilter] = useState<"" | FeedbackRating>("")
  const [runFilter, setRunFilter] = useState("")
  const [busyId, setBusyId] = useState<string | null>(null)

  const filtersActive =
    statusFilter !== "" || ratingFilter !== "" || runFilter.trim() !== ""

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setRecords(
        await fetchFeedbackList({
          ...(statusFilter ? { status: statusFilter } : {}),
          ...(ratingFilter ? { rating: ratingFilter } : {}),
          ...(runFilter.trim() ? { runId: runFilter.trim() } : {}),
        }),
      )
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      )
    } finally {
      setLoading(false)
    }
  }, [statusFilter, ratingFilter, runFilter])

  const review = async (record: FeedbackPayload, status: FeedbackStatus) => {
    if (busyId) return
    setBusyId(record.id)
    try {
      const updated = await updateFeedbackStatus(record.id, status)
      setRecords((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      )
      showToast(`已标记为${STATUS_LABELS[status]}`)
    } catch (reviewError) {
      showToast(
        reviewError instanceof Error ? reviewError.message : "反馈状态更新失败",
      )
    } finally {
      setBusyId(null)
    }
  }

  const copyProvenance = async (record: FeedbackPayload) => {
    const text = `run ${record.runId} · message ${record.messageId} · session ${record.sessionId} · subject ${record.subjectId}`
    try {
      await copyText(text)
      showToast("已复制完整溯源 id")
    } catch {
      showToast("复制失败，请检查浏览器权限")
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      onOpen={() => void refresh()}
      title="答案反馈审阅"
      titleId="feedback-title"
      icon={MessageSquareWarning}
      tier="work"
      toolbar={
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void refresh()
          }}
        >
          <Field label="状态">
            <Select
              value={statusFilter}
              onChange={(event) =>
                setStatusFilter(event.target.value as "" | FeedbackStatus)
              }
            >
              <option value="">全部</option>
              <option value="open">待审阅</option>
              <option value="reviewed">已审阅</option>
              <option value="dismissed">已忽略</option>
            </Select>
          </Field>
          <Field label="评分">
            <Select
              value={ratingFilter}
              onChange={(event) =>
                setRatingFilter(event.target.value as "" | FeedbackRating)
              }
            >
              <option value="">全部</option>
              <option value="up">有帮助</option>
              <option value="down">需改进</option>
            </Select>
          </Field>
          <div className="min-w-40 flex-1">
            <Field label="运行 id（provenance）">
              <TextInput
                value={runFilter}
                onChange={(event) => setRunFilter(event.target.value)}
                placeholder="run-…"
                className=""
              />
            </Field>
          </div>
          <Button
            type="submit"
            tone="primary"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? "读取中…" : "应用筛选"}
          </Button>
          {filtersActive ? (
            <Button
              onClick={() => {
                setStatusFilter("")
                setRatingFilter("")
                setRunFilter("")
              }}
            >
              清除筛选
            </Button>
          ) : null}
        </form>
      }
    >
      {error ? (
        <Alert variant="destructive" role="alert" className="border px-3 py-2">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {!loading && !error && records.length === 0 ? (
        <EmptyState
          icon={MessageSquareWarning}
          message={
            filtersActive
              ? "没有符合当前筛选条件的反馈。"
              : "还没有收到用户反馈。"
          }
          action={
            filtersActive ? (
              <Button
                size="sm"
                onClick={() => {
                  setStatusFilter("")
                  setRatingFilter("")
                  setRunFilter("")
                }}
              >
                清除筛选
              </Button>
            ) : undefined
          }
        />
      ) : null}

      {records.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {records.map((record) => (
            <li
              key={record.id}
              className="rounded-[14px] border border-line bg-surface-subtle px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex flex-wrap items-center gap-2 text-[11px]">
                  <StatusBadge
                    tone={record.rating === "up" ? "success" : "danger"}
                  >
                    {RATING_LABELS[record.rating]}
                  </StatusBadge>
                  <StatusBadge>{STATUS_LABELS[record.status]}</StatusBadge>
                  {record.reasonCode ? (
                    <span className="text-muted-foreground">
                      原因：
                      {REASON_LABELS.get(record.reasonCode) ??
                        record.reasonCode}
                    </span>
                  ) : null}
                </span>
                {/* One high-contrast object per card. All three actions used to be
                    pixel-identical neutral buttons, so nothing read as the action. */}
                <span className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    tone="primary"
                    disabled={busyId !== null || record.status === "reviewed"}
                    onClick={() => void review(record, "reviewed")}
                  >
                    标记已审阅
                  </Button>
                  <Button
                    size="sm"
                    disabled={busyId !== null || record.status === "dismissed"}
                    onClick={() => void review(record, "dismissed")}
                  >
                    忽略
                  </Button>
                  <Button
                    size="sm"
                    disabled={busyId !== null || record.status === "open"}
                    onClick={() => void review(record, "open")}
                  >
                    重新打开
                  </Button>
                </span>
              </div>
              {record.comment ? (
                <p className="mt-1.5 text-xs leading-relaxed text-ink">
                  {record.comment}
                </p>
              ) : null}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-faint">
                {/* Four full UUIDs on one truncated line were the loudest thing on
                    every card. Short id here, full set on copy. */}
                <span title={`run ${record.runId}`}>
                  run {record.runId.slice(0, 8)}
                </span>
                <UiButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => void copyProvenance(record)}
                  className="px-1 py-0.5"
                >
                  复制完整溯源
                </UiButton>
                <span>更新于 {record.updatedAt}</span>
                {record.evidenceIds.length > 0 ? (
                  <span>证据 {record.evidenceIds.length} 条</span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </Dialog>
  )
}
