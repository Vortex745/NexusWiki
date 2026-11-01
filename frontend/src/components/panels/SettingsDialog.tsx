import { Alert } from "@/components/arc/alert/alert"
import { Card } from "@/components/arc/card/card"
import { Input } from "@/components/arc/input/input"
import { PasswordField } from "@/components/arc/password-field/password-field"
import { Select } from "@/components/arc/select/select"
import { Switch } from "@/components/arc/switch/switch"
import {
  ArrowUpDown,
  Bot,
  CircleCheck,
  Database,
  PlugZap,
  RefreshCw,
  Settings,
} from "../ui/icons"
import { useEffect, useRef, useState } from "react"

import {
  discoverModelProfileModels,
  fetchModelProfileConfig,
  fetchModelProfiles,
  saveModelProfileConfig,
  setModelProfileEnabled,
  testModelProfile,
  type ModelProfileConfigView,
  type ModelProfilePayload,
  type ModelProfileTestResult,
} from "../../lib/api"
import { useAppShell } from "../../runtime/AppShellContext"
import { useSession } from "../../runtime/SessionContext"
import { Icon } from "../ui/Icon"
import { Dialog } from "../ui/Dialog"
import { InlineMessage } from "../ui/containers"
import { Button, EmptyState } from "../ui/Controls"

/**
 * Ticket 16 (MODEL-01A): the model-profile settings workspace. Administrators
 * configure Chat/Embedding/Rerank/TypeSafe slots through server-side writes,
 * inspect non-secret metadata, and run protocol-specific connectivity tests.
 * The TypeSafe toggle immediately selects the decision provider; keys are
 * never returned to the browser.
 */

const KIND_LABEL: Record<ModelProfilePayload["kind"], string> = {
  chat: "对话模型",
  embedding: "嵌入模型",
  rerank: "重排序模型",
  typesafe: "TypeSafe System One",
}

const KIND_ICON: Record<ModelProfilePayload["kind"], typeof Bot> = {
  chat: Bot,
  embedding: Database,
  rerank: ArrowUpDown,
  typesafe: Bot,
}

function ProfileCard({
  profile,
  initialConfig,
  busy,
  testing,
  result,
  onTest,
  onToggleDecision,
  onSaved,
}: {
  profile: ModelProfilePayload
  initialConfig: ModelProfileConfigView | null
  busy: boolean
  testing: boolean
  result: ModelProfileTestResult | null
  onTest: (profile: ModelProfilePayload) => void
  onToggleDecision: (profile: ModelProfilePayload, enabled: boolean) => void
  onSaved: (config: ModelProfileConfigView) => void
}) {
  const state = profile.configured ? "已配置" : "未配置"

  return (
    <Card
      title={KIND_LABEL[profile.kind]}
      description={
        profile.configured
          ? `${profile.source === "workspace" ? "本工作区" : "服务端"}地址 ${profile.baseUrlHost}${
              profile.kind === "embedding" && profile.dimensions
                ? ` · 向量维度 ${profile.dimensions}`
                : ""
            }`
          : "尚未保存配置"
      }
      media={
        // The icon holds the top-left corner: the quick look's close button
        // lands on the top-right of this same cover.
        <div
          className="flex h-28 w-full flex-col justify-between p-5"
          style={{ backgroundImage: "var(--arc-gradient)" }}
        >
          <span className="grid size-9 place-items-center rounded-full bg-surface/75 text-ink">
            <Icon icon={KIND_ICON[profile.kind]} className="size-4" />
          </span>
          <div className="flex items-end justify-between gap-3">
            <p className="min-w-0 truncate font-mono text-xs text-[var(--arc-gradient-foreground)]">
              {profile.model}
            </p>
            <span className="flex-none rounded-full bg-surface/75 px-2.5 py-1 text-[10px] leading-none font-medium text-ink">
              {state}
            </span>
          </div>
        </div>
      }
      details={
        <ProfileConfigForm
          profile={profile}
          initialConfig={initialConfig}
          onSaved={onSaved}
        />
      }
    >
      <div className="relative z-[1] mt-5 flex flex-wrap items-center justify-between gap-3">
        {profile.kind === "typesafe" ? (
          <Switch
            label="TypeSafe 决策模型"
            checked={profile.enabled}
            disabled={busy}
            onCheckedChange={(enabled) => onToggleDecision(profile, enabled)}
          />
        ) : <span />}
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
      {testing ? (
        <p role="status" className="mt-4 text-[11px] text-faint">
          正在测试「{KIND_LABEL[profile.kind]}」…
        </p>
      ) : null}
      {result ? <TestResultLine result={result} /> : null}
    </Card>
  )
}

function TestResultLine({
  result,
  className = "mt-4",
}: {
  result: ModelProfileTestResult
  className?: string
}) {
  if (result.ok) {
    return (
      <p
        role="status"
        className={`${className} flex items-center gap-1.5 text-[11px] text-success`}
      >
        <Icon icon={CircleCheck} className="size-3.5 flex-none" />
        连接正常（{result.latencyMs} ms）
      </p>
    )
  }
  return (
    <Alert
      tone="danger"
      title="发生错误"
      className={`${className} border px-3 py-2.5`}
    >
      <span className="block text-[11px] leading-relaxed">
        {result.error}
      </span>
      {result.hint ? (
        <span className="mt-1 block text-[11px] leading-relaxed">
          {result.hint}
        </span>
      ) : null}
    </Alert>
  )
}

/**
 * The card's quick look: the credentials live in the server `.env`, so the
 * form edits Base URL / model, treats a blank key as "keep the stored one",
 * and verifies the result by discovering models and testing the connection.
 */
function ProfileConfigForm({
  profile,
  initialConfig,
  onSaved,
}: {
  profile: ModelProfilePayload
  initialConfig: ModelProfileConfigView | null
  onSaved: (config: ModelProfileConfigView) => void
}) {
  const [view, setView] = useState<ModelProfileConfigView | null>(
    initialConfig,
  )
  const [baseUrl, setBaseUrl] = useState(initialConfig?.baseUrl ?? "")
  const [model, setModel] = useState(initialConfig?.model ?? "")
  const [dimensions, setDimensions] = useState(
    initialConfig?.dimensions ? String(initialConfig.dimensions) : "",
  )
  const [apiKey, setApiKey] = useState("")
  const [detected, setDetected] = useState<string[]>([])
  const [loading, setLoading] = useState(initialConfig === null)
  const [busy, setBusy] = useState<"detect" | "save" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ModelProfileTestResult | null>(
    null,
  )
  const { showToast } = useAppShell()
  const scrollRef = useRef<HTMLDivElement>(null)
  const discoverable = profile.kind !== "rerank"

  // A tall error (wrapped hint) scrolls inside the fixed frame; keep its last
  // line visible instead of leaving it below the fold.
  useEffect(() => {
    if (!error) return
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [error])

  useEffect(() => {
    // Prefetched when the dialog opened: render the form on the first frame so
    // the quick look never resizes mid-morph.
    if (initialConfig) return
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchModelProfileConfig(profile.id)
      .then((config) => {
        if (cancelled) return
        setView(config)
        setBaseUrl(config.baseUrl)
        setModel(config.model)
        setDimensions(config.dimensions ? String(config.dimensions) : "")
        setDetected([])
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "配置读取失败")
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [profile.id, initialConfig])

  const handleDetect = async () => {
    const nextBaseUrl = baseUrl.trim()
    if (!/^https?:\/\//i.test(nextBaseUrl)) {
      setError("先填写以 http:// 或 https:// 开头的 Base URL。")
      return
    }
    if (!apiKey.trim() && !view?.hasApiKey) {
      setError("先填写 API Key，检测会用该密钥在服务端请求 /models。")
      return
    }
    setError(null)
    setNotice(null)
    setBusy("detect")
    try {
      const result = await discoverModelProfileModels(profile.id, {
        baseUrl: nextBaseUrl,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })
      if (!result.ok) {
        setError(result.hint ? `${result.error} — ${result.hint}` : result.error)
        return
      }
      setDetected(result.models)
      if (result.models.length === 0) {
        if (profile.kind === "rerank") {
          setNotice("该提供商未公开重排序模型；可直接填写模型名。")
        } else {
          setError("提供商返回了空模型列表。")
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "模型检测失败")
    } finally {
      setBusy(null)
    }
  }

  const handleSave = async () => {
    const nextBaseUrl = baseUrl.trim()
    const nextModel = model.trim()
    if (!/^https?:\/\//i.test(nextBaseUrl)) {
      setError("Base URL 必须以 http:// 或 https:// 开头。")
      return
    }
    if (!nextModel) {
      setError("请选择或填写模型。")
      return
    }
    let nextDimensions: number | undefined
    if (profile.kind === "embedding") {
      const parsed = Number(dimensions)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        setError("请填写嵌入模型的向量维度（可用下方测试读取）。")
        return
      }
      nextDimensions = parsed
    }
    setError(null)
    setNotice(null)
    setTestResult(null)
    setBusy("save")
    try {
      const saved = await saveModelProfileConfig(profile.id, {
        baseUrl: nextBaseUrl,
        model: nextModel,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(nextDimensions !== undefined ? { dimensions: nextDimensions } : {}),
      })
      setView(saved)
      setBaseUrl(saved.baseUrl)
      setModel(saved.model)
      setDimensions(saved.dimensions ? String(saved.dimensions) : "")
      setApiKey("")
      onSaved(saved)
      showToast(`已保存${KIND_LABEL[profile.kind]}「${saved.model}」`)
      // Run the speed probe against the new values.
      setTesting(true)
      try {
        setTestResult(await testModelProfile(profile.id))
      } catch (err) {
        setError(err instanceof Error ? err.message : "测速失败")
      } finally {
        setTesting(false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败")
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    // Reserve the final frame while the config arrives: a shorter placeholder
    // would resize the panel mid-morph and restart the layout animation.
    return (
      <div className="flex h-[500px] max-h-[calc(100dvh-360px)] flex-col">
        <InlineMessage className="py-1 text-left">正在读取配置…</InlineMessage>
      </div>
    )
  }

  const modelOptions = Array.from(
    new Set([model, ...detected].filter(Boolean)),
  ).map((value) => ({ value, label: value }))

  return (
    <div className="flex h-[500px] max-h-[calc(100dvh-360px)] flex-col gap-4">
      <div
        ref={scrollRef}
        className="scrollbar-hidden flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"
      >
        <Input
          label="Base URL"
          description={profile.kind === "typesafe"
            ? "TypeSafe API 根地址，例如 https://api.typesafe.ai"
            : "OpenAI 兼容接口的根地址，例如 https://api.openai.com/v1"}
          value={baseUrl}
          placeholder={profile.kind === "typesafe" ? "https://api.typesafe.ai" : "https://api.openai.com/v1"}
          autoComplete="off"
          spellCheck={false}
          disabled={busy !== null}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
        <PasswordField
          label="API Key"
          description={
            view?.hasApiKey
              ? "已保存密钥；留空保存时保持不变。"
              : "密钥只保存在服务端，不会回传浏览器。"
          }
          messages={{ showPassword: "显示密钥", hidePassword: "隐藏密钥" }}
          value={apiKey}
          placeholder={view?.hasApiKey ? "已保存，留空保持不变" : profile.kind === "typesafe" ? "ts-…" : "sk-…"}
          autoComplete="off"
          spellCheck={false}
          disabled={busy !== null}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <div className="flex flex-wrap items-end justify-between gap-2">
          <p className="text-[11px] leading-relaxed text-faint">
            {detected.length > 0
              ? `已发现 ${detected.length} 个可用${discoverable ? "" : "重排序"}模型`
              : discoverable
                ? "填入密钥后可向提供商查询可用模型"
                : "填入密钥后可向提供商查询可用重排序模型"}
          </p>
          <Button
            size="sm"
            icon={RefreshCw}
            onClick={() => void handleDetect()}
            disabled={busy !== null}
          >
            {busy === "detect" ? "检测中…" : "检测模型"}
          </Button>
        </div>
        {profile.kind === "embedding" ? (
          <Input
            label="向量维度"
            description="索引按该维度建库。点击下方测试可读取提供商返回的真实维度。"
            value={dimensions}
            inputMode="numeric"
            placeholder="例如 1024"
            disabled={busy !== null}
            onChange={(event) => setDimensions(event.target.value)}
          />
        ) : null}
        {discoverable ? (
          <Select
            label="模型"
            options={modelOptions}
            value={model}
            placeholder="先检测或直接填写模型"
            description={
              detected.length > 0
                ? "来自提供商的 /models 列表。"
                : "尚未检测；保存时使用当前值。"
            }
            disabled={busy !== null}
            onValueChange={setModel}
          />
        ) : (
          <>
            <Input
              label="模型"
              description="重排序使用专用协议，可直接填写；检测只列出提供商公开的重排序模型。"
              value={model}
              placeholder="BAAI/bge-reranker-v2-m3"
              autoComplete="off"
              spellCheck={false}
              disabled={busy !== null}
              onChange={(event) => setModel(event.target.value)}
            />
            {detected.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {detected.map((value) => (
                  <Button
                    key={value}
                    size="sm"
                    tone={value === model ? "primary" : "neutral"}
                    disabled={busy !== null}
                    onClick={() => setModel(value)}
                  >
                    {value}
                  </Button>
                ))}
              </div>
            ) : null}
          </>
        )}
        {notice ? (
          <p role="status" className="text-[11px] leading-relaxed text-faint">
            {notice}
          </p>
        ) : null}
        {testing ? (
          <p role="status" className="text-[11px] text-faint">
            正在用新配置测速…
          </p>
        ) : null}
        {testResult ? (
          <TestResultLine result={testResult} className="" />
        ) : null}
        {error ? (
          <Alert tone="danger" title="操作失败" className="border px-3 py-2.5">
            <span className="block text-[11px] leading-relaxed">{error}</span>
          </Alert>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[30ch] text-[11px] leading-relaxed text-faint">
          {profile.kind === "embedding"
            ? "保存后立即创建本工作区的默认知识库与向量索引；已有文档后不可再改模型或维度。"
            : view?.editable === false
              ? "该配置由服务端环境文件管理，此卡片只读。"
              : "保存后立即测速；下一次对话使用新配置。"}
        </p>
        <Button
          tone="primary"
          size="sm"
          onClick={() => void handleSave()}
          disabled={busy !== null}
        >
          {busy === "save" ? "保存中…" : "保存并测速"}
        </Button>
      </div>
    </div>
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
  const { refresh: refreshSession } = useSession()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [profiles, setProfiles] = useState<ModelProfilePayload[]>([])
  const [configs, setConfigs] = useState<
    Record<string, ModelProfileConfigView | null>
  >({})
  const [busy, setBusy] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [results, setResults] = useState<
    Record<string, ModelProfileTestResult>
  >({})

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const { profiles: list } = await fetchModelProfiles()
      setProfiles(list)
      // Warm the forms so opening a card renders it on the first frame
      // instead of swapping a placeholder in mid-morph.
      void Promise.all(
        list.map(async (profile) => {
          const config = await fetchModelProfileConfig(profile.id).catch(
            () => null,
          )
          return [profile.id, config] as const
        }),
      ).then((entries) => setConfigs(Object.fromEntries(entries)))
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

  /** Re-read the cards after a save without unmounting the open quick look. */
  const refreshProfiles = async () => {
    try {
      setProfiles((await fetchModelProfiles()).profiles)
    } catch {
      // A failed refresh keeps the card data the dialog already shows.
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

  const handleToggleDecision = async (profile: ModelProfilePayload, enabled: boolean) => {
    setBusy(true)
    try {
      const updated = await setModelProfileEnabled(profile.id, enabled)
      setProfiles((previous) => previous.map((item) => item.id === updated.id ? updated : item))
      showToast(enabled ? "已启用 TypeSafe 决策模型" : "已切换到主 LLM Judge")
    } catch (err) {
      showToast(err instanceof Error ? err.message : "决策模型切换失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="模型设置"
      titleId="settings-title"
      bodyClassName="scrollbar-hidden"
    >
      {loading ? (
        <InlineMessage>正在加载模型配置…</InlineMessage>
      ) : error ? (
        <Alert tone="danger" title="发生错误" className="border p-3">

            <p className="text-xs text-danger">模型配置读取失败：{error}</p>
            <Button size="sm" className="mt-2" onClick={() => void load()}>
              重试
            </Button>

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
          <div className="mx-auto flex w-full max-w-[520px] flex-col gap-4">
            <p className="text-[11px] leading-relaxed text-faint">
              点击卡片配置 Base URL、API Key 与模型；私有工作区保存到自己账号，服务端配置只读，密钥不会回传浏览器。
            </p>
            <div className="flex flex-col gap-4">
              {profiles.map((profile) => (
                <ProfileCard
                  key={profile.id}
                  profile={profile}
                  initialConfig={configs[profile.id] ?? null}
                  busy={busy}
                  testing={testingId === profile.id}
                  result={results[profile.id] ?? null}
                  onTest={(target) => void handleTest(target)}
                  onToggleDecision={(target, enabled) => void handleToggleDecision(target, enabled)}
                  onSaved={(saved) => {
                    setConfigs((previous) => ({
                      ...previous,
                      [profile.id]: saved,
                    }))
                    void refreshProfiles()
                    // The import intercept reads this flag from /api/session;
                    // refresh it so a just-configured workspace can import.
                    if (profile.id === "embedding") void refreshSession()
                  }}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </Dialog>
  )
}
