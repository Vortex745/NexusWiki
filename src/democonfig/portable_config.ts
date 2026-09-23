/**
 * Ticket 43 (DEMO-01B) — portable, non-secret demo configuration.
 *
 * Export/import of the demo WORKSPACE CONFIGURATION: knowledge bases, model
 * profile toggles and assistants. What it deliberately contains:
 *
 *   - stable slugs: a slug IS the row id minus its type prefix, so the
 *     deterministic ids the seed/default paths use (`kb-demo-project`,
 *     `assistant-default-demo`) round-trip byte-stable, and every import
 *     creates rows whose ids derive from their slugs — a re-export of an
 *     imported namespace is identical;
 *   - version metadata (the schema version and the application version);
 *   - references BETWEEN entities by slug (an assistant's knowledge-base
 *     bindings are exported as knowledge-base slugs, never database ids).
 *
 * What it deliberately leaves out: credentials (model profiles export only
 * their enabled toggle — the profile ids are a closed set whose credential
 * slots live in the environment), documents, vectors, sessions and every
 * other content artifact. The export is configuration, not data.
 *
 * Import is a dry-run FIRST: the plan names every create, update, copy,
 * conflict and unchanged entry without touching a row. Conflicts (a slug
 * that already exists with different content) REJECT the whole import until
 * the administrator explicitly resolves each one as `update` (overwrite in
 * place — an assistant edit inserts a new immutable version) or `copy`
 * (import under a fresh `-copy` slug).
 */

import { createRequire } from "node:module"
import type { DB } from "../ingestion/tracking/db"
import type { KnowledgeBase } from "../types/knowledge_base"
import { SqliteKnowledgeBaseRepo } from "../knowledge/knowledge_base_repo"
import type { KnowledgeBaseService } from "../knowledge/knowledge_base_service"
import {
  AssistantService,
  type Assistant,
  type AssistantToolPolicy,
  type AssistantVersionConfig,
} from "../assistants/assistant_service"
import type { ModelProfile } from "../models/profiles"

export const DEMO_CONFIG_SCHEMA_VERSION = "demo-config-v1"

function applicationVersion(): string {
  try {
    // The project compiles to CommonJS — __filename/createRequire reach the
    // package manifest without bundler tricks.
    const requireFn = createRequire(__filename)
    return requireFn("../../package.json").version ?? "unknown"
  } catch {
    return "unknown"
  }
}

// --- stable slugs -----------------------------------------------------------

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,98}$/

/** A knowledge base's slug: the stable part of its id (`kb-demo-project` → `demo-project`). */
export function knowledgeBaseSlug(id: string): string {
  return id.startsWith("kb-") ? id.slice(3) : id
}

/** The inverse mapping — import-created knowledge bases get `kb-<slug>` ids. */
export function knowledgeBaseIdFromSlug(slug: string): string {
  return `kb-${slug}`
}

/** An assistant's slug (`assistant-default-demo` → `default-demo`). */
export function assistantSlug(id: string): string {
  return id.startsWith("assistant-") ? id.slice("assistant-".length) : id
}

/** The inverse mapping — import-created assistants get `assistant-<slug>` ids. */
export function assistantIdFromSlug(slug: string): string {
  return `assistant-${slug}`
}

function assertValidSlug(slug: string, kind: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(`invalid ${kind} slug: ${JSON.stringify(slug)}`)
  }
}

// --- export -----------------------------------------------------------------

export interface PortableKnowledgeBase {
  slug: string
  name: string
  description: string
  status: "active" | "archived"
  embeddingProfile: string
}

export interface PortableModelProfile {
  profileId: string
  enabled: boolean
}

export interface PortableAssistantConfig {
  systemPrompt: string
  /** Knowledge-base REFERENCES by stable slug, never by database id. */
  knowledgeBaseSlugs: string[]
  chatModelProfileId: "chat"
  rerankModelProfileId: "rerank" | null
  toolPolicy: AssistantToolPolicy
  memoryEnabled: boolean
}

export interface PortableAssistant {
  slug: string
  name: string
  description: string
  status: "active" | "archived"
  allowedGroups: string[]
  config: PortableAssistantConfig
}

export interface DemoConfigExport {
  schema: typeof DEMO_CONFIG_SCHEMA_VERSION
  application: "kefu-rag"
  applicationVersion: string
  exportedAt: string
  knowledgeBases: PortableKnowledgeBase[]
  modelProfiles: PortableModelProfile[]
  assistants: PortableAssistant[]
}

export interface AssistantWithCurrentConfig {
  assistant: Assistant
  config: AssistantVersionConfig
}

export interface DemoConfigExportDeps {
  knowledgeBases: KnowledgeBase[]
  /** The non-secret profile metadata (only the enabled toggle is exported). */
  modelProfiles: ModelProfile[]
  /** The tenant's assistants with their current execution config. */
  assistants: AssistantWithCurrentConfig[]
}

/** Build the portable export from the tenant's current configuration. */
export function buildDemoConfigExport(
  deps: DemoConfigExportDeps,
  exportedAt: Date
): DemoConfigExport {
  const kbIds = new Set(deps.knowledgeBases.map((base) => base.id))
  return {
    schema: DEMO_CONFIG_SCHEMA_VERSION,
    application: "kefu-rag",
    applicationVersion: applicationVersion(),
    exportedAt: exportedAt.toISOString(),
    knowledgeBases: deps.knowledgeBases.map((base) => ({
      slug: knowledgeBaseSlug(base.id),
      name: base.name,
      description: base.description,
      status: base.status,
      embeddingProfile: base.embeddingProfile,
    })),
    modelProfiles: deps.modelProfiles.map((profile) => ({
      profileId: profile.id,
      enabled: profile.enabled,
    })),
    assistants: deps.assistants.map(({ assistant, config }) => ({
      slug: assistantSlug(assistant.id),
      name: assistant.name,
      description: assistant.description,
      status: assistant.status,
      allowedGroups: [...assistant.allowedGroups],
      config: {
        systemPrompt: config.systemPrompt,
        // References travel by slug; a dangling binding (impossible by
        // construction — KBs are archive-only) is dropped honestly.
        knowledgeBaseSlugs: config.knowledgeBaseIds
          .filter((id) => kbIds.has(id))
          .map(knowledgeBaseSlug),
        chatModelProfileId: config.chatModelProfileId,
        rerankModelProfileId: config.rerankModelProfileId,
        toolPolicy: config.toolPolicy,
        memoryEnabled: config.memoryEnabled,
      },
    })),
  }
}

// --- import -----------------------------------------------------------------

export type DemoConfigImportAction = "create" | "update" | "copy" | "conflict" | "unchanged"

export interface DemoConfigImportEntry {
  kind: "knowledgeBase" | "modelProfile" | "assistant"
  slug: string
  action: DemoConfigImportAction
  /** Human-readable reason: WHAT differs or WHAT will be created. */
  detail: string
}

export interface DemoConfigImportReport {
  dryRun: boolean
  entries: DemoConfigImportEntry[]
  /** Set on a confirmed run that was rejected — nothing was written. */
  rejectedReason?: string
}

/** Per-conflict resolution an administrator must choose explicitly. */
export type DemoConfigImportResolutions = Record<string, "update" | "copy">

export interface DemoConfigImportDeps {
  tenantId: string
  db: DB
  knowledgeBases: KnowledgeBaseService
  /** Server's current embedding profile for CREATEd knowledge bases. */
  embeddingProfile: string
  /** The live profile registry — only list/setEnabled are consulted. */
  modelProfiles: { list(): ModelProfile[]; setEnabled(id: string, enabled: boolean): ModelProfile }
  assistants: AssistantService
  actorId: string
  now: () => Date
}

function sameKnowledgeBase(current: KnowledgeBase, incoming: PortableKnowledgeBase): boolean {
  return (
    current.name === incoming.name &&
    current.description === incoming.description &&
    current.status === incoming.status
  )
}

function resolveAssistantConfig(
  config: PortableAssistantConfig,
  slugToKbId: Map<string, string>
): AssistantVersionConfig | { error: string } {
  const knowledgeBaseIds: string[] = []
  for (const slug of config.knowledgeBaseSlugs) {
    const id = slugToKbId.get(slug)
    if (!id) return { error: `references unknown knowledge base slug "${slug}"` }
    knowledgeBaseIds.push(id)
  }
  return {
    systemPrompt: config.systemPrompt,
    knowledgeBaseIds,
    chatModelProfileId: config.chatModelProfileId,
    rerankModelProfileId: config.rerankModelProfileId,
    toolPolicy: config.toolPolicy,
    memoryEnabled: config.memoryEnabled,
  }
}

function planCopySlug(base: string, exists: (slug: string) => boolean): string {
  if (!exists(`${base}-copy`)) return `${base}-copy`
  let n = 2
  while (exists(`${base}-copy-${n}`)) n += 1
  return `${base}-copy-${n}`
}

/**
 * A conflict the administrator has explicitly resolved is REPORTED as the
 * action it will take ("update"/"copy") — the dry-run must show what a
 * confirmed run would do, not a permanent "conflict". Unresolved conflicts
 * stay "conflict" and reject the run.
 */
function resolvedConflictEntry(
  kind: DemoConfigImportEntry["kind"],
  slug: string,
  resolutions: DemoConfigImportResolutions,
  conflictDetail: string
): DemoConfigImportEntry {
  const resolution = resolutions[`${kind}:${slug}`]
  if (resolution === "update") {
    return {
      kind,
      slug,
      action: "update",
      detail: `resolves a conflict by UPDATE in place — ${conflictDetail}`,
    }
  }
  if (resolution === "copy") {
    return {
      kind,
      slug,
      action: "copy",
      detail: `resolves a conflict by COPY under a fresh slug — ${conflictDetail}`,
    }
  }
  return { kind, slug, action: "conflict", detail: conflictDetail }
}

const NAME_MAX_LENGTH = 200
const DESCRIPTION_MAX_LENGTH = 2_000

/**
 * Ticket 43 review: the import writes through the module-owned repositories,
 * so the payload must satisfy the same bounds the interactive create paths
 * enforce. Duplicate slugs would silently merge into one entry — rejected.
 */
function assertPayloadSane(config: DemoConfigExport): void {
  const seen = new Set<string>()
  for (const base of config.knowledgeBases ?? []) {
    const key = `knowledgeBase:${base.slug}`
    if (seen.has(key)) throw new Error(`duplicate knowledge base slug in payload: "${base.slug}"`)
    seen.add(key)
    const name = typeof base.name === "string" ? base.name.trim() : ""
    if (!name || name.length > NAME_MAX_LENGTH) {
      throw new Error(`knowledge base "${base.slug}" has an invalid name`)
    }
    if (typeof base.description === "string" && base.description.length > DESCRIPTION_MAX_LENGTH) {
      throw new Error(`knowledge base "${base.slug}" description is too long`)
    }
  }
  for (const assistant of config.assistants ?? []) {
    const key = `assistant:${assistant.slug}`
    if (seen.has(key)) throw new Error(`duplicate assistant slug in payload: "${assistant.slug}"`)
    seen.add(key)
    const name = typeof assistant.name === "string" ? assistant.name.trim() : ""
    if (!name || name.length > NAME_MAX_LENGTH) {
      throw new Error(`assistant "${assistant.slug}" has an invalid name`)
    }
    if (
      typeof assistant.description === "string" &&
      assistant.description.length > DESCRIPTION_MAX_LENGTH
    ) {
      throw new Error(`assistant "${assistant.slug}" description is too long`)
    }
  }
}

/**
 * Plan (and optionally execute) a portable-config import. `dryRun` reports
 * every create/update/copy/conflict/unchanged WITHOUT writing; a confirmed
 * run applies everything non-conflicting, honors explicit per-conflict
 * resolutions, and REJECTS (writing nothing) when any conflict lacks a
 * resolution.
 */
export function importDemoConfig(
  deps: DemoConfigImportDeps,
  config: DemoConfigExport,
  options: { dryRun: boolean; resolutions?: DemoConfigImportResolutions }
): DemoConfigImportReport {
  if (config.schema !== DEMO_CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `unsupported demo-config schema ${JSON.stringify(config.schema)} (expected "${DEMO_CONFIG_SCHEMA_VERSION}")`
    )
  }
  assertPayloadSane(config)

  const resolutions = options.resolutions ?? {}
  const entries: DemoConfigImportEntry[] = []
  // Conflicts a resolution CANNOT fix (a reference to a knowledge base that
  // is neither present nor part of the payload). They always reject.
  const hardConflictKeys = new Set<string>()
  const kbRepo = new SqliteKnowledgeBaseRepo(deps.db)
  const slugToKbId = new Map<string, string>()

  // --- knowledge bases ------------------------------------------------------
  for (const incoming of config.knowledgeBases ?? []) {
    assertValidSlug(incoming.slug, "knowledge base")
    const id = knowledgeBaseIdFromSlug(incoming.slug)
    slugToKbId.set(incoming.slug, id)
    const current = deps.knowledgeBases.getById(id, deps.tenantId)
    if (!current) {
      entries.push({
        kind: "knowledgeBase",
        slug: incoming.slug,
        action: "create",
        detail: `creates "${incoming.name}" as ${id}`,
      })
      continue
    }
    if (sameKnowledgeBase(current, incoming)) {
      entries.push({
        kind: "knowledgeBase",
        slug: incoming.slug,
        action: "unchanged",
        detail: "name, description and status already match",
      })
      continue
    }
    const detail = `exists with different workspace metadata (has "${current.name}" / incoming "${incoming.name}")`
    entries.push(resolvedConflictEntry("knowledgeBase", incoming.slug, resolutions, detail))
  }

  // --- model profiles ---------------------------------------------------------
  const profileById = new Map<string, ModelProfile>(
    deps.modelProfiles.list().map((profile) => [profile.id, profile])
  )
  for (const incoming of config.modelProfiles ?? []) {
    const current = profileById.get(incoming.profileId)
    if (!current) {
      // A resolution cannot conjure a profile this server does not have —
      // hard conflict, always rejects.
      hardConflictKeys.add(`modelProfile:${incoming.profileId}`)
      entries.push({
        kind: "modelProfile",
        slug: incoming.profileId,
        action: "conflict",
        detail: `unknown model profile "${incoming.profileId}" on this server`,
      })
      continue
    }
    if (current.enabled === incoming.enabled) {
      entries.push({
        kind: "modelProfile",
        slug: incoming.profileId,
        action: "unchanged",
        detail: "toggle already matches",
      })
      continue
    }
    entries.push(
      resolvedConflictEntry(
        "modelProfile",
        incoming.profileId,
        resolutions,
        `toggle differs (server ${current.enabled ? "enabled" : "disabled"} / incoming ${incoming.enabled ? "enabled" : "disabled"})`
      )
    )
  }

  // --- assistants -------------------------------------------------------------
  const assistantBySlug = new Map<
    string,
    { id: string; name: string; description: string; status: string; allowedGroups: string[]; config: AssistantVersionConfig }
  >()
  for (const withVersion of deps.assistants.listForTenant(deps.tenantId)) {
    assistantBySlug.set(assistantSlug(withVersion.id), {
      id: withVersion.id,
      name: withVersion.name,
      description: withVersion.description,
      status: withVersion.status,
      allowedGroups: withVersion.allowedGroups,
      config: withVersion.version.config,
    })
  }
  for (const incoming of config.assistants ?? []) {
    assertValidSlug(incoming.slug, "assistant")
    const resolved = resolveAssistantConfig(incoming.config, slugToKbId)
    if ("error" in resolved) {
      hardConflictKeys.add(`assistant:${incoming.slug}`)
      entries.push({
        kind: "assistant",
        slug: incoming.slug,
        action: "conflict",
        detail: resolved.error,
      })
      continue
    }
    const existing = assistantBySlug.get(incoming.slug)
    if (!existing) {
      entries.push({
        kind: "assistant",
        slug: incoming.slug,
        action: "create",
        detail: `creates "${incoming.name}" as ${assistantIdFromSlug(incoming.slug)}`,
      })
      continue
    }
    const same =
      existing.name === incoming.name &&
      existing.description === incoming.description &&
      existing.status === incoming.status &&
      JSON.stringify(existing.allowedGroups) === JSON.stringify(incoming.allowedGroups) &&
      JSON.stringify(existing.config) === JSON.stringify(resolved)
    if (same) {
      entries.push({
        kind: "assistant",
        slug: incoming.slug,
        action: "unchanged",
        detail: "workspace metadata and execution config already match",
      })
      continue
    }
    entries.push(
      resolvedConflictEntry(
        "assistant",
        incoming.slug,
        resolutions,
        existing.status === "archived"
          ? "exists ARCHIVED with different workspace metadata or execution config (an update restores it first)"
          : "exists with different workspace metadata or execution config"
      )
    )
  }

  // A conflict without an explicit resolution rejects the import; a conflict
  // no resolution could fix (unknown references) always does.
  const conflicts = entries.filter((entry) => entry.action === "conflict")
  const unresolved = conflicts.filter(
    (entry) =>
      resolutions[`${entry.kind}:${entry.slug}`] === undefined ||
      hardConflictKeys.has(`${entry.kind}:${entry.slug}`)
  )
  if (options.dryRun) {
    return { dryRun: true, entries }
  }
  if (unresolved.length > 0) {
    return {
      dryRun: false,
      entries,
      rejectedReason: `${unresolved.length} conflict(s) without an explicit update/copy resolution: ${unresolved
        .map((entry) => `${entry.kind}:${entry.slug}`)
        .join(", ")}`,
    }
  }

  // --- execution: knowledge bases, then profiles, then assistants -------------
  // ONE SQLite transaction: any throw (an unexpected PK collision, a profile
  // whose credentials vanished, a payload the validators refuse) rolls the
  // WHOLE import back — a half-applied configuration is never a state this
  // function can leave behind.
  const apply = deps.db.transaction((): void => {
    let createSequence = 0
    for (const incoming of config.knowledgeBases ?? []) {
      const entry = entries.find(
        (candidate) => candidate.kind === "knowledgeBase" && candidate.slug === incoming.slug
      )
      if (!entry || entry.action === "unchanged") continue
      const asCopy = entry.action === "copy"
      const slug = asCopy
        ? planCopySlug(incoming.slug, (candidate) =>
            deps.knowledgeBases.getById(knowledgeBaseIdFromSlug(candidate), deps.tenantId) !== null
          )
        : incoming.slug
      const id = knowledgeBaseIdFromSlug(slug)
      if (entry.action === "create" || asCopy) {
        // created_at follows the payload order (1ms apart) so list views stay
        // deterministic even when the clock is frozen.
        const timestamp = new Date(deps.now().getTime() + createSequence++).toISOString()
        // Created ACTIVE; the exported status (archived or not) is applied by
        // the final status pass so assistant bindings resolve against active
        // bases.
        kbRepo.insertIfAbsent({
          id,
          tenantId: deps.tenantId,
          name: incoming.name,
          description: incoming.description,
          status: "active",
          embeddingProfile: deps.embeddingProfile,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        // insertIfAbsent swallows a PK collision — read back and fail loudly
        // instead of reporting a create that did not happen (the transaction
        // rolls the rest of the import back).
        if (!deps.knowledgeBases.getById(id, deps.tenantId)) {
          throw new Error(`imported knowledge base ${id} could not be read back`)
        }
        slugToKbId.set(slug, id)
        entry.slug = slug
        entry.action = asCopy ? "copy" : "create"
        entry.detail = asCopy
          ? `copied "${incoming.name}" under slug ${slug} (embedding profile: this server's ${deps.embeddingProfile})`
          : `created "${incoming.name}" as ${id} (embedding profile: this server's ${deps.embeddingProfile})`
        continue
      }
      // action === "update": workspace metadata in place. The embedding
      // profile is server-owned (a vector space cannot be swapped in place)
      // and the STATUS is deferred to the final pass — an archived base must
      // not silently break the assistant bindings applied below.
      const timestamp = deps.now().toISOString()
      kbRepo.setName(id, deps.tenantId, incoming.name, timestamp)
      kbRepo.setDescription(id, deps.tenantId, incoming.description, timestamp)
      entry.detail = "workspace metadata updated (embedding profile is server-owned)"
    }

    for (const incoming of config.modelProfiles ?? []) {
      const entry = entries.find(
        (candidate) => candidate.kind === "modelProfile" && candidate.slug === incoming.profileId
      )
      if (!entry || entry.action === "unchanged") continue
      if (entry.action !== "update") continue
      deps.modelProfiles.setEnabled(incoming.profileId, incoming.enabled)
      entry.detail = "toggle updated"
    }

    for (const incoming of config.assistants ?? []) {
      const entry = entries.find(
        (candidate) => candidate.kind === "assistant" && candidate.slug === incoming.slug
      )
      if (!entry || entry.action === "unchanged") continue
      const resolved = resolveAssistantConfig(incoming.config, slugToKbId)
      if ("error" in resolved) continue
      const asCopy = entry.action === "copy"
      const slug = asCopy
        ? planCopySlug(incoming.slug, (candidate) =>
            assistantBySlug.has(candidate) ||
            deps.assistants.get(assistantIdFromSlug(candidate), deps.tenantId) !== null
          )
        : incoming.slug
      if (entry.action === "create" || asCopy) {
        deps.assistants.create(deps.tenantId, deps.actorId, {
          id: assistantIdFromSlug(slug),
          name: incoming.name,
          description: incoming.description,
          allowedGroups: incoming.allowedGroups,
          config: resolved,
        })
        entry.slug = slug
        entry.action = asCopy ? "copy" : "create"
        entry.detail = asCopy
          ? `copied "${incoming.name}" under slug ${slug}`
          : `created "${incoming.name}" as ${assistantIdFromSlug(slug)}`
        continue
      }
      // action === "update": an edit inserts a NEW immutable version when the
      // execution config changed (history is never rewritten). An ARCHIVED
      // assistant is restored first — an update implies the operator wants it
      // live again; archiving it back is the next import's business.
      const assistantId = assistantIdFromSlug(incoming.slug)
      if (assistantBySlug.get(incoming.slug)?.status === "archived") {
        deps.assistants.restore(assistantId, deps.tenantId)
      }
      deps.assistants.edit(assistantId, deps.tenantId, deps.actorId, {
        name: incoming.name,
        description: incoming.description,
        allowedGroups: incoming.allowedGroups,
        config: resolved,
      })
      if (incoming.status === "archived") {
        deps.assistants.archive(assistantId, deps.tenantId)
      }
      entry.detail =
        "updated in place (archived assistants are restored first); a changed execution config is a new version"
    }

    // Final status pass: apply the exported status of EVERY payload knowledge
    // base (create, update and copy) — AFTER the assistants, so bindings
    // resolved against active bases. The tenant's DEFAULT knowledge base is
    // unarchivable by contract — the setStatus simply never matches it.
    for (const incoming of config.knowledgeBases ?? []) {
      const entry = entries.find(
        (candidate) => candidate.kind === "knowledgeBase" && candidate.slug === incoming.slug
      )
      if (!entry || entry.action === "unchanged") continue
      const id = knowledgeBaseIdFromSlug(entry.slug)
      const current = deps.knowledgeBases.getById(id, deps.tenantId)
      if (current && current.status !== incoming.status) {
        kbRepo.setStatus(id, deps.tenantId, incoming.status, deps.now().toISOString())
      }
    }
  })
  apply()

  return { dryRun: false, entries }
}
