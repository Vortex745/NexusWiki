import { forwardRef } from "react"
import { cn } from "cn"
import {
  Button as ArcButton,
  type ButtonProps as ArcButtonProps,
  type ButtonSize as ArcButtonSize,
  type ButtonVariant as ArcButtonVariant,
} from "../arc/button/button"

type ButtonVariant =
  | "default"
  | "outline"
  | "secondary"
  | "ghost"
  | "destructive"
  | "link"
type ButtonSize =
  | "default"
  | "xs"
  | "sm"
  | "lg"
  | "icon"
  | "icon-xs"
  | "icon-sm"
  | "icon-lg"

export interface ButtonProps
  extends Omit<ArcButtonProps, "variant" | "size"> {
  variant?: ButtonVariant
  size?: ButtonSize
}

const variants: Record<ButtonVariant, ArcButtonVariant> = {
  default: "primary",
  outline: "secondary",
  secondary: "secondary",
  ghost: "ghost",
  destructive: "danger",
  link: "ghost",
}

const sizes: Record<ButtonSize, ArcButtonSize> = {
  default: "md",
  xs: "sm",
  sm: "sm",
  lg: "lg",
  icon: "md",
  "icon-xs": "sm",
  "icon-sm": "sm",
  "icon-lg": "lg",
}

const sizeClasses: Record<ButtonSize, string> = {
  default: "h-8 min-h-0 gap-1.5 px-2.5",
  xs: "h-6 min-h-0 gap-1 rounded-lg px-2 text-xs",
  sm: "h-7 min-h-0 gap-1 rounded-lg px-2.5 text-[0.8rem]",
  lg: "h-9 min-h-0 gap-1.5 px-2.5",
  icon: "size-8 min-h-0 p-0",
  "icon-xs": "size-6 min-h-0 p-0",
  "icon-sm": "size-7 min-h-0 p-0",
  "icon-lg": "size-9 min-h-0 p-0",
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "default",
      size = "default",
      className,
      ...props
    },
    ref,
  ) {
    return (
      <ArcButton
        ref={ref}
        data-slot="button"
        data-variant={variant}
        data-size={size}
        variant={variants[variant]}
        size={sizes[size]}
        className={cn(sizeClasses[size], className)}
        {...props}
      />
    )
  },
)
