import { useState } from "react"

import type { KnowledgeBaseFolderPayload } from "../../lib/api"
import { useAppShell } from "../../runtime/AppShellContext"
import { knowledgeStore, useKnowledgeBases } from "../../runtime/knowledgeStore"
import { Dialog } from "../ui/Dialog"
import { Button, TextInput } from "../ui/Controls"

/**
 * Folder management owns every folder mutation (add / rename / delete); the
 * manage dialog's category section is read-only. Deleting a folder only
 * releases its members — the confirmation says so.
 */
export function KnowledgeFolderDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const { showToast } = useAppShell()
  const { folders, knowledgeBases } = useKnowledgeBases()
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState("")
  const [renaming, setRenaming] = useState<KnowledgeBaseFolderPayload | null>(
    null,
  )
  const [renameValue, setRenameValue] = useState("")
  const [deleting, setDeleting] = useState<KnowledgeBaseFolderPayload | null>(
    null,
  )

  const memberCount = (folderId: string) =>
    knowledgeBases.filter((base) => base.folderId === folderId).length

  const run = async (action: () => Promise<void>, successText: string) => {
    setBusy(true)
    try {
      await action()
      showToast(successText)
    } catch (error) {
      showToast(error instanceof Error ? error.message : "分类操作失败")
    } finally {
      setBusy(false)
    }
  }

  const add = () => {
    if (!name.trim() || busy) return
    void run(async () => {
      await knowledgeStore.createFolder(name.trim())
      setName("")
    }, "分类已创建")
  }

  const saveRename = () => {
    if (!renaming || !renameValue.trim() || busy) return
    void run(async () => {
      await knowledgeStore.renameFolder(renaming.id, renameValue.trim())
      setRenaming(null)
    }, "分类已重命名")
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="分类管理"
      titleId="knowledge-folder-manager-title"
      tier="confirm"
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <TextInput
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") add()
            }}
            placeholder="分类名称（必填）"
            maxLength={200}
          />
          <Button
            tone="primary"
            className="flex-none"
            onClick={add}
            disabled={busy || !name.trim()}
          >
            添加
          </Button>
        </div>

        {folders.length === 0 ? null : (
          <ul className="flex flex-col gap-1.5">
            {folders.map((folder) => (
              <li
                key={folder.id}
                className="rounded-[10px] border border-line px-3 py-2"
              >
                {renaming?.id === folder.id ? (
                  <div className="flex items-center gap-2">
                    <TextInput
                      autoFocus
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setRenaming(null)
                        if (event.key === "Enter") saveRename()
                      }}
                      maxLength={200}
                    />
                    <Button
                      className="flex-none"
                      onClick={() => setRenaming(null)}
                      disabled={busy}
                    >
                      取消
                    </Button>
                    <Button
                      className="flex-none"
                      tone="primary"
                      onClick={saveRename}
                      disabled={busy || !renameValue.trim()}
                    >
                      保存
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">
                      {folder.name}
                    </span>
                    <span className="flex-none font-mono text-[10px] text-faint">
                      {memberCount(folder.id)} 个
                    </span>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setDeleting(null)
                        setRenaming(folder)
                        setRenameValue(folder.name)
                      }}
                    >
                      重命名
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setRenaming(null)
                        setDeleting(deleting?.id === folder.id ? null : folder)
                      }}
                    >
                      删除
                    </Button>
                  </div>
                )}

                {deleting?.id === folder.id ? (
                  <div className="mt-2 rounded-[10px] border border-danger-line bg-danger-subtle px-3 py-2">
                    <p className="text-[11px] leading-relaxed text-danger">
                      删除「{folder.name}」？里面的 {memberCount(folder.id)}{" "}
                      个知识库会变成未分类，不会被归档或删除。
                    </p>
                    <div className="mt-2 flex justify-end gap-2">
                      <Button size="sm" onClick={() => setDeleting(null)}>
                        取消
                      </Button>
                      <Button
                        size="sm"
                        tone="danger"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await knowledgeStore.deleteFolder(folder.id)
                            setDeleting(null)
                          }, "分类已删除，里面的知识库变成未分类")
                        }
                      >
                        删除分类
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  )
}
