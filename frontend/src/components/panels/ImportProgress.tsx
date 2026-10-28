import * as TooltipPrimitive from "@radix-ui/react-tooltip"
import { Progress as ProgressBar } from "../arc/progress/progress"
import { useEffect, useId, useRef, useState, type ComponentProps } from "react"

import { cn } from "../../lib/cn"
import {
  buildImportSteps,
  estimateImportRemainingMs,
  estimateUploadRemainingMs,
  type ImportProgress as Progress,
  type UploadProgress,
} from "../../lib/ingestProgress"
import { PDF_PROTECTION_GUIDANCE } from "../../lib/qualityReasons"

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

/** Radix 1.4 requires every tooltip root to sit under a provider. */
function ProgressTooltip(props: ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipPrimitive.Provider delayDuration={0}>
      <TooltipPrimitive.Root {...props} />
    </TooltipPrimitive.Provider>
  )
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
  const steps = buildImportSteps(progress, isLocal, uploaded)
  const doneSteps = steps.filter((step) => step.status === "done").length
  const totalSteps = steps.length || 1
  const uploadPercent = uploadProgress?.total
    ? Math.min(
        100,
        Math.round((uploadProgress.loaded / uploadProgress.total) * 100),
      )
    : null
  // One bar spans the whole run: the upload owns the first step's share, every
  // finished stage adds its own. Only a real completion reaches 100% — hold
  // and review states stop just short so the bar never wears the done check.
  const overallPercent =
    progress.status === "uploading"
      ? Math.round(((uploadPercent ?? 0) / 100) * (100 / totalSteps))
      : progress.status === "completed"
        ? 100
        : Math.min(99, Math.round((doneSteps / totalSteps) * 100))
  const progressLabel =
    progress.status === "uploading"
      ? "正在上传文件"
      : progress.status === "queued"
        ? "等待上传"
        : progress.summary
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
    <ProgressTooltip open={open} onOpenChange={setOpen} delayDuration={0}>
      <TooltipPrimitive.Trigger asChild>
        <div
          ref={anchorRef}
          role="group"
          tabIndex={0}
          aria-label={`${fileName} 处理进度`}
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
          <ProgressBar
            value={overallPercent}
            label={progressLabel}
            showValue
          />
          <div className="mt-1.5 flex items-start justify-between gap-2 text-[10px] leading-4 text-faint">
            <span className="min-w-0 break-words" aria-live="polite">
              {syncError
                ? syncError.startsWith("处理时间")
                  ? "处理超时提醒"
                  : "状态同步异常"
                : progress.status === "uploading"
                  ? uploadPercent === 100
                    ? "等待服务器确认"
                    : uploadPercent !== null
                      ? `已上传 ${uploadPercent}%`
                      : "正在上传"
                  : `${doneSteps}/${totalSteps} 阶段`}
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
            ) : null}
          </div>
        </div>
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side="top"
          sideOffset={8}
          ref={tooltipRef}
          id={tooltipId}
          className="z-50 inline-flex w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin) items-center gap-1.5 rounded-md bg-ink px-3 py-1.5 text-xs text-canvas ease-out animate-pop-in pointer-events-none w-72 max-w-[calc(100vw-16px)] max-h-[calc(100dvh-16px)] overflow-y-auto"
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
                  : "text-faint",
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
                            ? "bg-accent-subtle"
                            : "bg-faint",
                    )}
                  />
                  {stage.label}
                </span>
                <span className="shrink-0 text-faint">
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
          <p className="mt-2 border-t border-line pt-2 text-[11px] text-faint">
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
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </ProgressTooltip>
  )
}
