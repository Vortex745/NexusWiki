// UT-10：保真 TXT 路径（直接解码 + 保守清洗）。
//
// 契约（UP-05 AC 1/2/3/5，经 10 票继承）：纯文本不再经过通用 CLI 和
// Markdown 归一化——那条路在提取边界就剥行尾空格、在清洗边界把字面
// `#`/`**`/`|` 当排版解释、逐行 trim 掉代码缩进。本路径在进程内解码：
//
// - 编码证据：BOM（UTF-8/UTF-16LE/UTF-16BE）或严格 UTF-8 解码成功；
//   两者都没有时按 GBK 回退猜测，但猜测不算成功——记 ambiguous_encoding
//   待校验。解码器替换字符（corrupt_bytes）与文件原有合法 U+FFFD
//   （legitimate_replacement_char_present）分别记录，不混为一谈。
// - 只做两项已约定的排版变换：剥单个前导 BOM、CRLF/CR → LF。不逐行
//   trim、不折叠空行、不把 TXT 中的 Markdown 标题/链接/列表/表格符号
//   当标记删除；词间空格、代码缩进、制表、数字、顺序与有效重复原样保留。
// - 全文保持一个 paragraph 块，清洗来源（decode provenance）随块
//   metadata 流入切块与文档 metadata，可追溯。
import { createHash } from "node:crypto"
import type { NormalizedBlock } from "../../types"
import type { ParseDocumentInput } from "./markitdown"

export interface TextDecodeProvenance {
  /** 实际使用的解码标签（"utf-8" | "utf-16le" | "utf-16be" | "gbk" | "unknown"）。 */
  encoding: string
  /** 编码证据等级：BOM > 严格 UTF-8 > 回退猜测。 */
  evidence: "bom" | "strict-utf8" | "fallback-guess" | "unknown"
  /** 实际应用的已约定变换（按序）——未触发的变换不记录。 */
  allowedTransforms: string[]
  /** 诚实警告（解码引入的替换字符、模糊编码猜测等）。 */
  warnings: string[]
  /** 待校验标记：模糊编码或损坏字节时为 true，绝不以非空字符串判完整。 */
  reviewRequired: boolean
  reviewReason?: "ambiguous_encoding" | "corrupt_bytes" | "legitimate_replacement_char_present"
}

/** 本路径唯一允许的清洗变换（与 golden/upload-truth/txt 的允许清单一致）。 */
const ALLOWED_TRANSFORMS = ["strip single leading BOM", "CRLF/CR -> LF"]

type DecodeOutcome = {
  text: string
  provenance: Omit<TextDecodeProvenance, "allowedTransforms">
}

/** 带编码声明的解码：fatal 失败退回非 fatal，替换字符如实记警告。 */
function decodeDeclared(bytes: Buffer, encoding: string, evidence: "bom"): DecodeOutcome {
  try {
    return {
      text: new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes),
      provenance: { encoding, evidence, warnings: [], reviewRequired: false },
    }
  } catch {
    return {
      text: new TextDecoder(encoding, { ignoreBOM: true }).decode(bytes),
      provenance: {
        encoding,
        evidence,
        reviewRequired: true,
        reviewReason: "corrupt_bytes",
        warnings: [
          `bytes do not form valid ${encoding} despite the BOM; the decoder introduced U+FFFD replacement characters`,
        ],
      },
    }
  }
}

/**
 * 解码原始字节（UT-10 的提取边界）。返回解码后的文本（BOM 与原行尾
 * 保留——清洗才应用已约定变换）与解码证据。绝不静默把模糊编码当成功。
 */
export function decodeTextBytes(bytes: Buffer): DecodeOutcome {
  // 1) BOM 是最强编码证据。
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decodeDeclared(bytes, "utf-16le", "bom")
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeDeclared(bytes, "utf-16be", "bom")
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decodeDeclared(bytes, "utf-8", "bom")
  }
  // 2) 无 BOM：严格 UTF-8 解码成功即是证据（无效字节序列不可能碰巧通过）。
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    if (text.includes("\uFFFD")) {
      // 文件里本来就有 U+FFFD：合法替换符号，不是本次解码引入的——
      // 与解码错误分开记录，但内容确实带损坏证据，明确待校验。
      return {
        text,
        provenance: {
          encoding: "utf-8",
          evidence: "strict-utf8",
          reviewRequired: true,
          reviewReason: "legitimate_replacement_char_present",
          warnings: [
            "U+FFFD is present in the original bytes (a legitimate replacement character carried by the file, not introduced by this decode)",
          ],
        },
      }
    }
    return {
      text,
      provenance: { encoding: "utf-8", evidence: "strict-utf8", warnings: [], reviewRequired: false },
    }
  } catch {
    // 无 BOM 且不是有效 UTF-8：GBK 回退猜测（东亚环境最常见的旧编码）。
  }
  // 3) GBK 猜测：解得干净也只能记 ambiguous_encoding 待校验（可能是
  //    Big5/Shift-JIS/Latin-1 等，无法确认）；解不干净记 corrupt_bytes。
  try {
    const text = new TextDecoder("gbk", { fatal: true }).decode(bytes)
    return {
      text,
      provenance: {
        encoding: "gbk",
        evidence: "fallback-guess",
        reviewRequired: true,
        reviewReason: "ambiguous_encoding",
        warnings: [
          "no BOM and the bytes are not valid UTF-8; decoded as GBK by fallback guess — the encoding could not be confirmed and the result is pending review",
        ],
      },
    }
  } catch {
    return {
      text: new TextDecoder("gbk").decode(bytes),
      provenance: {
        encoding: "gbk",
        evidence: "fallback-guess",
        reviewRequired: true,
        reviewReason: "corrupt_bytes",
        warnings: [
          "bytes are not valid UTF-8 or GBK; the decoder introduced U+FFFD replacement characters",
        ],
      },
    }
  }
}

function blockId(documentId: string, text: string): string {
  return createHash("sha256")
    .update(`${documentId}\0${0}\0paragraph\0${text}`, "utf8")
    .digest("hex")
}

export class DirectTextParser {
  readonly type = "direct-txt" as const
  private lastDecode: TextDecodeProvenance | null = null

  async parse(input: ParseDocumentInput): Promise<NormalizedBlock[]> {
    const raw = await this.parseRaw(input)
    return this.normalizeRaw(raw, input.documentId)
  }

  /**
   * UT-10 truth seam: decode the bytes and return the decoded text BEFORE
   * cleaning — BOM and original line endings retained — so the durable
   * evidence record holds the honest extraction output. No behavior change
   * for parse().
   */
  async parseRaw(
    input: Omit<ParseDocumentInput, "documentId">
  ): Promise<string> {
    const outcome = decodeTextBytes(input.content)
    this.lastDecode = { ...outcome.provenance, allowedTransforms: [...ALLOWED_TRANSFORMS] }
    return outcome.text
  }

  /**
   * UT-10 conservative cleaning: only the two agreed typography transforms
   * (strip one leading BOM, CRLF/CR → LF). No per-line trimming, no markdown
   * interpretation, no blank-line collapsing — the whole cleaned text stays
   * ONE paragraph block, so word spaces, code indentation, tab meaning,
   * numbers, order, valid repetition and literal `#`/`**`/`|` syntax all
   * survive. The decode provenance rides on block metadata into chunks and
   * document metadata.
   */
  normalizeRaw(raw: string, documentId: string): NormalizedBlock[] {
    let cleaned = raw
    const applied: string[] = []
    if (cleaned.startsWith("\uFEFF")) {
      cleaned = cleaned.slice(1)
      applied.push("strip single leading BOM")
    }
    if (/\r\n?/.test(cleaned)) {
      cleaned = cleaned.replace(/\r\n?/g, "\n")
      applied.push("CRLF/CR -> LF")
    }
    if (!cleaned.trim()) {
      throw new Error(
        "direct-txt produced no text content (the file is empty or whitespace-only)"
      )
    }
    const decode: TextDecodeProvenance = this.lastDecode
      ? { ...this.lastDecode, allowedTransforms: applied }
      : { encoding: "unknown", evidence: "unknown", allowedTransforms: applied, warnings: [], reviewRequired: false }
    // Reconcile: extraction provenance reports the transforms ACTUALLY applied
    // by this cleaning pass (the same object the block metadata carries).
    this.lastDecode = decode
    return [
      {
        id: blockId(documentId, cleaned),
        index: 0,
        type: "paragraph",
        text: cleaned,
        sectionPath: [],
        metadata: { decode },
        provenance: { parser: "direct-txt", adapter: "in-process" },
      },
    ]
  }

  /**
   * UT-10: extraction-level provenance of the last parseRaw — the pipeline
   * merges `metadata` into document metadata.system and `warnings` into the
   * durable extraction evidence record.
   */
  extractionProvenance(): { metadata: Record<string, unknown>; warnings: string[] } | null {
    if (!this.lastDecode) return null
    return {
      metadata: { decode: { ...this.lastDecode } },
      warnings: [...this.lastDecode.warnings],
    }
  }
}
