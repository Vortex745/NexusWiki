import { FlaskConical, X } from "lucide"
import { useCallback, useEffect, useRef, useState } from "react"

import {
  createEvaluationTask,
  EvaluationRequestError,
  fetchEvaluationDatasets,
  fetchEvaluationTask,
  listEvaluationTasks,
  type EvaluationCaseResult,
  type EvaluationDatasetsPayload,
  type EvaluationTaskDetail,
  type EvaluationTaskStage,
  type EvaluationTaskSummary,
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

/**
 * Every metric a case reports, in display order: the six retrieval metrics
 * (ticket 06), the three BLEU scores (ticket 07) and the three ROUGE scores
 * (ticket 08) — twelve in total.
 */
const CASE_METRICS: Array<[string, string]> = [
  ["precision", "Precision"],
  ["recall", "Recall"],
  ["ndcg@3", "NDCG@3"],
  ["ndcg@10", "NDCG@10"],
  ["mrr", "MRR"],
  ["map", "MAP"],
  ["bleu-1", "BLEU-1"],
  ["bleu-2", "BLEU-2"],
  ["bleu-4", "BLEU-4"],
  ["rouge-1", "ROUGE-1"],
  ["rouge-2", "ROUGE-2"],
  ["rouge-l", "ROUGE-L"],
]

const ORDERING_REASON_LABELS: Record<string, string> = {
  not_configured: "未配置专用重排",
  below_threshold: "候选过少，无需重排",
  unavailable: "重排服务不可用",
  multi_query_aggregation: "多路检索合并顺序",
}

function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "不适用"
  return value.toFixed(3)
}

/** Score source of one case's ranking — an unscored order is never dressed up. */
function OrderingNote({ ordering }: { ordering?: EvaluationCaseResult["ordering"] }) {
  if (!ordering) return null
  const dedicated = ordering.source === "dedicated_rerank"
  return (
    <p className="mt-1 text-[10px] text-muted/50">
      评分来源：
      <span className={dedicated ? "text-brand" : "text-amber-600 dark:text-amber-400"}>
        {dedicated ? "专用重排" : "原始顺序（未重排）"}
      </span>
      {!dedicated && ordering.reason
        ? `（${ORDERING_REASON_LABELS[ordering.reason] ?? ordering.reason}）`
        : ""}
    </p>
  )
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

/**
 * 票 14：清理结果独立于运行结果呈现——有残留就不能读成"毫无问题的成功"，没有残留
 * 也不该被说成失败（skipped＝本次从未创建专用资源）。错误文本由服务端脱敏。
 */
function CleanupLine({ detail }: { detail: EvaluationTaskDetail }) {
  const cleanup = detail.cleanup
  if (!cleanup) return null
  const incomplete =
    cleanup.esIndex === "failed" || cleanup.graphProvenance === "failed"
  const neverCreated = cleanup.esIndex === "skipped"
  const label = incomplete
    ? "未完成（可能仍有残留）"
    : neverCreated
      ? "无残留（未创建专用资源）"
      : "已完成"
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface-subtle/40 px-3 py-2">
      <p className="text-[11px] text-muted/70">
        资源清理：
        <span
          className={cn(
            "font-medium",
            incomplete
              ? "text-red-600"
              : neverCreated
                ? "text-muted/70"
                : "text-green-700 dark:text-green-400"
          )}
        >
          {label}
        </span>
        <span className="ml-2 font-mono">
          专用索引 {cleanup.esIndex}
          {cleanup.esError ? `（${cleanup.esError}）` : ""} · 图谱归属 {cleanup.graphProvenance}
          {cleanup.graphError ? `（${cleanup.graphError}）` : ""} · 本地临时库{" "}
          {cleanup.dbClosed ? "已关闭" : "未关闭"}
        </span>
      </p>
      {incomplete ? (
        <p className="text-[11px] text-red-600">
          专用索引/图谱归属未能释放，重启服务后按所有权清理：
          <span className="ml-1 font-mono">npm run eval:residue -- --delete</span>
          。只影响 eval 专用索引与 eval 归属的图谱证据，不动业务数据；运行失败与清理失败分开记录、互不覆盖。
        </p>
      ) : null}
    </div>
  )
}

/** Client-side JSON parse only — the server stays the authoritative validator. */
function parseUpload(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, error: "请粘贴数据集 JSON 或选择一个 .json 文件" }
  try {
    return { ok: true, value: JSON.parse(trimmed) }
  } catch (error) {
    return { ok: false, error: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export function EvaluationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const pollTimer = useRef<number | null>(null)

  const [datasets, setDatasets] = useState<EvaluationDatasetsPayload | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [mode, setMode] = useState<"builtin" | "upload">("builtin")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [uploadText, setUploadText] = useState("")
  const [uploadFileName, setUploadFileName] = useState<string | null>(null)
  const [uploadIssues, setUploadIssues] = useState<string[]>([])
  // 票 11：可选模型覆盖（只填 id；留空＝沿用服务配置）
  const [chatModel, setChatModel] = useState("")
  const [rerankModel, setRerankModel] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [task, setTask] = useState<EvaluationTaskDetail | null>(null)
  const [taskMissing, setTaskMissing] = useState(false)
  // Ticket 12: in-process history. `pollTokenRef` invalidates responses of a
  // task the user has already switched away from, so an old poll can never
  // backfill the panel with stale results.
  const [history, setHistory] = useState<EvaluationTaskSummary[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const pollTokenRef = useRef(0)

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

  /** Ticket 12: the retained records of THIS process (empty after a restart). */
  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await listEvaluationTasks())
    } catch {
      // 历史列表读取失败不影响当前任务的展示与轮询。
    }
  }, [])

  // Load the built-in samples and the retained records each time it opens.
  useEffect(() => {
    if (!open) return
    setLoadError(null)
    void refreshHistory()
    fetchEvaluationDatasets()
      .then((payload) => {
        setDatasets(payload)
        setSelectedId((current) => current ?? payload.datasets[0]?.id ?? null)
      })
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : String(error))
      })
  }, [open, refreshHistory])

  useEffect(
    () => () => {
      stopPolling()
    },
    [stopPolling],
  )

  const startPolling = useCallback(
    (taskId: string) => {
      stopPolling()
      const token = (pollTokenRef.current += 1)
      pollTimer.current = window.setInterval(() => {
        void (async () => {
          try {
            const detail = await fetchEvaluationTask(taskId)
            // Ticket 12: the user switched records — drop this stale response
            // instead of writing an older task back into the panel.
            if (pollTokenRef.current !== token) return
            if (detail === null) {
              // 服务重启或记录被清理：任务只存在于创建它的进程。
              setTaskMissing(true)
              stopPolling()
              void refreshHistory()
              return
            }
            setTask(detail)
            if (TERMINAL_STAGES.has(detail.stage)) {
              stopPolling()
              void refreshHistory()
            }
          } catch {
            // 单次轮询失败不中断任务，下一次轮询会重试。
          }
        })()
      }, EVALUATION_POLL_MS)
    },
    [refreshHistory, stopPolling],
  )

  /** Switch the panel to a retained record; polling follows the new choice. */
  const selectTask = useCallback(
    async (taskId: string) => {
      stopPolling()
      const token = (pollTokenRef.current += 1)
      setSelectedTaskId(taskId)
      setTaskMissing(false)
      setUploadIssues([])
      setLoadError(null)
      try {
        const detail = await fetchEvaluationTask(taskId)
        if (pollTokenRef.current !== token) return
        if (detail === null) {
          setTask(null)
          setTaskMissing(true)
          return
        }
        setTask(detail)
        if (!TERMINAL_STAGES.has(detail.stage)) startPolling(taskId)
      } catch (error) {
        setTask(null)
        setLoadError(`读取记录失败：${error instanceof Error ? error.message : String(error)}`)
      }
    },
    [startPolling, stopPolling],
  )

  const handleRun = async () => {
    if (submitting) return
    const upload = mode === "upload" ? parseUpload(uploadText) : null
    if (mode === "builtin" && !selectedId) return
    if (upload && !upload.ok) {
      setUploadIssues([upload.error])
      return
    }
    setSubmitting(true)
    setTask(null)
    setTaskMissing(false)
    setUploadIssues([])
    setLoadError(null)
    try {
      // 服务端校验是权威：非法数据集在这里被逐字段/逐题拒绝，不会产生任何
      // 模型或索引调用（票 05）。
      // 票 11：只提交模型 id（服务端按允许列表校验），留空表示沿用服务配置。
      const models = {
        ...(chatModel.trim() ? { chatModel: chatModel.trim() } : {}),
        ...(rerankModel.trim() ? { rerankModel: rerankModel.trim() } : {}),
      }
      const summary = await createEvaluationTask(
        mode === "upload"
          ? { dataset: upload && upload.ok ? upload.value : null, ...models }
          : { datasetId: selectedId as string, ...models },
      )
      // 先展示 202 返回的初始状态，再进入轮询。
      setTask({
        ...summary,
        config: { chatModel: "", rerankModel: null, embeddingModel: "", rerankSource: "unknown" },
        cases: [],
        metrics: { version: "", metrics: {} },
        cleanup: null,
      })
      setSelectedTaskId(summary.id)
      void refreshHistory()
      startPolling(summary.id)
    } catch (error) {
      if (error instanceof EvaluationRequestError) {
        setUploadIssues(error.issues.length > 0 ? error.issues : [error.message])
      }
      const message = error instanceof Error ? error.message : String(error)
      setLoadError(`提交失败：${message}`)
    } finally {
      setSubmitting(false)
    }
  }

  const handleUploadFile = async (file: File | undefined) => {
    if (!file) return
    setUploadFileName(file.name)
    setUploadIssues([])
    setUploadText(await file.text())
  }

  const selected = datasets?.datasets.find((item) => item.id === selectedId) ?? null
  const cases = task?.cases ?? []
  // 票 11：页面只提供服务器允许的选择；没有允许列表时不显示覆盖控件。
  const allowedModels = datasets?.allowedModels ?? { chat: [], rerank: [] }
  const allowedModelCount = allowedModels.chat.length + allowedModels.rerank.length
  const defaultChatModel = datasets?.defaults.chatModel ?? ""
  const defaultRerankModel = datasets?.defaults.rerankModel ?? null
  const running = task !== null && !TERMINAL_STAGES.has(task.stage)
  const canRun =
    mode === "builtin" ? Boolean(selectedId) : uploadText.trim().length > 0

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
        {/* 数据来源：内置样例，或用户上传的 JSON（票 05） */}
        <div className="mb-4 flex flex-none items-center gap-1 rounded-lg bg-surface-subtle/60 p-1">
          {([
            ["builtin", "内置样例"],
            ["upload", "上传 JSON"],
          ] as Array<["builtin" | "upload", string]>).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setMode(value)
                setUploadIssues([])
                setLoadError(null)
              }}
              disabled={running}
              className={cn(
                "flex-1 cursor-pointer rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed",
                mode === value ? "bg-surface text-ink shadow-sm" : "text-muted/70 hover:text-ink",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "upload" ? (
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold text-ink">上传数据集 JSON</h3>
            <input
              type="file"
              accept="application/json,.json"
              aria-label="选择数据集 JSON 文件"
              onChange={(event) => void handleUploadFile(event.target.files?.[0])}
              className="cursor-pointer text-[11px] text-muted/70 file:mr-2 file:cursor-pointer file:rounded-md file:border file:border-line file:bg-surface-subtle file:px-2.5 file:py-1 file:text-[11px] file:text-ink"
            />
            <textarea
              value={uploadText}
              onChange={(event) => {
                setUploadText(event.target.value)
                setUploadIssues([])
                setUploadFileName(null)
              }}
              spellCheck={false}
              rows={8}
              placeholder='{"schemaVersion":1,"name":"我的数据集","version":"1.0.0","corpus":[{"passageId":"p1","content":"…"}],"cases":[{"caseId":"c1","question":"…","referenceAnswer":"…","relevantPassageIds":["p1"]}]}'
              className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 font-mono text-[11px] leading-relaxed text-ink outline-none focus:border-brand"
            />
            {uploadFileName ? (
              <p className="text-[11px] text-muted/50">已读取文件：{uploadFileName}</p>
            ) : null}
            {uploadIssues.length > 0 ? (
              <ul className="list-disc space-y-1 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
                {uploadIssues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            ) : null}
            <p className="text-[11px] text-muted/50">
              corpus 需带稳定 passageId（干扰段落也要入库），cases 引用这些 id 并给出参考答案；服务端逐字段校验，
              非法数据在付费调用前被拒绝。多题会按受控并发批量运行，每题独立会话。
            </p>
          </div>
        ) : (
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
        )}

        {/* 票 11：本次运行的模型（可选；留空＝沿用服务配置，只接受服务端允许的 id） */}
        {allowedModelCount > 0 ? (
          <div className="mt-3 flex flex-col gap-1.5 rounded-lg border border-line bg-surface px-3 py-2">
            <p className="text-[11px] font-semibold text-ink">本次运行的模型（可选）</p>
            <label className="flex items-center justify-between gap-2 text-[11px] text-muted/70">
              <span>Chat</span>
              <input
                list="eval-chat-models"
                value={chatModel}
                onChange={(event) => setChatModel(event.target.value)}
                placeholder={defaultChatModel}
                className="w-48 rounded-md border border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-brand"
              />
            </label>
            <datalist id="eval-chat-models">
              {allowedModels.chat.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
            <label className="flex items-center justify-between gap-2 text-[11px] text-muted/70">
              <span>Rerank</span>
              <input
                list="eval-rerank-models"
                value={rerankModel}
                onChange={(event) => setRerankModel(event.target.value)}
                placeholder={defaultRerankModel ?? "未配置"}
                className="w-48 rounded-md border border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-brand"
              />
            </label>
            <datalist id="eval-rerank-models">
              {allowedModels.rerank.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
            <p className="text-[10px] text-muted/50">
              只接受服务端允许的模型 id；此处不能填写 Base URL 或密钥，Embedding 沿用服务配置。
            </p>
          </div>
        ) : null}

        <button
          type="button"
          disabled={!canRun || submitting || running}
          onClick={() => void handleRun()}
          className="mt-4 inline-flex h-9 w-full flex-none cursor-pointer items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 text-xs font-medium text-white shadow-sm transition-all hover:bg-neutral-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 dark:bg-neutral-200 dark:text-neutral-900 dark:hover:bg-white"
        >
          {running ? "评测进行中…" : submitting ? "提交中…" : mode === "upload" ? "运行上传数据集" : "运行评测"}
        </button>

        {/* 本进程保留的评测记录（票 12） */}
        <div className="mt-4 flex flex-col gap-1.5">
          <p className="text-[11px] font-semibold text-ink">
            本进程评测记录
            <span className="ml-2 font-normal text-muted/50">
              仅保存在当前服务进程内；重启后不可查询，超出保留上限或过期的完成记录会被清理
            </span>
          </p>
          {history.length === 0 ? (
            <p className="text-[11px] text-muted/50">本进程暂无评测记录。</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {history.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => void selectTask(item.id)}
                    className={cn(
                      "flex w-full cursor-pointer items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left text-[11px] transition-colors",
                      item.id === selectedTaskId
                        ? "border-brand bg-brand-subtle/40"
                        : "border-line hover:bg-surface-subtle",
                    )}
                  >
                    <span className="min-w-0 truncate font-mono text-muted/70">
                      {item.dataset.name} · {item.id.slice(0, 8)}
                    </span>
                    <span className="flex flex-none items-center gap-2 text-muted/60">
                      <span>
                        已完成 {item.progress.finished}/{item.progress.total}
                      </span>
                      <span>{STAGE_LABELS[item.stage]}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 任务进度与结果 */}
        {task ? (
          <div className="mt-4 flex min-h-0 flex-1 flex-col gap-3" aria-live="polite">
            <div className="flex items-center justify-between gap-2">
              <StageStepper stage={task.stage} />
              <span className="flex items-center gap-2">
                {task.progress.total > 0 ? (
                  <span className="font-mono text-[11px] text-muted/70">
                    已完成 {task.progress.finished}/{task.progress.total}
                    <span className="ml-2 text-muted/50">
                      成功 {task.counts.answered} · 失败 {task.counts.failed} · 降级{" "}
                      {task.counts.degraded}
                    </span>
                  </span>
                ) : null}
                <StageBadge stage={task.stage} />
              </span>
            </div>

            {/* 票 11：本次运行实际使用的数据集与脱敏配置（不含任何凭据） */}
            <p className="font-mono text-[10px] text-muted/50">
              数据集 {task.dataset.name} v{task.dataset.version} · 摘要{" "}
              {task.dataset.contentDigest.slice(0, 12)} · 模型 Chat {task.config.chatModel || "…"} ·
              Rerank {task.config.rerankModel ?? "未配置"}（{task.config.rerankSource}） · Embedding{" "}
              {task.config.embeddingModel || "…"}
            </p>

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
                    {item.outcome === "answered"
                      ? item.terminalStatus && item.terminalStatus !== "completed"
                        ? `已回答（${item.terminalStatus}）`
                        : "已回答"
                      : "失败"}
                  </span>
                </header>
                {item.answer ? (
                  <p className="mt-2 rounded-md bg-surface px-2.5 py-2 text-xs leading-relaxed text-ink">
                    {item.answer}
                  </p>
                ) : null}
                {item.error ? <p className="mt-2 text-[11px] text-red-600">{item.error}</p> : null}
                <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1 text-[11px] text-muted/70">
                  {CASE_METRICS.map(([key, label]) => (
                    <div key={key} className="flex justify-between gap-2">
                      <dt>{label}</dt>
                      <dd className="font-mono font-semibold text-ink">
                        {formatScore(item.metrics[key] ?? null)}
                      </dd>
                    </div>
                  ))}
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
                <OrderingNote ordering={item.ordering} />
                {item.finalContextRound ? (
                  <p className="mt-1 text-[10px] text-muted/50">
                    评分输入来自第 {item.finalContextRound} 轮生成上下文
                    {item.finalContextRound > 1
                      ? "（最后一次纠错被接受）"
                      : "（首次草稿被接受）"}
                  </p>
                ) : null}
                {item.candidates.length > 0 ? (
                  <details className="mt-2 rounded-md border border-line bg-surface px-2.5 py-2">
                    <summary className="cursor-pointer text-[11px] text-muted/70">
                      候选段落（评分输入，共 {item.candidates.length} 条
                      {item.unmappedCandidates > 0
                        ? `，其中 ${item.unmappedCandidates} 条未映射`
                        : ""}
                      ）
                    </summary>
                    <ol className="mt-1.5 space-y-1">
                      {item.candidates.map((candidate) => (
                        <li
                          key={`${candidate.rank}-${candidate.chunkId}`}
                          className="flex items-baseline justify-between gap-2 font-mono text-[10px] text-muted/70"
                        >
                          <span
                            className="min-w-0 truncate"
                            title={`${candidate.documentId} · ${candidate.chunkId}`}
                          >
                            #{candidate.rank} {candidate.passageId ?? "（未映射）"}
                            <span className="ml-1 text-muted/40">
                              {candidate.channels.join("/")}
                            </span>
                          </span>
                          <span className="flex flex-none items-center gap-2">
                            <span className={candidate.relevant ? "text-brand" : "text-muted/50"}>
                              {candidate.relevant ? "相关" : "无关"}
                            </span>
                            <span>{candidate.score.toFixed(3)}</span>
                          </span>
                        </li>
                      ))}
                    </ol>
                  </details>
                ) : null}
                <p className="mt-1 font-mono text-[10px] text-muted/40">参考答案：{item.referenceAnswer}</p>
              </article>
            ))}

            {task.metrics.version ? (
              <div className="rounded-lg border border-line bg-surface-subtle/40 px-3 py-2.5">
                <p className="text-[11px] font-semibold text-ink">
                  汇总指标（六项检索 + 六项文本相似度）
                  <span className="ml-2 font-mono text-[10px] font-normal text-muted/50">
                    {task.metrics.version}
                  </span>
                </p>
                <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                  {CASE_METRICS.map(([key, label]) => {
                    const summary = task.metrics.metrics[key]
                    return (
                      <div key={key} className="flex items-baseline justify-between gap-2">
                        <dt className="text-muted/70">{label}</dt>
                        <dd className="font-mono font-semibold text-ink">
                          {formatScore(summary?.value ?? null)}
                          <span className="ml-1.5 font-normal text-muted/50">
                            有效 {summary?.sampleSize ?? 0}
                            {summary && summary.notApplicable > 0
                              ? ` · 不适用 ${summary.notApplicable}`
                              : ""}
                          </span>
                        </dd>
                      </div>
                    )
                  })}
                </dl>
                <p className="mt-1.5 text-[10px] text-muted/50">
                  BLEU 与 ROUGE 均为文本相似度（固定中文按字、英文按词及大小写/标点归一化规则
                  {task.metrics.generation
                    ? ` ${task.metrics.generation.bleuVersion} / ${task.metrics.generation.rougeVersion} / ${task.metrics.generation.textRuleVersion}`
                    : ""}
                  ），不是正确率或忠实性；分数取自本次实际回复。
                </p>
              </div>
            ) : null}

            {task.cleanup ? <CleanupLine detail={task} /> : null}
          </div>
        ) : null}
      </section>
    </dialog>
  )
}
