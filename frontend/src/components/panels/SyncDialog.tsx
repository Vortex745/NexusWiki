import { RefreshCw, X } from "lucide"
import { useCallback, useEffect, useRef, useState } from "react"

import { Icon } from "../ui/Icon"
import {
  createSyncSource,
  deleteSyncSource,
  fetchSyncSources,
  runSyncSource,
  updateSyncSource,
  type SyncDataSourcePayload,
  type SyncRunReportPayload,
} from "../../lib/api"

/**
 * Ticket 39 (SYNC-01A): the administrator URL/sitemap sync data-source panel
 * for ONE knowledge base. Define a resource with an interval choice, pause or
 * resume it, run ONE safe manual sync (per-page report: submitted /
 * unchanged / failed), and delete a source. Interval scheduling itself is
 * ticket 40 — the choice is stored and shown here.
 */

const INTERVALS = [
  { id: "manual", label: "手动" },
  { id: "1h", label: "每小时" },
  { id: "6h", label: "每 6 小时" },
  { id: "24h", label: "每 24 小时" },
] as const

export function SyncDialog({
  open,
  knowledgeBase,
  onClose,
}: {
  open: boolean
  knowledgeBase: { id: string; name: string } | null
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const kbId = knowledgeBase?.id ?? null
  const [sources, setSources] = useState<SyncDataSourcePayload[]>([])
  const [kind, setKind] = useState<"url" | "sitemap">("url")
  const [uri, setUri] = useState("")
  const [interval, setInterval] = useState<string>("manual")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastReport, setLastReport] = useState<SyncRunReportPayload | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  const refresh = useCallback(() => {
    if (!kbId) return
    fetchSyncSources(kbId)
      .then(setSources)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "同步源读取失败")
      )
  }, [kbId])

  useEffect(() => {
    if (!open) return
    setUri("")
    setInterval("manual")
    setError(null)
    setLastReport(null)
    refresh()
  }, [open, kbId, refresh])

  const create = () => {
    if (!kbId || !uri.trim() || busy) return
    setBusy(true)
    setError(null)
    createSyncSource(kbId, {
      kind,
      uri: uri.trim(),
      ...(interval !== "manual" ? { interval } : {}),
    })
      .then(() => {
        setUri("")
        refresh()
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "同步源创建失败")
      )
      .finally(() => setBusy(false))
  }

  const runOnce = (id: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    runSyncSource(id)
      .then((report) => {
        setLastReport(report)
        refresh()
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "同步执行失败")
      )
      .finally(() => setBusy(false))
  }

  const toggleState = (source: SyncDataSourcePayload) => {
    if (busy) return
    setBusy(true)
    updateSyncSource(source.id, { state: source.state === "active" ? "paused" : "active" })
      .then(refresh)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "同步源更新失败")
      )
      .finally(() => setBusy(false))
  }

  const remove = (id: string) => {
    if (busy) return
    setBusy(true)
    deleteSyncSource(id)
      .then(refresh)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "同步源删除失败")
      )
      .finally(() => setBusy(false))
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      aria-labelledby="sync-title"
      className="m-auto h-[min(680px,calc(100dvh-48px))] w-[min(720px,calc(100vw-32px))] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-dialog backdrop:bg-black/20 open:grid max-md:m-0 max-md:h-dvh max-md:w-screen max-md:rounded-none max-md:border-0"
    >
      <div className="flex h-13 flex-none items-center justify-between border-b border-line px-5 max-md:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Icon icon={RefreshCw} className="size-4 flex-none text-muted" />
          <h2 id="sync-title" className="truncate text-sm font-semibold text-ink">
            同步数据源{knowledgeBase ? ` · ${knowledgeBase.name}` : ""}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭同步数据源"
          title="关闭"
          className="grid size-7 flex-none cursor-pointer place-items-center rounded-md text-muted/70 transition-colors hover:bg-surface-subtle hover:text-ink"
        >
          <Icon icon={X} className="size-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4 max-md:px-4">
        {error ? (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        ) : null}

        <section className="rounded-lg border border-line p-3">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted/70">
            新建数据源（URL 或 sitemap，绑定本知识库）
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as "url" | "sitemap")}
              aria-label="资源类型"
              className="h-9 flex-none rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none focus:border-brand"
            >
              <option value="url">URL</option>
              <option value="sitemap">Sitemap</option>
            </select>
            <input
              value={uri}
              onChange={(event) => setUri(event.target.value)}
              placeholder="https://example.com/policy 或 https://example.com/sitemap.xml"
              maxLength={2000}
              aria-label="资源地址"
              className="h-9 min-w-0 flex-1 rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-brand"
            />
            <select
              value={interval}
              onChange={(event) => setInterval(event.target.value)}
              aria-label="同步间隔"
              className="h-9 flex-none rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none focus:border-brand"
            >
              {INTERVALS.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={create}
              disabled={busy || !uri.trim()}
              title="创建数据源"
              className="inline-flex h-9 flex-none cursor-pointer items-center rounded-lg bg-brand px-3 text-xs font-medium text-white transition-[color,background-color,border-color,transform,translate,scale] duration-150 ease-out hover:bg-brand-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              创建
            </button>
          </div>
          <p className="mt-1.5 text-[10px] text-muted/60">
            同步复用与导入一致的安全抓取（内网拒绝 / 重定向校验 / 大小上限），内容经正常摄取流程入库；内容未变化时不会产生新版本。
          </p>
        </section>

        {lastReport ? (
          <section className="rounded-lg border border-line p-3">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted/70">
              最近一次同步报告
            </p>
            <ul className="mt-1.5 flex flex-col gap-0.5">
              {lastReport.pages.map((page) => (
                <li key={page.uri} className="text-xs">
                  <span
                    className={
                      page.status === "failed"
                        ? "font-mono text-[10px] text-red-600 dark:text-red-400"
                        : page.status === "unchanged"
                          ? "font-mono text-[10px] text-muted/70"
                          : "font-mono text-[10px] text-brand"
                    }
                  >
                    {page.status}
                  </span>{" "}
                  <span className="truncate">{page.uri}</span>
                  {page.detail ? <span className="text-[10px] text-muted/60"> — {page.detail}</span> : null}
                </li>
              ))}
            </ul>
            {lastReport.truncated ? (
              <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">
                本次同步窗口已截断（页面数超过单次上限），其余页面将在后续同步处理。
              </p>
            ) : null}
          </section>
        ) : null}

        <section className="rounded-lg border border-line p-3">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted/70">数据源列表</p>
          {sources.length === 0 ? (
            <p className="mt-2 text-xs text-muted/70">还没有同步数据源。</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {sources.map((source) => (
                <li key={source.id} className="rounded-md border border-line bg-surface px-2.5 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={
                        source.state === "active"
                          ? "rounded bg-brand-subtle px-1 text-[10px] text-brand"
                          : "rounded bg-surface-subtle px-1 text-[10px] text-muted/70"
                      }
                    >
                      {source.state === "active" ? "启用" : "已暂停"}
                    </span>
                    <span className="rounded bg-surface-subtle px-1 text-[10px] text-muted">
                      {source.kind === "url" ? "URL" : "Sitemap"}
                    </span>
                    <span className="truncate font-medium text-ink" title={source.uri}>
                      {source.uri}
                    </span>
                    <span className="font-mono text-[10px] text-muted/60">
                      {INTERVALS.find((entry) => entry.id === source.interval)?.label ?? source.interval}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[10px] text-muted/60">
                    {source.lastSyncStatus
                      ? `上次同步：${source.lastSyncAt ?? "—"} · ${source.lastSyncStatus}`
                      : "尚未同步过。"}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => runOnce(source.id)}
                      disabled={busy || source.state !== "active"}
                      className="cursor-pointer rounded bg-brand-subtle px-1.5 py-0.5 text-[10px] text-brand transition-colors hover:bg-brand-hover hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      立即同步
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleState(source)}
                      disabled={busy}
                      className="cursor-pointer rounded bg-surface-subtle px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:text-ink disabled:opacity-50"
                    >
                      {source.state === "active" ? "暂停" : "启用"}
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(source.id)}
                      disabled={busy}
                      className="cursor-pointer rounded px-1.5 py-0.5 text-[10px] text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:hover:bg-red-950/40"
                    >
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </dialog>
  )
}
