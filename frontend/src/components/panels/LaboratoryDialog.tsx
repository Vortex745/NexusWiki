import { FlaskConical, X } from "lucide"
import { useEffect, useRef, useState } from "react"

import { Icon } from "../ui/Icon"
import {
  DocumentOperationError,
  LabTimeoutError,
  runRetrievalDebug,
  type LabCandidatePayload,
  type LabRunPayload,
} from "../../lib/api"

/**
 * Ticket 15 (RET-02): the retrieval laboratory — one experiment at a time,
 * running the SAME read-only debug endpoint chat's searcher backs (ticket 14).
 *
 * Rendering rules the acceptance criteria live in:
 * - Every transformation gets its own stage (channels → fusion/dedup →
 *   rerank); raw channel scores are labeled per-channel and NEVER shown in
 *   one comparable scoreboard (raw scores are not comparable across channels).
 * - Empty hits, a disabled/unavailable channel, a timeout and a rerank
 *   failure are visually distinct states.
 * - A rerank failure is labeled as a FALLBACK ordering, never as a
 *   successful rerank.
 */

const ALL_CHANNELS = [
  { id: "vector", label: "向量" },
  { id: "bm25", label: "BM25" },
  { id: "graph", label: "图谱" },
  { id: "pageIndex", label: "目录" },
] as const

const RERANK_REASON_LABELS: Record<string, string> = {
  below_threshold: "候选不足（少于 2 条），无需重排",
  not_configured: "未配置专用重排服务",
  unavailable: "重排服务调用失败",
}

const CHANNEL_LABELS: Record<string, string> = Object.fromEntries(
  ALL_CHANNELS.map(({ id, label }) => [id, label]),
)

function CandidateList({
  candidates,
  scoreNote,
}: {
  candidates: LabCandidatePayload[]
  scoreNote: string
}) {
  return (
    <ol className="mt-1.5 flex flex-col gap-1">
      {candidates.map((candidate) => (
        <li
          key={`${candidate.chunkId}-${candidate.rank}`}
          className="rounded-md border border-line bg-surface px-2 py-1.5 text-[11px] text-muted"
        >
          <span className="mr-1.5 font-mono text-[10px] text-brand">#{candidate.rank}</span>
          <span className="font-medium text-ink">{candidate.title || "未命名"}</span>
          {candidate.score !== null ? (
            <span className="ml-1.5 font-mono text-[10px]" title={scoreNote}>
              {scoreNote} {candidate.score.toFixed(4)}
            </span>
          ) : null}
          <p className="mt-0.5 line-clamp-2 overflow-hidden">{candidate.excerpt}</p>
        </li>
      ))}
    </ol>
  )
}

const STAGE_CARD_CLASS = "rounded-lg border border-line p-3"
const STAGE_TITLE_CLASS = "text-[10px] font-medium uppercase tracking-wider text-muted/70"

export function LaboratoryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<string[]>(["vector", "bm25", "graph", "pageIndex"])
  const [running, setRunning] = useState(false)
  const [run, setRun] = useState<LabRunPayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  const toggleChannel = (id: string) =>
    setSelected((previous) =>
      previous.includes(id) ? previous.filter((entry) => entry !== id) : [...previous, id],
    )

  const execute = () => {
    const text = query.trim()
    if (!text || selected.length === 0 || running) return
    setRunning(true)
    setError(null)
    setRun(null)
    runRetrievalDebug(text, selected)
      .then((payload) => setRun(payload))
      .catch((err: unknown) => {
        if (err instanceof LabTimeoutError) setError(err.message)
        else if (err instanceof DocumentOperationError) setError(err.message)
        else setError(err instanceof Error ? err.message : "检索实验失败")
      })
      .finally(() => setRunning(false))
  }

  const rerank = run?.debug?.rerank
  const ordering = run?.ordering ?? null

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      aria-labelledby="laboratory-title"
      className="m-auto h-[min(680px,calc(100dvh-48px))] w-[min(760px,calc(100vw-32px))] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-dialog backdrop:bg-black/20 open:grid open:animate-dialog-enter max-md:m-0 max-md:h-dvh max-md:w-screen max-md:rounded-none max-md:border-0"
    >
      <div className="flex h-13 flex-none items-center justify-between border-b border-line px-5 max-md:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Icon icon={FlaskConical} className="size-4 flex-none text-muted" />
          <h2 id="laboratory-title" className="truncate text-sm font-semibold text-ink">
            检索实验室
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭检索实验室"
          title="关闭"
          className="grid size-7 flex-none cursor-pointer place-items-center rounded-md text-muted/70 transition-colors hover:bg-surface-subtle hover:text-ink"
        >
          <Icon icon={X} className="size-4" />
        </button>
      </div>

      <form
        className="flex min-h-0 flex-col overflow-y-auto px-5 py-4 max-md:px-4"
        onSubmit={(event) => {
          event.preventDefault()
          execute()
        }}
      >
        {/* Query + channel selection */}
        <div className="flex flex-none flex-wrap items-center gap-2">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="输入实验查询…（回车运行）"
            maxLength={2000}
            aria-label="实验查询"
            className="h-9 min-w-0 flex-1 rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-brand"
          />
          <button
            type="submit"
            disabled={running || !query.trim() || selected.length === 0}
            title={selected.length === 0 ? "至少选择一个通道" : "运行实验"}
            className="inline-flex h-9 flex-none cursor-pointer items-center gap-1.5 rounded-lg bg-brand px-3 text-xs font-medium text-white transition-[colors,transform] duration-150 ease-out hover:bg-brand-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? "运行中…" : "运行"}
          </button>
        </div>
        <div className="mt-2 flex flex-none flex-wrap items-center gap-3" role="group" aria-label="通道选择">
          {ALL_CHANNELS.map(({ id, label }) => (
            <label key={id} className="flex cursor-pointer items-center gap-1.5 text-xs text-muted">
              <input
                type="checkbox"
                checked={selected.includes(id)}
                onChange={() => toggleChannel(id)}
                className="accent-[var(--color-brand,theme(colors.brand))]"
              />
              {label}
            </label>
          ))}
          <span className="text-[10px] text-muted/60">
            知识范围与对话一致（侧栏选择）
          </span>
        </div>

        {/* States: error / timeout / empty / result — each distinct */}
        {error ? (
          <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        ) : null}

        {run ? (
          <div className="mt-4 flex min-h-0 flex-col gap-3">
            {/* Overall status + ordering source */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded-full border border-line bg-surface-subtle px-2 py-0.5 font-mono text-[10px] text-muted">
                {run.status === "ok" ? "正常" : run.status === "degraded" ? "降级" : "无结果"}
              </span>
              <span className="rounded-full border border-line bg-surface-subtle px-2 py-0.5 font-mono text-[10px] text-muted">
                总耗时 {Math.round(run.debug?.totalMs ?? 0)} ms
              </span>
              {ordering ? (
                ordering.source === "dedicated_rerank" ? (
                  <span className="rounded-full border border-brand-line bg-brand-subtle px-2 py-0.5 font-mono text-[10px] text-brand">
                    专用重排
                  </span>
                ) : (
                  /* Criterion 3: a fallback ordering is labeled as one. */
                  <span
                    title="融合排序是回退结果，不是成功的重排"
                    className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 font-mono text-[10px] text-amber-700 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                  >
                    回退排序：融合结果（未成功重排{ordering.reason ? ` — ${RERANK_REASON_LABELS[ordering.reason] ?? ordering.reason}` : ""}）
                  </span>
                )
              ) : null}
            </div>

            {/* Disabled channels (not a failure) */}
            {(run.unselectedChannels?.length ?? 0) > 0 ? (
              <p className="rounded-lg border border-line bg-surface-subtle/40 p-3 text-xs text-muted">
                本次未启用通道：{run.unselectedChannels?.map((c) => CHANNEL_LABELS[c] ?? c).join("、")}（未启用 ≠ 故障）
              </p>
            ) : null}

            {/* Empty hits vs total channel failure — distinct states */}
            {run.unavailableChannels.length > 0 ? (
              <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                通道不可用：{run.unavailableChannels.map((c) => CHANNEL_LABELS[c] ?? c).join("、")} — 该通道执行失败，其余通道正常参与。
              </p>
            ) : run.status === "insufficient" || (run.debug?.fused.distinctCount ?? 0) === 0 ? (
              <p className="rounded-lg border border-line bg-surface-subtle/40 p-3 text-xs text-muted">
                无命中：本次实验未检索到候选（空命中是正常结果，不是故障）。
              </p>
            ) : null}

            {/* Stage 1: raw channel ranks — per-channel scores, explicitly NOT comparable */}
            {run.debug?.channels.map((stage) => (
              <div key={stage.channel} className={STAGE_CARD_CLASS}>
                <div className="flex items-center justify-between gap-2">
                  <p className={STAGE_TITLE_CLASS}>
                    通道 · {CHANNEL_LABELS[stage.channel] ?? stage.channel}
                    {!stage.ok ? " · 失败" : ""}
                  </p>
                  <span className="font-mono text-[10px] text-muted/70">{Math.round(stage.elapsedMs)} ms</span>
                </div>
                {stage.error ? (
                  <p role="alert" className="mt-1 text-[11px] text-red-700 dark:text-red-300">{stage.error}</p>
                ) : stage.candidates.length === 0 ? (
                  <p className="mt-1 text-[11px] text-muted/70">该通道没有返回候选。</p>
                ) : (
                  <CandidateList
                    candidates={stage.candidates}
                    scoreNote="通道原始分（不可跨通道比较）"
                  />
                )}
              </div>
            ))}

            {/* Stage 2: fusion = dedup + rank-based ordering (no scores shown) */}
            {run.debug ? (
              <div className={STAGE_CARD_CLASS}>
                <div className="flex items-center justify-between gap-2">
                  <p className={STAGE_TITLE_CLASS}>融合（RRF · 去重）</p>
                  <span className="font-mono text-[10px] text-muted/70">{Math.round(run.debug.fused.elapsedMs)} ms</span>
                </div>
                <p className="mt-1 text-[11px] text-muted">
                  原始候选 {run.debug.fused.rawCandidateCount} 条 → 去重后 {run.debug.fused.distinctCount} 条（按排名融合，无统一分数）
                </p>
                {run.debug.fused.candidates.length > 0 ? (
                  <CandidateList candidates={run.debug.fused.candidates} scoreNote="" />
                ) : null}
              </div>
            ) : null}

            {/* Stage 3: rerank — success and failure are visibly different */}
            {rerank ? (
              <div className={STAGE_CARD_CLASS}>
                <div className="flex items-center justify-between gap-2">
                  <p className={STAGE_TITLE_CLASS}>
                    重排
                    {rerank.applied ? " · 已应用" : " · 未应用（回退）"}
                  </p>
                  <span className="font-mono text-[10px] text-muted/70">{Math.round(rerank.elapsedMs)} ms</span>
                </div>
                {!rerank.applied ? (
                  <p role="alert" className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                    重排失败或未执行（{RERANK_REASON_LABELS[rerank.reason ?? ""] ?? rerank.reason ?? "未知原因"}）——
                    展示的是融合回退排序，不是重排结果。
                  </p>
                ) : rerank.candidates && rerank.candidates.length > 0 ? (
                  <CandidateList candidates={rerank.candidates} scoreNote="重排分" />
                ) : (
                  <p className="mt-1 text-[11px] text-muted/70">没有候选。</p>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </form>
    </dialog>
  )
}
