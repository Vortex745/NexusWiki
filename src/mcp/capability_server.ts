/**
 * Ticket 35 (TOOL-01B) — the local READ-ONLY MCP capability server.
 *
 * A stdio MCP server that reports the deployment's capability state —
 * Elasticsearch, Neo4j, model, Rerank, parser — and NOTHING else: every tool
 * is a status probe, the outputs carry booleans and identifiers (never
 * credentials, endpoints or file paths), and nothing here mutates state.
 * Discovery and calls therefore expose only safe capability status.
 *
 * Runs as its own child process (the MCP client spawns it); probes are
 * bounded (each has a deadline) so a half-dead backend shows up as
 * "unavailable" instead of a hang.
 */

import { Client as EsClient } from "@elastic/elasticsearch"
import neo4j from "neo4j-driver"
import { spawnSync } from "node:child_process"
import { MCPServer } from "@mastra/mcp"
import { createTool } from "@mastra/core/tools"
import { z } from "zod"
import { loadConfig, type AppConfig } from "../config"

const PROBE_TIMEOUT_MS = 3_000

function bounded<T>(probe: () => Promise<T>): Promise<{ ok: boolean; detail?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    probe()
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({
        ok: false as const,
        detail: (error instanceof Error ? error.message : String(error)).slice(0, 200),
      })),
    new Promise<{ ok: boolean; detail: string }>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, detail: `probe exceeded ${PROBE_TIMEOUT_MS}ms` }),
        PROBE_TIMEOUT_MS
      )
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

async function elasticsearchStatus(config: AppConfig) {
  const client = new EsClient({ node: config.esNode })
  try {
    const probe = await bounded(() => client.ping({ request_timeout: `${PROBE_TIMEOUT_MS}ms` } as never))
    return {
      capability: "elasticsearch",
      configured: true,
      reachable: probe.ok,
      ...(probe.detail ? { detail: probe.detail } : {}),
    }
  } finally {
    await client.close().catch(() => {})
  }
}

async function neo4jStatus(config: AppConfig) {
  const driver = neo4j.driver(
    config.neo4jUri,
    neo4j.auth.basic(config.neo4jUser, config.neo4jPassword)
  )
  try {
    const probe = await bounded(() => driver.getServerInfo())
    return {
      capability: "neo4j",
      configured: Boolean(config.neo4jUri),
      reachable: probe.ok,
      ...(probe.detail ? { detail: probe.detail } : {}),
    }
  } finally {
    await driver.close().catch(() => {})
  }
}

function modelStatus(config: AppConfig) {
  // Configuration state only — never the credentials themselves.
  return {
    capability: "model",
    configured: Boolean(config.openaiApiKey),
    chatModel: config.openaiChatModel,
    embeddingModel: config.embeddingModel,
  }
}

function rerankStatus(config: AppConfig) {
  return {
    capability: "rerank",
    configured: Boolean(config.rerankBaseUrl && config.rerankModel),
    model: config.rerankModel || null,
  }
}

function commandOnPath(command: string): boolean {
  const result = spawnSync(command, ["--help"], {
    timeout: PROBE_TIMEOUT_MS,
    shell: process.platform === "win32",
    stdio: "ignore",
  })
  return !result.error
}

function parserStatus(config: AppConfig) {
  const candidates = {
    markitdown: commandOnPath(config.markitdownCommand ?? "markitdown"),
    marker: config.markerCommand ? commandOnPath(config.markerCommand) : false,
    mineru: config.mineruCommand ? commandOnPath(config.mineruCommand) : false,
    builtin_pdf: commandOnPath(config.pythonCommand ?? "python"),
  }
  return {
    capability: "parser",
    configured: Object.values(candidates).some(Boolean),
    available: candidates,
  }
}

/**
 * Build the local capability server. Tool outputs are safe status objects
 * only; the empty strict input schemas leave nothing for a caller to widen.
 */
export function createCapabilityServer(config: AppConfig = loadConfig()): MCPServer {
  return new MCPServer({
    name: "kefu-rag-capabilities",
    version: "1.0.0",
    tools: {
      elasticsearch_status: createTool({
        id: "elasticsearch_status",
        description: "Read-only Elasticsearch capability status of this deployment.",
        inputSchema: z.strictObject({}),
        execute: async () => elasticsearchStatus(config),
      }),
      neo4j_status: createTool({
        id: "neo4j_status",
        description: "Read-only Neo4j graph capability status of this deployment.",
        inputSchema: z.strictObject({}),
        execute: async () => neo4jStatus(config),
      }),
      model_status: createTool({
        id: "model_status",
        description: "Read-only chat/embedding model configuration status (no credentials).",
        inputSchema: z.strictObject({}),
        execute: async () => modelStatus(config),
      }),
      rerank_status: createTool({
        id: "rerank_status",
        description: "Read-only dedicated reranker configuration status (no credentials).",
        inputSchema: z.strictObject({}),
        execute: async () => rerankStatus(config),
      }),
      parser_status: createTool({
        id: "parser_status",
        description: "Read-only document parser availability (markitdown/marker/mineru/builtin-pdf runtime on PATH).",
        inputSchema: z.strictObject({}),
        execute: async () => parserStatus(config),
      }),
    },
  })
}

/** The tool names the capability server advertises (discovery expectation). */
export const CAPABILITY_TOOL_NAMES = [
  "elasticsearch_status",
  "neo4j_status",
  "model_status",
  "rerank_status",
  "parser_status",
] as const
