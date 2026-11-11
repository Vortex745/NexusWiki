import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import type { ThinkingTier } from '../shared/protocol.ts'
import { DEFAULT_THINKING_TIER, parseThinkingTier, tierForLegacyLevel } from '../shared/protocol.ts'
import { ensureRagTables } from './rag/store.ts'
import { ensureTasksTable } from './tasks/store.ts'

let db: DatabaseSync | null = null

export function openDb(): DatabaseSync {
  if (db) return db

  db = new DatabaseSync(join(app.getPath('userData'), 'app.db'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  ensureTasksTable(db)
  ensureRagTables(db)
  return db
}

export const ROUTER_MODEL_KEY = 'router.model'
export const WORKER_MODEL_KEY = 'worker.model'
// 全局思考强度档位：新键 thinking.tier 存产品三档 low/high/max
export const THINKING_TIER_KEY = 'thinking.tier'
// 旧键 thinking.level 存的是 SDK 档位（off/minimal/low/medium/high/xhigh/max），只读不写，用于迁移
export const THINKING_LEVEL_KEY = 'thinking.level'
// 当前聊天会话 id（"chat.currentSessionId"）：每次 Router 创建成功后落账，下次启动按它精确恢复
export const CHAT_CURRENT_SESSION_KEY = 'chat.currentSessionId'
// 长期记忆浮动卡片（"memory.pinned" 钉住态 '1'|'0'，"memory.pinnedPos" 位置 JSON {x,y}）
export const MEMORY_PINNED_KEY = 'memory.pinned'
export const MEMORY_PINNED_POS_KEY = 'memory.pinnedPos'

export function getSetting(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

export function setSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

// 新键优先；没有新键时读旧键并按 SDK 档位强度迁移（旧 high / xhigh / max 都落到新 max），缺省 high
export function getThinkingTierSetting(db: DatabaseSync): ThinkingTier {
  const current = getSetting(db, THINKING_TIER_KEY)
  if (current !== undefined) return parseThinkingTier(current)
  return tierForLegacyLevel(getSetting(db, THINKING_LEVEL_KEY)) ?? DEFAULT_THINKING_TIER
}
