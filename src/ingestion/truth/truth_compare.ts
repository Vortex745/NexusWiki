// UT-01：独立真值比较器。
//
// 设计约束（规格 UP-01 / UT-01 验收）：
// - 比较保留词间空格、缩进、数值、否定、顺序和有效重复；
// - 绝不通过删除全部空白来掩盖损失（全空白剥离后相同仍判 loss）；
// - 允许的解码变换只有两种，且剥离 BOM 仍作为 whitespace 记录：
//     1) 剥离一个前导 BOM（仅解码边界且显式允许时）
//     2) CRLF/CR → LF 行尾归一化
// - U+FFFD 或 NUL 出现即判 corrupt（模糊编码 → 待校验类，不得伪装成功）。
//
// 边界职责：
// - compareTextToTruth：真值 vs 解码/提取边界文本（逐行、空白敏感）。
// - compareTransformedText：清洗边界前后对比（同规则，不允许 BOM）。
// - checkChunkCoverage：切块边界的词元覆盖（块级会合法重排空白/重叠，
//   因此该边界按 eval-text-v1 风格词元判定缺口，不做空白敏感断言；
//   空白保真由上游两个文本边界负责）。

export type TruthLossKind = "whitespace" | "content" | "corruption" | "fabrication"

export type TruthVerdict = "match" | "loss" | "corrupt"

export interface TruthFinding {
  kind: TruthLossKind
  detail: string
  /** 仅 whitespace 类：该差异属于声明的允许变换，不参与 loss 判定。 */
  allowed?: boolean
}

export interface TruthStageVerdict {
  verdict: TruthVerdict
  findings: TruthFinding[]
}

export interface ChunkCoverageVerdict extends TruthStageVerdict {
  missingTokenSamples: string[]
  fabricatedTokenSamples: string[]
  coveredTruthLines: number
  totalTruthLines: number
}

export interface TextCompareOptions {
  /** 解码边界：允许剥离一个前导 BOM（仍作为 whitespace/allowed 记录）。 */
  allowLeadingBom?: boolean
}

const LINE_ENDINGS = /\r\n?/g
const DETAIL_MAX = 96

function truncate(detail: string): string {
  const single = detail.replace(/\s+/g, " ").trim()
  return single.length > DETAIL_MAX ? `${single.slice(0, DETAIL_MAX)}…` : single
}

function quote(value: string): string {
  return JSON.stringify(truncate(value))
}

/** 空白差异专用：保留空白字面（truncate 的空白折叠会把 "    " 显示成 ""）。 */
function quoteVerbatim(value: string): string {
  return JSON.stringify(value.length > DETAIL_MAX ? `${value.slice(0, DETAIL_MAX)}…` : value)
}

export function compareTextToTruth(
  truth: string,
  actual: string,
  options: TextCompareOptions = {}
): TruthStageVerdict {
  const findings: TruthFinding[] = []

  if (actual.includes("\0")) {
    findings.push({
      kind: "corruption",
      detail: "decoded text contains NUL bytes — encoding mismatch",
    })
    return { verdict: "corrupt", findings }
  }
  const replacementCount = (actual.match(/\uFFFD/g) ?? []).length
  if (replacementCount > 0) {
    findings.push({
      kind: "corruption",
      detail: `decoded text contains ${replacementCount} U+FFFD replacement character(s)`,
    })
    return { verdict: "corrupt", findings }
  }

  let actualText = actual.replace(LINE_ENDINGS, "\n")
  const truthText = truth.replace(LINE_ENDINGS, "\n")

  if (actualText.startsWith("\uFEFF") && !truthText.startsWith("\uFEFF")) {
    const allowed = options.allowLeadingBom === true
    findings.push({
      kind: "whitespace",
      detail: allowed
        ? "leading BOM stripped (declared allowed decode transform)"
        : "unexpected leading BOM in decoded text",
      ...(allowed ? { allowed: true } : {}),
    })
    if (allowed) actualText = actualText.slice(1)
  }

  const truthLines = truthText.split("\n")
  const actualLines = actualText.split("\n")

  // 逐行精确 LCS 配对（样本行数量有界，O(n·m) 可接受）。
  const exactPairs = longestCommonSubsequencePairs(truthLines, actualLines)
  const truthMatched = new Set<number>()
  const actualMatched = new Set<number>()
  for (const [truthIndex, actualIndex] of exactPairs) {
    truthMatched.add(truthIndex)
    actualMatched.add(actualIndex)
  }

  // 第二轮：非精确但"空白折叠后相同"的行配对 → whitespace 差异记录。
  const looseQueue = new Map<string, number[]>()
  for (let actualIndex = 0; actualIndex < actualLines.length; actualIndex += 1) {
    if (actualMatched.has(actualIndex)) continue
    const key = looseKey(actualLines[actualIndex])
    if (!key) continue
    const queue = looseQueue.get(key) ?? []
    queue.push(actualIndex)
    looseQueue.set(key, queue)
  }
  for (let truthIndex = 0; truthIndex < truthLines.length; truthIndex += 1) {
    if (truthMatched.has(truthIndex)) continue
    const key = looseKey(truthLines[truthIndex])
    const queue = key ? looseQueue.get(key) : undefined
    const actualIndex = queue?.shift()
    if (actualIndex === undefined) continue
    truthMatched.add(truthIndex)
    actualMatched.add(actualIndex)
    const whitespaceParts = whitespaceDiffParts(truthLines[truthIndex], actualLines[actualIndex])
    if (whitespaceParts.length === 0) {
      // 内容逐字相同却无法精确配对 → 只能是位置不同：顺序损失。
      findings.push({
        kind: "content",
        detail: `truth line ${truthIndex + 1} content found at a different position — order changed: ${quote(truthLines[truthIndex])}`,
      })
      continue
    }
    findings.push({
      kind: "whitespace",
      detail: `truth line ${truthIndex + 1} whitespace differs: ${whitespaceParts.join("; ")} (line: ${quote(truthLines[truthIndex])})`,
    })
  }

  for (let truthIndex = 0; truthIndex < truthLines.length; truthIndex += 1) {
    if (truthMatched.has(truthIndex)) continue
    const line = truthLines[truthIndex]
    if (!looseKey(line)) {
      findings.push({
        kind: "whitespace",
        detail: `blank line at truth line ${truthIndex + 1} was removed or merged`,
      })
      continue
    }
    findings.push({
      kind: "content",
      detail: `missing truth line ${truthIndex + 1}: ${quote(line)}`,
    })
  }
  for (let actualIndex = 0; actualIndex < actualLines.length; actualIndex += 1) {
    if (actualMatched.has(actualIndex)) continue
    const line = actualLines[actualIndex]
    if (!looseKey(line)) continue
    findings.push({
      kind: "fabrication",
      detail: `unexpected line at position ${actualIndex + 1}: ${quote(line)}`,
    })
  }

  const blocking = findings.some((finding) => !(finding.kind === "whitespace" && finding.allowed))
  return { verdict: blocking ? "loss" : "match", findings }
}

/** 清洗边界：同一比较规则，但不允许前导 BOM。 */
export function compareTransformedText(
  before: string,
  after: string
): TruthStageVerdict {
  return compareTextToTruth(before, after, { allowLeadingBom: false })
}

function longestCommonSubsequencePairs(
  left: string[],
  right: string[]
): Array<[number, number]> {
  const rows = left.length
  const columns = right.length
  const table: number[][] = Array.from(
    { length: rows + 1 },
    () => new Array<number>(columns + 1).fill(0)
  )
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < rows && j < columns) {
    if (left[i] === right[j]) {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1
    } else {
      j += 1
    }
  }
  return pairs
}

function looseKey(line: string): string {
  return line.replace(/\s+/g, " ").trim()
}

function leadingWhitespaceOf(line: string): string {
  const match = /^\s*/.exec(line)
  return match ? match[0] : ""
}

function trailingWhitespaceOf(line: string): string {
  const match = /\s*$/.exec(line)
  return match ? match[0] : ""
}

function whitespaceDiffParts(
  expected: string,
  actual: string
): string[] {
  const expectedLeading = leadingWhitespaceOf(expected)
  const actualLeading = leadingWhitespaceOf(actual)
  const expectedTrailing = trailingWhitespaceOf(expected)
  const actualTrailing = trailingWhitespaceOf(actual)
  const parts: string[] = []
  if (expectedLeading !== actualLeading) {
    parts.push(`leading whitespace expected ${quoteVerbatim(expectedLeading)}, got ${quoteVerbatim(actualLeading)}`)
  }
  if (expectedTrailing !== actualTrailing) {
    parts.push(`trailing whitespace expected ${quoteVerbatim(expectedTrailing)}, got ${quoteVerbatim(actualTrailing)}`)
  }
  const expectedInner = expected.trim().replace(/\s+/g, " ")
  const actualInner = actual.trim().replace(/\s+/g, " ")
  if (!parts.length && expectedInner !== actualInner) {
    parts.push("inner spacing differs")
  }
  return parts
}

// ---- 切块边界：词元覆盖 ----

const CJK_RANGES = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/

/**
 * eval-text-v1 风格词元：拉丁/数字连续段为词级 token（保留内部 ._-/ 连接），
 * CJK 每字一个 token；小写化。空白不产生 token（空白保真由文本边界负责）。
 */
export function tokenizeForCoverage(text: string): string[] {
  const tokens: string[] = []
  const runs = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  for (const run of runs) {
    let buffer = ""
    for (const character of run) {
      if (CJK_RANGES.test(character)) {
        if (buffer) {
          tokens.push(buffer)
          buffer = ""
        }
        tokens.push(character)
      } else {
        buffer += character
      }
    }
    if (buffer) tokens.push(buffer)
  }
  return tokens
}

function incrementCounts(counts: Map<string, number>, tokens: string[]): void {
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
}

export function checkChunkCoverage(
  sourceTruth: string,
  chunkTexts: string[]
): ChunkCoverageVerdict {
  const findings: TruthFinding[] = []
  const truthTokens = tokenizeForCoverage(sourceTruth)
  const truthCounts = new Map<string, number>()
  incrementCounts(truthCounts, truthTokens)

  const available = new Map<string, number>()
  const chunkTokenStreams = chunkTexts.map((chunkText) => tokenizeForCoverage(chunkText))
  for (const tokens of chunkTokenStreams) {
    incrementCounts(available, tokens)
  }

  const missingTokenSamples: string[] = []
  for (const [token, count] of truthCounts) {
    if ((available.get(token) ?? 0) < count && missingTokenSamples.length < 8) {
      missingTokenSamples.push(token)
    }
  }
  if (missingTokenSamples.length > 0) {
    findings.push({
      kind: "content",
      detail: `chunk reconstruction is missing tokens: ${missingTokenSamples.map(quote).join(", ")}`,
    })
  }

  const fabricatedTokenSamples: string[] = []
  for (const tokens of chunkTokenStreams) {
    for (const token of tokens) {
      if (!truthCounts.has(token) && !fabricatedTokenSamples.includes(token) &&
        fabricatedTokenSamples.length < 8) {
        fabricatedTokenSamples.push(token)
      }
    }
  }
  if (fabricatedTokenSamples.length > 0) {
    findings.push({
      kind: "fabrication",
      detail: `chunks contain tokens absent from the source: ${fabricatedTokenSamples.map(quote).join(", ")}`,
    })
  }

  // 信息项：多少条真值行能作为连续词元子序列在某个 chunk 中找到。
  let coveredTruthLines = 0
  let totalTruthLines = 0
  for (const line of sourceTruth.split("\n")) {
    const key = looseKey(line)
    if (!key) continue
    totalTruthLines += 1
    const lineTokens = tokenizeForCoverage(key)
    if (lineTokens.length === 0) continue
    const covered = chunkTokenStreams.some((stream) =>
      containsContiguousSubsequence(stream, lineTokens)
    )
    if (covered) coveredTruthLines += 1
  }

  return {
    verdict: findings.length > 0 ? "loss" : "match",
    findings,
    missingTokenSamples,
    fabricatedTokenSamples,
    coveredTruthLines,
    totalTruthLines,
  }
}

function containsContiguousSubsequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) return true
  if (needle.length > haystack.length) return false
  outer: for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer
    }
    return true
  }
  return false
}
