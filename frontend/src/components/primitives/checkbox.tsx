import { forwardRef } from "react"
import {
  Checkbox as ArcCheckbox,
  type CheckboxProps,
} from "../arc/checkbox/checkbox"

const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(
  function Checkbox(props, ref) {
    return <ArcCheckbox ref={ref} data-slot="checkbox" {...props} />
  },
)

export { Checkbox, type CheckboxProps }
