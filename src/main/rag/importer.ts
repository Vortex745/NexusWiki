import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { RagImportEvent } from '../../shared/protocol.ts'
import {
  CHUNK_MAX_CHARS,
  GROUP_SIZE,
  GROUP_THRESHOLD,
  JUDGE_EXCERPT_CHARS,
  MODEL_DECISION,
  MODEL_LLM,
  MODEL_OCR,
  OCR_MIN_TEXT_CHARS,
  OCR_PROMPT,
  SUMMARY_SOURCE_CHARS
} from './config.ts'
import type { NoulQuestion, SiliconFlowClient, SystemOneAnswer } from './siliconflow.ts'
import { insertDoc, insertGroups, insertPassages, insertImport, updateImport, type RagDocStatus } from './store.ts'
import type { ParseResult } from './pymupdf.ts'

// 导入流水线：parsing → extracting → chunking → [grouping 仅超阈值大文档] → summarizing → judging → done|failed（单阶段机，无双布尔）
// 判定降级：judging 接口失败不拖垮导入（status=unverified）；其余阶段失败 → import failed，不落 doc

const JUDGE_QUESTIONS: Record<string, NoulQuestion> = {
  title_accuracy: { type: 'noul', instructions: '文档标题与内容是否相符，能否准确概括这份文档的主题？' },
  chunk_integrity: { type: 'noul', instructions: '这些段落切分是否都是语义完整的片段，而不是被截断的半句或无关碎片？' },
  structure_clarity: { type: 'noul', instructions: '这份文档是否具有可用于检索导航的清晰结构（标题、章节或明确主题）？' }
}

// DeepSeek-OCR 的 grounding 输出夹带 <|ref|>标签<|/ref|><|det|>坐标<|/det|> 布局元数据行，不属于文档内容
const OCR_LAYOUT_MARKER = /<\|ref\|>[\s\S]*?<\|\/ref\|><\|det\|>[\s\S]*?<\|\/det\|>\n?/g

export function sanitizeOcrText(text: string): string {
  return text.replace(OCR_LAYOUT_MARKER, '').trim()
}

// 纯切分：标题行（#开头）开新段；空行分块的段落累积到超限即开新段；单段超限按 maxChars 硬切（切片间不加任何分隔符）。
// 段落不跨页——每页结束时收尾当前段（两页短文本也要各自成段）。
export function splitPassages(
  pageTexts: string[],
  maxChars: number = CHUNK_MAX_CHARS
): Array<{ heading: string; content: string }> {
  const passages: Array<{ heading: string; content: string }> = []
  let heading = ''
  let blocks: string[] = []

  const flush = (): void => {
    if (blocks.length > 0) {
      passages.push({ heading, content: blocks.join('\n\n') })
      blocks = []
    }
  }

  const addBlock = (block: string): void => {
    if (block.length > maxChars) {
      flush()
      for (let start = 0; start < block.length; start += maxChars) {
        passages.push({ heading, content: block.slice(start, start + maxChars) })
      }
      return
    }
    const projected = blocks.length === 0 ? block.length : blocks.join('\n\n').length + 2 + block.length
    if (projected > maxChars) flush()
    blocks.push(block)
  }

  for (const pageText of pageTexts) {
    for (const rawBlock of pageText.split(/\n\s*\n/)) {
      const block = rawBlock.trim()
      if (!block) continue
      const lines = block.split('\n')
      if (/^#{1,6}\s/.test(lines[0])) {
        flush()
        heading = lines[0].replace(/^#+\s*/, '').trim()
        const rest = lines.slice(1).join('\n').trim()
        if (rest) addBlock(rest)
      } else {
        addBlock(block)
      }
    }
    flush()
    heading = ''
  }
  return passages
}

function readNoul(answer: SystemOneAnswer | undefined): number {
  if (typeof answer !== 'object' || answer === null || !('noul' in answer)) return 0
  const value = (answer as { noul: unknown }).noul
  return typeof value === 'number' ? value : 0
}

export function createImportQueue(deps: {
  db: DatabaseSync
  client: SiliconFlowClient
  parsePdf: (pdfPath: string, outDir: string) => Promise<ParseResult>
  onEvent: (event: RagImportEvent) => void
  workRoot: string
}): { enqueue(filePath: string): string } {
  const { db, client, parsePdf, onEvent, workRoot } = deps
  let chain: Promise<void> = Promise.resolve()

  const beginStage = (jobId: string, stage: string): void => {
    updateImport(db, jobId, { status: 'running', stage })
    onEvent({ jobId, stage })
  }

  const runJob = async (jobId: string, filePath: string): Promise<void> => {
    try {
      beginStage(jobId, 'parsing')
      const parse = await parsePdf(filePath, join(workRoot, jobId))

      beginStage(jobId, 'extracting')
      const pageTexts: string[] = []
      for (let i = 0; i < parse.pages.length; i++) {
        const page = parse.pages[i]
        let text = page.text
        if (text.length < OCR_MIN_TEXT_CHARS) {
          const base64 = readFileSync(page.imagePath).toString('base64')
          text = sanitizeOcrText(
            await client.chatComplete({
              model: MODEL_OCR,
              messages: [
                {
                  role: 'user',
                  content: [
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
                    { type: 'text', text: OCR_PROMPT }
                  ]
                }
              ]
            })
          )
        }
        pageTexts.push(text)
        onEvent({ jobId, stage: 'extracting', pageDone: i + 1, pageCount: parse.pageCount })
      }

      beginStage(jobId, 'chunking')
      const passages = splitPassages(pageTexts)

      // 大文档按位置分组（每组 GROUP_SIZE 段），组摘要给检索的组筛级用——SemIf TPM 顶不住全量段打分
      const groupSummaries: string[] = []
      if (passages.length > GROUP_THRESHOLD) {
        beginStage(jobId, 'grouping')
        const groupCount = Math.ceil(passages.length / GROUP_SIZE)
        for (let g = 0; g < groupCount; g++) {
          const source = passages
            .slice(g * GROUP_SIZE, (g + 1) * GROUP_SIZE)
            .map((p) => p.content)
            .join('\n\n')
            .slice(0, SUMMARY_SOURCE_CHARS)
          groupSummaries.push(
            await client.chatComplete({
              model: MODEL_LLM,
              messages: [
                {
                  role: 'user',
                  content: `请用一句不超过60字的中文概括以下内容片段的主题，直接输出这句话。\n\n${source}`
                }
              ]
            })
          )
        }
      }

      beginStage(jobId, 'summarizing')
      const combined = pageTexts.join('\n\n')
      const title = basename(filePath).replace(/\.pdf$/i, '')
      const summaryRaw = await client.chatComplete({
        model: MODEL_LLM,
        messages: [
          {
            role: 'user',
            content: `请用一句不超过60字的中文概括这份文档的主题，直接输出这句话，不要任何其他内容。\n\n文档内容：\n${combined.slice(0, SUMMARY_SOURCE_CHARS)}`
          }
        ]
      })
      const summary = summaryRaw.trim() || title

      beginStage(jobId, 'judging')
      let status: RagDocStatus
      let formatIssues: string | null
      try {
        const answers = await client.systemOne({
          model: MODEL_DECISION,
          state: { title, summary, excerpt: combined.slice(0, JUDGE_EXCERPT_CHARS) },
          questions: JUDGE_QUESTIONS
        })
        const issues = Object.keys(JUDGE_QUESTIONS).filter((q) => readNoul(answers[q]) < 0.5)
        status = issues.length > 0 ? 'needs-review' : 'ok'
        formatIssues = issues.length > 0 ? JSON.stringify(issues) : null
      } catch {
        status = 'unverified'
        formatIssues = null
      }

      const docId = randomUUID()
      insertDoc(db, {
        id: docId,
        title,
        summary,
        sourcePath: filePath,
        pageCount: parse.pageCount,
        status,
        formatIssues,
        chunkCount: passages.length,
        createdAt: new Date().toISOString()
      })
      insertPassages(db, docId, passages)
      // 组摘要早在 grouping 阶段算好，落账只能等 doc 行存在（docId 此时才生成）
      if (groupSummaries.length > 0) insertGroups(db, docId, groupSummaries)
      updateImport(db, jobId, { status: 'done', stage: 'done', finishedAt: new Date().toISOString() })
      onEvent({ jobId, stage: 'done', docId, status })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      updateImport(db, jobId, { status: 'failed', stage: 'failed', message, finishedAt: new Date().toISOString() })
      onEvent({ jobId, stage: 'failed', message })
    }
  }

  return {
    // 单飞队列：任务链在上一任务完全落账后才开始，绝不交叠；任何异常都在任务内消化，链不死
    enqueue(filePath: string): string {
      const jobId = randomUUID()
      insertImport(db, jobId, filePath)
      chain = chain.then(() => runJob(jobId, filePath)).catch(() => {})
      return jobId
    }
  }
}
