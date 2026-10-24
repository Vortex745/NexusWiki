import { forwardRef } from "react"
import {
  Switch as ArcSwitch,
  type SwitchProps as ArcSwitchProps,
} from "../arc/switch/switch"

export interface SwitchProps extends ArcSwitchProps {
  size?: "sm" | "default"
}

const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { size: _size, ...props },
  ref,
) {
  return <ArcSwitch ref={ref} data-slot="switch" {...props} />
})

export { Switch }
