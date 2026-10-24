import { forwardRef } from "react"
import {
  Input as ArcInput,
  type InputProps,
} from "../arc/input/input"

const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  props,
  ref,
) {
  return <ArcInput ref={ref} data-slot="input" {...props} />
})

export { Input, type InputProps }
