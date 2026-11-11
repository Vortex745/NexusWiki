import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answerQuestion } from './answer.ts'
import { MODEL_LLM } from './config.ts'
import type { RetrievedPassage } from './retrieval.ts'
import type { SiliconFlowClient } from './siliconflow.ts'

function fakeChat(): { client: SiliconFlowClient; calls: Array<{ model: string; messages: unknown[] }> } {
  const calls: Array<{ model: string; messages: unknown[] }> = []
  const client: SiliconFlowClient = {
    async chatComplete(req) {
      calls.push({ model: req.model, messages: req.messages })
      return '根据[1]，检索延迟由层级深度决定。'
    },
    async systemOne() {
      throw new Error('systemOne not expected in answer tests')
    }
  }
  return { client, calls }
}

function passage(n: number): RetrievedPassage {
  return {
    id: `p${n}`,
    docId: 'd1',
    docTitle: 'DecisionRAG 论文',
    heading: `章节${n}`,
    content: `第${n}段的内容文本。`,
    score: 0.9
  }
}

test('empty knowledge base answers with a fixed line and no API call', async () => {
  const { client, calls } = fakeChat()
  const out = await answerQuestion(client, '什么是决策模型？', [])
  assert.equal(out.answer, '知识库中还没有可用的文档段落。')
  assert.deepEqual(out.sources, [])
  assert.equal(calls.length, 0)
})

test('answer call numbers the passages, cites sources, and names the LLM model', async () => {
  const { client, calls } = fakeChat()
  const out = await answerQuestion(client, '检索延迟由什么决定？', [passage(1), passage(2)])

  assert.equal(calls.length, 1)
  assert.equal(calls[0].model, MODEL_LLM)
  const userText = JSON.stringify(calls[0].messages)
  assert.match(userText, /\[1\]/)
  assert.match(userText, /第1段的内容文本/)
  assert.match(userText, /检索延迟由什么决定/)
  assert.equal(out.answer, '根据[1]，检索延迟由层级深度决定。')
  assert.deepEqual(out.sources, [
    { n: 1, docTitle: 'DecisionRAG 论文', heading: '章节1' },
    { n: 2, docTitle: 'DecisionRAG 论文', heading: '章节2' }
  ])
})
