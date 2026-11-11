import { MODEL_LLM } from './config.ts'
import type { SiliconFlowClient } from './siliconflow.ts'
import type { RetrievedPassage } from './retrieval.ts'

export interface AnswerSource {
  n: number
  docTitle: string
  heading: string
}

export async function answerQuestion(
  client: SiliconFlowClient,
  query: string,
  passages: RetrievedPassage[]
): Promise<{ answer: string; sources: AnswerSource[] }> {
  if (passages.length === 0) {
    return { answer: '知识库中还没有可用的文档段落。', sources: [] }
  }
  const system = '只依据给定编号段落回答用户问题，引用出处用 [n] 标注，段落不足以回答时明确说明，不要编造。'
  const user =
    passages.map((p, i) => `[${i + 1}] 《${p.docTitle}》· ${p.heading}\n${p.content}`).join('\n\n') +
    `\n\n问题：${query}`
  const content = await client.chatComplete({
    model: MODEL_LLM,
    temperature: 0,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  })
  return {
    answer: content.trim(),
    sources: passages.map((p, i) => ({ n: i + 1, docTitle: p.docTitle, heading: p.heading }))
  }
}
