import { createHash } from "node:crypto"
import type { AnswerReference, Evidence, RetrievalResult } from "../types"

const EXCERPT_LIMIT = 600

function stableEvidenceId(result: RetrievalResult): string {
  return `ev_${createHash("sha256")
    .update(`${result.chunk.documentId}\0${result.chunk.id}`, "utf8")
    .digest("hex")
    .slice(0, 16)}`
}

function blockLocation(metadata: Record<string, unknown>): {
  page?: number
  sectionPath?: string[]
} {
  const directPage = Number.isInteger(metadata.page) && (metadata.page as number) > 0
    ? metadata.page as number
    : undefined
  const directSectionPath = Array.isArray(metadata.sectionPath) &&
      metadata.sectionPath.every((item) => typeof item === "string")
    ? metadata.sectionPath as string[]
    : undefined
  if (directPage !== undefined || directSectionPath !== undefined) {
    return { page: directPage, sectionPath: directSectionPath }
  }
  if (!Array.isArray(metadata.normalizedBlocks)) return {}
  for (const value of metadata.normalizedBlocks) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const block = value as Record<string, unknown>
    const page = Number.isInteger(block.page) && (block.page as number) > 0
      ? block.page as number
      : undefined
    const sectionPath = Array.isArray(block.sectionPath) &&
        block.sectionPath.every((item) => typeof item === "string")
      ? block.sectionPath as string[]
      : undefined
    if (page !== undefined || sectionPath !== undefined) return { page, sectionPath }
  }
  return {}
}

function imageReference(metadata: Record<string, unknown>): Evidence["image"] {
  if (!metadata.image || typeof metadata.image !== "object" || Array.isArray(metadata.image)) {
    return undefined
  }
  const image = metadata.image as Record<string, unknown>
  const assetId = typeof image.assetId === "string" &&
      /^sha256:[a-f0-9]{64}$/.test(image.assetId)
    ? image.assetId
    : undefined
  const assetPath = typeof image.assetPath === "string" &&
      /^[a-f0-9]{64}\.[a-z0-9]{1,10}$/.test(image.assetPath)
    ? image.assetPath
    : undefined
  const sourceReference = typeof image.sourceReference === "string" &&
      image.sourceReference.length <= 512
    ? image.sourceReference
    : undefined
  const captions = Array.isArray(image.captions)
    ? image.captions.filter((item): item is string =>
        typeof item === "string" && item.length > 0 && item.length <= 512
      ).slice(0, 8)
    : []
  if (!assetId && !assetPath && !sourceReference && captions.length === 0) return undefined
  return {
    ...(assetId ? { assetId } : {}),
    ...(assetPath ? { assetPath } : {}),
    ...(sourceReference ? { sourceReference } : {}),
    captions,
  }
}

function graphPath(metadata: Record<string, unknown>): string[] | undefined {
  if (
    !Array.isArray(metadata.graphPath) ||
    metadata.graphPath.length === 0 ||
    metadata.graphPath.length > 32 ||
    !metadata.graphPath.every((item) =>
      typeof item === "string" && item.length > 0 && item.length <= 256
    )
  ) return undefined
  return [...metadata.graphPath]
}

/**
 * Ticket 22 (ATT-01): attachment provenance, or undefined for knowledge. The
 * fields are only emitted when the chunk really is a session attachment, so
 * every pre-existing evidence shape is untouched.
 */
function attachmentProvenance(
  metadata: Record<string, unknown>
): Pick<Evidence, "origin" | "attachmentId" | "attachmentName" | "attachmentSessionId"> | undefined {
  if (metadata.origin !== "attachment") return undefined
  const attachmentId = typeof metadata.attachmentId === "string" ? metadata.attachmentId : undefined
  const attachmentName = typeof metadata.attachmentName === "string"
    ? metadata.attachmentName
    : undefined
  const attachmentSessionId = typeof metadata.attachmentSessionId === "string"
    ? metadata.attachmentSessionId
    : undefined
  return {
    origin: "attachment",
    ...(attachmentId ? { attachmentId } : {}),
    ...(attachmentName ? { attachmentName } : {}),
    ...(attachmentSessionId ? { attachmentSessionId } : {}),
  }
}

/**
 * Ticket 31 (FAQ-01B): FAQ provenance, or undefined otherwise. Mirrors
 * {@link attachmentProvenance}: the fields are only emitted when the chunk
 * really is a FAQ standard answer, so every pre-existing evidence shape is
 * untouched and a FAQ citation stays distinguishable from knowledge-base
 * documents and memory context.
 */
function faqProvenance(
  metadata: Record<string, unknown>
): Pick<Evidence, "origin" | "faqEntryId" | "faqVersion"> | undefined {
  if (metadata.origin !== "faq") return undefined
  const faqEntryId = typeof metadata.faqEntryId === "string" ? metadata.faqEntryId : undefined
  const faqVersion = Number.isInteger(metadata.faqVersion) &&
      (metadata.faqVersion as number) > 0
    ? metadata.faqVersion as number
    : undefined
  return {
    origin: "faq",
    ...(faqEntryId ? { faqEntryId } : {}),
    ...(faqVersion ? { faqVersion } : {}),
  }
}

export function buildEvidence(results: RetrievalResult[]): Evidence[] {
  const evidence = new Map<string, Evidence>()
  for (const result of results) {
    const key = `${result.chunk.documentId}\0${result.chunk.id}`
    const existing = evidence.get(key)
    if (existing) {
      for (const channel of result.channels ?? [result.source]) {
        if (!existing.channels.includes(channel)) existing.channels.push(channel)
      }
      existing.score = Math.max(existing.score, result.score)
      for (const link of result.wikilinks) {
        const candidate = existing.wikilinks.find((candidate) =>
          candidate.sourceEntityId === link.sourceEntityId &&
          candidate.targetEntityId === link.targetEntityId &&
          candidate.relation === link.relation
        )
        if (candidate) {
          candidate.weight = Math.max(candidate.weight, link.weight)
          candidate.provenance = [...new Map([
            ...(candidate.provenance ?? []),
            ...(link.provenance ?? []),
          ].map((item) => [`${item.documentId}\0${item.chunkId}`, item])).values()]
        }
        else existing.wikilinks.push({ ...link })
      }
      const laterPath = graphPath(result.chunk.metadata || {})
      if (!existing.graphPath && laterPath) existing.graphPath = laterPath
      continue
    }

    const metadata = result.chunk.metadata || {}
    const location = blockLocation(metadata)
    const path = graphPath(metadata)
    const image = imageReference(metadata)
    // Ticket 22 (ATT-01): a session attachment is TEMPORARY context. Its
    // provenance travels with the citation so no layer mistakes it for a
    // knowledge-base document.
    // Ticket 31 (FAQ-01B): a FAQ entry version is a STANDARD ANSWER. Its
    // provenance travels the same way so no layer presents it as a document.
    const attachment = attachmentProvenance(metadata)
    const faq = faqProvenance(metadata)
    evidence.set(key, {
      id: stableEvidenceId(result),
      documentId: result.chunk.documentId,
      documentVersionId: result.chunk.documentId,
      documentVersion: Number.isInteger(metadata.documentVersion) &&
          (metadata.documentVersion as number) > 0
        ? metadata.documentVersion as number
        : null,
      chunkId: result.chunk.id,
      title: typeof metadata.title === "string" ? metadata.title : "Untitled",
      source: typeof metadata.source === "string" ? metadata.source : "unknown",
      ...(attachment ?? {}),
      ...(faq ?? {}),
      ...location,
      ...(image ? { image } : {}),
      excerpt: result.chunk.content.slice(0, EXCERPT_LIMIT),
      channels: [...(result.channels ?? [result.source])],
      score: result.score,
      ...(path ? { graphPath: path } : {}),
      wikilinks: [...result.wikilinks],
      ...(result.chunk.tenantId !== undefined
        ? { tenantId: result.chunk.tenantId }
        : {}),
      ...(result.chunk.allowedGroups !== undefined
        ? { allowedGroups: [...result.chunk.allowedGroups] }
        : {}),
    })
  }
  return [...evidence.values()]
}

export function citationIdsByChunk(evidence: Evidence[]): Map<string, string> {
  return new Map(evidence.map((item) => [
    `${item.documentId}\0${item.chunkId}`,
    item.id,
  ]))
}

export function referencesForReply(
  reply: string,
  evidence: Evidence[]
): AnswerReference[] {
  const byId = new Map(evidence.map((item) => [item.id, item]))
  const references: AnswerReference[] = []
  const seen = new Set<string>()
  for (const match of reply.matchAll(/\[cite:([^\]]+)\]/g)) {
    const id = match[1]
    const item = byId.get(id)
    if (!item) throw new Error(`unknown citation: ${id}`)
    if (!seen.has(id)) {
      seen.add(id)
      references.push(item)
    }
  }
  return references
}
