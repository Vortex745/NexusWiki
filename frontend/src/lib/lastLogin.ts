const minute = 60_000
const hour = 60 * minute
const day = 24 * hour
const maxDays = 7

/**
 * Last login as relative text: minutes under an hour, hours under a day,
 * days after that, capped at seven days. A null value means the account has
 * never signed in; an unparseable one is shown as-is instead of inventing a
 * distance.
 */
export function formatLastLogin(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "从未登录"
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return iso
  const elapsed = Math.max(0, now - then)
  if (elapsed < hour) return `${Math.max(1, Math.floor(elapsed / minute))}分钟前`
  if (elapsed < day) return `${Math.floor(elapsed / hour)}小时前`
  return `${Math.min(maxDays, Math.floor(elapsed / day))}天前`
}
