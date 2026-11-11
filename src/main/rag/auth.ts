import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

// 管理员登录 + 手写 HS256 JWT（零依赖，node:crypto 实现）：settings 表存用户名/scrypt 口令哈希/JWT 密钥
// 哈希格式 `salt:hash`（各为 hex）；token 只有主进程内存里校验，渲染层仅持有不解析

const LOGIN_TTL_SECONDS = 43200 // 12h
const SCRYPT_KEYLEN = 64

function getSettingValue(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

function setSettingValue(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value)
}

// 幂等播种：仅缺哪个补哪个（重跑不轮换已有密钥/口令）
export function ensureAdminSeed(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  if (getSettingValue(db, 'admin.username') === undefined) setSettingValue(db, 'admin.username', 'admin')
  if (getSettingValue(db, 'admin.passwordHash') === undefined) {
    const salt = randomBytes(16).toString('hex')
    const hash = scryptSync('admin123', salt, SCRYPT_KEYLEN).toString('hex')
    setSettingValue(db, 'admin.passwordHash', `${salt}:${hash}`)
  }
  if (getSettingValue(db, 'admin.jwtSecret') === undefined) {
    setSettingValue(db, 'admin.jwtSecret', randomBytes(32).toString('hex'))
  }
}

export function signToken(db: DatabaseSync, subject: string, ttlSeconds: number): string {
  const secret = getSettingValue(db, 'admin.jwtSecret') ?? ''
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub: subject, iat: now, exp: now + ttlSeconds })).toString('base64url')
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

// 宽容解析：任何畸形输入返回 false 而不是抛错
export function verifyJwt(db: DatabaseSync, token: string): boolean {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return false
    const [header, payload, signature] = parts
    const secret = getSettingValue(db, 'admin.jwtSecret')
    if (secret === undefined) return false
    const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest()
    const given = Buffer.from(signature, 'base64url')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof claims.exp === 'number' && claims.exp > Math.floor(Date.now() / 1000)
  } catch {
    return false
  }
}

export function loginAdmin(db: DatabaseSync, username: string, password: string): string | null {
  const storedUsername = getSettingValue(db, 'admin.username')
  const storedHash = getSettingValue(db, 'admin.passwordHash')
  if (storedUsername === undefined || storedHash === undefined || username !== storedUsername) return null
  const [salt, hash] = storedHash.split(':')
  if (salt === undefined || hash === undefined) return null
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN)
  const expected = Buffer.from(hash, 'hex')
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return null
  return signToken(db, username, LOGIN_TTL_SECONDS)
}
