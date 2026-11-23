import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

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
  resetUserPassword,
  setUserDisabled,
  type AdminUserItem,
} from "../../lib/adminApi"
import { adminKeys, adminUsersQueryOptions } from "../../lib/queries/admin"

/**
 * AC-03/04/05 (admin console): the operator's user directory.
 *
 * Everything on screen comes from `GET /api/admin/users` — server-side
 * paging, case-insensitive ID search, status filter, newest first. The
 * console holds no local copy of the registry: every action invalidates the
 * cached reads, so the table can never drift from what the server enforces.
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

export function UserDirectory({
  q,
  status,
  page,
  onSearchChange,
  onStatusChange,
  onPageChange,
}: {
  q: string
  status: "all" | "active" | "disabled"
  page: number
  onSearchChange: (q: string) => void
  onStatusChange: (status: "all" | "active" | "disabled") => void
  onPageChange: (page: number) => void
}) {
  const { showToast } = useAppShell()
  const queryClient = useQueryClient()
  const [query, setQuery] = useState(q)
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
  // The search box debounces: typing never fires one request per keystroke,
  // and every accepted query resets paging to the first page.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Back/forward and external search changes flow back into the input.
  useEffect(() => {
    setQuery(q)
  }, [q])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      const next = query.trim()
      if (next !== q) onSearchChange(next)
    }, 250)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, q, onSearchChange])

  const usersQuery = useQuery(
    adminUsersQueryOptions({
      ...(q ? { q } : {}),
      status,
      page,
      pageSize: 20,
    }),
  )

  const disableMutation = useMutation({
    mutationFn: ({ id, disabled }: { id: string; disabled: boolean }) =>
      setUserDisabled(id, disabled),
    onSuccess: (fresh, variables) => {
      showToast(
        variables.disabled
          ? `已禁用「${fresh.displayId}」`
          : `已启用「${fresh.displayId}」`,
      )
      void queryClient.invalidateQueries({ queryKey: adminKeys.all })
    },
    onError: (reason: unknown) => {
      showToast(reason instanceof Error ? reason.message : "操作失败", "error")
    },
  })

  const resetMutation = useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      resetUserPassword(id, password),
    onSuccess: (_result, variables) => {
      showToast(`已重置「${resetTarget?.displayId ?? variables.id}」的密码，旧密码立即失效`)
      setResetTarget(null)
      setResetDraft("")
      void queryClient.invalidateQueries({ queryKey: adminKeys.all })
    },
    onError: (reason: unknown) => {
      setResetError(reason instanceof Error ? reason.message : "重置密码失败")
    },
  })

  const mutateDisabled = async (row: AdminUserItem, disabled: boolean) => {
    setBusyId(row.id)
    try {
      await disableMutation.mutateAsync({ id: row.id, disabled })
    } finally {
      setBusyId(null)
    }
  }

  const submitPasswordReset = async () => {
    if (!resetTarget) return
    setResetError(null)
    try {
      await resetMutation.mutateAsync({ id: resetTarget.id, password: resetDraft })
    } finally {
      // The dialog stays open on failure so the error is visible.
    }
  }

  const users = usersQuery.data?.items ?? []
  const rows: DirectoryRow[] = users.map((user) => ({
    ...user,
    status: user.disabledAt ? "已禁用" : "启用",
  }))
  const total = usersQuery.data?.total ?? 0
  const pageSize = usersQuery.data?.pageSize ?? 20
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const loading = usersQuery.isPending || usersQuery.isFetching
  const error =
    usersQuery.error instanceof Error ? usersQuery.error.message : null

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
              onStatusChange(event.target.value as "all" | "active" | "disabled")
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
            onClick={() => void usersQuery.refetch()}
          >
            重试
          </UiButton>
        </div>
      ) : loading && rows.length === 0 ? (
        <p className="py-6 text-center text-xs text-faint">正在读取用户目录…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Users}
          message={q ? "没有匹配的账号" : "还没有注册账号"}
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
                onClick={() => onPageChange(Math.max(1, page - 1))}
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
                onClick={() => onPageChange(Math.min(pageCount, page + 1))}
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
        title={`禁用「${confirmDisable?.displayId ?? ""}」？`}
        confirmLabel="禁用账号"
        confirmTone="danger"
        busy={disableMutation.isPending}
        confirmDisabled={confirmDisable === null}
        onConfirm={() => {
          const target = confirmDisable
          setConfirmDisable(null)
          if (target) void mutateDisabled(target, true)
        }}
      >
        <p>禁用后该账号立即无法登录，已有数据不受影响；可以随时重新启用。</p>
      </ConfirmDialog>

      <Dialog
        open={resetTarget !== null}
        onClose={() => {
          if (resetMutation.isPending) return
          setResetTarget(null)
          setResetError(null)
        }}
        title={`重置「${resetTarget?.displayId ?? ""}」的密码`}
        tier="form"
        footer={
          <div className="flex justify-end gap-2">
            <UiButton
              variant="ghost"
              size="sm"
              type="button"
              disabled={resetMutation.isPending}
              onClick={() => {
                setResetTarget(null)
                setResetError(null)
              }}
            >
              取消
            </UiButton>
            <UiButton
              variant="default"
              size="sm"
              type="button"
              disabled={resetMutation.isPending || resetDraft.length !== 8}
              onClick={() => void submitPasswordReset()}
            >
              {resetMutation.isPending ? "正在重置…" : "确认重置"}
            </UiButton>
          </div>
        }
      >
        <label className="flex flex-col gap-1.5 text-xs text-faint">
          新密码（恰好 8 位）
          <TextInput
            type="password"
            value={resetDraft}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
              setResetDraft(event.target.value)
            }
            autoComplete="new-password"
          />
        </label>
        {resetError ? <p className="text-xs text-danger">{resetError}</p> : null}
      </Dialog>
    </section>
  )
}
