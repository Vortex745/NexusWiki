// 只有 captured 仍是当前 promise 时才能 dispose 并清空。否则另一个入口已经
// 接管，碰它会丢掉对方的 Router。
export interface RouterSlot<T> {
  current: () => Promise<T> | null
  ensure: (create: () => Promise<T>) => Promise<T>
  release: (captured: Promise<T> | null, resolved: T | undefined, dispose: (router: T) => void) => boolean
}

export function createRouterSlot<T>(): RouterSlot<T> {
  let promise: Promise<T> | null = null
  return {
    current: () => promise,
    ensure: (create) => (promise ??= create()),
    release: (captured, resolved, dispose) => {
      if (resolved === undefined || promise !== captured) return false
      dispose(resolved)
      promise = null
      return true
    }
  }
}
