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
 * `complete` ends the reveal with the run. A finished run never gets to type
 * after the fact: without this, a burst reply keeps typing hundreds of
 * milliseconds after the process steps have already settled, which reads as
 * the answer arriving late.
 */
export function useStreamReveal(
  text: string,
  fromZero = false,
  complete = false,
): string {
  const targetRef = useRef(text)
  const shownRef = useRef(fromZero && !complete ? 0 : text.length)
  const boundariesRef = useRef<number[]>([])
  /** Milliseconds banked toward the next token; the frame rate is not the clock. */
  const dueRef = useRef(0)
  const lastTickRef = useRef(0)
  const frameRef = useRef<number | null>(null)
  const [shown, setShown] = useState(() =>
    fromZero && !complete ? 0 : text.length,
  )
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
    if (
      complete ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
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
  }, [text, complete])

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [])

  // Completion is a render-time state change. Returning the target here makes
  // the final answer paint in the same commit as the terminal trace instead of
  // waiting for the effect below to schedule a second render after the steps
  // collapse.
  return complete || shown >= text.length ? text : text.slice(0, shown)
}
