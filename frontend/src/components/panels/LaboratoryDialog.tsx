import { Alert, AlertDescription } from "@/components/primitives/alert"
import { FlaskConical } from "../ui/icons"
import { useState } from "react"

import type { LabCandidatePayload, LabRunPayload } from "../../lib/api"
import {
  DocumentOperationError,
  LabTimeoutError,
  runRetrievalDebug,
} from "../../lib/api"
import { Icon } from "../ui/Icon"
import { Dialog } from "../ui/Dialog"
import {
  Button,
  Checkbox,
  EmptyState,
  StatusBadge,
  TextInput,
} from "../ui/Controls"

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
          className="rounded-[10px] border border-line bg-surface px-2.5 py-1.5 text-[11px] text-muted-foreground"
        >
          {/* The rank used to carry `text-brand`, spending the accent on a
              counter; brand is reserved for links, focus and selection. */}
          <span className="mr-1.5 font-mono text-[10px] text-faint">
            #{candidate.rank}
          </span>
          <span className="font-medium text-ink">
            {candidate.title || "未命名"}
          </span>
          {candidate.score !== null ? (
            <span className="ml-1.5 font-mono text-[10px]" title={scoreNote}>
              {scoreNote} {candidate.score.toFixed(4)}
            </span>
          ) : null}
          <p className="mt-0.5 line-clamp-2 overflow-hidden">
            {candidate.excerpt}
          </p>
        </li>
      ))}
    </ol>
  )
}

const STAGE_CARD_CLASS = "rounded-[14px] border border-line p-3"
const STAGE_TITLE_CLASS = "text-[10px] font-medium text-muted-foreground"
const STAGE_TIME_CLASS = "font-mono text-[10px] text-faint"

export function LaboratoryDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<string[]>([
    "vector",
    "bm25",
    "graph",
    "pageIndex",
  ])
  const [running, setRunning] = useState(false)
  const [run, setRun] = useState<LabRunPayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  const toggleChannel = (id: string) =>
    setSelected((previous) =>
      previous.includes(id)
        ? previous.filter((entry) => entry !== id)
        : [...previous, id],
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
    <Dialog
      open={open}
      onClose={onClose}
      title="检索实验室"
      titleId="laboratory-title"
      icon={FlaskConical}
      tier="work"
      toolbar={
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            execute()
          }}
        >
          <div className="flex items-center gap-2">
            <TextInput
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="输入实验查询…（回车运行）"
              maxLength={2000}
              aria-label="实验查询"
            />
            <Button
              type="submit"
              tone="primary"
              disabled={running || !query.trim() || selected.length === 0}
              title={selected.length === 0 ? "至少选择一个通道" : "运行实验"}
            >
              {running ? "运行中…" : "运行"}
            </Button>
          </div>
          <div
            className="flex flex-wrap items-center gap-3"
            role="group"
            aria-label="通道选择"
          >
            {ALL_CHANNELS.map(({ id, label }) => (
              <Checkbox
                key={id}
                checked={selected.includes(id)}
                onChange={() => toggleChannel(id)}
                label={label}
              />
            ))}
            <span className="ml-auto text-[10px] text-faint">
              知识范围与对话一致（侧栏选择）
            </span>
          </div>
        </form>
      }
    >
      {/* States: error / timeout / empty / result — each distinct */}
      {error ? (
        <Alert variant="destructive" role="alert" className="border p-3">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {!run && !error && !running ? (
        <EmptyState
          icon={FlaskConical}
          message="运行一次查询，这里会按通道、融合、重排三段展开各自的候选。"
        />
      ) : null}

      {run ? (
        <div className="flex min-h-0 flex-col gap-3">
          {/* Overall status + ordering source */}
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge
              tone={
                run.status === "ok"
                  ? "success"
                  : run.status === "degraded"
                    ? "warning"
                    : "neutral"
              }
            >
              {run.status === "ok"
                ? "正常"
                : run.status === "degraded"
                  ? "降级"
                  : "无结果"}
            </StatusBadge>
            <StatusBadge>
              总耗时 {Math.round(run.debug?.totalMs ?? 0)} ms
            </StatusBadge>
            {ordering ? (
              ordering.source === "dedicated_rerank" ? (
                <StatusBadge tone="success">专用重排</StatusBadge>
              ) : (
                /* Criterion 3: a fallback ordering is labeled as one. */
                <StatusBadge
                  tone="warning"
                  title="融合排序是回退结果，不是成功的重排"
                >
                  回退排序：融合结果（未成功重排
                  {ordering.reason
                    ? ` — ${RERANK_REASON_LABELS[ordering.reason] ?? ordering.reason}`
                    : ""}
                  ）
                </StatusBadge>
              )
            ) : null}
          </div>

          {/* Disabled channels (not a failure) */}
          {(run.unselectedChannels?.length ?? 0) > 0 ? (
            <p className="rounded-[14px] border border-line bg-surface-subtle p-3 text-xs text-muted-foreground">
              本次未启用通道：
              {run.unselectedChannels
                ?.map((c) => CHANNEL_LABELS[c] ?? c)
                .join("、")}
              （未启用 ≠ 故障）
            </p>
          ) : null}

          {/* Empty hits vs total channel failure — distinct states */}
          {run.unavailableChannels.length > 0 ? (
            <Alert variant="destructive" role="alert" className="border p-3">
              <AlertDescription>
                通道不可用：
                {run.unavailableChannels
                  .map((c) => CHANNEL_LABELS[c] ?? c)
                  .join("、")}{" "}
                — 该通道执行失败，其余通道正常参与。
              </AlertDescription>
            </Alert>
          ) : run.status === "insufficient" ||
            (run.debug?.fused.distinctCount ?? 0) === 0 ? (
            <p className="rounded-[14px] border border-line bg-surface-subtle p-3 text-xs text-muted-foreground">
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
                <span className={STAGE_TIME_CLASS}>
                  {Math.round(stage.elapsedMs)} ms
                </span>
              </div>
              {stage.error ? (
                <Alert variant="destructive" role="alert" className="mt-1">
                  <AlertDescription>{stage.error}</AlertDescription>
                </Alert>
              ) : stage.candidates.length === 0 ? (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  该通道没有返回候选。
                </p>
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
                <span className={STAGE_TIME_CLASS}>
                  {Math.round(run.debug.fused.elapsedMs)} ms
                </span>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                原始候选 {run.debug.fused.rawCandidateCount} 条 → 去重后{" "}
                {run.debug.fused.distinctCount} 条（按排名融合，无统一分数）
              </p>
              {run.debug.fused.candidates.length > 0 ? (
                <CandidateList
                  candidates={run.debug.fused.candidates}
                  scoreNote=""
                />
              ) : null}
            </div>
          ) : null}

          {/* Stage 3: rerank — success and failure are visibly different */}
          {rerank ? (
            <div className={STAGE_CARD_CLASS}>
              <div className="flex items-center justify-between gap-2">
                <p className={STAGE_TITLE_CLASS}>
                  重排{rerank.applied ? " · 已应用" : " · 未应用（回退）"}
                </p>
                <span className={STAGE_TIME_CLASS}>
                  {Math.round(rerank.elapsedMs)} ms
                </span>
              </div>
              {!rerank.applied ? (
                <Alert variant="destructive" role="alert" className="mt-1">
                  <AlertDescription>
                    重排失败或未执行（
                    {RERANK_REASON_LABELS[rerank.reason ?? ""] ??
                      rerank.reason ??
                      "未知原因"}
                    ）—— 展示的是融合回退排序，不是重排结果。
                  </AlertDescription>
                </Alert>
              ) : rerank.candidates && rerank.candidates.length > 0 ? (
                <CandidateList
                  candidates={rerank.candidates}
                  scoreNote="重排分"
                />
              ) : (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  没有候选。
                </p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  )
}
