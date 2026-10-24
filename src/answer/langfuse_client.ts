import { Langfuse } from "langfuse"
import type {
  LangfuseClient,
  LangfuseTraceSnapshot,
} from "./langfuse_exporter"

/**
 * Production Langfuse client factory — lifts OP-05 (candidate mode).
 *
 * T11 kept the Answer runtime decoupled from the `langfuse` npm package via
 * the narrow `LangfuseClient` interface in `langfuse_exporter.ts`; production
 * wiring never passed a client, so a complete configuration failed at
 * composition ("no client was injected") and the RecordingLangfuseClient in
 * the release probe stood in for the real service.
 *
 * This module is the assembly piece:
 *   - Constructs the real `Langfuse` SDK client when credentials are present
 *     and structurally binds it to the narrow interface (compile-time gate —
 *     no casts; tsc verifies the SDK surface satisfies LangfuseClient).
 *   - Adds `fetchTrace()` read-back over the public REST API
 *     (`GET {baseUrl}/api/public/traces/{id}`), which the SDK does not expose,
 *     so smoke/round-trip probes can verify configured runs reach Langfuse.
 *
 * Self-hosted deployments pass their instance URL as `baseUrl` (falls back to
 * Langfuse cloud). Missing or empty credentials return undefined — disabled
 * mode stays NoopLangfuseExporter (zero cost, per HINTS §2.7).
 */

const DEFAULT_LANGFUSE_HOST = "https://cloud.langfuse.com"

/** Bounded timeout for the read-back REST call. */
const FETCH_TRACE_TIMEOUT_MS = 5_000

/**
 * Build the read-back URL with trailing-slash tolerance on the base URL and
 * an encoded trace id. Exported pure so tests can assert URL shape without
 * network access.
 */
export function langfuseTraceUrl(baseUrl: string, traceId: string): string {
  const base = baseUrl.replace(/\/+$/, "")
  return `${base}/api/public/traces/${encodeURIComponent(traceId)}`
}

const OBSERVATION_LEVELS = ["DEBUG", "DEFAULT", "WARNING", "ERROR"] as const

function parseMetadataField(value: unknown): Record<string, unknown> | undefined {
  // The trace API serializes metadata as a JSON string; some versions return
  // it already parsed. Accept both shapes, reject non-object payloads.
  if (typeof value === "string" && value.length > 0) {
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
      return undefined
    } catch {
      return undefined
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return undefined
}

function toName(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/**
 * Map a GET /api/public/traces/{id} response body onto the probe-facing
 * LangfuseTraceSnapshot. The API flattens spans + generations into one
 * `observations` array (each entry typed "SPAN" | "GENERATION" | "EVENT");
 * the snapshot model expects them split into separate arrays.
 *
 * Exported pure for unit tests (no SDK instantiation — constructing a real
 * client queues background ingestion timers that would keep node:test alive).
 */
export function mapLangfuseApiTraceToSnapshot(
  body: unknown,
): LangfuseTraceSnapshot | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  const observations = Array.isArray(record["observations"]) ? record["observations"] : []

  const spans: LangfuseTraceSnapshot["spans"] = []
  const generations: LangfuseTraceSnapshot["generations"] = []
  for (const observation of observations) {
    if (!observation || typeof observation !== "object") continue
    const obs = observation as Record<string, unknown>
    const level = typeof obs["level"] === "string"
      && (OBSERVATION_LEVELS as readonly string[]).includes(obs["level"])
      ? obs["level"] as (typeof OBSERVATION_LEVELS)[number]
      : undefined
    const statusMessage = typeof obs["statusMessage"] === "string"
      ? obs["statusMessage"]
      : undefined
    const metadata = parseMetadataField(obs["metadata"])
    if (obs["type"] === "SPAN") {
      spans.push({
        name: toName(obs["name"]),
        ...(statusMessage !== undefined ? { statusMessage } : {}),
        ...(level ? { level } : {}),
        ...(metadata ? { metadata } : {}),
      })
    } else if (obs["type"] === "GENERATION") {
      generations.push({
        name: toName(obs["name"]),
        ...(typeof obs["model"] === "string" && obs["model"].length > 0
          ? { model: obs["model"] }
          : {}),
        ...(statusMessage !== undefined ? { statusMessage } : {}),
        ...(level ? { level } : {}),
        ...(metadata ? { metadata } : {}),
      })
    }
  }

  return {
    id: toName(record["id"]),
    name: toName(record["name"]),
    spans,
    generations,
    metadata: parseMetadataField(record["metadata"]),
  }
}

/**
 * Build the real production Langfuse client bound to the narrow
 * `LangfuseClient` seam used by `createAnswerRuntime`.
 *
 * Returns undefined (disabled mode) when either key is absent — matches the
 * runtime's all-or-nothing configuration guard, so Noop export is preserved.
 * When keys are present but partial/invalid the downstream
 * `createLangfuseExporter` keeps failing loudly at composition time.
 */
export function createRealLangfuseClient(options?: {
  publicKey?: string
  secretKey?: string
  baseUrl?: string
}): LangfuseClient | undefined {
  const publicKey = options?.publicKey?.trim()
  const secretKey = options?.secretKey?.trim()
  if (!publicKey || !secretKey) return undefined

  const baseUrl = options?.baseUrl?.trim() || DEFAULT_LANGFUSE_HOST
  const client = new Langfuse({ publicKey, secretKey, baseUrl })

  const authHeader =
    `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`

  return {
    trace: (params) => client.trace(params),
    shutdownAsync: () => client.shutdownAsync(),
    fetchTrace: async (traceId) => {
      const response = await globalThis.fetch(
        langfuseTraceUrl(baseUrl, traceId),
        {
          headers: { Authorization: authHeader },
          signal: AbortSignal.timeout(FETCH_TRACE_TIMEOUT_MS),
        },
      )
      // 404 = not yet queryable (eventual consistency) — probes poll.
      if (response.status === 404) return undefined
      if (!response.ok) {
        throw new Error(`[langfuse] fetchTrace HTTP ${response.status}`)
      }
      return mapLangfuseApiTraceToSnapshot(await response.json())
    },
  }
}
