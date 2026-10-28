import { motion, useReducedMotion } from "motion/react"
import { cn } from "../../lib/cn"

/** Dashed ring spinning in place; the trace row's running marker. */
export function DashRing({
  size = 16,
  className,
}: {
  size?: number
  className?: string
}) {
  const reduceMotion = useReducedMotion()
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 50 50"
      width={size}
      height={size}
      className={cn("block shrink-0 fill-none", className)}
    >
      <motion.circle
        cx="25"
        cy="25"
        r="20"
        strokeWidth="3"
        strokeDasharray="8 8"
        className="fill-none stroke-current"
        animate={reduceMotion ? undefined : { rotate: 360 }}
        style={{ transformOrigin: "center" }}
        transition={
          reduceMotion
            ? undefined
            : { duration: 4, repeat: Infinity, ease: "linear" }
        }
      />
    </svg>
  )
}
