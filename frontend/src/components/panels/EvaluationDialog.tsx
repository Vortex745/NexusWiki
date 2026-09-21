import { FlaskConical, X } from "lucide"
import { useCallback, useEffect, useRef, useState } from "react"

import {
  createEvaluationTask,
  fetchEvaluationDatasets,
  fetchEvaluationTask,
  type EvaluationDatasetsPayload,
  type EvaluationTaskDetail,
  type EvaluationTaskStage,
} from "../../lib/api"
import { EVALUATION_POLL_MS } from "../../lib/constants"
import { cn } from "../../lib/cn"
import { Icon } from "../ui/Icon"

const STAGE_LABELS: Record<EvaluationTaskStage, string> = {
  queued: "排队中",
  preparing: "准备语料",
  running: "真实问答",
  cleaning: "清理资源",
  completed: "已完成",
  completed_with_errors: "完成（含失败）",
  failed: "失败",
}

const TERMINAL_STAGES: ReadonlySet<EvaluationTaskStage> = new Set([
  "completed",
  "completed_with_errors",
  "failed",
])

/** Transient stages in execution order (queued is the pre-step). */
const ACTIVE_ORDER: EvaluationTaskStage[] = ["preparing", "running", "cleaning"]

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "不适用"
  return `${Math.round(value * 100)}%`
}

function StageStepper({ stage }: { stage: EvaluationTaskStage }) {
  if (TERMINAL_STAGES.has(stage)) return null
  const activeIndex = ACTIVE_ORDER.indexOf(stage)
  return (
    <ol className="flex items-center gap-1.5" aria-label="评测进度">
      {ACTIVE_ORDER.map((step, index) => {
        const state = index < activeIndex ? "done" : index === activeIndex ? "active" : "pending"
        return (
          <li key={step} className="flex items-center gap-1.5">
            <span
              aria-current={state === "active" ? "step" : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium",
                state === "active" && "bg-brand-subtle text-brand",
                state === "done" && "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400",
                state === "pending" && "bg-surface-subtle text-muted/70",
              )}
            >
              {state === "active" ? (
                <span className="size-1.5 animate-pulse rounded-full bg-brand" aria-hidden />
              ) : null}
              {STAGE_LABELS[step]}
            </span>
            {index < ACTIVE_ORDER.length - 1 ? (
              <span className="text-[10px] text-muted/50" aria-hidden>
                →
              </span>
            ) : null}
          </li>
        )
      })}
      <span className="ml-1 text-[11px] text-muted/70">{STAGE_LABELS[stage]}…</span>
    </ol>
  )
}

function StageBadge({ stage }: { stage: EvaluationTaskStage }) {
  return (
    <span
      className={cn(
        "flex-none rounded-full px-2 py-0.5 text-[10px] font-medium",
        stage === "completed" && "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400",
        (stage === "failed" || stage === "completed_with_errors") &&
          "bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400",
        !TERMINAL_STAGES.has(stage) && "bg-brand-subtle text-brand",
      )}
    >
      {STAGE_LABELS[stage]}
    </span>
  )
}

function CleanupLine({ detail }: { detail: EvaluationTaskDetail }) {
  if (!detail.cleanup) return null
  const { cleanup } = detail
  const ok =
    cleanup.esIndex !== "failed" &&
    cleanup.graphProvenance !== "failed" &&
    cleanup.esIndex !== "skipped"
  return (
    <p className="text-[11px] text-muted/70">
      资源清理：
      <span className={cn("font-medium", ok ? "text-green-700 dark:text-green-400" : "text-red-600")}>
        {ok ? "已完成" : "失败"}
      </span>
      <span className="ml-2 font-mono">
        索引 {cleanup.esIndex}
        {cleanup.esError ? `（${cleanup.esError}）` : ""} · 图谱 {cleanup.graphProvenance}
        {cleanup.graphError ? `（${cleanup.graphError}）` : ""}
      </span>
    </p>
  )
}

export function EvaluationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const pollTimer = useRef<number | null>(null)

  const [datasets, setDatasets] = useState<EvaluationDatasetsPayload | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [task, setTask] = useState<EvaluationTaskDetail | null>(null)
  const [taskMissing, setTaskMissing] = useState(false)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current)
      pollTimer.current = null
    }
  }, [])

  // Load the built-in samples each time the dialog opens.
  useEffect(() => {
    if (!open) return
    setLoadError(null)
    fetchEvaluationDatasets()
      .then((payload) => {
        setDatasets(payload)
        setSelectedId((current) => current ?? payload.datasets[0]?.id ?? null)
      })
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : String(error))
      })
  }, [open])

  useEffect(
    () => () => {
      stopPolling()
    },
    [stopPolling],
  )

  const startPolling = useCallback(
    (taskId: string) => {
      stopPolling()
      pollTimer.current = window.setInterval(() => {
        void (async () => {
          try {
            const detail = await fetchEvaluationTask(taskId)
            if (detail === null) {
              // 服务重启或记录被清理：任务只存在于创建它的进程。
              setTaskMissing(true)
              stopPolling()
              return
            }
            setTask(detail)
            if (TERMINAL_STAGES.has(detail.stage)) stopPolling()
          } catch {
            // 单次轮询失败不中断任务，下一次轮询会重试。
          }
        })()
      }, EVALUATION_POLL_MS)
    },
    [stopPolling],
  )

  const handleRun = async () => {
    if (!selectedId || submitting) return
    setSubmitting(true)
    setTask(null)
    setTaskMissing(false)
    try {
      const summary = await createEvaluationTask(selectedId)
      // 先展示 202 返回的初始状态，再进入轮询。
      setTask({
        ...summary,
        config: { chatModel: "", rerankModel: null, embeddingModel: "", rerankSource: "unknown" },
        cases: [],
        metrics: { version: "", metrics: {} },
        cleanup: null,
      })
      startPolling(summary.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setLoadError(`提交失败：${message}`)
    } finally {
      setSubmitting(false)
    }
  }

  const selected = datasets?.datasets.find((item) => item.id === selectedId) ?? null
  const cases = task?.cases ?? []
  const aggregatePrecision = task?.metrics.metrics.precision ?? null

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      aria-labelledby="evaluation-title"
      className="m-auto h-[min(640px,calc(100dvh-48px))] w-[min(560px,calc(100vw-32px))] overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-dialog backdrop:bg-black/20 open:flex open:animate-dialog-enter open:flex-col max-md:m-0 max-md:h-dvh max-md:w-screen max-md:rounded-none max-md:border-0"
    >
      <div className="flex h-12 flex-none items-center justify-between border-b border-line px-5 max-md:px-4">
        <div className="flex items-center gap-2">
          <Icon icon={FlaskConical} className="size-4 text-muted" />
          <h2 id="evaluation-title" className="text-sm font-semibold text-ink">
            运行评测
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭评测"
          title="关闭"
          className="grid size-7 flex-none cursor-pointer place-items-center rounded-md text-muted/70 transition-colors hover:bg-surface-subtle hover:text-ink"
        >
          <Icon icon={X} className="size-3.5" />
        </button>
      </div>

      <section className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-5 max-md:px-4">
        {/* 内置样例选择 */}
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-ink">内置样例</h3>
          {loadError ? <p className="text-xs text-red-600">{loadError}</p> : null}
          {!datasets && !loadError ? (
            <p className="px-1 py-4 text-center text-xs text-muted/70">正在读取内置样例…</p>
          ) : null}
          {datasets?.datasets.map((item) => (
            <label
              key={item.id}
              className={cn(
                "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs transition-colors",
                selectedId === item.id
                  ? "border-brand bg-brand-subtle/40"
                  : "border-line bg-surface-subtle/40 hover:bg-surface-subtle",
              )}
            >
              <input
                type="radio"
                name="evaluation-dataset"
                value={item.id}
                checked={selectedId === item.id}
                onChange={() => setSelectedId(item.id)}
                disabled={submitting || (task !== null && !TERMINAL_STAGES.has(task.stage))}
                className="mt-0.5 accent-neutral-900 dark:accent-neutral-200"
              />
              <span className="min-w-0">
                <span className="block font-medium text-ink">{item.name}</span>
                <span className="mt-0.5 block text-[11px] text-muted/70">{item.description}</span>
                <span className="mt-0.5 block font-mono text-[10px] text-muted/50">
                  v{item.version} · {item.caseCount} 题 · {item.passageCount} 段语料
                </span>
              </span>
            </label>
          ))}
          {datasets ? (
            <p className="text-[11px] text-muted/50">
              默认模型：Chat {datasets.defaults.chatModel}
              {datasets.defaults.rerankModel ? ` · Rerank ${datasets.defaults.rerankModel}` : " · Rerank 未配置"}
              {" · "}
              Embedding {datasets.defaults.embeddingModel}
            </p>
          ) : null}
        </div>

        <button
          type="button"
          disabled={!selectedId || submitting || (task !== null && !TERMINAL_STAGES.has(task.stage))}
          onClick={() => void handleRun()}
          className="mt-4 inline-flex h-9 w-full flex-none cursor-pointer items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 text-xs font-medium text-white shadow-sm transition-all hover:bg-neutral-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 dark:bg-neutral-200 dark:text-neutral-900 dark:hover:bg-white"
        >
          {task !== null && !TERMINAL_STAGES.has(task.stage)
            ? "评测进行中…"
            : submitting
              ? "提交中…"
              : "运行评测"}
        </button>

        {/* 任务进度与结果 */}
        {task ? (
          <div className="mt-4 flex min-h-0 flex-1 flex-col gap-3" aria-live="polite">
            <div className="flex items-center justify-between gap-2">
              <StageStepper stage={task.stage} />
              <StageBadge stage={task.stage} />
            </div>

            {taskMissing ? (
              <p className="rounded-lg border border-line bg-surface-subtle/40 px-3 py-2.5 text-xs text-muted">
                该评测记录只存在于当前服务进程，重启后不可查询。请重新运行。
              </p>
            ) : null}

            {task.error ? (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
                任务失败：{task.error}
              </p>
            ) : null}

            {cases.map((item) => (
              <article key={item.caseId} className="rounded-lg border border-line bg-surface-subtle/40 px-3 py-2.5">
                <header className="flex items-center justify-between gap-2">
                  <h4 className="min-w-0 truncate text-xs font-semibold text-ink" title={item.question}>
                    {item.question}
                  </h4>
                  <span
                    className={cn(
                      "flex-none rounded-full px-2 py-0.5 text-[10px] font-medium",
                      item.outcome === "answered"
                        ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400"
                        : "bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400",
                    )}
                  >
                    {item.outcome === "answered" ? "已回答" : "失败"}
                  </span>
                </header>
                {item.answer ? (
                  <p className="mt-2 rounded-md bg-surface px-2.5 py-2 text-xs leading-relaxed text-ink">
                    {item.answer}
                  </p>
                ) : null}
                {item.error ? <p className="mt-2 text-[11px] text-red-600">{item.error}</p> : null}
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-muted/70">
                  <div className="flex justify-between gap-2">
                    <dt>Precision</dt>
                    <dd className="font-mono font-semibold text-ink">
                      {formatPercent(item.metrics.precision ?? null)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>耗时</dt>
                    <dd className="font-mono">{item.durationMs} ms</dd>
                  </div>
                </dl>
                {item.retrievedPassageIds.length > 0 ? (
                  <p className="mt-1.5 truncate font-mono text-[10px] text-muted/50" title={item.retrievedPassageIds.join(" → ")}>
                    证据顺序：{item.retrievedPassageIds.join(" → ")}
                  </p>
                ) : null}
                <p className="mt-1 font-mono text-[10px] text-muted/40">参考答案：{item.referenceAnswer}</p>
              </article>
            ))}

            {aggregatePrecision ? (
              <p className="text-[11px] text-muted/70">
                汇总 Precision：
                <span className="ml-1 font-mono text-sm font-semibold text-ink">
                  {formatPercent(aggregatePrecision.value)}
                </span>
                <span className="ml-2">
                  （有效样本 {aggregatePrecision.sampleSize}，不适用 {aggregatePrecision.notApplicable}）
                </span>
              </p>
            ) : null}

            {task.cleanup ? <CleanupLine detail={task} /> : null}
          </div>
        ) : null}
      </section>
    </dialog>
  )
}
