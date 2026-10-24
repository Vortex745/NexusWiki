import { Alert, AlertDescription } from "@/components/primitives/alert"
import { HelpCircle, Plus } from "../ui/icons"
import { useCallback, useEffect, useState } from "react"

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
import { useAppShell } from "../../runtime/AppShellContext"
import { Dialog } from "../ui/Dialog"
import {
  Button,
  EmptyState,
  Field,
  Select,
  StatusBadge,
  TextArea,
  TextInput,
} from "../ui/Controls"

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
export function FaqDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const { showToast } = useAppShell()
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBasePayload[]>(
    [],
  )
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
  const [importResult, setImportResult] =
    useState<FaqImportResultPayload | null>(null)
  const [versionsFor, setVersionsFor] = useState<{
    entry: FaqEntryPayload
    versions: FaqEntryVersionPayload[]
  } | null>(null)

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
        if (active)
          setError(
            loadError instanceof Error ? loadError.message : String(loadError),
          )
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
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      )
    } finally {
      setLoading(false)
    }
  }, [kbId, statusFilter])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  const runCommand = async (
    action: () => Promise<void>,
    successText: string,
  ) => {
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
            commandError.issues.length > 0
              ? commandError.issues
              : [commandError.message],
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
        ? {
            title: draft.sourceTitle.trim(),
            uri: draft.sourceUri.trim() || null,
          }
        : null,
    }
    await runCommand(
      async () => {
        if (draft.id) await editFaqEntry(kbId, draft.id, body)
        else await createFaqEntry(kbId, body)
        setDraft(null)
      },
      draft.id ? "已保存为新版本" : "条目已创建",
    )
  }

  const toggleStatus = async (entry: FaqEntryPayload) => {
    const next: FaqEntryStatus =
      entry.status === "active" ? "disabled" : "active"
    await runCommand(
      () => setFaqEntryStatus(kbId, entry.id, next).then(() => undefined),
      next === "active" ? "条目已启用" : "条目已停用（不再参与检索）",
    )
  }

  const showVersions = async (entry: FaqEntryPayload) => {
    setDraft(null)
    setImportOpen(false)
    await runCommand(async () => {
      setVersionsFor({
        entry,
        versions: await fetchFaqEntryVersions(kbId, entry.id),
      })
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
    <Dialog
      open={open}
      onClose={onClose}
      title="标准问答（FAQ）"
      titleId="faq-title"
      icon={HelpCircle}
      tier="work"
      toolbar={
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-44 flex-1">
            <Field label="知识库">
              <Select
                value={kbId}
                onChange={(event) => {
                  setKbId(event.target.value)
                  setDraft(null)
                  setVersionsFor(null)
                  setImportResult(null)
                }}
              >
                {knowledgeBases.length === 0 ? (
                  <option value="">（暂无知识库）</option>
                ) : null}
                {knowledgeBases.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.status === "archived" ? "（已归档）" : ""}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="w-28 flex-none">
            <Field label="状态">
              <Select
                value={statusFilter}
                onChange={(event) =>
                  setStatusFilter(event.target.value as "" | FaqEntryStatus)
                }
              >
                <option value="">全部</option>
                <option value="active">生效中</option>
                <option value="disabled">已停用</option>
              </Select>
            </Field>
          </div>
          <Button
            tone="primary"
            icon={Plus}
            disabled={!kbId || busy}
            onClick={startCreate}
          >
            新建条目
          </Button>
          <Button
            disabled={!kbId || busy}
            onClick={() => {
              setDraft(null)
              setVersionsFor(null)
              setImportResult(null)
              setImportOpen((current) => !current)
            }}
          >
            导入 JSON/CSV
          </Button>
        </div>
      }
    >
      {error ? (
        <Alert variant="destructive" className="border px-3 py-2" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {draft ? (
        <div className="flex flex-col gap-2 rounded-[14px] border border-brand-line bg-brand-subtle/40 p-3">
          {/* Create mode adds no heading: the open panel is the CTA's own state, and
              "新建条目" here only repeated the button that opened it. */}
          {draft.id ? (
            <p className="text-[11px] font-medium text-ink">
              编辑条目（保存=新增版本）
            </p>
          ) : null}
          <Field label="标准问题">
            <TextInput
              value={draft.question}
              onChange={(event) =>
                setDraft({ ...draft, question: event.target.value })
              }
            />
          </Field>
          <Field label="变体（用 | 分隔）">
            <TextInput
              value={draft.variants}
              onChange={(event) =>
                setDraft({ ...draft, variants: event.target.value })
              }
            />
          </Field>
          <Field label="标准答案">
            <TextArea
              value={draft.answer}
              rows={4}
              onChange={(event) =>
                setDraft({ ...draft, answer: event.target.value })
              }
            />
          </Field>
          <div className="flex gap-2 max-md:flex-col">
            <div className="min-w-0 flex-1">
              <Field label="来源标题（可选）">
                <TextInput
                  value={draft.sourceTitle}
                  onChange={(event) =>
                    setDraft({ ...draft, sourceTitle: event.target.value })
                  }
                />
              </Field>
            </div>
            <div className="min-w-0 flex-1">
              <Field label="来源定位（可选）">
                <TextInput
                  value={draft.sourceUri}
                  onChange={(event) =>
                    setDraft({ ...draft, sourceUri: event.target.value })
                  }
                  className=""
                />
              </Field>
            </div>
          </div>
          {draftIssues.length > 0 ? (
            <ul
              className="list-disc flex flex-col gap-1 rounded-[14px] border border-danger-line bg-danger-subtle px-4 py-2 text-[11px] text-danger"
              role="alert"
            >
              {draftIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              tone="primary"
              disabled={busy || !draft.question.trim() || !draft.answer.trim()}
              onClick={() => void submitDraft()}
            >
              {busy ? "保存中…" : "保存"}
            </Button>
            <Button size="sm" onClick={() => setDraft(null)}>
              取消
            </Button>
          </div>
        </div>
      ) : null}

      {importOpen ? (
        <div className="flex flex-col gap-2 rounded-[14px] border border-brand-line bg-brand-subtle/40 p-3">
          <div className="w-40">
            <Field label="格式">
              <Select
                value={importFormat}
                onChange={(event) =>
                  setImportFormat(event.target.value as "json" | "csv")
                }
              >
                <option value="json">JSON 数组</option>
                <option value="csv">CSV</option>
              </Select>
            </Field>
          </div>
          <TextArea
            value={importText}
            rows={6}
            spellCheck={false}
            onChange={(event) => setImportText(event.target.value)}
            placeholder={
              importFormat === "json"
                ? '[{"question":"退款多久到账？","answer":"3 个工作日。","variants":["退款几天到"]}]'
                : "question,answer,variants,source_title,source_uri"
            }
            className=""
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            逐行校验：非法行与重复行会被指名跳过，合法行照常入库；同一标准问题已存在时会追加为新版本。
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              tone="primary"
              disabled={busy || !importText.trim()}
              onClick={() => void runImport()}
            >
              {busy ? "导入中…" : "导入"}
            </Button>
            <Button size="sm" onClick={() => setImportOpen(false)}>
              收起
            </Button>
          </div>
          {importResult ? (
            <div className="rounded-[14px] border border-line bg-surface px-3 py-2">
              <p className="text-[11px] text-ink">
                新建 {importResult.imported} 条 · 追加版本{" "}
                {importResult.versioned} 条 · 跳过 {importResult.skipped} 条
              </p>
              {importResult.issues.length > 0 ? (
                <ul className="mt-1 list-disc flex flex-col gap-0.5 pl-4 font-mono text-[10px] text-muted-foreground">
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
        <div className="flex flex-col gap-1.5 rounded-[14px] border border-line bg-surface-subtle px-3 py-2.5">
          <p className="text-[11px] font-medium text-ink">
            {versionsFor.entry.version.question} · 版本历史
            <span className="ml-2 font-normal text-faint">
              旧版本只读，永远不会被改写
            </span>
          </p>
          <ul className="flex flex-col gap-1">
            {versionsFor.versions.map((item) => (
              <li
                key={item.version}
                className="rounded-[10px] border border-line bg-surface px-2.5 py-1.5 text-[11px]"
              >
                <p className="font-mono text-[10px] text-faint">
                  v{item.version} · {item.createdAt} · {item.createdBy}
                  {item.version === versionsFor.entry.currentVersion
                    ? " · 当前"
                    : ""}
                </p>
                <p className="mt-0.5 text-ink">{item.answer}</p>
                {item.source ? (
                  <p className="mt-0.5 font-mono text-[10px] text-faint">
                    来源 {item.source.title}
                    {item.source.uri ? ` · ${item.source.uri}` : ""}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            className="mt-1 self-start"
            onClick={() => setVersionsFor(null)}
          >
            收起版本
          </Button>
        </div>
      ) : null}

      {loading ? (
        <p
          role="status"
          className="px-1 py-6 text-center text-xs text-muted-foreground"
        >
          正在读取条目…
        </p>
      ) : entries.length === 0 ? (
        <EmptyState icon={HelpCircle} message="该知识库没有符合条件的条目。" />
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="rounded-[14px] border border-line bg-surface-subtle px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="truncate text-xs font-semibold text-ink"
                    title={entry.version.question}
                  >
                    {entry.version.question}
                  </span>
                  <StatusBadge
                    tone={entry.status === "active" ? "success" : "neutral"}
                  >
                    {STATUS_LABELS[entry.status]}
                  </StatusBadge>
                  <span className="flex-none font-mono text-[10px] text-faint">
                    v{entry.currentVersion}
                  </span>
                </span>
                <span className="flex flex-none items-center gap-1.5 max-md:w-full max-md:justify-end">
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => startEdit(entry)}
                  >
                    编辑
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void toggleStatus(entry)}
                  >
                    {entry.status === "active" ? "停用" : "启用"}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void showVersions(entry)}
                  >
                    版本
                  </Button>
                </span>
              </div>
              {/* Two lines only: the card list is an index of questions, and an
                  un-clamped answer made every screen read as answer prose. The
                  full text stays reachable via 版本 and this title. */}
              <p
                className="mt-1.5 line-clamp-2 overflow-hidden text-xs leading-relaxed text-ink"
                title={entry.version.answer}
              >
                {entry.version.answer}
              </p>
              {entry.version.variants.length > 0 ? (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  变体：{entry.version.variants.join(" · ")}
                </p>
              ) : null}
              {entry.version.source ? (
                <p className="mt-0.5 font-mono text-[10px] text-faint">
                  来源 {entry.version.source.title}
                  {entry.version.source.uri
                    ? ` · ${entry.version.source.uri}`
                    : ""}
                </p>
              ) : null}
              <p className="mt-0.5 font-mono text-[10px] text-faint">
                归一化问题 {entry.version.normalizedQuestion}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
