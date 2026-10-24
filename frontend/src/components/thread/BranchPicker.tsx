import { BranchPickerPrimitive, useAuiState } from "@assistant-ui/react"
import { ChevronLeft, ChevronRight } from "../ui/icons"

import { cn } from "../../lib/cn"
import { Icon } from "../ui/Icon"
import { TooltipIconButton } from "../ui/TooltipIconButton"

/** Only offer branch navigation when the host runtime can persist the selection. */
export function BranchPicker({ className }: { className?: string }) {
  const canSwitch = useAuiState((state) => state.thread.capabilities.switchToBranch)
  if (!canSwitch) return null
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "inline-flex items-center text-xs text-muted-foreground",
        className,
      )}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="上一个版本" className="size-6">
          <Icon data-icon="inline-start" icon={ChevronLeft} />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="下一个版本" className="size-6">
          <Icon data-icon="inline-start" icon={ChevronRight} />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  )
}
