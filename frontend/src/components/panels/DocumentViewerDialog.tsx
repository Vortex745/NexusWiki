import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../ui/collapsible"
import { Button as DisclosureButton } from "../ui/Button"
import { Button as UiButton } from "@/components/ui/Button"
import { Alert } from "@/components/arc/alert/alert"
import { SearchField } from "../arc/search-field/search-field"
import { PanelDialog } from "../ui/Dialog"
import { InlineMessage } from "../ui/containers"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../arc/tabs/tabs"
import { BookOpen, ChevronRight, FileText } from "../ui/icons"
import { useEffect, useMemo, useState, type ComponentPropsWithoutRef } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { Icon } from "../ui/Icon"
import {
  fetchDocumentChunk,
  fetchDocumentDetail,
  fetchDocumentPreview,
  type DocumentChunkPayload,
  type DocumentDetailPayload,
  type DocumentPreviewPayload,
  type DocumentSectionPayload,
} from "../../lib/api"

interface SectionNode {
  title: string
  path: string
  section?: DocumentSectionPayload
  children: SectionNode[]
}

function buildSectionTree(sections: DocumentSectionPayload[]): SectionNode[] {
  const roots: SectionNode[] = []
  for (const section of sections) {
    const path = section.sectionPath.length
      ? section.sectionPath
      : [section.title]
    let siblings = roots
    path.forEach((title, index) => {
      let node = siblings.find((entry) => entry.title === title)
      if (!node) {
        node = {
          title,
          path: JSON.stringify(path.slice(0, index + 1)),
          children: [],
        }
        siblings.push(node)
      }
      if (index === path.length - 1) node.section = section
      siblings = node.children
    })
  }
  const collator = new Intl.Collator("zh-CN", { numeric: true })
  const sort = (nodes: SectionNode[]) => {
    const allHavePages = nodes.every((node) => node.section?.pageStart != null)
    nodes.sort((left, right) => {
      const a = left.section?.pageStart
      const b = right.section?.pageStart
      return allHavePages && a != null && b != null && a !== b
        ? a - b
        : collator.compare(left.title, right.title)
    })
    nodes.forEach((node) => sort(node.children))
  }
  sort(roots)
  return roots
}

function SectionTree({
  nodes,
  expanded,
}: {
  nodes: SectionNode[]
  expanded: boolean
}) {
  return (
    <ul className="min-w-0">
      {nodes.map((node) => {
        const section = node.section
        const label = (
          <>
            <span className="min-w-0 flex-1 break-words">{node.title}</span>
            {section?.pageStart != null ? (
              <span className="flex-none pt-0.5 text-[11px] tabular-nums text-faint">
                {section.pageEnd != null &&
                section.pageEnd !== section.pageStart
                  ? `${section.pageStart}-${section.pageEnd} 页`
                  : `${section.pageStart} 页`}
              </span>
            ) : null}
          </>
        )
        return (
          <li key={node.path} className="min-w-0">
            {node.children.length ? (
              <Collapsible
                defaultOpen={expanded || undefined}
                className="[&[open]>summary>svg]:rotate-90"
              >
                <CollapsibleTrigger asChild>
                  <DisclosureButton
                    variant="ghost"
                    size="sm"
                    className="h-auto w-full justify-start whitespace-normal text-left"
                  >
                    <Icon
                      data-icon="inline-start"
                      icon={ChevronRight}
                      className="mt-1  flex-none"
                    />
                    {label}
                  </DisclosureButton>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="ml-4 border-l border-line pl-2">
                    <SectionTree nodes={node.children} expanded={expanded} />
                  </div>
                </CollapsibleContent>
              </Collapsible>
            ) : (
              <div className="flex items-start gap-3 px-2 py-2 pl-8 text-[13px] leading-6 text-faint">
                {label}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Ticket 13 (DOC-02): opens the EXACT authorized document version referenced
 * by a citation or a catalog row — with version/section/page metadata, the
 * text preview and (from a citation) the cited chunk plus its adjacent
 * chunks. Read-only over the server: retired or superseded versions stay
 * viewable, and an unavailable parser/OCR capability is reported instead of
 * rendering a successful blank preview.
 */

export interface DocumentViewTarget {
  documentId: string
  chunkId?: string
}

const MARKDOWN_COMPONENTS = {
  a: ({ href, children, ...rest }: ComponentPropsWithoutRef<"a">) => (
    <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
      {children}
    </a>
  ),
  img: ({ src, alt, ...rest }: ComponentPropsWithoutRef<"img">) => (
    <img
      src={src}
      alt={alt ?? ""}
      loading="lazy"
      className="my-3 max-w-full rounded-lg border border-line"
      {...rest}
    />
  ),
}

export function DocumentViewerDialog({
  open,
  target,
  onClose,
}: {
  open: boolean
  target: DocumentViewTarget | null
  onClose: () => void
}) {
  const [detail, setDetail] = useState<DocumentDetailPayload | null>(null)
  const [preview, setPreview] = useState<DocumentPreviewPayload | null>(null)
  const [chunk, setChunk] = useState<DocumentChunkPayload | null>(null)
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(
    "idle",
  )
  const [error, setError] = useState<string | null>(null)
  // The chunk request carries its own document id, so a reopen with a new
  // target never fires a stale cross-document fetch.
  const [chunkTarget, setChunkTarget] = useState<{
    docId: string
    chunkId: string
  } | null>(null)
  const [chunkError, setChunkError] = useState<string | null>(null)
  const [view, setView] = useState<"text" | "sections">("text")
  const [sectionQuery, setSectionQuery] = useState("")
  const query = sectionQuery.trim().toLocaleLowerCase()
  const sections = useMemo(
    () =>
      buildSectionTree(
        (detail?.sections ?? []).filter((section) =>
          [section.title, ...section.sectionPath]
            .join(" ")
            .toLocaleLowerCase()
            .includes(query),
        ),
      ),
    [detail, query],
  )

  useEffect(() => {
    if (!open || !target) return
    let discarded = false
    setStatus("loading")
    setDetail(null)
    setPreview(null)
    setView("text")
    setSectionQuery("")
    setError(null)
    setChunk(null)
    setChunkError(null)
    setChunkTarget(
      target.chunkId
        ? { docId: target.documentId, chunkId: target.chunkId }
        : null,
    )
    Promise.all([
      fetchDocumentDetail(target.documentId),
      fetchDocumentPreview(target.documentId).catch((err: unknown) => {
        // A failed preview must not hide the metadata — render it as the
        // "unavailable" report.
        return {
          available: false,
          reason: err instanceof Error ? err.message : String(err),
        } satisfies DocumentPreviewPayload
      }),
    ])
      .then(([detailPayload, previewPayload]) => {
        if (discarded) return
        setDetail(detailPayload)
        setPreview(previewPayload)
        setStatus("ready")
      })
      .catch((err: unknown) => {
        if (discarded) return
        setError(err instanceof Error ? err.message : String(err))
        setStatus("error")
      })
    return () => {
      discarded = true
    }
  }, [open, target])

  // The cited chunk loads separately so neighbors can be switched freely.
  useEffect(() => {
    if (!open || !chunkTarget || chunkTarget.docId !== target?.documentId)
      return
    let discarded = false
    setChunk(null)
    setChunkError(null)
    fetchDocumentChunk(chunkTarget.docId, chunkTarget.chunkId)
      .then((payload) => {
        if (!discarded) setChunk(payload)
      })
      .catch((err: unknown) => {
        if (!discarded)
          setChunkError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      discarded = true
    }
  }, [open, target, chunkTarget])

  const document = detail?.document
  const location = chunk
    ? [
        chunk.chunk.sectionPath && chunk.chunk.sectionPath.length > 0
          ? chunk.chunk.sectionPath.join(" / ")
          : null,
        chunk.chunk.page !== null ? `第 ${chunk.chunk.page} 页` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null

  return (
    <PanelDialog
      open={open && Boolean(target)}
      onClose={onClose}
      titleId="document-viewer-title"
      title={document ? document.title : "文档版本"}
      className="h-[min(760px,calc(100dvh-64px))] sm:max-w-3xl"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {status === "loading" || status === "idle" ? (
          <InlineMessage>正在加载文档…</InlineMessage>
        ) : status === "error" ? (
          <Alert tone="danger" title="发生错误" className="m-4 border p-3">

              <p className="text-xs text-danger">{error}</p>

          </Alert>
        ) : document ? (
          <Tabs
            value={view}
            onValueChange={(value) => setView(value as "text" | "sections")}
            panelMotion="morph"
            className="flex min-h-0 flex-1 flex-col gap-0"
          >
            <div className="flex flex-none items-center gap-3 border-b border-line px-6 py-2.5 max-md:px-4">
              <span
                title={document.mimeType}
                className="min-w-0 truncate text-xs text-faint"
              >
                {document.mimeType === "application/pdf"
                  ? "PDF"
                  : document.mimeType}
              </span>
              {document.retired ? (
                <span className="flex-none text-xs text-faint">已删除</span>
              ) : null}
              <div className="ml-auto flex-none">
                <TabsList aria-label="文档视图">
                  <TabsTrigger
                    value="text"
                    aria-label="文本预览"
                    title="文本预览"
                    className="min-w-9 px-2.5"
                  >
                    <Icon icon={FileText} className="size-4" />
                  </TabsTrigger>
                  <TabsTrigger
                    value="sections"
                    aria-label="目录"
                    title="目录"
                    className="min-w-9 px-2.5"
                  >
                    <Icon icon={BookOpen} className="size-4" />
                  </TabsTrigger>
                </TabsList>
              </div>
            </div>

            <TabsContent
              value="text"
              tabIndex={0}
              className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto overscroll-contain px-8 py-6 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand max-md:px-5 max-md:py-5"
            >
              <div className="mx-auto max-w-[68ch]">
                {chunkTarget ? (
                  <section
                    aria-label="引用段落"
                    className="mb-7 border-b border-line pb-6"
                  >
                    <h3 className="mb-3 flex items-center gap-2 text-xs font-medium text-brand">
                      <Icon icon={FileText} className="size-3.5" />
                      引用段落
                    </h3>
                    {location ? (
                      <p className="mb-3 break-words text-xs leading-6 text-faint">
                        {location}
                      </p>
                    ) : null}
                    {chunkError ? (
                      <Alert tone="danger" title="发生错误" className="">
                        {chunkError}
                      </Alert>
                    ) : chunk ? (
                      <>
                        <p className="whitespace-pre-wrap break-words border-l-2 border-brand-line pl-4 text-sm leading-7 text-ink">
                          {chunk.chunk.content}
                        </p>
                        {chunk.neighbors.length > 0 ? (
                          <div className="mt-2.5 flex flex-col gap-1">
                            <p className="text-[10px] font-medium text-faint">
                              相邻段落
                            </p>
                            {chunk.neighbors.map((neighbor) => (
                              <UiButton
                                variant="outline"
                                size="sm"
                                key={neighbor.chunkId}
                                type="button"
                                onClick={() =>
                                  setChunkTarget({
                                    docId: chunk.document.docId,
                                    chunkId: neighbor.chunkId,
                                  })
                                }
                                className="break-words px-3 py-2 text-left leading-6"
                              >
                                <span className="font-mono text-[10px]">
                                  #{neighbor.index ?? "?"}
                                </span>{" "}
                                {neighbor.excerpt}
                              </UiButton>
                            ))}
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <p className="text-xs text-faint">
                        正在加载引用段落…
                      </p>
                    )}
                  </section>
                ) : null}

                {preview?.available ? (
                  <div className="markdown-body break-words">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={MARKDOWN_COMPONENTS}
                    >
                      {preview.text ?? ""}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <Alert tone="danger" title="发生错误"
                    className="py-8 text-center leading-7"
                  >

                      {preview?.reason ?? "该版本的文本内容不可用。"}

                  </Alert>
                )}
              </div>
            </TabsContent>

            <TabsContent
              value="sections"
              className="flex min-h-0 flex-1 flex-col overflow-hidden"
            >
              <div className="flex-none px-6 py-4 max-md:px-4">
                <SearchField
                  value={sectionQuery}
                  onValueChange={setSectionQuery}
                  aria-label="搜索章节"
                  clearLabel="清空章节搜索"
                  placeholder="搜索章节"
                />
              </div>
              <div
                tabIndex={0}
                aria-label="章节目录"
                className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand max-md:px-3"
              >
                {sections.length ? (
                  <SectionTree
                    key={query}
                    nodes={sections}
                    expanded={Boolean(query)}
                  />
                ) : (
                  <p className="py-8 text-center text-sm text-faint">
                    {query ? "没有匹配的章节" : "暂无章节目录"}
                  </p>
                )}
              </div>
            </TabsContent>
          </Tabs>
        ) : null}
      </div>
    </PanelDialog>
  )
}
