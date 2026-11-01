import type { ReactNode } from "react"
import { cn } from "../../lib/cn"

export function DangerNote({
  children,
  hint,
  className,
}: {
  children: ReactNode
  hint?: string
  className?: string
}) {
  return (
    <p
      className={cn(
        "rounded-[10px] border border-danger-line bg-danger-subtle px-3 py-2 text-danger",
        className,
      )}
      title={hint}
    >
      {children}
    </p>
  )
}

export function InlineMessage({
  children,
  role,
  className,
}: {
  children: ReactNode
  role?: "status" | "alert"
  className?: string
}) {
  return (
    <p
      role={role}
      className={cn("px-1 py-6 text-center text-xs text-faint", className)}
    >
      {children}
    </p>
  )
}

export const listRowSurfaceClass =
  "rounded-[10px] border border-line px-3 py-2.5 transition-colors hover:border-faint/40"

export function ListRow({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <li
      className={cn(
        listRowSurfaceClass,
        "flex items-center gap-3 max-md:flex-wrap",
        className,
      )}
    >
      {children}
    </li>
  )
}
