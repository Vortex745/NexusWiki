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
