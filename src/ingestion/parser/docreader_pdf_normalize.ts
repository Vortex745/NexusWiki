import { createHash } from "node:crypto"
import type { NormalizedBlock, NormalizedBlockType } from "../../types"
import { DocReaderError } from "./docreader_client"
import type {
  DocReaderRawEnvelope,
  DocReaderSourceBlockSummary,
} from "./docreader_pdf_types"

interface Line {
  text: string
  start: number
  end: number
}

interface MappedSourceBlock {
  start: number
  end: number
  locator?: Record<string, unknown>
}

const CODE_FENCE_START = /^(`{3,})([^`]*)$/

export interface NormalizedDocReaderResult {
  blocks: NormalizedBlock[]
  warnings: string[]
}

function malformed(detail: string): never {
  throw new DocReaderError(
    `malformed docreader-pdf output: ${detail}`,
    "permanent_input",
    "docreader_parse_failed"
  )
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return malformed("expected an object")
  }
  return value as Record<string, unknown>
}

function isImageOnlyMarkdown(text: string): boolean {
  const remaining = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<img\b[^>]*>/gi, "")
    .trim()
  return remaining.length === 0
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

function splitLines(markdown: string): Line[] {
  const lines: Line[] = []
  let start = 0
  for (let index = 0; index <= markdown.length; index += 1) {
    if (index !== markdown.length && markdown[index] !== "\n") continue
    let text = markdown.slice(start, index)
    if (text.endsWith("\r")) text = text.slice(0, -1)
    lines.push({ text, start, end: index })
    start = index + 1
  }
  return lines
}

function isTableStart(lines: Line[], index: number): boolean {
  return index + 1 < lines.length &&
    lines[index].text.includes("|") &&
    /^\s*\|?\s*:?-{3,}:?/.test(lines[index + 1].text)
}

function parseTableRow(line: string): string[] {
  let value = line.trim()
  if (value.startsWith("|")) value = value.slice(1)
  const cells: string[] = []
  let cell = ""
  let backslashes = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "|" && backslashes % 2 === 1) {
      cell = cell.slice(0, -1) + "|"
    } else if (value[index] === "|") {
      cells.push(cell.trim())
      cell = ""
      if (index === value.length - 1) return cells
    } else {
      cell += value[index]
    }
    backslashes = value[index] === "\\" ? backslashes + 1 : 0
  }
  cells.push(cell.trim())
  return cells
}

function tableShape(lines: Line[]): { headers: string[]; rows: string[][] } {
  return {
    headers: parseTableRow(lines[0].text),
    rows: lines.slice(2).map((line) => parseTableRow(line.text)),
  }
}

const NUMERIC_UNIT = /^(?:元|天|%|次|年|月|日|小时|分钟|秒|kg|KG|g|m|cm|mm|GB|MB|KB)$/

function tableCells(text: string): string[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean)
  const cells: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    if (/^\d+(?:[.,]\d+)?$/.test(tokens[index]) && NUMERIC_UNIT.test(tokens[index + 1] ?? "")) {
      cells.push(`${tokens[index]}${tokens[index + 1]}`)
      index += 1
    } else {
      cells.push(tokens[index])
    }
  }
  return cells
}

interface WhitespaceTable {
  headers: string[]
  rows: string[][]
  consumed: number
}

/**
 * DocReader's builtin PDF engine emits visually aligned tables as plain lines
 * (no pipe syntax). Recover a conservative table only when a header line and
 * at least two numeric rows share the same cell count; prose and layout text
 * stay paragraphs. This is normalization, not a quality approval gate.
 */
function detectWhitespaceTable(lines: Line[]): WhitespaceTable | null {
  if (lines.length < 3) return null
  const headerText = lines[0].text.trim()
  if (!headerText || /[：:。！？；,，;!?]$/.test(headerText)) return null
  const headers = tableCells(headerText)
  if (headers.length < 3 || headers.some((cell) => /\d/.test(cell))) return null

  const rows: string[][] = []
  let pending: string[] = []
  let lastComplete = 1
  for (let index = 1; index < lines.length; index += 1) {
    const raw = lines[index].text.trim()
    if (!raw || /[：:。！？；]/.test(raw)) break
    const cells = tableCells(raw)
    if (cells.length === 0 || pending.length + cells.length > headers.length) break
    pending.push(...cells)
    if (pending.length === headers.length) {
      if (!pending.some((cell) => /\d/.test(cell))) return null
      rows.push(pending)
      pending = []
      lastComplete = index + 1
    }
  }
  if (pending.length > 0 || rows.length < 2) return null
  return { headers, rows, consumed: lastComplete }
}

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n")
}

function mapCodePointOffsets(markdown: string, boundaries: Set<number>): Map<number, number> {
  const mapped = new Map<number, number>()
  let codePoints = 0
  let utf16 = 0
  for (const character of markdown) {
    if (boundaries.has(codePoints)) mapped.set(codePoints, utf16)
    codePoints += 1
    utf16 += character.length
  }
  if (boundaries.has(codePoints)) mapped.set(codePoints, utf16)
  return mapped
}

function parseLocator(value: unknown): Record<string, unknown> | undefined {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

function locatorPage(locator: Record<string, unknown>): number | undefined {
  const page = locator.page
  return Number.isInteger(page) && (page as number) >= 1 ? page as number : undefined
}

function withRatioUnit(locator: Record<string, unknown>): Record<string, unknown> {
  const bbox = locator.bbox
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((value) => typeof value === "number")) {
    return locator
  }
  return { ...locator, bboxUnit: "ratio" }
}

export function parseDocReaderEnvelope(raw: string): DocReaderRawEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return malformed("invalid JSON envelope")
  }
  const envelope = object(parsed)
  if (envelope.schemaVersion !== 1) return malformed("unsupported envelope schema")
  if (typeof envelope.markdown !== "string") return malformed("markdown must be a string")
  if (!Array.isArray(envelope.sourceBlocks)) return malformed("sourceBlocks must be an array")
  if (!Array.isArray(envelope.images)) return malformed("images must be an array")
  if (!Array.isArray(envelope.warnings)) return malformed("warnings must be an array")
  if (typeof envelope.forceScanned !== "boolean") return malformed("forceScanned must be a boolean")
  if (typeof envelope.documentSha256 !== "string") return malformed("documentSha256 must be a string")
  return envelope as unknown as DocReaderRawEnvelope
}

export function normalizeDocReaderEnvelope(
  raw: string,
  documentId: string
): NormalizedDocReaderResult {
  const envelope = parseDocReaderEnvelope(raw)
  const warnings = new Set(envelope.warnings)

  const boundaries = new Set<number>()
  for (const source of envelope.sourceBlocks as DocReaderSourceBlockSummary[]) {
    if (!Number.isInteger(source.start) || !Number.isInteger(source.end) ||
      source.start < 0 || source.end <= source.start) {
      warnings.add("docreader_source_block_invalid")
      continue
    }
    boundaries.add(source.start)
    boundaries.add(source.end)
  }
  const offsetMap = mapCodePointOffsets(envelope.markdown, boundaries)
  const sources: MappedSourceBlock[] = []
  for (const source of envelope.sourceBlocks as DocReaderSourceBlockSummary[]) {
    if (!Number.isInteger(source.start) || !Number.isInteger(source.end) ||
      source.start < 0 || source.end <= source.start) continue
    const start = offsetMap.get(source.start)
    const end = offsetMap.get(source.end)
    if (start === undefined || end === undefined || end <= start) {
      warnings.add("docreader_source_block_invalid")
      continue
    }
    const locator = parseLocator(source.locatorJson)
    if (source.locatorJson.trim() && !locator) warnings.add("docreader_source_locator_invalid")
    sources.push({ start, end, ...(locator ? { locator } : {}) })
  }

  const blocks: NormalizedBlock[] = []
  const headings: Array<{ level: number; text: string }> = []

  const addBlock = (
    type: NormalizedBlockType,
    text: string,
    range: { start: number; end: number },
    extras: Partial<NormalizedBlock> = {},
    extraMetadata: Record<string, unknown> = {}
  ): void => {
    const normalizedText = text.trim()
    if (!normalizedText) return
    if (type === "paragraph" && isImageOnlyMarkdown(normalizedText)) return
    const matched = sources.filter(
      (source) => source.start < range.end && range.start < source.end
    )
    if (matched.length === 0) warnings.add("docreader_source_block_missing")
    const locators = matched
      .flatMap((source) => source.locator ? [withRatioUnit(source.locator)] : [])
    const page = locators
      .map(locatorPage)
      .find((value): value is number => value !== undefined)
    const index = blocks.length
    blocks.push({
      id: blockId(documentId, index, type, normalizedText),
      index,
      type,
      text: normalizedText,
      ...(page !== undefined ? { page } : {}),
      sectionPath: headings.map((heading) => heading.text),
      metadata: {
        ...(locators.length > 0 ? { sourceLocators: locators } : {}),
        ...(matched.length > 0 ? { sourceBlockCount: matched.length } : {}),
        ...extraMetadata,
      },
      provenance: { parser: "docreader-pdf", adapter: "grpc" },
      ...extras,
    })
  }

  const addOcrBlock = (text: string, page: number): void => {
    const index = blocks.length
    blocks.push({
      id: blockId(documentId, index, "paragraph", text),
      index,
      type: "paragraph",
      text,
      page,
      sectionPath: [],
      metadata: {
        sourceLocators: [{ type: "pdf", page }],
        docreaderOcr: true,
      },
      provenance: { parser: "docreader-pdf", adapter: "grpc" },
    })
  }

  const lines = splitLines(envelope.markdown)
  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    if (!line.text.trim()) {
      index += 1
      continue
    }

    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line.text)
    if (heading) {
      const level = heading[1].length
      const text = heading[2].trim()
      while (headings.at(-1)?.level && headings.at(-1)!.level >= level) headings.pop()
      headings.push({ level, text })
      addBlock("heading", text, { start: line.start, end: line.end }, { headingLevel: level })
      index += 1
      continue
    }

    const fence = CODE_FENCE_START.exec(line.text)
    if (fence) {
      const info = fence[2].trim()
      const language = /^([\w.+-]+)(?:\s|$)/.exec(info)?.[1]
      const content: string[] = []
      const fenceEnd = new RegExp("^`{" + fence[1].length + ",}\\s*$")
      let cursor = index + 1
      while (cursor < lines.length && !fenceEnd.test(lines[cursor].text)) {
        content.push(lines[cursor].text)
        cursor += 1
      }
      if (cursor >= lines.length) {
        warnings.add("docreader_unclosed_code_fence")
        const rest = lines.slice(index).map((entry) => entry.text).join("\n")
        addBlock("paragraph", rest, { start: line.start, end: lines.at(-1)!.end })
        break
      }
      addBlock(
        "code",
        content.join("\n"),
        { start: line.start, end: lines[cursor].end },
        {},
        {
          ...(language ? { language } : {}),
          ...(info && info !== language ? { fenceInfo: info } : {}),
        }
      )
      index = cursor + 1
      continue
    }

    if (isTableStart(lines, index)) {
      const tableLines: Line[] = []
      let cursor = index
      while (cursor < lines.length && lines[cursor].text.trim() && lines[cursor].text.includes("|")) {
        tableLines.push(lines[cursor])
        cursor += 1
      }
      const last = tableLines.at(-1)!
      addBlock(
        "table",
        tableLines.map((entry) => entry.text).join("\n"),
        { start: line.start, end: last.end },
        { table: tableShape(tableLines) }
      )
      index = cursor
      continue
    }

    const paragraph: Line[] = []
    let cursor = index
    while (
      cursor < lines.length &&
      lines[cursor].text.trim() &&
      !/^(#{1,6})\s+/.test(lines[cursor].text) &&
      !CODE_FENCE_START.test(lines[cursor].text) &&
      !isTableStart(lines, cursor)
    ) {
      paragraph.push(lines[cursor])
      cursor += 1
    }
    const table = detectWhitespaceTable(paragraph)
    if (table) {
      const tableLines = paragraph.slice(0, table.consumed)
      const rest = paragraph.slice(table.consumed)
      addBlock(
        "table",
        markdownTable(table.headers, table.rows),
        { start: tableLines[0].start, end: tableLines.at(-1)!.end },
        { table: { headers: table.headers, rows: table.rows } }
      )
      if (rest.length > 0) {
        addBlock(
          "paragraph",
          rest.map((entry) => entry.text.trim()).join("\n"),
          { start: rest[0].start, end: rest.at(-1)!.end }
        )
      }
    } else {
      const last = paragraph.at(-1)!
      addBlock(
        "paragraph",
        paragraph.map((entry) => entry.text.trim()).join("\n"),
        { start: line.start, end: last.end }
      )
    }
    index = cursor
  }

  for (const image of envelope.images) {
    if (image.kind !== "scan" || !image.ocr) continue
    for (const warning of image.ocr.warnings ?? []) warnings.add(warning)
    const text = image.ocr.text.trim()
    if (!text) continue
    const page = image.ocr.page ?? image.page
    if (!Number.isInteger(page) || (page as number) < 1) continue
    for (const paragraph of text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
      addOcrBlock(paragraph, page as number)
    }
  }

  // Merge native and OCR blocks in original page order. Stable sort keeps the
  // within-page order from the markdown scan.
  blocks.sort((left, right) => {
    const leftPage = left.page ?? Number.MAX_SAFE_INTEGER
    const rightPage = right.page ?? Number.MAX_SAFE_INTEGER
    return leftPage - rightPage || left.index - right.index
  })
  blocks.forEach((block, index) => {
    block.index = index
    block.id = blockId(documentId, index, block.type, block.text)
  })

  if (blocks.length === 0) {
    throw new DocReaderError(
      "docreader-pdf produced no extractable text",
      "permanent_input",
      "docreader_no_extractable_text"
    )
  }
  return { blocks, warnings: [...warnings] }
}
