import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensurePiProviderSeed } from './pi-seed.ts'
import { MODEL_LLM } from './config.ts'

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return db
}

function setupAgentDir(): string {
  return mkdtempSync(join(tmpdir(), 'rag-pi-seed-'))
}

function getSetting(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

function setSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value)
}

test('absent models.json is created with the siliconflow provider and router.model is defaulted', () => {
  const db = setupDb()
  const agentDir = setupAgentDir()
  setSetting(db, 'rag.apiKey', 'sk-seed')
  ensurePiProviderSeed(db, agentDir)

  const modelsPath = join(agentDir, 'models.json')
  assert.ok(existsSync(modelsPath))
  const parsed = JSON.parse(readFileSync(modelsPath, 'utf8')) as {
    providers: Record<string, { apiKey: string; models: Array<{ id: string }> }>
  }
  const provider = parsed.providers.siliconflow
  assert.ok(provider, 'siliconflow provider must be seeded')
  assert.equal(provider.apiKey, 'sk-seed')
  assert.ok(provider.models.some((m) => m.id === MODEL_LLM), `models must contain ${MODEL_LLM}`)
  assert.equal(getSetting(db, 'router.model'), `siliconflow/${MODEL_LLM}`)
})

test('existing models.json gains siliconflow without touching other providers or router.model', () => {
  const db = setupDb()
  const agentDir = setupAgentDir()
  const modelsPath = join(agentDir, 'models.json')
  const original = {
    providers: {
      custom: { name: 'Custom', baseUrl: 'https://example.com/v1', apiKey: 'k-custom', models: [{ id: 'custom-x' }] }
    }
  }
  writeFileSync(modelsPath, JSON.stringify(original, null, 2))
  setSetting(db, 'router.model', 'custom/custom-x')

  ensurePiProviderSeed(db, agentDir)

  const parsed = JSON.parse(readFileSync(modelsPath, 'utf8')) as typeof original & {
    providers: { siliconflow?: unknown }
  }
  assert.deepEqual(parsed.providers.custom, original.providers.custom, 'existing provider must be preserved byte-for-byte in value')
  assert.ok(parsed.providers.siliconflow, 'siliconflow must be added')
  assert.equal(getSetting(db, 'router.model'), 'custom/custom-x', 'user-set router.model must not be overwritten')
})

test('rag.apiKey settings override flows into the seeded provider', () => {
  const db = setupDb()
  const agentDir = setupAgentDir()
  setSetting(db, 'rag.apiKey', 'sk-override')
  ensurePiProviderSeed(db, agentDir)
  const parsed = JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf8')) as {
    providers: Record<string, { apiKey: string }>
  }
  assert.equal(parsed.providers.siliconflow.apiKey, 'sk-override')
})

test('seeding is idempotent', () => {
  const db = setupDb()
  const agentDir = setupAgentDir()
  ensurePiProviderSeed(db, agentDir)
  const first = readFileSync(join(agentDir, 'models.json'), 'utf8')
  ensurePiProviderSeed(db, agentDir)
  const second = readFileSync(join(agentDir, 'models.json'), 'utf8')
  assert.equal(first, second)
})

test('missing key seeds an empty key instead of embedding a default', () => {
  const db = setupDb()
  const agentDir = setupAgentDir()
  const previous = process.env.SILICONFLOW_API_KEY
  delete process.env.SILICONFLOW_API_KEY
  try {
    ensurePiProviderSeed(db, agentDir)
    const parsed = JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf8')) as {
      providers: Record<string, { apiKey: string }>
    }
    assert.equal(parsed.providers.siliconflow.apiKey, '')
  } finally {
    if (previous === undefined) delete process.env.SILICONFLOW_API_KEY
    else process.env.SILICONFLOW_API_KEY = previous
  }
})
