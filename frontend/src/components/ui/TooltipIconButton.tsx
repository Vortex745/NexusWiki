import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react"
import { Button } from "../ui/Button"
import { Tooltip } from "../arc/tooltip/tooltip"

export interface TooltipIconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  tooltip?: string
  children: ReactNode
  side?: "top" | "bottom"
}

export const TooltipIconButton = forwardRef<
  HTMLButtonElement,
  TooltipIconButtonProps
>(function TooltipIconButton(
  { tooltip, children, side = "top", className, ...rest },
  ref,
) {
  const button = (
    <Button
      ref={ref}
      variant="ghost"
      size="icon-sm"
      type="button"
      aria-label={tooltip}
      className={className}
      {...rest}
    >
      {children}
    </Button>
  )
  return tooltip ? (
    <Tooltip content={tooltip} side={side}>
      {button}
    </Tooltip>
  ) : (
    button
  )
})
