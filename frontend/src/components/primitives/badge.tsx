import {
  Badge as ArcBadge,
  type BadgeProps as ArcBadgeProps,
  type BadgeTone,
} from "../arc/badge/badge"

type BadgeVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "outline"
  | "ghost"
  | "link"

export interface BadgeProps extends Omit<ArcBadgeProps, "tone"> {
  variant?: BadgeVariant
}

const tones: Record<BadgeVariant, BadgeTone> = {
  default: "neutral",
  secondary: "neutral",
  destructive: "danger",
  outline: "neutral",
  ghost: "neutral",
  link: "info",
}

function Badge({ variant = "default", size = "sm", ...props }: BadgeProps) {
  return (
    <ArcBadge
      data-slot="badge"
      data-variant={variant}
      tone={tones[variant]}
      size={size}
      {...props}
    />
  )
}

export { Badge }
