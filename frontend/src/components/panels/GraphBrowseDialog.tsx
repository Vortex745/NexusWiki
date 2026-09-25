import { Network, X } from "lucide"
import { useEffect, useRef, useState } from "react"

import { Icon } from "../ui/Icon"
import {
  fetchGraphEntities,
  fetchGraphRelations,
  type GraphEntityPayload,
  type GraphProvenancePayload,
  type GraphRelationPayload,
} from "../../lib/api"
import { useAppShell } from "../../runtime/AppShellContext"

/**
 * Ticket 37 (GRAPH-01): browse the knowledge-scoped graph of ONE knowledge
 * base — bounded entity pages, bounded relation pages, and every relation
 * linked to an authorized document version (openDocument) or honestly
 * labelled 溯源不可用. Server-side limits do the bounding; the dialog only
 * pages through what the server returned.
 */

const PAGE_SIZE = 20

export function GraphBrowseDialog({
  open,
  knowledgeBase,
  onClose,
}: {
  open: boolean
  knowledgeBase: { id: string; name: string } | null
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { openDocument } = useAppShell()
  const [query, setQuery] = useState("")
  const [entities, setEntities] = useState<GraphEntityPayload[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState<"idle" | "entities" | "relations">("idle")
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<GraphEntityPayload | null>(null)
  const [relations, setRelations] = useState<GraphRelationPayload[]>([])
  const [relationsTruncated, setRelationsTruncated] = useState(false)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  // A different base (or a reopened dialog) resets the browse state.
  useEffect(() => {
    if (!open) return
    setQuery("")
    setEntities([])
    setTruncated(false)
    setSelected(null)
    setRelations([])
    setError(null)
  }, [open, knowledgeBase?.id])

  const loadEntities = (search: string, offset: number) => {
    if (!knowledgeBase) return
    setLoading("entities")
    setError(null)
    fetchGraphEntities(knowledgeBase.id, { limit: PAGE_SIZE, offset, ...(search ? { query: search } : {}) })
      .then((payload) => {
        setEntities((previous) =>
          offset === 0 ? payload.entities : [...previous, ...payload.entities]
        )
        setTruncated(payload.page.truncated)
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "图谱实体读取失败")
      )
      .finally(() => setLoading("idle"))
  }

  const loadRelations = (entity: GraphEntityPayload, offset: number) => {
    if (!knowledgeBase) return
    setLoading("relations")
    setError(null)
    fetchGraphRelations(knowledgeBase.id, entity.name, { limit: PAGE_SIZE, offset })
      .then((payload) => {
        setRelations((previous) =>
          offset === 0 ? payload.relations : [...previous, ...payload.relations]
        )
        setRelationsTruncated(payload.page.truncated)
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "图谱关系读取失败")
      )
      .finally(() => setLoading("idle"))
  }

  const openEntity = (entity: GraphEntityPayload) => {
    setSelected(entity)
    setRelations([])
    setRelationsTruncated(false)
    loadRelations(entity, 0)
  }

  const openProvenance = (item: GraphProvenancePayload) => {
    if (!item.available) return
    openDocument({
      documentId: item.documentId,
      ...(typeof item.chunkId === "string" ? { chunkId: item.chunkId } : {}),
    })
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      aria-labelledby="graph-browse-title"
      className="m-auto h-[min(680px,calc(100dvh-48px))] w-[min(760px,calc(100vw-32px))] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-dialog backdrop:bg-black/20 open:grid max-md:m-0 max-md:h-dvh max-md:w-screen max-md:rounded-none max-md:border-0"
    >
      <div className="flex h-13 flex-none items-center justify-between border-b border-line px-5 max-md:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Icon icon={Network} className="size-4 flex-none text-muted" />
          <h2 id="graph-browse-title" className="truncate text-sm font-semibold text-ink">
            图谱浏览{knowledgeBase ? ` · ${knowledgeBase.name}` : ""}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭图谱浏览"
          title="关闭"
          className="grid size-7 flex-none cursor-pointer place-items-center rounded-md text-muted/70 transition-colors hover:bg-surface-subtle hover:text-ink"
        >
          <Icon icon={X} className="size-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-col overflow-y-auto px-5 py-4 max-md:px-4">
        <form
          className="flex flex-none items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            setSelected(null)
            setRelations([])
            loadEntities(query.trim(), 0)
          }}
        >
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索实体名称或别名…（回车检索）"
            maxLength={200}
            aria-label="实体搜索"
            className="h-9 min-w-0 flex-1 rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-brand"
          />
          <button
            type="submit"
            disabled={loading !== "idle"}
            title="检索实体"
            className="inline-flex h-9 flex-none cursor-pointer items-center rounded-lg bg-brand px-3 text-xs font-medium text-white transition-[color,background-color,border-color,transform,translate,scale] duration-150 ease-out hover:bg-brand-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading === "entities" ? "检索中…" : "检索"}
          </button>
        </form>

        {error ? (
          <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        ) : null}

        {/* Entity list */}
        {entities.length === 0 && loading === "idle" && !error ? (
          <p className="mt-4 rounded-lg border border-line bg-surface-subtle/40 p-3 text-xs text-muted">
            {query ? "没有匹配的实体（空结果是正常结果，不是故障）。" : "输入关键词检索该知识库图谱中的实体。"}
          </p>
        ) : entities.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-1">
            {entities.map((entity) => (
              <li key={entity.name}>
                <button
                  type="button"
                  onClick={() => openEntity(entity)}
                  aria-pressed={selected?.name === entity.name}
                  className={
                    selected?.name === entity.name
                      ? "w-full cursor-pointer rounded-md border border-brand-line bg-brand-subtle px-2.5 py-1.5 text-left text-xs text-ink"
                      : "w-full cursor-pointer rounded-md border border-line bg-surface px-2.5 py-1.5 text-left text-xs text-ink transition-colors hover:bg-surface-subtle"
                  }
                >
                  <span className="font-medium">{entity.name}</span>
                  {entity.type ? (
                    <span className="ml-1.5 rounded bg-surface-subtle px-1 text-[10px] text-muted">{entity.type}</span>
                  ) : null}
                  <span className="ml-1.5 font-mono text-[10px] text-muted/70">{entity.relationCount} 条关系</span>
                </button>
              </li>
            ))}
            {truncated ? (
              <li>
                <button
                  type="button"
                  onClick={() => loadEntities(query.trim(), entities.length)}
                  disabled={loading !== "idle"}
                  className="w-full cursor-pointer rounded-md border border-line px-2.5 py-1.5 text-xs text-brand transition-colors hover:bg-surface-subtle disabled:opacity-50"
                >
                  加载更多实体（服务端已截断大邻居，分页返回）
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}

        {/* Relations of the selected entity */}
        {selected ? (
          <div className="mt-4">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted/70">
              「{selected.name}」的关系（仅显示本知识库范围内可授权的关系）
            </p>
            {loading === "relations" && relations.length === 0 ? (
              <p className="mt-2 text-xs text-muted/70">正在读取关系…</p>
            ) : relations.length === 0 ? (
              <p className="mt-2 rounded-lg border border-line bg-surface-subtle/40 p-3 text-xs text-muted">
                该实体在本知识库内没有可显示的关系（共享同名实体的其他库关系不会出现）。
              </p>
            ) : (
              <ol className="mt-2 flex flex-col gap-1.5">
                {relations.map((relation) => (
                  <li
                    key={`${relation.sourceName}\0${relation.relation}\0${relation.targetName}`}
                    className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-ink">{relation.sourceName}</span>
                      <span className="font-mono text-[10px] text-brand">—{relation.relation}→</span>
                      <span className="font-medium text-ink">{relation.targetName}</span>
                      <span className="font-mono text-[10px] text-muted/70" title="关系权重">
                        w={relation.weight.toFixed(2)}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {relation.provenance.map((item) =>
                        item.available ? (
                          <button
                            key={`${item.documentId}\0${item.chunkId}`}
                            type="button"
                            onClick={() => openProvenance(item)}
                            title={`打开来源文档：${item.title ?? item.documentId}${item.documentVersion ? ` v${item.documentVersion}` : ""}`}
                            className="cursor-pointer rounded bg-brand-subtle px-1.5 py-0.5 text-[10px] text-brand transition-colors hover:bg-brand-hover hover:text-white"
                          >
                            查看来源{item.title ? ` · ${item.title}` : ""}
                            {item.documentVersion ? ` v${item.documentVersion}` : ""}
                          </button>
                        ) : (
                          <span
                            key={`${item.documentId}\0${item.chunkId}`}
                            title="该溯源记录无法解析到当前授权范围内的文档版本"
                            className="rounded bg-surface-subtle px-1.5 py-0.5 text-[10px] text-muted/70"
                          >
                            溯源不可用
                          </span>
                        )
                      )}
                    </div>
                  </li>
                ))}
                {relationsTruncated ? (
                  <li>
                    <button
                      type="button"
                      onClick={() => loadRelations(selected, relations.length)}
                      disabled={loading !== "idle"}
                      className="w-full cursor-pointer rounded-md border border-line px-2.5 py-1.5 text-xs text-brand transition-colors hover:bg-surface-subtle disabled:opacity-50"
                    >
                      加载更多关系
                    </button>
                  </li>
                ) : null}
              </ol>
            )}
          </div>
        ) : null}
      </div>
    </dialog>
  )
}
