import { Button as UiButton } from "@/components/primitives/button"
import { useMemo } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { ComponentPropsWithoutRef } from "react"

import type { Reference } from "@core/conversation"
import { isStreamWhitespace, streamTokens } from "@core/stream_reveal"

const CITATION_PATTERN = /\[cite:([^\]]+)\]/g

/* ---------------------------------------------------------------------------
   Streaming word wrap (transitions.dev t-stream).
   While the answer streams, every text word is wrapped in a .t-stream-w span.
   Spans mount as their words arrive and resolve through opacity + blur once;
   stable spans never remount, so already-read words never replay. Tags whose
   text must stay atomic (code, citation anchors) are skipped.
--------------------------------------------------------------------------- */

interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}
const STREAM_SKIP_TAGS = new Set(["code", "pre", "a", "script", "style"])

function wrapWords(value: string): HastNode[] {
  const out: HastNode[] = []
  // The reveal exposes whole tokens, so this must cut on exactly the same
  // tokenisation or a span boundary and a reveal step would disagree.
  for (const token of streamTokens(value)) {
    if (isStreamWhitespace(token)) {
      out.push({ type: "text", value: token })
    } else {
      out.push({
        type: "element",
        tagName: "span",
        properties: { className: ["t-stream-w"] },
        children: [{ type: "text", value: token }],
      })
    }
  }
  return out
}

function rehypeStreamWords() {
  return (tree: HastNode) => {
    const visit = (node: HastNode, skipped: boolean) => {
      if (!node.children) return
      const skip = skipped || STREAM_SKIP_TAGS.has(node.tagName ?? "")
      const next: HastNode[] = []
      for (const child of node.children) {
        if (child.type === "text" && !skip && child.value?.trim()) {
          next.push(...wrapWords(child.value))
        } else {
          visit(child, skip)
          next.push(child)
        }
      }
      node.children = next
    }
    visit(tree, false)
    withCaret(tree)
    return tree
  }
}

const CARET: HastNode = {
  type: "element",
  tagName: "span",
  properties: { className: ["t-caret"], "aria-hidden": true },
  children: [],
}

/** Block containers the caret is allowed to land inside. Restricting it to
 *  these is what keeps it out of `<code>`, `<pre>` and a trailing citation
 *  chip, which "deepest last element" would happily walk into. */
const CARET_HOST_TAGS = new Set([
  "root",
  "p",
  "li",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
])

/**
 * The caret has to sit at the end of the last line of text, so it must be an
 * inline child of the final block — a sibling placed after the markdown would
 * drop onto its own line. When the tree is empty (running, no token yet) a
 * paragraph is created so the "answer is on its way" signal still shows.
 */
function appendCaret(node: HastNode): HastNode | null {
  const children = node.children
  const isHost =
    (node.type === "root" || CARET_HOST_TAGS.has(node.tagName ?? "")) &&
    !!children
  let best: HastNode | null =
    isHost && children && children.length > 0 ? node : null
  for (const child of children ?? []) {
    const deeper = appendCaret(child)
    if (deeper) best = deeper
  }
  return best
}

function withCaret(tree: HastNode) {
  const host = appendCaret(tree)
  if (host) host.children = [...(host.children ?? []), CARET]
  else
    tree.children = [
      { type: "element", tagName: "p", properties: {}, children: [CARET] },
    ]
}

interface MarkdownTextProps {
  text: string
  references: readonly Reference[]
  onCitationClick?: (referenceId: string) => void
  /** While true, words resolve in through opacity+blur as they arrive. */
  streaming?: boolean
}

/**
 * Renders assistant markdown. `[cite:id]` markers are rewritten to links
 * pointing at `#ref:<id>` so the shared react-markdown tree handles them;
 * the anchor renderer turns those back into citation chips. Unknown ids keep
 * their raw marker rather than silently dropping text.
 */
export function MarkdownText({
  text,
  references,
  onCitationClick,
  streaming,
}: MarkdownTextProps) {
  const source = useMemo(() => {
    if (!references.length) return text
    const indexById = new Map(
      references.map((reference, index) => [reference.id, index]),
    )
    return text.replace(CITATION_PATTERN, (whole, id: string) => {
      const index = indexById.get(id)
      return index === undefined
        ? whole
        : `[${index + 1}](#ref:${encodeURIComponent(id)})`
    })
  }, [text, references])

  const components = useMemo(
    () => ({
      a: ({ href, children, ...rest }: ComponentPropsWithoutRef<"a">) => {
        if (href?.startsWith("#ref:") && onCitationClick) {
          const referenceId = decodeURIComponent(href.slice("#ref:".length))
          return (
            <UiButton
              variant="outline"
              size="sm"
              type="button"
              className="mx-0.5 inline-flex h-4 -translate-y-px items-center px-1 align-middle tabular-nums animate-pop-in"
              onClick={() => onCitationClick(referenceId)}
              title="查看参考来源"
            >
              {children}
            </UiButton>
          )
        }
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
            {children}
          </a>
        )
      },
    }),
    [onCitationClick],
  )

  return (
    <div
      className="markdown-body"
      data-stream-revealing={streaming ? "true" : undefined}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={streaming ? [rehypeStreamWords] : []}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
}
