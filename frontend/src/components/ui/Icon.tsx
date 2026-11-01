import { useEffect, useRef, type ComponentProps } from "react"
import type { LucideIcon } from "lucide-react"

import { cn } from "../../lib/cn"

/** Standalone icons have a default size; shadcn controls own their icon sizing. */
const HAS_OWN_SIZE = /(^|\s)(size|w|h)-\S/

const ICON_SIZE = "size-4"

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)"

/** The swap spring, carried over from the old morphicons `snappy` preset. */
const SPRING = { k: 420, c: 30 }

export interface IconProps
  extends Omit<ComponentProps<"svg">, "children" | "dangerouslySetInnerHTML"> {
  icon: LucideIcon
  className?: string
  "data-icon"?: string
}

export function Icon({ icon: Glyph, className, ...props }: IconProps) {
  return (
    <Glyph
      {...props}
      aria-hidden
      className={cn(
        props["data-icon"] || HAS_OWN_SIZE.test(className ?? "")
          ? ""
          : ICON_SIZE,
        className,
      )}
    />
  )
}

export interface SwapIconProps {
  from: LucideIcon
  to: LucideIcon
  /** `false` holds `from`, `true` lands on `to`. */
  at: boolean
  className?: string
  "data-icon"?: string
}

/**
 * The state-swap icon. Both glyphs stay in the DOM and trade places under the
 * same spring — two different path sets cannot be interpolated into one
 * travelling shape, so the incoming glyph pops in with overshoot while the
 * outgoing one shrinks away, which keeps the physicality of the change.
 */
export function SwapIcon({ from: From, to: To, at, className, ...props }: SwapIconProps) {
  const fromEl = useRef<SVGSVGElement>(null)
  const toEl = useRef<SVGSVGElement>(null)
  // Progress toward `to`: 0 = fully `from`, 1 = fully `to`, overshoot allowed.
  const motion = useRef({ p: at ? 1 : 0, v: 0 })
  const settled = useRef(true)

  useEffect(() => {
    const fromNode = fromEl.current
    const toNode = toEl.current
    if (!fromNode || !toNode) return

    const { k, c } = SPRING
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
      // instant swap without the spring.
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
      // Same substep clamp as the previous morphicons-driven integrator.
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
      {/* The layers fill the shared 24-unit viewport (the global `svg` box
          rule would otherwise resize them to 16px); the spring drives their
          opacity and transform attributes directly. */}
      <From ref={fromEl} className="size-full" opacity={at ? 0 : 1} />
      <To ref={toEl} className="size-full" opacity={at ? 1 : 0} />
    </svg>
  )
}
