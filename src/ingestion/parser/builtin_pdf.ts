import { createHash } from "node:crypto"
import { accessSync, constants } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { NormalizedBlock, NormalizedBlockType } from "../../types"
import type { ParseDocumentInput } from "./markitdown"
import { runBoundedProcess } from "./process"

export interface BuiltinPdfParserOptions {
  command: string
  commandArgs?: string[]
  scriptPath?: string
  timeoutMs: number
  inputLimitBytes: number
  outputLimitBytes: number
}

interface RawOutlineEntry {
  level: number
  title: string
  page: number
}

interface RawBlock {
  page: number
  text: string
  bbox: [number, number, number, number]
  fontSize: number
  bold: boolean
}

interface RawTable {
  page: number
  bbox: [number, number, number, number]
  markdown: string
}

interface BuiltinPdfOutput {
  version: 1
  pageCount: number
  outline: RawOutlineEntry[]
  blocks: RawBlock[]
  tables: RawTable[]
  warnings: string[]
  stats: { textChars: number; pagesWithText: number }
}

/**
 * The extractor script ships with the repository under `scripts/`. The
 * module layout differs between tsx (src/ingestion/parser) and the compiled
 * build (dist/ingestion/parser), so resolve from the module directory and
 * fall back to the process working directory.
 */
function resolveDefaultScriptPath(): string {
  const relative = join("scripts", "builtin_pdf_extract.py")
  const candidates = [
    resolve(__dirname, "..", "..", "..", relative),
    resolve(process.cwd(), relative),
  ]
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.R_OK)
      return candidate
    } catch {
      continue
    }
  }
  return candidates[0]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function boundingBox(value: unknown): [number, number, number, number] | undefined {
  if (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every(finiteNumber)
  ) {
    return value as [number, number, number, number]
  }
  return undefined
}

function blockId(
  documentId: string,
  index: number,
  type: NormalizedBlockType,
  text: string
): string {
  return createHash("sha256")
    .update(`${documentId}\0${index}\0${type}\0${text}`, "utf8")
    .digest("hex")
}

function isDotLeaderRow(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length < 8) return false
  // A TOC row: a title followed by a run of dot leaders and a page number.
  if (!/[.·•]{3,}/.test(normalized)) return false
  if (!/\d{1,4}$/.test(normalized)) return false
  const dots = (normalized.match(/[.·•]/g) ?? []).length
  return dots / normalized.length >= 0.25
}

function repairDotLeaderRow(text: string): string {
  return text
    .replace(/\s*[.·•](?:\s*[.·•]){2,}\s*/g, " … ")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

function repairDotLeadersMultiline(text: string): string {
  return text.split("\n").map(repairDotLeaderRow).join("\n")
}

function parseOutline(value: unknown): RawOutlineEntry[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error("malformed builtin-pdf output: outline must be an array")
  }
  const entries: RawOutlineEntry[] = []
  for (const item of value) {
    if (
      !isRecord(item) ||
      !Number.isInteger(item.level) ||
      (item.level as number) < 1 ||
      (item.level as number) > 6 ||
      typeof item.title !== "string" ||
      !item.title.trim() ||
      !Number.isInteger(item.page) ||
      (item.page as number) < 1
    ) {
      throw new Error("malformed builtin-pdf output: invalid outline entry")
    }
    entries.push({
      level: item.level as number,
      title: (item.title as string).trim(),
      page: item.page as number,
    })
  }
  return entries
}

function parseBlocks(value: unknown): RawBlock[] {
  if (!Array.isArray(value)) {
    throw new Error("malformed builtin-pdf output: blocks must be an array")
  }
  const blocks: RawBlock[] = []
  for (const item of value) {
    const bbox = isRecord(item) ? boundingBox(item.bbox) : undefined
    if (
      !isRecord(item) ||
      !Number.isInteger(item.page) ||
      (item.page as number) < 1 ||
      typeof item.text !== "string" ||
      !item.text.trim() ||
      !bbox ||
      !finiteNumber(item.fontSize) ||
      typeof item.bold !== "boolean"
    ) {
      throw new Error("malformed builtin-pdf output: invalid block entry")
    }
    blocks.push({
      page: item.page as number,
      text: (item.text as string).trim(),
      bbox,
      fontSize: item.fontSize as number,
      bold: item.bold as boolean,
    })
  }
  return blocks
}

function parseTables(value: unknown): RawTable[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error("malformed builtin-pdf output: tables must be an array")
  }
  const tables: RawTable[] = []
  for (const item of value) {
    const bbox = isRecord(item) ? boundingBox(item.bbox) : undefined
    if (
      !isRecord(item) ||
      !Number.isInteger(item.page) ||
      (item.page as number) < 1 ||
      typeof item.markdown !== "string" ||
      !item.markdown.trim() ||
      !bbox
    ) {
      throw new Error("malformed builtin-pdf output: invalid table entry")
    }
    tables.push({
      page: item.page as number,
      bbox,
      markdown: (item.markdown as string).trim(),
    })
  }
  return tables
}

function parseOutput(value: unknown): BuiltinPdfOutput {
  if (!isRecord(value)) {
    throw new Error("malformed builtin-pdf output: expected a JSON object")
  }
  if (value.version !== 1 || !Number.isInteger(value.pageCount)) {
    throw new Error("malformed builtin-pdf output: unsupported payload shape")
  }
  const statsValue = isRecord(value.stats) ? value.stats : {}
  return {
    version: 1,
    pageCount: value.pageCount as number,
    outline: parseOutline(value.outline),
    blocks: parseBlocks(value.blocks),
    tables: parseTables(value.tables),
    warnings: Array.isArray(value.warnings)
      ? value.warnings.filter((warning): warning is string => typeof warning === "string")
      : [],
    stats: {
      textChars: finiteNumber(statsValue.textChars) ? statsValue.textChars : 0,
      pagesWithText: finiteNumber(statsValue.pagesWithText)
        ? statsValue.pagesWithText
        : 0,
    },
  }
}

function headingLevelsBySize(blocks: RawBlock[]): Map<number, number> {
  // Cluster the font sizes that are meaningfully larger than the body size
  // and map each to a heading level (1 = largest). The body size is the size
  // carrying the most text.
  const charsBySize = new Map<number, number>()
  for (const block of blocks) {
    if (block.fontSize <= 0) continue
    charsBySize.set(
      block.fontSize,
      (charsBySize.get(block.fontSize) ?? 0) + block.text.length
    )
  }
  if (charsBySize.size === 0) return new Map()
  const bodySize = [...charsBySize.entries()].sort((a, b) => b[1] - a[1])[0][0]
  const candidateSizes = [
    ...new Set(
      blocks
        .filter((block) => block.fontSize >= bodySize * 1.2 && block.text.length <= 80)
        .map((block) => block.fontSize)
    ),
  ].sort((a, b) => b - a)
  const levels = new Map<number, number>()
  candidateSizes.forEach((size, index) => {
    levels.set(size, Math.min(index + 1, 6))
  })
  return levels
}

function headingLevelFor(
  block: RawBlock,
  levelsBySize: Map<number, number>
): number | null {
  if (block.text.length > 80) return null
  const level = levelsBySize.get(block.fontSize)
  if (level === undefined) return null
  // Reject sentences mistaken for headings — heading lines rarely end with
  // sentence punctuation.
  if (/[。！？!?.;；]$/.test(block.text.trim())) return null
  return level
}

class OutlineCursor {
  private readonly sorted: RawOutlineEntry[]
  private readonly stack: RawOutlineEntry[] = []
  private cursor = 0

  constructor(outline: RawOutlineEntry[]) {
    this.sorted = [...outline].sort((a, b) => a.page - b.page)
  }

  advance(page: number): string[] {
    while (this.cursor < this.sorted.length && this.sorted[this.cursor].page <= page) {
      const entry = this.sorted[this.cursor]
      while (
        this.stack.length > 0 &&
        this.stack[this.stack.length - 1].level >= entry.level
      ) {
        this.stack.pop()
      }
      this.stack.push(entry)
      this.cursor += 1
    }
    return this.stack.map(({ title }) => title)
  }
}

function intersectionArea(
  a: [number, number, number, number],
  b: [number, number, number, number]
): number {
  const x = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
  const y = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  return x * y
}

function boxArea(a: [number, number, number, number]): number {
  return Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1])
}

export function normalizeBuiltinPdf(
  value: unknown,
  documentId: string
): NormalizedBlock[] {
  const output = parseOutput(value)
  if (output.blocks.length === 0) {
    throw new Error(
      "malformed builtin-pdf output: no text blocks (the PDF likely has no text layer; use an OCR parser such as mineru or marker)"
    )
  }

  const tablesByPage = new Map<number, RawTable[]>()
  for (const table of output.tables) {
    const existing = tablesByPage.get(table.page) ?? []
    existing.push(table)
    tablesByPage.set(table.page, existing)
  }
  const blocksByPage = new Map<number, RawBlock[]>()
  for (const block of output.blocks) {
    const existing = blocksByPage.get(block.page) ?? []
    existing.push(block)
    blocksByPage.set(block.page, existing)
  }

  const levelsBySize = headingLevelsBySize(output.blocks)
  const cursor = new OutlineCursor(output.outline)
  const fallbackHeadings: Array<{ level: number; text: string }> = []

  const blocks: NormalizedBlock[] = []
  const addBlock = (
    type: NormalizedBlockType,
    text: string,
    page: number,
    extras: Partial<NormalizedBlock> = {}
  ): void => {
    const index = blocks.length
    const outlineSection = cursor.advance(page)
    const headingLevel = extras.headingLevel
    if (type === "heading" && headingLevel) {
      while (
        fallbackHeadings.at(-1)?.level &&
        fallbackHeadings.at(-1)!.level >= headingLevel
      ) {
        fallbackHeadings.pop()
      }
      fallbackHeadings.push({ level: headingLevel, text })
    }
    blocks.push({
      id: blockId(documentId, index, type, text),
      index,
      type,
      text,
      ...(headingLevel ? { headingLevel } : {}),
      page,
      sectionPath:
        outlineSection.length > 0
          ? outlineSection
          : fallbackHeadings.map(({ text: headingText }) => headingText),
      metadata: {},
      provenance: { parser: "builtin-pdf", adapter: "script" },
      ...extras,
    })
  }

  // UT-11: a text block that shares its region with a detected table is
  // PRESERVED as body text (the conservative rule — suspected captions,
  // footnotes and side notes are never swallowed because a table extraction
  // succeeded), and the overlap relation is recorded on BOTH sides so the
  // duplication is auditable instead of silently resolved. The original text
  // of every transform stays reachable in the extraction evidence rawExtraction.
  const tablesByTextOverlap = new Set<string>()

  const pages = [...blocksByPage.keys()].sort((a, b) => a - b)
  for (const page of pages) {
    const pageBlocks = [...(blocksByPage.get(page) ?? [])].sort((a, b) =>
      a.bbox[1] === b.bbox[1] ? a.bbox[0] - b.bbox[0] : a.bbox[1] - b.bbox[1]
    )
    const pageTables = tablesByPage.get(page) ?? []

    for (const block of pageBlocks) {
      const coveringTable = pageTables.find(
        (table) =>
          boxArea(block.bbox) > 0 &&
          intersectionArea(block.bbox, table.bbox) / boxArea(block.bbox) >= 0.5
      )
      if (coveringTable) {
        tablesByTextOverlap.add(`${page}:${coveringTable.bbox.join(",")}`)
      }
      const transforms: string[] = []
      let headingLevel = headingLevelFor(block, levelsBySize) ?? undefined
      if (isDotLeaderRow(block.text)) {
        headingLevel = undefined
      }
      let text = block.text
      const repaired = repairDotLeaderRow(block.text)
      if (repaired !== text) {
        transforms.push("dot_leader_normalized")
        text = repaired
      }
      if (!text) continue
      addBlock(headingLevel ? "heading" : "paragraph", text, page, {
        headingLevel,
        metadata: {
          fontSize: block.fontSize,
          ...(block.bold ? { bold: true } : {}),
          ...(transforms.length > 0 ? { transforms } : {}),
          ...(coveringTable
            ? {
                overlapsTable: {
                  bbox: coveringTable.bbox,
                  note: "text block shares its region with a detected table; kept as body text (conservative preserve)",
                },
              }
            : {}),
        },
      })
    }

    // Every detected table is emitted — including ones whose region overlaps
    // text blocks, which used to be the only ones emitted (with the text
    // suppressed). The header-value structure stays queryable; the overlap
    // relation is recorded instead of guessing which side to drop.
    for (const table of pageTables) {
      const key = `${page}:${table.bbox.join(",")}`
      const markdown = repairDotLeadersMultiline(table.markdown)
      const tableTransforms: string[] = []
      if (markdown !== table.markdown) {
        tableTransforms.push("dot_leader_normalized_multiline")
      }
      addBlock("table", markdown, page, {
        table: { markdown },
        metadata: {
          source: "pymupdf-find_tables",
          ...(tablesByTextOverlap.has(key) ? { overlappedByText: true } : {}),
          ...(tableTransforms.length > 0 ? { transforms: tableTransforms } : {}),
        },
      })
    }
  }

  if (blocks.length === 0) {
    throw new Error("malformed builtin-pdf output: no normalized blocks")
  }
  return blocks
}

export class BuiltinPdfParser {
  readonly type = "builtin-pdf" as const
  private lastSummary: {
    warnings: string[]
    pageCount: number | null
    textChars: number | null
    pagesWithText: number | null
  } | null = null

  constructor(private options: BuiltinPdfParserOptions) {}

  static defaultScriptPath(): string {
    return resolveDefaultScriptPath()
  }

  async parse(input: ParseDocumentInput): Promise<NormalizedBlock[]> {
    try {
      const raw = await this.parseRaw(input)
      return this.normalizeRaw(raw, input.documentId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith("Parser executable is unavailable:")) {
        throw new Error(
          `builtin-pdf executable is unavailable. Configure PYTHON_COMMAND. ${message}`
        )
      }
      throw new Error(`builtin-pdf failed: ${message}`)
    }
  }

  /**
   * Ticket UT-09 truth seam: run the extraction script exactly like parse()
   * but return the RAW stdout (the extraction JSON) so the pipeline can
   * persist durable extraction evidence. No behavior change for parse().
   */
  async parseRaw(
    input: Omit<ParseDocumentInput, "documentId">
  ): Promise<string> {
    if (input.content.length > this.options.inputLimitBytes) {
      throw new Error(
        `builtin-pdf input exceeded ${this.options.inputLimitBytes} bytes`
      )
    }

    const scriptPath = this.options.scriptPath ?? resolveDefaultScriptPath()
    const workspace = await mkdtemp(join(tmpdir(), "kefu-rag-builtin-pdf-"))
    const sourcePath = join(workspace, "input.pdf")
    try {
      await writeFile(sourcePath, input.content, { flag: "wx" })
      const raw = await runBoundedProcess({
        command: this.options.command,
        args: [...(this.options.commandArgs ?? []), scriptPath, sourcePath],
        cwd: workspace,
        timeoutMs: this.options.timeoutMs,
        outputLimitBytes: this.options.outputLimitBytes,
        signal: input.signal,
      })
      // UT-11: capture the extraction summary (coverage warnings, per-file
      // stats) for extractionProvenance — normalizeRaw drops nothing, but the
      // document state and the durable evidence must carry the warnings too.
      this.lastSummary = null
      try {
        const parsed = JSON.parse(raw) as {
          warnings?: unknown
          pageCount?: unknown
          stats?: { textChars?: unknown; pagesWithText?: unknown }
        }
        this.lastSummary = {
          warnings: Array.isArray(parsed.warnings)
            ? parsed.warnings.filter(
                (warning): warning is string => typeof warning === "string"
              )
            : [],
          pageCount: Number.isInteger(parsed.pageCount)
            ? (parsed.pageCount as number)
            : null,
          textChars:
            typeof parsed.stats?.textChars === "number"
              ? parsed.stats.textChars
              : null,
          pagesWithText:
            typeof parsed.stats?.pagesWithText === "number"
              ? parsed.stats.pagesWithText
              : null,
        }
      } catch {
        // normalizeRaw re-validates the same payload and will fail loudly on
        // malformed output; provenance stays null rather than guessed.
      }
      return raw
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }

  /** UT-09: normalize a raw extraction JSON string into blocks. */
  normalizeRaw(raw: string, documentId: string): NormalizedBlock[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(
        `malformed builtin-pdf output: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    return normalizeBuiltinPdf(parsed, documentId)
  }

  /**
   * UT-11: extraction-level provenance of the last parseRaw — the extraction
   * payload's own coverage warnings and per-file stats, merged by the pipeline
   * into document metadata.system.extraction and the durable evidence record.
   */
  extractionProvenance(): { metadata: Record<string, unknown>; warnings: string[] } | null {
    if (!this.lastSummary) return null
    return {
      metadata: { extraction: { ...this.lastSummary } },
      warnings: [...this.lastSummary.warnings],
    }
  }
}
