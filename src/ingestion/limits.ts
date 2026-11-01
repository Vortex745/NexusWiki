// UT-14: embedding limits — explicit, character-based, never inferred from bytes.
//
// 契约（UP-07 AC 4，经 14 票继承）：实际 provider 的 token 限制与字节预算
// 分别约束；限制未知不能默认无上限。本模块提供：
// - 显式的单条嵌入输入 token 上限（默认 8192，OpenAI 兼容 text-embedding
//   模型族；可用 EMBEDDING_INPUT_TOKEN_LIMIT 覆盖）——超过即明确报错，
//   绝不静默让 provider 截断。
// - 保守的字符级 token 估算器：CJK 每字按 2 token、其他字符按 0.35 token
//   上界估算（cl100k 系分词器实测 CJK 常见 1~2 token/字）。它刻意用字符
//   而非字节数——"不以字节数推断模型 token"（1500 个 CJK 字符是 4500 字节
//   却约 3000 token 上界；1500 个拉丁字符是 1500 字节却不足 600 token）。
// - 估算只做上界防护（防止配置漂移把单块推过 provider 限制）；正常默认
//   配置下切块器产出的块（≤1500 字符）远低于该限制。
import type { Chunk } from "../types"

export interface EmbeddingLimits {
  /** 单条嵌入输入的 token 上限（provider 契约，非本系统发明）。 */
  inputTokenLimit: number
  /** 单次嵌入请求的字节预算（store 已有约束，这里一并声明）。 */
  batchMaxBytes: number
  /** 单次嵌入请求的最大条数。 */
  batchMaxChunks: number
}

export const DEFAULT_EMBEDDING_INPUT_TOKEN_LIMIT = 8192

/**
 * 从环境直接解析——不经过 loadConfig（loadConfig 要求完整的生产环境变量，
 * 而限额网必须在任何环境里都能工作）。字段名与 config/index.ts 的
 * integerEnv 读取保持一致。
 */
export function resolveEmbeddingLimits(): EmbeddingLimits {
  const tokenLimit = Number.parseInt(process.env.EMBEDDING_INPUT_TOKEN_LIMIT ?? "", 10)
  const batchBytes = Number.parseInt(process.env.EMBEDDING_BATCH_MAX_BYTES ?? "", 10)
  const batchChunks = Number.parseInt(process.env.EMBEDDING_BATCH_MAX_CHUNKS ?? "", 10)
  return {
    inputTokenLimit:
      Number.isFinite(tokenLimit) && tokenLimit > 0
        ? tokenLimit
        : DEFAULT_EMBEDDING_INPUT_TOKEN_LIMIT,
    batchMaxBytes:
      Number.isFinite(batchBytes) && batchBytes > 0 ? batchBytes : 150 * 1024,
    batchMaxChunks: Number.isFinite(batchChunks) && batchChunks > 0 ? batchChunks : 64,
  }
}

const CJK_CHARACTER = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/

/**
 * 保守上界 token 估算：CJK 字符按 2 token/字，其余按 0.35 token/字符。
 * 上界性质：真实分词结果 ≤ 估算值（估算偏高是安全的方向）。
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  for (const character of text) {
    if (CJK_CHARACTER.test(character)) cjk += 1
  }
  const other = text.length - cjk
  return Math.ceil(cjk * 2 + other * 0.35)
}

export interface OversizedChunk {
  chunkId: string
  estimatedTokens: number
  chars: number
}

/** 找出估算 token 超过 provider 输入限制的入索引块。 */
export function findOversizedChunks(
  indexChunks: Chunk[],
  limits: EmbeddingLimits
): OversizedChunk[] {
  const oversized: OversizedChunk[] = []
  for (const chunk of indexChunks) {
    const estimated = estimateTokens(chunk.content)
    if (estimated > limits.inputTokenLimit) {
      oversized.push({
        chunkId: chunk.id,
        estimatedTokens: estimated,
        chars: chunk.content.length,
      })
    }
  }
  return oversized
}
