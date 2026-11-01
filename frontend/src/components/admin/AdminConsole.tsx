import { useEffect, useRef } from "react"

import { Button as UiButton } from "../ui/Button"
import { Icon } from "../ui/Icon"
import { Shield, X } from "../ui/icons"
import { UserMenu } from "../arc/user-menu/user-menu"
import { useSignedInSession, useSession } from "../../runtime/SessionContext"
import { UserDirectory } from "./UserDirectory"
import { UserOverview } from "./UserOverview"

/**
 * AC-02 (admin console), user decision 2026-10-31: the operator's separate
 * back-office interface. Signing in WITH the administrator password lands
 * here directly — this is the app's home view for `session.operator`, not an
 * extra entry inside the chat.
 *
 * The chat shell stays mounted underneath the fixed overlay, so 「进入对话」
 * returns to an untouched chat (layout, scroll, theme, composer) and the
 * sidebar entry switches back. The header carries the account menu, so the
 * operator can sign out without ever visiting the chat. Every API this
 * console calls is rejected server-side for anyone else.
 */
export function AdminConsole({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const session = useSignedInSession()
  const { signOut } = useSession()
  // Fullscreen takeover: put focus on the way out, so keyboard users are not
  // dropped into a hidden focus order behind the overlay.
  useEffect(() => {
    if (open) closeRef.current?.focus()
  }, [open])
  if (!open) return null
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="后台管理"
      className="fixed inset-0 z-50 flex min-h-0 flex-col bg-canvas"
    >
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-2 text-ink">
          <Icon icon={Shield} className="size-4 flex-none text-faint" />
          <h1 className="truncate text-sm font-semibold">后台管理</h1>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {session?.displayName ? (
            <UserMenu
              user={{ name: session.displayName, caption: "后台管理员" }}
              showName
              align="end"
              onSignOut={() => signOut()}
            />
          ) : null}
          <UiButton
            ref={closeRef}
            variant="outline"
            size="sm"
            type="button"
            onClick={onClose}
            title="离开后台，进入对话工作区"
          >
            <Icon data-icon="inline-start" icon={X} />
            进入对话
          </UiButton>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 md:px-6">
          <UserOverview />
          <UserDirectory />
        </div>
      </div>
    </div>
  )
}
