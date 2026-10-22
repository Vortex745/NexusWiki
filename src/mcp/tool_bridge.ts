/**
 * Ticket 35 (TOOL-01B) — the MCP tool bridge.
 *
 * Discovers the local capability server's tools through @mastra/mcp and
 * registers them into the ticket-34 tool registry, so MCP calls inherit the
 * exact bounded properties every tool has: allowlist, trace records,
 * deadline and cancellation. The bridge never makes chat depend on itself:
 * discovery failures leave the registry without the MCP tools and ordinary
 * answering untouched.
 *
 * ponytail: MCP tool arguments are validated as plain objects here — the
 * SERVER enforces its declared JSON schema (MCP protocol behavior). When a
 * third-party MCP server needs stricter client-side validation, translate
 * its inputSchema into zod at registration.
 *
 * DR-20 (T1-AC07): authority is NOT a tool parameter. A run's tenant,
 * subject, groups and scope live in the tool environment; an argument that
 * names any of them is refused here, before the call leaves this process,
 * whichever server declared the tool.
 */

import path from "node:path"
import { MCPClient } from "@mastra/mcp"
import { z } from "zod"
import type { ToolRegistry } from "../tools/invocation"
import type { AppConfig } from "../config"

export interface McpToolBridge {
  /** The names the tools are registered under (prefixed, namespaced). */
  toolNames(): string[]
  /** Safe status snapshot for trace/discovery visibility. */
  status(): {
    enabled: boolean
    connected: boolean
    tools: string[]
    error?: string
  }
  close(): Promise<void>
}

const ACCESS_CONTEXT_ARGUMENT_KEYS = [
  "accessContext",
  "retrievalScope",
  "tenant",
  "tenantId",
  "subject",
  "subjectId",
  "scope",
  "scopes",
  "groups",
] as const

const AUTHORITY_ARGUMENT_ERROR =
  "MCP tool arguments cannot carry tenant, subject or scope; authority comes from the run environment"

/**
 * The invocation boundary parses every MCP call with this schema. The plain
 * record keeps the server's own JSON-schema enforcement authoritative for
 * tool-specific parameters; the refinement refuses injected AUTHORITY fields
 * so no server — local or third-party — ever receives them.
 */
const mcpToolArguments = z
  .record(z.string(), z.unknown())
  .superRefine((args, context) => {
    const injected = Object.keys(args).find((key) =>
      (ACCESS_CONTEXT_ARGUMENT_KEYS as readonly string[]).includes(key)
    )
    if (injected) {
      context.addIssue({
        code: "custom",
        path: [injected],
        message: AUTHORITY_ARGUMENT_ERROR,
      })
    }
  })

export interface McpToolBridgeOptions {
  registry: ToolRegistry
  config: AppConfig
  /**
   * Test seam: override the spawn command (defaults to this process's node
   * running the TS entry through tsx — the deployment runs TypeScript
   * directly).
   */
  serverCommand?: { command: string; args: string[] }
  connectTimeoutMs?: number
}

export async function createMcpToolBridge(
  options: McpToolBridgeOptions
): Promise<McpToolBridge | null> {
  const { registry, config } = options
  if (!config.mcpCapabilitiesEnabled) return null

  // This deployment runs TypeScript directly (tsx), so the child entry is
  // the source file beside this module; dotenv/config gives the child the
  // same .env the server process loaded.
  const serverPath = path.resolve(__dirname, "server_main.ts")
  const command =
    options.serverCommand ??
    { command: process.execPath, args: ["--import", "tsx", "--import", "dotenv/config", serverPath] }
  const client = new MCPClient({
    id: "kefu-rag-capabilities",
    servers: { capabilities: command },
    timeout: options.connectTimeoutMs ?? 15_000,
  })

  let discoveryError: string | undefined
  let connected = false
  const registeredNames: string[] = []
  const REGISTERED_PREFIX = "mcp_"

  /**
   * MCP call results arrive as the protocol envelope
   * `{ content: [{ type: "text", text }], isError }`. Unwrap the single text
   * payload (our capability server returns JSON objects) so the boundary's
   * result is plain data; in-band errors become bounded tool failures.
   */
  const unwrapMcpResult = (raw: unknown): unknown => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw
    // @mastra/mcp reports a rejected call (e.g. the server's input-schema
    // validation) as `{ error: true, message }` instead of throwing. That is a
    // refusal, never data: surfacing it as an `ok` result would hide both the
    // refusal and its bounded terminal from the caller.
    const refusal = raw as { error?: unknown; message?: unknown }
    if (refusal.error === true && typeof refusal.message === "string") {
      throw new Error(refusal.message.slice(0, 200))
    }
    const envelope = raw as { isError?: boolean; content?: Array<{ type?: string; text?: string }> }
    if (!Array.isArray(envelope.content)) return raw
    if (envelope.isError) {
      throw new Error(
        String(envelope.content[0]?.text ?? "mcp tool error").slice(0, 200)
      )
    }
    const first = envelope.content[0]
    if (envelope.content.length === 1 && first?.type === "text" && typeof first.text === "string") {
      try {
        return JSON.parse(first.text) as unknown
      } catch {
        return first.text
      }
    }
    return raw
  }

  const discover = async (): Promise<boolean> => {
    try {
      const tools = await client.listTools()
      for (const [discoveredName, tool] of Object.entries(tools)) {
        if (registeredNames.includes(`${REGISTERED_PREFIX}${discoveredName}`)) continue
        // The client namespaces discovered tools; keep the namespace visible
        // so trace records and the allowlist name the origin explicitly.
        const registeredName = `${REGISTERED_PREFIX}${discoveredName}`.slice(0, 100)
        const executable = tool.execute as
          | ((input: unknown, context?: unknown) => Promise<unknown>)
          | undefined
        if (!executable) continue
        registry.register({
          name: registeredName,
          description: (tool.description ?? "MCP capability status tool").slice(0, 300),
          // DR-20: the server's declared JSON schema still governs its own
          // parameters, but authority keys are refused at THIS boundary.
          schema: mcpToolArguments,
          summarize: (args) => JSON.stringify(args ?? {}).slice(0, 160),
          execute: async (args) => unwrapMcpResult(await executable(args)),
        })
        registeredNames.push(registeredName)
      }
      return registeredNames.length > 0
    } catch (error) {
      discoveryError = (error instanceof Error ? error.message : String(error)).slice(0, 200)
      return false
    }
  }

  connected = await discover()
  if (!connected) discoveryError ??= "discovery returned no callable tools"
  // Bounded recovery: one discovery retry per minute while disconnected —
  // never blocks chat (registration is additive) and stops once connected.
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  if (!connected) {
    retryTimer = setInterval(() => {
      void discover().then((ok) => {
        if (ok && retryTimer) {
          clearInterval(retryTimer)
          retryTimer = null
        }
      })
    }, 60_000)
    retryTimer.unref?.()
  }

  return {
    toolNames: () => [...registeredNames],
    status: () => ({
      enabled: true,
      connected,
      tools: [...registeredNames],
      ...(discoveryError ? { error: discoveryError } : {}),
    }),
    close: async () => {
      if (retryTimer) {
        clearInterval(retryTimer)
        retryTimer = null
      }
      await client.disconnect().catch(() => {})
    },
  }
}
