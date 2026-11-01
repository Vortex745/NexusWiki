import { Button as UiButton } from "@/components/ui/Button"
import { SearchField } from "../arc/search-field/search-field"
import { Alert } from "@/components/arc/alert/alert"
import { PanelBody, PanelDialog } from "../ui/Dialog"
import { useEffect, useState } from "react"

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
  const { openDocument } = useAppShell()
  const [query, setQuery] = useState("")
  const [entities, setEntities] = useState<GraphEntityPayload[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState<"idle" | "entities" | "relations">(
    "idle",
  )
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<GraphEntityPayload | null>(null)
  const [relations, setRelations] = useState<GraphRelationPayload[]>([])
  const [relationsTruncated, setRelationsTruncated] = useState(false)

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
    fetchGraphEntities(knowledgeBase.id, {
      limit: PAGE_SIZE,
      offset,
      ...(search ? { query: search } : {}),
    })
      .then((payload) => {
        setEntities((previous) =>
          offset === 0 ? payload.entities : [...previous, ...payload.entities],
        )
        setTruncated(payload.page.truncated)
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "图谱实体读取失败"),
      )
      .finally(() => setLoading("idle"))
  }

  const loadRelations = (entity: GraphEntityPayload, offset: number) => {
    if (!knowledgeBase) return
    setLoading("relations")
    setError(null)
    fetchGraphRelations(knowledgeBase.id, entity.name, {
      limit: PAGE_SIZE,
      offset,
    })
      .then((payload) => {
        setRelations((previous) =>
          offset === 0
            ? payload.relations
            : [...previous, ...payload.relations],
        )
        setRelationsTruncated(payload.page.truncated)
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "图谱关系读取失败"),
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
    <PanelDialog
      open={open}
      onClose={onClose}
      titleId="graph-browse-title"
      title={`图谱浏览${knowledgeBase ? ` · ${knowledgeBase.name}` : ""}`}
      className="sm:max-w-3xl"
    >
      <PanelBody>
        <form
          className="flex flex-none items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            setSelected(null)
            setRelations([])
            loadEntities(query.trim(), 0)
          }}
        >
          <div className="min-w-0 flex-1">
            <SearchField
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="搜索实体名称或别名…（回车检索）"
              maxLength={200}
              aria-label="实体搜索"
              clearLabel="清空实体搜索"
            />
          </div>
          <UiButton
            variant="default"
            size="sm"
            type="submit"
            disabled={loading !== "idle"}
            title="检索实体"
            className="inline-flex h-9 flex-none items-center px-3 active:scale-[0.98] disabled:opacity-50"
          >
            {loading === "entities" ? "检索中…" : "检索"}
          </UiButton>
        </form>

        {error ? (
          <Alert tone="danger" title="发生错误" className="mt-3 border p-3">
            {error}
          </Alert>
        ) : null}

        {/* Entity list */}
        {entities.length === 0 && loading === "idle" && !error ? (
          <p className="mt-4 rounded-[14px] border border-line bg-surface-subtle p-3 text-xs text-faint">
            {query
              ? "没有匹配的实体（空结果是正常结果，不是故障）。"
              : "输入关键词检索该知识库图谱中的实体。"}
          </p>
        ) : entities.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-1">
            {entities.map((entity) => (
              <li key={entity.name}>
                <UiButton
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => openEntity(entity)}
                  aria-pressed={selected?.name === entity.name}
                  className={
                    selected?.name === entity.name
                      ? "w-full border px-2.5 py-1.5 text-left"
                      : "w-full border px-2.5 py-1.5 text-left"
                  }
                >
                  <span className="font-medium">{entity.name}</span>
                  {entity.type ? (
                    <span className="ml-1.5 rounded bg-surface-subtle px-1 text-[10px] text-faint">
                      {entity.type}
                    </span>
                  ) : null}
                  <span className="ml-1.5 font-mono text-[10px] text-faint/70">
                    {entity.relationCount} 条关系
                  </span>
                </UiButton>
              </li>
            ))}
            {truncated ? (
              <li>
                <UiButton
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => loadEntities(query.trim(), entities.length)}
                  disabled={loading !== "idle"}
                  className="w-full px-2.5 py-1.5 disabled:opacity-50"
                >
                  加载更多实体（服务端已截断大邻居，分页返回）
                </UiButton>
              </li>
            ) : null}
          </ul>
        ) : null}

        {/* Relations of the selected entity */}
        {selected ? (
          <div className="mt-4">
            <p className="text-[10px] font-medium text-faint">
              「{selected.name}」的关系（仅显示本知识库范围内可授权的关系）
            </p>
            {loading === "relations" && relations.length === 0 ? (
              <p className="mt-2 text-xs text-faint/70">
                正在读取关系…
              </p>
            ) : relations.length === 0 ? (
              <p className="mt-2 rounded-[14px] border border-line bg-surface-subtle p-3 text-xs text-faint">
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
                      <span className="font-medium text-ink">
                        {relation.sourceName}
                      </span>
                      <span className="font-mono text-[10px] text-brand">
                        —{relation.relation}→
                      </span>
                      <span className="font-medium text-ink">
                        {relation.targetName}
                      </span>
                      <span
                        className="font-mono text-[10px] text-faint/70"
                        title="关系权重"
                      >
                        w={relation.weight.toFixed(2)}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {relation.provenance.map((item) =>
                        item.available ? (
                          <UiButton
                            variant="default"
                            size="sm"
                            key={`${item.documentId}\0${item.chunkId}`}
                            type="button"
                            onClick={() => openProvenance(item)}
                            title={`打开来源文档：${item.title ?? item.documentId}${item.documentVersion ? ` v${item.documentVersion}` : ""}`}
                            className="px-1.5 py-0.5"
                          >
                            查看来源{item.title ? ` · ${item.title}` : ""}
                            {item.documentVersion
                              ? ` v${item.documentVersion}`
                              : ""}
                          </UiButton>
                        ) : (
                          <span
                            key={`${item.documentId}\0${item.chunkId}`}
                            title="该溯源记录无法解析到当前授权范围内的文档版本"
                            className="rounded bg-surface-subtle px-1.5 py-0.5 text-[10px] text-faint/70"
                          >
                            溯源不可用
                          </span>
                        ),
                      )}
                    </div>
                  </li>
                ))}
                {relationsTruncated ? (
                  <li>
                    <UiButton
                      variant="outline"
                      size="sm"
                      type="button"
                      onClick={() => loadRelations(selected, relations.length)}
                      disabled={loading !== "idle"}
                      className="w-full px-2.5 py-1.5 disabled:opacity-50"
                    >
                      加载更多关系
                    </UiButton>
                  </li>
                ) : null}
              </ol>
            )}
          </div>
        ) : null}
      </PanelBody>
    </PanelDialog>
  )
}
