import { useEffect, useRef, type ComponentProps } from "react"
import { SPRING_PRESETS } from "morphicons"
import type { IconFunction } from "reicon"

import { cn } from "../../lib/cn"

/** Standalone icons have a default size; shadcn controls own their icon sizing. */
const HAS_OWN_SIZE = /(^|\s)(size|w|h)-\S/

const ICON_SIZE = "size-4"

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)"

/** reicon's Outline weight. Every glyph fills or strokes its own paths, so the
 *  markup is dropped in as-is and needs no inherited paint defaults. */
const outline = (glyph: IconFunction) => glyph.iconData.O ?? ""

export interface IconProps
  extends Omit<ComponentProps<"svg">, "children" | "dangerouslySetInnerHTML"> {
  icon: IconFunction
  className?: string
  "data-icon"?: string
}

export function Icon({ icon, className, ...props }: IconProps) {
  return (
    <svg
      {...props}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={cn(
        props["data-icon"] || HAS_OWN_SIZE.test(className ?? "")
          ? ""
          : ICON_SIZE,
        className,
      )}
      dangerouslySetInnerHTML={{ __html: outline(icon) }}
    />
  )
}

export interface SwapIconProps {
  from: IconFunction
  to: IconFunction
  /** `false` holds `from`, `true` lands on `to`. */
  at: boolean
  className?: string
  "data-icon"?: string
}

/**
 * The state-swap icon. It replaces the shape morph this app used to run through
 * morphicons: reicon draws its outlines as *fills*, and a fill contour cannot be
 * interpolated as a stroke centerline, so the two endpoints of a swap can no
 * longer be merged into one travelling path. Instead both glyphs stay in the DOM
 * and trade places under the same spring, which keeps the physicality of the
 * change without pretending to interpolate geometry.
 */
export function SwapIcon({ from, to, at, className, ...props }: SwapIconProps) {
  const fromEl = useRef<SVGGElement>(null)
  const toEl = useRef<SVGGElement>(null)
  // Progress toward `to`: 0 = fully `from`, 1 = fully `to`, overshoot allowed.
  const motion = useRef({ p: at ? 1 : 0, v: 0 })
  const settled = useRef(true)

  useEffect(() => {
    const fromNode = fromEl.current
    const toNode = toEl.current
    if (!fromNode || !toNode) return

    const { k, c } = SPRING_PRESETS.snappy
    const state = motion.current
    const target = at ? 1 : 0

    const paint = () => {
      const t = Math.max(0, Math.min(1, state.p))
      // The incoming glyph rides the raw spring so the overshoot reads as a
      // pop; the outgoing one only ever moves inward, so it cannot go negative.
      const inScale = 0.86 + 0.14 * state.p
      const outScale = 1 - 0.14 * t
      const around = (s: number) =>
        `translate(12 12) scale(${s}) translate(-12 -12)`
      toNode.setAttribute("opacity", String(t))
      toNode.setAttribute("transform", around(inScale))
      fromNode.setAttribute("opacity", String(1 - t))
      fromNode.setAttribute("transform", around(outScale))
    }

    if (settled.current || window.matchMedia(REDUCED_MOTION).matches) {
      // First commit has nothing to leave; a reduced-motion reader gets the
      // same instant swap morphicons degraded to.
      settled.current = false
      state.p = target
      state.v = 0
      paint()
      return
    }

    let frame = 0
    let last = performance.now()
    const step = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000)
      last = now
      // Same substep clamp as morphicons' own integrator.
      const substeps = Math.max(1, Math.min(16, Math.ceil(dt / (1 / 240))))
      const h = dt / substeps
      for (let i = 0; i < substeps; i++) {
        state.v += (k * (target - state.p) - c * state.v) * h
        state.p += state.v * h
      }
      paint()
      if (Math.abs(target - state.p) < 0.001 && Math.abs(state.v) < 0.02) {
        state.p = target
        state.v = 0
        paint()
        return
      }
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [at])

  return (
    <svg
      {...props}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={cn(
        props["data-icon"] || HAS_OWN_SIZE.test(className ?? "")
          ? ""
          : ICON_SIZE,
        className,
      )}
    >
      <g ref={fromEl} dangerouslySetInnerHTML={{ __html: outline(from) }} />
      <g ref={toEl} dangerouslySetInnerHTML={{ __html: outline(to) }} />
    </svg>
  )
}
