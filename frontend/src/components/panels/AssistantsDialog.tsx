import { Alert } from "@/components/arc/alert/alert"
import { Checkbox as ArcCheckbox } from "@/components/arc/checkbox/checkbox"
import {
  ExpandingButtonGroup,
  type ExpandingButtonGroupItem,
} from "@/components/arc/expanding-button-group/expanding-button-group"
import { Archive, ArchiveRestore, Bot, Pencil, Plus, Trash2 } from "../ui/icons"
import { useState } from "react"

import { useAppShell } from "../../runtime/AppShellContext"
import {
  assistantStore,
  isDefaultAssistantId,
} from "../../runtime/assistantStore"
import { ConfirmDialog, Dialog } from "../ui/Dialog"
import { DangerNote, InlineMessage, ListRow } from "../ui/containers"
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
  /** No editor control; an existing binding rides along unchanged on save. */
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

/** Row subtitle: the description when there is one, plus the config summary; both absent renders no line at all. */
function detailLine(assistant: AssistantPayload): string {
  const meta = assistant.config
    ? [
        assistant.config.toolPolicy === "none" ? "无工具" : "只读检索",
        assistant.config.rerankModelProfileId === "rerank" ? "重排序" : null,
        assistant.config.memoryEnabled ? "记忆" : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : ""
  return [(assistant.description ?? "").trim(), meta].filter(Boolean).join(" · ")
}

export function AssistantsDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const { showToast } = useAppShell()
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
      setError(err instanceof Error ? err.message : "专家列表读取失败")
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
      setValidation("专家名称必填")
      return
    }
    if (form.name.trim().length > 200) {
      setValidation("专家名称最多 200 字符")
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
        showToast("专家已保存")
      } else {
        const created = await createAssistant({
          name: form.name.trim(),
          description: form.description,
          allowedGroups,
          config,
        })
        setAssistants((previous) => [...previous, created])
        showToast("专家已创建")
      }
      closeEditor()
      void assistantStore.refresh()
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存失败")
    } finally {
      setBusy(false)
    }
  }

  const handleArchive = async (assistant: AssistantPayload): Promise<boolean> => {
    setBusy(true)
    try {
      const updated = await archiveAssistant(assistant.id)
      setAssistants((previous) =>
        previous.map((a) => (a.id === updated.id ? updated : a)),
      )
      showToast(`「${assistant.name}」已归档`)
      void assistantStore.refresh()
      return true
    } catch (err) {
      showToast(err instanceof Error ? err.message : "归档失败")
      return false
    } finally {
      setBusy(false)
    }
  }

  const handleRestore = async (assistant: AssistantPayload): Promise<boolean> => {
    setBusy(true)
    try {
      const updated = await restoreAssistant(assistant.id)
      setAssistants((previous) =>
        previous.map((a) => (a.id === updated.id ? updated : a)),
      )
      showToast(`「${assistant.name}」已恢复`)
      void assistantStore.refresh()
      return true
    } catch (err) {
      showToast(err instanceof Error ? err.message : "恢复失败")
      return false
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
      void assistantStore.refresh()
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

  const editorOpen = creating || editing !== null
  const isEmpty = !loading && !error && assistants.length === 0

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        onOpen={() => void load()}
        title="专家管理"
        titleId="assistants-title"
        dividers={false}
        bodyClassName="scrollbar-hidden"
        toolbar={
          isEmpty ? null : (
            <div className="flex justify-end">
              <Button
                size="lg"
                tone="primary"
                icon={Plus}
                onClick={startCreate}
                disabled={busy}
                title="新建专家"
                className="px-4"
              >
                新建专家
              </Button>
            </div>
          )
        }
      >
        {loading ? (
          <InlineMessage>正在加载专家…</InlineMessage>
        ) : error ? (
          <Alert tone="danger" title="发生错误" className="border p-3">

              <p className="text-xs text-danger">专家列表读取失败：{error}</p>
              <Button size="sm" className="mt-2" onClick={() => void load()}>
                重试
              </Button>

          </Alert>
        ) : isEmpty ? (
          <EmptyState
            icon={Bot}
            message="还没有专家，点击「新建专家」创建第一个。"
            action={
              <Button
                size="lg"
                tone="primary"
                icon={Plus}
                onClick={startCreate}
                disabled={busy}
                title="新建专家"
                className="px-4"
              >
                新建专家
              </Button>
            }
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {assistants.map((assistant) => {
              const displayName = isDefaultAssistantId(assistant.id)
                ? "默认专家"
                : assistant.name
              const detail = detailLine(assistant)
              const actions: ExpandingButtonGroupItem[] = []
              if (assistant.status === "active") {
                actions.push(
                  {
                    id: "edit",
                    label: "编辑",
                    icon: <Pencil />,
                    onSelect: () => startEdit(assistant),
                    disabled: busy,
                  },
                  {
                    id: "archive",
                    label: "归档",
                    doneLabel: "已归档",
                    icon: <Archive />,
                    onSelect: () => handleArchive(assistant),
                    disabled: busy,
                  },
                )
              } else {
                actions.push({
                  id: "restore",
                  label: "恢复",
                  doneLabel: "已恢复",
                  icon: <ArchiveRestore />,
                  onSelect: () => handleRestore(assistant),
                  disabled: busy,
                })
              }
              if (!isDefaultAssistantId(assistant.id)) {
                actions.push({
                  id: "delete",
                  label: "删除",
                  tone: "danger",
                  icon: <Trash2 />,
                  onSelect: () => setDeleting(assistant),
                  disabled: busy,
                })
              }
              return (
                <ListRow key={assistant.id}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-xs font-medium text-ink">
                        {displayName}
                      </span>
                      {assistant.status === "archived" ? (
                        <StatusBadge>已归档</StatusBadge>
                      ) : null}
                    </div>
                    {detail ? (
                      <p className="mt-0.5 truncate text-[11px] text-faint">
                        {detail}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-none items-center gap-2 max-md:w-full max-md:justify-end">
                    <ArcCheckbox
                      checked={assistant.sidebarVisible !== false}
                      disabled={isDefaultAssistantId(assistant.id)}
                      onCheckedChange={(next) =>
                        void handleToggleSidebar(assistant, next === true)
                      }
                      aria-label={`在侧边栏显示「${displayName}」`}
                      title={
                        isDefaultAssistantId(assistant.id)
                          ? "默认专家始终显示在侧边栏"
                          : "勾选后该专家显示在侧边栏的选择器中"
                      }
                    />
                    <ExpandingButtonGroup
                      label={`「${displayName}」操作`}
                      size="sm"
                      items={actions}
                    />
                  </div>
                </ListRow>
              )
            })}
          </ul>
        )}

        {/* Physical delete replaces a window.confirm: the nested confirm-tier
            dialog gets the shared top-layer transitions, and busy guards close. */}
        <ConfirmDialog
          open={deleting !== null}
          onClose={() => {
            if (!busy) setDeleting(null)
          }}
          title={deleting ? `删除「${deleting.name}」` : "删除专家"}
          titleId="assistants-delete-title"
          confirmLabel="确认删除"
          onConfirm={() => deleting && void handleRemove(deleting)}
          busy={busy}
          confirmDisabled={deleting === null}
        >
          <p>将删除这个专家及其全部配置版本，此操作不可恢复。</p>
          <DangerNote>
            引用它的历史对话将无法继续使用该专家运行（评估报告中的历史快照不受影响）。
          </DangerNote>
        </ConfirmDialog>
      </Dialog>

      <Dialog
        open={editorOpen}
        onClose={closeEditor}
        title={editing ? `编辑「${editing.name}」` : "新建专家"}
        titleId="assistant-editor-title"
        tier="form"
        bodyClassName="scrollbar-hidden"
        footer={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {validation ? (
              <Alert tone="danger" title="发生错误" className="min-w-0 flex-1">
                {validation}
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
        }
      >
        {editing ? (
          <p className="text-[11px] text-faint">配置修改将生成新版本。</p>
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
        <Field label="系统提示词" hint="定义这个专家的回答方式与性格。">
          <TextArea
            value={form.systemPrompt}
            onChange={(event) =>
              setForm({ ...form, systemPrompt: event.target.value })
            }
            placeholder="可选，最多 8000 字符"
            rows={3}
          />
        </Field>
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
      </Dialog>
    </>
  )
}
