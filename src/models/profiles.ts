/**
 * Ticket 16 (MODEL-01A) — server-backed model profiles.
 *
 * Four built-in profiles map 1:1 to the server's credential slots:
 *
 *   chat      → OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_CHAT_MODEL
 *   embedding → EMBEDDING_API_KEY / EMBEDDING_BASE_URL / EMBEDDING_MODEL(_DIMENSIONS)
 *   rerank    → RERANK_API_KEY / RERANK_BASE_URL / RERANK_MODEL
 *   typesafe  → TYPESAFE_API_KEY / TYPESAFE_BASE_URL / TYPESAFE_MODEL
 *
 * The registry exposes only non-secret metadata (model id, host, dimensions,
 * configured/enabled flags). Keys never leave the server: the settings
 * workspace may WRITE provider credentials into the server environment file
 * (`.env`, through `saveConfig`) and read back a key-less view, but no
 * response ever carries a key.
 *
 * `credentials(id)` resolves a slot field-by-field — the environment file
 * wins over the boot config — so detection and probes see a save right away.
 * Ordinary model changes apply after restart. The decision provider toggle
 * is persisted in SQLite and applied to the shared runtime config immediately.
 */

import type OpenAI from "openai"
import type { AppConfig } from "../config"
import { readEnvValuesSync, writeEnvValues } from "../config/env_file"
import type { DB } from "../ingestion/tracking/db"

export type ModelProfileId = "chat" | "embedding" | "rerank" | "typesafe"

export const MODEL_PROFILE_IDS: readonly ModelProfileId[] = ["chat", "embedding", "rerank", "typesafe"]
const PROFILE_IDS = MODEL_PROFILE_IDS

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

/** Server-side resolution of one slot: override first, environment second. */
export interface ModelProfileCredentials {
  apiKey: string
  baseUrl: string
  model: string
}

/**
 * What the settings workspace may read back about a slot. The key itself is
 * write-only: the browser learns whether one is stored, never its value.
 */
export interface ModelProfileConfigView {
  id: ModelProfileId
  baseUrl: string
  model: string
  hasApiKey: boolean
  /** "file" when the environment file carries this slot's values. */
  source: "file" | "env"
}

/**
 * A save from the settings workspace. The base URL and model are written
 * verbatim; an omitted API key keeps the stored one (the form never receives
 * it back, so a blank field must not erase it).
 */
export interface ModelProfileConfigSave {
  baseUrl: string
  model: string
  apiKey?: string
}

/** Environment-file keys behind each slot. */
export const SLOT_ENV_KEYS: Record<
  ModelProfileId,
  { apiKey: string; baseUrl: string; model: string }
> = {
  chat: { apiKey: "OPENAI_API_KEY", baseUrl: "OPENAI_BASE_URL", model: "OPENAI_CHAT_MODEL" },
  embedding: {
    apiKey: "EMBEDDING_API_KEY",
    baseUrl: "EMBEDDING_BASE_URL",
    model: "EMBEDDING_MODEL",
  },
  rerank: { apiKey: "RERANK_API_KEY", baseUrl: "RERANK_BASE_URL", model: "RERANK_MODEL" },
  typesafe: { apiKey: "TYPESAFE_API_KEY", baseUrl: "TYPESAFE_BASE_URL", model: "TYPESAFE_MODEL" },
}

/** The boot-config credentials of one server slot (single source for the registry and workspace fallback). */
export function serverProfileCredentials(
  config: AppConfig,
  id: ModelProfileId
): ModelProfileCredentials {
  if (id === "embedding") {
    return { apiKey: config.embeddingApiKey, baseUrl: config.embeddingBaseUrl, model: config.embeddingModel }
  }
  if (id === "rerank") {
    return { apiKey: config.rerankApiKey, baseUrl: config.rerankBaseUrl, model: config.rerankModel }
  }
  if (id === "typesafe") {
    return {
      apiKey: config.typesafeApiKey ?? "",
      baseUrl: config.typesafeBaseUrl ?? "https://api.typesafe.ai",
      model: config.typesafeModel ?? "jev-latest",
    }
  }
  return { apiKey: config.openaiApiKey, baseUrl: config.openaiBaseUrl, model: config.openaiChatModel }
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
  selectable(kind: "chat" | "rerank" | "typesafe"): boolean
}

export class ModelProfileRegistry implements ModelProfileGate {
  constructor(
    private readonly db: DB,
    private readonly config: AppConfig,
    /**
     * The server environment file. Omitted in tests so nothing touches disk;
     * production passes it so a save is visible to detection/probes before
     * the next restart picks it up through dotenv.
     */
    private readonly envPath?: string
  ) {
    this.seed()
    this.syncDecisionProvider()
  }

  /**
   * Seed built-ins once. TypeSafe starts enabled only when selected in boot
   * config; later settings-page choices persist across restarts.
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
      insert.run("typesafe", this.config.decisionProvider === "typesafe" && this.isConfigured("typesafe") ? 1 : 0, now)
    })
    seedAll()
  }

  /** A slot is configured when its resolved key (override or env) is present. */
  private isConfigured(id: ModelProfileId): boolean {
    return this.credentials(id).apiKey.length > 0
  }

  private envFileValues(): Map<string, string> {
    if (!this.envPath) return new Map()
    try {
      return readEnvValuesSync(this.envPath)
    } catch {
      // An unreadable file must not take the settings workspace down; the
      // boot config still describes what this process calls.
      return new Map()
    }
  }

  private envSlot(id: ModelProfileId): ModelProfileCredentials {
    return serverProfileCredentials(this.config, id)
  }

  /**
   * Effective credentials for one slot: the environment file wins per field,
   * so a save is visible to detection/probes immediately; the boot config
   * covers keys the file does not carry.
   */
  credentials(id: ModelProfileId): ModelProfileCredentials {
    const env = this.envSlot(id)
    const file = this.envFileValues()
    const keys = SLOT_ENV_KEYS[id]
    return {
      apiKey: (file.get(keys.apiKey) ?? env.apiKey).trim(),
      baseUrl: (file.get(keys.baseUrl) ?? env.baseUrl).trim(),
      model: (file.get(keys.model) ?? env.model).trim(),
    }
  }

  /** The key-less view the settings workspace renders its form from. */
  configView(id: ModelProfileId): ModelProfileConfigView {
    const creds = this.credentials(id)
    const keys = SLOT_ENV_KEYS[id]
    const file = this.envFileValues()
    return {
      id,
      baseUrl: creds.baseUrl,
      model: creds.model,
      hasApiKey: creds.apiKey.length > 0,
      source: file.has(keys.baseUrl) || file.has(keys.model) ? "file" : "env",
    }
  }

  /**
   * Persist a slot into the environment file. This is the ONLY write path for
   * model credentials; probes read the file and verify saved values right
   * away. Decision config is also updated in memory. Validation lives in the HTTP layer; the saved key is
   * never returned.
   */
  async saveConfig(
    id: string,
    save: ModelProfileConfigSave
  ): Promise<ModelProfileConfigView> {
    if (!(PROFILE_IDS as readonly string[]).includes(id)) {
      throw new ModelProfileError(`unknown model profile "${id}"`, 404)
    }
    if (!this.envPath) {
      throw new ModelProfileError(
        `the ${id} profile is read-only on this server`,
        400,
        "No writable environment file is configured (ENV_FILE)."
      )
    }
    const keys = SLOT_ENV_KEYS[id as ModelProfileId]
    const entries: Record<string, string> = {
      [keys.baseUrl]: save.baseUrl,
      [keys.model]: save.model,
    }
    if (save.apiKey !== undefined) entries[keys.apiKey] = save.apiKey
    await writeEnvValues(this.envPath, entries)
    if (id === "typesafe") {
      this.syncDecisionProvider()
    }
    return this.configView(id as ModelProfileId)
  }

  private persistedEnabled(id: ModelProfileId): boolean {
    const row = this.db
      .prepare("SELECT enabled FROM model_profiles WHERE id = ?")
      .get(id) as { enabled: number } | undefined
    return row?.enabled === 1
  }

  private syncDecisionProvider(): void {
    const credentials = this.credentials("typesafe")
    this.config.typesafeApiKey = credentials.apiKey
    this.config.typesafeBaseUrl = credentials.baseUrl
    this.config.typesafeModel = credentials.model
    this.config.decisionProvider = this.persistedEnabled("typesafe") && credentials.apiKey.length > 0
      ? "typesafe"
      : "chat"
  }

  list(): ModelProfile[] {
    return PROFILE_IDS.map((id) => {
      const creds = this.credentials(id)
      const configured = creds.apiKey.length > 0
      const enabled = this.persistedEnabled(id)
      return {
        id,
        kind: id,
        model: creds.model,
        baseUrlHost: hostOf(creds.baseUrl),
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
  selectable(kind: "chat" | "rerank" | "typesafe"): boolean {
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
      const envVar = id === "rerank"
        ? "RERANK_API_KEY"
        : id === "embedding"
          ? "EMBEDDING_API_KEY"
          : id === "typesafe"
            ? "TYPESAFE_API_KEY"
            : "OPENAI_API_KEY"
      throw new ModelProfileError(
        `the ${id} profile has no credentials configured`,
        400,
        `Save credentials for this profile on its settings card (or set ${envVar}), then enable it.`
      )
    }
    this.db
      .prepare("UPDATE model_profiles SET enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, new Date().toISOString(), id)
    if (id === "typesafe") this.syncDecisionProvider()
    return this.get(id) as ModelProfile
  }
}

/** Test/deps seam so the connectivity router never builds real SDK clients itself. */
export interface ModelProfileClients {
  chatClient: OpenAI
  embeddingClient: OpenAI
}
