import { Alert } from "@/components/arc/alert/alert"
import { ExpandingButtonGroup } from "@/components/arc/expanding-button-group/expanding-button-group"
import {
  Archive,
  ArchiveRestore,
  BookOpen,
  Pencil,
  Plus,
  Trash2,
} from "../ui/icons"
import { useState } from "react"

import type {
  KnowledgeBaseFolderPayload,
  KnowledgeBasePayload,
} from "../../lib/api"
import { useAppShell } from "../../runtime/AppShellContext"
import { knowledgeStore, useKnowledgeBases } from "../../runtime/knowledgeStore"
import { Icon } from "../ui/Icon"
import { Dialog } from "../ui/Dialog"
import { InlineMessage, ListRow } from "../ui/containers"
import { Button, EmptyState, Select, TextInput } from "../ui/Controls"
import { KnowledgeCreateDialog } from "./KnowledgeCreateDialog"
import { KnowledgeFolderDialog } from "./KnowledgeFolderDialog"

/** The value a folder <select> uses for "not in any folder". */
const UNGROUPED = "__ungrouped__"

function KnowledgeRow({
  base,
  folders,
  busy,
  onRename,
  onArchive,
  onRestore,
  onMove,
  onDelete,
}: {
  base: KnowledgeBasePayload
  folders: readonly KnowledgeBaseFolderPayload[]
  busy: boolean
  onRename: (base: KnowledgeBasePayload) => void
  onArchive: (base: KnowledgeBasePayload) => Promise<boolean>
  onRestore: (base: KnowledgeBasePayload) => Promise<boolean>
  onMove: (base: KnowledgeBasePayload, folderId: string | null) => void
  onDelete: (base: KnowledgeBasePayload) => Promise<boolean>
}) {
  const isDefault = base.id.startsWith("kb-default-")
  const archived = base.status === "archived"

  return (
    <ListRow>
      {/* Only the name lives here; it is cut at five characters, not at a
          pixel width, so Chinese names keep exactly five glyphs. */}
      <span
        className="min-w-0 flex-1 truncate text-xs font-medium text-ink"
        title={base.name}
      >
        {base.name.length > 5 ? `${base.name.slice(0, 5)}…` : base.name}
      </span>
      {/* The width lives on the wrapper, not the Select: its own `flex-1` needs
          a sized parent to resolve against, and appending `flex-none` to it
          would collide with `flex-1` at equal specificity (cn is a plain join). */}
      <div className="ml-auto flex w-36 flex-none items-center max-md:w-full">
        <Select
          size="sm"
          aria-label={`「${base.name}」所属分类`}
          className="whitespace-nowrap"
          value={base.folderId ?? UNGROUPED}
          disabled={busy}
          onChange={(event) =>
            onMove(
              base,
              event.target.value === UNGROUPED ? null : event.target.value,
            )
          }
        >
          <option value={UNGROUPED}>未分类</option>
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-none flex-wrap items-center justify-end gap-2 max-md:w-full">
        <ExpandingButtonGroup
          label={`「${base.name}」操作`}
          size="md"
          defaultExpanded={archived ? "restore" : "rename"}
          items={
            archived
              ? [
                  {
                    id: "restore",
                    label: "恢复",
                    icon: <Icon icon={ArchiveRestore} />,
                    doneLabel: "已恢复",
                    onSelect: () => onRestore(base),
                  },
                  {
                    id: "delete",
                    label: "删除",
                    icon: <Icon icon={Trash2} />,
                    doneLabel: "已删除",
                    tone: "danger",
                    disabled: isDefault,
                    onSelect: () => onDelete(base),
                  },
                ]
              : [
                  {
                    id: "rename",
                    label: "重命名",
                    icon: <Icon icon={Pencil} />,
                    onSelect: () => onRename(base),
                  },
                  {
                    id: "archive",
                    label: "归档",
                    icon: <Icon icon={Archive} />,
                    doneLabel: "已归档",
                    disabled: isDefault,
                    onSelect: () => onArchive(base),
                  },
                  {
                    id: "delete",
                    label: "删除",
                    icon: <Icon icon={Trash2} />,
                    doneLabel: "已删除",
                    tone: "danger",
                    disabled: isDefault,
                    onSelect: () => onDelete(base),
                  },
                ]
          }
        />
      </div>
    </ListRow>
  )
}

/**
 * Read-only on purpose: folders group knowledge bases for SELECTION only, and
 * every mutation (add / rename / delete) lives in KnowledgeFolderDialog so the
 * manage surface stays about knowledge bases.
 */
function FolderSection({
  bases,
}: {
  bases: readonly KnowledgeBasePayload[]
}) {
  const { folders } = useKnowledgeBases()
  const memberCount = (folderId: string) =>
    bases.filter((base) => base.folderId === folderId).length

  if (folders.length === 0) return null

  return (
    <section aria-label="分类">
      <ul className="flex flex-col gap-1.5">
        {folders.map((folder) => (
          <li
            key={folder.id}
            className="flex items-center gap-3 rounded-[10px] border border-line px-3 py-2"
          >
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">
              {folder.name}
            </span>
            <span className="flex-none font-mono text-[10px] text-faint">
              {memberCount(folder.id)} 个
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function KnowledgeDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const { showToast } = useAppShell()
  const { status, knowledgeBases, folders, error } = useKnowledgeBases()
  const [busy, setBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [foldersOpen, setFoldersOpen] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [renaming, setRenaming] = useState<KnowledgeBasePayload | null>(null)
  const [renameValue, setRenameValue] = useState("")
  /** The backend keeps an archived base as an audit tombstone, so "deleted"
      bases are hidden here for the session instead of leaving a dead row. */
  const [deletedIds, setDeletedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )

  const runCommand = async (
    action: () => Promise<void>,
    successText: string,
  ): Promise<boolean> => {
    setBusy(true)
    try {
      await action()
      showToast(successText)
      return true
    } catch (error) {
      showToast(error instanceof Error ? error.message : "知识库操作失败")
      return false
    } finally {
      setBusy(false)
    }
  }

  const handleRename = async () => {
    if (!renaming || !renameValue.trim()) return
    const target = renaming
    await runCommand(async () => {
      await knowledgeStore.rename(target.id, renameValue.trim())
      setRenaming(null)
    }, "知识库已重命名")
  }

  /**
   * The backend keeps an audit tombstone instead of hard-deleting a base, so
   * "delete" retires every source (the actual data) and archives the base; the
   * row is then hidden here for the session, tombstone and all.
   */
  const handleDelete = async (
    target: KnowledgeBasePayload,
  ): Promise<boolean> => {
    setBusy(true)
    try {
      await knowledgeStore.wipeContents(
        target.id,
        "在知识库管理中删除知识库",
      )
      if (target.status !== "archived") {
        await knowledgeStore.archive(target.id)
      }
      setDeletedIds((previous) => new Set(previous).add(target.id))
      showToast(`「${target.name}」已删除`)
      return true
    } catch (error) {
      showToast(error instanceof Error ? error.message : "删除失败")
      return false
    } finally {
      setBusy(false)
    }
  }

  const loading =
    status === "loading" || (status === "idle" && knowledgeBases.length === 0)
  const visibleBases = knowledgeBases.filter(
    (base) => !deletedIds.has(base.id),
  )
  const activeBases = visibleBases.filter(
    (base) => base.status !== "archived",
  )
  const archivedBases = visibleBases.filter(
    (base) => base.status === "archived",
  )
  const isEmpty =
    !loading &&
    status !== "error" &&
    activeBases.length === 0 &&
    archivedBases.length === 0

  const renderRow = (base: KnowledgeBasePayload) => (
    <KnowledgeRow
      key={base.id}
      base={base}
      folders={folders}
      busy={busy}
      onRename={(target) => {
        setRenaming(target)
        setRenameValue(target.name)
      }}
      onArchive={(target) =>
        runCommand(
          () => knowledgeStore.archive(target.id),
          `「${target.name}」已归档，不再参与新检索`,
        )
      }
      onRestore={(target) =>
        runCommand(
          () => knowledgeStore.restore(target.id),
          `「${target.name}」已恢复`,
        )
      }
      onDelete={handleDelete}
      onMove={(target, folderId) =>
        void runCommand(
          () => knowledgeStore.moveKnowledgeBase(target.id, folderId),
          folderId
            ? `「${target.name}」已归入「${folders.find((folder) => folder.id === folderId)?.name ?? ""}」`
            : `「${target.name}」已移出分类`,
        )
      }
    />
  )

  return (
    <Dialog
      open={open}
      onClose={onClose}
      onOpen={() => knowledgeStore.ensureLoaded()}
      title="知识库管理"
      titleId="knowledge-title"
      bodyClassName="scrollbar-hidden"
    >
      {status === "ready" ? (
        <div className="mx-auto grid w-full max-w-[440px] grid-cols-2 gap-2">
          <Button
            size="sm"
            tone="primary"
            icon={Plus}
            onClick={() => setCreateOpen(true)}
            disabled={busy}
          >
            新建知识库
          </Button>
          <Button
            size="sm"
            icon={Plus}
            onClick={() => setFoldersOpen(true)}
            disabled={busy}
          >
            新建分类
          </Button>
        </div>
      ) : null}

      {status === "ready" ? <FolderSection bases={visibleBases} /> : null}

      {renaming ? (
        <div className="rounded-[14px] border border-brand-line bg-brand-subtle/40 p-3">
          <p className="text-[11px] text-faint">
            正在重命名「{renaming.name}」
          </p>
          <div className="mt-2 flex items-center gap-2">
            <TextInput
              autoFocus
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              maxLength={200}
            />
            <Button onClick={() => setRenaming(null)}>取消</Button>
            <Button
              tone="primary"
              onClick={() => void handleRename()}
              disabled={busy || !renameValue.trim()}
            >
              保存
            </Button>
          </div>
        </div>
      ) : null}

      {loading ? (
        <InlineMessage>正在加载知识库…</InlineMessage>
      ) : status === "error" ? (
        <Alert tone="danger" title="发生错误" className="border p-3">

            <p className="text-xs text-danger">知识库读取失败：{error}</p>
            <Button
              size="sm"
              className="mt-2"
              onClick={() => void knowledgeStore.refresh()}
            >
              重试
            </Button>

        </Alert>
      ) : isEmpty ? (
        <EmptyState
          icon={BookOpen}
          message="还没有知识库。创建第一个之后才能导入文档。"
        />
      ) : (
        <div className="flex flex-col gap-2">
          {activeBases.length === 0 ? (
            <p className="px-1 py-6 text-center text-xs text-faint">
              没有启用的知识库。
            </p>
          ) : (
            <ul className="flex flex-col gap-2">{activeBases.map(renderRow)}</ul>
          )}
          {archivedBases.length > 0 ? (
            <div className="flex flex-col gap-2">
              <Button
                size="sm"
                className="self-center"
                onClick={() => setShowArchived((current) => !current)}
                disabled={busy}
              >
                {showArchived
                  ? "隐藏已归档"
                  : `显示已归档（${archivedBases.length}）`}
              </Button>
              {showArchived ? (
                <ul className="flex flex-col gap-2">
                  {archivedBases.map(renderRow)}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      <KnowledgeCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
      <KnowledgeFolderDialog
        open={foldersOpen}
        onClose={() => setFoldersOpen(false)}
      />
    </Dialog>
  )
}
