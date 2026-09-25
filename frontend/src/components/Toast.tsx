import { useEffect, useRef, useState } from "react"

export interface ToastMessage {
  text: string
  key: number
}

const SHOW_MS = 2200
/** Margin past the 150ms exit transition before the element unmounts. */
const EXIT_MS = 180

export function Toast({ toast }: { toast: ToastMessage | null }) {
  const [shown, setShown] = useState<ToastMessage | null>(null)
  const [visible, setVisible] = useState(false)
  const lastKeyRef = useRef<number | null>(null)

  // Adopt a new toast during render (React's adjust-state-on-prop-change
  // pattern) so its element commits at the hidden from-state: mounting at
  // "shown" would skip the enter transition, and an effect-phase flip would
  // first paint the new element in the previous toast's visible state.
  if (toast && toast.key !== lastKeyRef.current) {
    lastKeyRef.current = toast.key
    setVisible(false)
    setShown(toast)
  }

  useEffect(() => {
    if (!shown) return
    // Double rAF: the first frame paints the from-state, the second flips it,
    // so the enter transition reliably plays.
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setVisible(true))
    })
    const hide = window.setTimeout(() => setVisible(false), SHOW_MS)
    // Once the exit has played, drop the element so the stale text leaves the
    // accessibility tree instead of lingering at opacity-0.
    const unmount = window.setTimeout(() => setShown(null), SHOW_MS + EXIT_MS)
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
      window.clearTimeout(hide)
      window.clearTimeout(unmount)
    }
  }, [shown])

  if (!shown) return null

  return (
    <div
      key={shown.key}
      role="status"
      aria-live="polite"
      className={
        "toast pointer-events-none fixed bottom-5 left-1/2 z-[100] max-w-[min(340px,calc(100vw-32px))] " +
        "-translate-x-1/2 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs " +
        "text-white shadow-md transition-[opacity,translate] duration-150 ease-out " +
        (visible ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0")
      }
    >
      {shown.text}
    </div>
  )
}
