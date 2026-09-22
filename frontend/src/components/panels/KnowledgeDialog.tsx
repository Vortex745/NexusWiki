import { Archive, ArchiveRestore, BookOpen, Pencil, Plus, X } from "lucide"
import { useEffect, useRef, useState } from "react"

import { Icon } from "../ui/Icon"
import { useAppShell } from "../../runtime/AppShellContext"
import {
  knowledgeStore,
  useKnowledgeBases,
} from "../../runtime/knowledgeStore"
import type { KnowledgeBasePayload } from "../../lib/api"

/**
 * Ticket 08 (KB-04): the knowledge-base workspace. Administrators create,
 * rename, archive and restore knowledge bases here; the archive state of a
 * base is always visible (archived bases stop joining new retrieval but stay
 * inspectable). Loading, empty and error each have an explicit rendering, and
 * the layout adapts below 768px.
 */

function DialogButton({
  onClick,
  disabled,
  title,
  children,
  tone = "neutral",
}: {
  onClick: () => void
  disabled?: boolean
  title: string
  children: React.ReactNode
  tone?: "neutral" | "brand"
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

function KnowledgeRow({
  base,
  busy,
  onRename,
  onArchive,
  onRestore,
}: {
  base: KnowledgeBasePayload
  busy: boolean
  onRename: (base: KnowledgeBasePayload) => void
  onArchive: (base: KnowledgeBasePayload) => void
  onRestore: (base: KnowledgeBasePayload) => void
}) {
  const isDefault = base.id.startsWith("kb-default-")
  return (
    <li className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5 max-md:flex-wrap">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-medium text-ink">{base.name}</span>
          {base.status === "archived" ? (
            <span className="flex-none rounded-full border border-line bg-surface-subtle px-1.5 py-0.5 font-mono text-[10px] text-muted">
              已归档
            </span>
          ) : null}
          {isDefault ? (
            <span className="flex-none rounded-full border border-brand-line bg-brand-subtle px-1.5 py-0.5 font-mono text-[10px] text-brand">
              默认
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted/80">
          {base.description || "无描述"}
        </p>
      </div>
      <div className="flex flex-none items-center gap-1.5 max-md:w-full max-md:justify-end">
        {base.status === "active" ? (
          <DialogButton onClick={() => onRename(base)} disabled={busy} title="重命名">
            <Icon icon={Pencil} className="size-3.5" />
            重命名
          </DialogButton>
        ) : null}
        {base.status === "active" ? (
          <DialogButton
            onClick={() => onArchive(base)}
            disabled={busy || isDefault}
            title={isDefault ? "默认知识库不可归档" : "归档后不再参与新检索"}
          >
            <Icon icon={Archive} className="size-3.5" />
            归档
          </DialogButton>
        ) : (
          <DialogButton onClick={() => onRestore(base)} disabled={busy} title="恢复为启用">
            <Icon icon={ArchiveRestore} className="size-3.5" />
            恢复
          </DialogButton>
        )}
      </div>
    </li>
  )
}

export function KnowledgeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { showToast } = useAppShell()
  const { status, knowledgeBases, error } = useKnowledgeBases()
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [renaming, setRenaming] = useState<KnowledgeBasePayload | null>(null)
  const [renameValue, setRenameValue] = useState("")

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      knowledgeStore.ensureLoaded()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  const runCommand = async (action: () => Promise<void>, successText: string) => {
    setBusy(true)
    try {
      await action()
      showToast(successText)
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "知识库操作失败"
      showToast(message)
    } finally {
      setBusy(false)
    }
  }

  const handleCreate = async () => {
    if (!name.trim()) return
    await runCommand(async () => {
      await knowledgeStore.create(name.trim(), description.trim() || undefined)
      setName("")
      setDescription("")
      setCreating(false)
    }, "知识库已创建")
  }

  const handleRename = async () => {
    if (!renaming || !renameValue.trim()) return
    const target = renaming
    await runCommand(async () => {
      await knowledgeStore.rename(target.id, renameValue.trim())
      setRenaming(null)
    }, "知识库已重命名")
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      aria-labelledby="knowledge-title"
      className="m-auto h-[min(640px,calc(100dvh-48px))] w-[min(620px,calc(100vw-32px))] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-dialog backdrop:bg-black/20 open:grid open:animate-dialog-enter max-md:m-0 max-md:h-dvh max-md:w-screen max-md:rounded-none max-md:border-0"
    >
      <div className="flex h-13 flex-none items-center justify-between border-b border-line px-5 max-md:px-4">
        <div className="flex items-center gap-2">
          <Icon icon={BookOpen} className="size-4 text-muted" />
          <h2 id="knowledge-title" className="text-sm font-semibold text-ink">
            知识库管理
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭知识库管理"
          title="关闭"
          className="grid size-7 flex-none cursor-pointer place-items-center rounded-md text-muted/70 transition-colors hover:bg-surface-subtle hover:text-ink"
        >
          <Icon icon={X} className="size-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-col overflow-y-auto px-5 py-4 max-md:px-4">
        {/* Create */}
        {creating ? (
          <div className="mb-4 rounded-lg border border-line bg-surface-subtle/60 p-3">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="知识库名称（必填）"
              maxLength={200}
              className="h-8 w-full rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-brand"
            />
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="描述（可选）"
              maxLength={2000}
              className="mt-2 h-8 w-full rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-brand"
            />
            <div className="mt-2.5 flex justify-end gap-2">
              <DialogButton onClick={() => setCreating(false)} title="取消创建">
                取消
              </DialogButton>
              <DialogButton onClick={handleCreate} disabled={busy || !name.trim()} tone="brand" title="创建">
                创建
              </DialogButton>
            </div>
          </div>
        ) : (
          <div className="mb-4 flex justify-end">
            <DialogButton onClick={() => setCreating(true)} disabled={busy} tone="brand" title="新建知识库">
              <Icon icon={Plus} className="size-3.5" />
              新建知识库
            </DialogButton>
          </div>
        )}

        {/* Rename */}
        {renaming ? (
          <div className="mb-4 rounded-lg border border-brand-line bg-brand-subtle/40 p-3">
            <p className="text-[11px] text-muted">
              正在重命名「{renaming.name}」
            </p>
            <input
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              maxLength={200}
              className="mt-2 h-8 w-full rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-brand"
            />
            <div className="mt-2.5 flex justify-end gap-2">
              <DialogButton onClick={() => setRenaming(null)} title="取消重命名">
                取消
              </DialogButton>
              <DialogButton
                onClick={handleRename}
                disabled={busy || !renameValue.trim()}
                tone="brand"
                title="保存"
              >
                保存
              </DialogButton>
            </div>
          </div>
        ) : null}

        {/* Loading / error / empty / list */}
        {status === "loading" || (status === "idle" && knowledgeBases.length === 0) ? (
          <p className="px-1 py-6 text-center text-xs text-muted">正在加载知识库…</p>
        ) : status === "error" ? (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/40">
            <p className="text-xs text-red-700 dark:text-red-300">知识库读取失败：{error}</p>
            <button
              type="button"
              onClick={() => void knowledgeStore.refresh()}
              className="mt-2 cursor-pointer text-xs font-medium text-brand hover:underline"
            >
              重试
            </button>
          </div>
        ) : knowledgeBases.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted">
            还没有知识库，点击「新建知识库」创建第一个。
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {knowledgeBases.map((base) => (
              <KnowledgeRow
                key={base.id}
                base={base}
                busy={busy}
                onRename={(target) => {
                  setRenaming(target)
                  setRenameValue(target.name)
                }}
                onArchive={(target) =>
                  void runCommand(
                    () => knowledgeStore.archive(target.id),
                    `「${target.name}」已归档，不再参与新检索`,
                  )
                }
                onRestore={(target) =>
                  void runCommand(
                    () => knowledgeStore.restore(target.id),
                    `「${target.name}」已恢复`,
                  )
                }
              />
            ))}
          </ul>
        )}
      </div>
    </dialog>
  )
}
