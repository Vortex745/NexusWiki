import { MorphIcon } from "morphicons/react"
import type { ComponentProps } from "react"

import { cn } from "../../lib/cn"

type MorphIconProps = ComponentProps<typeof MorphIcon>

export interface IconProps {
  /** Icon data — a Lucide IconNode or a raw `d` string. Both morph. */
  icon: MorphIconProps["icon"]
  className?: string
  /** When set, the icon becomes an accessible image instead of decorative. */
  label?: string
  spring?: MorphIconProps["spring"]
  strokeWidth?: number
}

/**
 * Every icon in the app renders through morphicons. When the `icon` prop
 * changes the shape morphs under spring physics; while it stays the same the
 * output is a plain static SVG, which is what most icons are.
 */
export function Icon({ icon, className, label, spring = "snappy", strokeWidth }: IconProps) {
  return (
    <MorphIcon
      icon={icon}
      spring={spring}
      strokeWidth={strokeWidth}
      label={label}
      reducedMotion="user"
      className={cn("size-4", className)}
    />
  )
}
