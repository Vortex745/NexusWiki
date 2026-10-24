import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"
import {
  Popover,
  PopoverClose,
  PopoverTrigger,
  PopoverContent,
} from "../arc/popover/popover"

function PopoverAnchor(
  props: React.ComponentProps<typeof PopoverPrimitive.Anchor>,
) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverHeader(props: React.ComponentProps<"div">) {
  return <div data-slot="popover-header" {...props} />
}

function PopoverTitle(props: React.ComponentProps<"div">) {
  return <div data-slot="popover-title" {...props} />
}

function PopoverDescription(props: React.ComponentProps<"p">) {
  return <p data-slot="popover-description" {...props} />
}

export {
  Popover,
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
}
