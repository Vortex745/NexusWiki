import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  ensureRagTables,
  insertDoc,
  getDoc,
  listDocs,
  updateDocStatus,
  deleteDoc,
  insertPassages,
  listPassages,
  insertImport,
  updateImport,
  getImport,
  listImports
} from './store.ts'

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  ensureRagTables(db)
  return db
}

test('doc roundtrip and newest-first listing', () => {
  const db = freshDb()
  insertDoc(db, {
    id: 'd1',
    title: '旧文档',
    summary: '摘要一',
    sourcePath: 'C:/a.pdf',
    pageCount: 3,
    status: 'ok',
    formatIssues: null,
    chunkCount: 12,
    createdAt: '2026-01-01T00:00:00Z'
  })
  insertDoc(db, {
    id: 'd2',
    title: '新文档',
    summary: '摘要二',
    sourcePath: 'C:/b.pdf',
    pageCount: 5,
    status: 'needs-review',
    formatIssues: JSON.stringify(['title_accuracy']),
    chunkCount: 30,
    createdAt: '2026-01-02T00:00:00Z'
  })
  assert.equal(getDoc(db, 'd1')?.title, '旧文档')
  assert.deepEqual(listDocs(db).map((d) => d.id), ['d2', 'd1'])
  assert.deepEqual(JSON.parse(listDocs(db)[0].formatIssues ?? '[]'), ['title_accuracy'])
})

test('updateDocStatus writes status and issue list', () => {
  const db = freshDb()
  insertDoc(db, {
    id: 'd1',
    title: 't',
    summary: 's',
    sourcePath: 'C:/a.pdf',
    pageCount: 1,
    status: 'unverified',
    formatIssues: null,
    chunkCount: 1,
    createdAt: '2026-01-01T00:00:00Z'
  })
  updateDocStatus(db, 'd1', 'needs-review', JSON.stringify(['chunk_integrity', 'structure_clarity']))
  const doc = getDoc(db, 'd1')
  assert.equal(doc?.status, 'needs-review')
  assert.deepEqual(JSON.parse(doc?.formatIssues ?? '[]'), ['chunk_integrity', 'structure_clarity'])
})

test('passages get ordered seq and deleteDoc cascades', () => {
  const db = freshDb()
  insertDoc(db, {
    id: 'd1',
    title: 't',
    summary: 's',
    sourcePath: 'C:/a.pdf',
    pageCount: 1,
    status: 'ok',
    formatIssues: null,
    chunkCount: 2,
    createdAt: '2026-01-01T00:00:00Z'
  })
  insertPassages(db, 'd1', [
    { heading: '甲', content: '内容甲' },
    { heading: '乙', content: '内容乙' }
  ])
  const passages = listPassages(db, 'd1')
  assert.deepEqual(passages.map((p) => p.seq), [0, 1])
  assert.equal(passages[0].heading, '甲')
  assert.ok(passages[0].id.length > 0)
  deleteDoc(db, 'd1')
  assert.equal(getDoc(db, 'd1'), undefined)
  assert.deepEqual(listPassages(db, 'd1'), [])
})

test('import rows: queued default, stage/status updates, finishedAt', () => {
  const db = freshDb()
  insertImport(db, 'j1', 'C:/a.pdf')
  assert.equal(getImport(db, 'j1')?.status, 'queued')
  updateImport(db, 'j1', { status: 'running', stage: 'extracting' })
  updateImport(db, 'j1', { status: 'done', stage: 'done', message: null, finishedAt: '2026-01-01T01:00:00Z' })
  const imp = getImport(db, 'j1')
  assert.equal(imp?.stage, 'done')
  assert.equal(imp?.message, null)
  assert.equal(imp?.finishedAt, '2026-01-01T01:00:00Z')
  assert.deepEqual(listImports(db).map((i) => i.id), ['j1'])
})

test('fresh db lists empty', () => {
  const db = freshDb()
  assert.deepEqual(listDocs(db), [])
  assert.deepEqual(listImports(db), [])
})
