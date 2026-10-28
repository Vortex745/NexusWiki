import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  type ReactNode,
} from "react"
import type { IconProps } from "./Icon"
import { Icon } from "./Icon"
import { cn } from "../../lib/cn"
import { Button as UiButton } from "./Button"
import { Input } from "../arc/input/input"
import { Textarea } from "../arc/textarea/textarea"
import {
  Field as ShadcnField,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "./field"
import { Select as ArcSelect } from "../arc/select/select"
import { Checkbox as ArcCheckbox } from "../arc/checkbox/checkbox"
import { EmptyState as ArcEmptyState } from "../arc/empty-state/empty-state"
import { Badge } from "../arc/badge/badge"

/** Compatibility props keep existing business handlers intact during the UI migration. */
export function Button({
  tone = "neutral",
  size = "md",
  full = false,
  icon,
  className,
  children,
  ...rest
}: React.ComponentProps<"button"> & {
  tone?: "primary" | "neutral" | "danger"
  size?: "sm" | "md" | "lg"
  full?: boolean
  icon?: IconProps["icon"]
}) {
  return (
    <UiButton
      type="button"
      variant={
        tone === "primary"
          ? "default"
          : tone === "danger"
            ? "destructive"
            : "outline"
      }
      size={size === "sm" ? "sm" : size === "lg" ? "lg" : "default"}
      className={cn(full && "w-full", className)}
      {...rest}
    >
      {icon ? <Icon icon={icon} data-icon="inline-start" /> : null}
      {children}
    </UiButton>
  )
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string
  htmlFor?: string
  hint?: string
  children: ReactNode
}) {
  const generatedId = useId()
  const child = isValidElement<{ id?: string }>(children) ? children : null
  const id = htmlFor ?? child?.props.id ?? generatedId
  return (
    <FieldGroup>
      <ShadcnField>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {child ? cloneElement(child, { id }) : children}
        {hint ? <FieldDescription>{hint}</FieldDescription> : null}
      </ShadcnField>
    </FieldGroup>
  )
}

export function TextInput(props: React.ComponentProps<"input">) {
  return <Input {...props} />
}
export function TextArea(props: React.ComponentProps<"textarea">) {
  return <Textarea {...props} />
}

type Entry =
  | { kind: "option"; value: string; label: string; disabled: boolean }
  | { kind: "group"; label: string }
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return ""
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (isValidElement<{ children?: ReactNode }>(node))
    return textOf(node.props.children)
  return String(node)
}
function flattenOptions(children: ReactNode): Entry[] {
  const entries: Entry[] = []
  const walk = (node: ReactNode) => {
    for (const child of Children.toArray(node)) {
      if (
        !isValidElement<{
          children?: ReactNode
          label?: string
          value?: unknown
          disabled?: boolean
        }>(child)
      )
        continue
      if (child.type === "optgroup") {
        entries.push({ kind: "group", label: child.props.label ?? "" })
        walk(child.props.children)
      } else if (child.type === "option")
        entries.push({
          kind: "option",
          value: String(child.props.value ?? ""),
          label: textOf(child.props.children),
          disabled: Boolean(child.props.disabled),
        })
      else walk(child.props.children)
    }
  }
  walk(children)
  return entries
}
export function Select({
  value,
  defaultValue,
  onChange,
  children,
  className,
  wrapperClassName,
  disabled,
  size = "md",
  hideSelected,
  id,
  name,
  required,
  title,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
  "aria-invalid": invalid,
}: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size"> & {
  wrapperClassName?: string
  size?: "sm" | "md"
  /** Opt-in: the popup lists alternatives only (the trigger keeps the value). */
  hideSelected?: boolean
}) {
  const entries = flattenOptions(children)
  // Prefix every value so the real empty-string choice remains selectable in Radix.
  const encode = (value: unknown) => `value:${String(value ?? "")}`
  let group = ""
  const options = entries.flatMap((entry) => {
    if (entry.kind === "group") {
      group = entry.label
      return []
    }
    return [{
      value: encode(entry.value),
      label: entry.label,
      disabled: entry.disabled,
      group: group || undefined,
    }]
  })
  return (
    <span className={cn("block min-w-0", wrapperClassName)}>
      <ArcSelect
        id={id}
        title={title}
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        aria-invalid={invalid}
        className={cn("w-full", className)}
        style={{ minHeight: size === "sm" ? 36 : 44 }}
        options={options}
        hideSelected={hideSelected}
        value={value === undefined ? undefined : encode(value)}
        defaultValue={
          defaultValue === undefined ? undefined : encode(defaultValue)
        }
        disabled={disabled}
        name={name}
        required={required}
        onValueChange={(next) => {
          const decoded = next.slice(6)
          onChange?.({
            target: { value: decoded, name },
            currentTarget: { value: decoded, name },
          } as React.ChangeEvent<HTMLSelectElement>)
        }}
      />
    </span>
  )
}
export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  title,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  title?: string
}) {
  return (
    <ArcCheckbox
      checked={checked}
      disabled={disabled}
      title={title}
      label={label}
      onCheckedChange={(next) => onChange(next === true)}
    />
  )
}
export function EmptyState({
  icon,
  message,
  action,
}: {
  icon?: IconProps["icon"]
  message: string
  action?: ReactNode
}) {
  return (
    <ArcEmptyState
      title={message}
      icon={icon ? <Icon icon={icon} /> : undefined}
      action={action}
    />
  )
}
export function StatusBadge({
  tone = "neutral",
  title,
  children,
}: {
  tone?: "neutral" | "success" | "warning" | "danger"
  title?: string
  children: ReactNode
}) {
  return (
    <Badge tone={tone === "danger" ? "danger" : "neutral"} title={title}>
      {children}
    </Badge>
  )
}
