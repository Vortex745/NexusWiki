import type { DatabaseSync } from 'node:sqlite'
import {
  CHOICE_M,
  GROUP_SIZE,
  GROUPS_PER_DOC,
  K_DOCS,
  MAX_QUESTIONS_PER_REQUEST,
  MAX_STATE_CHARS,
  MODEL_DECISION,
  TOP_R
} from './config.ts'
import type { SiliconFlowClient, SystemOneAnswer } from './siliconflow.ts'
import { listDocs, listGroups, listPassages } from './store.ts'

export interface RetrievedPassage {
  id: string
  docId: string
  docTitle: string
  heading: string
  content: string
  score: number
}

export interface RetrieveOptions {
  kDocs?: number
  topR?: number
  choiceM?: number
  maxQuestionsPerRequest?: number
  maxStateChars?: number
}

// noul 答案缺字段/非数字按 0 分算：判定模型的脏输出只能拉低排序，不能炸掉检索
function noulOf(answer: SystemOneAnswer | undefined): number {
  const value = answer !== null && typeof answer === 'object' ? (answer as { noul?: unknown }).noul : undefined
  return typeof value === 'number' ? value : 0
}

// DecisionRAG 检索：先文档筛查定 top-k 文档，带分组的大文档加一道组筛（论文 §3.4），再段落二分打分，最后 choice 复排头部长名单
export async function retrieve(
  db: DatabaseSync,
  client: SiliconFlowClient,
  query: string,
  opts?: RetrieveOptions
): Promise<RetrievedPassage[]> {
  const docs = listDocs(db)
  if (docs.length === 0) return []

  const kDocs = opts?.kDocs ?? K_DOCS
  const topR = opts?.topR ?? TOP_R
  const choiceM = opts?.choiceM ?? CHOICE_M
  const maxQuestionsPerRequest = opts?.maxQuestionsPerRequest ?? MAX_QUESTIONS_PER_REQUEST
  const maxStateChars = opts?.maxStateChars ?? MAX_STATE_CHARS

  // 第一级：一次判定请求并行问全部文档，答案键 d_<docId> 对回原文档
  const docAnswers = await client.systemOne({
    model: MODEL_DECISION,
    state: { query, documents: docs.map((d) => ({ id: d.id, title: d.title, summary: d.summary })) },
    questions: Object.fromEntries(
      docs.map((d) => [`d_${d.id}`, { type: 'noul' as const, instructions: '回答用户问题所需的信息是否可能在这份文档中？' }])
    )
  })
  const keptDocs = docs
    .map((doc) => ({ doc, score: noulOf(docAnswers[`d_${doc.id}`]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, kDocs)

  // 第二级：候选文档的段落按 doc 顺序摊平成池（seq 留着给组筛过滤），池为空就不用再打分
  const pool: Array<{ passage: RetrievedPassage; seq: number }> = []
  for (const { doc } of keptDocs) {
    for (const passage of listPassages(db, doc.id)) {
      pool.push({
        passage: { id: passage.id, docId: passage.docId, docTitle: doc.title, heading: passage.heading, content: passage.content, score: 0 },
        seq: passage.seq
      })
    }
  }
  if (pool.length === 0) return []

  // 组筛级（大文档导入时建的位置分组）：一次请求并行问所有组的摘要，每组只留 top GROUPS_PER_DOC；
  // 挂了静默退化成全量段打分——组筛是省 TPM 的加速级，不能反过来挡检索
  const keptRanges = new Map<string, Array<[number, number]>>()
  const groupEntries = keptDocs.flatMap(({ doc }) =>
    listGroups(db, doc.id).map((g) => ({ docId: doc.id, docTitle: doc.title, seq: g.seq, summary: g.summary }))
  )
  if (groupEntries.length > 0) {
    try {
      const groupAnswers = await client.systemOne({
        model: MODEL_DECISION,
        state: { query, groups: groupEntries.map((e) => ({ docTitle: e.docTitle, summary: e.summary })) },
        questions: Object.fromEntries(
          groupEntries.map((e) => [
            `g_${e.docId}:${e.seq}`,
            { type: 'noul' as const, instructions: '回答用户问题所需的信息是否可能在这个内容分组中？' }
          ])
        )
      })
      for (const docId of new Set(groupEntries.map((e) => e.docId))) {
        keptRanges.set(
          docId,
          groupEntries
            .filter((e) => e.docId === docId)
            .map((e) => ({ seq: e.seq, score: noulOf(groupAnswers[`g_${e.docId}:${e.seq}`]) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, GROUPS_PER_DOC)
            .map((t) => [t.seq * GROUP_SIZE, (t.seq + 1) * GROUP_SIZE] as [number, number])
        )
      }
    } catch {
      // ranges 留空 = 该文档全部段落照旧入池打分
    }
  }

  // 段落编号全局 1 起（不随批次重置），答案键 p<n> 才能对回原段；编号在组筛过滤之前定死——组筛只筛段不改号；
  // 批次受问题数与状态字符双上限约束
  const numbered = pool.map(({ passage, seq }, index) => ({ passage, seq, n: index + 1 }))
  const toScore = numbered.filter(({ passage, seq }) => {
    const ranges = keptRanges.get(passage.docId)
    return ranges === undefined || ranges.some(([lo, hi]) => seq >= lo && seq < hi)
  })
  const batches: Array<Array<{ passage: RetrievedPassage; n: number }>> = []
  let current: Array<{ passage: RetrievedPassage; n: number }> = []
  let currentChars = 0
  for (const item of toScore) {
    const chars = item.passage.content.length
    if (current.length > 0 && (current.length >= maxQuestionsPerRequest || currentChars + chars > maxStateChars)) {
      batches.push(current)
      current = []
      currentChars = 0
    }
    current.push(item)
    currentChars += chars
  }
  if (current.length > 0) batches.push(current)

  // Alpha 阶段的 SemIf 扛不住高并发（实测 7 路并行必挂 1 路），限制同时 2 路批次
  const scoredGroups: Array<Array<RetrievedPassage>> = []
  let cursor = 0
  const judgeBatch = async (batch: Array<{ passage: RetrievedPassage; n: number }>): Promise<void> => {
    const questions: Record<string, { type: 'noul'; instructions: string }> = {}
    for (const { n } of batch) questions[`p${n}`] = { type: 'noul', instructions: '这一段是否包含回答用户问题所需的信息？' }
    const answers = await client.systemOne({
      model: MODEL_DECISION,
      state: {
        query,
        passages: batch.map(({ passage, n }) => ({ n, docTitle: passage.docTitle, heading: passage.heading, content: passage.content }))
      },
      questions
    })
    scoredGroups.push(batch.map(({ passage, n }) => ({ ...passage, score: noulOf(answers[`p${n}`]) })))
  }
  await Promise.all(
    Array.from({ length: Math.min(2, batches.length) }, async () => {
      while (cursor < batches.length) {
        const batch = batches[cursor]
        cursor += 1
        await judgeBatch(batch)
      }
    })
  )
  const shortlist = scoredGroups.flat().sort((a, b) => b.score - a.score).slice(0, topR)

  // 第三级：头部长名单够长时用 choice 从中挑第一名前移；判定挂了或答非所挑就静默保持二分序
  if (choiceM >= 2 && shortlist.length >= 2) {
    const candidates = shortlist.slice(0, choiceM)
    try {
      const answers = await client.systemOne({
        model: MODEL_DECISION,
        state: { query, passages: candidates.map(({ id, docTitle, heading, content }) => ({ id, docTitle, heading, content })) },
        questions: {
          pick: {
            type: 'choice',
            instructions: '哪一段最有助于回答用户的问题？',
            criteria: Object.fromEntries(candidates.map((p) => [p.id, `${p.docTitle}｜${p.heading}`]))
          }
        }
      })
      const pick = answers.pick as { choice?: unknown }
      const winner = candidates.find((p) => p.id === pick?.choice)
      if (winner !== undefined) {
        return [winner, ...candidates.filter((p) => p.id !== winner.id), ...shortlist.slice(candidates.length)]
      }
    } catch {
      // choice 阶段是锦上添花，失败不阻断检索
    }
  }
  return shortlist
}

// 聊天 search_knowledge 工具的检索出口：编号片段文本（文档标题·段落标题 + 正文），空库给固定提示
export async function searchKnowledgeDigest(db: DatabaseSync, client: SiliconFlowClient, query: string): Promise<string> {
  const passages = await retrieve(db, client, query)
  if (passages.length === 0) return '知识库中还没有相关内容。'
  return passages
    .map((p, i) => `[${i + 1}] 《${p.docTitle}》· ${p.heading}\n${p.content}`)
    .join('\n\n')
}
