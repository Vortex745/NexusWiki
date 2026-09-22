import { BookOpen, FileText, X } from "lucide"
import { useEffect, useRef, useState } from "react"

import { Icon } from "../ui/Icon"
import {
  fetchDocumentChunk,
  fetchDocumentDetail,
  fetchDocumentPreview,
  type DocumentChunkPayload,
  type DocumentDetailPayload,
  type DocumentPreviewPayload,
} from "../../lib/api"

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

export function DocumentViewerDialog({
  open,
  target,
  onClose,
}: {
  open: boolean
  target: DocumentViewTarget | null
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [detail, setDetail] = useState<DocumentDetailPayload | null>(null)
  const [preview, setPreview] = useState<DocumentPreviewPayload | null>(null)
  const [chunk, setChunk] = useState<DocumentChunkPayload | null>(null)
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle")
  const [error, setError] = useState<string | null>(null)
  // The chunk request carries its own document id, so a reopen with a new
  // target never fires a stale cross-document fetch.
  const [chunkTarget, setChunkTarget] = useState<{ docId: string; chunkId: string } | null>(null)
  const [chunkError, setChunkError] = useState<string | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && target && !dialog.open) {
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open, target])

  useEffect(() => {
    if (!open || !target) return
    let discarded = false
    setStatus("loading")
    setError(null)
    setChunk(null)
    setChunkError(null)
    setChunkTarget(target.chunkId ? { docId: target.documentId, chunkId: target.chunkId } : null)
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
    if (!open || !chunkTarget || chunkTarget.docId !== target?.documentId) return
    let discarded = false
    setChunk(null)
    setChunkError(null)
    fetchDocumentChunk(chunkTarget.docId, chunkTarget.chunkId)
      .then((payload) => {
        if (!discarded) setChunk(payload)
      })
      .catch((err: unknown) => {
        if (!discarded) setChunkError(err instanceof Error ? err.message : String(err))
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
      ].filter(Boolean).join(" · ")
    : null

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      aria-labelledby="document-viewer-title"
      className="m-auto h-[min(680px,calc(100dvh-48px))] w-[min(760px,calc(100vw-32px))] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-dialog backdrop:bg-black/20 open:grid open:animate-dialog-enter max-md:m-0 max-md:h-dvh max-md:w-screen max-md:rounded-none max-md:border-0"
    >
      <div className="flex h-13 flex-none items-center justify-between border-b border-line px-5 max-md:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Icon icon={BookOpen} className="size-4 flex-none text-muted" />
          <h2 id="document-viewer-title" className="truncate text-sm font-semibold text-ink">
            {document ? document.title : "文档版本"}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭文档"
          title="关闭"
          className="grid size-7 flex-none cursor-pointer place-items-center rounded-md text-muted/70 transition-colors hover:bg-surface-subtle hover:text-ink"
        >
          <Icon icon={X} className="size-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 py-4 max-md:px-4">
        {status === "loading" || status === "idle" ? (
          <p className="px-1 py-6 text-center text-xs text-muted">正在加载文档…</p>
        ) : status === "error" ? (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/40">
            <p className="text-xs text-red-700 dark:text-red-300">{error}</p>
          </div>
        ) : document ? (
          <>
            {/* Version metadata */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded-full border border-line bg-surface-subtle px-1.5 py-0.5 font-mono text-[10px] text-muted">
                v{document.version}
              </span>
              {document.active ? (
                <span className="rounded-full border border-brand-line bg-brand-subtle px-1.5 py-0.5 font-mono text-[10px] text-brand">
                  活动版本
                </span>
              ) : (
                <span className="rounded-full border border-line bg-surface-subtle px-1.5 py-0.5 font-mono text-[10px] text-muted">
                  历史版本
                </span>
              )}
              {document.retired ? (
                <span className="rounded-full border border-line bg-surface-subtle px-1.5 py-0.5 font-mono text-[10px] text-muted">
                  已退役
                </span>
              ) : null}
              <span className="rounded-full border border-line bg-surface-subtle px-1.5 py-0.5 font-mono text-[10px] text-muted">
                {document.mimeType}
              </span>
              {location ? (
                <span className="rounded-full border border-brand-line bg-brand-subtle px-1.5 py-0.5 font-mono text-[10px] text-brand">
                  {location}
                </span>
              ) : null}
            </div>

            {/* Cited chunk + adjacent chunks */}
            {chunkTarget ? (
              <div className="rounded-lg border border-brand-line bg-brand-subtle/40 p-3">
                <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted">
                  <Icon icon={FileText} className="size-3.5" />
                  引用段落
                </p>
                {chunkError ? (
                  <p role="alert" className="text-xs text-red-700 dark:text-red-300">{chunkError}</p>
                ) : chunk ? (
                  <>
                    <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink">{chunk.chunk.content}</p>
                    {chunk.neighbors.length > 0 ? (
                      <div className="mt-2.5 flex flex-col gap-1">
                        <p className="text-[10px] font-medium uppercase tracking-wider text-muted/70">相邻段落</p>
                        {chunk.neighbors.map((neighbor) => (
                          <button
                            key={neighbor.chunkId}
                            type="button"
                            onClick={() => setChunkTarget({ docId: chunk.document.docId, chunkId: neighbor.chunkId })}
                            className="cursor-pointer rounded-md border border-line bg-surface px-2 py-1.5 text-left text-[11px] text-muted transition-colors hover:bg-surface-subtle hover:text-ink"
                          >
                            <span className="font-mono text-[10px]">#{neighbor.index ?? "?"}</span>
                            {" "}
                            {neighbor.excerpt}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <p className="text-xs text-muted">正在加载引用段落…</p>
                )}
              </div>
            ) : null}

            {/* Preview: success, or the capability report — never a blank success */}
            {preview?.available ? (
              <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg border border-line bg-surface-subtle/40 p-3 font-sans text-xs leading-relaxed text-ink">
                {preview.text}
              </pre>
            ) : (
              <p role="alert" className="rounded-lg border border-line bg-surface-subtle/40 p-3 text-xs text-muted">
                {preview?.reason ?? "该版本的文本内容不可用。"}
              </p>
            )}

            {/* Section map */}
            {detail && detail.sections.length > 0 ? (
              <div className="rounded-lg border border-line p-3">
                <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted/70">章节结构</p>
                <ul className="flex flex-col gap-1">
                  {detail.sections.map((section) => (
                    <li key={section.nodeId} className="flex items-center justify-between gap-2 text-xs text-muted">
                      <span className="min-w-0 truncate">
                        {section.sectionPath.length > 0 ? section.sectionPath.join(" / ") : section.title}
                      </span>
                      {section.pageStart !== null ? (
                        <span className="flex-none font-mono text-[10px]">
                          {section.pageEnd !== null && section.pageEnd !== section.pageStart
                            ? `${section.pageStart}-${section.pageEnd} 页`
                            : `${section.pageStart} 页`}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </dialog>
  )
}
