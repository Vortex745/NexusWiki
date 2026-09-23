import { NotebookPen, X } from "lucide"
import { useCallback, useEffect, useRef, useState } from "react"

import { Icon } from "../ui/Icon"
import {
  fetchWikiPages,
  fetchWikiSources,
  generateWikiPage,
  restoreWikiPage,
  type WikiPagePayload,
  type WikiSourceCandidatePayload,
} from "../../lib/api"
import { useAppShell } from "../../runtime/AppShellContext"

/**
 * Ticket 38 (WIKI-01): the administrator Wiki surface for ONE knowledge base.
 *
 * - Generate: pick original documents (wiki pages themselves are excluded by
 *   the server) + a page title → one generate command. The server publishes
 *   automatically when the draft is non-empty and fully cited, and rejects
 *   with reasons otherwise — the current page is never replaced by invalid
 *   output.
 * - Pages: every published page with its full revision history, the visible
 *   staleness of each recorded source citation (updated / retired / missing),
 *   and a restore action that re-publishes a prior revision verbatim.
 */

const STALE_LABELS: Record<string, string> = {
  updated: "源文档已更新",
  retired: "源文档已退役",
  missing: "源文档不存在",
}

export function WikiDialog({
  open,
  knowledgeBase,
  onClose,
}: {
  open: boolean
  knowledgeBase: { id: string; name: string } | null
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { showToast, openDocument } = useAppShell()
  const kbId = knowledgeBase?.id ?? null
  const [title, setTitle] = useState("")
  const [sources, setSources] = useState<WikiSourceCandidatePayload[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [pages, setPages] = useState<WikiPagePayload[]>([])
  const [busy, setBusy] = useState<"idle" | "generating" | "restoring">("idle")
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

  const refresh = useCallback(() => {
    if (!kbId) return
    fetchWikiSources(kbId)
      .then((payload) => setSources(payload))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Wiki 来源读取失败")
      )
    fetchWikiPages(kbId)
      .then((payload) => setPages(payload))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Wiki 页面读取失败")
      )
  }, [kbId])

  useEffect(() => {
    if (!open) return
    setTitle("")
    setSelected([])
    setError(null)
    refresh()
  }, [open, kbId, refresh])

  const toggle = (documentId: string) =>
    setSelected((previous) =>
      previous.includes(documentId)
        ? previous.filter((id) => id !== documentId)
        : [...previous, documentId]
    )

  const generate = () => {
    if (!kbId || !title.trim() || selected.length === 0 || busy !== "idle") return
    setBusy("generating")
    setError(null)
    generateWikiPage(kbId, title.trim(), selected)
      .then((payload) => {
        showToast(`Wiki「${payload.title}」已发布（v${payload.version}，进入正常摄取）`)
        setSelected([])
        refresh()
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Wiki 生成失败")
      })
      .finally(() => setBusy("idle"))
  }

  const restore = (docId: string) => {
    if (!kbId || busy !== "idle") return
    setBusy("restoring")
    restoreWikiPage(kbId, docId)
      .then((payload) => {
        showToast(`已恢复为最新版本（v${payload.version}）`)
        refresh()
      })
      .catch((err: unknown) => {
        showToast(err instanceof Error ? err.message : "恢复失败")
      })
      .finally(() => setBusy("idle"))
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      aria-labelledby="wiki-title"
      className="m-auto h-[min(680px,calc(100dvh-48px))] w-[min(760px,calc(100vw-32px))] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-dialog backdrop:bg-black/20 open:grid open:animate-dialog-enter max-md:m-0 max-md:h-dvh max-md:w-screen max-md:rounded-none max-md:border-0"
    >
      <div className="flex h-13 flex-none items-center justify-between border-b border-line px-5 max-md:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Icon icon={NotebookPen} className="size-4 flex-none text-muted" />
          <h2 id="wiki-title" className="truncate text-sm font-semibold text-ink">
            Wiki 工坊{knowledgeBase ? ` · ${knowledgeBase.name}` : ""}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭 Wiki 工坊"
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

        {/* Generate */}
        <section className="rounded-lg border border-line p-3">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted/70">
            生成新版本（AI 生成 · 自动校验 · 校验通过才发布）
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="页面标题（同一标题累积版本）"
              maxLength={200}
              aria-label="Wiki 页面标题"
              className="h-9 min-w-0 flex-1 rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-brand"
            />
            <button
              type="button"
              onClick={generate}
              disabled={busy !== "idle" || !title.trim() || selected.length === 0}
              title={selected.length === 0 ? "至少选择一份来源文档" : "生成并发布"}
              className="inline-flex h-9 flex-none cursor-pointer items-center rounded-lg bg-brand px-3 text-xs font-medium text-white transition-[colors,transform] duration-150 ease-out hover:bg-brand-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "generating" ? "生成中…" : "生成"}
            </button>
          </div>
          <div className="mt-2 flex max-h-36 flex-col gap-1 overflow-y-auto">
            {sources.length === 0 ? (
              <p className="text-xs text-muted/70">暂无可选来源（Wiki 页面本身不会作为来源）。</p>
            ) : (
              sources.map((source) => (
                <label key={source.documentId} className="flex cursor-pointer items-center gap-2 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={selected.includes(source.documentId)}
                    onChange={() => toggle(source.documentId)}
                    className="accent-[var(--color-brand,theme(colors.brand))]"
                  />
                  <span className="truncate text-ink">{source.title}</span>
                  <span className="font-mono text-[10px] text-muted/60">v{source.version}</span>
                </label>
              ))
            )}
          </div>
          <p className="mt-1.5 text-[10px] text-muted/60">
            校验规则：内容非空、引用完整（每份来源至少被引用一次）。校验不通过时不会发布，当前页面保持不变。
          </p>
        </section>

        {/* Published pages */}
        <section className="rounded-lg border border-line p-3">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted/70">
            已发布页面（版本历史可恢复）
          </p>
          {pages.length === 0 ? (
            <p className="mt-2 text-xs text-muted/70">还没有 Wiki 页面。</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {pages.map((page) => (
                <li key={page.documentId} className="rounded-md border border-line bg-surface px-2.5 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => openDocument({ documentId: page.documentId })}
                      title="打开当前版本"
                      className="cursor-pointer font-medium text-ink hover:text-brand"
                    >
                      {page.title}
                    </button>
                    <span className="rounded bg-brand-subtle px-1 text-[10px] text-brand">AI 生成</span>
                    <span className="font-mono text-[10px] text-muted/60">
                      当前 v{page.version} · 共 {page.versions.length} 版
                    </span>
                  </div>
                  {page.sources.length > 0 ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {page.sources.map((source) =>
                        source.stale ? (
                          <span
                            key={source.documentId}
                            title={`记录为 v${source.version}${source.currentVersion ? `，当前 v${source.currentVersion}` : ""}`}
                            className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                          >
                            {STALE_LABELS[source.stale]}：{source.title}
                          </span>
                        ) : (
                          <span
                            key={source.documentId}
                            title={`来源文档 v${source.version}`}
                            className="rounded bg-surface-subtle px-1.5 py-0.5 text-[10px] text-muted"
                          >
                            来源：{source.title} v{source.version}
                          </span>
                        )
                      )}
                    </div>
                  ) : null}
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] text-muted/60">历史版本：</span>
                    {page.versions.map((version) => (
                      <span key={version.documentId} className="flex items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => openDocument({ documentId: version.documentId })}
                          title="打开该历史版本"
                          className="cursor-pointer rounded bg-surface-subtle px-1 py-0.5 font-mono text-[10px] text-muted transition-colors hover:text-ink"
                        >
                          v{version.version}
                          {version.active ? "（当前）" : ""}
                        </button>
                        {!version.active ? (
                          <button
                            type="button"
                            onClick={() => restore(version.documentId)}
                            disabled={busy !== "idle"}
                            title="把该版本内容恢复为最新版本"
                            className="cursor-pointer rounded px-1 py-0.5 text-[10px] text-brand transition-colors hover:bg-brand-subtle disabled:opacity-50"
                          >
                            {busy === "restoring" ? "恢复中…" : "恢复"}
                          </button>
                        ) : null}
                      </span>
                    ))}
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
