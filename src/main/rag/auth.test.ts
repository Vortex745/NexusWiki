import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { ensureAdminSeed, loginAdmin, verifyJwt, signToken } from './auth.ts'

function freshDb(): DatabaseSync {
  return new DatabaseSync(':memory:')
}

test('seed is idempotent and default credentials log in', () => {
  const db = freshDb()
  ensureAdminSeed(db)
  ensureAdminSeed(db)
  const token = loginAdmin(db, 'admin', 'admin123')
  assert.equal(typeof token, 'string')
  assert.equal((token as string).split('.').length, 3)
})

test('wrong password or unknown user returns null', () => {
  const db = freshDb()
  ensureAdminSeed(db)
  assert.equal(loginAdmin(db, 'admin', 'wrong-password'), null)
  assert.equal(loginAdmin(db, 'nobody', 'admin123'), null)
  assert.equal(loginAdmin(db, '', ''), null)
})

test('verifyJwt accepts a fresh token and rejects tampered, expired, malformed, foreign-secret tokens', () => {
  const db = freshDb()
  ensureAdminSeed(db)
  const token = loginAdmin(db, 'admin', 'admin123') as string
  assert.equal(verifyJwt(db, token), true)

  const [header, , signature] = token.split('.')
  const forgedPayload = Buffer.from(JSON.stringify({ sub: 'admin', iat: 1, exp: 99999999999 })).toString('base64url')
  assert.equal(verifyJwt(db, `${header}.${forgedPayload}.${signature}`), false)

  assert.equal(verifyJwt(db, signToken(db, 'admin', -10)), false)
  assert.equal(verifyJwt(db, 'garbage'), false)
  assert.equal(verifyJwt(db, 'a.b'), false)

  const otherDb = freshDb()
  ensureAdminSeed(otherDb)
  assert.equal(verifyJwt(otherDb, token), false)
})

test('re-seeded db keeps working credentials stable across restarts of the module', () => {
  const db = freshDb()
  ensureAdminSeed(db)
  const firstSecret = db.prepare("SELECT value FROM settings WHERE key = 'admin.jwtSecret'").get() as { value: string }
  ensureAdminSeed(db)
  const secondSecret = db.prepare("SELECT value FROM settings WHERE key = 'admin.jwtSecret'").get() as { value: string }
  assert.equal(firstSecret.value, secondSecret.value)
})
