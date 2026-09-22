import { CircleCheck, CircleX, PlugZap, Settings, X } from "lucide"
import { useEffect, useRef, useState } from "react"

import { Icon } from "../ui/Icon"
import { useAppShell } from "../../runtime/AppShellContext"
import {
  fetchModelProfiles,
  setModelProfileEnabled,
  testModelProfile,
  type ModelProfilePayload,
  type ModelProfileTestResult,
} from "../../lib/api"

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
    <li className="rounded-lg border border-line px-3 py-2.5 max-md:flex-wrap">
      <div className="flex items-center gap-3 max-md:flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-ink">{KIND_LABEL[profile.kind]}</span>
            <span className="rounded-full border border-line bg-surface-subtle px-1.5 py-0.5 font-mono text-[10px] text-muted">
              {profile.model}
            </span>
            {profile.configured ? (
              <span className="rounded-full border border-brand-line bg-brand-subtle px-1.5 py-0.5 font-mono text-[10px] text-brand">
                已配置
              </span>
            ) : (
              <span className="rounded-full border border-line bg-surface-subtle px-1.5 py-0.5 font-mono text-[10px] text-muted">
                未配置
              </span>
            )}
            {profile.enabled ? (
              <span className="rounded-full border border-brand-line bg-brand-subtle px-1.5 py-0.5 font-mono text-[10px] text-brand">
                已启用
              </span>
            ) : (
              <span className="rounded-full border border-line bg-surface-subtle px-1.5 py-0.5 font-mono text-[10px] text-muted">
                已停用
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted/80">
            服务端地址 {profile.baseUrlHost}
            {profile.kind === "embedding" && profile.dimensions
              ? ` · 向量维度 ${profile.dimensions}`
              : ""}
          </p>
        </div>
        <div className="flex flex-none items-center gap-1.5 max-md:w-full max-md:justify-end">
          {profile.enabled ? (
            <button
              type="button"
              onClick={() => onToggle(profile, false)}
              disabled={busy}
              title="停用后无法通过任何请求选择该模型配置"
              className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs text-muted transition-colors hover:bg-surface-subtle hover:text-ink active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              停用
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onToggle(profile, true)}
              disabled={busy || !profile.configured}
              title={profile.configured ? "重新允许选择该配置" : "先在服务器环境配置凭据后才能启用"}
              className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs text-muted transition-colors hover:bg-surface-subtle hover:text-ink active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              启用
            </button>
          )}
          <button
            type="button"
            onClick={() => onTest(profile)}
            disabled={busy}
            title="按该配置自身的协议做一次连通性测试"
            className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-brand px-2.5 text-xs font-medium text-white transition-[colors,transform] duration-150 ease-out hover:bg-brand-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon icon={PlugZap} className="size-3.5" />
            测试连接
          </button>
        </div>
      </div>
      <p className="mt-1.5 text-[10px] leading-relaxed text-muted/60">
        凭据保存在服务器环境变量中，此处只显示非敏感信息；测试在服务端执行，密钥永不下发。
      </p>
      {testing ? (
        <p role="status" className="mt-2 text-[11px] text-muted">
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
      <p role="status" className="mt-2 flex items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-400">
        <Icon icon={CircleCheck} className="size-3.5 flex-none" />
        连接正常（{result.latencyMs} ms）
      </p>
    )
  }
  return (
    <div role="alert" className="mt-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 dark:border-red-900 dark:bg-red-950/40">
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-red-700 dark:text-red-300">
        <Icon icon={CircleX} className="size-3.5 flex-none" />
        {result.error}
      </p>
      {result.hint ? (
        <p className="mt-1 pl-5 text-[11px] leading-relaxed text-red-600/90 dark:text-red-300/80">{result.hint}</p>
      ) : null}
    </div>
  )
}

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { showToast } = useAppShell()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [profiles, setProfiles] = useState<ModelProfilePayload[]>([])
  const [busy, setBusy] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, ModelProfileTestResult>>({})

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

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

  const handleToggle = async (profile: ModelProfilePayload, enabled: boolean) => {
    setBusy(true)
    try {
      const updated = await setModelProfileEnabled(profile.id, enabled)
      setProfiles((previous) => previous.map((p) => (p.id === profile.id ? updated : p)))
      showToast(enabled ? `「${KIND_LABEL[profile.kind]}」已启用` : `「${KIND_LABEL[profile.kind]}」已停用`)
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
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      aria-labelledby="settings-title"
      className="m-auto h-[min(640px,calc(100dvh-48px))] w-[min(620px,calc(100vw-32px))] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-dialog backdrop:bg-black/20 open:grid open:animate-dialog-enter max-md:m-0 max-md:h-dvh max-md:w-screen max-md:rounded-none max-md:border-0"
    >
      <div className="flex h-13 flex-none items-center justify-between border-b border-line px-5 max-md:px-4">
        <div className="flex items-center gap-2">
          <Icon icon={Settings} className="size-4 text-muted" />
          <h2 id="settings-title" className="text-sm font-semibold text-ink">
            模型设置
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭模型设置"
          title="关闭"
          className="grid size-7 flex-none cursor-pointer place-items-center rounded-md text-muted/70 transition-colors hover:bg-surface-subtle hover:text-ink"
        >
          <Icon icon={X} className="size-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-col overflow-y-auto px-5 py-4 max-md:px-4">
        {loading ? (
          <p className="px-1 py-6 text-center text-xs text-muted">正在加载模型配置…</p>
        ) : error ? (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/40">
            <p className="text-xs text-red-700 dark:text-red-300">模型配置读取失败：{error}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-2 cursor-pointer text-xs font-medium text-brand hover:underline"
            >
              重试
            </button>
          </div>
        ) : profiles.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted">服务器没有暴露任何模型配置。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {profiles.map((profile) => (
              <ProfileRow
                key={profile.id}
                profile={profile}
                busy={busy}
                testing={testingId === profile.id}
                result={results[profile.id] ?? null}
                onToggle={(target, enabled) => void handleToggle(target, enabled)}
                onTest={(target) => void handleTest(target)}
              />
            ))}
          </ul>
        )}
      </div>
    </dialog>
  )
}
