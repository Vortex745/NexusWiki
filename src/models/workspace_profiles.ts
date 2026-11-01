/**
 * Per-workspace model configuration.
 *
 * A local account owns a private workspace tenant (`w-<hash>`). Its model
 * settings live in SQLite; the demo/single-tenant path keeps reading the
 * server environment file through `serverProfileCredentials`.
 *
 * The embedding slot is special: a workspace must configure it before it can
 * own a knowledge base, because the workspace's physical vector index is
 * created from that model and dimension. Once the knowledge base exists the
 * profile is locked — a different vector space cannot be mixed into it.
 */

import { createHash } from "node:crypto"
import type { AppConfig, } from "../config"
import { resolveChunkIndexName } from "../config"
import { readEnvValuesSync } from "../config/env_file"
import type { DB } from "../ingestion/tracking/db"
import { LOCAL_WORKSPACE_TENANT_PREFIX } from "../identity/local_users"
import { knowledgeBaseEmbeddingProfile } from "../types/knowledge_base"
import {
  MODEL_PROFILE_IDS,
  SLOT_ENV_KEYS,
  serverProfileCredentials,
  type ModelProfileCredentials,
  type ModelProfileId,
} from "./profiles"

export type WorkspaceProfileSource = "workspace" | "server"

export interface WorkspaceProfileView {
  id: ModelProfileId
  kind: ModelProfileId
  model: string
  baseUrlHost: string
  dimensions?: number
  configured: boolean
  enabled: boolean
  selectable: boolean
  source: WorkspaceProfileSource
}

export interface WorkspaceConfigView {
  id: ModelProfileId
  baseUrl: string
  model: string
  dimensions?: number
  hasApiKey: boolean
  source: WorkspaceProfileSource
  /** False for the demo/single-tenant path and for embedding on non-workspaces. */
  editable: boolean
}

export interface WorkspaceProfileSave {
  baseUrl: string
  model: string
  apiKey?: string
  dimensions?: number
}

export class WorkspaceProfileError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
    readonly hint?: string
  ) {
    super(message)
    this.name = "WorkspaceProfileError"
  }
}

interface WorkspaceProfileRow {
  tenant_id: string
  profile_id: ModelProfileId
  base_url: string
  model: string
  api_key: string
  dimensions: number | null
  enabled: number
  updated_at: string
}

function hostOf(baseUrl: string): string {
  if (!baseUrl.trim()) return ""
  try {
    return new URL(baseUrl).host
  } catch {
    return "(配置的 BASE_URL 不是合法 URL)"
  }
}

/** A workspace embedding profile includes the gateway, not just model + dimensions. */
export function workspaceEmbeddingProfile(
  baseUrl: string,
  model: string,
  dimensions: number
): string {
  const gateway = createHash("sha256").update(baseUrl.trim()).digest("hex").slice(0, 8)
  return `${model}:${dimensions}:${gateway}`
}

export function isWorkspaceTenant(tenantId: string): boolean {
  return tenantId.startsWith(LOCAL_WORKSPACE_TENANT_PREFIX)
}

/** One physical vector index per private workspace; demo/single keep the shared index. */
export function chunkIndexNameForTenant(tenantId: string, config: AppConfig): string {
  if (!isWorkspaceTenant(tenantId)) return resolveChunkIndexName(undefined, config)
  const suffix = createHash("sha256").update(tenantId).digest("hex").slice(0, 12)
  return `kefu-rag-chunks-${suffix}`
}

export class WorkspaceModelProfileStore {
  constructor(
    private readonly db: DB,
    private readonly config: AppConfig,
    private readonly options: {
      envPath?: string
      now?: () => Date
    } = {}
  ) {}

  isWorkspace(tenantId: string): boolean {
    return isWorkspaceTenant(tenantId)
  }

  /** A private workspace that has not configured embedding yet. */
  requiresEmbeddingSetup(tenantId: string): boolean {
    if (!this.isWorkspace(tenantId)) return false
    const row = this.row(tenantId, "embedding")
    return !row || !row.base_url.trim() || !row.model.trim() || row.dimensions === null
  }

  /**
   * A private workspace runs Answers only with its OWN chat credentials.
   * There is no server-credential fallback, so an unconfigured workspace is
   * refused before any run instead of silently spending the operator's key.
   */
  chatConfigured(tenantId: string): boolean {
    if (!this.isWorkspace(tenantId)) return true
    const row = this.row(tenantId, "chat")
    return (
      row !== null &&
      row.enabled === 1 &&
      row.api_key.trim().length > 0 &&
      row.base_url.trim().length > 0 &&
      row.model.trim().length > 0
    )
  }

  /**
   * The embedding profile of this workspace. Demo/single tenants keep the
   * server profile; an unconfigured workspace cannot own a knowledge base.
   */
  embeddingProfile(tenantId: string): string {
    if (!this.isWorkspace(tenantId)) return this.serverEmbeddingProfile()
    const row = this.row(tenantId, "embedding")
    if (!row || !row.base_url.trim() || !row.model.trim() || row.dimensions === null) {
      throw new WorkspaceProfileError(
        "embedding is not configured for this workspace",
        409,
        "Save the Embedding card in model settings before importing knowledge."
      )
    }
    return workspaceEmbeddingProfile(row.base_url, row.model, row.dimensions)
  }

  serverEmbeddingProfile(): string {
    return knowledgeBaseEmbeddingProfile(
      this.config.embeddingModel,
      this.config.embeddingDimensions
    )
  }

  chunkIndexName(tenantId: string): string {
    return chunkIndexNameForTenant(tenantId, this.config)
  }

  /** Drives the per-workspace Answer entry cache. */
  revision(tenantId: string): string {
    if (!this.isWorkspace(tenantId)) return "server"
    const row = this.db
      .prepare(
        "SELECT MAX(updated_at) AS revision FROM workspace_model_profiles WHERE tenant_id = ?"
      )
      .get(tenantId) as { revision: string | null } | undefined
    return row?.revision ?? "unconfigured"
  }

  list(tenantId: string): WorkspaceProfileView[] {
    return MODEL_PROFILE_IDS.map((id) => {
      const resolved = this.credentials(tenantId, id)
      const enabled = this.enabled(tenantId, id)
      return {
        id,
        kind: id,
        model: resolved.model,
        baseUrlHost: hostOf(resolved.baseUrl),
        ...(id === "embedding" && resolved.dimensions !== null
          ? { dimensions: resolved.dimensions }
          : {}),
        configured: resolved.apiKey.length > 0,
        enabled,
        selectable: enabled && resolved.apiKey.length > 0,
        source: this.source(tenantId),
      }
    })
  }

  configView(tenantId: string, id: ModelProfileId): WorkspaceConfigView {
    const resolved = this.credentials(tenantId, id)
    return {
      id,
      baseUrl: resolved.baseUrl,
      model: resolved.model,
      ...(id === "embedding" && resolved.dimensions !== null
        ? { dimensions: resolved.dimensions }
        : {}),
      hasApiKey: resolved.apiKey.length > 0,
      source: this.source(tenantId),
      editable: this.isWorkspace(tenantId),
    }
  }

  credentials(
    tenantId: string,
    id: ModelProfileId
  ): ModelProfileCredentials & { dimensions: number | null } {
    const row = this.row(tenantId, id)
    if (row) {
      return {
        apiKey: row.api_key.trim(),
        baseUrl: row.base_url.trim(),
        model: row.model.trim(),
        dimensions: row.dimensions,
      }
    }
    // A private workspace owns its settings: an unsaved slot stays empty
    // instead of inheriting the operator's server credentials.
    if (this.isWorkspace(tenantId)) {
      return { apiKey: "", baseUrl: "", model: "", dimensions: null }
    }
    const server = this.serverCredentials(id)
    return {
      ...server,
      dimensions: id === "embedding" ? this.config.embeddingDimensions : null,
    }
  }

  /**
   * Persist one profile for a private workspace. A blank key keeps the stored
   * one; the key itself never comes back from a read.
   */
  save(tenantId: string, id: string, save: WorkspaceProfileSave): WorkspaceConfigView {
    if (!this.isWorkspace(tenantId)) {
      throw new WorkspaceProfileError(
        "the server configuration is managed by the environment file",
        403,
        "Only private workspaces can save model settings here."
      )
    }
    if (!(MODEL_PROFILE_IDS as readonly string[]).includes(id)) {
      throw new WorkspaceProfileError(`unknown model profile "${id}"`, 404)
    }
    const profileId = id as ModelProfileId
    const baseUrl = typeof save.baseUrl === "string" ? save.baseUrl.trim() : ""
    const model = typeof save.model === "string" ? save.model.trim() : ""
    if (!baseUrl || !model) {
      throw new WorkspaceProfileError("baseUrl and model are required", 400)
    }
    let dimensions: number | null = null
    if (profileId === "embedding") {
      const value = save.dimensions
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        throw new WorkspaceProfileError(
          "embedding dimensions are required",
          400,
          "Use the embedding test to read the provider's vector length."
        )
      }
      dimensions = value
    }
    const previous = this.row(tenantId, profileId)
    const providedKey = typeof save.apiKey === "string" ? save.apiKey.trim() : ""
    const apiKey = providedKey || previous?.api_key.trim() || ""
    if (!apiKey) {
      throw new WorkspaceProfileError("apiKey is required", 400)
    }
    // A knowledge base's vector space cannot be swapped in place. Once this
    // workspace owns documents, a different embedding model/gateway/dimension
    // is refused instead of silently detaching retrieval from the index.
    if (
      profileId === "embedding" &&
      previous &&
      (previous.base_url !== baseUrl ||
        previous.model !== model ||
        previous.dimensions !== dimensions)
    ) {
      const owned = this.db
        .prepare("SELECT COUNT(*) AS count FROM documents WHERE tenant_id = ?")
        .get(tenantId) as { count: number } | undefined
      if ((owned?.count ?? 0) > 0) {
        throw new WorkspaceProfileError(
          "this workspace already contains documents; the embedding profile cannot change",
          409,
          "Import into a new knowledge base only after clearing the existing documents."
        )
      }
    }
    const now = (this.options.now ?? (() => new Date()))().toISOString()
    this.db
      .prepare(
        `INSERT INTO workspace_model_profiles (
          tenant_id, profile_id, base_url, model, api_key, dimensions, enabled, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, profile_id) DO UPDATE SET
          base_url = excluded.base_url,
          model = excluded.model,
          api_key = excluded.api_key,
          dimensions = excluded.dimensions,
          updated_at = excluded.updated_at`
      )
      .run(
        tenantId,
        profileId,
        baseUrl,
        model,
        apiKey,
        dimensions,
        previous?.enabled ?? 1,
        now
      )
    return this.configView(tenantId, profileId)
  }

  setEnabled(tenantId: string, id: string, enabled: boolean): WorkspaceProfileView {
    if (!this.isWorkspace(tenantId)) {
      throw new WorkspaceProfileError(
        "the server configuration is managed by the environment file",
        403,
        "Only private workspaces can toggle model profiles here."
      )
    }
    const profile = this.list(tenantId).find((entry) => entry.id === id)
    if (!profile) throw new WorkspaceProfileError(`unknown model profile "${id}"`, 404)
    if (enabled && !profile.configured) {
      throw new WorkspaceProfileError(
        "the profile has no credentials configured",
        400,
        "Save the card before enabling it."
      )
    }
    const now = (this.options.now ?? (() => new Date()))().toISOString()
    const previous = this.row(tenantId, profile.id)
    if (previous) {
      this.db
        .prepare(
          "UPDATE workspace_model_profiles SET enabled = ?, updated_at = ? WHERE tenant_id = ? AND profile_id = ?"
        )
        .run(enabled ? 1 : 0, now, tenantId, profile.id)
    } else {
      // No row yet: a workspace-owned slot starts empty rather than copying
      // the operator's server credentials.
      const workspace = this.isWorkspace(tenantId)
      const credentials = workspace
        ? { baseUrl: "", model: "", apiKey: "" }
        : this.serverCredentials(profile.id)
      this.db
        .prepare(
          `INSERT INTO workspace_model_profiles (
            tenant_id, profile_id, base_url, model, api_key, dimensions, enabled, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          tenantId,
          profile.id,
          credentials.baseUrl,
          credentials.model,
          credentials.apiKey,
          workspace || profile.id !== "embedding" ? null : this.config.embeddingDimensions,
          enabled ? 1 : 0,
          now
        )
    }
    return this.list(tenantId).find((entry) => entry.id === profile.id) as WorkspaceProfileView
  }

  /** The rerank slot is selectable when this workspace (or the server) has it configured. */
  selectable(tenantId: string, id: ModelProfileId): boolean {
    return this.list(tenantId).find((entry) => entry.id === id)?.selectable === true
  }

  private source(tenantId: string): WorkspaceProfileSource {
    return this.isWorkspace(tenantId) ? "workspace" : "server"
  }

  private enabled(tenantId: string, id: ModelProfileId): boolean {
    const row = this.row(tenantId, id)
    if (row) return row.enabled === 1
    // A private workspace never inherits the operator's toggle state.
    if (this.isWorkspace(tenantId)) return id !== "typesafe"
    const seeded = this.db
      .prepare("SELECT enabled FROM model_profiles WHERE id = ?")
      .get(id) as { enabled: number } | undefined
    if (seeded) return seeded.enabled === 1
    // Typesafe starts off unless the server explicitly selected it; the other
    // profiles are usable as soon as their credentials exist.
    if (id === "typesafe") return this.config.decisionProvider === "typesafe"
    return true
  }

  private row(tenantId: string, id: ModelProfileId): WorkspaceProfileRow | null {
    const row = this.db
      .prepare(
        "SELECT tenant_id, profile_id, base_url, model, api_key, dimensions, enabled, updated_at FROM workspace_model_profiles WHERE tenant_id = ? AND profile_id = ?"
      )
      .get(tenantId, id) as WorkspaceProfileRow | undefined
    return row ?? null
  }

  private envFileValues(): Map<string, string> {
    if (!this.options.envPath) return new Map()
    try {
      return readEnvValuesSync(this.options.envPath)
    } catch {
      return new Map()
    }
  }

  private serverCredentials(id: ModelProfileId): ModelProfileCredentials {
    const base = serverProfileCredentials(this.config, id)
    const keys = SLOT_ENV_KEYS[id]
    const file = this.envFileValues()
    return {
      apiKey: (file.get(keys.apiKey) ?? base.apiKey).trim(),
      baseUrl: (file.get(keys.baseUrl) ?? base.baseUrl).trim(),
      model: (file.get(keys.model) ?? base.model).trim(),
    }
  }
}
