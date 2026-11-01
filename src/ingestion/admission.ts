// UT-05：文件准入的类型一致性检查（字节签名 vs 声明类型）。
//
// 契约（UP-02 / UT-05）：准入以实际字节、文件名、现有大小限制和格式特征共同
// 判定；明确类型伪装在进入解析前被稳定拒绝。MIME 只是声明——通用二进制声明
// （application/octet-stream）不得让文本样本被误判，真正的判定依据是字节。
// 模糊/旧编码（UTF-16、GBK 等）是文本，不在此拒绝——它们属于 UT-10 的
// 待校验范围，不是类型伪装。

/** 文件类：路由与 override 兼容性判定共用（UT-06 也消费）。 */
export type AdmittedFileClass = "pdf" | "image" | "text" | "unknown"

export interface TypeConflict {
  /** 稳定错误码（错误响应的 kind 字段）。 */
  kind: "type_conflict"
  /** 机器可读的检测结论，例如 "binary_signature_pdf"。 */
  detected: string
  message: string
}

interface ByteSignature {
  detected: string
  fileClass: Exclude<AdmittedFileClass, "unknown"> | "zip-container" | "executable"
}

function detectByteSignature(bytes: Buffer): ByteSignature | null {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
    return { detected: "binary_signature_pdf", fileClass: "pdf" }
  }
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
    bytes[2] === 0x03 && bytes[3] === 0x04) {
    return { detected: "binary_signature_zip_container", fileClass: "zip-container" }
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 &&
    bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { detected: "binary_signature_png", fileClass: "image" }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { detected: "binary_signature_jpeg", fileClass: "image" }
  }
  if (bytes.length >= 6 && bytes.subarray(0, 3).toString("latin1") === "GIF") {
    return { detected: "binary_signature_gif", fileClass: "image" }
  }
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    return { detected: "binary_signature_windows_executable", fileClass: "executable" }
  }
  return null
}

const TEXT_EXTENSIONS = new Set([
  ".csv", ".doc", ".docx", ".epub", ".htm", ".html", ".json", ".md",
  ".markdown", ".ppt", ".pptx", ".rtf", ".txt", ".xls", ".xlsx", ".xml",
])

function declaredClassFromName(fileName: string): AdmittedFileClass {
  const extension = fileName.toLowerCase().match(/\.[a-z0-9]{1,10}$/)?.[0] ?? ""
  if (extension === ".pdf") return "pdf"
  if ([".bmp", ".heic", ".jpeg", ".jpg", ".png", ".tif", ".tiff"].includes(extension)) {
    return "image"
  }
  if (TEXT_EXTENSIONS.has(extension)) return "text"
  return "unknown"
}

/**
 * 判定声明的类型与实际字节是否明确冲突。返回 null 表示没有可判定的伪装
 * （类型未知或一致——无法确认的情况不在这里下结论，由路由决定）。
 *
 * 设计边界：
 * - MIME 声明只作旁证；application/octet-stream 等通用声明不会让文本样本
 *   被误判，也不会让伪装文件被放行——判定只看字节 vs 文件名。
 * - UTF-16/GBK 等旧编码文本是文本：不在伪装检查范围（UT-10 待校验）。
 */
export function detectTypeConflict(fileName: string, bytes: Buffer): TypeConflict | null {
  if (bytes.length === 0) return null
  const signature = detectByteSignature(bytes)
  const declared = declaredClassFromName(fileName)

  if (signature && declared === "text") {
    return {
      kind: "type_conflict",
      detected: signature.detected,
      message: `文件名声明为文本类型（${fileName}），但字节是 ${signature.detected}；请在进入解析前修正类型`,
    }
  }
  if (declared === "pdf" && !signature) {
    // 声明为 PDF 却没有任何已知二进制签名：若字节明显是文本（可打印为主），
    // 是"文本伪装成 PDF"，拒绝；否则无法确认，交给路由/解析如实失败。
    if (looksLikeText(bytes)) {
      return {
        kind: "type_conflict",
        detected: "text_content_declared_pdf",
        message: `文件名声明为 PDF（${fileName}），但字节是文本内容，不是 %PDF- 结构`,
      }
    }
  }
  return null
}

/** 采样判定字节是否以可打印/常见控制字符为主（前 4KB 与中间采样）。 */
function looksLikeText(bytes: Buffer): boolean {
  const samples: Array<number> = []
  const stride = Math.max(1, Math.floor(bytes.length / 2048))
  for (let offset = 0; offset < bytes.length && samples.length < 4096; offset += stride) {
    samples.push(bytes[offset])
  }
  if (samples.length === 0) return false
  let printable = 0
  for (const byte of samples) {
    // 可打印 ASCII/Latin、常见空白、UTF-8 多字节高位字节都算"文本样"。
    if ((byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a ||
      byte === 0x0d || byte >= 0x80) {
      printable += 1
    }
  }
  return printable / samples.length >= 0.95
}
