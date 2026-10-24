import { forwardRef } from "react"
import {
  Textarea as ArcTextarea,
  type TextareaProps,
} from "../arc/textarea/textarea"

const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea(props, ref) {
    return <ArcTextarea ref={ref} data-slot="textarea" {...props} />
  },
)

export { Textarea, type TextareaProps }
