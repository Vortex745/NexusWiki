import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'

// PDF 解析子进程封装：调 resources/pymupdf/parse_pdf.py（Python + PyMuPDF，零 npm 依赖）
// python/pymupdf 缺失、超时、输出非法等一切失败 → 带 stderr 尾部的 Error，主进程据此提示管理员

const execFileAsync = promisify(execFile)

interface PythonCommand {
  bin: string
  prefixArgs: string[]
}

let cachedPython: PythonCommand | null = null

// PATH 里排第一的 python 可能是微软商店的占位 stub（静默退出、零输出——实机踩过），
// 所以用 --version 实测挑解释器而不是直接赌 PATH 顺序；settings rag.pythonBin 可手动指定
export async function resolvePythonCommand(db?: DatabaseSync): Promise<PythonCommand> {
  if (cachedPython) return cachedPython
  if (db) {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'rag.pythonBin'").get() as
      | { value: string }
      | undefined
    if (row?.value && existsSync(row.value)) {
      cachedPython = { bin: row.value, prefixArgs: [] }
      return cachedPython
    }
  }
  const candidates: Array<{ bin: string; prefixArgs: string[] }> = [
    { bin: 'python', prefixArgs: [] },
    { bin: 'python3', prefixArgs: [] },
    { bin: 'py', prefixArgs: ['-3'] }
  ]
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate.bin, [...candidate.prefixArgs, '--version'], { timeout: 10000 })
      if (/Python 3/.test(stdout)) {
        cachedPython = candidate
        return cachedPython
      }
    } catch {
      // 换下一个候选
    }
  }
  throw new Error('未找到可用的 Python 3（尝试了 python / python3 / py）。请安装 Python 并 pip install pymupdf，或在 settings 表配置 rag.pythonBin 指向 python.exe 绝对路径')
}

export interface ParsedPage {
  index: number
  imagePath: string
  text: string
}

export interface ParseResult {
  pageCount: number
  pages: ParsedPage[]
}

// out/main/index.mjs 运行时与 src/main/rag 测试时 import.meta.dirname 深度不同，两处都探测
export function resolveParsePdfScriptPath(): string {
  const candidates = [
    join(import.meta.dirname, '../../resources/pymupdf/parse_pdf.py'),
    join(import.meta.dirname, '../../../resources/pymupdf/parse_pdf.py')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('parse_pdf.py not found (resources/pymupdf missing)')
}

export async function parsePdf(opts: {
  pdfPath: string
  outDir: string
  scriptPath: string
  db?: DatabaseSync
}): Promise<ParseResult> {
  const python = await resolvePythonCommand(opts.db).catch((err: unknown) => {
    throw new Error(err instanceof Error ? err.message : String(err))
  })
  try {
    const { stdout } = await execFileAsync(
      python.bin,
      [...python.prefixArgs, opts.scriptPath, opts.pdfPath, opts.outDir, '--dpi', '150'],
      {
        timeout: 120000,
        maxBuffer: 32 * 1024 * 1024
      }
    )
    const parsed = JSON.parse(stdout) as ParseResult
    if (typeof parsed.pageCount !== 'number' || !Array.isArray(parsed.pages)) {
      throw new Error('parse output missing pageCount/pages')
    }
    return parsed
  } catch (err) {
    const e = err as { stderr?: unknown; message?: string }
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr == null ? '' : String(e.stderr)
    const tail = stderr.trim().slice(-500)
    throw new Error(`PDF 解析失败: ${tail || (e.message ?? String(err))}`, { cause: err })
  }
}
