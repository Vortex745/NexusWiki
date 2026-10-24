import { Button as UiButton } from "@/components/primitives/button"
import { Input } from "@/components/primitives/input"
import { SearchField } from "../arc/search-field/search-field"
import { Textarea } from "@/components/primitives/textarea"
import { PanelDialog } from "../ui/Dialog"
import { DialogTitle } from "../primitives/dialog"
import { Brain, Check, Pencil, Sparkles, Trash2, X } from "../ui/icons"
import { useState } from "react"

import { formatMemoryDate, useMemoryFilter } from "../../lib/memory"
import { useAppShell } from "../../runtime/AppShellContext"
import { useMemoryApi } from "../../runtime/MemoryContext"
import { Dialog } from "../ui/Dialog"
import { Button } from "../ui/Controls"
import { Icon } from "../ui/Icon"

export function MemoryDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const {
    memories,
    loaded,
    addMemory,
    editMemory,
    deleteMemory,
    clearMemories,
    suggestions,
    acceptSuggestion,
    dismissSuggestion,
  } = useMemoryApi()
  const { showToast } = useAppShell()
  const [query, setQuery] = useState("")
  const [addText, setAddText] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState("")
  const [busy, setBusy] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const filtered = useMemoryFilter(memories, query)

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault()
    const text = addText.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      await addMemory(text)
      setAddText("")
      showToast("已成功添加新记忆")
    } catch (error) {
      showToast(error instanceof Error ? error.message : "记忆添加失败")
    } finally {
      setBusy(false)
    }
  }

  const handleSaveEdit = async () => {
    if (!editingId || busy) return
    const text = editText.trim()
    if (!text) return
    setBusy(true)
    try {
      await editMemory(editingId, text)
      setEditingId(null)
      setEditText("")
      showToast("已更新记忆条目")
    } catch (error) {
      showToast(error instanceof Error ? error.message : "记忆更新失败")
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteMemory(id)
      showToast("已删除记忆条目")
    } catch (error) {
      showToast(error instanceof Error ? error.message : "记忆删除失败")
    }
  }

  const handleClear = async () => {
    try {
      await clearMemories()
      setQuery("")
      showToast("已清空全部记忆")
    } catch (error) {
      showToast(error instanceof Error ? error.message : "记忆清空失败")
    } finally {
      setBusy(false)
      setConfirmingClear(false)
    }
  }

  return (
    <PanelDialog
      open={open}
      onClose={onClose}
      titleId="memory-title"
      className="flex flex-col sm:max-w-[520px] h-[min(680px,calc(100dvh-64px))]"
    >
      <div className="flex h-12 items-center justify-between border-b border-line px-5 max-md:px-4">
        <div className="flex items-center gap-2">
          <Icon icon={Brain} className="size-4 text-muted-foreground" />
          <DialogTitle id="memory-title" className="">
            上下文记忆
          </DialogTitle>
        </div>
        <UiButton
          variant="ghost"
          size="icon-sm"
          type="button"
          onClick={onClose}
          aria-label="关闭记忆面板"
          title="关闭"
          className="grid size-7 flex-none place-items-center"
        >
          <Icon data-icon="inline-start" icon={X} />
        </UiButton>
      </div>

      {/* Search + quick add */}
      <div className="flex flex-col gap-2 border-b border-line bg-surface-subtle p-3">
        <SearchField
          aria-label="搜索已保存的偏好与事实"
          clearLabel="清空记忆搜索"
          value={query}
          onValueChange={setQuery}
          placeholder="搜索已保存的偏好与事实..."
        />
        <form onSubmit={handleAdd} className="flex gap-1.5">
          <Input
            type="text"
            value={addText}
            onChange={(event) => setAddText(event.target.value)}
            placeholder="添加新偏好（如：回答优先提供 TypeScript 代码）..."
            className="h-8 flex-1 border px-2.5"
          />
          <UiButton
            variant="default"
            size="sm"
            type="submit"
            disabled={busy}
            className="flex h-8 items-center gap-1 px-3 disabled:opacity-60"
          >
            添加
          </UiButton>
        </form>
      </div>

      {/* Suggestion review queue (ticket 33) — pending only, never a memory
          until the owner accepts it. */}
      {suggestions.length > 0 ? (
        <div className="border-b border-line bg-brand-subtle/40 p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-ink">
            <Icon icon={Sparkles} className="size-3.5 text-brand" />
            提取建议 {suggestions.length} 条待确认
          </div>
          <ul className="grid gap-1.5">
            {suggestions.map((suggestion) => (
              <li
                key={suggestion.id}
                className="flex items-start justify-between gap-2 rounded-lg border border-line bg-surface p-2"
              >
                <p className="min-w-0 flex-1 text-xs leading-relaxed text-ink">
                  {suggestion.text}
                </p>
                <div className="flex flex-none items-center gap-1">
                  <UiButton
                    variant="default"
                    size="sm"
                    type="button"
                    onClick={() => {
                      void acceptSuggestion(suggestion.id)
                        .then(() => showToast("已保存为长期记忆"))
                        .catch((error: unknown) =>
                          showToast(
                            error instanceof Error ? error.message : "采纳失败",
                          ),
                        )
                    }}
                    className="px-2 py-1"
                  >
                    记住
                  </UiButton>
                  <UiButton
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={() => {
                      void dismissSuggestion(suggestion.id)
                        .then(() => showToast("已忽略该建议"))
                        .catch((error: unknown) =>
                          showToast(
                            error instanceof Error ? error.message : "忽略失败",
                          ),
                        )
                    }}
                    className="px-2 py-1"
                  >
                    忽略
                  </UiButton>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* List */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mb-2 flex items-center justify-between text-[11px] text-muted-foreground/70">
          <span>
            {loaded
              ? `已记住 ${memories.length} 条上下文事实`
              : "正在从服务器读取记忆…"}
          </span>
        </div>
        {filtered.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground/70">
            {loaded ? "暂无匹配记忆" : "加载中…"}
          </div>
        ) : (
          <ul className="grid gap-2">
            {filtered.map((entry) => {
              const editing = editingId === entry.id
              return (
                <li
                  key={entry.id}
                  className="flex items-start justify-between gap-2.5 rounded-[14px] border border-line bg-surface-subtle p-2.5 transition-colors hover:border-muted-foreground/40 hover:bg-surface"
                >
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      <span
                        className="inline-flex items-center rounded border border-line bg-surface-subtle px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                        title={
                          entry.assistantId
                            ? `仅在该助手（${entry.assistantId}）的对话中生效`
                            : "对该账号的所有助手生效"
                        }
                      >
                        {entry.assistantId ? "助手限定" : "全局"}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground/60">
                        {formatMemoryDate(entry.createdAt)}
                      </span>
                    </div>
                    {editing ? (
                      <div className="flex flex-col gap-1.5">
                        <Textarea
                          value={editText}
                          onChange={(event) => setEditText(event.target.value)}
                          rows={3}
                          autoFocus
                          className="w-full border px-2 py-1.5 leading-relaxed"
                        />
                        <div className="flex gap-1.5">
                          <UiButton
                            variant="default"
                            size="sm"
                            type="button"
                            onClick={handleSaveEdit}
                            disabled={busy || !editText.trim()}
                            className="flex items-center gap-1 px-2 py-1 disabled:opacity-60"
                          >
                            <Icon data-icon="inline-start" icon={Check} />
                            保存
                          </UiButton>
                          <UiButton
                            variant="ghost"
                            size="sm"
                            type="button"
                            onClick={() => {
                              setEditingId(null)
                              setEditText("")
                            }}
                            className="px-2 py-1"
                          >
                            取消
                          </UiButton>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs leading-relaxed text-ink">
                        {entry.text}
                      </p>
                    )}
                  </div>
                  {!editing ? (
                    <div className="flex flex-none flex-col gap-1">
                      <UiButton
                        variant="ghost"
                        size="icon-sm"
                        type="button"
                        aria-label="编辑记忆"
                        title="编辑记忆"
                        onClick={() => {
                          setEditingId(entry.id)
                          setEditText(entry.text)
                        }}
                        className="grid size-6 place-items-center"
                      >
                        <Icon data-icon="inline-start" icon={Pencil} />
                      </UiButton>
                      <UiButton
                        variant="destructive"
                        size="icon-sm"
                        type="button"
                        aria-label="删除记忆"
                        title="删除记忆"
                        onClick={() => void handleDelete(entry.id)}
                        className="grid size-6 flex-none place-items-center"
                      >
                        <Icon data-icon="inline-start" icon={Trash2} />
                      </UiButton>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-line bg-surface px-5 py-2.5 text-xs max-md:px-4">
        <UiButton
          variant="destructive"
          size="sm"
          type="button"
          onClick={() => setConfirmingClear(true)}
          className=""
        >
          清空记忆
        </UiButton>
        <UiButton
          variant="ghost"
          size="sm"
          type="button"
          onClick={onClose}
          className="px-3 py-1"
        >
          完成
        </UiButton>
      </div>

      {/* Clear-all replaces the OS confirm() (unstylable, no transition): the
          nested confirm-tier dialog gets the shared top-layer transitions. */}
      <Dialog
        open={confirmingClear}
        onClose={() => {
          if (!busy) setConfirmingClear(false)
        }}
        title="清空全部记忆"
        titleId="memory-clear-title"
        icon={Trash2}
        tier="confirm"
      >
        <div className="flex flex-col gap-2 text-xs leading-relaxed text-muted-foreground">
          <p>确定要清空所有已保存的上下文记忆吗？</p>
          <p className="rounded-[10px] border border-danger-line bg-danger-subtle px-3 py-2 text-danger">
            此操作不可恢复。
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => setConfirmingClear(false)}
          >
            取消
          </Button>
          <Button
            size="sm"
            tone="danger"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void handleClear()
            }}
          >
            清空全部
          </Button>
        </div>
      </Dialog>
    </PanelDialog>
  )
}
