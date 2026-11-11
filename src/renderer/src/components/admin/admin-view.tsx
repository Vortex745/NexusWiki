import { useState } from 'react'
import Button from 'tdesign-react/es/button'
import Input from 'tdesign-react/es/input'
import List from 'tdesign-react/es/list'
import Popconfirm from 'tdesign-react/es/popconfirm'
import Progress from 'tdesign-react/es/progress'
import { Search, Trash2 } from 'lucide'
import { MorphIcon } from 'morphicons/react'
import { useRagStore } from '@/stores/rag-store'
import { cn } from '@/lib/utils'
import type { RagDocInfo } from '../../../../shared/protocol'

const STAGE_LABELS: Record<string, string> = {
  parsing: '解析中',
  extracting: '识别中',
  chunking: '切分中',
  grouping: '分组中',
  summarizing: '总结中',
  judging: '审查中'
}

const ISSUE_LABELS: Record<string, string> = {
  title_accuracy: '标题不符',
  chunk_integrity: '切分不完整',
  structure_clarity: '结构不清'
}

const DOC_STATUS: Record<RagDocInfo['status'], { label: string; dot: string }> = {
  ok: { label: '正常', dot: 'bg-emerald-500' },
  'needs-review': { label: '需复核', dot: 'bg-amber-500' },
  unverified: { label: '未校验', dot: 'bg-muted-foreground/50' },
  failed: { label: '失败', dot: 'bg-destructive' }
}

// 单条状态行：进行中→阶段（识别中带真实页数进度），失败→原因，完成→不占地方（列表刷新即是结果）
function useImportStatus(): { text: string; progress: { done: number; total: number } | null } | null {
  const lastEvent = useRagStore((s) => s.lastEvent)
  if (!lastEvent) return null
  if (lastEvent.stage === 'failed') return { text: `导入失败：${lastEvent.message ?? '未知错误'}`, progress: null }
  if (lastEvent.stage === 'done') return null
  const label = STAGE_LABELS[lastEvent.stage] ?? lastEvent.stage
  if (lastEvent.stage === 'extracting' && typeof lastEvent.pageCount === 'number' && lastEvent.pageCount > 0) {
    return { text: label, progress: { done: lastEvent.pageDone ?? 0, total: lastEvent.pageCount } }
  }
  return { text: label, progress: null }
}

function DocRow({ doc }: { doc: RagDocInfo }) {
  const removeDoc = useRagStore((s) => s.removeDoc)
  const status = DOC_STATUS[doc.status]
  return (
    <List.ListItem
      action={
        <Popconfirm
          content="删除该文档？"
          confirmBtn="删除"
          cancelBtn="取消"
          theme="danger"
          onConfirm={() => removeDoc(doc.id)}
        >
          <Button
            variant="text"
            size="small"
            icon={<MorphIcon icon={Trash2} size="1em" />}
            aria-label="删除文档"
            data-test="delete-doc"
            className="text-muted-foreground hover:text-destructive"
          />
        </Popconfirm>
      }
    >
      <div className="flex min-w-0 flex-1 items-center gap-3" data-test="doc-row">
        <span className="min-w-0 flex-1 truncate text-sm">{doc.title}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn('h-1.5 w-1.5 rounded-full', status.dot)} />
          {status.label}
        </span>
        {doc.status === 'needs-review' && doc.formatIssues.length > 0 && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {doc.formatIssues.map((issue) => ISSUE_LABELS[issue] ?? issue).join('、')}
          </span>
        )}
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{doc.chunkCount} 段</span>
      </div>
    </List.ListItem>
  )
}

// 检索试问：一次提问走完文档筛查→段落打分→choice 复排→作答，直接展示名次与得分便于验收调参
function SearchSection() {
  const searching = useRagStore((s) => s.searching)
  const searchResult = useRagStore((s) => s.searchResult)
  const searchError = useRagStore((s) => s.searchError)
  const searchTest = useRagStore((s) => s.searchTest)
  const [query, setQuery] = useState('')
  const runSearch = (q: string) => {
    if (q.trim() && !searching) searchTest(q.trim())
  }
  return (
    <div className="mt-4 flex flex-col gap-3">
      <Input
        value={query}
        onChange={(v) => setQuery(v)}
        onEnter={(v) => runSearch(v)}
        placeholder="向知识库提问…"
        aria-label="检索知识库"
        data-test="search-input"
        suffixIcon={
          <Button
            shape="square"
            variant="text"
            icon={<MorphIcon icon={Search} size="1em" />}
            loading={searching}
            aria-label="检索"
            data-test="search-button"
            onClick={() => runSearch(query)}
          />
        }
      />
      {searchError && <p className="text-xs text-destructive">{searchError}</p>}
      {searchResult && (
        <>
          <p className="text-sm leading-relaxed">{searchResult.answer}</p>
          <div data-test="search-results">
            <List split>
              {searchResult.passages.map((p, i) => (
                <List.ListItem key={i}>
                  <div className="flex w-full flex-col gap-1">
                    <div className="flex items-center gap-3">
                      <span className="shrink-0 text-xs text-muted-foreground">[{i + 1}]</span>
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {p.docTitle}·{p.heading}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {(p.score * 100).toFixed(1)}%
                      </span>
                    </div>
                    <p className="line-clamp-2 text-xs text-muted-foreground">{p.content}</p>
                  </div>
                </List.ListItem>
              ))}
            </List>
          </div>
        </>
      )}
    </div>
  )
}

function LoginPanel() {
  const loginError = useRagStore((s) => s.loginError)
  const login = useRagStore((s) => s.login)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  return (
    <div className="flex flex-1 items-center justify-center px-4 pb-24" data-test="login-panel">
      <form
        className="flex w-full max-w-xs flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          login(username.trim(), password)
        }}
      >
        <Input
          value={username}
          onChange={(v) => setUsername(v)}
          placeholder="用户名"
          aria-label="用户名"
          data-test="login-username"
          autocomplete="username"
          autofocus
        />
        <Input
          type="password"
          value={password}
          onChange={(v) => setPassword(v)}
          placeholder="密码"
          aria-label="密码"
          data-test="login-password"
          autocomplete="current-password"
        />
        <Button theme="primary" type="submit" block disabled={!username.trim() || !password} data-test="login-submit">
          登录
        </Button>
        {loginError && <p className="text-center text-xs text-destructive">{loginError}</p>}
      </form>
    </div>
  )
}

export function AdminView() {
  const token = useRagStore((s) => s.token)
  const docs = useRagStore((s) => s.docs)
  const status = useImportStatus()
  const progress = status?.progress

  if (!token) return <LoginPanel />

  const importPdf = () => {
    void window.api.ragImportPick(token)
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-y-auto px-4 py-6" data-test="admin-view">
      <div className="flex items-center justify-between gap-3">
        <Button theme="primary" onClick={importPdf} data-test="import-pdf">
          导入 PDF
        </Button>
        {status && (
          <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
            <span className="min-w-0 line-clamp-2 whitespace-normal text-xs text-muted-foreground">{status.text}</span>
            {progress && (
              <div className="max-w-40 shrink-0" data-test="import-progress">
                <Progress
                  size="small"
                  percentage={Math.round((progress.done / progress.total) * 100)}
                  label={`${progress.done}/${progress.total}`}
                />
              </div>
            )}
          </div>
        )}
      </div>
      <SearchSection />
      {docs.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground" data-test="doc-empty">
          暂无文档
        </p>
      ) : (
        <div className="mt-4" data-test="doc-list">
          <List split>{docs.map((doc) => <DocRow key={doc.id} doc={doc} />)}</List>
        </div>
      )}
    </div>
  )
}
