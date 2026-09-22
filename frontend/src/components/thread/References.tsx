import { assetUrl, formatReferenceLocation, type Reference } from "@core/conversation"
import { ChevronDown } from "lucide"
import { useCallback, useEffect, useRef, useState, type RefObject } from "react"

import { useAppShell } from "../../runtime/AppShellContext"
import { Icon } from "../ui/Icon"

const ASSET_API_BASE = "/api"

/**
 * Owns the "jump to the source this citation points at" behaviour: opens the
 * disclosure, scrolls the matching row into view, and highlights it briefly.
 */
export function useReferenceHighlight() {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const timeoutRef = useRef<number | null>(null)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)

  const focusReference = useCallback((referenceId: string) => {
    const details = detailsRef.current
    if (!details) return
    details.open = true
    setHighlightedId(referenceId)
    requestAnimationFrame(() => {
      details
        .querySelector(`[data-reference-item="${CSS.escape(referenceId)}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    })
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
    timeoutRef.current = window.setTimeout(() => setHighlightedId(null), 1600)
  }, [])

  useEffect(
    () => () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
    },
    [],
  )

  return { detailsRef, highlightedId, focusReference }
}

export interface ReferencesPanelProps {
  references: readonly Reference[]
  detailsRef: RefObject<HTMLDetailsElement | null>
  highlightedId: string | null
}

export function ReferencesPanel({ references, detailsRef, highlightedId }: ReferencesPanelProps) {
  const { openDocument } = useAppShell()
  if (references.length === 0) return null

  return (
    <details
      ref={detailsRef}
      className="mt-3 w-full rounded-xl border border-line bg-surface-subtle/60 p-2.5 text-muted"
    >
      <summary className="flex min-h-7 cursor-pointer list-none select-none items-center gap-1.5 text-xs font-medium text-muted transition-colors hover:text-ink">
        <Icon icon={ChevronDown} className="size-3.5 transition-transform" />
        参考来源 {references.length}
      </summary>
      <ol className="mt-1.5 list-none">
        {references.map((reference) => {
          const location = formatReferenceLocation(reference)
          const imageUrl = assetUrl(reference, ASSET_API_BASE)
          // Ticket 22 (ATT-01): a temporary attachment citation is NOT a
          // knowledge-base document — it is labelled as temporary and cannot
          // be opened as one.
          const temporary = reference.origin === "attachment"
          // Ticket 13 (DOC-02): a citation that carries its document version
          // opens the exact authorized version (and the cited chunk).
          const openable = !temporary && typeof reference.documentId === "string"
          return (
            <li
              key={reference.id}
              data-reference-item={reference.id}
              data-highlighted={highlightedId === reference.id}
              className="border-t border-line py-1.5 transition-colors duration-200 data-[highlighted=true]:bg-brand-subtle"
            >
              <button
                type="button"
                disabled={!openable}
                onClick={() => {
                  if (typeof reference.documentId === "string") {
                    openDocument({
                      documentId: reference.documentId,
                      ...(typeof reference.chunkId === "string" ? { chunkId: reference.chunkId } : {}),
                    })
                  }
                }}
                title={openable ? "打开引用的文档版本" : undefined}
                className={openable
                  ? "block w-full cursor-pointer rounded-md px-1 py-0.5 text-left transition-colors hover:bg-surface-subtle"
                  : "block w-full px-1 py-0.5 text-left"}
              >
                <div className="text-xs font-medium text-ink">
                  {[
                    temporary && reference.attachmentName
                      ? reference.attachmentName
                      : reference.title || reference.source || "未命名来源",
                    location,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  {temporary ? (
                    <span
                      className="ml-1.5 rounded bg-surface-subtle px-1 text-[10px] font-normal text-muted"
                      title="来自本次会话的临时附件，不属于知识库"
                    >
                      临时
                    </span>
                  ) : null}
                  {openable ? <span className="ml-1.5 text-[10px] font-normal text-brand">查看来源</span> : null}
                </div>
                {reference.excerpt ? (
                  <p className="mt-0.5 line-clamp-3 overflow-hidden text-xs leading-relaxed text-muted">
                    {reference.excerpt}
                  </p>
                ) : null}
              </button>
              {imageUrl ? (
                <a
                  className="mt-1 inline-block text-xs text-brand underline underline-offset-2 hover:text-brand-hover"
                  href={imageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {reference.image?.captions?.[0] || "查看图片证据"}
                </a>
              ) : null}
            </li>
          )
        })}
      </ol>
    </details>
  )
}
