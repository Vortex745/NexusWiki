import { useEffect, useRef, type CSSProperties, type ReactNode } from "react"
import {
  Dialog as ArcDialog,
  DialogContent as ArcDialogContent,
} from "../arc/dialog/dialog"
import { cn } from "../../lib/cn"
import { Button } from "./Button"

/**
 * The one dialog container every dialog in the app renders through. Arc owns
 * the surface: the root tracks open state so the exit animation can finish,
 * Radix owns Escape, modality, focus trapping and the outside-press guard,
 * and the shared chrome (overlay, panel, titled header with its close
 * button) lives in the Arc dialog. Slot layout (toolbar/body/footer) is
 * layered on top by `Dialog`; `PanelDialog` hands the whole body to the
 * caller.
 */

/** Zeroes Arc's body padding so the slotted rows can draw full-bleed rules. */
const FLUSH_BODY: CSSProperties = {
  padding: 0,
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minHeight: 0,
  overflow: "hidden",
}

function DialogShell({
  open,
  onClose,
  title,
  titleId,
  className,
  headerStyle,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  titleId?: string
  className?: string
  headerStyle?: CSSProperties
  children: ReactNode
}) {
  const returnFocus = useRef<HTMLElement | null>(null)
  return (
    <ArcDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <ArcDialogContent
        title={title}
        titleId={titleId}
        closeLabel={`关闭${title}`}
        className={className}
        headerStyle={headerStyle}
        bodyStyle={FLUSH_BODY}
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
      >
        {children}
      </ArcDialogContent>
    </ArcDialog>
  )
}

export function PanelDialog({
  open,
  onClose,
  title,
  titleId,
  className,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  titleId?: string
  className?: string
  children: ReactNode
}) {
  return (
    <DialogShell
      open={open}
      onClose={onClose}
      title={title}
      titleId={titleId}
      className={cn("flex w-[calc(100vw-2rem)] flex-col", className)}
    >
      {children}
    </DialogShell>
  )
}

export function PanelBody({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4 max-md:px-4",
        className,
      )}
    >
      {children}
    </div>
  )
}

const TIER = {
  confirm: "",
  form: "flex w-[calc(100vw-2rem)] flex-col overflow-hidden sm:max-w-[560px]",
  manage:
    "flex w-[calc(100vw-2rem)] flex-col overflow-hidden sm:max-w-[560px] h-[min(700px,calc(100dvh-2rem))]",
  work: "flex w-[calc(100vw-2rem)] flex-col overflow-hidden sm:max-w-[640px] h-[min(760px,calc(100dvh-2rem))]",
} as const

export function Dialog({
  open,
  onClose,
  onOpen,
  title,
  titleId,
  tier = "manage",
  dividers = true,
  toolbar,
  footer,
  bodyClassName,
  children,
}: {
  open: boolean
  onClose: () => void
  onOpen?: () => void
  title: string
  titleId?: string
  tier?: keyof typeof TIER
  /** Draws the rules under the header and around the toolbar/footer. */
  dividers?: boolean
  toolbar?: ReactNode
  footer?: ReactNode
  bodyClassName?: string
  children: ReactNode
}) {
  const wasOpen = useRef(false)
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen
  useEffect(() => {
    if (open && !wasOpen.current) onOpenRef.current?.()
    wasOpen.current = open
  }, [open])
  return (
    <DialogShell
      open={open}
      onClose={onClose}
      title={title}
      titleId={titleId}
      className={TIER[tier]}
      headerStyle={dividers ? undefined : { borderBottom: 0 }}
    >
      {toolbar ? (
        <div
          className={cn(
            "flex-none px-5 pb-3 max-md:px-4",
            dividers && "border-b border-line",
          )}
        >
          {toolbar}
        </div>
      ) : null}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-5 max-md:px-4",
          bodyClassName,
        )}
      >
        {children}
      </div>
      {footer ? (
        <div
          className={cn(
            "flex-none px-5 py-3 max-md:px-4",
            dividers && "border-t border-line",
          )}
        >
          {footer}
        </div>
      ) : null}
    </DialogShell>
  )
}

export function ConfirmDialog({
  open,
  onClose,
  onOpen,
  title,
  titleId,
  children,
  confirmLabel,
  cancelLabel = "取消",
  confirmTone = "danger",
  onConfirm,
  busy = false,
  confirmDisabled = false,
}: {
  open: boolean
  onClose: () => void
  onOpen?: () => void
  title: string
  titleId?: string
  children: ReactNode
  confirmLabel: string
  cancelLabel?: string
  confirmTone?: "danger" | "primary"
  onConfirm: () => void
  busy?: boolean
  confirmDisabled?: boolean
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      onOpen={onOpen}
      title={title}
      titleId={titleId}
      tier="confirm"
      footer={
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onClose}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={confirmTone === "danger" ? "destructive" : "default"}
            size="sm"
            disabled={busy || confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-2 text-xs leading-relaxed text-faint">
        {children}
      </div>
    </Dialog>
  )
}
