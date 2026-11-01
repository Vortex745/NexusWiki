import { useEffect, useRef, useState } from "react"

import { Button as UiButton } from "../ui/Button"
import { ConfirmDialog, Dialog } from "../ui/Dialog"
import { Input } from "../arc/input/input"
import {
  SortableDataTable,
  type DataColumn,
} from "../arc/sortable-data-table/sortable-data-table"
import { Icon } from "../ui/Icon"
import { Search, Users } from "../ui/icons"
import { EmptyState, Select, TextInput } from "../ui/Controls"
import { useAppShell } from "../../runtime/AppShellContext"
import { formatLastLogin } from "../../lib/lastLogin"
import {
  fetchAdminUsers,
  resetUserPassword,
  setUserDisabled,
  type AdminUserItem,
  type AdminUsersPage,
} from "../../lib/adminApi"

/**
 * AC-03/04/05 (admin console): the operator's user directory.
 *
 * Everything on screen comes from `GET /api/admin/users` — server-side
 * paging, case-insensitive ID search, status filter, newest first. The
 * console holds no local copy of the registry: every action re-reads the
 * current view, so the table can never drift from what the server enforces.
 * Disabling asks first (one dialog, one account); enabling is a direct
 * action; a reset always goes through a typed confirmation with the same
 * eight-character rule the server enforces. The table itself is Arc's
 * SortableDataTable: sorting runs client-side over the page the server
 * returned (paging and the newest-first default stay server-owned), and the
 * columns only add presentation, never a second source of truth.
 */

type DirectoryRow = {
  id: string
  displayId: string
  createdAt: string
  lastLoginAt: string | null
  disabledAt: string | null
  status: "启用" | "已禁用"
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "从未登录"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function UserDirectory() {
  const { showToast } = useAppShell()
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<"all" | "active" | "disabled">("all")
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<AdminUsersPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  // AC-04: exactly one pending mutation, and one disable awaiting its
  // confirmation. Closing the dialog never fires the request.
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmDisable, setConfirmDisable] = useState<AdminUserItem | null>(null)
  // AC-05: the reset dialog owns its own draft password, error text and
  // busy flag — the server's contract (exactly 8 characters) is mirrored
  // here only so the confirm button can't fire a doomed request.
  const [resetTarget, setResetTarget] = useState<AdminUserItem | null>(null)
  const [resetDraft, setResetDraft] = useState("")
  const [resetError, setResetError] = useState<string | null>(null)
  const [resetBusy, setResetBusy] = useState(false)
  // The search box debounces: typing never fires one request per keystroke,
  // and every accepted query resets paging to the first page.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [debouncedQuery, setDebouncedQuery] = useState("")

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(query.trim())
      setPage(1)
    }, 250)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchAdminUsers({
      ...(debouncedQuery ? { q: debouncedQuery } : {}),
      status,
      page,
      pageSize: 20,
    })
      .then((payload) => {
        if (!cancelled) setResult(payload)
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "读取用户目录失败")
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [debouncedQuery, status, page, reloadToken])

  const mutateDisabled = async (row: AdminUserItem, disabled: boolean) => {
    setBusyId(row.id)
    try {
      const fresh = await setUserDisabled(row.id, disabled)
      showToast(disabled ? `已禁用「${fresh.displayId}」` : `已启用「${fresh.displayId}」`)
      // The server is the source: re-read the current view instead of
      // patching a local row.
      setReloadToken((token) => token + 1)
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "操作失败", "error")
    } finally {
      setBusyId(null)
    }
  }

  const submitPasswordReset = async () => {
    if (!resetTarget) return
    setResetBusy(true)
    setResetError(null)
    try {
      await resetUserPassword(resetTarget.id, resetDraft)
      showToast(`已重置「${resetTarget.displayId}」的密码，旧密码立即失效`)
      setResetTarget(null)
      setResetDraft("")
    } catch (reason) {
      setResetError(reason instanceof Error ? reason.message : "重置密码失败")
    } finally {
      setResetBusy(false)
    }
  }

  const users = result?.items ?? []
  const rows: DirectoryRow[] = users.map((user) => ({
    ...user,
    status: user.disabledAt ? "已禁用" : "启用",
  }))
  const total = result?.total ?? 0
  const pageSize = result?.pageSize ?? 20
  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  const columns: DataColumn<DirectoryRow>[] = [
    {
      key: "displayId",
      label: "账号",
      render: (value) => <span className="font-medium">{String(value)}</span>,
    },
    {
      key: "createdAt",
      label: "创建时间",
      render: (value) => <span className="text-faint">{formatDateTime(String(value))}</span>,
    },
    {
      key: "lastLoginAt",
      label: "最近登录",
      render: (value) => (
        <span className="text-faint">{formatLastLogin(value as string | null)}</span>
      ),
    },
    {
      key: "status",
      label: "状态",
      render: (_value, row) =>
        row.disabledAt ? <span className="text-danger">已禁用</span> : <span>启用</span>,
    },
    {
      key: "actions",
      label: "操作",
      sortable: false,
      // The first button's 10px inset is cancelled so its label lines up with
      // the column header at the cell's padding edge.
      render: (_value, row) => (
        <span className="-ml-2.5 inline-flex items-center gap-1">
          {row.disabledAt ? (
            <UiButton
              variant="ghost"
              size="sm"
              type="button"
              disabled={busyId === row.id}
              onClick={() => void mutateDisabled(row, false)}
              title="恢复该账号的登录"
            >
              启用
            </UiButton>
          ) : (
            <>
              <UiButton
                variant="ghost"
                size="sm"
                type="button"
                disabled={busyId === row.id}
                onClick={() => {
                  setResetDraft("")
                  setResetError(null)
                  setResetTarget(row)
                }}
                title="为该账号设置新密码（恰好 8 位）"
              >
                重置密码
              </UiButton>
              <UiButton
                variant="ghost"
                size="sm"
                type="button"
                disabled={busyId === row.id}
                onClick={() => setConfirmDisable(row)}
                className="text-danger"
                title="禁用后该账号将无法登录"
              >
                禁用
              </UiButton>
            </>
          )}
        </span>
      ),
    },
  ]

  return (
    <section aria-label="用户目录" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">用户目录</h2>
        <div className="flex min-w-0 items-center gap-2">
          <Select
            aria-label="按状态筛选"
            value={status}
            onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
              setStatus(event.target.value as "all" | "active" | "disabled")
              setPage(1)
            }}
            wrapperClassName="w-28 flex-none"
            size="sm"
          >
            <option value="all">全部状态</option>
            <option value="active">启用</option>
            <option value="disabled">已禁用</option>
          </Select>
          <div className="relative w-56 max-w-full">
            <Input
              aria-label="按账号 ID 搜索"
              placeholder="搜索账号 ID"
              value={query}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                setQuery(event.target.value)
              }
              className="h-8 pr-8 text-[0.8rem]"
            />
            <Icon
              icon={Search}
              className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-faint"
            />
          </div>
        </div>
      </div>

      {error ? (
        <div className="flex items-center justify-between rounded-[12px] border border-line bg-surface-subtle px-3 py-2 text-xs text-danger">
          <span>用户目录读取失败：{error}</span>
          <UiButton
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => setReloadToken((token) => token + 1)}
          >
            重试
          </UiButton>
        </div>
      ) : loading && rows.length === 0 ? (
        <p className="py-6 text-center text-xs text-faint">正在读取用户目录…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Users}
          message={debouncedQuery ? "没有匹配的账号" : "还没有注册账号"}
        />
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <SortableDataTable
              rows={rows}
              columns={columns}
              rowKey="id"
              caption="用户目录"
              defaultSort={{ key: "createdAt", direction: "desc" }}
              sortLabel={(label, direction) =>
                direction
                  ? `按${label}排序，当前${direction === "asc" ? "升序" : "降序"}`
                  : `按${label}排序`
              }
              sortAnnouncement={(label, direction) =>
                `已按${label}${direction === "asc" ? "升序" : "降序"}排列`
              }
            />
            {loading ? (
              <p className="px-1 text-[11px] text-faint" role="status">
                正在刷新…
              </p>
            ) : null}
          </div>
          <div className="flex items-center justify-between text-xs text-faint">
            <span>共 {total} 个账号</span>
            <div className="flex items-center gap-1">
              <UiButton
                variant="ghost"
                size="sm"
                type="button"
                disabled={page <= 1 || loading}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                上一页
              </UiButton>
              <span className="px-1 tabular-nums">
                {page} / {pageCount}
              </span>
              <UiButton
                variant="ghost"
                size="sm"
                type="button"
                disabled={page >= pageCount || loading}
                onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
              >
                下一页
              </UiButton>
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmDisable !== null}
        onClose={() => setConfirmDisable(null)}
        title={confirmDisable ? `禁用「${confirmDisable.displayId}」` : "禁用账号"}
        titleId="admin-disable-user-title"
        confirmLabel="确认禁用"
        busy={busyId !== null}
        onConfirm={async () => {
          if (!confirmDisable) return
          const row = confirmDisable
          setConfirmDisable(null)
          await mutateDisabled(row, true)
        }}
      >
        <p>
          禁用后该账号无法再登录，但它的工作区、文档、对话和知识库都原样保留，随时可以重新启用。
        </p>
      </ConfirmDialog>

      <Dialog
        open={resetTarget !== null}
        onClose={() => {
          if (resetBusy) return
          setResetTarget(null)
          setResetDraft("")
          setResetError(null)
        }}
        title={resetTarget ? `重置「${resetTarget.displayId}」的密码` : "重置密码"}
        titleId="admin-reset-password-title"
        tier="confirm"
        footer={
          <div className="flex justify-end gap-2">
            <UiButton
              variant="outline"
              size="sm"
              disabled={resetBusy}
              onClick={() => {
                setResetTarget(null)
                setResetDraft("")
                setResetError(null)
              }}
            >
              取消
            </UiButton>
            <UiButton
              size="sm"
              disabled={resetBusy || resetDraft.length !== 8}
              onClick={() => void submitPasswordReset()}
            >
              确认重置
            </UiButton>
          </div>
        }
      >
        <p className="text-xs text-faint">
          新密码恰好 8 位、区分大小写。保存后旧密码立即失效，请把新密码告知该账号的使用者。
        </p>
        <TextInput
          aria-label="新密码"
          type="password"
          autoFocus
          disabled={resetBusy}
          value={resetDraft}
          maxLength={8}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
            setResetDraft(event.target.value)
            setResetError(null)
          }}
          onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
            if (event.key === "Enter" && resetDraft.length === 8 && !resetBusy) {
              event.preventDefault()
              void submitPasswordReset()
            }
          }}
          placeholder="恰好 8 位"
        />
        {resetError ? <p className="text-xs text-danger">{resetError}</p> : null}
      </Dialog>
    </section>
  )
}
