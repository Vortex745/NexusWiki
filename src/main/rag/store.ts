import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

// rag_documents / rag_passages / rag_groups / rag_imports 四表唯一落账点（无 electron 依赖，测试可用 :memory:）
// 票据词汇：document=整份导入的 PDF，passage=切分后的语义段，group=大文档的位置分组（组筛用），judgment=导入质量判定结果
export type RagDocStatus = 'ok' | 'needs-review' | 'unverified' | 'failed'
export type RagImportStatus = 'queued' | 'running' | 'done' | 'failed'

export interface RagDoc {
  id: string
  title: string
  summary: string
  sourcePath: string
  pageCount: number
  status: RagDocStatus
  formatIssues: string | null
  chunkCount: number
  createdAt: string
}

export interface RagPassage {
  id: string
  docId: string
  seq: number
  heading: string
  content: string
}

export interface RagGroup {
  id: string
  docId: string
  seq: number
  summary: string
}

export interface RagImportRow {
  id: string
  filePath: string
  status: RagImportStatus
  stage: string
  message: string | null
  createdAt: string
  finishedAt: string | null
}

export function ensureRagTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS rag_documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    source_path TEXT NOT NULL,
    page_count INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL,
    status TEXT NOT NULL,
    format_issues TEXT,
    created_at TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS rag_passages (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    heading TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS rag_groups (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    summary TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS rag_imports (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    stage TEXT NOT NULL DEFAULT 'queued',
    message TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  )`)
}

export function insertDoc(db: DatabaseSync, doc: RagDoc): void {
  db.prepare(
    'INSERT INTO rag_documents (id, title, summary, source_path, page_count, chunk_count, status, format_issues, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(doc.id, doc.title, doc.summary, doc.sourcePath, doc.pageCount, doc.chunkCount, doc.status, doc.formatIssues, doc.createdAt)
}

export function getDoc(db: DatabaseSync, id: string): RagDoc | undefined {
  const row = db
    .prepare(
      'SELECT id, title, summary, source_path AS sourcePath, page_count AS pageCount, chunk_count AS chunkCount, status, format_issues AS formatIssues, created_at AS createdAt FROM rag_documents WHERE id = ?'
    )
    .get(id) as
    | {
        id: string
        title: string
        summary: string
        sourcePath: string
        pageCount: number
        chunkCount: number
        status: string
        formatIssues: string | null
        createdAt: string
      }
    | undefined
  if (!row) return undefined
  return { ...row, status: row.status as RagDocStatus }
}

export function listDocs(db: DatabaseSync): RagDoc[] {
  const rows = db
    .prepare(
      'SELECT id, title, summary, source_path AS sourcePath, page_count AS pageCount, chunk_count AS chunkCount, status, format_issues AS formatIssues, created_at AS createdAt FROM rag_documents ORDER BY created_at DESC, rowid DESC'
    )
    .all() as Array<{
    id: string
    title: string
    summary: string
    sourcePath: string
    pageCount: number
    chunkCount: number
    status: string
    formatIssues: string | null
    createdAt: string
  }>
  return rows.map((row) => ({ ...row, status: row.status as RagDocStatus }))
}

export function updateDocStatus(db: DatabaseSync, id: string, status: RagDocStatus, formatIssues: string | null): void {
  db.prepare('UPDATE rag_documents SET status = ?, format_issues = ? WHERE id = ?').run(status, formatIssues, id)
}

export function deleteDoc(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM rag_groups WHERE doc_id = ?').run(id)
  db.prepare('DELETE FROM rag_passages WHERE doc_id = ?').run(id)
  db.prepare('DELETE FROM rag_documents WHERE id = ?').run(id)
}

export function insertPassages(db: DatabaseSync, docId: string, passages: Array<{ heading: string; content: string }>): void {
  const statement = db.prepare('INSERT INTO rag_passages (id, doc_id, seq, heading, content) VALUES (?, ?, ?, ?, ?)')
  for (let seq = 0; seq < passages.length; seq++) {
    const passage = passages[seq]
    statement.run(randomUUID(), docId, seq, passage.heading, passage.content)
  }
}

export function listPassages(db: DatabaseSync, docId: string): RagPassage[] {
  const rows = db
    .prepare(
      'SELECT id, doc_id AS docId, seq, heading, content FROM rag_passages WHERE doc_id = ? ORDER BY seq ASC'
    )
    .all(docId) as Array<{ id: string; docId: string; seq: number; heading: string; content: string }>
  return rows.map((row) => ({ ...row, seq: Number(row.seq) }))
}

export function insertGroups(db: DatabaseSync, docId: string, summaries: string[]): void {
  const statement = db.prepare('INSERT INTO rag_groups (id, doc_id, seq, summary) VALUES (?, ?, ?, ?)')
  for (let seq = 0; seq < summaries.length; seq++) {
    statement.run(randomUUID(), docId, seq, summaries[seq])
  }
}

export function listGroups(db: DatabaseSync, docId: string): RagGroup[] {
  const rows = db
    .prepare('SELECT id, doc_id AS docId, seq, summary FROM rag_groups WHERE doc_id = ? ORDER BY seq ASC')
    .all(docId) as Array<{ id: string; docId: string; seq: number; summary: string }>
  return rows.map((row) => ({ ...row, seq: Number(row.seq) }))
}

export function insertImport(db: DatabaseSync, id: string, filePath: string): void {
  db.prepare('INSERT INTO rag_imports (id, file_path, status, stage, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    filePath,
    'queued',
    'queued',
    new Date().toISOString()
  )
}

export function updateImport(
  db: DatabaseSync,
  id: string,
  patch: { status?: RagImportStatus; stage?: string; message?: string | null; finishedAt?: string }
): void {
  const sets: string[] = []
  const values: (string | null)[] = []
  if (patch.status !== undefined) {
    sets.push('status = ?')
    values.push(patch.status)
  }
  if (patch.stage !== undefined) {
    sets.push('stage = ?')
    values.push(patch.stage)
  }
  if (patch.message !== undefined) {
    sets.push('message = ?')
    values.push(patch.message)
  }
  if (patch.finishedAt !== undefined) {
    sets.push('finished_at = ?')
    values.push(patch.finishedAt)
  }
  if (sets.length === 0) return
  values.push(id)
  db.prepare(`UPDATE rag_imports SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

export function getImport(db: DatabaseSync, id: string): RagImportRow | undefined {
  const row = db
    .prepare(
      'SELECT id, file_path AS filePath, status, stage, message, created_at AS createdAt, finished_at AS finishedAt FROM rag_imports WHERE id = ?'
    )
    .get(id) as
    | {
        id: string
        filePath: string
        status: string
        stage: string
        message: string | null
        createdAt: string
        finishedAt: string | null
      }
    | undefined
  if (!row) return undefined
  return { ...row, status: row.status as RagImportStatus }
}

export function listImports(db: DatabaseSync): RagImportRow[] {
  const rows = db
    .prepare(
      'SELECT id, file_path AS filePath, status, stage, message, created_at AS createdAt, finished_at AS finishedAt FROM rag_imports ORDER BY created_at DESC, rowid DESC'
    )
    .all() as Array<{
    id: string
    filePath: string
    status: string
    stage: string
    message: string | null
    createdAt: string
    finishedAt: string | null
  }>
  return rows.map((row) => ({ ...row, status: row.status as RagImportStatus }))
}
