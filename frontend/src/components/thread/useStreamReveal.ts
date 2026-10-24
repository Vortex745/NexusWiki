import { useEffect, useMemo, useRef, useState } from "react"

import { REVEAL_TOKEN_MS, revealTo, tokenBoundaries } from "@core/stream_reveal"

/**
 * Reveals answer text one streamed token at a time instead of painting every SSE
 * delta the moment it lands.
 *
 * `fromZero` is what makes the burst case work. The knowledge routes withhold
 * draft tokens until the Critic approves, so the entire reply and the terminal
 * `done` frame arrive together: by the time the text part mounts, the text is
 * already complete, and "already complete when I mounted" would otherwise be
 * indistinguishable from "this is history". The caller decides that from the
 * message, which mounts while the run is still open and empty.
 *
 * The loop is deliberately not gated on the run still being open — it has to
 * keep typing after the stream closes. Text that is already complete when the
 * component mounts without `fromZero` (history, reload, a re-rendered thread)
 * starts caught up and never replays.
 */
export function useStreamReveal(text: string, fromZero = false): string {
  const targetRef = useRef(text)
  const shownRef = useRef(fromZero ? 0 : text.length)
  const boundariesRef = useRef<number[]>([])
  /** Milliseconds banked toward the next token; the frame rate is not the clock. */
  const dueRef = useRef(0)
  const lastTickRef = useRef(0)
  const frameRef = useRef<number | null>(null)
  const [shown, setShown] = useState(() => (fromZero ? 0 : text.length))
  const boundaries = useMemo(() => tokenBoundaries(text), [text])
  targetRef.current = text
  boundariesRef.current = boundaries

  useEffect(() => {
    if (shownRef.current > text.length) {
      // Regenerate and edit truncate the message: drop the stale tail instead of
      // leaving the reveal ahead of the text it is supposed to be showing.
      shownRef.current = text.length
      setShown(text.length)
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      shownRef.current = text.length
      setShown(text.length)
      return
    }

    // One loop follows the latest target. Restarting this loop for every SSE
    // delta cancels the pending frame faster than it can paint, which makes a
    // fast stream appear only after the final chunk arrives.
    if (frameRef.current !== null || shownRef.current >= text.length) return
    lastTickRef.current = 0
    const tick = (now: number) => {
      frameRef.current = null
      const elapsed = lastTickRef.current ? now - lastTickRef.current : 0
      lastTickRef.current = now
      dueRef.current += elapsed
      const due = Math.floor(dueRef.current / REVEAL_TOKEN_MS)
      if (due <= 0) {
        frameRef.current = requestAnimationFrame(tick)
        return
      }
      dueRef.current -= due * REVEAL_TOKEN_MS
      const next = revealTo(shownRef.current, targetRef.current.length, due, boundariesRef.current)
      if (next > shownRef.current) {
        shownRef.current = next
        setShown(next)
      }
      if (shownRef.current < targetRef.current.length) {
        frameRef.current = requestAnimationFrame(tick)
      }
    }
    frameRef.current = requestAnimationFrame(tick)
  }, [text])

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [])

  return shown >= text.length ? text : text.slice(0, shown)
}
