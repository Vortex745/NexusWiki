import { useEffect, useRef, useState } from "react"

import { revealStep } from "@core/stream_reveal"

/**
 * Reveals answer text on an animation-frame cadence instead of painting every
 * SSE delta the moment it lands.
 *
 * Deliberately not gated on the run still being open: the knowledge routes
 * withhold draft tokens until the Critic approves, so their entire reply and the
 * terminal `done` frame arrive together. Tying the reveal to "still running"
 * would mean it never plays exactly where it is needed most. The loop simply
 * chases the text length, so it keeps typing after the stream closes and stops
 * once it catches up. Text that is already complete when the component mounts
 * (history, reload, a re-rendered thread) starts caught up and never replays.
 */
export function useStreamReveal(text: string): string {
  const targetRef = useRef(text)
  const shownRef = useRef(text.length)
  const lastTickRef = useRef(0)
  const frameRef = useRef<number | null>(null)
  const [shown, setShown] = useState(text.length)
  targetRef.current = text

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
      const target = targetRef.current.length
      const step = revealStep(shownRef.current, target, elapsed)
      if (step > 0) {
        shownRef.current += step
        setShown(shownRef.current)
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
