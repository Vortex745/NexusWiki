import { Alert, AlertDescription } from "@/components/primitives/alert"
import {
  Archive,
  ArchiveRestore,
  BookOpen,
  Folder,
  Pencil,
  Plus,
  Trash2,
} from "../ui/icons"
import { useState } from "react"

import type {
  KnowledgeBaseContentWipeResult,
  KnowledgeBaseFolderPayload,
  KnowledgeBasePayload,
} from "../../lib/api"
import { fetchKnowledgeBaseDocuments } from "../../lib/api"
import { useAppShell } from "../../runtime/AppShellContext"
import { knowledgeStore, useKnowledgeBases } from "../../runtime/knowledgeStore"
import { Icon } from "../ui/Icon"
import { Dialog } from "../ui/Dialog"
import {
  Button,
  EmptyState,
  Select,
  StatusBadge,
  TextInput,
} from "../ui/Controls"

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
  onWipe,
}: {
  base: KnowledgeBasePayload
  folders: readonly KnowledgeBaseFolderPayload[]
  busy: boolean
  onRename: (base: KnowledgeBasePayload) => void
  onArchive: (base: KnowledgeBasePayload) => void
  onRestore: (base: KnowledgeBasePayload) => void
  onMove: (base: KnowledgeBasePayload, folderId: string | null) => void
  onWipe: (base: KnowledgeBasePayload) => void
}) {
  const isDefault = base.id.startsWith("kb-default-")
  const archived = base.status === "archived"
  return (
    <li className="flex items-center gap-3 rounded-[10px] border border-line px-3 py-2.5 transition-colors hover:border-muted-foreground/40 max-md:flex-wrap">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-medium text-ink">
            {base.name}
          </span>
          {archived ? <StatusBadge>已归档</StatusBadge> : null}
          {isDefault ? <StatusBadge>默认</StatusBadge> : null}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {base.description || "无描述"}
        </p>
      </div>
      {/* The width lives on the wrapper, not the Select: its own `flex-1` needs
          a sized parent to resolve against, and appending `flex-none` to it
          would collide with `flex-1` at equal specificity (cn is a plain join). */}
      <div className="flex w-40 flex-none items-center max-md:w-full">
        <Select
          aria-label={`「${base.name}」所属分类`}
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
      <div className="flex flex-none items-center gap-1.5 max-md:w-full max-md:justify-end">
        {!archived ? (
          <Button
            size="sm"
            onClick={() => onRename(base)}
            disabled={busy}
            title="重命名"
          >
            <Icon data-icon="inline-start" icon={Pencil} />
            重命名
          </Button>
        ) : null}
        {!archived ? (
          <Button
            size="sm"
            onClick={() => onWipe(base)}
            disabled={busy}
            title="退役这个知识库里的全部文档（不可恢复）"
          >
            <Icon data-icon="inline-start" icon={Trash2} />
            清空内容
          </Button>
        ) : null}
        {!archived ? (
          <Button
            size="sm"
            onClick={() => onArchive(base)}
            disabled={busy || isDefault}
            title={isDefault ? "默认知识库不可归档" : "归档后不再参与新检索"}
          >
            <Icon data-icon="inline-start" icon={Archive} />
            归档
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => onRestore(base)}
            disabled={busy}
            title="恢复为启用"
          >
            <Icon data-icon="inline-start" icon={ArchiveRestore} />
            恢复
          </Button>
        )}
      </div>
    </li>
  )
}

/**
 * The folder taxonomy. A folder groups knowledge bases for SELECTION only: no
 * folder id is ever sent as a retrieval scope, and deleting one releases its
 * members instead of touching them — which is why the delete confirmation says
 * so out loud.
 */
function FolderSection() {
  const { showToast } = useAppShell()
  const { folders, knowledgeBases } = useKnowledgeBases()
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
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

  const stopEditing = () => {
    setCreating(false)
    setName("")
    setRenaming(null)
    setRenameValue("")
  }

  return (
    <section className="mb-4" aria-labelledby="knowledge-folders-title">
      <div className="flex items-center justify-between gap-2">
        <h3
          id="knowledge-folders-title"
          className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"
        >
          <Icon icon={Folder} className="size-3.5" />
          分类
        </h3>
        {!creating ? (
          <Button
            size="sm"
            icon={Plus}
            onClick={() => setCreating(true)}
            disabled={busy}
          >
            新建分类
          </Button>
        ) : null}
      </div>

      {renaming ? (
        <div className="mt-2 rounded-[14px] border border-brand-line bg-brand-subtle/40 p-3">
          <p className="text-[11px] text-muted-foreground">
            正在重命名「{renaming.name}」
          </p>
          <div className="mt-2 flex gap-2">
            <TextInput
              autoFocus
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setRenaming(null)
                if (event.key === "Enter" && renameValue.trim()) {
                  void run(
                    () =>
                      knowledgeStore.renameFolder(
                        renaming.id,
                        renameValue.trim(),
                      ),
                    "分类已重命名",
                  )
                }
              }}
              maxLength={200}
            />
            <Button size="sm" onClick={() => setRenaming(null)}>
              取消
            </Button>
            <Button
              size="sm"
              tone="primary"
              disabled={busy || !renameValue.trim()}
              onClick={() =>
                void run(
                  () =>
                    knowledgeStore.renameFolder(
                      renaming.id,
                      renameValue.trim(),
                    ),
                  "分类已重命名",
                )
              }
            >
              保存
            </Button>
          </div>
        </div>
      ) : null}

      {deleting ? (
        <Alert variant="destructive" role="alert" className="mt-2 border p-3">
          <AlertDescription>
            <p className="text-xs text-danger">
              删除分类「{deleting.name}」？里面的 {memberCount(deleting.id)}{" "}
              个知识库会变成未分类， 不会被归档或删除。
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
                    await knowledgeStore.deleteFolder(deleting.id)
                    setDeleting(null)
                  }, "分类已删除，里面的知识库变成未分类")
                }
              >
                删除分类
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {creating ? (
        <div className="mt-2 flex gap-2">
          <TextInput
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") stopEditing()
              if (event.key === "Enter" && name.trim()) {
                void run(async () => {
                  await knowledgeStore.createFolder(name.trim())
                  stopEditing()
                }, "分类已创建")
              }
            }}
            placeholder="分类名称（必填）"
            maxLength={200}
          />
          <Button size="sm" onClick={stopEditing}>
            取消
          </Button>
          <Button
            size="sm"
            tone="primary"
            disabled={busy || !name.trim()}
            onClick={() =>
              void run(async () => {
                await knowledgeStore.createFolder(name.trim())
                stopEditing()
              }, "分类已创建")
            }
          >
            创建
          </Button>
        </div>
      ) : null}

      {folders.length === 0 ? (
        !creating ? (
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            还没有分类。建一个之后可以把下面的知识库归进去，侧栏里勾选分类会一次选中里面所有知识库。
          </p>
        ) : null
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {folders.map((folder) => (
            <li
              key={folder.id}
              className="flex items-center gap-3 rounded-[10px] border border-line px-3 py-2 transition-colors hover:border-muted-foreground/40"
            >
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">
                {folder.name}
              </span>
              <span className="flex-none font-mono text-[10px] text-muted-foreground">
                {memberCount(folder.id)} 个
              </span>
              <div className="flex flex-none items-center gap-1.5">
                <Button
                  size="sm"
                  disabled={busy}
                  title="重命名"
                  onClick={() => {
                    setRenaming(folder)
                    setRenameValue(folder.name)
                  }}
                >
                  <Icon data-icon="inline-start" icon={Pencil} />
                  重命名
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  title="删除分类（里面的知识库变成未分类）"
                  onClick={() => setDeleting(folder)}
                >
                  <Icon data-icon="inline-start" icon={Trash2} />
                  删除
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * The irreversible one, so it gets a real dialog rather than the inline banner a
 * folder delete uses: the user is about to destroy chunks, graph relations, page
 * index nodes and image assets across a whole knowledge base, and the copy says
 * exactly that — including what SURVIVES, because "deleted" that quietly keeps
 * the audit trail is a different promise from "deleted".
 */
function WipeContentsDialog({
  base,
  onClose,
  onWiped,
}: {
  base: KnowledgeBasePayload | null
  onClose: () => void
  onWiped: (result: KnowledgeBaseContentWipeResult) => void
}) {
  const { showToast } = useAppShell()
  const [docCount, setDocCount] = useState<number | null>(null)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)

  const name = base?.name ?? ""

  const wipe = async () => {
    if (!base || !reason.trim()) return
    setBusy(true)
    try {
      const result = await knowledgeStore.wipeContents(base.id, reason.trim())
      setReason("")
      setDocCount(null)
      onWiped(result)
    } catch (error) {
      showToast(error instanceof Error ? error.message : "清空失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={base !== null}
      onClose={() => {
        setReason("")
        onClose()
      }}
      onOpen={() => {
        if (!base) return
        setDocCount(null)
        void fetchKnowledgeBaseDocuments(
          base.id,
          { page: 1, status: "", tag: "", folder: "" },
          1,
        )
          .then((catalog) => setDocCount(catalog.total))
          .catch(() => setDocCount(null))
      }}
      title={`清空「${name}」的内容`}
      titleId="knowledge-wipe-title"
      icon={Trash2}
    >
      <div className="flex flex-col gap-2.5 text-xs leading-relaxed text-muted-foreground">
        <p>
          将退役这个知识库里的{docCount === null ? "全部" : `${docCount} 篇`}
          文档，并排队删除它们在 Elasticsearch
          的分块、知识图谱里的关系与实体引用、PageIndex
          节点，以及不再被任何分块引用的图片资产。
        </p>
        <p className="rounded-[10px] border border-danger-line bg-danger-subtle px-3 py-2 text-danger">
          这一步不可恢复：退役是终态，没有「撤销退役」。
        </p>
        <p>
          保留的是知识库本身、来源与文档的元数据行和退役墓碑——历史回答里的引用仍然可追溯。
          清理由后台队列异步执行，命令返回只代表「已排队」，不代表已经删完。
        </p>
      </div>

      <TextInput
        autoFocus
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="退役原因（必填，会写进墓碑记录）"
        maxLength={200}
      />

      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          onClick={() => {
            setReason("")
            onClose()
          }}
        >
          取消
        </Button>
        <Button
          size="sm"
          tone="danger"
          disabled={busy || !reason.trim()}
          onClick={() => void wipe()}
        >
          确认清空
        </Button>
      </div>
    </Dialog>
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
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [renaming, setRenaming] = useState<KnowledgeBasePayload | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [wiping, setWiping] = useState<KnowledgeBasePayload | null>(null)

  const runCommand = async (
    action: () => Promise<void>,
    successText: string,
  ) => {
    setBusy(true)
    try {
      await action()
      showToast(successText)
    } catch (error) {
      showToast(error instanceof Error ? error.message : "知识库操作失败")
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

  const loading =
    status === "loading" || (status === "idle" && knowledgeBases.length === 0)
  const isEmpty = !loading && status !== "error" && knowledgeBases.length === 0

  return (
    <Dialog
      open={open}
      onClose={onClose}
      onOpen={() => knowledgeStore.ensureLoaded()}
      title="知识库管理"
      titleId="knowledge-title"
      icon={BookOpen}
      toolbar={
        creating ? (
          <div className="flex flex-col gap-2">
            <div className="flex gap-2 max-md:flex-col">
              <TextInput
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="知识库名称（必填）"
                maxLength={200}
              />
              <TextInput
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="描述（可选）"
                maxLength={2000}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" onClick={() => setCreating(false)}>
                取消
              </Button>
              <Button
                size="sm"
                tone="primary"
                onClick={() => void handleCreate()}
                disabled={busy || !name.trim()}
              >
                创建
              </Button>
            </div>
          </div>
        ) : isEmpty ? null : (
          <div className="flex justify-end">
            <Button
              size="sm"
              tone="primary"
              icon={Plus}
              onClick={() => setCreating(true)}
              disabled={busy}
            >
              新建知识库
            </Button>
          </div>
        )
      }
    >
      {status === "ready" ? <FolderSection /> : null}

      <WipeContentsDialog
        base={wiping}
        onClose={() => setWiping(null)}
        onWiped={(result) => {
          setWiping(null)
          showToast(
            result.retired > 0
              ? `已退役 ${result.retired} 个来源，${result.cleanupTasksQueued} 项清理已排队`
              : "这个知识库已经没有可退役的内容了",
          )
        }}
      />

      {renaming ? (
        <div className="rounded-[14px] border border-brand-line bg-brand-subtle/40 p-3">
          <p className="text-[11px] text-muted-foreground">
            正在重命名「{renaming.name}」
          </p>
          <div className="mt-2 flex gap-2">
            <TextInput
              autoFocus
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              maxLength={200}
            />
            <Button size="sm" onClick={() => setRenaming(null)}>
              取消
            </Button>
            <Button
              size="sm"
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
        <p className="px-1 py-6 text-center text-xs text-muted-foreground">
          正在加载知识库…
        </p>
      ) : status === "error" ? (
        <Alert variant="destructive" role="alert" className="border p-3">
          <AlertDescription>
            <p className="text-xs text-danger">知识库读取失败：{error}</p>
            <Button
              size="sm"
              className="mt-2"
              onClick={() => void knowledgeStore.refresh()}
            >
              重试
            </Button>
          </AlertDescription>
        </Alert>
      ) : isEmpty ? (
        <EmptyState
          icon={BookOpen}
          message="还没有知识库。创建第一个之后才能导入文档。"
          action={
            <Button
              size="sm"
              tone="primary"
              icon={Plus}
              onClick={() => setCreating(true)}
              disabled={busy}
            >
              新建知识库
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {knowledgeBases.map((base) => (
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
              onWipe={(target) => setWiping(target)}
              onMove={(target, folderId) =>
                void runCommand(
                  () => knowledgeStore.moveKnowledgeBase(target.id, folderId),
                  folderId
                    ? `「${target.name}」已归入「${folders.find((folder) => folder.id === folderId)?.name ?? ""}」`
                    : `「${target.name}」已移出分类`,
                )
              }
            />
          ))}
        </ul>
      )}
    </Dialog>
  )
}
