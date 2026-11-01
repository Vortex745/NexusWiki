import * as React from "react"
import { cn } from "../../lib/cn"

function BubbleGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="bubble-group"
      className={cn("flex min-w-0 flex-col gap-2", className)}
      {...props}
    />
  )
}

type BubbleVariant =
  | "default"
  | "secondary"
  | "muted"
  | "tinted"
  | "outline"
  | "ghost"
  | "destructive"

const bubbleVariants: Record<BubbleVariant, string> = {
  default:
    "*:data-[slot=bubble-content]:bg-accent-subtle *:data-[slot=bubble-content]:text-on-primary [&>[data-slot=bubble-content]:is(button,a):hover]:bg-accent-subtle/80",
  secondary:
    "*:data-[slot=bubble-content]:bg-surface-muted *:data-[slot=bubble-content]:text-ink [&>[data-slot=bubble-content]:is(button,a):hover]:bg-[color-mix(in_oklch,var(--surface-muted),var(--foreground)_5%)]",
  muted:
    "*:data-[slot=bubble-content]:bg-surface-subtle [&>[data-slot=bubble-content]:is(button,a):hover]:bg-[color-mix(in_oklch,var(--surface-muted),var(--foreground)_5%)]",
  tinted:
    "*:data-[slot=bubble-content]:bg-[oklch(from_var(--accent)_0.93_calc(c*0.4)_h)] *:data-[slot=bubble-content]:text-ink dark:*:data-[slot=bubble-content]:bg-[oklch(from_var(--accent)_0.3_calc(c*0.4)_h)] [&>[data-slot=bubble-content]:is(button,a):hover]:bg-[oklch(from_var(--accent)_0.88_calc(c*0.5)_h)] dark:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-[oklch(from_var(--accent)_0.35_calc(c*0.5)_h)]",
  outline:
    "*:data-[slot=bubble-content]:border-line *:data-[slot=bubble-content]:bg-canvas [&>[data-slot=bubble-content]:is(button,a):hover]:bg-surface-subtle [&>[data-slot=bubble-content]:is(button,a):hover]:text-ink dark:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-surface-muted/30",
  ghost:
    "border-none *:data-[slot=bubble-content]:rounded-none *:data-[slot=bubble-content]:bg-transparent *:data-[slot=bubble-content]:p-0 [&>[data-slot=bubble-content]:is(button,a):hover]:bg-surface-subtle [&>[data-slot=bubble-content]:is(button,a):hover]:text-ink dark:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-surface-subtle/50",
  destructive:
    "*:data-[slot=bubble-content]:bg-danger/10 *:data-[slot=bubble-content]:text-danger dark:*:data-[slot=bubble-content]:bg-danger/20 [&>[data-slot=bubble-content]:is(button,a):hover]:bg-danger/20 dark:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-danger/30",
}

function Bubble({
  variant = "default",
  align = "start",
  className,
  ...props
}: React.ComponentProps<"div"> & {
  variant?: BubbleVariant
  align?: "start" | "end"
}) {
  return (
    <div
      data-slot="bubble"
      data-variant={variant}
      data-align={align}
      className={cn(
        "group/bubble relative flex w-fit max-w-[80%] min-w-0 flex-col gap-1 group-data-[align=end]/message:self-end data-[align=end]:self-end data-[variant=ghost]:max-w-full",
        bubbleVariants[variant],
        className,
      )}
      {...props}
    />
  )
}

function BubbleContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="bubble-content"
      className={cn(
        "w-fit max-w-full min-w-0 overflow-hidden rounded-xl border border-transparent px-3 py-2 text-sm leading-relaxed wrap-break-word group-data-[align=end]/bubble:self-end [button]:text-left [button,a]:transition-colors [button,a]:outline-none [button,a]:focus-visible:border-accent [button,a]:focus-visible:ring-3 [button,a]:focus-visible:ring-accent/50",
        className,
      )}
      {...props}
    />
  )
}

type BubbleReactionsAlign = "start" | "end"
type BubbleReactionsSide = "top" | "bottom"

const bubbleReactionsPosition: Record<BubbleReactionsSide, string> = {
  top: "top-0 -translate-y-3/4",
  bottom: "bottom-0 translate-y-3/4",
}
const bubbleReactionsAlign: Record<BubbleReactionsAlign, string> = {
  start: "left-3",
  end: "right-3",
}

function BubbleReactions({
  side = "bottom",
  align = "end",
  className,
  ...props
}: React.ComponentProps<"div"> & {
  align?: BubbleReactionsAlign
  side?: BubbleReactionsSide
}) {
  return (
    <div
      data-slot="bubble-reactions"
      data-align={align}
      data-side={side}
      className={cn(
        "absolute z-10 flex w-fit shrink-0 items-center justify-center gap-1 rounded-full bg-surface-subtle px-1.5 py-0.5 text-sm ring-3 ring-surface has-[button]:p-0",
        bubbleReactionsPosition[side],
        bubbleReactionsAlign[align],
        className,
      )}
      {...props}
    />
  )
}

export { BubbleGroup, Bubble, BubbleContent, BubbleReactions }
