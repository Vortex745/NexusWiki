import { Brain, Check, Pencil, Search, Sparkles, Trash2, X } from "lucide"
import { useEffect, useRef, useState } from "react"

import { formatMemoryDate, useMemoryFilter } from "../../lib/memory"
import { useAppShell } from "../../runtime/AppShellContext"
import { useMemoryApi } from "../../runtime/MemoryContext"
import { Icon } from "../ui/Icon"

export function MemoryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
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
  const filtered = useMemoryFilter(memories, query)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

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
    if (!window.confirm("确定要清空所有已保存的上下文记忆吗？此操作不可恢复。")) return
    try {
      await clearMemories()
      setQuery("")
      showToast("已清空全部记忆")
    } catch (error) {
      showToast(error instanceof Error ? error.message : "记忆清空失败")
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      aria-labelledby="memory-title"
      className="m-auto h-[min(560px,calc(100dvh-48px))] w-[min(480px,calc(100vw-32px))] grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-dialog backdrop:bg-black/20 open:grid open:animate-dialog-enter max-md:m-0 max-md:h-dvh max-md:w-screen max-md:rounded-none max-md:border-0"
    >
      <div className="flex h-12 items-center justify-between border-b border-line px-5 max-md:px-4">
        <div className="flex items-center gap-2">
          <Icon icon={Brain} className="size-4 text-muted" />
          <h2 id="memory-title" className="text-sm font-semibold text-ink">
            上下文记忆
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭记忆面板"
          title="关闭"
          className="grid size-7 flex-none cursor-pointer place-items-center rounded-md text-muted/70 transition-colors hover:bg-surface-subtle hover:text-ink"
        >
          <Icon icon={X} className="size-3.5" />
        </button>
      </div>

      {/* Search + quick add */}
      <div className="space-y-2 border-b border-line bg-surface-subtle/50 p-3">
        <div className="relative flex items-center">
          <div className="pointer-events-none absolute left-2.5 flex items-center text-muted/60">
            <Icon icon={Search} className="size-3.5" />
          </div>
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索已保存的偏好与事实..."
            className="h-8 w-full rounded-lg border border-line bg-surface pl-8 pr-2.5 text-xs text-ink outline-none focus:border-muted/50"
          />
        </div>
        <form onSubmit={handleAdd} className="flex gap-1.5">
          <input
            type="text"
            value={addText}
            onChange={(event) => setAddText(event.target.value)}
            placeholder="添加新偏好（如：回答优先提供 TypeScript 代码）..."
            className="h-8 flex-1 rounded-lg border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-muted/50"
          />
          <button
            type="submit"
            disabled={busy}
            className="flex h-8 cursor-pointer items-center gap-1 rounded-lg bg-neutral-900 px-3 text-xs font-medium text-white transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-neutral-200 dark:text-neutral-900 dark:hover:bg-white"
          >
            添加
          </button>
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
                <p className="min-w-0 flex-1 text-xs leading-relaxed text-ink">{suggestion.text}</p>
                <div className="flex flex-none items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      void acceptSuggestion(suggestion.id)
                        .then(() => showToast("已保存为长期记忆"))
                        .catch((error: unknown) =>
                          showToast(error instanceof Error ? error.message : "采纳失败")
                        )
                    }}
                    className="cursor-pointer rounded-md bg-neutral-900 px-2 py-1 text-[10px] font-medium text-white dark:bg-neutral-200 dark:text-neutral-900"
                  >
                    记住
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void dismissSuggestion(suggestion.id)
                        .then(() => showToast("已忽略该建议"))
                        .catch((error: unknown) =>
                          showToast(error instanceof Error ? error.message : "忽略失败")
                        )
                    }}
                    className="cursor-pointer rounded-md bg-surface-subtle px-2 py-1 text-[10px] font-medium text-muted"
                  >
                    忽略
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* List */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mb-2 flex items-center justify-between text-[11px] text-muted/70">
          <span>
            {loaded ? `已记住 ${memories.length} 条上下文事实` : "正在从服务器读取记忆…"}
          </span>
        </div>
        {filtered.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted/70">
            {loaded ? "暂无匹配记忆" : "加载中…"}
          </div>
        ) : (
          <ul className="grid gap-2">
            {filtered.map((entry) => {
              const editing = editingId === entry.id
              return (
                <li
                  key={entry.id}
                  className="flex items-start justify-between gap-2.5 rounded-lg border border-line bg-surface-subtle/40 p-2.5 transition-colors hover:border-muted/40 hover:bg-surface"
                >
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      <span
                        className="inline-flex items-center rounded border border-line bg-surface-subtle px-1.5 py-0.5 text-[10px] font-medium text-muted"
                        title={entry.assistantId
                          ? `仅在该助手（${entry.assistantId}）的对话中生效`
                          : "对该账号的所有助手生效"}
                      >
                        {entry.assistantId ? "助手限定" : "全局"}
                      </span>
                      <span className="font-mono text-[10px] text-muted/60">
                        {formatMemoryDate(entry.createdAt)}
                      </span>
                    </div>
                    {editing ? (
                      <div className="flex flex-col gap-1.5">
                        <textarea
                          value={editText}
                          onChange={(event) => setEditText(event.target.value)}
                          rows={3}
                          autoFocus
                          className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-xs leading-relaxed text-ink outline-none focus:border-muted/50"
                        />
                        <div className="flex gap-1.5">
                          <button
                            type="button"
                            onClick={handleSaveEdit}
                            disabled={busy || !editText.trim()}
                            className="flex cursor-pointer items-center gap-1 rounded-md bg-neutral-900 px-2 py-1 text-[10px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-60 dark:bg-neutral-200 dark:text-neutral-900"
                          >
                            <Icon icon={Check} className="size-3" />
                            保存
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(null)
                              setEditText("")
                            }}
                            className="cursor-pointer rounded-md bg-surface-subtle px-2 py-1 text-[10px] font-medium text-muted"
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs leading-relaxed text-ink">{entry.text}</p>
                    )}
                  </div>
                  {!editing ? (
                    <div className="flex flex-none flex-col gap-1">
                      <button
                        type="button"
                        aria-label="编辑记忆"
                        title="编辑记忆"
                        onClick={() => {
                          setEditingId(entry.id)
                          setEditText(entry.text)
                        }}
                        className="grid size-6 cursor-pointer place-items-center rounded text-muted/60 transition-colors hover:text-ink"
                      >
                        <Icon icon={Pencil} className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label="删除记忆"
                        title="删除记忆"
                        onClick={() => void handleDelete(entry.id)}
                        className="grid size-6 flex-none cursor-pointer place-items-center rounded text-muted/60 transition-colors hover:text-red-600"
                      >
                        <Icon icon={Trash2} className="size-3.5" />
                      </button>
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
        <button
          type="button"
          onClick={() => void handleClear()}
          className="cursor-pointer text-muted/70 transition-colors hover:text-red-600"
        >
          清空记忆
        </button>
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer rounded-lg bg-surface-subtle px-3 py-1 text-xs font-medium text-muted transition-colors hover:bg-surface-subtle/70"
        >
          完成
        </button>
      </div>
    </dialog>
  )
}
