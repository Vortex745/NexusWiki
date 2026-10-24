import { createHash } from "node:crypto"
import * as path from "node:path"
import { defaultKnowledgeBaseId } from "../types/knowledge_base"

export interface SourceIdentityInput {
  kind: string
  uriOrExternalId: string
  namespace?: string
  // Ticket 05 P2: access context attributes propagated from the caller.
  // tenantId defaults to "default" when not provided (single-tenant mode).
  tenantId?: string
  // allowedGroups defaults to [] meaning tenant-wide visibility (never cross-tenant public).
  allowedGroups?: string[]
}

export interface CanonicalSourceIdentity {
  kind: string
  uri: string
  namespace: string
  // The default tenant keeps the legacy key; non-default tenants are key-isolated.
  tenantId: string
  allowedGroups: string[]
  /**
   * Ticket 03 (KB-02A): the knowledge base that owns this Source. Required —
   * one Source belongs to exactly one knowledge base. Callers that do not
   * request one resolve to the tenant's deterministic DEFAULT knowledge base,
   * so legacy callers keep their byte-identical source key.
   */
  knowledgeBaseId: string
}

function canonicalize(kind: string, value: string): string {
  if (kind === "file") {
    const resolved = path.resolve(value)
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }
  if (kind === "url") return new URL(value).toString()
  return value
}

export function resolveStoredSourceIdentity(
  source: string,
  fallbackId: string
): CanonicalSourceIdentity {
  const storedSource = source.trim()
  const isAbsoluteFilePath = path.isAbsolute(storedSource) ||
    /^[a-z]:[\\/]/i.test(storedSource) ||
    /^\\\\/.test(storedSource)
  if (storedSource !== "api" && isAbsoluteFilePath) {
    return resolveSourceIdentity(
      { kind: "file", uriOrExternalId: storedSource, namespace: "local" },
      undefined,
      fallbackId
    )
  }
  return resolveSourceIdentity(undefined, source, fallbackId)
}

export function resolveSourceIdentity(
  identity: SourceIdentityInput | undefined,
  legacySource: string | undefined,
  fallbackId: string,
  knowledgeBaseId?: string
): CanonicalSourceIdentity {
  // Ticket 03 (KB-02A): an omitted knowledge base resolves to the tenant's
  // deterministic default — never to "no ownership" and never to "all".
  const requestedKnowledgeBaseId = knowledgeBaseId?.trim()
  if (identity) {
    const kind = identity.kind.trim().toLowerCase()
    const value = identity.uriOrExternalId.trim()
    const namespace = identity.namespace?.trim() || "default"
    if (!kind || !value) {
      throw new Error("source identity kind and URI or external ID are required")
    }
    // Ticket 05 P2: propagate access attributes with defaults (additive — key unchanged).
    const tenantId = identity.tenantId?.trim() || "default"
    const allowedGroups = identity.allowedGroups ?? []
    return {
      kind,
      uri: canonicalize(kind, value),
      namespace,
      tenantId,
      allowedGroups,
      knowledgeBaseId: requestedKnowledgeBaseId || defaultKnowledgeBaseId(tenantId),
    }
  }

  // Legacy paths default to single-tenant identity (backward compat for existing callers).
  const source = legacySource?.trim()
  const legacyKnowledgeBaseId = requestedKnowledgeBaseId || defaultKnowledgeBaseId("default")
  if (!source || source === "api") {
    return {
      kind: "submission",
      uri: fallbackId,
      namespace: fallbackId,
      tenantId: "default",
      allowedGroups: [],
      knowledgeBaseId: legacyKnowledgeBaseId,
    }
  }
  if (/^https?:\/\//i.test(source)) {
    try {
      return {
        kind: "url",
        uri: canonicalize("url", source),
        namespace: "default",
        tenantId: "default",
        allowedGroups: [],
        knowledgeBaseId: legacyKnowledgeBaseId,
      }
    } catch {
      return {
        kind: "legacy",
        uri: source,
        namespace: "default",
        tenantId: "default",
        allowedGroups: [],
        knowledgeBaseId: legacyKnowledgeBaseId,
      }
    }
  }
  return {
    kind: "legacy",
    uri: source,
    namespace: "default",
    tenantId: "default",
    allowedGroups: [],
    knowledgeBaseId: legacyKnowledgeBaseId,
  }
}

export function sourceIdentityKey(identity: CanonicalSourceIdentity): string {
  const keyParts = [identity.kind, identity.uri, identity.namespace]
  if (identity.tenantId !== "default") keyParts.push(identity.tenantId)
  // Ticket 03 (KB-02A): a non-default knowledge base isolates the key, so the
  // same file name or content in two knowledge bases is two Source identities.
  // The default knowledge base appends nothing — legacy keys stay identical.
  if (identity.knowledgeBaseId !== defaultKnowledgeBaseId(identity.tenantId)) {
    // The "kb:" tag keeps this element from ever colliding with the bare
    // tenant id pushed above: a knowledge base whose id happens to equal some
    // tenant's id must not hash to that tenant's identity.
    keyParts.push(`kb:${identity.knowledgeBaseId}`)
  }
  return createHash("sha256")
    .update(JSON.stringify(keyParts))
    .digest("hex")
}

// ---------------------------------------------------------------------------
// Ticket 05: original-file identity — the first element of a candidate
// identity. The bytes decide what the file is; a declared name or MIME type
// can never promote a derived page render into an original document.
// ---------------------------------------------------------------------------

export type OriginalFileIdentityErrorCode =
  | "original_file_bytes_missing"
  | "original_file_not_pdf"
  | "preview_substituted_for_original"

export class OriginalFileIdentityError extends Error {
  constructor(readonly code: OriginalFileIdentityErrorCode, message: string) {
    super(message)
    this.name = "OriginalFileIdentityError"
  }
}

export interface OriginalFileIdentity {
  /** Canonical source key when the caller supplied a source identity; null for an anonymous upload. */
  sourceKey: string | null
  uri: string | null
  tenantId: string | null
  knowledgeBaseId: string | null
  fileName: string | null
  mimeType: string | null
  /** sha256 of the ORIGINAL file bytes, never of a derived artifact. */
  sha256: string
  byteLength: number
}

export interface OriginalFileIdentityInput {
  bytes: Buffer
  fileName?: string | null
  mimeType?: string | null
  identity?: SourceIdentityInput
  legacySource?: string
  fallbackId?: string
  knowledgeBaseId?: string
}

const PDF_SIGNATURE = "%PDF-"

function looksLikeRasterPreview(bytes: Buffer): boolean {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes.subarray(1, 4).toString("latin1") === "PNG") return true
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true
  if (bytes.length >= 6 && bytes.subarray(0, 3).toString("latin1") === "GIF") return true
  return false
}

/**
 * Binds the original file of a candidate: its digest, size, declared name and
 * (when supplied) the canonical source identity it belongs to. A raster — a
 * page preview — offered as the original is refused here, which is what keeps
 * derived images from being substituted for the PDF downstream.
 */
export function deriveOriginalFileIdentity(input: OriginalFileIdentityInput): OriginalFileIdentity {
  const bytes = input.bytes
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new OriginalFileIdentityError(
      "original_file_bytes_missing",
      "the original file identity requires the uploaded bytes, not a metadata record"
    )
  }
  if (looksLikeRasterPreview(bytes)) {
    throw new OriginalFileIdentityError(
      "preview_substituted_for_original",
      `a derived page preview (${input.fileName ?? "unnamed"}) cannot be registered as the original file`
    )
  }
  const declaredPdf =
    input.identity?.kind === "pdf" ||
    /\.pdf$/i.test(input.fileName ?? "") ||
    (input.mimeType ?? "").split(";", 1)[0].trim().toLowerCase() === "application/pdf"
  if (declaredPdf && bytes.subarray(0, PDF_SIGNATURE.length).toString("latin1") !== PDF_SIGNATURE) {
    throw new OriginalFileIdentityError(
      "original_file_not_pdf",
      `${input.fileName ?? "unnamed"} is declared as a PDF but its bytes carry no %PDF- header`
    )
  }

  let sourceKey: string | null = null
  let uri: string | null = null
  let tenantId: string | null = null
  let knowledgeBaseId: string | null = null
  if (input.identity || input.legacySource) {
    const resolved = resolveSourceIdentity(
      input.identity,
      input.legacySource,
      input.fallbackId ?? "anonymous-upload",
      input.knowledgeBaseId
    )
    sourceKey = sourceIdentityKey(resolved)
    uri = resolved.uri
    tenantId = resolved.tenantId
    knowledgeBaseId = resolved.knowledgeBaseId
  }

  return Object.freeze({
    sourceKey,
    uri,
    tenantId,
    knowledgeBaseId,
    fileName: input.fileName ?? null,
    mimeType: input.mimeType ?? null,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
  })
}
