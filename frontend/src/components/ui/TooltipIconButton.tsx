import type { ButtonHTMLAttributes, ReactNode } from "react"

import { cn } from "../../lib/cn"

export interface TooltipIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tooltip: string
  children: ReactNode
  /** Tooltip placement; mem0 renders every message/composer action above. */
  side?: "top" | "bottom"
}

export function TooltipIconButton({
  tooltip,
  children,
  side = "top",
  className,
  ...rest
}: TooltipIconButtonProps) {
  return (
    <span className="group/tip relative inline-flex">
      <button
        type="button"
        className={cn(
          "grid size-7 cursor-pointer place-items-center rounded-md text-muted",
          "transition-[color,background-color,border-color,transform,translate,scale] duration-150 ease-out hover:bg-surface-subtle hover:text-ink active:scale-[0.97]",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
          "disabled:pointer-events-none disabled:opacity-40",
          className,
        )}
        {...rest}
      >
        {children}
      </button>
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md",
          "bg-neutral-900 px-2 py-1 text-[11px] leading-4 text-white opacity-0 shadow-sm",
          "transition-opacity duration-150 group-hover/tip:opacity-100 group-focus-within/tip:opacity-100",
          side === "top" ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]",
        )}
      >
        {tooltip}
      </span>
    </span>
  )
}
