import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadAppExtensions } from './pi-shared.ts'
import { ensureSubagentConfig, resolveSubagentExtension } from './subagent-extension.ts'

function makeAgentDir(): string {
  return mkdtempSync(join(tmpdir(), 't02-subagent-ext-'))
}

const configDir = (agentDir: string) => join(agentDir, 'extensions', 'subagent')
const configFile = (agentDir: string) => join(configDir(agentDir), 'config.json')

test('config seed 1: missing file is created with the three required keys', () => {
  const agentDir = makeAgentDir()
  ensureSubagentConfig(agentDir)
  assert.ok(existsSync(configFile(agentDir)))
  const parsed = JSON.parse(readFileSync(configFile(agentDir), 'utf8')) as Record<string, unknown>
  // 钉死条件 2（spec: docs/spec/pi-subagents-adoption.md）：eager 激活 + 封死 detached runner
  assert.equal(parsed['toolActivation'], 'eager')
  assert.equal(parsed['asyncByDefault'], false)
  assert.equal(parsed['maxActiveAsyncRunsPerSession'], 0)
})

test('config seed 2: existing user config is never overwritten and stays idempotent', () => {
  const agentDir = makeAgentDir()
  mkdirSync(configDir(agentDir), { recursive: true })
  writeFileSync(configFile(agentDir), JSON.stringify({ toolActivation: 'auto', userCustom: 1 }), 'utf8')
  ensureSubagentConfig(agentDir)
  ensureSubagentConfig(agentDir)
  const parsed = JSON.parse(readFileSync(configFile(agentDir), 'utf8')) as Record<string, unknown>
  assert.equal(parsed['toolActivation'], 'auto')
  assert.equal(parsed['userCustom'], 1)
})

test('config seed 3: broken JSON is never overwritten (pi-seed 同语义)', () => {
  const agentDir = makeAgentDir()
  mkdirSync(configDir(agentDir), { recursive: true })
  writeFileSync(configFile(agentDir), '{ broken', 'utf8')
  ensureSubagentConfig(agentDir)
  assert.equal(readFileSync(configFile(agentDir), 'utf8'), '{ broken')
})

test('resolve 1: returns the packaged extension entry and pins PI_CODING_AGENT_DIR to the agentDir', () => {
  const agentDir = makeAgentDir()
  const entry = resolveSubagentExtension(agentDir)
  assert.ok(entry, 'pi-subagents must be installed as an npm dependency')
  // 0.87.0 发布版是预打包 JS：exports "." 与 pi.extensions 都指 bundle/index.js
  assert.ok(entry.endsWith('index.js') && entry.includes('pi-subagents'), `entry is the bundled extension, got: ${entry}`)
  assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir)
  // 幂等：Router 重建（重复调用）不换 env
  assert.equal(resolveSubagentExtension(agentDir), entry)
  assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir)
})

test('load 1: subagent extension loads through the MCP-factory seam and registers the subagent tool', async () => {
  const agentDir = makeAgentDir()
  const entry = resolveSubagentExtension(agentDir)
  assert.ok(entry)
  const result = await loadAppExtensions({
    cwd: agentDir,
    loadConfig: () => ({ servers: [], errors: [] }),
    extensionPaths: [entry]
  })
  assert.deepEqual(
    result.errors,
    [],
    `extension load errors: ${result.errors.map((e) => `${e.path}: ${e.error}`).join('; ')}`
  )
  const subagent = result.extensions.find((e) => e.path.includes('pi-subagents'))
  assert.ok(subagent, `subagent extension loaded, got: ${result.extensions.map((e) => e.path).join(', ')}`)
  // 工具在加载期注册：eager 激活下 subagent 直接可用（不只有 subagents_enable 加载器）
  assert.ok(subagent.tools.has('subagent'), `subagent tool registered, got: ${[...subagent.tools.keys()].join(', ')}`)
})

test('load 2: nonexistent extension path lands in errors without throwing', async () => {
  const missing = join(makeAgentDir(), 'no-such-extension.ts')
  const result = await loadAppExtensions({
    cwd: makeAgentDir(),
    loadConfig: () => ({ servers: [], errors: [] }),
    extensionPaths: [missing]
  })
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]!.path, missing)
})
