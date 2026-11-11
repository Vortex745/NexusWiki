import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { ensureRagTables, insertDoc, insertGroups, insertPassages } from './store.ts'
import { retrieve, searchKnowledgeDigest, type RetrievedPassage } from './retrieval.ts'
import type { SiliconFlowClient, SystemOneQuestion, SystemOneAnswer } from './siliconflow.ts'

interface FakeJudgeScript {
  docScores?: Record<string, number>
  groupScores?: Record<string, number>
  passageScore?: (globalIndex: number) => number
  choicePickHeading?: string
  throwAt?: 'doc' | 'group' | 'choice'
}

function fakeClient(script: FakeJudgeScript = {}): {
  client: SiliconFlowClient
  judgeCalls: Array<{ stage: 'doc' | 'group' | 'passage' | 'choice'; state: unknown; questions: Record<string, SystemOneQuestion> }>
} {
  const judgeCalls: Array<{ stage: 'doc' | 'group' | 'passage' | 'choice'; state: unknown; questions: Record<string, SystemOneQuestion> }> = []
  const client: SiliconFlowClient = {
    async chatComplete() {
      throw new Error('chatComplete not expected in retrieval tests')
    },
    async systemOne(req) {
      const keys = Object.keys(req.questions)
      let stage: 'doc' | 'group' | 'passage' | 'choice'
      if (keys.some((k) => k.startsWith('d_'))) stage = 'doc'
      else if (keys.some((k) => k.startsWith('g_'))) stage = 'group'
      else if (keys[0] !== undefined && req.questions[keys[0]]?.type === 'choice') stage = 'choice'
      else stage = 'passage'
      judgeCalls.push({ stage, state: req.state, questions: req.questions })
      if (script.throwAt === stage) throw new Error('judge down')
      const answers: Record<string, SystemOneAnswer> = {}
      if (stage === 'doc') {
        for (const key of keys) answers[key] = { type: 'noul', noul: script.docScores?.[key.slice(2)] ?? 0 }
      } else if (stage === 'group') {
        for (const key of keys) answers[key] = { type: 'noul', noul: script.groupScores?.[key.slice(2)] ?? 0 }
      } else if (stage === 'passage') {
        const state = req.state as { passages: Array<{ n: number }> }
        for (const passage of state.passages) {
          answers[`p${passage.n}`] = { type: 'noul', noul: script.passageScore?.(passage.n) ?? 0 }
        }
      } else {
        const criteria = (req.questions[keys[0]] as { criteria?: Record<string, string> }).criteria ?? {}
        const pickKey =
          script.choicePickHeading !== undefined
            ? (Object.entries(criteria).find(([, label]) => label.includes(script.choicePickHeading as string))?.[0] ?? '')
            : keys[0]
        for (const key of keys) answers[key] = { type: 'choice', choice: pickKey }
      }
      return answers
    }
  }
  return { client, judgeCalls }
}

function seedDoc(db: DatabaseSync, id: string, title: string, createdAt: string, headings: string[]): void {
  insertDoc(db, {
    id,
    title,
    summary: `${title}摘要`,
    sourcePath: `C:/${id}.pdf`,
    pageCount: 1,
    status: 'ok',
    formatIssues: null,
    chunkCount: headings.length,
    createdAt
  })
  insertPassages(
    db,
    id,
    headings.map((heading, i) => ({ heading, content: `${id}-段${i}-` + '内容'.repeat(10) }))
  )
}

const NO_CHOICE = { kDocs: 10, topR: 8, choiceM: 0, maxQuestionsPerRequest: 50, maxStateChars: 40000 }

test('empty corpus returns no passages and calls no API', async () => {
  const db = new DatabaseSync(':memory:')
  ensureRagTables(db)
  const { client, judgeCalls } = fakeClient()
  const result = await retrieve(db, client, '随便问')
  assert.deepEqual(result, [])
  assert.equal(judgeCalls.length, 0)
})

test('doc screening keeps top-k documents before passage scoring', async () => {
  const db = new DatabaseSync(':memory:')
  ensureRagTables(db)
  seedDoc(db, 'd1', '甲文档', '2026-01-01T00:00:00Z', ['甲段'])
  seedDoc(db, 'd2', '乙文档', '2026-01-01T00:00:01Z', ['乙段'])
  seedDoc(db, 'd3', '丙文档', '2026-01-01T00:00:02Z', ['丙段'])
  const { client, judgeCalls } = fakeClient({ docScores: { d1: 0.9, d2: 0.1, d3: 0.8 } })
  const result = await retrieve(db, client, '问题', { ...NO_CHOICE, kDocs: 2 })

  assert.equal(judgeCalls[0].stage, 'doc')
  assert.deepEqual(Object.keys(judgeCalls[0].questions).sort(), ['d_d1', 'd_d2', 'd_d3'])
  assert.equal(judgeCalls.filter((c) => c.stage === 'passage').length, 1)
  const passageState = judgeCalls[1].state as { passages: Array<{ docTitle: string }> }
  assert.deepEqual([...new Set(passageState.passages.map((p) => p.docTitle))].sort(), ['丙文档', '甲文档'])
  assert.ok(result.every((p) => p.docId !== 'd2'))
})

test('passage scoring splits into batches and merges scores globally', async () => {
  const db = new DatabaseSync(':memory:')
  ensureRagTables(db)
  seedDoc(db, 'd1', '甲', '2026-01-01T00:00:00Z', ['h0', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7'])
  const { client, judgeCalls } = fakeClient({
    docScores: { d1: 0.9 },
    passageScore: (n) => (n === 3 || n === 6 ? 0.99 : n === 1 ? 0.9 : 0.1)
  })
  // 全局打分：第 3、6 段（全局编号，1 起）最高，落在不同批次
  const result: RetrievedPassage[] = await retrieve(db, client, '问题', {
    ...NO_CHOICE,
    topR: 3,
    maxQuestionsPerRequest: 3
  })

  const passageCalls = judgeCalls.filter((c) => c.stage === 'passage')
  assert.equal(passageCalls.length, 3, '8 passages at 3 per request -> 3 batches')
  for (const call of passageCalls) {
    assert.ok(Object.keys(call.questions).length <= 3)
  }
  const topContents = result.map((p) => p.content.slice(0, 6))
  assert.deepEqual(topContents, ['d1-段2-', 'd1-段5-', 'd1-段0-'])
  assert.deepEqual(result.map((p) => p.heading), ['h2', 'h5', 'h0'])
})

test('choice stage moves its pick to rank one, others keep binary order', async () => {
  const db = new DatabaseSync(':memory:')
  ensureRagTables(db)
  seedDoc(db, 'd1', '甲', '2026-01-01T00:00:00Z', ['h0', 'h1', 'h2'])
  const { client, judgeCalls } = fakeClient({
    docScores: { d1: 0.9 },
    passageScore: (n) => (n === 1 ? 0.9 : n === 2 ? 0.3 : 0.8),
    choicePickHeading: 'h1'
  })
  const result: RetrievedPassage[] = await retrieve(db, client, '问题', {
    ...NO_CHOICE,
    topR: 3,
    choiceM: 3
  })

  assert.equal(judgeCalls[2].stage, 'choice')
  const choiceCall = judgeCalls[2]
  assert.deepEqual(Object.keys(choiceCall.questions), ['pick'])
  assert.deepEqual(result.map((p) => p.heading), ['h1', 'h0', 'h2'])
  assert.deepEqual(result.map((p) => p.score), [0.3, 0.9, 0.8], 'scores stay binary; only order changes')
})

test('choice failure degrades to binary order', async () => {
  const db = new DatabaseSync(':memory:')
  ensureRagTables(db)
  seedDoc(db, 'd1', '甲', '2026-01-01T00:00:00Z', ['h0', 'h1', 'h2'])
  const { client } = fakeClient({
    docScores: { d1: 0.9 },
    passageScore: (n) => (n === 1 ? 0.9 : n === 2 ? 0.3 : 0.8),
    throwAt: 'choice'
  })
  const result: RetrievedPassage[] = await retrieve(db, client, '问题', { ...NO_CHOICE, topR: 3, choiceM: 3 })
  assert.deepEqual(result.map((p) => p.heading), ['h0', 'h2', 'h1'])
})

test('doc-stage judge failure propagates to the caller', async () => {
  const db = new DatabaseSync(':memory:')
  ensureRagTables(db)
  seedDoc(db, 'd1', '甲', '2026-01-01T00:00:00Z', ['h0'])
  const { client } = fakeClient({ throwAt: 'doc' })
  await assert.rejects(retrieve(db, client, '问题'), /judge down/)
})

test('docs with groups get a group screen and only kept groups are scored', async () => {
  const db = new DatabaseSync(':memory:')
  ensureRagTables(db)
  seedDoc(db, 'd1', '甲', '2026-01-01T00:00:00Z', Array.from({ length: 96 }, (_, i) => `h${i}`))
  insertGroups(db, 'd1', ['甲组摘要', '乙组摘要'])
  const { client, judgeCalls } = fakeClient({ docScores: { d1: 0.9 }, groupScores: { 'd1:0': 0.1, 'd1:1': 0.9 } })
  const result: RetrievedPassage[] = await retrieve(db, client, '问题', { ...NO_CHOICE, topR: 8 })

  const groupCall = judgeCalls.find((c) => c.stage === 'group')
  assert.ok(groupCall, 'group screen must run for docs with groups')
  assert.deepEqual(Object.keys(groupCall.questions).sort(), ['g_d1:0', 'g_d1:1'])
  const groupState = groupCall.state as { groups: Array<{ docTitle: string; summary: string }> }
  assert.deepEqual(groupState.groups.map((g) => g.summary), ['甲组摘要', '乙组摘要'])

  const passageStates = judgeCalls
    .filter((c) => c.stage === 'passage')
    .map((c) => c.state as { passages: Array<{ n: number }> })
  const allN = passageStates.flatMap((s) => s.passages.map((p) => p.n))
  assert.ok(allN.length > 0)
  assert.ok(allN.every((n) => n >= 49), `only group-1 passages (seq>=48, n>=49) may be scored, got min ${Math.min(...allN)}`)
  assert.ok(result.every((p) => Number(p.heading.slice(1)) >= 48))
})

test('group-screen failure falls back to scoring all passages', async () => {
  const db = new DatabaseSync(':memory:')
  ensureRagTables(db)
  seedDoc(db, 'd1', '甲', '2026-01-01T00:00:00Z', Array.from({ length: 96 }, (_, i) => `h${i}`))
  insertGroups(db, 'd1', ['甲组摘要', '乙组摘要'])
  const { client, judgeCalls } = fakeClient({ docScores: { d1: 0.9 }, throwAt: 'group' })
  const result: RetrievedPassage[] = await retrieve(db, client, '问题', { ...NO_CHOICE, topR: 8 })

  assert.equal(judgeCalls.filter((c) => c.stage === 'group').length, 1)
  const passageStates = judgeCalls
    .filter((c) => c.stage === 'passage')
    .map((c) => c.state as { passages: Array<{ n: number }> })
  const allN = passageStates.flatMap((s) => s.passages.map((p) => p.n))
  assert.ok(Math.min(...allN) === 1, 'fallback must score the whole pool')
  assert.equal(result.length, 8)
})

test('searchKnowledgeDigest formats retrieved passages for the chat tool', async () => {
  const db = new DatabaseSync(':memory:')
  ensureRagTables(db)
  seedDoc(db, 'd1', '甲', '2026-01-01T00:00:00Z', ['h0'])
  const { client } = fakeClient({
    docScores: { d1: 0.9 },
    passageScore: () => 0.9
  })
  const digest = await searchKnowledgeDigest(db, client, '问题')
  assert.match(digest, /\[1\] 《甲》· h0/)
  assert.match(digest, /d1-段0-/)

  const emptyDb = new DatabaseSync(':memory:')
  ensureRagTables(emptyDb)
  const empty = await searchKnowledgeDigest(emptyDb, fakeClient().client, '问题')
  assert.equal(empty, '知识库中还没有相关内容。')
})
