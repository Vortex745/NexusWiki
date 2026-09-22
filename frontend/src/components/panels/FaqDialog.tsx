import { HelpCircle, X } from "lucide"
import { useCallback, useEffect, useRef, useState } from "react"

import {
  FaqCommandError,
  createFaqEntry,
  editFaqEntry,
  fetchFaqEntries,
  fetchFaqEntryVersions,
  fetchKnowledgeBases,
  importFaqEntries,
  setFaqEntryStatus,
  type FaqEntryPayload,
  type FaqEntryStatus,
  type FaqEntryVersionPayload,
  type FaqImportResultPayload,
  type KnowledgeBasePayload,
} from "../../lib/api"
import { cn } from "../../lib/cn"
import { useAppShell } from "../../runtime/AppShellContext"
import { Icon } from "../ui/Icon"

const STATUS_LABELS: Record<FaqEntryStatus, string> = {
  active: "生效中",
  disabled: "已停用",
}

interface DraftState {
  id: string | null
  question: string
  variants: string
  answer: string
  sourceTitle: string
  sourceUri: string
}

const emptyDraft = (): DraftState => ({
  id: null,
  question: "",
  variants: "",
  answer: "",
  sourceTitle: "",
  sourceUri: "",
})

/**
 * 票 30（FAQ-01A）：知识库内的版本化标准问答。创建/编辑/导入都走后端校验，
 * 冲突（同一归一化问题已有生效答案）在界面上显示冲突对象；停用条目仍然可见，
 * 只是不再参与检索。
 */
export function FaqDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { showToast } = useAppShell()
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBasePayload[]>([])
  const [kbId, setKbId] = useState("")
  const [entries, setEntries] = useState<FaqEntryPayload[]>([])
  const [statusFilter, setStatusFilter] = useState<"" | FaqEntryStatus>("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [draftIssues, setDraftIssues] = useState<string[]>([])
  const [importOpen, setImportOpen] = useState(false)
  const [importFormat, setImportFormat] = useState<"json" | "csv">("json")
  const [importText, setImportText] = useState("")
  const [importResult, setImportResult] = useState<FaqImportResultPayload | null>(null)
  const [versionsFor, setVersionsFor] = useState<{
    entry: FaqEntryPayload
    versions: FaqEntryVersionPayload[]
  } | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  useEffect(() => {
    if (!open) return
    let active = true
    fetchKnowledgeBases()
      .then((list) => {
        if (!active) return
        setKnowledgeBases(list)
        setKbId((current) => current || list[0]?.id || "")
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
    return () => {
      active = false
    }
  }, [open])

  const refresh = useCallback(async () => {
    if (!kbId) return
    setLoading(true)
    setError(null)
    try {
      setEntries(await fetchFaqEntries(kbId, statusFilter || undefined))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [kbId, statusFilter])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  const runCommand = async (action: () => Promise<void>, successText: string) => {
    if (busy) return
    setBusy(true)
    setDraftIssues([])
    try {
      await action()
      showToast(successText)
      await refresh()
    } catch (commandError) {
      if (commandError instanceof FaqCommandError) {
        const conflict = commandError.conflict
        if (conflict) {
          setDraftIssues([
            `${commandError.message}（冲突条目 ${String(conflict.conflictingEntryId).slice(0, 8)}）`,
          ])
        } else {
          setDraftIssues(
            commandError.issues.length > 0 ? commandError.issues : [commandError.message]
          )
        }
      } else {
        setDraftIssues([
          commandError instanceof Error ? commandError.message : "FAQ 操作失败",
        ])
      }
    } finally {
      setBusy(false)
    }
  }

  const startCreate = () => {
    setVersionsFor(null)
    setImportOpen(false)
    setDraft(emptyDraft())
    setDraftIssues([])
  }

  const startEdit = (entry: FaqEntryPayload) => {
    setVersionsFor(null)
    setImportOpen(false)
    setDraft({
      id: entry.id,
      question: entry.version.question,
      variants: entry.version.variants.join(" | "),
      answer: entry.version.answer,
      sourceTitle: entry.version.source?.title ?? "",
      sourceUri: entry.version.source?.uri ?? "",
    })
    setDraftIssues([])
  }

  const submitDraft = async () => {
    if (!draft || !kbId) return
    const body = {
      question: draft.question.trim(),
      answer: draft.answer.trim(),
      variants: draft.variants
        .split("|")
        .map((value) => value.trim())
        .filter(Boolean),
      source: draft.sourceTitle.trim()
        ? { title: draft.sourceTitle.trim(), uri: draft.sourceUri.trim() || null }
        : null,
    }
    await runCommand(async () => {
      if (draft.id) await editFaqEntry(kbId, draft.id, body)
      else await createFaqEntry(kbId, body)
      setDraft(null)
    }, draft.id ? "已保存为新版本" : "条目已创建")
  }

  const toggleStatus = async (entry: FaqEntryPayload) => {
    const next: FaqEntryStatus = entry.status === "active" ? "disabled" : "active"
    await runCommand(
      () => setFaqEntryStatus(kbId, entry.id, next).then(() => undefined),
      next === "active" ? "条目已启用" : "条目已停用（不再参与检索）"
    )
  }

  const showVersions = async (entry: FaqEntryPayload) => {
    setDraft(null)
    setImportOpen(false)
    await runCommand(async () => {
      setVersionsFor({ entry, versions: await fetchFaqEntryVersions(kbId, entry.id) })
    }, "已读取版本历史")
  }

  const runImport = async () => {
    if (!kbId || !importText.trim()) return
    setImportResult(null)
    await runCommand(async () => {
      const result = await importFaqEntries(kbId, importFormat, importText)
      setImportResult(result)
    }, "导入完成（逐行结果见下方）")
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      aria-labelledby="faq-title"
      className="m-auto h-[min(700px,calc(100dvh-48px))] w-[min(760px,calc(100vw-32px))] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-dialog backdrop:bg-black/20 open:grid open:animate-dialog-enter max-md:m-0 max-md:h-dvh max-md:w-screen max-md:rounded-none max-md:border-0"
    >
      <div className="flex h-13 flex-none items-center justify-between border-b border-line px-5 max-md:px-4">
        <div className="flex items-center gap-2">
          <Icon icon={HelpCircle} className="size-4 text-muted" />
          <h2 id="faq-title" className="text-sm font-semibold text-ink">
            标准问答（FAQ）
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭标准问答"
          title="关闭"
          className="grid size-7 flex-none cursor-pointer place-items-center rounded-md text-muted/70 transition-colors hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-brand"
        >
          <Icon icon={X} className="size-3.5" />
        </button>
      </div>

      <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4 max-md:px-4">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-1 flex-col gap-1 text-[11px] text-muted/70">
            <span>知识库</span>
            <select
              value={kbId}
              onChange={(event) => {
                setKbId(event.target.value)
                setDraft(null)
                setVersionsFor(null)
                setImportResult(null)
              }}
              className="w-full cursor-pointer rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-ink outline-none focus:border-brand focus-visible:outline-2 focus-visible:outline-brand"
            >
              {knowledgeBases.length === 0 ? <option value="">（暂无知识库）</option> : null}
              {knowledgeBases.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.status === "archived" ? "（已归档）" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted/70">
            <span>状态</span>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as "" | FaqEntryStatus)}
              className="cursor-pointer rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-ink outline-none focus:border-brand focus-visible:outline-2 focus-visible:outline-brand"
            >
              <option value="">全部</option>
              <option value="active">生效中</option>
              <option value="disabled">已停用</option>
            </select>
          </label>
          <button
            type="button"
            disabled={!kbId || busy}
            onClick={startCreate}
            className="h-7 cursor-pointer rounded-md bg-neutral-900 px-2.5 text-[11px] text-white transition-colors hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-200 dark:text-neutral-900"
          >
            新建条目
          </button>
          <button
            type="button"
            disabled={!kbId || busy}
            onClick={() => {
              setDraft(null)
              setVersionsFor(null)
              setImportResult(null)
              setImportOpen((current) => !current)
            }}
            className="h-7 cursor-pointer rounded-md border border-line bg-surface px-2.5 text-[11px] text-muted transition-colors hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
          >
            导入 JSON/CSV
          </button>
        </div>

        {error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400" role="alert">
            {error}
          </p>
        ) : null}

        {draft ? (
          <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-subtle/40 px-3 py-3">
            <p className="text-[11px] font-semibold text-ink">
              {draft.id ? "编辑条目（保存=新增版本）" : "新建条目"}
            </p>
            <label className="flex flex-col gap-1 text-[11px] text-muted/70">
              <span>标准问题</span>
              <input
                value={draft.question}
                onChange={(event) => setDraft({ ...draft, question: event.target.value })}
                className="rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-ink outline-none focus:border-brand"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-muted/70">
              <span>变体（用 | 分隔）</span>
              <input
                value={draft.variants}
                onChange={(event) => setDraft({ ...draft, variants: event.target.value })}
                className="rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-ink outline-none focus:border-brand"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-muted/70">
              <span>标准答案</span>
              <textarea
                value={draft.answer}
                rows={4}
                onChange={(event) => setDraft({ ...draft, answer: event.target.value })}
                className="resize-y rounded-md border border-line bg-surface px-2 py-1 text-[11px] leading-relaxed text-ink outline-none focus:border-brand"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <label className="flex flex-1 flex-col gap-1 text-[11px] text-muted/70">
                <span>来源标题（可选）</span>
                <input
                  value={draft.sourceTitle}
                  onChange={(event) => setDraft({ ...draft, sourceTitle: event.target.value })}
                  className="rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-ink outline-none focus:border-brand"
                />
              </label>
              <label className="flex flex-1 flex-col gap-1 text-[11px] text-muted/70">
                <span>来源定位（可选）</span>
                <input
                  value={draft.sourceUri}
                  onChange={(event) => setDraft({ ...draft, sourceUri: event.target.value })}
                  className="rounded-md border border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-brand"
                />
              </label>
            </div>
            {draftIssues.length > 0 ? (
              <ul className="list-disc space-y-1 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400" role="alert">
                {draftIssues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            ) : null}
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy || !draft.question.trim() || !draft.answer.trim()}
                onClick={() => void submitDraft()}
                className="h-7 cursor-pointer rounded-md bg-neutral-900 px-2.5 text-[11px] text-white transition-colors hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-200 dark:text-neutral-900"
              >
                {busy ? "保存中…" : "保存"}
              </button>
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="h-7 cursor-pointer rounded-md border border-line bg-surface px-2.5 text-[11px] text-muted transition-colors hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-brand"
              >
                取消
              </button>
            </div>
          </div>
        ) : null}

        {importOpen ? (
          <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-subtle/40 px-3 py-3">
            <p className="text-[11px] font-semibold text-ink">导入条目</p>
            <label className="flex items-center justify-between gap-2 text-[11px] text-muted/70">
              <span>格式</span>
              <select
                value={importFormat}
                onChange={(event) => setImportFormat(event.target.value as "json" | "csv")}
                className="cursor-pointer rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-ink outline-none focus:border-brand"
              >
                <option value="json">JSON 数组</option>
                <option value="csv">CSV</option>
              </select>
            </label>
            <textarea
              value={importText}
              rows={6}
              spellCheck={false}
              onChange={(event) => setImportText(event.target.value)}
              placeholder={
                importFormat === "json"
                  ? '[{"question":"退款多久到账？","answer":"3 个工作日。","variants":["退款几天到"]}]'
                  : "question,answer,variants,source_title,source_uri"
              }
              className="w-full resize-y rounded-md border border-line bg-surface px-2 py-1 font-mono text-[11px] leading-relaxed text-ink outline-none focus:border-brand"
            />
            <p className="text-[10px] text-muted/50">
              逐行校验：非法行与重复行会被指名跳过，合法行照常入库；同一标准问题已存在时会追加为新版本。
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy || !importText.trim()}
                onClick={() => void runImport()}
                className="h-7 cursor-pointer rounded-md bg-neutral-900 px-2.5 text-[11px] text-white transition-colors hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-200 dark:text-neutral-900"
              >
                {busy ? "导入中…" : "导入"}
              </button>
              <button
                type="button"
                onClick={() => setImportOpen(false)}
                className="h-7 cursor-pointer rounded-md border border-line bg-surface px-2.5 text-[11px] text-muted transition-colors hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-brand"
              >
                收起
              </button>
            </div>
            {importResult ? (
              <div className="rounded-lg border border-line bg-surface px-3 py-2">
                <p className="text-[11px] text-ink">
                  新建 {importResult.imported} 条 · 追加版本 {importResult.versioned} 条 · 跳过{" "}
                  {importResult.skipped} 条
                </p>
                {importResult.issues.length > 0 ? (
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 font-mono text-[10px] text-muted/70">
                    {importResult.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {versionsFor ? (
          <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-subtle/40 px-3 py-2.5">
            <p className="text-[11px] font-semibold text-ink">
              {versionsFor.entry.version.question} · 版本历史
              <span className="ml-2 font-normal text-muted/50">旧版本只读，永远不会被改写</span>
            </p>
            <ul className="flex flex-col gap-1">
              {versionsFor.versions.map((item) => (
                <li key={item.version} className="rounded-md bg-surface px-2.5 py-1.5 text-[11px]">
                  <p className="font-mono text-[10px] text-muted/60">
                    v{item.version} · {item.createdAt} · {item.createdBy}
                    {item.version === versionsFor.entry.currentVersion ? " · 当前" : ""}
                  </p>
                  <p className="mt-0.5 text-ink">{item.answer}</p>
                  {item.source ? (
                    <p className="mt-0.5 font-mono text-[10px] text-muted/50">
                      来源 {item.source.title}
                      {item.source.uri ? ` · ${item.source.uri}` : ""}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setVersionsFor(null)}
              className="mt-1 h-6 w-fit cursor-pointer rounded-md border border-line bg-surface px-2 text-[10px] text-muted transition-colors hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-brand"
            >
              收起版本
            </button>
          </div>
        ) : null}

        {loading ? (
          <p className="text-[11px] text-muted/50" role="status">
            正在读取条目…
          </p>
        ) : entries.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted/70">该知识库没有符合条件的条目。</p>
        ) : null}

        <ul className="flex flex-col gap-2">
          {entries.map((entry) => (
            <li key={entry.id} className="rounded-lg border border-line bg-surface-subtle/40 px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-xs font-semibold text-ink" title={entry.version.question}>
                    {entry.version.question}
                  </span>
                  <span
                    className={cn(
                      "flex-none rounded-full px-2 py-0.5 text-[10px] font-medium",
                      entry.status === "active"
                        ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400"
                        : "bg-surface-subtle text-muted",
                    )}
                  >
                    {STATUS_LABELS[entry.status]}
                  </span>
                  <span className="flex-none font-mono text-[10px] text-muted/50">
                    v{entry.currentVersion}
                  </span>
                </span>
                <span className="flex flex-none items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => startEdit(entry)}
                    className="cursor-pointer rounded-md border border-line bg-surface px-2 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void toggleStatus(entry)}
                    className="cursor-pointer rounded-md border border-line bg-surface px-2 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {entry.status === "active" ? "停用" : "启用"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void showVersions(entry)}
                    className="cursor-pointer rounded-md border border-line bg-surface px-2 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    版本
                  </button>
                </span>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-ink">{entry.version.answer}</p>
              {entry.version.variants.length > 0 ? (
                <p className="mt-1 text-[10px] text-muted/60">
                  变体：{entry.version.variants.join(" · ")}
                </p>
              ) : null}
              {entry.version.source ? (
                <p className="mt-0.5 font-mono text-[10px] text-muted/50">
                  来源 {entry.version.source.title}
                  {entry.version.source.uri ? ` · ${entry.version.source.uri}` : ""}
                </p>
              ) : null}
              <p className="mt-0.5 font-mono text-[10px] text-muted/40">
                归一化问题 {entry.version.normalizedQuestion}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </dialog>
  )
}
