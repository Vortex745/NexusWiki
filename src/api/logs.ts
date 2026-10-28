import { spawn } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { basename, resolve } from "node:path"
import { Router, type Request, type Response } from "express"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
import { resolveLogDir } from "../logging/file_destination"
import { formatLocalDateKey } from "../logging/weknora_text"

/**
 * Admin-only "open the log file" surface behind 更多设置 → 查看日志.
 *
 * The browser cannot open a local path from an HTTP page, and the app's auth is
 * a bearer header that a plain new tab would not carry. The user explicitly
 * chose the OS-default-program route, so the SERVER opens the file on its own
 * machine. That is the documented boundary: a remote/Docker backend opens (or
 * refuses) there, never on the client.
 *
 * Security shape:
 *   - admin scope is required here AND at the mount point;
 *   - `stream` is an allowlisted enum, never a path;
 *   - the path is derived from LOG_DIR + the daily file name pattern;
 *   - the command receives the path through an environment variable, so a
 *     filename can never become shell syntax.
 */

const STREAMS = new Set(["system", "agent"] as const)
type LogStream = "system" | "agent"

export interface LogFileOpener {
  (filePath: string): Promise<void>
}

export interface LogsRouterOptions {
  /** Test seam: the log directory; production reads LOG_DIR at request time. */
  logDir?: string
  /** Test seam: wall clock for "today". */
  now?: () => Date
  /** Test seam: the platform opener; tests must never launch real programs. */
  openFile?: LogFileOpener
}

function resolveContext(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

function requireAdmin(ctx: AccessContext, res: Response): boolean {
  if (!ctx.scopes.includes("admin")) {
    res.status(403).json({ error: "missing scope: admin" })
    return false
  }
  return true
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Today's file when it exists, otherwise the newest same-stream file. */
export function latestLogFile(
  dir: string,
  stream: LogStream,
  now: Date,
): { name: string; path: string } | null {
  const today = `${stream}-${formatLocalDateKey(now)}.log`
  // Absolute paths: the opener is a separate process; a relative path there
  // depends on its working directory, not this server's.
  const todayPath = resolve(dir, today)
  if (isFile(todayPath)) return { name: today, path: todayPath }

  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  const pattern = new RegExp(`^${stream}-\\d{4}-\\d{2}-\\d{2}\\.log$`)
  const newest = names
    .filter((name) => pattern.test(name))
    .sort()
    .at(-1)
  return newest ? { name: newest, path: resolve(dir, newest) } : null
}

/**
 * Run the platform opener and wait for IT to exit. A successfully spawned
 * PowerShell is not evidence that Start-Process worked; a hidden or failed
 * launch must surface as an error instead of a green toast.
 */
function runOpener(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...(env ? { env } : {}),
    })
    let stderr = ""
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.once("error", reject)
    child.once("close", (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(stderr.trim() || `默认程序启动失败（exit ${code ?? "unknown"}）`))
    })
  })
}

/** Open a server-side file with the platform's default application. */
export function openWithDefaultApp(filePath: string): Promise<void> {
  if (process.platform === "win32") {
    // Start-Process reads the path from the environment: no quoting/injection
    // surface even when LOG_DIR or the file name contains spaces. `-PassThru`
    // plus a non-zero exit is the only honest "it launched" signal; a normal
    // window matters because this opener is used from a background API process.
    return runOpener(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop'; Start-Process -FilePath $env:LOG_FILE_PATH -WindowStyle Normal -PassThru | Out-Null",
      ],
      { ...process.env, LOG_FILE_PATH: filePath },
    )
  }
  if (process.platform === "darwin") return runOpener("open", [filePath])
  if (process.platform === "linux" && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
    return runOpener("xdg-open", [filePath])
  }
  return Promise.reject(new Error("当前服务端没有可用的桌面会话，无法打开本机文件"))
}

export function createLogsRouter(options: LogsRouterOptions = {}): Router {
  const router = Router()
  const clock = options.now ?? (() => new Date())
  const opener = options.openFile ?? openWithDefaultApp

  router.post("/logs/open", async (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return

    const stream = (req.body as { stream?: unknown } | undefined)?.stream
    if (typeof stream !== "string" || !STREAMS.has(stream as LogStream)) {
      res.status(400).json({ error: "stream must be system or agent" })
      return
    }

    const dir = options.logDir ?? resolveLogDir(process.env.LOG_DIR)
    const file = latestLogFile(dir, stream as LogStream, clock())
    if (!file) {
      res.status(404).json({ error: `没有找到 ${stream} 日志文件`, stream })
      return
    }

    try {
      await opener(file.path)
      res.set("Cache-Control", "no-store").json({
        opened: true,
        stream,
        file: basename(file.path),
        path: file.path,
      })
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
        stream,
        file: basename(file.path),
        path: file.path,
      })
    }
  })

  return router
}
