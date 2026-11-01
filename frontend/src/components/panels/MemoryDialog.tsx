import { useEffect, useRef, useState } from "react"

import { Alert } from "../arc/alert/alert"
import { Button } from "../arc/button/button"
import { Dialog, DialogClose, DialogContent } from "../arc/dialog/dialog"
import { Textarea } from "../arc/textarea/textarea"
import { formatMemoryUpdatedAt } from "../../lib/memory"
import { useAppShell } from "../../runtime/AppShellContext"
import { useMemoryApi } from "../../runtime/MemoryContext"
import type { MemorySections } from "../../lib/api"

/** Mirrors MEMORY_PROFILE_LIMITS.maxSectionChars on the server. */
const MAX_SECTION_CHARS = 800

const SECTION_FIELDS: Array<{
  key: keyof MemorySections
  label: string
  placeholder: string
  rows: number
}> = [
  {
    key: "workBackground",
    label: "工作背景",
    placeholder: "职业、行业、职责、项目与技术栈…",
    rows: 4,
  },
  {
    key: "personalBackground",
    label: "个人背景",
    placeholder: "称呼、语言、表达偏好与长期习惯…",
    rows: 4,
  },
  {
    key: "recentActivity",
    label: "近期动态",
    placeholder: "最近关注的事项与正在进行的任务…",
    rows: 3,
  },
]

const EMPTY_DRAFT: MemorySections = {
  workBackground: "",
  personalBackground: "",
  recentActivity: "",
}

export function MemoryDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const { profile, loaded, failed, refresh, save, reset } = useMemoryApi()
  const { showToast } = useAppShell()
  const [draft, setDraft] = useState<MemorySections>({
    workBackground: profile.workBackground,
    personalBackground: profile.personalBackground,
    recentActivity: profile.recentActivity,
  })
  const [busy, setBusy] = useState(false)
  const [confirmingReset, setConfirmingReset] = useState(false)
  const returnFocus = useRef<HTMLElement | null>(null)

  // A profile refreshed in the background (a new session finished summarizing)
  // must be re-read when the panel opens, not shown stale.
  useEffect(() => {
    if (!open) return
    void refresh()
  }, [open, refresh])

  useEffect(() => {
    // A background refresh must never overwrite text the owner is typing.
    setDraft((current) => {
      const dirtyNow =
        current.workBackground !== profile.workBackground ||
        current.personalBackground !== profile.personalBackground ||
        current.recentActivity !== profile.recentActivity
      return dirtyNow
        ? current
        : {
            workBackground: profile.workBackground,
            personalBackground: profile.personalBackground,
            recentActivity: profile.recentActivity,
          }
    })
  }, [profile])

  const dirty =
    draft.workBackground !== profile.workBackground ||
    draft.personalBackground !== profile.personalBackground ||
    draft.recentActivity !== profile.recentActivity

  const handleSave = async () => {
    if (!dirty || busy) return
    setBusy(true)
    try {
      await save(draft)
      showToast("已保存长期记忆")
    } catch (error) {
      showToast(error instanceof Error ? error.message : "长期记忆保存失败")
    } finally {
      setBusy(false)
    }
  }

  const handleReset = async () => {
    try {
      await reset()
      setDraft(EMPTY_DRAFT)
      showToast("已重置长期记忆")
    } catch (error) {
      showToast(error instanceof Error ? error.message : "长期记忆重置失败")
    } finally {
      setBusy(false)
      setConfirmingReset(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return
        setConfirmingReset(false)
        onClose()
      }}
    >
      <DialogContent
        title="长期记忆"
        description="新建对话时会自动总结上一段会话，画像在这里逐步成形。你也可以直接编辑。"
        closeLabel="关闭长期记忆"
        onOpenAutoFocus={() => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const target = returnFocus.current
          if (target?.isConnected) target.focus()
        }}
      >
        {!loaded ? (
          <p className="text-sm text-faint">正在读取长期记忆…</p>
        ) : null}
        {failed ? (
          <Alert tone="danger" title="长期记忆读取失败" className="mb-5">
            请稍后重试。
          </Alert>
        ) : null}
        <div className="grid gap-5">
          {SECTION_FIELDS.map((field) => (
            <Textarea
              key={field.key}
              label={field.label}
              value={draft[field.key]}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  [field.key]: event.target.value,
                }))
              }
              rows={field.rows}
              maxLength={MAX_SECTION_CHARS}
              placeholder={field.placeholder}
            />
          ))}
        </div>
        <div className="mt-6 flex items-center justify-between gap-3">
          <Button
            variant="danger"
            size="sm"
            type="button"
            disabled={busy}
            onClick={() => setConfirmingReset(true)}
          >
            重置
          </Button>
          <div className="flex items-center gap-3">
            {profile.updatedAt ? (
              <span className="text-xs text-faint">
                更新于 {formatMemoryUpdatedAt(profile.updatedAt)}
              </span>
            ) : null}
            <Button
              variant="primary"
              size="sm"
              type="button"
              loading={busy}
              disabled={!dirty}
              onClick={() => void handleSave()}
            >
              保存
            </Button>
          </div>
        </div>
      </DialogContent>

      {/* Confirm with a custom cancel: the official Arc composition, with the
          cancel wrapped in DialogClose and the destructive action in the body. */}
      <Dialog
        open={confirmingReset}
        onOpenChange={(next) => {
          if (!next && !busy) setConfirmingReset(false)
        }}
      >
        <DialogContent
          title="重置长期记忆"
          description="工作背景、个人背景和近期动态将被清空，此操作不可恢复。"
          closeLabel="关闭重置确认"
        >
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="secondary" size="sm" type="button" disabled={busy}>
                取消
              </Button>
            </DialogClose>
            <Button
              variant="danger"
              size="sm"
              type="button"
              loading={busy}
              onClick={() => void handleReset()}
            >
              重置
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Dialog>
  )
}
