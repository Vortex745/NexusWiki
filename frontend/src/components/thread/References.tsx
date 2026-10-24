import { Card } from "../arc/card/card"
import { Badge } from "../primitives/badge"
import { Button as UiButton } from "@/components/primitives/button"
import {
  assetUrl,
  formatReferenceLocation,
  type Reference,
} from "@core/conversation"
import { useCallback, useEffect, useRef, useState, type RefObject } from "react"

import { useAppShell } from "../../runtime/AppShellContext"

const ASSET_API_BASE = "/api"

/** Height of the disclosure's grid transition, in ms. */
const REVEAL_MS = 300

/**
 * Owns the "jump to the source this citation points at" behaviour: opens the
 * disclosure, scrolls the matching row into view, and highlights it briefly.
 */
export function useReferenceHighlight() {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const highlightTimer = useRef<number | null>(null)
  const scrollTimer = useRef<number | null>(null)
  // Mirrors `open` so `focusReference` stays identity-stable: it is captured by
  // the `parts` memo in AssistantMessage, and a new identity there would
  // re-render the whole markdown tree on every toggle.
  const openRef = useRef(false)
  const [open, setOpen] = useState(false)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)

  const toggle = useCallback((next: boolean) => {
    openRef.current = next
    setOpen(next)
  }, [])

  const focusReference = useCallback(
    (referenceId: string) => {
      const wasOpen = openRef.current
      toggle(true)
      setHighlightedId(referenceId)

      if (scrollTimer.current !== null) window.clearTimeout(scrollTimer.current)
      // The list animates open through a growing `0fr` row. Scrolling during that
      // window resolves `block: "nearest"` against a half-height ancestor and
      // lands on the wrong row, so an opening list waits out the transition; an
      // already-open one scrolls on the next frame.
      scrollTimer.current = window.setTimeout(
        () => {
          rootRef.current
            ?.querySelector(
              `[data-reference-item="${CSS.escape(referenceId)}"]`,
            )
            ?.scrollIntoView({ block: "nearest", behavior: "smooth" })
        },
        wasOpen ? 16 : REVEAL_MS + 20,
      )

      if (highlightTimer.current !== null)
        window.clearTimeout(highlightTimer.current)
      highlightTimer.current = window.setTimeout(
        () => setHighlightedId(null),
        1600,
      )
    },
    [toggle],
  )

  useEffect(
    () => () => {
      if (highlightTimer.current !== null)
        window.clearTimeout(highlightTimer.current)
      if (scrollTimer.current !== null) window.clearTimeout(scrollTimer.current)
    },
    [],
  )

  return { rootRef, open, toggle, highlightedId, focusReference }
}

export interface ReferencesPanelProps {
  references: readonly Reference[]
  rootRef: RefObject<HTMLDivElement | null>
  open: boolean
  onToggle: (next: boolean) => void
  highlightedId: string | null
}

export function ReferencesPanel({
  references,
  rootRef,
  highlightedId,
}: ReferencesPanelProps) {
  const { openDocument } = useAppShell()
  if (!references.length) return null
  return (
    <div ref={rootRef} className="flex min-w-0 flex-col gap-3">
      {references.map((reference, index) => {
        const location = formatReferenceLocation(reference)
        const imageUrl = assetUrl(reference, ASSET_API_BASE)
        const temporary = reference.origin === "attachment"
        const faq = reference.origin === "faq"
        const webRef = reference.origin === "web"
        const openable =
          !temporary &&
          !faq &&
          !webRef &&
          typeof reference.documentId === "string"
        return (
          <Card
            key={reference.id}
            data-reference-item={reference.id}
            data-highlighted={highlightedId === reference.id}
            className="min-w-0 transition-shadow data-[highlighted=true]:ring-2 data-[highlighted=true]:ring-ring"
            title={
              temporary && reference.attachmentName
                ? reference.attachmentName
                : reference.title || reference.source || "未命名来源"
            }
            description={`来源 ${index + 1}${location ? ` · ${location}` : ""}`}
            action={
              <>
                {temporary ? (
                  <Badge
                    variant="secondary"
                    title="来自本次会话的临时附件，不属于知识库"
                  >
                    临时
                  </Badge>
                ) : null}
                {faq ? (
                  <Badge variant="secondary">
                    FAQ
                    {Number.isInteger(reference.faqVersion)
                      ? " v" + reference.faqVersion
                      : ""}
                  </Badge>
                ) : null}
                {webRef ? (
                  <a
                    className="text-sm underline underline-offset-4"
                    title={
                      "网页证据：" +
                      (reference.webUrl ?? "") +
                      (reference.webFetchedAt
                        ? "（抓取于 " + reference.webFetchedAt + "）"
                        : "")
                    }
                    href={reference.webUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    网页来源
                  </a>
                ) : null}
                {openable ? (
                  <UiButton
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (typeof reference.documentId === "string")
                        openDocument({
                          documentId: reference.documentId,
                          ...(typeof reference.chunkId === "string"
                            ? { chunkId: reference.chunkId }
                            : {}),
                        })
                    }}
                  >
                    查看来源
                  </UiButton>
                ) : null}
                {imageUrl ? (
                  <a
                    className="text-sm underline underline-offset-4"
                    href={imageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {reference.image?.captions?.[0] || "查看图片证据"}
                  </a>
                ) : null}
              </>
            }
          >
            {reference.excerpt ? (
              <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed">
                {reference.excerpt}
              </p>
            ) : null}
          </Card>
        )
      })}
    </div>
  )
}
