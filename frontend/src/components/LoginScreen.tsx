import { useState } from "react"
import { motion, useReducedMotion } from "motion/react"
import { Check } from "lucide-react"
import { InvalidCredentialsError, type AuthConfigPayload } from "../lib/api"
import { PasswordField } from "./arc/password-field/password-field"
import { Alert } from "./arc/alert/alert"
import { Button } from "./ui/Button"
import { motionTokens } from "./arc/lib/motion-tokens"

interface LoginScreenProps {
  authConfig: AuthConfigPayload
  onSignIn: (account: string, password: string) => Promise<void>
}

export function LoginScreen({ authConfig, onSignIn }: LoginScreenProps) {
  const [account, setAccount] = useState(authConfig.accounts[0]?.key ?? "")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const reduced = useReducedMotion()
  const { duration, ease, blur, spring } = motionTokens

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
            : "登录失败",
      )
    } finally {
      setPending(false)
    }
  }

  const pickAccount = (key: string) => {
    setAccount(key)
    setError(null)
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-canvas p-5">
      <motion.form
        onSubmit={submit}
        aria-label="登录"
        initial={
          reduced
            ? { opacity: 0 }
            : { opacity: 0, y: -24, scale: 0.97, filter: `blur(${blur.soft}px)` }
        }
        animate={
          reduced
            ? { opacity: 1 }
            : { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }
        }
        transition={{ duration: duration.standard, ease: [...ease.enter] }}
        className="w-xs overflow-hidden rounded-[var(--radius-surface)] border border-line bg-surface-muted shadow-[var(--shadow-raised)] transition-colors sm:w-sm"
      >
        <div className="border-b border-line bg-surface p-6 pb-8 transition-colors sm:p-8 sm:pb-10">
          <h1 className="text-2xl font-semibold text-ink sm:text-3xl">
            登录 NexusWiki
          </h1>
          <p className="mb-6 mt-1.5 text-sm text-faint sm:mb-8 sm:text-base">
            选择您的账号并输入密码
          </p>

          <div
            role="radiogroup"
            aria-label="选择账号"
            className="flex flex-col gap-2.5 sm:gap-3"
          >
            {authConfig.accounts.map((entry) => {
              const selected = account === entry.key
              return (
                <motion.button
                  key={entry.key}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={pending}
                  onClick={() => pickAccount(entry.key)}
                  whileTap={reduced ? undefined : { scale: 0.985 }}
                  transition={spring.snappy}
                  className={
                    "flex w-full items-center justify-between gap-3 rounded-[var(--radius-control)] border bg-surface px-4 py-3 text-sm font-medium text-ink transition-colors disabled:opacity-60 sm:text-base " +
                    (selected ? "border-ink" : "border-line hover:bg-surface-muted")
                  }
                >
                  {entry.label}
                  {selected ? (
                    <Check className="size-4 shrink-0" aria-hidden />
                  ) : null}
                </motion.button>
              )
            })}
          </div>

          <div className="my-5 h-px bg-linear-to-r from-transparent via-line to-transparent sm:my-6" />

          <PasswordField
            id="login-password"
            label="密码"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            disabled={pending}
            aria-invalid={Boolean(error)}
            messages={{
              showPassword: "显示密码",
              hidePassword: "隐藏密码",
            }}
          />

          {error ? (
            <Alert tone="danger" title="发生错误" className="mt-4">
              {error}
            </Alert>
          ) : null}

          <motion.div
            whileHover={reduced ? undefined : { scale: 1.01 }}
            whileTap={reduced ? undefined : { scale: 0.97 }}
            transition={spring.snappy}
            className="mt-6 sm:mt-8"
          >
            <Button
              type="submit"
              loading={pending}
              disabled={!account}
              className="h-11 w-full text-base"
            >
              {pending ? "登录中…" : "登录"}
            </Button>
          </motion.div>
        </div>

        <div className="py-3.5 text-center sm:py-4">
          <p className="text-xs text-faint sm:text-sm">
            {authConfig.demoAuth
              ? "演示环境，登录密码由部署方提供"
              : "登录凭据由工作区管理员提供"}
          </p>
        </div>
      </motion.form>
    </div>
  )
}
