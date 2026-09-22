import { Archive, ArchiveRestore, Bot, Pencil, Plus, X } from "lucide"
import { useEffect, useRef, useState } from "react"

import { Icon } from "../ui/Icon"
import { useAppShell } from "../../runtime/AppShellContext"
import { useKnowledgeBases } from "../../runtime/knowledgeStore"
import {
  archiveAssistant,
  createAssistant,
  editAssistant,
  fetchAssistants,
  restoreAssistant,
  type AssistantConfigPayload,
  type AssistantPayload,
} from "../../lib/api"

/**
 * Ticket 18 (AST-01A): the assistant workspace. Administrators create, edit
 * (each config edit becomes a new immutable version), archive and restore
 * assistants; readers see only group-visible metadata. The editor carries the
 * validated contract: name/description limits, knowledge-base bindings from
 * the live workspace list, model-profile ids as fixed choices, and the
 * tool-policy enum. Empty, validation, error and archived states each have an
 * explicit rendering.
 */

const DEFAULT_CONFIG: AssistantConfigPayload = {
  systemPrompt: "",
  knowledgeBaseIds: [],
  chatModelProfileId: "chat",
  rerankModelProfileId: null,
  toolPolicy: "read_only_retrieval",
  memoryEnabled: false,
}

interface FormState {
  name: string
  description: string
  allowedGroups: string
  systemPrompt: string
  knowledgeBaseIds: string[]
  rerankBound: boolean
  toolPolicy: AssistantConfigPayload["toolPolicy"]
  memoryEnabled: boolean
}

function formFrom(assistant: AssistantPayload | null): FormState {
  if (!assistant) {
    return {
      name: "",
      description: "",
      allowedGroups: "",
      systemPrompt: DEFAULT_CONFIG.systemPrompt,
      knowledgeBaseIds: [],
      rerankBound: false,
      toolPolicy: DEFAULT_CONFIG.toolPolicy,
      memoryEnabled: false,
    }
  }
  return {
    name: assistant.name,
    description: assistant.description,
    allowedGroups: (assistant.allowedGroups ?? []).join(", "),
    systemPrompt: assistant.config?.systemPrompt ?? "",
    knowledgeBaseIds: assistant.config?.knowledgeBaseIds ?? [],
    rerankBound: (assistant.config?.rerankModelProfileId ?? null) === "rerank",
    toolPolicy: assistant.config?.toolPolicy ?? "read_only_retrieval",
    memoryEnabled: assistant.config?.memoryEnabled ?? false,
  }
}

function DialogButton({
  onClick,
  disabled,
  title,
  tone = "neutral",
  children,
}: {
  onClick: () => void
  disabled?: boolean
  title: string
  tone?: "neutral" | "brand"
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={
        tone === "brand"
          ? "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-brand px-2.5 text-xs font-medium text-white transition-[colors,transform] duration-150 ease-out hover:bg-brand-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          : "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs text-muted transition-colors hover:bg-surface-subtle hover:text-ink active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
      }
    >
      {children}
    </button>
  )
}

function VersionChips({ assistant }: { assistant: AssistantPayload }) {
  return (
    <span className="rounded-full border border-line bg-surface-subtle px-1.5 py-0.5 font-mono text-[10px] text-muted">
      v{assistant.currentVersion}
    </span>
  )
}

export function AssistantsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { showToast } = useAppShell()
  const { activeKnowledgeBases } = useKnowledgeBases()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [assistants, setAssistants] = useState<AssistantPayload[]>([])
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<AssistantPayload | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<FormState>(formFrom(null))
  const [validation, setValidation] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setAssistants(await fetchAssistants())
    } catch (err) {
      setError(err instanceof Error ? err.message : "助手列表读取失败")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      void load()
    } else if (!open && dialog.open) {
      dialog.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const startCreate = () => {
    setEditing(null)
    setForm(formFrom(null))
    setValidation(null)
    setCreating(true)
  }

  const startEdit = (assistant: AssistantPayload) => {
    setCreating(false)
    setValidation(null)
    setEditing(assistant)
    setForm(formFrom(assistant))
  }

  const closeEditor = () => {
    setCreating(false)
    setEditing(null)
    setValidation(null)
  }

  const handleSave = async () => {
    if (!form.name.trim()) {
      setValidation("助手名称必填")
      return
    }
    if (form.name.trim().length > 200) {
      setValidation("助手名称最多 200 字符")
      return
    }
    if (form.systemPrompt.length > 8000) {
      setValidation("系统提示词最多 8000 字符")
      return
    }
    setValidation(null)
    setBusy(true)
    const config: AssistantConfigPayload = {
      systemPrompt: form.systemPrompt,
      knowledgeBaseIds: form.knowledgeBaseIds,
      chatModelProfileId: "chat",
      rerankModelProfileId: form.rerankBound ? "rerank" : null,
      toolPolicy: form.toolPolicy,
      memoryEnabled: form.memoryEnabled,
    }
    const allowedGroups = form.allowedGroups
      .split(",")
      .map((g) => g.trim())
      .filter((g) => g.length > 0)
    // Field-wise compare against the server's config shape (never key-order
    // sensitive), so a metadata-only save cannot mint a spurious version.
    const previousConfig = editing?.config
    const configChanged =
      !previousConfig ||
      previousConfig.systemPrompt !== config.systemPrompt ||
      JSON.stringify(previousConfig.knowledgeBaseIds) !== JSON.stringify(config.knowledgeBaseIds) ||
      previousConfig.rerankModelProfileId !== config.rerankModelProfileId ||
      previousConfig.toolPolicy !== config.toolPolicy ||
      previousConfig.memoryEnabled !== config.memoryEnabled
    try {
      if (editing) {
        const updated = await editAssistant(editing.id, {
          name: form.name.trim(),
          description: form.description,
          allowedGroups,
          ...(configChanged ? { config } : {}),
        })
        setAssistants((previous) => previous.map((a) => (a.id === updated.id ? updated : a)))
        showToast("助手已保存")
      } else {
        const created = await createAssistant({
          name: form.name.trim(),
          description: form.description,
          allowedGroups,
          config,
        })
        setAssistants((previous) => [...previous, created])
        showToast("助手已创建")
      }
      closeEditor()
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存失败")
    } finally {
      setBusy(false)
    }
  }

  const handleArchive = async (assistant: AssistantPayload) => {
    setBusy(true)
    try {
      const updated = await archiveAssistant(assistant.id)
      setAssistants((previous) => previous.map((a) => (a.id === updated.id ? updated : a)))
      showToast(`「${assistant.name}」已归档`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : "归档失败")
    } finally {
      setBusy(false)
    }
  }

  const handleRestore = async (assistant: AssistantPayload) => {
    setBusy(true)
    try {
      const updated = await restoreAssistant(assistant.id)
      setAssistants((previous) => previous.map((a) => (a.id === updated.id ? updated : a)))
      showToast(`「${assistant.name}」已恢复`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : "恢复失败")
    } finally {
      setBusy(false)
    }
  }

  const toggleKnowledgeBase = (id: string) => {
    setForm((previous) => ({
      ...previous,
      knowledgeBaseIds: previous.knowledgeBaseIds.includes(id)
        ? previous.knowledgeBaseIds.filter((existing) => existing !== id)
        : [...previous.knowledgeBaseIds, id],
    }))
  }

  const editorOpen = creating || editing !== null

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      aria-labelledby="assistants-title"
      className="m-auto h-[min(680px,calc(100dvh-48px))] w-[min(680px,calc(100vw-32px))] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-dialog backdrop:bg-black/20 open:grid open:animate-dialog-enter max-md:m-0 max-md:h-dvh max-md:w-screen max-md:rounded-none max-md:border-0"
    >
      <div className="flex h-13 flex-none items-center justify-between border-b border-line px-5 max-md:px-4">
        <div className="flex items-center gap-2">
          <Icon icon={Bot} className="size-4 text-muted" />
          <h2 id="assistants-title" className="text-sm font-semibold text-ink">
            助手管理
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭助手管理"
          title="关闭"
          className="grid size-7 flex-none cursor-pointer place-items-center rounded-md text-muted/70 transition-colors hover:bg-surface-subtle hover:text-ink"
        >
          <Icon icon={X} className="size-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-col overflow-y-auto px-5 py-4 max-md:px-4">
        {editorOpen ? (
          <div className="mb-4 rounded-lg border border-line bg-surface-subtle/60 p-3">
            <p className="text-[11px] font-medium text-ink">
              {editing ? `编辑「${editing.name}」（配置修改将生成新版本）` : "新建助手"}
            </p>
            <div className="mt-2 flex flex-col gap-2">
              <input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="助手名称（必填）"
                maxLength={200}
                className="h-8 w-full rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-brand"
              />
              <input
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
                placeholder="描述（可选）"
                maxLength={2000}
                className="h-8 w-full rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-brand"
              />
              <textarea
                value={form.systemPrompt}
                onChange={(event) => setForm({ ...form, systemPrompt: event.target.value })}
                placeholder="系统提示词（可选，最多 8000 字符）"
                rows={3}
                className="w-full resize-y rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-ink outline-none focus:border-brand"
              />
              {activeKnowledgeBases.length > 0 || form.knowledgeBaseIds.length > 0 ? (
                <div>
                  <p className="text-[11px] text-muted">绑定知识库（可多选，留空 = 无知识上下文）</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {(() => {
                      // Union: every bound id stays visible even when it is no
                      // longer in the active list (e.g. archived afterwards) —
                      // otherwise an admin could neither see nor unbind it.
                      const seen = new Set<string>()
                      const chips: Array<{ id: string; name: string }> = []
                      for (const id of form.knowledgeBaseIds) {
                        if (seen.has(id)) continue
                        seen.add(id)
                        chips.push({ id, name: activeKnowledgeBases.find((b) => b.id === id)?.name ?? id })
                      }
                      for (const base of activeKnowledgeBases) {
                        if (!seen.has(base.id)) chips.push({ id: base.id, name: base.name })
                      }
                      return chips.map(({ id, name }) => {
                        const selected = form.knowledgeBaseIds.includes(id)
                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() => toggleKnowledgeBase(id)}
                            aria-pressed={selected}
                            className={
                              selected
                                ? "cursor-pointer rounded-full border border-brand bg-brand-subtle px-2 py-0.5 text-[11px] text-brand"
                                : "cursor-pointer rounded-full border border-line px-2 py-0.5 text-[11px] text-muted hover:text-ink"
                            }
                          >
                            {name}
                          </button>
                        )
                      })
                    })()}
                  </div>
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted">
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={form.rerankBound}
                    onChange={(event) => setForm({ ...form, rerankBound: event.target.checked })}
                    className="accent-[var(--color-brand)]"
                  />
                  绑定重排序模型
                </label>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={form.memoryEnabled}
                    onChange={(event) => setForm({ ...form, memoryEnabled: event.target.checked })}
                    className="accent-[var(--color-brand)]"
                  />
                  启用会话记忆
                </label>
                <label className="flex items-center gap-1.5">
                  工具策略
                  <select
                    value={form.toolPolicy}
                    onChange={(event) =>
                      setForm({ ...form, toolPolicy: event.target.value as FormState["toolPolicy"] })
                    }
                    className="h-7 cursor-pointer rounded-md border border-line bg-surface px-1.5 text-[11px] text-ink outline-none focus:border-brand"
                  >
                    <option value="read_only_retrieval">只读检索</option>
                    <option value="none">不使用工具</option>
                  </select>
                </label>
              </div>
              <input
                value={form.allowedGroups}
                onChange={(event) => setForm({ ...form, allowedGroups: event.target.value })}
                placeholder="可见分组（逗号分隔，留空 = 全员可见）"
                className="h-8 w-full rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-brand"
              />
            </div>
            {validation ? (
              <p role="alert" className="mt-2 text-[11px] text-red-600 dark:text-red-400">
                {validation}
              </p>
            ) : null}
            <div className="mt-2.5 flex justify-end gap-2">
              <DialogButton onClick={closeEditor} title="取消">
                取消
              </DialogButton>
              <DialogButton onClick={() => void handleSave()} disabled={busy} tone="brand" title="保存">
                保存
              </DialogButton>
            </div>
          </div>
        ) : (
          <div className="mb-4 flex justify-end">
            <DialogButton onClick={startCreate} disabled={busy} tone="brand" title="新建助手">
              <Icon icon={Plus} className="size-3.5" />
              新建助手
            </DialogButton>
          </div>
        )}

        {loading ? (
          <p className="px-1 py-6 text-center text-xs text-muted">正在加载助手…</p>
        ) : error ? (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/40">
            <p className="text-xs text-red-700 dark:text-red-300">助手列表读取失败：{error}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-2 cursor-pointer text-xs font-medium text-brand hover:underline"
            >
              重试
            </button>
          </div>
        ) : assistants.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted">
            还没有助手，点击「新建助手」创建第一个。
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {assistants.map((assistant) => (
              <li
                key={assistant.id}
                className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5 max-md:flex-wrap"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-xs font-medium text-ink">{assistant.name}</span>
                    <VersionChips assistant={assistant} />
                    {assistant.status === "archived" ? (
                      <span className="rounded-full border border-line bg-surface-subtle px-1.5 py-0.5 font-mono text-[10px] text-muted">
                        已归档
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-muted/80">
                    {assistant.description || "无描述"}
                    {assistant.config
                      ? ` · ${assistant.config.toolPolicy === "none" ? "无工具" : "只读检索"}${
                          assistant.config.rerankModelProfileId === "rerank" ? " · 重排序" : ""
                        }${assistant.config.memoryEnabled ? " · 记忆" : ""}`
                      : ""}
                  </p>
                </div>
                <div className="flex flex-none items-center gap-1.5 max-md:w-full max-md:justify-end">
                  {assistant.status === "active" ? (
                    <DialogButton
                      onClick={() => startEdit(assistant)}
                      disabled={busy}
                      title="编辑（配置修改将生成新版本）"
                    >
                      <Icon icon={Pencil} className="size-3.5" />
                      编辑
                    </DialogButton>
                  ) : null}
                  {assistant.status === "active" ? (
                    <DialogButton
                      onClick={() => void handleArchive(assistant)}
                      disabled={busy}
                      title="归档后不可编辑，历史版本仍可引用"
                    >
                      <Icon icon={Archive} className="size-3.5" />
                      归档
                    </DialogButton>
                  ) : (
                    <DialogButton onClick={() => void handleRestore(assistant)} disabled={busy} title="恢复为启用">
                      <Icon icon={ArchiveRestore} className="size-3.5" />
                      恢复
                    </DialogButton>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </dialog>
  )
}
