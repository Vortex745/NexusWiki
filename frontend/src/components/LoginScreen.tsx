import { useState } from "react"
import { ShieldCheck } from "lucide"

import { InvalidCredentialsError, type AuthConfigPayload } from "../lib/api"
import { cn } from "../lib/cn"
import { Icon } from "./ui/Icon"

interface LoginScreenProps {
  authConfig: AuthConfigPayload
  onSignIn(account: string, password: string): Promise<void>
}

/**
 * Ticket 01 (IAM-01): the local sign-in screen.
 *
 * It offers only the accounts the server advertises — the list comes from
 * `GET /api/auth/config`, so the browser cannot invent an identity. The
 * password is typed by the operator and posted once; nothing about the
 * issuer, the signing key or the credential is compiled into this bundle.
 */
export function LoginScreen({ authConfig, onSignIn }: LoginScreenProps) {
  const [account, setAccount] = useState(authConfig.accounts[0]?.key ?? "")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!account || pending) return
    setPending(true)
    setError(null)
    try {
      await onSignIn(account, password)
    } catch (cause) {
      setError(
        cause instanceof InvalidCredentialsError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : "登录失败"
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-canvas px-4 py-10">
      <form
        onSubmit={submit}
        aria-label="登录"
        className="w-full max-w-sm rounded-xl border border-line bg-surface p-6 shadow-card"
      >
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-lg bg-neutral-900 text-white dark:bg-neutral-700">
            <Icon icon={ShieldCheck} className="size-4" />
          </span>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold tracking-tight text-ink">NexusRAG</h1>
            <p className="text-[11px] text-muted">本地 OIDC 演示登录</p>
          </div>
        </div>

        <fieldset className="mt-5" disabled={pending}>
          <legend className="text-[11px] font-semibold uppercase tracking-wider text-muted/70">
            账号
          </legend>
          <div className="mt-2 flex flex-col gap-1.5">
            {authConfig.accounts.map((entry) => (
              <label
                key={entry.key}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors",
                  account === entry.key
                    ? "border-brand-line bg-brand-subtle text-ink"
                    : "border-line text-muted hover:bg-surface-subtle hover:text-ink"
                )}
              >
                <input
                  type="radio"
                  name="account"
                  value={entry.key}
                  checked={account === entry.key}
                  onChange={() => setAccount(entry.key)}
                  className="accent-brand"
                />
                <span>{entry.label}</span>
                <span className="ml-auto font-mono text-[10px] text-muted/70">{entry.key}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="mt-4 block text-[11px] font-semibold uppercase tracking-wider text-muted/70">
          密码
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            disabled={pending}
            className="mt-2 h-9 w-full rounded-lg border border-line bg-canvas px-3 text-xs font-normal normal-case tracking-normal text-ink outline-none focus-visible:border-brand-line focus-visible:outline-2 focus-visible:outline-brand"
          />
        </label>

        {error ? (
          <p role="alert" className="mt-3 text-[11px] text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending || !account}
          className="mt-4 h-9 w-full cursor-pointer rounded-lg bg-brand text-xs font-medium text-white shadow-card transition-[color,background-color,border-color,transform,translate,scale] duration-150 ease-out hover:bg-brand-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "登录中…" : "登录"}
        </button>

        <p className="mt-3 text-[11px] leading-relaxed text-muted/70">
          签名密钥仅存在于服务端进程，浏览器只拿到访问令牌。
        </p>
      </form>
    </div>
  )
}
