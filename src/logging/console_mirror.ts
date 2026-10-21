import util from "node:util"
import type { Logger, LogFields } from "./logger"

/**
 * LF-04: fold existing `console.*` calls into the system log file.
 *
 * The mirror must never change what a developer sees in the terminal and must
 * never write the JSON stdout line again: the composition root hands it the
 * system FILE branch, not the tee. Mirroring is best effort — a logger that
 * throws or rejects cannot break the original console call, and a console call
 * triggered from inside the logger is not mirrored again.
 */
export interface ConsoleLike {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

const LEVEL_BY_METHOD = {
  debug: "debug",
  info: "info",
  log: "info",
  warn: "warn",
  error: "error",
} as const

type ConsoleMethod = keyof typeof LEVEL_BY_METHOD

const METHODS = Object.keys(LEVEL_BY_METHOD) as ConsoleMethod[]

interface MirrorState {
  originals: Record<ConsoleMethod, (...args: unknown[]) => unknown>
  uninstall: () => void
}

const states = new WeakMap<ConsoleLike, MirrorState>()

const NOOP = (): void => {}

/**
 * Replaces the five console methods in place. Returns an idempotent uninstall
 * that restores the exact function references captured at install time.
 * Without a logger (or with `LOG_LEVEL=off`) nothing is patched.
 */
export function installConsoleMirror(
  target: ConsoleLike,
  logger: Logger | undefined,
): () => void {
  const existing = states.get(target)
  if (existing) return existing.uninstall
  if (!logger || logger.level === "off") return NOOP

  const originals = {} as Record<ConsoleMethod, (...args: unknown[]) => unknown>
  let mirroring = false

  for (const method of METHODS) {
    const original = target[method]
    originals[method] = original
    target[method] = function mirroredConsole(this: ConsoleLike, ...args: unknown[]) {
      const result = original.apply(this, args)
      if (mirroring) return result
      mirroring = true
      try {
        const fields: LogFields = { message: formatConsoleArgs(args) }
        const pending = logger[LEVEL_BY_METHOD[method]]("console", fields)
        void Promise.resolve(pending).catch(NOOP)
      } catch {
        // A broken mirror must never affect the console output just written.
      } finally {
        mirroring = false
      }
      return result
    }
  }

  const state: MirrorState = {
    originals,
    uninstall: () => {
      if (states.get(target) !== state) return
      states.delete(target)
      for (const method of METHODS) target[method] = originals[method]
    },
  }
  states.set(target, state)
  return state.uninstall
}

/** Node `util.format` semantics; a hostile inspect hook degrades instead of throwing. */
function formatConsoleArgs(args: readonly unknown[]): string {
  try {
    return util.format(...args)
  } catch {
    return args
      .map((value) => {
        try {
          return String(value)
        } catch {
          return "[unserializable]"
        }
      })
      .join(" ")
  }
}
