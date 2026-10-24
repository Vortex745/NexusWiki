import { Alert, AlertDescription } from "@/components/primitives/alert"
import { CircleCheck, CircleX, PlugZap, Settings } from "../ui/icons"
import { useEffect, useState } from "react"

import {
  fetchModelProfiles,
  setModelProfileEnabled,
  testModelProfile,
  type ModelProfilePayload,
  type ModelProfileTestResult,
} from "../../lib/api"
import { useAppShell } from "../../runtime/AppShellContext"
import { Icon } from "../ui/Icon"
import { Dialog } from "../ui/Dialog"
import { Button, EmptyState, StatusBadge } from "../ui/Controls"

/**
 * Ticket 16 (MODEL-01A): the model-profile settings workspace. Administrators
 * inspect the server's Chat/Embedding/Rerank credential slots as non-secret
 * metadata only, toggle whether a profile may be selected, and run a
 * protocol-specific connectivity test. The server never accepts keys or
 * endpoints here and never writes environment files — a toggle only flips a
 * persisted flag, so the browser can never change what the process calls.
 */

const KIND_LABEL: Record<ModelProfilePayload["kind"], string> = {
  chat: "对话模型",
  embedding: "嵌入模型",
  rerank: "重排序模型",
}

function ProfileRow({
  profile,
  busy,
  testing,
  result,
  onToggle,
  onTest,
}: {
  profile: ModelProfilePayload
  busy: boolean
  testing: boolean
  result: ModelProfileTestResult | null
  onToggle: (profile: ModelProfilePayload, enabled: boolean) => void
  onTest: (profile: ModelProfilePayload) => void
}) {
  return (
    <li className="rounded-[10px] border border-line px-3 py-2.5 transition-colors hover:border-muted-foreground/40">
      <div className="flex items-center gap-3 max-md:flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-ink">
              {KIND_LABEL[profile.kind]}
            </span>
            <span className="rounded-full border border-line bg-surface-subtle px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {profile.model}
            </span>
            {profile.configured ? (
              <StatusBadge>已配置</StatusBadge>
            ) : (
              <StatusBadge tone="warning">未配置</StatusBadge>
            )}
            {profile.enabled ? (
              <StatusBadge tone="success">已启用</StatusBadge>
            ) : (
              <StatusBadge>已停用</StatusBadge>
            )}
          </div>
          <p className="mt-1 truncate text-[11px] text-muted-foreground">
            服务端地址 {profile.baseUrlHost}
            {profile.kind === "embedding" && profile.dimensions
              ? ` · 向量维度 ${profile.dimensions}`
              : ""}
          </p>
        </div>
        <div className="flex flex-none items-center gap-1.5 max-md:w-full max-md:justify-end">
          {profile.enabled ? (
            <Button
              size="sm"
              onClick={() => onToggle(profile, false)}
              disabled={busy}
              title="停用后无法通过任何请求选择该模型配置"
            >
              停用
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => onToggle(profile, true)}
              disabled={busy || !profile.configured}
              title={
                profile.configured
                  ? "重新允许选择该配置"
                  : "先在服务器环境配置凭据后才能启用"
              }
            >
              启用
            </Button>
          )}
          <Button
            size="sm"
            tone="primary"
            icon={PlugZap}
            onClick={() => onTest(profile)}
            disabled={busy}
            title="按该配置自身的协议做一次连通性测试"
          >
            测试连接
          </Button>
        </div>
      </div>
      {testing ? (
        <p role="status" className="mt-2 text-[11px] text-muted-foreground">
          正在测试「{KIND_LABEL[profile.kind]}」…
        </p>
      ) : null}
      {result ? <TestResultLine result={result} /> : null}
    </li>
  )
}

function TestResultLine({ result }: { result: ModelProfileTestResult }) {
  if (result.ok) {
    return (
      <p
        role="status"
        className="mt-2 flex items-center gap-1.5 text-[11px] text-success"
      >
        <Icon icon={CircleCheck} className="size-3.5 flex-none" />
        连接正常（{result.latencyMs} ms）
      </p>
    )
  }
  return (
    <Alert
      variant="destructive"
      role="alert"
      className="mt-2 border px-2.5 py-2"
    >
      <AlertDescription>
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-danger">
          <Icon icon={CircleX} className="size-3.5 flex-none" />
          {result.error}
        </p>
        {result.hint ? (
          <p className="mt-1 pl-5 text-[11px] leading-relaxed text-danger">
            {result.hint}
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

export function SettingsDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const { showToast } = useAppShell()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [profiles, setProfiles] = useState<ModelProfilePayload[]>([])
  const [busy, setBusy] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [results, setResults] = useState<
    Record<string, ModelProfileTestResult>
  >({})

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setProfiles(await fetchModelProfiles())
    } catch (err) {
      setError(err instanceof Error ? err.message : "模型配置读取失败")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const handleToggle = async (
    profile: ModelProfilePayload,
    enabled: boolean,
  ) => {
    setBusy(true)
    try {
      const updated = await setModelProfileEnabled(profile.id, enabled)
      setProfiles((previous) =>
        previous.map((p) => (p.id === profile.id ? updated : p)),
      )
      showToast(
        enabled
          ? `「${KIND_LABEL[profile.kind]}」已启用`
          : `「${KIND_LABEL[profile.kind]}」已停用`,
      )
    } catch (err) {
      showToast(err instanceof Error ? err.message : "操作失败")
    } finally {
      setBusy(false)
    }
  }

  const handleTest = async (profile: ModelProfilePayload) => {
    setBusy(true)
    setTestingId(profile.id)
    setResults((previous) => {
      const next = { ...previous }
      delete next[profile.id]
      return next
    })
    try {
      const result = await testModelProfile(profile.id)
      setResults((previous) => ({ ...previous, [profile.id]: result }))
    } catch (err) {
      showToast(err instanceof Error ? err.message : "测试失败")
    } finally {
      setBusy(false)
      setTestingId(null)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="模型设置"
      titleId="settings-title"
      icon={Settings}
    >
      {loading ? (
        <p className="px-1 py-6 text-center text-xs text-muted-foreground">
          正在加载模型配置…
        </p>
      ) : error ? (
        <Alert variant="destructive" role="alert" className="border p-3">
          <AlertDescription>
            <p className="text-xs text-danger">模型配置读取失败：{error}</p>
            <Button size="sm" className="mt-2" onClick={() => void load()}>
              重试
            </Button>
          </AlertDescription>
        </Alert>
      ) : profiles.length === 0 ? (
        <EmptyState
          icon={Settings}
          message="服务器没有暴露任何模型配置。要添加凭据请改服务端环境变量。"
        />
      ) : (
        <>
          {/* One line for the whole dialog. It used to be repeated verbatim inside
              every profile row, three times over. */}
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            凭据保存在服务器环境变量中，此处只显示非敏感信息；测试在服务端执行，密钥永不下发。
          </p>
          <ul className="flex flex-col gap-2">
            {profiles.map((profile) => (
              <ProfileRow
                key={profile.id}
                profile={profile}
                busy={busy}
                testing={testingId === profile.id}
                result={results[profile.id] ?? null}
                onToggle={(target, enabled) =>
                  void handleToggle(target, enabled)
                }
                onTest={(target) => void handleTest(target)}
              />
            ))}
          </ul>
        </>
      )}
    </Dialog>
  )
}
