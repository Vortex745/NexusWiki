/**
 * Ticket 30 (FAQ-01A) — a minimal RFC 4180 CSV reader for FAQ imports.
 *
 * The repository has no CSV dependency and this parser is the only one: comma
 * delimiter, double-quote quoting with `""` escapes, CRLF or LF row breaks,
 * quoted fields may contain delimiters and newlines. It reports structural
 * problems with their ROW NUMBER so an import can say exactly which row is
 * wrong instead of failing the whole file.
 *
 * Row numbers are RECORD positions, not text-editor line numbers: a quoted
 * field spanning several lines is one row (what a spreadsheet shows), so the
 * number a user sees in Excel/WPS is the number this parser reports.
 */

export interface CsvTable {
  header: string[]
  rows: string[][]
  /** The 1-based record position each row occupies in the file (header = 1). */
  rowLines: number[]
  issues: string[]
}

export function parseCsvTable(text: string): CsvTable {
  const issues: string[] = []
  const records: Array<{ line: number; fields: string[] }> = []
  let field = ""
  let record: string[] = []
  let inQuotes = false
  /** Number of the record being read: completed records + 1 (header = 1). */
  const recordNumber = () => records.length + 1
  let index = 0

  const endField = () => {
    record.push(field)
    field = ""
  }
  const endRecord = () => {
    endField()
    records.push({ line: recordNumber(), fields: record })
    record = []
  }

  while (index < text.length) {
    const char = text[index]!
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        inQuotes = false
        index += 1
        continue
      }
      field += char
      index += 1
      continue
    }
    if (char === '"') {
      if (field.length > 0) {
        issues.push(`row ${recordNumber()}: unexpected quote inside an unquoted field`)
      }
      inQuotes = true
      index += 1
      continue
    }
    if (char === ",") {
      endField()
      index += 1
      continue
    }
    if (char === "\r" || char === "\n") {
      endRecord()
      if (char === "\r" && text[index + 1] === "\n") index += 1
      index += 1
      continue
    }
    field += char
    index += 1
  }
  if (inQuotes) {
    issues.push(`row ${recordNumber()}: unterminated quoted field`)
  }
  // A file ending with a newline produces one empty trailing record — that is
  // not a row.
  if (field.length > 0 || record.length > 0) endRecord()

  const nonEmpty = records.filter(
    (item) => item.fields.length > 1 || (item.fields[0] ?? "").trim().length > 0
  )
  if (nonEmpty.length === 0) {
    return { header: [], rows: [], rowLines: [], issues: [...issues, "the file is empty"] }
  }
  const header = (nonEmpty[0]?.fields ?? []).map((name) => name.trim())
  const rows = nonEmpty.slice(1).map((item) => item.fields)
  const rowLines = nonEmpty.slice(1).map((item) => item.line)
  const width = header.length
  rows.forEach((row, position) => {
    if (row.length === width) return
    issues.push(
      `row ${rowLines[position]}: expected ${width} columns (${header.join(", ")}), saw ${row.length}`
    )
    while (row.length < width) row.push("")
  })
  return { header, rows, rowLines, issues }
}
