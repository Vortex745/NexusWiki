import { Tooltip, TooltipTrigger, TooltipContent } from "../primitives/tooltip"
import { Progress as ProgressBar } from "../primitives/progress"
import { useEffect, useId, useRef, useState } from "react"

import { cn } from "../../lib/cn"
import {
  buildImportSteps,
  estimateImportRemainingMs,
  estimateUploadRemainingMs,
  type ImportProgress as Progress,
  type UploadProgress,
} from "../../lib/ingestProgress"
import { PDF_PROTECTION_GUIDANCE } from "../../lib/qualityReasons"
import { Check, X } from "../ui/icons"
import { Icon } from "../ui/Icon"

const STAGE_STATUS = {
  pending: "等待中",
  running: "处理中",
  done: "已完成",
  failed: "失败",
  skipped: "未执行",
  cancelled: "已取消",
}

function formatRemainingTime(milliseconds: number): string {
  const seconds = Math.ceil(milliseconds / 1000)
  if (seconds < 60) return `约 ${Math.max(5, Math.ceil(seconds / 5) * 5)} 秒`
  if (seconds < 60 * 60) return `约 ${Math.ceil(seconds / 60)} 分钟`
  return `约 ${Math.ceil(seconds / 3600)} 小时`
}

export function ImportProgress({
  fileName,
  progress,
  syncError,
  checkedAt,
  isLocal,
  uploaded,
  uploadProgress,
  processingStartedAt,
  fileSize,
}: {
  fileName: string
  progress: Progress
  syncError?: string | null
  checkedAt?: string
  isLocal: boolean
  uploaded: boolean
  uploadProgress?: UploadProgress
  processingStartedAt?: number
  fileSize: number
}) {
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(Date.now())
  const anchorRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const tooltipId = useId()
  const failed = progress.status === "failed"
  const completed = progress.status === "completed"
  const done = progress.stages.filter((stage) => stage.status === "done").length
  const steps = buildImportSteps(progress, isLocal, uploaded)
  const uploadPercent = uploadProgress?.total
    ? Math.min(
        100,
        Math.round((uploadProgress.loaded / uploadProgress.total) * 100),
      )
    : null
  const remainingMs =
    progress.status === "uploading" && uploadProgress
      ? estimateUploadRemainingMs(uploadProgress, now)
      : estimateImportRemainingMs(progress, processingStartedAt, now, fileSize)

  useEffect(() => {
    if (progress.status !== "uploading" && progress.status !== "processing")
      return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [progress.status])

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <div
          ref={anchorRef}
          role="group"
          tabIndex={0}
          aria-label={`${fileName} 处理进度`}
          aria-describedby={open ? tooltipId : undefined}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onClick={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && open) {
              event.preventDefault()
              event.stopPropagation()
              setOpen(false)
            }
          }}
          className="mt-2 cursor-help rounded-sm py-1 outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          {progress.status === "uploading" && uploadPercent !== null ? (
            <ProgressBar
              value={uploadPercent}
              aria-label="上传进度"
              className="mb-2"
            />
          ) : null}
          <ol
            className="grid"
            style={{
              gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))`,
            }}
          >
            {steps.map((step, index) => {
              const stepDone = step.status === "done"
              const stepFailed =
                step.status === "failed" || step.status === "cancelled"
              const stepRunning = step.status === "running"
              return (
                <li
                  key={step.name}
                  className="relative min-w-0 text-center"
                  aria-current={stepRunning ? "step" : undefined}
                >
                  {index < steps.length - 1 ? (
                    <span
                      aria-hidden
                      className={cn(
                        "absolute left-1/2 top-[7px] h-0.5 w-full transition-colors duration-150 ease-out",
                        stepDone ? "bg-success" : "bg-line",
                      )}
                    />
                  ) : null}
                  <span
                    aria-hidden
                    className={cn(
                      "relative z-10 mx-auto grid size-4 place-items-center rounded-full border text-[9px] transition-colors duration-150 ease-out",
                      stepDone
                        ? "border-success bg-success text-white"
                        : stepFailed
                          ? "border-danger bg-danger text-white"
                          : stepRunning
                            ? "border-brand bg-brand-subtle text-brand"
                            : "border-line bg-surface text-muted-foreground",
                    )}
                  >
                    {stepDone ? (
                      <Icon icon={Check} className="size-2.5" />
                    ) : stepFailed ? (
                      <Icon icon={X} className="size-2.5" />
                    ) : stepRunning ? (
                      <span className="size-1.5 rounded-full bg-brand" />
                    ) : null}
                  </span>
                  <span
                    className={cn(
                      "mt-1 block truncate text-[10px] leading-4",
                      stepRunning
                        ? "font-medium text-brand"
                        : stepDone
                          ? "text-ink"
                          : stepFailed
                            ? "text-danger"
                            : "text-muted-foreground",
                    )}
                  >
                    {step.label}
                  </span>
                  <span className="sr-only">{STAGE_STATUS[step.status]}</span>
                </li>
              )
            })}
          </ol>
          <div className="mt-1.5 flex items-start justify-between gap-2 text-[10px] leading-4 text-muted-foreground">
            <span className="min-w-0 break-words" aria-live="polite">
              {syncError
                ? syncError.startsWith("处理时间")
                  ? "处理超时提醒"
                  : "状态同步异常"
                : progress.status === "uploading" && uploadPercent === 100
                  ? "等待服务器确认"
                  : progress.summary}
              {progress.status === "uploading" &&
              uploadPercent !== null &&
              uploadPercent < 100
                ? ` ${uploadPercent}%`
                : ""}
            </span>
            {progress.status === "uploading" ||
            progress.status === "processing" ? (
              <span className="max-w-[45%] shrink-0 text-right tabular-nums">
                {remainingMs === null
                  ? progress.status === "processing" &&
                    processingStartedAt &&
                    now - processingStartedAt > 45_000
                    ? "已超过预估时间"
                    : "剩余时间估算中"
                  : `预计还需 ${formatRemainingTime(remainingMs)}`}
              </span>
            ) : progress.stages.length ? (
              <span className="shrink-0 tabular-nums">
                {done}/{progress.stages.length} 阶段
              </span>
            ) : null}
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={8}
        ref={tooltipRef}
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none w-72 max-w-[calc(100vw-16px)] max-h-[calc(100dvh-16px)] overflow-y-auto"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="font-semibold">处理详情</span>
          <span
            className={cn(
              "text-[10px] transition-colors duration-150 ease-out",
              failed
                ? "text-danger"
                : completed
                  ? "text-success"
                  : "text-muted-foreground",
            )}
          >
            {progress.summary}
          </span>
        </div>
        {progress.stages.length ? (
          <ul className="mt-2 flex flex-col gap-2">
            {progress.stages.map((stage) => (
              <li
                key={stage.name}
                className="flex items-center justify-between gap-2 text-[11px]"
              >
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 rounded-full transition-colors duration-150 ease-out",
                      stage.status === "done"
                        ? "bg-success"
                        : stage.status === "failed"
                          ? "bg-danger"
                          : stage.status === "running"
                            ? "bg-primary"
                            : "bg-faint",
                    )}
                  />
                  {stage.label}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {STAGE_STATUS[stage.status]}
                  {stage.durationMs !== null
                    ? ` · ${(stage.durationMs / 1000).toFixed(1)}s`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {progress.chunkCount !== null || progress.parser ? (
          <p className="mt-2 border-t border-line pt-2 text-[11px] text-muted-foreground">
            {progress.chunkCount !== null
              ? `${progress.chunkCount} 个切片`
              : ""}
            {progress.parser ? ` · ${progress.parser}` : ""}
          </p>
        ) : null}
        {progress.embeddingRateLimitCount > 0 ? (
          <p className="mt-2 border-t border-line pt-2 text-[11px] text-warning">
            embedding 服务限流 {progress.embeddingRateLimitCount} 次
            {progress.rateLimitWaitMs > 0
              ? `，等待 ${(progress.rateLimitWaitMs / 1000).toFixed(1)}s`
              : ""}
          </p>
        ) : null}
        {progress.retryCount > 0 ? (
          <p className="mt-2 text-[11px] text-warning">
            失败尝试 {progress.retryCount} 次
            {progress.retryAt
              ? `，下次重试 ${new Date(progress.retryAt).toLocaleTimeString()}`
              : ""}
          </p>
        ) : null}
        {progress.outcome?.userGuidance ? (
          <p className="mt-2 break-words text-[11px] text-warning">
            {PDF_PROTECTION_GUIDANCE}
          </p>
        ) : null}
        {progress.error ? (
          <p className="mt-2 break-words text-[11px] text-danger">
            {progress.error}
          </p>
        ) : null}
        {syncError ? (
          <p className="mt-2 break-words text-[11px] text-warning">
            状态查询失败，正在重新同步：{syncError}
          </p>
        ) : null}
        {checkedAt ? (
          <p className="mt-2 text-[10px] text-faint">
            状态更新于 {new Date(checkedAt).toLocaleTimeString()}
          </p>
        ) : null}
      </TooltipContent>
    </Tooltip>
  )
}
