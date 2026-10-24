import { useLayoutEffect, useRef, useState } from "react"

/**
 * One highlight rectangle that glides between list rows, instead of every row
 * toggling its own background. Spatial continuity is the point: the eye follows
 * a single shape to the next row rather than re-scanning the list for which
 * cell just lit up.
 *
 * The container has to be `relative` — `offsetTop` is measured against the
 * nearest positioned ancestor, so the rows' geometry is only meaningful to the
 * pill when the list itself is that ancestor.
 *
 * Purely additive: the rows keep their own selected and focus indicators, so a
 * reader who never sees the pill (reduced motion, contrast, a hidden sidebar)
 * loses no information.
 */
export function useSlidingHighlight(activeIndex: number | null): {
  registerRow: (index: number) => (element: HTMLElement | null) => void
  box: { top: number; height: number } | null
} {
  const rows = useRef<(HTMLElement | null)[]>([])
  const activeRef = useRef(activeIndex)
  const [box, setBox] = useState<{ top: number; height: number } | null>(null)
  activeRef.current = activeIndex

  // Ref callbacks are recreated on every render, so React detaches and re-attaches
  // them each time. Bailing out on an unchanged rectangle is what stops that from
  // turning into a render loop.
  const measure = (element: HTMLElement | null) => {
    if (!element) return
    const top = element.offsetTop
    const height = element.offsetHeight
    setBox((current) =>
      current && current.top === top && current.height === height ? current : { top, height },
    )
  }

  // A row list that loads after the highlight mounts keeps the same index in front
  // of a different element, so measure on registration as well as on change.
  const registerRow = (index: number) => (element: HTMLElement | null) => {
    rows.current[index] = element
    if (element && index === activeRef.current) measure(element)
  }

  useLayoutEffect(() => measure(rows.current[activeIndex ?? -1] ?? null), [activeIndex])

  return { registerRow, box }
}
