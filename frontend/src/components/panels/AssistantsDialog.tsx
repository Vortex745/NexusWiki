import { Button as UiButton } from "@/components/primitives/button"
import { Alert, AlertDescription } from "@/components/primitives/alert"
import { Archive, ArchiveRestore, Bot, Pencil, Plus, Trash2 } from "../ui/icons"
import { useState } from "react"

import { useAppShell } from "../../runtime/AppShellContext"
import {
  assistantStore,
  isDefaultAssistantId,
} from "../../runtime/assistantStore"
import { useKnowledgeBases } from "../../runtime/knowledgeStore"
import { Dialog } from "../ui/Dialog"
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  Select,
  StatusBadge,
  TextArea,
  TextInput,
} from "../ui/Controls"
import {
  archiveAssistant,
  createAssistant,
  deleteAssistant,
  editAssistant,
  fetchAssistants,
  restoreAssistant,
  setAssistantSidebarVisible,
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

export function AssistantsDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const { showToast } = useAppShell()
  const { activeKnowledgeBases } = useKnowledgeBases()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [assistants, setAssistants] = useState<AssistantPayload[]>([])
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<AssistantPayload | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<AssistantPayload | null>(null)
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
      JSON.stringify(previousConfig.knowledgeBaseIds) !==
        JSON.stringify(config.knowledgeBaseIds) ||
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
        setAssistants((previous) =>
          previous.map((a) => (a.id === updated.id ? updated : a)),
        )
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
      setAssistants((previous) =>
        previous.map((a) => (a.id === updated.id ? updated : a)),
      )
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
      setAssistants((previous) =>
        previous.map((a) => (a.id === updated.id ? updated : a)),
      )
      showToast(`「${assistant.name}」已恢复`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : "恢复失败")
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async (assistant: AssistantPayload) => {
    setBusy(true)
    try {
      await deleteAssistant(assistant.id)
      setAssistants((previous) => previous.filter((a) => a.id !== assistant.id))
      showToast(`「${assistant.name}」已删除`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : "删除失败")
    } finally {
      setBusy(false)
      setDeleting(null)
    }
  }

  /** Sidebar curation: optimistic flip so the checkbox feels immediate; the
      row rolls back if the server refuses (e.g. a stale default payload). */
  const handleToggleSidebar = async (
    assistant: AssistantPayload,
    next: boolean,
  ) => {
    setAssistants((previous) =>
      previous.map((a) =>
        a.id === assistant.id ? { ...a, sidebarVisible: next } : a,
      ),
    )
    try {
      const updated = await setAssistantSidebarVisible(assistant.id, next)
      setAssistants((previous) =>
        previous.map((a) => (a.id === updated.id ? updated : a)),
      )
      showToast(
        next
          ? `「${assistant.name}」已显示在侧边栏`
          : `「${assistant.name}」已从侧边栏隐藏`,
      )
    } catch (err) {
      setAssistants((previous) =>
        previous.map((a) =>
          a.id === assistant.id ? { ...a, sidebarVisible: !next } : a,
        ),
      )
      showToast(err instanceof Error ? err.message : "更新侧边栏显示失败")
    } finally {
      // The sidebar selector reads this store; a toggle must reach it live.
      void assistantStore.refresh()
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
  const isEmpty = !loading && !error && assistants.length === 0

  return (
    <Dialog
      open={open}
      onClose={onClose}
      onOpen={() => void load()}
      title="助手管理"
      titleId="assistants-title"
      icon={Bot}
      toolbar={
        editorOpen || isEmpty ? null : (
          <div className="flex justify-end">
            <Button
              size="sm"
              tone="primary"
              icon={Plus}
              onClick={startCreate}
              disabled={busy}
              title="新建助手"
            >
              新建助手
            </Button>
          </div>
        )
      }
    >
      {editorOpen ? (
        <div className="flex flex-col gap-3 rounded-[14px] border border-brand-line bg-brand-subtle/40 p-3">
          {/* Create mode adds no heading: the panel itself is the「新建助手」CTA's
              open state, so a second "新建助手" line only repeated it. */}
          {editing ? (
            <p className="text-[11px] font-medium text-ink">
              编辑「{editing.name}」（配置修改将生成新版本）
            </p>
          ) : null}
          <div className="grid gap-2 md:grid-cols-2">
            <Field label="名称">
              <TextInput
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
                placeholder="必填"
                maxLength={200}
              />
            </Field>
            <Field label="描述">
              <TextInput
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                placeholder="可选"
                maxLength={2000}
              />
            </Field>
          </div>
          <Field label="系统提示词">
            <TextArea
              value={form.systemPrompt}
              onChange={(event) =>
                setForm({ ...form, systemPrompt: event.target.value })
              }
              placeholder="可选，最多 8000 字符"
              rows={3}
            />
          </Field>
          {activeKnowledgeBases.length > 0 ||
          form.knowledgeBaseIds.length > 0 ? (
            <div>
              <p className="text-[11px] text-muted-foreground">
                绑定知识库（可多选，留空 = 无知识上下文）
              </p>
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
                    chips.push({
                      id,
                      name:
                        activeKnowledgeBases.find((b) => b.id === id)?.name ??
                        id,
                    })
                  }
                  for (const base of activeKnowledgeBases) {
                    if (!seen.has(base.id))
                      chips.push({ id: base.id, name: base.name })
                  }
                  return chips.map(({ id, name }) => {
                    // Toggle chips, not actions: `Button` has no pressed state and
                    // its fixed radius/height would break the pill. Brand here marks
                    // the active selection, which is what the token reserves it for.
                    const selected = form.knowledgeBaseIds.includes(id)
                    return (
                      <UiButton
                        variant="outline"
                        size="sm"
                        key={id}
                        type="button"
                        onClick={() => toggleKnowledgeBase(id)}
                        aria-pressed={selected}
                        className={
                          selected ? "border px-2 py-0.5" : "border px-2 py-0.5"
                        }
                      >
                        {name}
                      </UiButton>
                    )
                  })
                })()}
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
            <div className="w-40">
              <Field label="工具策略">
                <Select
                  value={form.toolPolicy}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      toolPolicy: event.target.value as FormState["toolPolicy"],
                    })
                  }
                >
                  <option value="read_only_retrieval">只读检索</option>
                  <option value="none">不使用工具</option>
                </Select>
              </Field>
            </div>
            <Checkbox
              checked={form.rerankBound}
              onChange={(next) => setForm({ ...form, rerankBound: next })}
              label="绑定重排序模型"
            />
            <Checkbox
              checked={form.memoryEnabled}
              onChange={(next) => setForm({ ...form, memoryEnabled: next })}
              label="启用会话记忆"
            />
          </div>
          <Field label="可见分组">
            <TextInput
              value={form.allowedGroups}
              onChange={(event) =>
                setForm({ ...form, allowedGroups: event.target.value })
              }
              placeholder="逗号分隔，留空 = 全员可见"
            />
          </Field>
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-brand-line/60 pt-2.5">
            {validation ? (
              <Alert
                variant="destructive"
                role="alert"
                className="min-w-0 flex-1"
              >
                <AlertDescription>{validation}</AlertDescription>
              </Alert>
            ) : null}
            <Button size="sm" onClick={closeEditor} title="取消">
              取消
            </Button>
            <Button
              size="sm"
              tone="primary"
              onClick={() => void handleSave()}
              disabled={busy}
              title="保存"
            >
              保存
            </Button>
          </div>
        </div>
      ) : null}

      {loading ? (
        <p className="px-1 py-6 text-center text-xs text-muted-foreground">
          正在加载助手…
        </p>
      ) : error ? (
        <Alert variant="destructive" role="alert" className="border p-3">
          <AlertDescription>
            <p className="text-xs text-danger">助手列表读取失败：{error}</p>
            <Button size="sm" className="mt-2" onClick={() => void load()}>
              重试
            </Button>
          </AlertDescription>
        </Alert>
      ) : isEmpty ? (
        <EmptyState
          icon={Bot}
          message="还没有助手，点击「新建助手」创建第一个。"
          action={
            <Button
              size="sm"
              tone="primary"
              icon={Plus}
              onClick={startCreate}
              disabled={busy}
              title="新建助手"
            >
              新建助手
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {assistants.map((assistant) => (
            <li
              key={assistant.id}
              className="flex items-center gap-3 rounded-[10px] border border-line px-3 py-2.5 transition-colors hover:border-muted-foreground/40 max-md:flex-wrap"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-xs font-medium text-ink">
                    {assistant.name}
                  </span>
                  <StatusBadge>v{assistant.currentVersion}</StatusBadge>
                  {assistant.status === "archived" ? (
                    <StatusBadge>已归档</StatusBadge>
                  ) : null}
                </div>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {assistant.description || "无描述"}
                  {assistant.config
                    ? ` · ${assistant.config.toolPolicy === "none" ? "无工具" : "只读检索"}${
                        assistant.config.rerankModelProfileId === "rerank"
                          ? " · 重排序"
                          : ""
                      }${assistant.config.memoryEnabled ? " · 记忆" : ""}`
                    : ""}
                </p>
              </div>
              <div className="flex flex-none items-center gap-1.5 max-md:w-full max-md:justify-end">
                <Checkbox
                  checked={assistant.sidebarVisible !== false}
                  disabled={isDefaultAssistantId(assistant.id)}
                  onChange={(next) => void handleToggleSidebar(assistant, next)}
                  label="侧边栏"
                  title={
                    isDefaultAssistantId(assistant.id)
                      ? "默认助手始终显示在侧边栏"
                      : "勾选后该助手显示在侧边栏的选择器中"
                  }
                />
                {assistant.status === "active" ? (
                  <Button
                    size="sm"
                    icon={Pencil}
                    onClick={() => startEdit(assistant)}
                    disabled={busy}
                    title="编辑（配置修改将生成新版本）"
                  >
                    编辑
                  </Button>
                ) : null}
                {assistant.status === "active" ? (
                  <Button
                    size="sm"
                    icon={Archive}
                    onClick={() => void handleArchive(assistant)}
                    disabled={busy}
                    title="归档后不可编辑，历史版本仍可引用"
                  >
                    归档
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    icon={ArchiveRestore}
                    onClick={() => void handleRestore(assistant)}
                    disabled={busy}
                    title="恢复为启用"
                  >
                    恢复
                  </Button>
                )}
                {isDefaultAssistantId(assistant.id) ? null : (
                  <Button
                    size="sm"
                    tone="danger"
                    icon={Trash2}
                    onClick={() => setDeleting(assistant)}
                    disabled={busy}
                    title="物理删除，不可恢复"
                  >
                    删除
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Physical delete replaces a window.confirm: the nested confirm-tier
          dialog gets the shared top-layer transitions, and busy guards close. */}
      <Dialog
        open={deleting !== null}
        onClose={() => {
          if (!busy) setDeleting(null)
        }}
        title={deleting ? `删除「${deleting.name}」` : "删除助手"}
        titleId="assistants-delete-title"
        icon={Trash2}
        tier="confirm"
      >
        <div className="flex flex-col gap-2 text-xs leading-relaxed text-muted-foreground">
          <p>将删除这个助手及其全部配置版本，此操作不可恢复。</p>
          <p className="rounded-[10px] border border-danger-line bg-danger-subtle px-3 py-2 text-danger">
            引用它的历史对话将无法继续使用该助手运行（评估报告中的历史快照不受影响）。
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button size="sm" disabled={busy} onClick={() => setDeleting(null)}>
            取消
          </Button>
          <Button
            size="sm"
            tone="danger"
            disabled={busy || deleting === null}
            onClick={() => deleting && void handleRemove(deleting)}
          >
            确认删除
          </Button>
        </div>
      </Dialog>
    </Dialog>
  )
}
