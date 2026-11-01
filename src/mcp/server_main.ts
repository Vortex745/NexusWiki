/**
 * Ticket 35 (TOOL-01B) — the capability server entry point.
 *
 * Spawned by the MCP tool bridge as a child process over stdio. Exits when
 * the parent closes the transport; nothing here listens on a port.
 */

import { createCapabilityServer } from "./capability_server"
import { loadConfig } from "../config"

async function main() {
  const config = loadConfig()
  const server = createCapabilityServer(config)
  await server.startStdio()
}

void main().catch((error) => {
  console.error("[mcp-capabilities] failed to start:", error instanceof Error ? error.message : error)
  process.exit(1)
})
