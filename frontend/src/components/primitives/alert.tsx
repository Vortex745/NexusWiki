import { Children, isValidElement, type ReactNode } from "react"
import {
  Alert as ArcAlert,
  type AlertProps as ArcAlertProps,
  type AlertTone,
} from "../arc/alert/alert"

type AlertVariant = "default" | "destructive"

export interface AlertProps
  extends Omit<ArcAlertProps, "title" | "tone"> {
  variant?: AlertVariant
  title?: string
  tone?: AlertTone
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return ""
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (isValidElement<{ children?: ReactNode }>(node))
    return textOf(node.props.children)
  return String(node)
}

function AlertTitle(props: React.ComponentProps<"div">) {
  return <div data-slot="alert-title" {...props} />
}

function AlertDescription(props: React.ComponentProps<"div">) {
  return <div data-slot="alert-description" {...props} />
}

function AlertAction(props: React.ComponentProps<"div">) {
  return <div data-slot="alert-action" {...props} />
}

function Alert({
  variant = "default",
  tone,
  title,
  children,
  ...props
}: AlertProps) {
  const body: ReactNode[] = []
  let childTitle = ""
  for (const child of Children.toArray(children)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) {
      body.push(child)
    } else if (child.type === AlertTitle) {
      childTitle = textOf(child.props.children)
    } else if (child.type === AlertDescription) {
      body.push(child.props.children)
    } else {
      body.push(child)
    }
  }
  return (
    <ArcAlert
      data-slot="alert"
      tone={tone ?? (variant === "destructive" ? "danger" : "info")}
      title={title ?? (childTitle || (variant === "destructive" ? "发生错误" : "提示"))}
      {...props}
    >
      {body}
    </ArcAlert>
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction }
