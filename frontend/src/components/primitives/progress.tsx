import {
  Progress as ArcProgress,
  type ProgressProps as ArcProgressProps,
} from "../arc/progress/progress"

export interface ProgressProps
  extends Omit<ArcProgressProps, "value" | "aria-label"> {
  value?: number | null
  "aria-label"?: string
}

function Progress({
  value = 0,
  label,
  "aria-label": ariaLabel,
  ...props
}: ProgressProps) {
  return (
    <ArcProgress
      data-slot="progress"
      value={value ?? 0}
      label={label ?? ariaLabel}
      {...props}
    />
  )
}

export { Progress }
