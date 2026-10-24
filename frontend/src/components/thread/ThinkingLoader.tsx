import { useEffect, useState } from "react"

/* ---------------------------------------------------------------------------
   Pixel-grid loader for the gap between "run started" and "first token".
   Ported from beautifului.dev's Loading State, with three deliberate changes:

   - Colour references moved onto this project's tokens. The original reads
     `var(--ink-3)`, which does not exist here and would have resolved to
     nothing.
   - The elapsed timer is aria-hidden. The original put the whole row in a
     `role="status"` live region, so a 10Hz counter announced continuously.
   - `pixel-on` is authored, not ported: the source file referenced a keyframe
     that lives in that site's global CSS and was not included.

   Variants share one 3x3 grid and differ only in delay order: Drive and Dots
   run a chevron wavefront left-to-right, Orbit walks the perimeter.
--------------------------------------------------------------------------- */

/** Cell lightness at rest. The lit peak lives in the `pixel-on` keyframe. */
const DIM = 0.15

/** Column-major chevron: the middle row leads at each column, edges trail. */
const CHEVRON = Array.from({ length: 9 }, (_, i) => {
  const row = Math.floor(i / 3)
  const col = i % 3
  return (col + Math.abs(row - 1)) * 90
})

/** Perimeter walk, centre cell deliberately dark so the ring reads as a ring. */
const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3]
const ORBIT = Array.from({ length: 9 }, (_, i) => {
  const step = ORBIT_ORDER.indexOf(i)
  return step === -1 ? null : step * 110
})

const PATTERNS = {
  Drive: { delays: CHEVRON, dur: 650, round: false },
  Dots: { delays: CHEVRON, dur: 650, round: true },
  Orbit: { delays: ORBIT, dur: 950, round: false },
} as const

export type ThinkingLoaderVariant = keyof typeof PATTERNS

function LoaderGrid({ variant }: { variant: ThinkingLoaderVariant }) {
  const { delays, dur, round } = PATTERNS[variant]
  return (
    <span
      aria-hidden
      className="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]"
    >
      {delays.map((delay, index) => (
        <span
          key={index}
          /* The animation is set inline per cell, so reduced motion can only
             reach it through a class the stylesheet can target. */
          className="t-pixel-cell"
          style={{
            width: 4,
            height: 4,
            borderRadius: round ? "50%" : 1,
            background: "var(--color-ink)",
            // A cell with no delay never participates in the wavefront.
            opacity: delay === null ? 0.07 : DIM,
            animation:
              delay === null
                ? "none"
                : `pixel-on ${dur}ms ease-in-out ${delay}ms infinite`,
          }}
        />
      ))}
    </span>
  )
}

/** Tenths of a second since this loader mounted, which is close enough to the
 *  start of the run to be honest, and rolls over to `m s` past a minute. */
function useElapsed() {
  const [ticks, setTicks] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setTicks((t) => t + 1), 100)
    return () => window.clearInterval(timer)
  }, [])
  const total = ticks / 10
  return total < 60
    ? `${total.toFixed(1)}s`
    : `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`
}

export interface ThinkingLoaderProps {
  /** Shimmering status text, e.g. the current answer-path stage. */
  label: string
  variant?: ThinkingLoaderVariant
}

export function ThinkingLoader({
  label,
  variant = "Drive",
}: ThinkingLoaderProps) {
  const elapsed = useElapsed()

  return (
    <div className="flex h-5 items-center gap-2.5 py-0.5">
      <LoaderGrid variant={variant} />
      {/* One announcement for the state change, not one per repaint. */}
      <span role="status" aria-label={label} className="t-shimmer-label">
        {label}
      </span>
      <span
        aria-hidden
        className="font-mono text-xs text-muted-foreground tabular-nums"
      >
        {elapsed}
      </span>
    </div>
  )
}
