import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRouterSlot } from './router-slot.ts'

test('a stale entry cannot clear the router a newer entry created', async () => {
  const slot = createRouterSlot<{ id: string }>()
  let resolveFirst!: (value: { id: string }) => void
  const first = slot.ensure(() => new Promise((resolve) => (resolveFirst = resolve)))
  const capturedA = slot.current()
  const capturedB = slot.current()
  assert.equal(capturedA, first)
  assert.equal(capturedB, first)

  resolveFirst({ id: 'r1' })
  const r1 = await first
  const disposed: string[] = []

  assert.equal(slot.release(capturedA, r1, (r) => disposed.push(r.id)), true)
  assert.equal(slot.current(), null)

  const second = slot.ensure(() => new Promise<{ id: string }>(() => {}))
  assert.equal(slot.current(), second)

  assert.equal(slot.release(capturedB, r1, (r) => disposed.push(r.id)), false)
  assert.equal(slot.current(), second)
  assert.deepEqual(disposed, ['r1'])
})
