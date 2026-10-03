// UT-01 独立真值样本生成器。
// 设计原则：真值（truthText）由本文件逐字设计，与待测提取完全独立；
// 样本字节与真值哈希写入 truth-manifest.json，测试只核对哈希一致性，
// 绝不从被测管线输出反推真值。
// 运行：node golden/upload-truth/txt/generate.mjs
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))

const sha256 = (value) => createHash("sha256").update(value).digest("hex")

// ---- 共享基础内容（utf8-baseline / utf8-bom / utf16le / utf16be 同文） ----
// 覆盖：中英混排、数值、否定、顺序（步骤一/二/三）、行首缩进、字面 Markdown
// 记号、有效重复（同一行三次）、结尾校验词。
const BASE_TEXT = [
  "退货政策真值样本 v1",
  "Return Policy Truth Sample",
  "",
  "订单编号：A-2026-1004",
  "不支持七天无理由退款的条件包括：定制商品与激活类数字商品。",
  "Support contact: support@example.com，电话 400-000-0000。",
  "",
  "步骤一：登录账户",
  "步骤二：打开订单详情",
  "步骤三：点击申请退款",
  "",
  "以下为示例配置（行首缩进必须保留）：",
  "    retry_limit = 3",
  "    timeout_ms = 1500",
  "        nested_flag = true",
  "",
  "字面记号：# 一级标记 **加粗** `code`",
  "重复行（有效重复，原样出现三次）：",
  "同一行内容原样重复",
  "同一行内容原样重复",
  "同一行内容原样重复",
  "",
  "结尾校验词：终线-42",
  "",
].join("\n")

// ---- CRLF + 缩进样本 ----
const CRLF_LINES = [
  "配置片段（CRLF 与缩进保持样本）：",
  "    server_port = 8080",
  "        ssl_enabled = false",
  "行尾空格行：   ",
  "否定校验：不启用自动重试。",
]
const CRLF_TEXT = CRLF_LINES.join("\n") + "\n"
const CRLF_BYTES = Buffer.from(CRLF_TEXT, "utf8")
  .toString("utf8")
  .replace(/\n/g, "\r\n")
const CRLF_TRUTH = CRLF_TEXT // 真值按 LF 登记；CRLF→LF 是唯一允许的解码变换

// ---- 字面 Markdown 样本 ----
// 井号/双星号/竖线在此是"内容"而不是结构：字面语义必须原样保留。
const LITERAL_MARKDOWN_TEXT = [
  "# 这一行以井号开头，井号属于内容",
  "**双星号必须原样保留**",
  "1. 第一项",
  "2. 第二项",
  "|列A|列B|",
  "|---|---|",
  "|甲|乙|",
  "",
].join("\n")

// ---- 旧编码（GBK）样本 ----
// 字节为独立预计算结果（CRLF 行尾），此处按十六进制固定，保证生成确定性：
// 旧编码真值样本：订单不支持改址，请在工作日 9:00-18:00 联系客服。
// 缩进行必须保留：
//     配置项 = 启用
const GBK_HEX =
  "bec9b1e0c2ebd5e6d6b5d1f9b1bea3bab6a9b5a5b2bbd6a7b3d6b8c4d6b7a3acc7ebd4dab9a4" +
  "d7f7c8d520393a30302d31383a303020c1aacfb5bfcdb7fea1a30d0acbf5bdf8d0d0b1d8d0eb" +
  "b1a3c1f4a3ba0d0a20202020c5e4d6c3cfee203d20c6f4d3c30d0a"
const GBK_TRUTH = [
  "旧编码真值样本：订单不支持改址，请在工作日 9:00-18:00 联系客服。",
  "缩进行必须保留：",
  "    配置项 = 启用",
  "",
].join("\n")

// ---- 长段落样本：单行约 1500 字符 + 有效重复块 ----
const LONG_UNITS = [
  "第{n}条规则说明：金额上限为{n}00元，且不支持跨店抵扣。",
  "处理时限为{n}个工作日，节假日顺延并另行通知。",
]
let longSentence = ""
for (let index = 1; longSentence.length < 1500; index += 1) {
  longSentence += LONG_UNITS[index % 2 === 0 ? 0 : 1].replaceAll("{n}", String(index))
}
const LONG_TEXT = [
  longSentence,
  "",
  "重复结论（原样出现三次）：",
  "长段落结尾校验词：终线-LONG-77",
  "长段落结尾校验词：终线-LONG-77",
  "长段落结尾校验词：终线-LONG-77",
  "",
].join("\n")

const utf16Bytes = (text, endian) => {
  const withBom = `\uFEFF${text}`
  const buffer = Buffer.from(withBom, "utf16le")
  if (endian === "le") return buffer
  const swapped = Buffer.alloc(buffer.length)
  for (let offset = 0; offset < buffer.length; offset += 2) {
    swapped[offset] = buffer[offset + 1]
    swapped[offset + 1] = buffer[offset]
  }
  return swapped
}

const samples = [
  {
    id: "utf8-baseline",
    file: "utf8-baseline.txt",
    encoding: "utf-8",
    bom: false,
    lineEnding: "lf",
    truthText: BASE_TEXT,
    decodeExpectation: "exact",
    bytes: Buffer.from(BASE_TEXT, "utf8"),
    mustPreserve: ["word-spaces", "indentation", "numbers", "negation", "order", "repetition"],
  },
  {
    id: "utf8-bom",
    file: "utf8-bom.txt",
    encoding: "utf-8",
    bom: true,
    lineEnding: "lf",
    truthText: BASE_TEXT,
    decodeExpectation: "exact_modulo_leading_bom",
    bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(BASE_TEXT, "utf8")]),
    mustPreserve: ["word-spaces", "indentation", "numbers", "negation", "order", "repetition"],
  },
  {
    id: "utf16le-bom",
    file: "utf16le-bom.txt",
    encoding: "utf-16le",
    bom: true,
    lineEnding: "lf",
    truthText: BASE_TEXT,
    decodeExpectation: "exact_modulo_leading_bom",
    bytes: utf16Bytes(BASE_TEXT, "le"),
    mustPreserve: ["word-spaces", "indentation", "numbers", "negation", "order", "repetition"],
  },
  {
    id: "utf16be-bom",
    file: "utf16be-bom.txt",
    encoding: "utf-16be",
    bom: true,
    lineEnding: "lf",
    truthText: BASE_TEXT,
    decodeExpectation: "exact_modulo_leading_bom",
    bytes: utf16Bytes(BASE_TEXT, "be"),
    mustPreserve: ["word-spaces", "indentation", "numbers", "negation", "order", "repetition"],
  },
  {
    id: "legacy-gbk",
    file: "legacy-gbk.txt",
    encoding: "gbk",
    bom: false,
    lineEnding: "crlf",
    truthText: GBK_TRUTH,
    // 模糊/旧编码：正确行为是"待校验"，当前行为如实记录，不允许伪装成功。
    decodeExpectation: "pending_review_allowed",
    bytes: Buffer.from(GBK_HEX, "hex"),
    mustPreserve: ["word-spaces", "numbers", "negation", "indentation"],
  },
  {
    id: "crlf-indent",
    file: "crlf-indent.txt",
    encoding: "utf-8",
    bom: false,
    lineEnding: "crlf",
    truthText: CRLF_TRUTH,
    decodeExpectation: "exact_after_crlf_normalization",
    bytes: Buffer.from(CRLF_BYTES, "utf8"),
    mustPreserve: ["indentation", "trailing-spaces-recorded", "numbers", "negation"],
  },
  {
    id: "literal-markdown",
    file: "literal-markdown.txt",
    encoding: "utf-8",
    bom: false,
    lineEnding: "lf",
    truthText: LITERAL_MARKDOWN_TEXT,
    decodeExpectation: "exact",
    bytes: Buffer.from(LITERAL_MARKDOWN_TEXT, "utf8"),
    mustPreserve: ["literal-markers", "order", "table-pipes-as-content"],
  },
  {
    id: "long-paragraph",
    file: "long-paragraph.txt",
    encoding: "utf-8",
    bom: false,
    lineEnding: "lf",
    truthText: LONG_TEXT,
    decodeExpectation: "exact",
    bytes: Buffer.from(LONG_TEXT, "utf8"),
    mustPreserve: ["numbers", "repetition", "no-truncation", "order"],
  },
]

const manifest = {
  manifestVersion: "ut01-txt-truth-v1",
  annotationMethod: "designed",
  designNote:
    "真值文本由本目录 generate.mjs 逐字设计，与被测提取管线完全独立；" +
    "哈希把样本字节与真值文本固定下来。比较规则不得删除全部空白来掩盖损失。",
  allowedDecodeTransforms: [
    "strip single leading BOM (recorded as whitespace-class finding)",
    "CRLF/CR -> LF line-ending normalization",
  ],
  samples: samples.map((sample) => ({
    id: sample.id,
    file: sample.file,
    encoding: sample.encoding,
    bom: sample.bom,
    lineEnding: sample.lineEnding,
    fileSha256: sha256(sample.bytes),
    fileBytes: sample.bytes.length,
    truthSha256: sha256(sample.truthText, "utf8"),
    truthText: sample.truthText,
    decodeExpectation: sample.decodeExpectation,
    mustPreserve: sample.mustPreserve,
  })),
}

mkdirSync(here, { recursive: true })
for (const sample of samples) {
  writeFileSync(join(here, sample.file), sample.bytes)
}
writeFileSync(join(here, "truth-manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
console.log(`wrote ${samples.length} samples + truth-manifest.json`)
