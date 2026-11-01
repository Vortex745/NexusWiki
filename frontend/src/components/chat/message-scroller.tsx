"use client"

import * as React from "react"
import type { ReactNode } from "react"
import { cn } from "../../lib/cn"

import { Button } from "../ui/Button"
import { ArrowDown as ArrowDownIcon } from "../ui/icons"

// Local chat scroller (replaces the removed @shadcn/react message-scroller).
// Behavior contract the thread relies on:
//   - "following": pinned to the bottom end; content growth keeps the viewport
//     at the end.
//   - "anchored": a scroll-anchor message (the user's turn) is placed at the
//     top with the previous content peeking above it and stays at that offset
//     while the streamed answer grows below, until the user scrolls.
//   - "free": the user scrolled up; growth no longer moves the viewport.
//   - wheel / touch / arrow-key input always releases follow and anchor.
//   - the scroll-to-end button is active whenever the viewport sits away from
//     the bottom end.

type ScrollerState = { start: boolean; end: boolean; autoscrolling: boolean }

const SCROLL_EDGE_THRESHOLD = 8
const SCROLL_UP_PX = 0.5
const ANCHOR_PEEK_PX = 64
const AUTOSCROLLING_TIMEOUT_MS = 180
const USER_INTENT_KEYS = new Set(["ArrowDown", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "])

const INITIAL_SCROLLER_STATE: ScrollerState = { start: false, end: false, autoscrolling: false }

function createStore<T>(initial: T, isEqual: (a: T, b: T) => boolean) {
  let snapshot: T = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    hasListeners: () => listeners.size > 0,
    setSnapshot: (next: T) => {
      if (isEqual(snapshot, next)) return
      snapshot = next
      listeners.forEach((listener) => listener())
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

function isScrollerStateEqual(a: ScrollerState, b: ScrollerState) {
  return a.start === b.start && a.end === b.end && a.autoscrolling === b.autoscrolling
}

function isBooleanEqual(a: boolean, b: boolean) {
  return a === b
}

function contentChildren(content: Element | null, spacer: Element | null) {
  if (!content) return []
  return Array.from(content.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child !== spacer,
  )
}

function paddingBlockStart(element: Element | null) {
  if (!element) return 0
  const style = window.getComputedStyle(element)
  const parsed = Number.parseFloat(style.paddingBlockStart || style.paddingTop)
  return Number.isFinite(parsed) ? parsed : 0
}

type ScrollerApi = {
  setRootElement: (element: HTMLDivElement | null) => void
  setViewportElement: (element: HTMLDivElement | null) => void
  setContentElement: (element: HTMLDivElement | null) => void
  setSpacerElement: (element: HTMLDivElement | null) => void
  scrollToEnd: (options?: { behavior?: ScrollBehavior }) => boolean
  scrollToStart: (options?: { behavior?: ScrollBehavior }) => boolean
  userScrollIntent: () => void
  syncAfterScroll: () => void
  scrollerStore: ReturnType<typeof createStore<ScrollerState>>
  pendingStore: ReturnType<typeof createStore<boolean>>
}

const ScrollerContext = React.createContext<ScrollerApi | null>(null)
const ItemRegisterContext = React.createContext<((element: HTMLElement | null) => void) | null>(null)

function useScroller() {
  const api = React.useContext(ScrollerContext)
  if (!api) throw new Error("MessageScroller parts must be used within a MessageScrollerProvider.")
  return api
}

function useStore<T>(store: { subscribe: (listener: () => void) => () => void; getSnapshot: () => T }) {
  return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

export function useMessageScroller() {
  const { scrollToEnd, scrollToStart } = useScroller()
  return React.useMemo(() => ({ scrollToEnd, scrollToStart }), [scrollToEnd, scrollToStart])
}

export function useMessageScrollerScrollable() {
  const { scrollerStore } = useScroller()
  return useStore(scrollerStore)
}

export function MessageScrollerProvider({
  autoScroll = false,
  defaultScrollPosition = "end",
  children,
}: {
  autoScroll?: boolean
  defaultScrollPosition?: "start" | "end"
  children: ReactNode
}) {
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const viewportRef = React.useRef<HTMLDivElement | null>(null)
  const contentRef = React.useRef<HTMLDivElement | null>(null)
  const spacerRef = React.useRef<HTMLDivElement | null>(null)
  const itemsRef = React.useRef(new Set<HTMLElement>())
  const modeRef = React.useRef<"following" | "anchored" | "free">(autoScroll ? "following" : "free")
  const anchoredRef = React.useRef<{ element: HTMLElement; viewportTop: number } | null>(null)
  const seenAnchors = React.useRef(new WeakSet<HTMLElement>())
  const lastScrollTop = React.useRef(0)
  const autoscrollingTimeout = React.useRef<number | null>(null)
  const spacerGapRef = React.useRef(0)
  const autoScrollRef = React.useRef(autoScroll)
  autoScrollRef.current = autoScroll
  const defaultPositionRef = React.useRef(defaultScrollPosition)
  const defaultAppliedRef = React.useRef(false)

  const scrollerStore = React.useMemo(
    () => createStore<ScrollerState>(INITIAL_SCROLLER_STATE, isScrollerStateEqual),
    [],
  )
  const pendingStore = React.useMemo(() => createStore<boolean>(true, isBooleanEqual), [])

  const commitScrollState = React.useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const distanceEnd = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    const state: ScrollerState = {
      start: viewport.scrollTop > SCROLL_EDGE_THRESHOLD,
      end: distanceEnd > SCROLL_EDGE_THRESHOLD,
      autoscrolling: autoscrollingTimeout.current !== null,
    }
    scrollerStore.setSnapshot(state)
    for (const element of [rootRef.current, viewport]) {
      if (!element) continue
      const scrollable = [state.start && "start", state.end && "end"].filter(Boolean).join(" ")
      if (scrollable) element.setAttribute("data-scrollable", scrollable)
      else element.removeAttribute("data-scrollable")
    }
  }, [scrollerStore])

  const scheduleCommit = React.useCallback(() => {
    window.requestAnimationFrame(() => commitScrollState())
  }, [commitScrollState])

  const markAutoscrolling = React.useCallback(() => {
    if (autoscrollingTimeout.current !== null) window.clearTimeout(autoscrollingTimeout.current)
    autoscrollingTimeout.current = window.setTimeout(() => {
      autoscrollingTimeout.current = null
      commitScrollState()
    }, AUTOSCROLLING_TIMEOUT_MS)
    commitScrollState()
  }, [commitScrollState])

  const setSpacerHeight = React.useCallback((height: number) => {
    const spacer = spacerRef.current
    if (!spacer) return
    const next = Math.max(0, Math.ceil(height))
    spacer.hidden = next === 0
    spacer.style.height = `${next}px`
    // Cancel the content column's row gap so the padding lands flush.
    spacer.style.marginTop = next > 0 ? `${-spacerGapRef.current}px` : ""
  }, [])

  const scrollToOffset = React.useCallback(
    (top: number, behavior: ScrollBehavior = "auto") => {
      const viewport = viewportRef.current
      if (!viewport) return
      const clamped = Math.max(0, top)
      if (Math.abs(viewport.scrollTop - clamped) <= SCROLL_UP_PX) {
        viewport.scrollTop = clamped
        commitScrollState()
        return
      }
      markAutoscrolling()
      viewport.scrollTo({ top: clamped, behavior })
      scheduleCommit()
    },
    [commitScrollState, markAutoscrolling, scheduleCommit],
  )

  const scrollToEnd = React.useCallback(
    ({ behavior = "auto" }: { behavior?: ScrollBehavior } = {}) => {
      const viewport = viewportRef.current
      if (!viewport) return false
      setSpacerHeight(0)
      anchoredRef.current = null
      modeRef.current = autoScrollRef.current ? "following" : "free"
      scrollToOffset(viewport.scrollHeight - viewport.clientHeight, behavior)
      return true
    },
    [scrollToOffset, setSpacerHeight],
  )

  const scrollToStart = React.useCallback(
    ({ behavior = "auto" }: { behavior?: ScrollBehavior } = {}) => {
      const viewport = viewportRef.current
      if (!viewport) return false
      setSpacerHeight(0)
      anchoredRef.current = null
      modeRef.current = "free"
      scrollToOffset(0, behavior)
      return true
    },
    [scrollToOffset, setSpacerHeight],
  )

  /** Place an element near the top of the viewport, padding the bottom with the spacer when the remaining content is shorter than the viewport. */
  const anchorToElement = React.useCallback(
    (element: HTMLElement, peek: number) => {
      const viewport = viewportRef.current
      const content = contentRef.current
      if (!viewport || !content || !content.contains(element)) return
      const viewportBox = viewport.getBoundingClientRect()
      const elementTop =
        element.getBoundingClientRect().top - viewportBox.top + viewport.scrollTop
      const target = elementTop - paddingBlockStart(content) - peek
      const extent =
        viewport.scrollHeight - Number.parseInt(spacerRef.current?.style.height || "0", 10)
      setSpacerHeight(target + viewport.clientHeight - extent)
      modeRef.current = "anchored"
      anchoredRef.current = { element, viewportTop: paddingBlockStart(content) + peek }
      window.requestAnimationFrame(() => {
        scrollToOffset(target, "auto")
        scheduleCommit()
      })
    },
    [scheduleCommit, scrollToOffset, setSpacerHeight],
  )

  /** Keep the anchored message at its viewport offset while surrounding content changes. */
  const reanchor = React.useCallback(() => {
    const anchored = anchoredRef.current
    const viewport = viewportRef.current
    if (!anchored || !viewport || !anchored.element.isConnected) return
    const elementTop =
      anchored.element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    const delta = elementTop - anchored.viewportTop
    if (Math.abs(delta) <= SCROLL_UP_PX) return
    viewport.scrollTop += delta
    scheduleCommit()
  }, [scheduleCommit])

  const syncAfterScroll = React.useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const scrollTop = viewport.scrollTop
    const scrolledUp = scrollTop < lastScrollTop.current - SCROLL_UP_PX
    lastScrollTop.current = scrollTop
    const atEnd =
      viewport.scrollHeight - scrollTop - viewport.clientHeight <= SCROLL_EDGE_THRESHOLD
    if (modeRef.current === "anchored") {
      if (scrolledUp) {
        anchoredRef.current = null
        modeRef.current = "free"
      }
    } else if (atEnd) {
      // Scrolling back to the bottom re-engages the follow.
      modeRef.current = autoScrollRef.current ? "following" : modeRef.current
    } else if (modeRef.current === "following" && scrolledUp && autoscrollingTimeout.current === null) {
      modeRef.current = "free"
    }
    commitScrollState()
  }, [commitScrollState])

  const userScrollIntent = React.useCallback(() => {
    if (modeRef.current === "following" || modeRef.current === "anchored") {
      anchoredRef.current = null
      modeRef.current = "free"
      commitScrollState()
    }
  }, [commitScrollState])

  const applyDefaultPosition = React.useCallback(() => {
    if (defaultAppliedRef.current) return false
    const content = contentRef.current
    const viewport = viewportRef.current
    if (!content || !viewport) return false
    if (contentChildren(content, spacerRef.current).length === 0) return false
    defaultAppliedRef.current = true
    pendingStore.setSnapshot(false)
    if (defaultPositionRef.current === "end") scrollToEnd({ behavior: "auto" })
    else scrollToStart({ behavior: "auto" })
    return true
  }, [pendingStore, scrollToEnd, scrollToStart])

  const handleContentChange = React.useCallback(() => {
    const content = contentRef.current
    const viewport = viewportRef.current
    if (!content || !viewport) return
    if (applyDefaultPosition()) return

    // First not-yet-handled anchor in document order — the user's turn mounted.
    for (const child of contentChildren(content, spacerRef.current)) {
      if (child.dataset.scrollAnchor !== "true") continue
      if (seenAnchors.current.has(child)) continue
      seenAnchors.current.add(child)
      anchorToElement(child, ANCHOR_PEEK_PX)
      return
    }

    if (modeRef.current === "following" && autoScrollRef.current) {
      scrollToEnd({ behavior: "auto" })
    } else if (modeRef.current === "anchored" && anchoredRef.current) {
      reanchor()
    }
  }, [anchorToElement, applyDefaultPosition, reanchor, scrollToEnd])

  const handleViewportResize = React.useCallback(() => {
    if (modeRef.current === "following" && autoScrollRef.current) {
      scrollToEnd({ behavior: "auto" })
      return
    }
    if (modeRef.current === "anchored" && anchoredRef.current) {
      reanchor()
      return
    }
    scheduleCommit()
  }, [reanchor, scheduleCommit, scrollToEnd])

  const setRootElement = React.useCallback((element: HTMLDivElement | null) => {
    rootRef.current = element
  }, [])

  const setViewportElement = React.useCallback((element: HTMLDivElement | null) => {
    viewportRef.current = element
    lastScrollTop.current = element?.scrollTop ?? 0
  }, [])

  const setContentElement = React.useCallback((element: HTMLDivElement | null) => {
    contentRef.current = element
  }, [])

  const setSpacerElement = React.useCallback((element: HTMLDivElement | null) => {
    spacerRef.current = element
    if (element) {
      element.hidden = true
      element.setAttribute("aria-hidden", "true")
      element.dataset.messageScrollerSpacer = ""
      const parent = element.parentElement
      if (parent) {
        const style = window.getComputedStyle(parent)
        const gap = Number.parseFloat(style.rowGap === "normal" ? style.gap : style.rowGap)
        spacerGapRef.current = Number.isFinite(gap) ? gap : 0
      }
    }
  }, [])

  // Content children mutate on every streamed token; observe rather than rely
  // on render effects, because the items render through assistant-ui.
  React.useLayoutEffect(() => {
    const content = contentRef.current
    if (!content || typeof MutationObserver === "undefined") return
    handleContentChange()
    const observer = new MutationObserver(() => handleContentChange())
    observer.observe(content, { childList: true, subtree: false })
    return () => observer.disconnect()
  }, [handleContentChange])

  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || typeof ResizeObserver === "undefined") return
    let frame = 0
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(handleViewportResize)
    })
    observer.observe(viewport)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [handleViewportResize])

  React.useEffect(() => {
    return () => {
      if (autoscrollingTimeout.current !== null) {
        window.clearTimeout(autoscrollingTimeout.current)
        autoscrollingTimeout.current = null
      }
    }
  }, [])

  const registerItem = React.useCallback((element: HTMLElement | null) => {
    if (!element) return
    itemsRef.current.add(element)
    handleContentChange()
  }, [handleContentChange])

  const api = React.useMemo<ScrollerApi>(
    () => ({
      setRootElement,
      setViewportElement,
      setContentElement,
      setSpacerElement,
      scrollToEnd,
      scrollToStart,
      userScrollIntent,
      syncAfterScroll,
      scrollerStore,
      pendingStore,
    }),
    [
      pendingStore,
      scrollToEnd,
      scrollToStart,
      scrollerStore,
      setContentElement,
      setRootElement,
      setSpacerElement,
      setViewportElement,
      syncAfterScroll,
      userScrollIntent,
    ],
  )

  return (
    <ScrollerContext.Provider value={api}>
      <ItemRegisterContext.Provider value={registerItem}>{children}</ItemRegisterContext.Provider>
    </ScrollerContext.Provider>
  )
}

export function MessageScroller({ className, ...props }: React.ComponentProps<"div">) {
  const { setRootElement } = useScroller()
  const pending = usePendingDefault()
  return (
    <div
      ref={setRootElement}
      data-slot="message-scroller"
      data-pending-scroll={pending ? "" : undefined}
      className={cn(
        "group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden",
        className,
      )}
      {...props}
    />
  )
}

function usePendingDefault() {
  const { pendingStore } = useScroller()
  return useStore(pendingStore)
}

export function MessageScrollerViewport({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const api = useScroller()
  const pending = usePendingDefault()
  const ref = React.useCallback(
    (element: HTMLDivElement | null) => {
      api.setViewportElement(element)
    },
    [api],
  )
  return (
    <div
      ref={ref}
      data-slot="message-scroller-viewport"
      role="region"
      aria-label="Messages"
      tabIndex={0}
      data-pending-scroll={pending ? "" : undefined}
      onScroll={() => api.syncAfterScroll()}
      onKeyDown={(event) => {
        if (USER_INTENT_KEYS.has(event.key)) api.userScrollIntent()
      }}
      onWheel={() => api.userScrollIntent()}
      onTouchMove={() => api.userScrollIntent()}
      className={cn(
        "size-full min-h-0 min-w-0 scroll-fade-b scrollbar-thin scrollbar-gutter-stable overflow-y-auto overscroll-contain contain-content data-autoscrolling:scrollbar-thumb-transparent data-autoscrolling:scrollbar-track-transparent data-pending-scroll:invisible",
        className,
      )}
      {...props}
    />
  )
}

export function MessageScrollerContent({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const { setContentElement, setSpacerElement } = useScroller()
  return (
    <div
      ref={setContentElement}
      data-slot="message-scroller-content"
      role="log"
      aria-relevant="additions"
      className={cn("flex h-max min-h-full flex-col gap-6", className)}
      {...props}
    >
      {children}
      <div ref={setSpacerElement} />
    </div>
  )
}

export function MessageScrollerItem({
  messageId,
  scrollAnchor = false,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  messageId?: string
  scrollAnchor?: boolean
}) {
  const registerItem = React.useContext(ItemRegisterContext)
  const ref = React.useCallback(
    (element: HTMLDivElement | null) => {
      registerItem?.(element)
    },
    [registerItem],
  )
  return (
    <div
      ref={ref}
      data-slot="message-scroller-item"
      data-message-id={messageId}
      data-scroll-anchor={scrollAnchor ? "true" : "false"}
      className={cn(
        "min-w-0 shrink-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export function MessageScrollerButton({
  direction = "end",
  behavior = "smooth",
  variant = "secondary",
  size = "icon-sm",
  className,
  children,
  onClick,
  ...props
}: React.ComponentProps<typeof Button> & {
  direction?: "start" | "end"
  behavior?: ScrollBehavior
}) {
  const { scrollToEnd, scrollToStart, scrollerStore } = useScroller()
  const state = useStore(scrollerStore)
  const active = direction === "start" ? state.start : state.end
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      data-direction={direction}
      data-active={active ? "true" : "false"}
      tabIndex={active ? 0 : -1}
      className={cn(
        "absolute inset-s-1/2 -translate-x-1/2 border-line bg-canvas text-ink transition-[translate,scale,opacity] duration-200 hover:bg-surface-subtle hover:text-ink data-[active=false]:pointer-events-none data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=false]:duration-400 data-[active=false]:ease-[cubic-bezier(0.7,0,0.84,0)] data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[active=true]:ease-[cubic-bezier(0.23,1,0.32,1)] data-[direction=end]:bottom-4 data-[direction=end]:data-[active=false]:translate-y-full data-[direction=start]:top-4 data-[direction=start]:data-[active=false]:-translate-y-full rtl:translate-x-1/2 data-[direction=start]:[&_svg]:rotate-180",
        className,
      )}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        event.currentTarget.blur()
        if (direction === "start") scrollToStart({ behavior })
        else scrollToEnd({ behavior })
      }}
      {...props}
    >
      {children ?? (
        <>
          <ArrowDownIcon />
          <span className="sr-only">
            {direction === "end" ? "Scroll to end" : "Scroll to start"}
          </span>
        </>
      )}
    </Button>
  )
}
