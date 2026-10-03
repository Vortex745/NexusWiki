// UT-16: index manifest verification.
//
// 契约（UP-09 AC 1/2/5，经 16 票产生）：索引逐项写入与期望来源块一致——
// 逻辑身份、期望数量、正文哈希、向量缺一不可；同数量错正文、漏一块、
// 缺向量或出现期望之外的条目都不能通过，并给出稳定失败原因；条目校验
// ≠索引可见或全文完整（可见性/检索证明属于 UT-17 的联合门槛）。
import { createHash } from "node:crypto"

export interface IndexEntrySnapshot {
  /** ES 中的正文（逐字），本地重算哈希比对。 */
  content: string | null
  embedding: number[] | null
}

export interface ExpectedManifestEntry {
  chunkId: string
  contentSha256: string
}

export interface IndexVerificationResult {
  verdict: "pass" | "fail"
  reasonCodes: string[]
  expectedCount: number
  verifiedCount: number
  missingChunkIds: string[]
  contentMismatchChunkIds: string[]
  missingVectorChunkIds: string[]
  extraEntryCount: number
  verifiedAt: string
}

export function verifyIndexEntries(input: {
  expected: ExpectedManifestEntry[]
  /** chunkId → ES 快照（未找到的 chunkId 不在 Map 中）。 */
  entries: Map<string, IndexEntrySnapshot>
}): IndexVerificationResult {
  const missingChunkIds: string[] = []
  const contentMismatchChunkIds: string[] = []
  const missingVectorChunkIds: string[] = []
  let verifiedCount = 0

  for (const expected of input.expected) {
    const entry = input.entries.get(expected.chunkId)
    if (!entry) {
      missingChunkIds.push(expected.chunkId)
      continue
    }
    const actualHash = entry.content === null
      ? null
      : createHash("sha256").update(Buffer.from(entry.content, "utf8")).digest("hex")
    if (actualHash !== expected.contentSha256) {
      contentMismatchChunkIds.push(expected.chunkId)
      continue
    }
    if (!entry.embedding || entry.embedding.length === 0) {
      missingVectorChunkIds.push(expected.chunkId)
      continue
    }
    verifiedCount += 1
  }

  const extraEntryCount = [...input.entries.keys()].filter(
    (chunkId) => !input.expected.some((expected) => expected.chunkId === chunkId)
  ).length

  const reasonCodes: string[] = []
  if (missingChunkIds.length > 0) reasonCodes.push("index_missing_chunks")
  if (contentMismatchChunkIds.length > 0) reasonCodes.push("index_content_hash_mismatch")
  if (missingVectorChunkIds.length > 0) reasonCodes.push("index_missing_vectors")
  if (extraEntryCount > 0) reasonCodes.push("index_extra_entries")

  return {
    verdict: reasonCodes.length === 0 ? "pass" : "fail",
    reasonCodes,
    expectedCount: input.expected.length,
    verifiedCount,
    missingChunkIds,
    contentMismatchChunkIds,
    missingVectorChunkIds,
    extraEntryCount,
    verifiedAt: new Date().toISOString(),
  }
}

export interface EsIndexReader {
  (documentId: string, chunkIds: string[]): Promise<Map<string, IndexEntrySnapshot>>
}

/**
 * 生产 reader：按逻辑身份批量读取 ES（_id = `${documentId}:${chunkId}`），
 * 只取 content 与 embedding。返回以 chunkId（无前缀）为键。
 */
export function createEsIndexReader(es: {
  mget: (request: Record<string, unknown>) => Promise<unknown>
}, indexName: string): EsIndexReader {
  return async (documentId, chunkIds) => {
    const entries = new Map<string, IndexEntrySnapshot>()
    if (chunkIds.length === 0) return entries
    const result = await es.mget({
      index: indexName,
      ids: chunkIds.map((chunkId) => `${documentId}:${chunkId}`),
      _source: ["content", "embedding"],
    }) as {
      docs?: Array<{
        _id?: string
        found?: boolean
        _source?: { content?: unknown; embedding?: unknown }
      }>
    }
    const prefix = `${documentId}:`
    for (const doc of result.docs ?? []) {
      if (!doc.found || typeof doc._id !== "string" || !doc._id.startsWith(prefix)) continue
      const chunkId = doc._id.slice(prefix.length)
      const source = doc._source ?? {}
      entries.set(chunkId, {
        content: typeof source.content === "string" ? source.content : null,
        embedding: Array.isArray(source.embedding)
          ? (source.embedding as number[])
          : null,
      })
    }
    return entries
  }
}
