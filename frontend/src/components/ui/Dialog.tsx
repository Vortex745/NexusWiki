import { useEffect, useRef, type ReactNode } from "react"
import type { IconProps } from "./Icon"
import { cn } from "../../lib/cn"
import {
  Dialog as LegacyDialogRoot,
  DialogContent as LegacyDialogContent,
} from "../primitives/dialog"
import { Separator } from "../primitives/separator"
import {
  Dialog as DialogRoot,
  DialogContent,
} from "../arc/dialog/dialog"

export function PanelDialog({
  open,
  onClose,
  titleId,
  className,
  children,
}: {
  open: boolean
  onClose: () => void
  titleId: string
  className?: string
  children: ReactNode
}) {
  const returnFocus = useRef<HTMLElement | null>(null)
  return (
    <LegacyDialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <LegacyDialogContent
        showCloseButton={false}
        aria-labelledby={titleId}
        aria-describedby={undefined}
        onOpenAutoFocus={() => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const target = returnFocus.current
          if (target?.isConnected) target.focus()
        }}
        className={cn(
          "flex max-h-[min(850px,calc(100dvh-48px))] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl max-md:h-dvh max-md:max-h-dvh max-md:w-screen max-md:max-w-full max-md:rounded-none",
          className,
        )}
      >
        {children}
      </LegacyDialogContent>
    </LegacyDialogRoot>
  )
}

const TIER = {
  confirm: "sm:max-w-md",
  manage: "sm:max-w-[560px] h-[min(700px,calc(100dvh-64px))]",
  work: "sm:max-w-[640px] h-[min(760px,calc(100dvh-64px))]",
} as const

export function Dialog({
  open,
  onClose,
  onOpen,
  title,
  titleId,
  tier = "manage",
  toolbar,
  footer,
  children,
}: {
  open: boolean
  onClose: () => void
  onOpen?: () => void
  title: string
  titleId: string
  icon?: IconProps["icon"]
  tier?: keyof typeof TIER
  toolbar?: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  const wasOpen = useRef(false)
  const onOpenRef = useRef(onOpen)
  const returnFocus = useRef<HTMLElement | null>(null)
  onOpenRef.current = onOpen
  useEffect(() => {
    if (open && !wasOpen.current) onOpenRef.current?.()
    wasOpen.current = open
  }, [open])
  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent
        title={title}
        titleId={titleId}
        closeLabel={`关闭${title}`}
        aria-describedby={undefined}
        bodyStyle={{ padding: 0, display: "flex", minHeight: 0, flex: 1 }}
        onOpenAutoFocus={() => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const target = returnFocus.current
          if (target?.isConnected) target.focus()
        }}
        className={cn(
          "flex max-h-[min(850px,calc(100dvh-48px))] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl max-md:h-dvh max-md:max-h-dvh max-md:w-screen max-md:max-w-full max-md:rounded-none",
          TIER[tier],
        )}
      >
        {toolbar ? (
          <>
            <div className="shrink-0 px-5 py-3 max-md:px-4">{toolbar}</div>
            <Separator />
          </>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-5 max-md:px-4">
          {children}
        </div>
        {footer ? (
          <>
            <Separator />
            <div className="shrink-0 px-5 py-3 max-md:px-4">{footer}</div>
          </>
        ) : null}
      </DialogContent>
    </DialogRoot>
  )
}
