import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import type { SpanExporter } from "@opentelemetry/sdk-trace-base"
import { NoopTracingRuntime, type TracingRuntime } from "./contract"
import { OtelTracingRuntime } from "./otel_runtime"

/**
 * LO-05: composition root for tracing.
 *
 * Tracing is OFF unless explicitly switched on AND the export target is
 * configured AND the sample rate is a legal, non-zero value. A typo in
 * LANGFUSE_SAMPLE_RATE therefore turns tracing off with a warning instead of
 * silently tracing everything (LG-04-AC03).
 *
 * The exporter is injectable so tests can drive a fake backend; production
 * builds the OTLP/protobuf exporter against the deployed Langfuse instance.
 */

export interface TracingEnv {
  [key: string]: string | undefined
}

export type TracingDisabledReason =
  | "disabled_by_env"
  | "invalid_sample_rate"
  | "sample_rate_zero"
  | "missing_credentials"
  | "invalid_endpoint"

export interface TracingConfig {
  enabled: boolean
  sampleRate: number
  reason: "enabled" | TracingDisabledReason
  warnings: string[]
}

/** OTLP/HTTP ingestion path of Langfuse v3 (gRPC is not supported). */
export const OTEL_TRACES_PATH = "/api/public/otel/v1/traces"

/**
 * `x-langfuse-ingestion-version: 4` opts into near-real-time ingestion;
 * without it Langfuse may hold OTel data for up to ~10 minutes.
 */
export const LANGFUSE_INGESTION_VERSION_HEADER = "x-langfuse-ingestion-version"

export function resolveTracingConfig(env: TracingEnv = process.env): TracingConfig {
  const flag = (env.TRACING_ENABLED ?? "").trim().toLowerCase()
  if (flag !== "1" && flag !== "true") {
    return { enabled: false, sampleRate: 0, reason: "disabled_by_env", warnings: [] }
  }

  const rawRate = (env.LANGFUSE_SAMPLE_RATE ?? "1").trim()
  const parsedRate = rawRate === "" ? 1 : Number(rawRate)
  if (!Number.isFinite(parsedRate) || parsedRate < 0 || parsedRate > 1) {
    return {
      enabled: false,
      sampleRate: 0,
      reason: "invalid_sample_rate",
      warnings: [`invalid LANGFUSE_SAMPLE_RATE="${rawRate}" — tracing stays off`],
    }
  }
  if (parsedRate === 0) {
    return { enabled: false, sampleRate: 0, reason: "sample_rate_zero", warnings: [] }
  }

  const baseUrl = (env.LANGFUSE_BASE_URL ?? "").trim()
  const publicKey = (env.LANGFUSE_PUBLIC_KEY ?? "").trim()
  const secretKey = (env.LANGFUSE_SECRET_KEY ?? "").trim()
  if (!baseUrl || !publicKey || !secretKey) {
    return {
      enabled: false,
      sampleRate: parsedRate,
      reason: "missing_credentials",
      warnings: ["LANGFUSE_BASE_URL / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY missing — tracing stays off"],
    }
  }
  try {
    const parsed = new URL(baseUrl)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol")
    }
  } catch {
    return {
      enabled: false,
      sampleRate: parsedRate,
      reason: "invalid_endpoint",
      warnings: [`invalid LANGFUSE_BASE_URL="${baseUrl}" — tracing stays off`],
    }
  }

  return { enabled: true, sampleRate: parsedRate, reason: "enabled", warnings: [] }
}

export interface CreateTracingOptions {
  env?: TracingEnv
  exporter?: SpanExporter
}

export function createTracingRuntime(options: CreateTracingOptions = {}): {
  runtime: TracingRuntime
  config: TracingConfig
} {
  const env = options.env ?? process.env
  const config = resolveTracingConfig(env)
  if (!config.enabled) {
    return { runtime: new NoopTracingRuntime(), config }
  }

  const baseUrl = (env.LANGFUSE_BASE_URL ?? "").trim().replace(/\/+$/, "")
  const publicKey = (env.LANGFUSE_PUBLIC_KEY ?? "").trim()
  const secretKey = (env.LANGFUSE_SECRET_KEY ?? "").trim()
  const exporter =
    options.exporter ??
    new OTLPTraceExporter({
      url: `${baseUrl}${OTEL_TRACES_PATH}`,
      headers: {
        Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`,
        [LANGFUSE_INGESTION_VERSION_HEADER]: "4",
      },
      timeoutMillis: 10_000,
    })

  const runtime = new OtelTracingRuntime({
    sampleRate: config.sampleRate,
    exporter,
    serviceName: (env.OTEL_SERVICE_NAME ?? "kefu-rag").trim(),
    warnings: config.warnings,
  })
  return { runtime, config }
}
