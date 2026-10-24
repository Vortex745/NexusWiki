import { useState } from "react"
import { InvalidCredentialsError, type AuthConfigPayload } from "../lib/api"
import { Card } from "./arc/card/card"
import SegmentedControl from "./arc/segmented-control/segmented-control"
import { PasswordField } from "./arc/password-field/password-field"
import { Button } from "./primitives/button"
import { Alert, AlertDescription } from "./primitives/alert"

interface LoginScreenProps {
  authConfig: AuthConfigPayload
  onSignIn: (account: string, password: string) => Promise<void>
}

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
            : "登录失败",
      )
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="grid min-h-dvh place-items-center bg-background p-5">
      <form onSubmit={submit} aria-label="登录" className="w-full max-w-sm">
        <Card title="NexusWiki" description="登录您的知识工作区">
          <div className="mt-5 flex flex-col gap-4">
            <SegmentedControl
              label="账号"
              value={account}
              onValueChange={setAccount}
              disabled={pending}
              options={authConfig.accounts.map((entry) => ({
                value: entry.key,
                label: entry.label,
              }))}
            />
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
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <Button
              type="submit"
              loading={pending}
              disabled={!account}
              className="w-full"
            >
              {pending ? "登录中…" : "登录"}
            </Button>
          </div>
        </Card>
      </form>
    </div>
  )
}
