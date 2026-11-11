import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadAppMcpConfig } from './mcp-config.ts'

function makeAgentDir(): string {
  return mkdtempSync(join(tmpdir(), 't02-mcp-config-'))
}

function writeMcpJson(agentDir: string, content: string): void {
  writeFileSync(join(agentDir, 'mcp.json'), content, 'utf8')
}

test('boundary 1: missing mcp.json means zero servers and no errors', async () => {
  const agentDir = makeAgentDir()
  const result = await loadAppMcpConfig(agentDir)
  assert.deepEqual(result.servers, [])
  assert.deepEqual(result.errors, [])
})

test('boundary 2: broken JSON yields an error with the file path and no servers', async () => {
  const agentDir = makeAgentDir()
  writeMcpJson(agentDir, '{ "mcpServers": { ')
  const result = await loadAppMcpConfig(agentDir)
  assert.deepEqual(result.servers, [])
  assert.equal(result.errors.length, 1)
  assert.ok(result.errors[0]!.includes(join(agentDir, 'mcp.json')), 'error names the config file')
})

test('boundary 2: unreadable mcp.json (directory in its place) yields an error, no servers', async () => {
  const agentDir = makeAgentDir()
  mkdirSync(join(agentDir, 'mcp.json'))
  const result = await loadAppMcpConfig(agentDir)
  assert.deepEqual(result.servers, [])
  assert.equal(result.errors.length, 1)
  rmSync(join(agentDir, 'mcp.json'), { recursive: true })
})

test('boundary 3: missing mcpServers key is an empty config, not an error', async () => {
  const agentDir = makeAgentDir()
  writeMcpJson(agentDir, '{}')
  const result = await loadAppMcpConfig(agentDir)
  assert.deepEqual(result.servers, [])
  assert.deepEqual(result.errors, [])
})

test('boundary 3: non-object mcpServers is an error', async () => {
  const agentDir = makeAgentDir()
  writeMcpJson(agentDir, '{ "mcpServers": ["nope"] }')
  const result = await loadAppMcpConfig(agentDir)
  assert.deepEqual(result.servers, [])
  assert.equal(result.errors.length, 1)
})

test('boundary 4: stdio entry without command lands in errors', async () => {
  const agentDir = makeAgentDir()
  writeMcpJson(agentDir, '{ "mcpServers": { "broken": { "args": ["x"] } } }')
  const result = await loadAppMcpConfig(agentDir)
  assert.deepEqual(result.servers, [])
  assert.equal(result.errors.length, 1)
  assert.ok(result.errors[0]!.includes('broken'), `error names the server: ${result.errors[0]}`)
})

test('boundary 4: http entry without url lands in errors', async () => {
  const agentDir = makeAgentDir()
  writeMcpJson(agentDir, '{ "mcpServers": { "docs": { "type": "http", "headers": {} } } }')
  const result = await loadAppMcpConfig(agentDir)
  assert.deepEqual(result.servers, [])
  assert.equal(result.errors.length, 1)
})

test('boundary 4: non-object entry lands in errors', async () => {
  const agentDir = makeAgentDir()
  writeMcpJson(agentDir, '{ "mcpServers": { "bad": "just a string" } }')
  const result = await loadAppMcpConfig(agentDir)
  assert.deepEqual(result.servers, [])
  assert.equal(result.errors.length, 1)
})

test('boundary 5: exposure defaults to direct', async () => {
  const agentDir = makeAgentDir()
  writeMcpJson(agentDir, '{ "mcpServers": { "probe": { "command": "node", "args": ["x.js"] } } }')
  const result = await loadAppMcpConfig(agentDir)
  assert.deepEqual(result.errors, [])
  assert.equal(result.servers.length, 1)
  assert.equal(result.servers[0]!.config.exposure, 'direct')
})

test('boundary 5: explicit exposure and per-tool toolExposure are kept as written', async () => {
  const agentDir = makeAgentDir()
  writeMcpJson(
    agentDir,
    '{ "mcpServers": { "probe": { "command": "node", "exposure": "hidden", "toolExposure": { "echo": "direct" } } } }'
  )
  const result = await loadAppMcpConfig(agentDir)
  assert.deepEqual(result.errors, [])
  const config = result.servers[0]!.config
  assert.equal(config.exposure, 'hidden')
  assert.deepEqual(config.toolExposure, { echo: 'direct' })
})

test('boundary 6: enabled false entries are kept with enabled false', async () => {
  const agentDir = makeAgentDir()
  writeMcpJson(agentDir, '{ "mcpServers": { "off": { "command": "node", "enabled": false } } }')
  const result = await loadAppMcpConfig(agentDir)
  assert.deepEqual(result.errors, [])
  assert.equal(result.servers.length, 1)
  assert.equal(result.servers[0]!.config.enabled, false)
})

test('boundary 7: env variable references pass through untouched (pi transport resolves them)', async () => {
  const agentDir = makeAgentDir()
  writeMcpJson(
    agentDir,
    '{ "mcpServers": { "probe": { "command": "node", "env": { "TOKEN": "${PROBE_TOKEN}" } } } }'
  )
  const result = await loadAppMcpConfig(agentDir)
  assert.deepEqual(result.errors, [])
  const config = result.servers[0]!.config
  assert.ok('env' in config && config.env, 'stdio config carries env')
  assert.deepEqual(config.env, { TOKEN: '${PROBE_TOKEN}' })
})

test('boundary 8: legacy sse type is rejected into errors', async () => {
  const agentDir = makeAgentDir()
  writeMcpJson(agentDir, '{ "mcpServers": { "old": { "type": "sse", "url": "https://example.com/sse" } } }')
  const result = await loadAppMcpConfig(agentDir)
  assert.deepEqual(result.servers, [])
  assert.equal(result.errors.length, 1)
  assert.ok(result.errors[0]!.includes('SSE'), `error mentions SSE: ${result.errors[0]}`)
})

test('boundary 9: empty mcpServers object means zero servers and no errors', async () => {
  const agentDir = makeAgentDir()
  writeMcpJson(agentDir, '{ "mcpServers": {} }')
  const result = await loadAppMcpConfig(agentDir)
  assert.deepEqual(result.servers, [])
  assert.deepEqual(result.errors, [])
})

test('valid stdio and http entries both load with their source file recorded', async () => {
  const agentDir = makeAgentDir()
  writeMcpJson(
    agentDir,
    '{ "mcpServers": { "fs": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }, "docs": { "type": "http", "url": "https://example.com/mcp" } } }'
  )
  const result = await loadAppMcpConfig(agentDir)
  assert.deepEqual(result.errors, [])
  assert.equal(result.servers.length, 2)
  const stdio = result.servers.find((s) => s.name === 'fs')
  const http = result.servers.find((s) => s.name === 'docs')
  assert.equal(stdio?.config.type, 'stdio')
  assert.equal(stdio?.source, join(agentDir, 'mcp.json'))
  assert.equal(http?.config.type, 'http')
  assert.equal(http?.config.url, 'https://example.com/mcp')
})

test('broken entries do not stop valid ones from loading', async () => {
  const agentDir = makeAgentDir()
  writeMcpJson(
    agentDir,
    '{ "mcpServers": { "ok": { "command": "node" }, "bad": { "type": "sse", "url": "x" } } }'
  )
  const result = await loadAppMcpConfig(agentDir)
  assert.equal(result.servers.length, 1)
  assert.equal(result.servers[0]!.name, 'ok')
  assert.equal(result.errors.length, 1)
})
