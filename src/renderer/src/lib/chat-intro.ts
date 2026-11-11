// 入场标记：store 在消息创建时打标，气泡行挂载时消费。
// 带 TTL 的非破坏读——StrictMode 双挂载会重播一次（等价观感），不会把动画吃丢。
const flags = new Map<string, number>()
const TTL_MS = 5000

function mark(kind: string, id: string): void {
  const now = Date.now()
  flags.set(`${kind}:${id}`, now)
  for (const [key, at] of flags) if (now - at > TTL_MS) flags.delete(key)
}

export function markEnter(id: string): void {
  mark('enter', id)
}

export function peekEnter(id: string): boolean {
  return flags.has(`enter:${id}`)
}
