import { useState } from "react"
import { motion, useReducedMotion } from "motion/react"
import {
  InvalidCredentialsError,
  RegistrationError,
  registerAccount,
  type AuthConfigPayload,
} from "../lib/api"
import { PasswordField } from "./arc/password-field/password-field"
import { Input } from "./arc/input/input"
import { Alert } from "./arc/alert/alert"
import SegmentedControl from "./arc/segmented-control/segmented-control"
import { Button } from "./ui/Button"
import { motionTokens } from "./arc/lib/motion-tokens"

interface LoginScreenProps {
  authConfig: AuthConfigPayload
  onSignIn: (id: string, password: string) => Promise<void>
}

type Mode = "signin" | "register"

interface FieldError {
  field: "id" | "password"
  message: string
}

export function LoginScreen({ authConfig, onSignIn }: LoginScreenProps) {
  const [mode, setMode] = useState<Mode>("signin")
  const [id, setId] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<FieldError | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const reduced = useReducedMotion()
  const { duration, ease, blur, spring } = motionTokens

  const idMaxLength = authConfig.idMaxLength || 5
  const passwordLength = authConfig.passwordLength || 8
  const registering = mode === "register"

  const clearMessages = () => {
    setError(null)
    setFieldError(null)
  }

  const changeMode = (next: string) => {
    if (next !== "signin" && next !== "register") return
    setMode(next)
    setPassword("")
    clearMessages()
    if (next === "register") setNotice(null)
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const accountId = id.trim()
    if (!accountId || !password || pending) return
    setPending(true)
    clearMessages()
    setNotice(null)
    try {
      if (registering) {
        if ([...password].length !== passwordLength) {
          setFieldError({
            field: "password",
            message: `密码必须是 ${passwordLength} 位`,
          })
          return
        }
        await registerAccount(accountId, password)
        setMode("signin")
        setPassword("")
        setNotice("请使用新账号的 ID 与密码登录")
        return
      }
      await onSignIn(accountId, password)
    } catch (cause) {
      if (registering && cause instanceof RegistrationError) {
        const field =
          cause.code === "invalid_password"
            ? "password"
            : cause.code === "invalid_id" || cause.code === "id_taken"
              ? "id"
              : null
        if (field) {
          setFieldError({ field, message: cause.message })
          return
        }
      }
      setError(
        cause instanceof InvalidCredentialsError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : registering
              ? "注册失败"
              : "登录失败",
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-canvas p-5">
      <motion.form
        onSubmit={submit}
        aria-label={registering ? "注册账号" : "登录"}
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
            {registering ? "注册账号" : "登录 NexusWiki"}
          </h1>
          <p className="mt-1.5 text-sm text-faint sm:text-base">
            {registering ? "注册后即可用 ID 与密码登录" : "使用账号 ID 与密码进入工作区"}
          </p>

          {authConfig.registration ? (
            <SegmentedControl
              className="mt-6 w-full sm:mt-7 [&>div]:w-full [&_button]:flex-1"
              label="登录或注册"
              options={[
                { value: "signin", label: "登录" },
                { value: "register", label: "注册" },
              ]}
              value={mode}
              onValueChange={changeMode}
              disabled={pending}
            />
          ) : null}

          <div className="mt-5 flex flex-col gap-4 sm:mt-6">
            <Input
              id="login-id"
              label="账号 ID"
              placeholder="例如：小明"
              value={id}
              maxLength={idMaxLength}
              autoComplete="username"
              autoFocus
              disabled={pending}
              error={fieldError?.field === "id" ? fieldError.message : undefined}
              onChange={(event) => {
                setId(event.target.value)
                clearMessages()
              }}
              description={`最多 ${idMaxLength} 个字符，支持中英文`}
            />

            <div>
              <PasswordField
                id="login-password"
                label="密码"
                value={password}
                maxLength={registering ? passwordLength : 64}
                onChange={(event) => {
                  setPassword(event.target.value)
                  clearMessages()
                }}
                autoComplete={registering ? "new-password" : "current-password"}
                disabled={pending}
                aria-invalid={fieldError?.field === "password"}
                description={
                  registering ? `${passwordLength} 位，区分大小写` : undefined
                }
                messages={{
                  showPassword: "显示密码",
                  hidePassword: "隐藏密码",
                }}
              />
              {fieldError?.field === "password" ? (
                <p role="alert" className="pt-1 text-xs text-danger">
                  {fieldError.message}
                </p>
              ) : null}
            </div>
          </div>

          {notice ? (
            <Alert tone="success" title="注册成功" className="mt-4">
              {notice}
            </Alert>
          ) : null}

          {error ? (
            <Alert tone="danger" title={registering ? "注册失败" : "登录失败"} className="mt-4">
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
              disabled={!id.trim() || !password}
              className="h-11 w-full text-base"
            >
              {pending
                ? registering
                  ? "注册中…"
                  : "登录中…"
                : registering
                  ? "注册"
                  : "登录"}
            </Button>
          </motion.div>
        </div>

        <div className="py-3.5 text-center sm:py-4">
          <p className="text-xs text-faint sm:text-sm">
            {authConfig.demoAuth
              ? "管理员使用专属 ID 登录，普通账号注册后即可使用"
              : "登录凭据由工作区管理员提供"}
          </p>
        </div>
      </motion.form>
    </div>
  )
}
