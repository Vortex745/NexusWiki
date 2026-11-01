import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../ui/collapsible"
import { Button as DisclosureButton } from "../ui/Button"
import { Tabs, TabsList, TabsTrigger } from "../arc/tabs/tabs"
import { Switch } from "../arc/switch/switch"
import { Field as FormField, FieldLabel } from "@/components/ui/field"
import { Button as UiButton } from "@/components/ui/Button"
import { Alert } from "@/components/arc/alert/alert"
import { Textarea } from "@/components/arc/textarea/textarea"
import { Input } from "@/components/arc/input/input"
import { SearchField } from "../arc/search-field/search-field"
import { ConfirmDialog, PanelDialog } from "../ui/Dialog"
import { useCallback, useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  Archive,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  X,
} from "../ui/icons"
import { Icon } from "../ui/Icon"
import { Button, Select, TextInput } from "../ui/Controls"
import { useAppShell } from "../../runtime/AppShellContext"
import {
  wikiApi,
  type WikiFolderPayload,
  type WikiIssuePayload,
  type WikiJobPayload,
  type WikiPagePayload,
  type WikiProposalPayload,
  type WikiRevisionPayload,
} from "../../lib/api"

type View = "pages" | "directory" | "graph" | "jobs" | "issues" | "agent"

const TABS: Array<{ id: View; label: string }> = [
  { id: "pages", label: "页面" },
  { id: "directory", label: "目录" },
  { id: "graph", label: "链接" },
  { id: "jobs", label: "任务" },
  { id: "issues", label: "检查" },
  { id: "agent", label: "助手" },
]

const iconButton =
  "grid size-8 flex-none place-items-center rounded-md text-faint hover:bg-surface-subtle hover:text-ink disabled:opacity-40"
const command =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-xs text-ink hover:bg-surface-subtle disabled:opacity-40"
const field =
  "h-9 w-full rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-brand"

function wikiMarkdown(content: string): string {
  return content
    .replace(/\[chunk:[^\]]+\]/g, "")
    .replace(
      /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (_match, slug: string, label?: string) =>
        `[${(label ?? slug).replace(/[\[\]]/g, "\\$&")}](#wiki/${encodeURIComponent(slug.trim())})`,
    )
}

export function WikiDialog({
  open,
  knowledgeBase,
  canAdmin,
  onClose,
}: {
  open: boolean
  knowledgeBase: { id: string; name: string } | null
  canAdmin: boolean
  onClose: () => void
}) {
  const { showToast, openDocument } = useAppShell()
  const kbId = knowledgeBase?.id ?? ""
  const contextKey = useRef("")
  contextKey.current = `${kbId}:${open}`
  const pageRequest = useRef(0)
  const [view, setView] = useState<View>("pages")
  const [enabled, setEnabled] = useState(false)
  const [query, setQuery] = useState("")
  const [pages, setPages] = useState<WikiPagePayload[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [pagesLoading, setPagesLoading] = useState(false)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [indexPages, setIndexPages] = useState<
    Array<{
      slug: string
      title: string
      summary: string
      folderId: string
    }>
  >([])
  const [graph, setGraph] = useState<{
    nodes: Array<{ slug: string; title: string; pageType: string }>
    edges: Array<{ source: string; target: string }>
  }>({ nodes: [], edges: [] })
  const [folders, setFolders] = useState<WikiFolderPayload[]>([])
  const [jobs, setJobs] = useState<WikiJobPayload[]>([])
  const [issues, setIssues] = useState<WikiIssuePayload[]>([])
  const [findings, setFindings] = useState<
    Array<{
      slug: string
      kind: string
      target?: string
    }>
  >([])
  const [selected, setSelected] = useState<WikiPagePayload | null>(null)
  const [sources, setSources] = useState<Array<{ id: string; title: string }>>(
    [],
  )
  const [proposal, setProposal] = useState<WikiProposalPayload | null>(null)
  const [revisions, setRevisions] = useState<WikiRevisionPayload[]>([])
  const [editing, setEditing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({
    slug: "",
    title: "",
    content: "",
    summary: "",
  })
  const [folderName, setFolderName] = useState("")
  const [renaming, setRenaming] = useState<WikiFolderPayload | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [issueText, setIssueText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [agentMessage, setAgentMessage] = useState("")
  const [agentReply, setAgentReply] = useState("")
  const [agentCalls, setAgentCalls] = useState<
    Array<{ tool: string; outcome: string }>
  >([])

  const refresh = useCallback(async () => {
    if (!kbId) return
    const key = contextKey.current
    try {
      const [settings, folderData, indexData, graphData] = await Promise.all([
        wikiApi.settings(kbId),
        wikiApi.folders(kbId),
        wikiApi.index(kbId),
        wikiApi.graph(kbId),
      ])
      const [jobData, issueData, lintData] = canAdmin
        ? await Promise.all([
            wikiApi.jobs(kbId),
            wikiApi.issues(kbId),
            wikiApi.lint(kbId),
          ])
        : [{ jobs: [] }, { issues: [] }, { findings: [] }]
      if (contextKey.current !== key) return
      setEnabled(settings.enabled)
      setIndexPages(indexData.groups.flatMap((group) => group.pages))
      setGraph(graphData)
      setRefreshVersion((value) => value + 1)
      setFolders(folderData.folders)
      setJobs(jobData.jobs)
      setIssues(issueData.issues)
      setFindings(lintData.findings)
      setError(null)
    } catch (cause) {
      if (contextKey.current === key)
        setError(cause instanceof Error ? cause.message : "Wiki 读取失败")
    }
  }, [kbId, canAdmin])

  useEffect(() => {
    if (!open || !kbId) return
    setView("pages")
    setSelected(null)
    setQuery("")
    setOffset(0)
    setPages([])
    void refresh()
  }, [open, kbId, refresh])

  useEffect(() => {
    if (
      !open ||
      !jobs.some((job) => job.status === "pending" || job.status === "running")
    )
      return
    const timer = window.setTimeout(() => {
      void refresh()
    }, 3000)
    return () => window.clearTimeout(timer)
  }, [open, jobs, refresh])

  useEffect(() => {
    if (!open || !kbId) return
    let active = true
    setPagesLoading(true)
    const timer = window.setTimeout(() => {
      void wikiApi
        .pages(kbId, query, canAdmin, offset, 50)
        .then((data) => {
          if (!active) return
          setPages(data.pages)
          setTotal(data.total)
        })
        .catch((cause: unknown) => {
          if (active)
            setError(cause instanceof Error ? cause.message : "页面读取失败")
        })
        .finally(() => {
          if (active) setPagesLoading(false)
        })
    }, 180)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [open, kbId, query, canAdmin, offset, refreshVersion])

  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      await refresh()
      showToast(message)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wiki 操作失败")
    } finally {
      setBusy(false)
    }
  }

  const openPage = async (slug: string) => {
    if (!kbId) return
    const key = contextKey.current
    const request = ++pageRequest.current
    try {
      const [detail, history] = await Promise.all([
        wikiApi.page(kbId, slug),
        canAdmin
          ? wikiApi.revisions(kbId, slug)
          : Promise.resolve({ revisions: [] }),
      ])
      if (contextKey.current !== key || pageRequest.current !== request) return
      setSelected(detail.page)
      setSources(detail.sources)
      setProposal(detail.proposal)
      setRevisions(history.revisions)
      setEditing(false)
      setCreating(false)
      setDraft({
        slug: detail.page.slug,
        title: detail.page.title,
        content: detail.page.content,
        summary: detail.page.summary,
      })
      setView("pages")
      setError(null)
    } catch (cause) {
      if (contextKey.current === key && pageRequest.current === request) {
        setError(cause instanceof Error ? cause.message : "页面读取失败")
      }
    }
  }

  const savePage = () => {
    if (
      !kbId ||
      !draft.title.trim() ||
      !draft.content.trim() ||
      !draft.slug.trim()
    )
      return
    void run(
      async () => {
        const response = creating
          ? await wikiApi.createPage(kbId, draft)
          : await wikiApi.updatePage(kbId, selected!.slug, {
              ...draft,
              expectedVersion: selected!.version,
            })
        await openPage(response.page.slug)
      },
      creating ? "页面已创建" : "页面已保存",
    )
  }

  const published = pages.filter((page) => page.status === "published")
  const archived = pages.filter((page) => page.status !== "published")

  const commitRename = () => {
    if (!renaming || busy) return
    const name = renameValue.trim()
    if (!name) return
    void run(
      () => wikiApi.updateFolder(kbId, renaming.id, name, renaming.parentId),
      "目录已更新",
    )
    setRenaming(null)
  }

  return (
    <PanelDialog
      open={open}
      onClose={onClose}
      titleId="wiki-title"
      title={`${knowledgeBase?.name ?? "知识库"} / Wiki`}
      className="sm:max-w-6xl"
    >
      <div className="flex min-h-12 flex-none items-center justify-end gap-3 border-b border-line px-4">
        {canAdmin ? (
          <label className="flex cursor-pointer items-center gap-2 text-xs text-faint">
            <Switch
              checked={enabled}
              disabled={busy || !kbId}
              onCheckedChange={(checked) =>
                void run(
                  () => wikiApi.setEnabled(kbId, checked),
                  checked ? "Wiki 已开启" : "Wiki 已关闭",
                )
              }
              aria-label="Wiki 自动生成"
            />
            自动生成
          </label>
        ) : null}
        <UiButton
          variant="ghost"
          size="sm"
          type="button"
          className={iconButton}
          title="刷新"
          aria-label="刷新"
          onClick={() => void refresh()}
        >
          <Icon data-icon="inline-start" icon={RefreshCw} />
        </UiButton>
      </div>

      {/* Folder rename replaces the OS prompt (unstylable, no transition): the
          nested confirm-tier dialog gets the shared top-layer transitions. */}
      <ConfirmDialog
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title="重命名目录"
        titleId="wiki-folder-rename-title"
        confirmLabel="重命名"
        confirmTone="primary"
        onConfirm={() => commitRename()}
        busy={busy}
        confirmDisabled={!renameValue.trim()}
      >
        <TextInput
          value={renameValue}
          maxLength={64}
          aria-label="目录名称"
          placeholder="目录名称"
          onChange={(event) => setRenameValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitRename()
          }}
        />
        <p>输入新的目录名称，子目录与页面归属保持不变。</p>
      </ConfirmDialog>

      <Tabs
        value={view}
        onValueChange={(value) => setView(value as View)}
        className="shrink-0 overflow-x-auto px-4 py-3"
      >
        <TabsList aria-label="Wiki 视图">
          {TABS.filter(
            (tab) => canAdmin || !["jobs", "issues", "agent"].includes(tab.id),
          ).map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.label}
              {tab.id === "jobs" && jobs.some((job) => job.status === "failed")
                ? " ·"
                : ""}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {error ? (
        <Alert tone="danger" title="发生错误"
          className="border-b px-4 py-2"
        >
          {error}
        </Alert>
      ) : null}

      {view === "agent" && canAdmin ? (
        <main className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="mx-auto max-w-3xl flex flex-col gap-4">
            <form
              onSubmit={(event) => {
                event.preventDefault()
                if (!agentMessage.trim()) return
                void run(async () => {
                  const result = await wikiApi.agent(kbId, agentMessage.trim())
                  setAgentReply(result.reply)
                  setAgentCalls(result.toolCalls)
                }, "Wiki 助手任务结束")
              }}
              className="flex items-end gap-2"
            >
              <Textarea
                aria-label="Wiki 助手消息"
                value={agentMessage}
                onChange={(event) => setAgentMessage(event.target.value)}
                maxLength={8000}
                className={`${field} min-h-24 resize-y py-2`}
              />
              <UiButton
                variant="ghost"
                size="sm"
                type="submit"
                className={command}
                disabled={busy || !enabled || !agentMessage.trim()}
              >
                <Icon data-icon="inline-start" icon={Check} />
                执行
              </UiButton>
            </form>
            {busy ? (
              <p role="status" className="text-xs text-faint">
                处理中
              </p>
            ) : null}
            {agentReply ? (
              <div className="prose max-w-none text-sm">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {agentReply}
                </ReactMarkdown>
              </div>
            ) : null}
            {agentCalls.length ? (
              <ul className="divide-y divide-line text-xs text-faint">
                {agentCalls.map((call, index) => (
                  <li key={index} className="flex justify-between py-2">
                    <span>{call.tool}</span>
                    <span>{call.outcome}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </main>
      ) : null}

      {view === "pages" ? (
        <div className="flex min-h-0 flex-1 max-md:flex-col">
          <aside
            className={`${selected || editing || creating ? "max-md:hidden" : ""} flex w-72 flex-none flex-col border-r border-line max-md:w-full max-md:flex-1 max-md:border-r-0`}
          >
            <div className="flex gap-2 border-b border-line p-3">
              <div className="min-w-0 flex-1">
                <SearchField
                  aria-label="搜索 Wiki 页面"
                  clearLabel="清空 Wiki 搜索"
                  value={query}
                  onValueChange={(next) => {
                    setQuery(next)
                    setOffset(0)
                  }}
                  placeholder="搜索页面"
                />
              </div>
              {canAdmin ? (
                <UiButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  className={iconButton}
                  title="新建页面"
                  aria-label="新建页面"
                  onClick={() => {
                    setSelected(null)
                    setCreating(true)
                    setEditing(true)
                    setDraft({ slug: "", title: "", content: "", summary: "" })
                  }}
                >
                  <Icon data-icon="inline-start" icon={Plus} />
                </UiButton>
              ) : null}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {pagesLoading ? (
                <p role="status" className="p-3 text-xs text-faint">
                  加载中
                </p>
              ) : pages.length === 0 ? (
                <p className="p-3 text-xs text-faint">暂无页面</p>
              ) : null}
              {published.map((page) => (
                <UiButton
                  variant="ghost"
                  size="sm"
                  key={page.id}
                  type="button"
                  onClick={() => void openPage(page.slug)}
                  className={`mb-0.5 flex w-full min-w-0 flex-col rounded-md px-2.5 py-2 text-left hover:bg-surface-subtle `}
                >
                  <span className="w-full truncate text-xs font-medium">
                    {page.title}
                  </span>
                  <span className="mt-0.5 w-full truncate text-[11px] text-faint">
                    {page.pageType} · v{page.version} · {page.sourceRefs.length}{" "}
                    来源
                  </span>
                </UiButton>
              ))}
              {archived.length ? (
                <p className="px-2.5 py-2 text-[11px] text-faint">
                  未发布 / 已归档
                </p>
              ) : null}
              {archived.map((page) => (
                <UiButton
                  variant="ghost"
                  size="sm"
                  key={page.id}
                  type="button"
                  onClick={() => void openPage(page.slug)}
                  className="mb-0.5 w-full truncate px-2.5 py-2 text-left"
                >
                  {page.title} · {page.status}
                </UiButton>
              ))}
            </div>
            <div className="flex h-11 flex-none items-center justify-between border-t border-line px-3 text-xs text-faint">
              <span>
                {total
                  ? `${offset + 1}-${Math.min(offset + 50, total)} / ${total}`
                  : "0 页"}
              </span>
              <div className="flex gap-1">
                <UiButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  className={iconButton}
                  title="上一页"
                  aria-label="上一页"
                  disabled={pagesLoading || offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - 50))}
                >
                  <Icon data-icon="inline-start" icon={ChevronLeft} />
                </UiButton>
                <UiButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  className={iconButton}
                  title="下一页"
                  aria-label="下一页"
                  disabled={pagesLoading || offset + 50 >= total}
                  onClick={() => setOffset(offset + 50)}
                >
                  <Icon data-icon="inline-start" icon={ChevronRight} />
                </UiButton>
              </div>
            </div>
          </aside>

          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4 max-md:px-4">
            {editing ? (
              <div className="mx-auto max-w-3xl flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <UiButton
                    variant="ghost"
                    size="sm"
                    type="button"
                    className={iconButton}
                    aria-label="返回页面"
                    title="返回页面"
                    onClick={() => {
                      setEditing(false)
                      setCreating(false)
                    }}
                  >
                    <Icon data-icon="inline-start" icon={ChevronLeft} />
                  </UiButton>
                  <h3 className="flex-1 text-sm font-semibold">
                    {creating ? "新建页面" : "编辑页面"}
                  </h3>
                  <UiButton
                    variant="ghost"
                    size="sm"
                    type="button"
                    className={command}
                    disabled={busy}
                    onClick={savePage}
                  >
                    <Icon data-icon="inline-start" icon={Check} />
                    保存
                  </UiButton>
                </div>
                <Input
                  aria-label="页面标题"
                  className={field}
                  value={draft.title}
                  placeholder="标题"
                  onChange={(event) =>
                    setDraft({ ...draft, title: event.target.value })
                  }
                />
                <Input
                  aria-label="页面标识"
                  className={field}
                  value={draft.slug}
                  placeholder="页面标识，如 concept/rag"
                  onChange={(event) =>
                    setDraft({ ...draft, slug: event.target.value })
                  }
                />
                <Input
                  aria-label="页面摘要"
                  className={field}
                  value={draft.summary}
                  placeholder="摘要"
                  onChange={(event) =>
                    setDraft({ ...draft, summary: event.target.value })
                  }
                />
                <Textarea
                  aria-label="页面内容"
                  className={`${field} min-h-80 resize-y py-2 font-mono leading-6`}
                  value={draft.content}
                  onChange={(event) =>
                    setDraft({ ...draft, content: event.target.value })
                  }
                />
              </div>
            ) : selected ? (
              <article className="mx-auto max-w-3xl">
                <div className="mb-4 flex flex-wrap items-start gap-2">
                  <UiButton
                    variant="ghost"
                    size="sm"
                    type="button"
                    className={`${iconButton} md:hidden`}
                    aria-label="返回列表"
                    onClick={() => setSelected(null)}
                  >
                    <Icon data-icon="inline-start" icon={ChevronLeft} />
                  </UiButton>
                  <div className="min-w-0 flex-1">
                    <h3 className="break-words text-lg font-semibold">
                      {selected.title}
                    </h3>
                    <p className="mt-1 break-all text-[11px] text-faint">
                      {selected.slug} · v{selected.version} · {selected.status}
                    </p>
                  </div>
                  {canAdmin ? (
                    <UiButton
                      variant="ghost"
                      size="sm"
                      type="button"
                      className={command}
                      onClick={() => setEditing(true)}
                    >
                      <Icon data-icon="inline-start" icon={Pencil} />
                      编辑
                    </UiButton>
                  ) : null}
                  {canAdmin ? (
                    <UiButton
                      variant="ghost"
                      size="sm"
                      type="button"
                      className={iconButton}
                      title="归档页面"
                      aria-label="归档页面"
                      disabled={busy || selected.status === "archived"}
                      onClick={() =>
                        void run(async () => {
                          await wikiApi.archivePage(kbId, selected.slug)
                          await openPage(selected.slug)
                        }, "页面已归档")
                      }
                    >
                      <Icon data-icon="inline-start" icon={Archive} />
                    </UiButton>
                  ) : null}
                </div>
                {proposal ? (
                  <section className="mb-4 border-y border-warning-line bg-warning-subtle py-3 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="flex-1">自动更新待合并</strong>
                      <UiButton
                        variant="ghost"
                        size="sm"
                        type="button"
                        className={command}
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await wikiApi.acceptProposal(kbId, selected.slug)
                            await openPage(selected.slug)
                          }, "候选修订已合并")
                        }
                      >
                        合并更新
                      </UiButton>
                    </div>
                    <p className="mt-1 text-faint">
                      {proposal.sourceRefs.length} 份来源 ·{" "}
                      {proposal.chunkRefs.length} 个切片
                    </p>
                    <Collapsible className="mt-2">
                      <CollapsibleTrigger asChild>
                        <DisclosureButton
                          variant="ghost"
                          size="sm"
                          className="h-auto w-full justify-start whitespace-normal text-left"
                        >
                          查看候选内容
                        </DisclosureButton>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words">
                          {proposal.content}
                        </pre>
                      </CollapsibleContent>
                    </Collapsible>
                  </section>
                ) : null}
                <div className="prose prose-sm max-w-none break-words text-ink">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      a: ({ href, children }) =>
                        href?.startsWith("#wiki/") ? (
                          <a
                            href={href}
                            onClick={(event) => {
                              event.preventDefault()
                              void openPage(decodeURIComponent(href.slice(6)))
                            }}
                          >
                            {children}
                          </a>
                        ) : (
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {children}
                          </a>
                        ),
                    }}
                  >
                    {wikiMarkdown(selected.content)}
                  </ReactMarkdown>
                </div>
                <section className="mt-8 border-t border-line pt-4">
                  <h4 className="text-xs font-semibold">来源与切片</h4>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selected.sourceRefs.map((id) => (
                      <UiButton
                        variant="ghost"
                        size="sm"
                        key={id}
                        type="button"
                        className={command}
                        onClick={() => openDocument({ documentId: id })}
                        title={`打开原文 ${id}`}
                      >
                        <Icon
                          data-icon="inline-start"
                          icon={FileText}
                          className=" flex-none"
                        />
                        <span className="min-w-0 truncate">
                          {sources.find((source) => source.id === id)?.title ??
                            "源文档"}
                        </span>
                      </UiButton>
                    ))}
                    <span className="self-center text-[11px] text-faint">
                      {selected.chunkRefs.length} 个引用切片
                    </span>
                  </div>
                  <FormField className="mt-4 flex flex-wrap items-center gap-2">
                    <FieldLabel
                      className="text-xs text-faint"
                      htmlFor="wiki-page-folder"
                    >
                      目录
                    </FieldLabel>
                    <Select
                      id="wiki-page-folder"
                      aria-label="页面目录"
                      disabled={!canAdmin}
                      value={selected.folderId}
                      wrapperClassName="flex-none w-48"
                      onChange={(event) =>
                        void run(async () => {
                          await wikiApi.movePage(
                            kbId,
                            selected.slug,
                            event.target.value,
                          )
                          await openPage(selected.slug)
                        }, "目录已更新")
                      }
                    >
                      <option value="">根目录</option>
                      {folders.map((folder) => (
                        <option key={folder.id} value={folder.id}>
                          {folder.name}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                </section>
                {canAdmin ? (
                  <section className="mt-6 border-t border-line pt-4">
                    <h4 className="text-xs font-semibold">修订历史</h4>
                    <ul className="mt-2 flex flex-col gap-1 text-xs">
                      {revisions.map((revision) => (
                        <li
                          key={revision.version}
                          className="flex items-center gap-2 py-1"
                        >
                          <span className="flex-1 text-faint">
                            v{revision.version} · {revision.editSource} ·{" "}
                            {new Date(revision.createdAt).toLocaleString()}
                          </span>
                          <UiButton
                            variant="ghost"
                            size="sm"
                            type="button"
                            className={command}
                            disabled={
                              busy || revision.version === selected.version
                            }
                            onClick={() =>
                              void run(async () => {
                                await wikiApi.revert(
                                  kbId,
                                  selected.slug,
                                  revision.version,
                                )
                                await openPage(selected.slug)
                              }, "历史版本已恢复")
                            }
                          >
                            恢复
                          </UiButton>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                {canAdmin ? (
                  <section className="mt-6 border-t border-line pt-4">
                    <h4 className="text-xs font-semibold">问题记录</h4>
                    <div className="mt-2 flex gap-2">
                      <Input
                        className={field}
                        aria-label="记录页面问题"
                        value={issueText}
                        onChange={(event) => setIssueText(event.target.value)}
                        placeholder="记录问题"
                      />
                      <UiButton
                        variant="ghost"
                        size="sm"
                        type="button"
                        className={command}
                        disabled={busy || !issueText.trim()}
                        onClick={() =>
                          void run(async () => {
                            await wikiApi.createIssue(
                              kbId,
                              selected.slug,
                              issueText.trim(),
                            )
                            setIssueText("")
                          }, "问题已记录")
                        }
                      >
                        记录
                      </UiButton>
                    </div>
                  </section>
                ) : null}
              </article>
            ) : (
              <div className="grid h-full place-items-center text-xs text-faint">
                选择一个页面
              </div>
            )}
          </main>
        </div>
      ) : null}

      {view === "directory" ? (
        <main className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="mx-auto max-w-3xl">
            {canAdmin ? (
              <div className="flex gap-2">
                <Input
                  className={`${field} max-w-60`}
                  aria-label="新目录名称"
                  value={folderName}
                  onChange={(event) => setFolderName(event.target.value)}
                  placeholder="新目录名称"
                />
                <UiButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  className={command}
                  disabled={busy || !folderName.trim()}
                  onClick={() =>
                    void run(async () => {
                      await wikiApi.createFolder(kbId, folderName.trim())
                      setFolderName("")
                    }, "目录已创建")
                  }
                >
                  <Icon data-icon="inline-start" icon={Plus} />
                  新建
                </UiButton>
              </div>
            ) : null}
            <ul className="mt-5 divide-y divide-line">
              <li className="py-2 text-xs font-medium">根目录</li>
              {folders.map((folder) => (
                <li
                  key={folder.id}
                  className="flex items-center gap-3 py-2 text-xs"
                >
                  <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                  <span className="text-faint">
                    {
                      indexPages.filter((page) => page.folderId === folder.id)
                        .length
                    }{" "}
                    页
                  </span>
                  {canAdmin ? (
                    <UiButton
                      variant="ghost"
                      size="sm"
                      type="button"
                      className={iconButton}
                      title="重命名目录"
                      aria-label="重命名目录"
                      onClick={() => {
                        setRenaming(folder)
                        setRenameValue(folder.name)
                      }}
                    >
                      <Icon data-icon="inline-start" icon={Pencil} />
                    </UiButton>
                  ) : null}
                  {canAdmin ? (
                    <UiButton
                      variant="ghost"
                      size="sm"
                      type="button"
                      className={iconButton}
                      title="删除目录"
                      aria-label="删除目录"
                      onClick={() =>
                        void run(
                          () => wikiApi.deleteFolder(kbId, folder.id),
                          "目录已删除",
                        )
                      }
                    >
                      <Icon data-icon="inline-start" icon={X} />
                    </UiButton>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </main>
      ) : null}

      {view === "graph" ? (
        <main className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="mx-auto max-w-3xl">
            <div className="flex items-center gap-2 text-xs text-faint">
              <Icon icon={Network} className="size-4" />
              {graph.nodes.length} 页面 · {graph.edges.length} 链接
            </div>
            <ul className="mt-4 divide-y divide-line">
              {graph.nodes.map((page) => (
                <li key={page.slug} className="py-3">
                  <UiButton
                    variant="ghost"
                    size="sm"
                    type="button"
                    className=""
                    onClick={() => void openPage(page.slug)}
                  >
                    {page.title}
                  </UiButton>
                  <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-faint">
                    {graph.edges.some((edge) => edge.source === page.slug) ? (
                      graph.edges
                        .filter((edge) => edge.source === page.slug)
                        .map(({ target: slug }) => (
                          <UiButton
                            variant="ghost"
                            size="sm"
                            key={slug}
                            type="button"
                            onClick={() => void openPage(slug)}
                            className=""
                          >
                            →{" "}
                            {graph.nodes.find((item) => item.slug === slug)
                              ?.title ?? slug}
                          </UiButton>
                        ))
                    ) : (
                      <span>暂无出链</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </main>
      ) : null}

      {view === "jobs" ? (
        <main className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="mx-auto max-w-3xl">
            <UiButton
              variant="ghost"
              size="sm"
              type="button"
              className={command}
              disabled={busy || !enabled}
              onClick={() =>
                void run(async () => {
                  const result = await wikiApi.rebuild(kbId)
                  showToast(`已排队 ${result.enqueued} 份文档`)
                }, "Wiki 重建已排队")
              }
            >
              <Icon data-icon="inline-start" icon={RefreshCw} />
              重建当前知识库
            </UiButton>
            <ul className="mt-4 divide-y divide-line text-xs">
              {jobs.map((job) => (
                <li
                  key={job.id}
                  className="flex flex-wrap items-center gap-2 py-2"
                >
                  <span className="w-16 text-faint">#{job.id}</span>
                  <span className="w-14">
                    {job.op === "ingest" ? "生成" : "撤回"}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">
                    {job.documentId}
                  </span>
                  <span
                    className={
                      job.status === "failed"
                        ? "text-danger"
                        : "text-faint"
                    }
                  >
                    {job.status}
                  </span>
                  {job.status === "failed" ? (
                    <UiButton
                      variant="ghost"
                      size="sm"
                      type="button"
                      className={command}
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => wikiApi.retryJob(kbId, job.id),
                          "任务已重试",
                        )
                      }
                    >
                      重试
                    </UiButton>
                  ) : null}
                  {job.error ? (
                    <p className="w-full break-words pl-16 text-[11px] text-danger">
                      {job.error}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </main>
      ) : null}

      {view === "issues" ? (
        <main className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="mx-auto max-w-3xl flex flex-col gap-6">
            <section>
              <h3 className="text-xs font-semibold">
                结构检查 · {findings.length}
              </h3>
              <ul className="mt-2 divide-y divide-line text-xs">
                {findings.map((finding, index) => (
                  <li
                    key={`${finding.slug}:${index}`}
                    className="flex gap-2 py-2"
                  >
                    <UiButton
                      variant="ghost"
                      size="sm"
                      type="button"
                      className=""
                      onClick={() => void openPage(finding.slug)}
                    >
                      {finding.slug}
                    </UiButton>
                    <span className="text-faint">
                      {finding.kind}
                      {finding.target ? ` · ${finding.target}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h3 className="text-xs font-semibold">
                问题记录 ·{" "}
                {issues.filter((issue) => issue.status === "open").length}{" "}
                未解决
              </h3>
              <ul className="mt-2 divide-y divide-line text-xs">
                {issues.map((issue) => (
                  <li key={issue.id} className="flex items-center gap-2 py-2">
                    <span className="min-w-0 flex-1 break-words">
                      {issue.message}
                    </span>
                    <span className="text-faint">
                      {issue.status}
                    </span>
                    {issue.status === "open" ? (
                      <UiButton
                        variant="ghost"
                        size="sm"
                        type="button"
                        className={command}
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () =>
                              wikiApi.updateIssue(kbId, issue.id, "resolved"),
                            "问题已解决",
                          )
                        }
                      >
                        解决
                      </UiButton>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </main>
      ) : null}
    </PanelDialog>
  )
}
