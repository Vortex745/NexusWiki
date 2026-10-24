/**
 * Ticket 18 (AST-01A) — the assistant domain.
 *
 * An assistant is a named, versioned execution profile: system prompt,
 * knowledge-base binding, model-profile binding, tool policy and memory
 * setting. Workspace metadata (name/description/allowed groups) lives on the
 * `assistants` row; everything that influences execution lives in
 * `assistant_versions` and is IMMUTABLE — an edit always inserts a new
 * version and moves the pointer. Older versions therefore stay readable
 * forever, which is what lets existing conversations keep referencing the
 * assistant version they were created with (the runtime binding is ticket 19).
 *
 * Reader visibility mirrors the document/group ACL semantics: only callers
 * carrying groups are restricted (allowedGroups empty or intersecting); a
 * viewer with zero groups and admins see every row of the tenant. Reader
 * payloads omit the execution configuration entirely — prompts, knowledge
 * bindings and model/tool policy are server-executed configuration, not
 * reader-visible content.
 */

import { randomUUID } from "node:crypto"
import type { DB } from "../ingestion/tracking/db"
import type { AccessContext } from "../access/context"
import {
  KnowledgeBaseArchivedError,
  KnowledgeBaseNotFoundError,
  type KnowledgeBaseService,
} from "../knowledge/knowledge_base_service"

export type AssistantStatus = "active" | "archived"
export type AssistantToolPolicy = "none" | "read_only_retrieval"

/** The execution configuration one immutable version carries. */
export interface AssistantVersionConfig {
  systemPrompt: string
  /** Knowledge bases this assistant may draw from ([] = no knowledge context). */
  knowledgeBaseIds: string[]
  /** Profile ids from the ticket-16 registry; the chat slot has exactly one. */
  chatModelProfileId: "chat"
  /** `null` disables the dedicated reranker for this assistant. */
  rerankModelProfileId: "rerank" | null
  toolPolicy: AssistantToolPolicy
  memoryEnabled: boolean
}

export interface AssistantVersion {
  version: number
  config: AssistantVersionConfig
  createdAt: string
  createdBy: string
}

export interface Assistant {
  id: string
  tenantId: string
  name: string
  description: string
  status: AssistantStatus
  /** Sidebar curation: false = hidden from the sidebar selector (admin-set). */
  sidebarVisible: boolean
  /** Group visibility axis (same semantics as documents/allowed_groups). */
  allowedGroups: string[]
  currentVersion: number
  createdAt: string
  updatedAt: string
}

export interface AssistantWithVersion extends Assistant {
  version: AssistantVersion
}

const NAME_MAX = 200
const DESCRIPTION_MAX = 2_000
const SYSTEM_PROMPT_MAX = 8_000
const KB_BINDING_MAX = 20

const DEFAULT_ASSISTANT_ID_PREFIX = "assistant-default-"

/**
 * The deterministic id of a tenant's default assistant (mirrors
 * {@link defaultKnowledgeBaseId}). A chat request that names no assistant —
 * or names this one — runs the legacy overlay-free path.
 */
export function defaultAssistantId(tenantId: string): string {
  return `${DEFAULT_ASSISTANT_ID_PREFIX}${tenantId}`
}

/** The immutable per-run snapshot the transport hands to the shared entry. */
export interface AssistantRunSnapshot {
  id: string
  version: number
  systemPrompt: string
  rerankModelProfileId: "rerank" | null
  /**
   * Ticket 34 (TOOL-01A): the tool allowlist this version pins. "none" → no
   * tools execute; "read_only_retrieval" → the built-in read-only toolset.
   * Part of the immutable version snapshot, so a run cannot widen it.
   */
  toolPolicy: AssistantToolPolicy
}

export class InvalidAssistantCommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidAssistantCommandError"
  }
}

export class AssistantNotFoundError extends Error {
  constructor() {
    super("assistant not found")
    this.name = "AssistantNotFoundError"
  }
}

export class AssistantArchivedError extends Error {
  constructor() {
    super("assistant is archived")
    this.name = "AssistantArchivedError"
  }
}

/** A tenant's deterministic default assistant can be archived but never removed. */
export class AssistantDefaultError extends Error {
  constructor() {
    super("the default assistant cannot be deleted")
    this.name = "AssistantDefaultError"
  }
}

interface AssistantRow {
  id: string
  tenant_id: string
  name: string
  description: string
  status: AssistantStatus
  sidebar_visible: number
  allowed_groups: string
  current_version: number
  created_at: string
  updated_at: string
}

interface VersionRow {
  assistant_id: string
  version: number
  config: string
  created_at: string
  created_by: string
}

function rowToAssistant(row: AssistantRow): Assistant {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    status: row.status,
    // `!== 0` (not `=== 1`) so a row that somehow predates the column still
    // reads as visible — the pre-column behavior, not a mass hiding.
    sidebarVisible: row.sidebar_visible !== 0,
    allowedGroups: JSON.parse(row.allowed_groups) as string[],
    currentVersion: row.current_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToVersion(row: VersionRow): AssistantVersion {
  return {
    version: row.version,
    config: JSON.parse(row.config) as AssistantVersionConfig,
    createdAt: row.created_at,
    createdBy: row.created_by,
  }
}

/** The one external binding seam: a profile toggle the service cannot see. */
export interface AssistantBindingValidators {
  assertRerankProfileSelectable(): void
}

export class AssistantService {
  constructor(
    private readonly db: DB,
    /**
     * Knowledge-base binding validation reuses the ONE authoritative service:
     * an assistant may only bind knowledge bases that exist and are active in
     * its tenant at save time (runtime intersection is ticket 19's job).
     */
    private readonly knowledgeBases: KnowledgeBaseService,
    private readonly bindings?: AssistantBindingValidators,
    private readonly now: () => Date = () => new Date()
  ) {}

  create(
    tenantId: string,
    actorId: string,
    input: {
      name: unknown
      description?: unknown
      allowedGroups?: unknown
      config: unknown
      /**
       * Ticket 43 (DEMO-01B): an explicit deterministic id for the portable
       * config import — `assistant-<slug>` so a re-imported namespace keeps
       * stable identity. Anything else keeps the random id.
       */
      id?: unknown
    }
  ): AssistantWithVersion {
    const name = this.validateName(input.name)
    const description = this.validateDescription(input.description)
    const allowedGroups = this.validateGroups(input.allowedGroups)
    const config = this.validateConfig(tenantId, input.config)
    let id = `assistant-${randomUUID()}`
    if (input.id !== undefined) {
      if (
        typeof input.id !== "string" ||
        !/^assistant-[a-z0-9][a-z0-9-]{0,98}$/.test(input.id)
      ) {
        throw new InvalidAssistantCommandError(
          "id must match assistant-<slug> with lowercase letters, digits and dashes"
        )
      }
      id = input.id
    }
    const timestamp = this.now().toISOString()
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO assistants (
            id, tenant_id, name, description, status, allowed_groups,
            current_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'active', ?, 1, ?, ?)`
        )
        .run(id, tenantId, name, description, JSON.stringify(allowedGroups), timestamp, timestamp)
      this.db
        .prepare(
          `INSERT INTO assistant_versions (assistant_id, version, config, created_at, created_by)
           VALUES (?, 1, ?, ?, ?)`
        )
        .run(id, JSON.stringify(config), timestamp, actorId)
    })
    insert()
    const stored = this.get(id, tenantId)
    if (!stored) throw new Error(`created assistant could not be read back: ${id}`)
    return stored
  }

  /**
   * Edit = workspace metadata in place + a NEW immutable version when the
   * execution config changed. Version rows are never updated or deleted.
   */
  edit(
    id: string,
    tenantId: string,
    actorId: string,
    input: {
      name?: unknown
      description?: unknown
      allowedGroups?: unknown
      config?: unknown
    }
  ): AssistantWithVersion {
    const existing = this.get(id, tenantId)
    if (!existing) throw new AssistantNotFoundError()
    if (existing.status === "archived") throw new AssistantArchivedError()

    const name = input.name === undefined ? existing.name : this.validateName(input.name)
    const description =
      input.description === undefined ? existing.description : this.validateDescription(input.description)
    const allowedGroups =
      input.allowedGroups === undefined ? existing.allowedGroups : this.validateGroups(input.allowedGroups)
    const config =
      input.config === undefined ? existing.version.config : this.validateConfig(tenantId, input.config)

    const timestamp = this.now().toISOString()
    const update = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE assistants
           SET name = ?, description = ?, allowed_groups = ?, updated_at = ?
           WHERE id = ? AND tenant_id = ?`
        )
        .run(name, description, JSON.stringify(allowedGroups), timestamp, id, tenantId)
      if (input.config !== undefined) {
        const nextVersion = existing.currentVersion + 1
        this.db
          .prepare(
            `INSERT INTO assistant_versions (assistant_id, version, config, created_at, created_by)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(id, nextVersion, JSON.stringify(config), timestamp, actorId)
        this.db
          .prepare(
            `UPDATE assistants SET current_version = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`
          )
          .run(nextVersion, timestamp, id, tenantId)
      }
    })
    update()
    return this.get(id, tenantId) as AssistantWithVersion
  }

  archive(id: string, tenantId: string): Assistant {
    return this.setStatus(id, tenantId, "archived")
  }

  restore(id: string, tenantId: string): Assistant {
    return this.setStatus(id, tenantId, "active")
  }

  /**
   * Sidebar curation — flips the visibility flag WITHOUT minting a version:
   * versions carry only execution configuration, and this toggle changes no
   * execution semantics. The tenant's default assistant is always visible
   * (refused here; the UI disables the checkbox as the convenience half).
   * Setting the flag on an archived row is allowed on purpose: it records the
   * curator's intent and takes effect again after a restore.
   */
  setSidebarVisible(id: string, tenantId: string, visible: boolean): Assistant {
    if (id === defaultAssistantId(tenantId)) throw new AssistantDefaultError()
    const existing = this.get(id, tenantId)
    if (!existing) throw new AssistantNotFoundError()
    this.db
      .prepare(`UPDATE assistants SET sidebar_visible = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`)
      .run(visible ? 1 : 0, this.now().toISOString(), id, tenantId)
    return this.get(id, tenantId) as Assistant
  }

  /**
   * Physical delete — unlike archive, the row and its version history are
   * gone. Past conversations naming the id fall through to the chat route's
   * 404 and evaluation snapshots keep their immutable copy, so nothing else
   * references the row. The tenant's default assistant is refuse here (the
   * UI hides the button too; this is the enforced half of that contract).
   */
  remove(id: string, tenantId: string): void {
    if (id === defaultAssistantId(tenantId)) throw new AssistantDefaultError()
    const existing = this.get(id, tenantId)
    if (!existing) throw new AssistantNotFoundError()
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM assistant_versions WHERE assistant_id = ?`).run(id)
      this.db.prepare(`DELETE FROM assistants WHERE id = ? AND tenant_id = ?`).run(id, tenantId)
    })()
  }

  get(id: string, tenantId: string): AssistantWithVersion | null {
    const row = this.db
      .prepare(`SELECT * FROM assistants WHERE id = ? AND tenant_id = ?`)
      .get(id, tenantId) as AssistantRow | undefined
    if (!row) return null
    const version = this.getVersion(id, tenantId, row.current_version)
    if (!version) throw new Error(`assistant ${id} is missing its current version ${row.current_version}`)
    return { ...rowToAssistant(row), version }
  }

  getVersion(id: string, tenantId: string, version: number): AssistantVersion | null {
    const row = this.db
      .prepare(
        `SELECT * FROM assistant_versions WHERE assistant_id = ? AND version = ?
         AND assistant_id IN (SELECT id FROM assistants WHERE tenant_id = ?)`
      )
      .get(id, version, tenantId) as VersionRow | undefined
    return row ? rowToVersion(row) : null
  }

  /**
   * Ticket 43 (DEMO-01B): every assistant of the tenant WITH its current
   * execution config, oldest first (deterministic order for the portable
   * export).
   */
  listForTenant(tenantId: string): AssistantWithVersion[] {
    const rows = this.db
      .prepare(`SELECT * FROM assistants WHERE tenant_id = ? ORDER BY created_at ASC, id ASC`)
      .all(tenantId) as AssistantRow[]
    const result: AssistantWithVersion[] = []
    for (const row of rows) {
      const version = this.getVersion(row.id, tenantId, row.current_version)
      if (!version) {
        throw new Error(`assistant ${row.id} is missing its current version ${row.current_version}`)
      }
      result.push({ ...rowToAssistant(row), version })
    }
    return result
  }

  listVersions(id: string, tenantId: string): AssistantVersion[] {
    const rows = this.db
      .prepare(
        `SELECT v.* FROM assistant_versions v
         JOIN assistants a ON a.id = v.assistant_id
         WHERE v.assistant_id = ? AND a.tenant_id = ?
         ORDER BY v.version ASC`
      )
      .all(id, tenantId) as VersionRow[]
    return rows.map(rowToVersion)
  }

  /**
   * Ticket 19 (AST-01B): seed the tenant's deterministic default assistant
   * (INSERT OR IGNORE, same idempotency pattern as the default knowledge
   * base). Its config is the overlay-free legacy shape — empty prompt, no KB
   * binding, no rerank pin — and a run that names it takes the legacy path.
   */
  ensureDefault(tenantId: string): AssistantWithVersion {
    const id = defaultAssistantId(tenantId)
    const existing = this.get(id, tenantId)
    if (existing) return existing
    const timestamp = this.now().toISOString()
    const seed = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO assistants (
            id, tenant_id, name, description, status, allowed_groups,
            current_version, created_at, updated_at
          ) VALUES (?, ?, '默认助手', '', 'active', '[]', 1, ?, ?)`
        )
        .run(id, tenantId, timestamp, timestamp)
      this.db
        .prepare(
          `INSERT OR IGNORE INTO assistant_versions (assistant_id, version, config, created_at, created_by)
           VALUES (?, 1, ?, ?, 'system')`
        )
        .run(
          id,
          JSON.stringify({
            systemPrompt: "",
            knowledgeBaseIds: [],
            chatModelProfileId: "chat",
            rerankModelProfileId: null,
            toolPolicy: "read_only_retrieval",
            memoryEnabled: false,
          } satisfies AssistantVersionConfig),
          timestamp
        )
    })
    seed()
    return this.get(id, tenantId) as AssistantWithVersion
  }

  /**
   * Group-visibility filtered list (graph_acl semantics): only callers
   * carrying groups are restricted; zero-group viewers and admins see all.
   * The default assistant is seeded lazily on first list so a workspace can
   * always offer the legacy choice.
   */
  listForViewer(tenantId: string, context: AccessContext): Assistant[] {
    this.ensureDefault(tenantId)
    const rows = this.db
      .prepare(`SELECT * FROM assistants WHERE tenant_id = ? ORDER BY created_at ASC`)
      .all(tenantId) as AssistantRow[]
    const viewerGroups = new Set(context.groups)
    const restricted = context.groups.length > 0 && !context.scopes.includes("admin")
    return rows
      .map(rowToAssistant)
      .filter((assistant) => {
        if (!restricted) return true
        return assistant.allowedGroups.length === 0 ||
          assistant.allowedGroups.some((group) => viewerGroups.has(group))
      })
  }

  /** Group visibility check for a single assistant (detail/version routes). */
  visibleTo(assistant: Assistant, context: AccessContext): boolean {
    if (context.scopes.includes("admin")) return true
    if (context.groups.length === 0) return true
    return (
      assistant.allowedGroups.length === 0 ||
      assistant.allowedGroups.some((group) => context.groups.includes(group))
    )
  }

  private setStatus(id: string, tenantId: string, status: AssistantStatus): Assistant {
    const result = this.db
      .prepare(`UPDATE assistants SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`)
      .run(status, this.now().toISOString(), id, tenantId)
    if (result.changes === 0) throw new AssistantNotFoundError()
    const stored = this.get(id, tenantId)
    if (!stored) throw new AssistantNotFoundError()
    return stored
  }

  private validateName(name: unknown): string {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new InvalidAssistantCommandError("assistant name must be a non-empty string")
    }
    if (name.trim().length > NAME_MAX) {
      throw new InvalidAssistantCommandError(`assistant name must be at most ${NAME_MAX} characters`)
    }
    return name.trim()
  }

  private validateDescription(description: unknown): string {
    const value = description ?? ""
    if (typeof value !== "string" || value.length > DESCRIPTION_MAX) {
      throw new InvalidAssistantCommandError(
        `assistant description must be a string of at most ${DESCRIPTION_MAX} characters`
      )
    }
    return value
  }

  private validateGroups(groups: unknown): string[] {
    if (groups === undefined) return []
    if (!Array.isArray(groups) || groups.some((g) => typeof g !== "string" || g.trim().length === 0)) {
      throw new InvalidAssistantCommandError(
        "allowedGroups must be an array of non-empty group names"
      )
    }
    const unique = [...new Set(groups.map((g) => (g as string).trim()))]
    if (unique.length > 50) {
      throw new InvalidAssistantCommandError("allowedGroups must contain at most 50 groups")
    }
    return unique
  }

  /** The validated version-config contract. Unknown fields are refused. */
  private validateConfig(tenantId: string, raw: unknown): AssistantVersionConfig {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new InvalidAssistantCommandError("config must be an object")
    }
    const body = raw as Record<string, unknown>
    const systemPrompt = body.systemPrompt ?? ""
    if (typeof systemPrompt !== "string" || systemPrompt.length > SYSTEM_PROMPT_MAX) {
      throw new InvalidAssistantCommandError(
        `config.systemPrompt must be a string of at most ${SYSTEM_PROMPT_MAX} characters`
      )
    }
    const knowledgeBaseIds = body.knowledgeBaseIds ?? []
    if (
      !Array.isArray(knowledgeBaseIds) ||
      knowledgeBaseIds.some((id) => typeof id !== "string" || id.trim().length === 0)
    ) {
      throw new InvalidAssistantCommandError(
        "config.knowledgeBaseIds must be an array of non-empty knowledge-base ids"
      )
    }
    const uniqueKnowledgeBaseIds = [...new Set(knowledgeBaseIds.map((id) => (id as string).trim()))]
    if (uniqueKnowledgeBaseIds.length > KB_BINDING_MAX) {
      throw new InvalidAssistantCommandError(
        `config.knowledgeBaseIds must contain at most ${KB_BINDING_MAX} knowledge bases`
      )
    }
    // An empty binding is "no knowledge context"; a non-empty one must name
    // only knowledge bases that exist and are active in this tenant.
    if (uniqueKnowledgeBaseIds.length > 0 && this.knowledgeBases) {
      try {
        this.knowledgeBases.resolveScope(tenantId, uniqueKnowledgeBaseIds)
      } catch (error) {
        if (error instanceof KnowledgeBaseNotFoundError) {
          throw new InvalidAssistantCommandError(
            `config.knowledgeBaseIds names an unknown knowledge base`
          )
        }
        if (error instanceof KnowledgeBaseArchivedError) {
          throw new InvalidAssistantCommandError(
            `config.knowledgeBaseIds names an archived knowledge base`
          )
        }
        throw error
      }
    }
    if (body.chatModelProfileId !== "chat") {
      throw new InvalidAssistantCommandError('config.chatModelProfileId must be "chat"')
    }
    const rerankModelProfileId = body.rerankModelProfileId ?? null
    if (rerankModelProfileId !== null && rerankModelProfileId !== "rerank") {
      throw new InvalidAssistantCommandError(
        'config.rerankModelProfileId must be "rerank" or null'
      )
    }
    if (rerankModelProfileId === "rerank") {
      this.bindings?.assertRerankProfileSelectable()
    }
    const toolPolicy = body.toolPolicy ?? "read_only_retrieval"
    if (toolPolicy !== "none" && toolPolicy !== "read_only_retrieval") {
      throw new InvalidAssistantCommandError(
        'config.toolPolicy must be "none" or "read_only_retrieval"'
      )
    }
    const memoryEnabled = body.memoryEnabled ?? false
    if (typeof memoryEnabled !== "boolean") {
      throw new InvalidAssistantCommandError("config.memoryEnabled must be a boolean")
    }
    return {
      systemPrompt,
      knowledgeBaseIds: uniqueKnowledgeBaseIds,
      chatModelProfileId: "chat",
      rerankModelProfileId,
      toolPolicy,
      memoryEnabled,
    }
  }
}
