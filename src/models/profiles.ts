/**
 * Ticket 16 (MODEL-01A) — server-backed model profiles.
 *
 * Three built-in profiles map 1:1 to the server's credential slots:
 *
 *   chat      → OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_CHAT_MODEL
 *   embedding → EMBEDDING_API_KEY / EMBEDDING_BASE_URL / EMBEDDING_MODEL(_DIMENSIONS)
 *   rerank    → RERANK_API_KEY / RERANK_BASE_URL / RERANK_MODEL
 *
 * The registry exposes only non-secret metadata (model id, host, dimensions,
 * configured/enabled flags). Keys and full URLs never leave the server, and
 * the registry NEVER writes environment files — the only mutable state is the
 * `enabled` toggle persisted in SQLite (`model_profiles`), which governs
 * whether a profile may be SELECTED through raw request values (evaluation
 * model overrides today; assistant bindings in ticket 18).
 *
 * `configured` is derived live from the credential slot, so removing a key on
 * restart disables selection regardless of the persisted toggle.
 */

import type OpenAI from "openai"
import type { AppConfig } from "../config"
import type { DB } from "../ingestion/tracking/db"

export type ModelProfileId = "chat" | "embedding" | "rerank"

const PROFILE_IDS: readonly ModelProfileId[] = ["chat", "embedding", "rerank"]

/** Non-secret profile metadata — safe to send to the browser. */
export interface ModelProfile {
  id: ModelProfileId
  kind: ModelProfileId
  model: string
  /** Host only (scheme/credentials/path stripped) for display. */
  baseUrlHost: string
  /** Embedding only. */
  dimensions?: number
  /** The credential slot for this profile is filled. */
  configured: boolean
  /** The persisted admin toggle. */
  enabled: boolean
  /** enabled AND configured — the gate raw request values must pass. */
  selectable: boolean
}

export class ModelProfileError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
    readonly hint?: string
  ) {
    super(message)
    this.name = "ModelProfileError"
  }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl || "https://api.openai.com/v1").host
  } catch {
    // A malformed configured URL is a real deployment error — report it
    // without echoing the value (which could carry credential material).
    return "(配置的 BASE_URL 不是合法 URL)"
  }
}

/** The gate evaluation (and later assistants) consult before honoring a model selection. */
export interface ModelProfileGate {
  selectable(kind: "chat" | "rerank"): boolean
}

export class ModelProfileRegistry implements ModelProfileGate {
  constructor(
    private readonly db: DB,
    private readonly config: AppConfig
  ) {
    this.seed()
  }

  /**
   * Seed the three built-ins once. The initial toggle mirrors the credential
   * slot (a profile without credentials starts disabled); an existing row is
   * never overwritten — the admin's choice persists across restarts.
   */
  private seed(): void {
    const now = new Date().toISOString()
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO model_profiles (id, enabled, updated_at) VALUES (?, ?, ?)"
    )
    const seedAll = this.db.transaction(() => {
      insert.run("chat", 1, now)
      insert.run("embedding", 1, now)
      insert.run("rerank", this.isConfigured("rerank") ? 1 : 0, now)
    })
    seedAll()
  }

  /** Chat/embedding keys are required by loadConfig; rerank's is optional. */
  private isConfigured(id: ModelProfileId): boolean {
    if (id === "rerank") return this.config.rerankApiKey.trim().length > 0
    return true
  }

  private persistedEnabled(id: ModelProfileId): boolean {
    const row = this.db
      .prepare("SELECT enabled FROM model_profiles WHERE id = ?")
      .get(id) as { enabled: number } | undefined
    return row?.enabled === 1
  }

  list(): ModelProfile[] {
    return PROFILE_IDS.map((id) => {
      const configured = this.isConfigured(id)
      const enabled = this.persistedEnabled(id)
      const chatClientBase =
        id === "embedding"
          ? this.config.embeddingBaseUrl
          : id === "rerank"
            ? this.config.rerankBaseUrl
            : this.config.openaiBaseUrl
      return {
        id,
        kind: id,
        model:
          id === "embedding"
            ? this.config.embeddingModel
            : id === "rerank"
              ? this.config.rerankModel
              : this.config.openaiChatModel,
        baseUrlHost: hostOf(chatClientBase),
        ...(id === "embedding" ? { dimensions: this.config.embeddingDimensions } : {}),
        configured,
        enabled,
        selectable: enabled && configured,
      }
    })
  }

  get(id: string): ModelProfile | undefined {
    return this.list().find((profile) => profile.id === id)
  }

  /** The selection gate: an unknown or non-selectable profile refuses selection. */
  selectable(kind: "chat" | "rerank"): boolean {
    const profile = this.get(kind)
    return profile?.selectable === true
  }

  /**
   * Toggle the persisted enabled flag. Enabling a profile whose credential
   * slot is empty is refused with the env var that must be set — the admin
   * can never flip a profile into a state the process cannot serve.
   */
  setEnabled(id: string, enabled: boolean): ModelProfile {
    const profile = this.get(id)
    if (!profile) {
      throw new ModelProfileError(`unknown model profile "${id}"`, 404)
    }
    if (enabled && !profile.configured) {
      const envVar = id === "rerank" ? "RERANK_API_KEY" : id === "embedding" ? "EMBEDDING_API_KEY" : "OPENAI_API_KEY"
      throw new ModelProfileError(
        `the ${id} profile has no credentials configured`,
        400,
        `Set ${envVar} in the server environment and restart, then enable it here.`
      )
    }
    this.db
      .prepare("UPDATE model_profiles SET enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, new Date().toISOString(), id)
    return this.get(id) as ModelProfile
  }
}

/** Test/deps seam so the connectivity router never builds real SDK clients itself. */
export interface ModelProfileClients {
  chatClient: OpenAI
  embeddingClient: OpenAI
}
