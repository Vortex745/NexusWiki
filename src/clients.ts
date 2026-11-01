import { Client } from "@elastic/elasticsearch"
import OpenAI from "openai"

/**
 * Shared client-construction infrastructure (same role as `src/graph` —
 * a root-level module every layer may depend on).
 *
 * Consolidates the OpenAI timeout/retry wiring and the Elasticsearch
 * v9-client → v8-server media-type headers that were previously copied
 * at every construction site (process_runtime, answer/runtime, ingestion
 * storage ×2, wikifier).
 */

/** Options every OpenAI-compatible client construction site shares. */
export interface OpenAIClientOptions {
  apiKey: string
  baseURL?: string
  timeout?: number
  maxRetries?: number
}

/** Options every Elasticsearch client construction site shares. */
export interface ElasticsearchNodeOptions {
  node: string
  apiKey?: string
}

/**
 * OpenAI SDK per-request options bound from config: a finite timeout so a
 * hung provider cannot occupy a connection for the SDK default 10 minutes,
 * and a bounded retry count (SDK default 2). Applied at every client
 * construction site so every chat/embedding call in the Answer + ingestion
 * chains inherits the same bound.
 */
export function openaiClientOptions(cfg: {
  openaiRequestTimeoutMs: number
  openaiMaxRetries: number
}): { timeout: number; maxRetries: number } {
  return {
    timeout: cfg.openaiRequestTimeoutMs,
    maxRetries: cfg.openaiMaxRetries,
  }
}

/**
 * ES client v9 defaults to compatible-with=9 media-type headers, but the
 * deployed server is v8/v7 — without these headers the server rejects every
 * request with media_type_header_exception. Pin to 8 for forward-compat
 * with v8 servers (v9 client → v8 server is supported when the
 * Accept/Content-Type advertise compatible-with=8).
 */
export function esCompatHeaders(): Record<string, string> {
  return {
    accept: "application/vnd.elasticsearch+json; compatible-with=8",
    "content-type": "application/vnd.elasticsearch+json; compatible-with=8",
  }
}

export function createOpenAIClient(options: OpenAIClientOptions): OpenAI {
  return new OpenAI(options)
}

export function createElasticsearchClient(
  options: ElasticsearchNodeOptions
): Client {
  return new Client({
    node: options.node,
    ...(options.apiKey ? { auth: { apiKey: options.apiKey } } : {}),
    headers: esCompatHeaders(),
  })
}
