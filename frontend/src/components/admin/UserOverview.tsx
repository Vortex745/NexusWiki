import { useEffect, useState } from "react"

import { Button as UiButton } from "../ui/Button"
import { EmptyState } from "../ui/Controls"
import { BarChart, type BarChartDatum } from "../arc/bar-chart/bar-chart"
import {
  fetchAdminOverview,
  type AdminOverviewPayload,
} from "../../lib/adminApi"

/**
 * AC-06 (admin console): the account overview.
 *
 * Only what the registry can honestly support — created accounts and the
 * enabled/disabled split. There is no login-event table, so there is no
 * "daily active" curve to fake. The zero-filled 14-day series renders with
 * Arc's BarChart, which owns the average line, the scrubbable readout and
 * reduced motion; this page only supplies labels and the day formatter.
 */

const countText = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 })

function dayText(date: string): string {
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`
}

function axisText(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`
}

function periodText(dates: string[]): string {
  if (dates.length === 0) return ""
  const first = dates[0]!
  const last = dates[dates.length - 1]!
  const end =
    first.slice(0, 4) === last.slice(0, 4)
      ? dayText(last)
      : `${last.slice(0, 4)}年${dayText(last)}`
  return `${first.slice(0, 4)}年${dayText(first)} – ${end}`
}

export function UserOverview() {
  const [overview, setOverview] = useState<AdminOverviewPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    setError(null)
    fetchAdminOverview()
      .then((payload) => {
        if (!cancelled) setOverview(payload)
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "读取账号概览失败")
        }
      })
    return () => {
      cancelled = true
    }
  }, [reloadToken])

  if (error) {
    return (
      <section aria-label="账号概览" className="rounded-[12px] border border-line bg-surface px-4 py-3">
        <div className="flex items-center justify-between">
          <p className="text-xs text-danger">账号概览读取失败：{error}</p>
          <UiButton
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => setReloadToken((token) => token + 1)}
          >
            重试
          </UiButton>
        </div>
      </section>
    )
  }
  if (!overview) {
    return (
      <section aria-label="账号概览" className="rounded-[12px] border border-line bg-surface px-4 py-3">
        <p className="text-xs text-faint" role="status">正在读取账号概览…</p>
      </section>
    )
  }

  const { total, active, disabled, newUsers } = overview
  const series: BarChartDatum[] = newUsers.map((entry) => ({
    key: entry.date,
    label: dayText(entry.date),
    axisLabel: axisText(entry.date),
    value: entry.count,
  }))

  return (
    <section aria-label="账号概览" className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-ink">账号概览</h2>
      <div className="flex flex-wrap items-stretch gap-2">
        <Stat label="总账号" value={total} />
        <Stat label="启用" value={active} />
        <Stat label="已禁用" value={disabled} tone={disabled > 0 ? "danger" : undefined} />
      </div>
      <div className="rounded-[12px] border border-line bg-surface px-4 py-3">
        {total === 0 || series.length === 0 ? (
          <EmptyState message="还没有注册账号" />
        ) : (
          <BarChart
            data={series}
            label="最近 14 天新增账号"
            period={periodText(newUsers.map((entry) => entry.date))}
            unit="个"
            averageLabel="日均新增"
            averageShortLabel="日均"
            valueLabel="当日新增"
            categoryLabel="日期"
            formatValue={(value) => countText.format(value)}
          />
        )}
      </div>
    </section>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: "danger"
}) {
  return (
    <div className="min-w-24 flex-1 rounded-[12px] border border-line bg-surface px-4 py-3">
      <p className="text-[11px] text-faint">{label}</p>
      <p
        className={
          tone === "danger"
            ? "text-lg font-semibold tabular-nums text-danger"
            : "text-lg font-semibold tabular-nums text-ink"
        }
      >
        {value}
      </p>
    </div>
  )
}
