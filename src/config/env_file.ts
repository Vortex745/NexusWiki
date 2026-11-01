/**
 * Non-destructive `.env` editing for the model settings workspace.
 *
 * The settings form is allowed to change provider credentials, and the server
 * environment file is their single home — no second copy in SQLite or a JSON
 * store. Writing keeps every comment, blank line and untouched key exactly
 * where it was, updates only the requested keys (quoting a value when dotenv
 * would otherwise mis-parse it) and appends keys the file does not have yet.
 *
 * Writes go through a sibling temp file and a rename so a crash can never
 * leave a half-written `.env`. Windows can report a transient EPERM/EBUSY on
 * rename while another handle is closing, so the rename is retried briefly.
 */

import { promises as fs, readFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

const ENV_LINE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/

/** `ENV_FILE` lets a deployment point at a different environment file. */
export function defaultEnvFilePath(): string {
  return process.env.ENV_FILE || resolve(process.cwd(), ".env")
}

function parseValue(raw: string): string {
  const value = raw.trim()
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    const inner = value.slice(1, -1)
    if (value.startsWith("'")) return inner
    return inner.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  }
  // dotenv treats an unquoted ` #` as the start of an inline comment.
  const comment = value.search(/\s#/)
  return comment >= 0 ? value.slice(0, comment).trim() : value
}

function parseEnvText(text: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = ENV_LINE.exec(line)
    if (!match) continue
    values.set(match[2], parseValue(match[4]))
  }
  return values
}

/** Values currently in the environment file. A missing file reads as empty. */
export function readEnvValuesSync(path: string): Map<string, string> {
  try {
    return parseEnvText(readFileSync(path, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map()
    throw error
  }
}

function formatValue(value: string): string {
  if (value === "" || /[\s#"'`\\]/.test(value)) return JSON.stringify(value)
  return value
}

function updateEnvText(text: string, entries: Record<string, string>): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n"
  const lines = text.length === 0 ? [] : text.split(/\r?\n/)
  const endsWithNewline = lines.length > 0 && lines[lines.length - 1] === ""
  if (endsWithNewline) lines.pop()

  const written = new Set<string>()
  const next = lines.map((line) => {
    const match = ENV_LINE.exec(line)
    if (!match) return line
    const key = match[2]
    if (!(key in entries)) return line
    written.add(key)
    return `${match[1]}${key}=${formatValue(entries[key])}`
  })

  const additions = Object.entries(entries).filter(([key]) => !written.has(key))
  for (const [key, value] of additions) next.push(`${key}=${formatValue(value)}`)

  if (next.length === 0) return ""
  // A file that did not end with a newline keeps that shape unless appending
  // a new key, which needs one.
  const trailing = additions.length > 0 || endsWithNewline ? newline : ""
  return `${next.join(newline)}${trailing}`
}

/**
 * Write the given keys into the environment file, leaving everything else in
 * place. Values are stored verbatim (no expansion or interpolation).
 */
export async function writeEnvValues(
  path: string,
  entries: Record<string, string>
): Promise<void> {
  let text = ""
  try {
    text = await fs.readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const next = updateEnvText(text, entries)
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.tmp`
  )
  await fs.writeFile(temp, next, { encoding: "utf8", mode: 0o600 })
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(temp, path)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EEXIST")) {
        await fs.rm(temp, { force: true })
        throw error
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25 * (attempt + 1)))
    }
  }
}
