"use client"

import * as React from "react"
import { cn } from "../../lib/cn"

// Local disclosure replacing the removed radix-ui collapsible primitive.
// Content stays mounted but inert while closed, so the grid-rows height
// transition can run in both directions.

type CollapsibleContextValue = {
  open: boolean
  toggle: () => void
}

const CollapsibleContext = React.createContext<CollapsibleContextValue | null>(null)

function useCollapsible() {
  const context = React.useContext(CollapsibleContext)
  if (!context) {
    throw new Error("Collapsible parts must be used within a Collapsible.")
  }
  return context
}

function Collapsible({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen)
  const open = openProp ?? internalOpen
  const toggle = React.useCallback(() => {
    const next = !open
    if (openProp === undefined) setInternalOpen(next)
    onOpenChange?.(next)
  }, [onOpenChange, open, openProp])
  return (
    <CollapsibleContext.Provider value={{ open, toggle }}>
      <div
        data-slot="collapsible"
        data-state={open ? "open" : "closed"}
        className={className}
        {...props}
      />
    </CollapsibleContext.Provider>
  )
}

function CollapsibleTrigger({
  className,
  onClick,
  asChild = false,
  children,
  ...props
}: React.ComponentProps<"button"> & { asChild?: boolean }) {
  const { open, toggle } = useCollapsible()
  const handleClick = (event: React.MouseEvent) => {
    ;(onClick as ((event: React.MouseEvent) => void) | undefined)?.(event)
    if (event.defaultPrevented) return
    toggle()
  }
  const triggerProps = {
    type: asChild ? undefined : ("button" as const),
    "aria-expanded": open,
    "data-state": open ? ("open" as const) : ("closed" as const),
    className,
    onClick: handleClick,
    ...props,
  }
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(
      children as React.ReactElement<typeof triggerProps>,
      triggerProps,
    )
  }
  return <button {...triggerProps}>{children}</button>
}

function CollapsibleContent({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const { open } = useCollapsible()
  return (
    <div
      data-slot="collapsible-content"
      data-state={open ? "open" : "closed"}
      className={cn(
        "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        className,
      )}
      {...props}
    >
      <div className="overflow-hidden" inert={!open}>
        {children}
      </div>
    </div>
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
