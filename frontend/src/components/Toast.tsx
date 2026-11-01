import { useEffect, useState } from "react"
import ArcToast, { type ToastTone } from "./arc/toast/toast"

export interface ToastMessage {
  text: string
  key: number
  tone?: ToastTone
}

export function Toast({ toast }: { toast: ToastMessage | null }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (toast) setOpen(true)
  }, [toast])
  if (!toast) return null
  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-100 flex justify-center">
      <div className="pointer-events-auto w-full max-w-md">
        <ArcToast
          key={toast.key}
          title={toast.text}
          tone={toast.tone}
          open={open}
          onOpenChange={setOpen}
          duration={2200}
        />
      </div>
    </div>
  )
}
