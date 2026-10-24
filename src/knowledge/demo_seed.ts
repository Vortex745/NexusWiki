/**
 * Ticket 42 (DEMO-01A) — seed a deterministic demo namespace.
 *
 * The demo operator seeds a fixed set of project documents and clearly
 * fictional Chinese policy documents into the fixed demo tenant
 * ({@link DEMO_TENANT_ID}). Every identifier the seed controls is
 * deterministic:
 *
 *   - the two knowledge bases have fixed ids (`kb-demo-project`,
 *     `kb-demo-policy`) and are created through `insertIfAbsent`;
 *   - every document rides ONE stable source identity
 *     (`demo://seed/<slug>` in the `demo-seed` namespace), so the content
 *     hash check of the normal ingestion lifecycle makes a re-seed of
 *     unchanged content an honest "unchanged" — no duplicate version is
 *     ever created, and changed content becomes exactly ONE new version;
 *     the seed does not return until every seeded document is COMPLETED,
 *     and fails loudly when ingestion cannot deliver;
 *   - FAQ entries and long-term memories carry deterministic uuid-v5 ids
 *     and are skipped when their row already exists (any status).
 *
 * The digests reported here are plain sha256 over the exact seeded content,
 * so an operator can verify what is in the namespace without trusting the
 * seeder's own bookkeeping. Ingestion itself goes through the NORMAL
 * lifecycle — no second ingestion implementation exists.
 */

import { createHash } from "node:crypto"
import { v5 as uuidv5 } from "uuid"
import type { IngestionLifecycle } from "../ingestion/lifecycle"
import type { DB } from "../ingestion/tracking/db"
import { DEMO_TENANT_ID } from "../identity/demo_accounts"
import { FaqConflictError, FaqEntryServiceImpl } from "../faq/faq_entry_service"
import { SqliteFaqEntryRepo } from "../faq/faq_entry_repo"
import { LongTermMemoryStore, MemoryQuotaError } from "../memory/long_term_memory_store"
import { SqliteKnowledgeBaseRepo } from "./knowledge_base_repo"
import { normalizeFaqQuestion } from "../types/faq"

export { DEMO_TENANT_ID as DEMO_NAMESPACE_TENANT }

export const DEMO_PROJECT_KB_ID = "kb-demo-project"
export const DEMO_POLICY_KB_ID = "kb-demo-policy"

/** The namespace every seeded source identity lives under. */
export const DEMO_SEED_SOURCE_NAMESPACE = "demo-seed"

/**
 * Fixed uuid-v5 namespace for deterministic seed identifiers (a randomly
 * generated, never-changing value — the ids derived from it are stable
 * across processes and machines).
 */
const SEED_UUID_NAMESPACE = "7b1d3a6e-42c5-4d7e-9a51-0f2c8b6d3e91"

export interface DemoSeedDocument {
  slug: string
  knowledgeBaseId: string
  title: string
  content: string
}

/** The deterministic project documents (fictional, self-contained demo). */
export const DEMO_PROJECT_DOCUMENTS: readonly DemoSeedDocument[] = [
  {
    slug: "project/architecture-overview",
    knowledgeBaseId: DEMO_PROJECT_KB_ID,
    title: "架构总览",
    content: [
      "# 架构总览",
      "",
      "本系统是一个模块化单体：接入层、检索编排层与存储适配层在同一进程内。",
      "检索编排层固定走共享答案入口，四条检索通道（向量、BM25、图谱、页面索引）",
      "在服务端按知识库作用域收口。任何新执行面都必须携带同一份 AccessContext，",
      "绝不从请求体读取租户身份。",
    ].join("\n"),
  },
  {
    slug: "project/api-contract",
    knowledgeBaseId: DEMO_PROJECT_KB_ID,
    title: "API 契约",
    content: [
      "# API 契约",
      "",
      "问答接口只接受 assistantId 与消息正文；知识库选择由助手绑定决定，",
      "请求不能扩大作用域。未知资源与跨租户资源一律返回相同的 404，",
      "归档知识库返回 409。导入接口在归属解析通过之前不发出任何网络请求。",
    ].join("\n"),
  },
  {
    slug: "project/deployment-runbook",
    knowledgeBaseId: DEMO_PROJECT_KB_ID,
    title: "部署手册",
    content: [
      "# 部署手册",
      "",
      "本地演示按顺序启动：基础设施（Elasticsearch、Neo4j）→ 环境检查 →",
      "后端 → 前端 → 状态页。演示数据通过 demo:seed 播种，通过 demo:reset",
      "在确认后重建。两者都只触碰固定演示命名空间。",
    ].join("\n"),
  },
  {
    slug: "project/retrieval-channels",
    knowledgeBaseId: DEMO_PROJECT_KB_ID,
    title: "检索通道说明",
    content: [
      "# 检索通道说明",
      "",
      "向量检索使用嵌入模型计算语义相似度；BM25 走关键词全文匹配；",
      "知识图谱沿实体与关系扩展上下文；页面索引按章节树补齐父块。",
      "四路结果经 RRF 融合后，如配置了专用重排模型则再做一次精排。",
    ].join("\n"),
  },
  {
    slug: "project/session-scope",
    knowledgeBaseId: DEMO_PROJECT_KB_ID,
    title: "会话作用域规则",
    content: [
      "# 会话作用域规则",
      "",
      "每个会话在第一条消息发出时锁定检索作用域；之后在同一会话内",
      "调整知识库选择不会影响已锁定的会话。需要新的作用域时请新建对话。",
      "锁定后的作用域无法被请求参数放宽。",
    ].join("\n"),
  },
  {
    slug: "project/evaluation-guide",
    knowledgeBaseId: DEMO_PROJECT_KB_ID,
    title: "评测指南",
    content: [
      "# 评测指南",
      "",
      "评测任务在进程内运行：准备 → 逐题 → 清理三个阶段，支持取消。",
      "检索侧六项指标与生成侧 BLEU/ROUGE 全部是诊断值；发布判定只依据",
      "硬性约束与预写答案点规则。失败题目绝不伪造答案或分数。",
    ].join("\n"),
  },
  {
    slug: "project/faq-workflow",
    knowledgeBaseId: DEMO_PROJECT_KB_ID,
    title: "标准问答工作流",
    content: [
      "# 标准问答工作流",
      "",
      "标准问答（FAQ）按归一化问题精确匹配：命中即直接返回标准答案，",
      "并标注版本号与参考来源；模糊命中走证据路径，绝不冒充标准答案。",
      "同一归一化问题只允许一个启用中的标准答案，冲突将被拒绝。",
    ].join("\n"),
  },
  {
    slug: "project/observability",
    knowledgeBaseId: DEMO_PROJECT_KB_ID,
    title: "可观测性说明",
    content: [
      "# 可观测性说明",
      "",
      "每次回答的执行链路可在前端查看：路由、检索、证据整理与校验阶段",
      "均带耗时与结果计数。Langfuse 为可选导出，未配置时不影响任何功能。",
      "诊断信息只包含主机名与配置布尔值，绝不包含凭据。",
    ].join("\n"),
  },
  {
    slug: "project/security-model",
    knowledgeBaseId: DEMO_PROJECT_KB_ID,
    title: "安全模型",
    content: [
      "# 安全模型",
      "",
      "租户永远来自服务端解析的 AccessContext；组轴决定文档可见性；",
      "跨租户资源与不存在的资源不可区分。URL 抓取强制私网拒绝与",
      "重定向重新校验。诊断输出不含凭据、原始请求头或供应商内部信息。",
    ].join("\n"),
  },
  {
    slug: "project/troubleshooting",
    knowledgeBaseId: DEMO_PROJECT_KB_ID,
    title: "常见问题排查",
    content: [
      "# 常见问题排查",
      "",
      "检索为空时先检查会话作用域与知识库选择；回答降级时查看状态页的",
      "通道状态；文档导入失败时确认解析器可用与来源生命周期。所有失败",
      "都有明确的失败原因，绝不静默吞掉。",
    ].join("\n"),
  },
] as const

/**
 * The deterministic fictional policy documents. These are CLEARLY marked
 * fictional — the isolation/refusal demo cases (ticket 46) lean on them.
 */
export const DEMO_POLICY_DOCUMENTS: readonly DemoSeedDocument[] = [
  {
    slug: "policy/fictional-refund-policy",
    knowledgeBaseId: DEMO_POLICY_KB_ID,
    title: "虚构演示：退货政策",
    content: [
      "# 退货政策（虚构演示数据）",
      "",
      "本文档为演示虚构。标准商品自签收之日起 30 个自然日内可申请退货，",
      "定制商品不支持退货。退款在仓库验收后 7 个工作日内原路退回。",
      "本政策仅用于检索与隔离演示，不构成任何真实承诺。",
    ].join("\n"),
  },
  {
    slug: "policy/fictional-leave-policy",
    knowledgeBaseId: DEMO_POLICY_KB_ID,
    title: "虚构演示：休假政策",
    content: [
      "# 休假政策（虚构演示数据）",
      "",
      "本文档为演示虚构。年假按司龄分档：满一年 5 天，满三年 10 天，",
      "满五年 15 天，上限 20 天。病假需在当日 10 点前通知直属负责人。",
      "本政策仅用于检索与隔离演示。",
    ].join("\n"),
  },
  {
    slug: "policy/fictional-security-baseline",
    knowledgeBaseId: DEMO_POLICY_KB_ID,
    title: "虚构演示：安全基线",
    content: [
      "# 安全基线（虚构演示数据）",
      "",
      "本文档为演示虚构。所有服务账号必须使用最小权限；生产数据不得进入",
      "演示环境；日志不得包含凭据、原始请求头或供应商密钥。诊断输出只允许",
      "报告配置布尔值与脱敏后的端点。",
    ].join("\n"),
  },
  {
    slug: "policy/fictional-expense-policy",
    knowledgeBaseId: DEMO_POLICY_KB_ID,
    title: "虚构演示：报销政策",
    content: [
      "# 报销政策（虚构演示数据）",
      "",
      "本文档为演示虚构。差旅报销需在返回后 10 个工作日内提交，",
      "单笔超过 5000 元需提前审批；餐饮报销需附发票与事由说明。",
      "本政策仅用于检索与隔离演示。",
    ].join("\n"),
  },
  {
    slug: "policy/fictional-remote-work-policy",
    knowledgeBaseId: DEMO_POLICY_KB_ID,
    title: "虚构演示：远程办公政策",
    content: [
      "# 远程办公政策（虚构演示数据）",
      "",
      "本文档为演示虚构。每周可远程办公 2 天，需提前一天在系统中登记；",
      "远程期间保持工作时间在线，重要会议必须视频参加。",
      "本政策仅用于检索与隔离演示。",
    ].join("\n"),
  },
  {
    slug: "policy/fictional-data-retention-policy",
    knowledgeBaseId: DEMO_POLICY_KB_ID,
    title: "虚构演示：数据保留政策",
    content: [
      "# 数据保留政策（虚构演示数据）",
      "",
      "本文档为演示虚构。会话记录保留 90 天；文档历史版本永久保留；",
      "退役内容的物理清理遵循保留策略。删除操作必须先有墓碑审计记录。",
      "本政策仅用于检索与隔离演示。",
    ].join("\n"),
  },
  {
    slug: "policy/fictional-onboarding-policy",
    knowledgeBaseId: DEMO_POLICY_KB_ID,
    title: "虚构演示：入职政策",
    content: [
      "# 入职政策（虚构演示数据）",
      "",
      "本文档为演示虚构。新员工入职首日完成账号开通与安全培训；",
      "第一周由导师带领完成环境搭建；转正答辩在入职三个月后进行。",
      "本政策仅用于检索与隔离演示。",
    ].join("\n"),
  },
  {
    slug: "policy/fictional-incident-response-policy",
    knowledgeBaseId: DEMO_POLICY_KB_ID,
    title: "虚构演示：事件响应政策",
    content: [
      "# 事件响应政策（虚构演示数据）",
      "",
      "本文档为演示虚构。安全事件按严重度分四级：四级事件 24 小时内上报，",
      "一级事件立即上报并成立响应小组。事后 5 个工作日内输出复盘报告。",
      "本政策仅用于检索与隔离演示。",
    ].join("\n"),
  },
] as const

/** Deterministic FAQ entries: id + question + answer are all fixed. */
export interface DemoSeedFaq {
  id: string
  knowledgeBaseId: string
  question: string
  answer: string
}

export const DEMO_FAQ_ENTRIES: readonly DemoSeedFaq[] = [
  {
    id: uuidv5("faq/project/refund-window", SEED_UUID_NAMESPACE),
    knowledgeBaseId: DEMO_POLICY_KB_ID,
    question: "退货期限是多久？",
    answer: "标准商品自签收之日起 30 个自然日内可申请退货（演示标准答案，引用虚构政策文档）。",
  },
  {
    id: uuidv5("faq/project/reset-command", SEED_UUID_NAMESPACE),
    knowledgeBaseId: DEMO_PROJECT_KB_ID,
    question: "演示数据如何重置？",
    answer: "运行 npm run demo:reset 预览，加 -- --confirm 执行；只重建固定演示命名空间。",
  },
] as const

/** The deterministic long-term memory seeded for the demo admin. */
export const DEMO_ADMIN_SUBJECT_ID = "demo-admin"
export const DEMO_MEMORY_CONTENT =
  "演示记忆：本演示的知识库包含明确标注为虚构的政策文档，用于检索隔离与拒答演示。"

export interface DemoSeedReport {
  tenantId: string
  knowledgeBases: Array<{ id: string; created: boolean }>
  documents: Array<{
    slug: string
    knowledgeBaseId: string
    sourceUri: string
    contentDigest: string
    outcome: "submitted" | "unchanged"
    documentId: string
  }>
  faqEntries: Array<{ id: string; question: string; created: boolean }>
  memories: Array<{ subjectId: string; contentDigest: string; created: boolean }>
}

export interface DemoSeedOptions {
  db: DB
  /** The NORMAL ingestion lifecycle — the seed drains it to activation. */
  lifecycle: IngestionLifecycle
  /** Embedding profile recorded on the seeded knowledge bases. */
  embeddingProfile: string
  now?: () => Date
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/** How long a seed waits for (retryable) ingestion work to settle. */
const SEED_DRAIN_DEADLINE_MS = 30_000

/**
 * Drain the lifecycle until every seeded document is COMPLETED. A retryable
 * failure requeues its task a moment into the future — keep draining (with
 * a bounded wait) so the seed reflects settled state, fail fast on terminal
 * document failures, and throw when the deadline passes with work pending.
 */
async function drainLifecycleUntilCompleted(
  db: DB,
  lifecycle: IngestionLifecycle,
  docIds: string[]
): Promise<void> {
  const deadline = Date.now() + SEED_DRAIN_DEADLINE_MS
  const statuses = (): Map<string, string> => {
    const rows = db
      .prepare(
        `SELECT doc_id, status FROM documents WHERE doc_id IN (${docIds.map(() => "?").join(",")})`
      )
      .all(...docIds) as Array<{ doc_id: string; status: string }>
    return new Map(rows.map((row) => [row.doc_id, row.status]))
  }
  for (;;) {
    while (await lifecycle.runNext()) {
      // keep draining
    }
    const current = statuses()
    const failed = [...current.entries()].filter(
      ([, status]) => status === "failed" || status === "cancelled"
    )
    if (failed.length > 0) {
      throw new Error(
        `seed ingestion failed for ${failed.length} document(s): ${failed
          .map(([docId, status]) => `${docId.slice(0, 8)}=${status}`)
          .join(", ")}`
      )
    }
    const pending = [...current.values()].filter((status) => status !== "completed")
    if (pending.length === 0) return
    if (Date.now() > deadline) {
      throw new Error(
        `seed ingestion did not settle within ${SEED_DRAIN_DEADLINE_MS}ms — ${pending.length} document(s) still ${pending[0]}`
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

function sourceUriOf(slug: string): string {
  return `demo://seed/${slug}`
}

/**
 * Seed the fixed demo namespace. Idempotent: calling it again over unchanged
 * content creates nothing — documents come back "unchanged", knowledge bases
 * and FAQ/memory rows are skipped when their deterministic counterpart
 * already exists. The lifecycle is drained to activation before returning.
 */
export async function seedDemoNamespace(options: DemoSeedOptions): Promise<DemoSeedReport> {
  const { db, lifecycle, embeddingProfile } = options
  const now = options.now ?? (() => new Date())
  const report: DemoSeedReport = {
    tenantId: DEMO_TENANT_ID,
    knowledgeBases: [],
    documents: [],
    faqEntries: [],
    memories: [],
  }

  // 1. The two fixed knowledge bases — insertIfAbsent makes a re-seed a no-op.
  const repo = new SqliteKnowledgeBaseRepo(db)
  for (const base of [
    {
      id: DEMO_PROJECT_KB_ID,
      name: "演示项目文档",
      description: "确定性演示命名空间的项目文档知识库。",
    },
    {
      id: DEMO_POLICY_KB_ID,
      name: "演示虚构政策",
      description: "明确标注为虚构的政策文档知识库，用于隔离与拒答演示。",
    },
  ]) {
    const existing = repo.getById(base.id, DEMO_TENANT_ID)
    if (!existing) {
      const timestamp = now().toISOString()
      repo.insertIfAbsent({
        id: base.id,
        tenantId: DEMO_TENANT_ID,
        name: base.name,
        description: base.description,
        status: "active",
        embeddingProfile,
        folderId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      report.knowledgeBases.push({ id: base.id, created: true })
    } else {
      report.knowledgeBases.push({ id: base.id, created: false })
    }
  }

  // 2. Documents through the NORMAL ingestion lifecycle. The stable source
  //    identity + the content-hash check are the whole idempotency story.
  const seededDocIds: string[] = []
  for (const doc of [...DEMO_PROJECT_DOCUMENTS, ...DEMO_POLICY_DOCUMENTS]) {
    const submission = lifecycle.submit({
      title: doc.title,
      content: doc.content,
      mimeType: "text/plain",
      knowledgeBaseId: doc.knowledgeBaseId,
      // Re-seeding the SAME slug with changed content is a new version of
      // that identity — never a detached document.
      versionIntent: "new_version",
      sourceIdentity: {
        kind: "url",
        uriOrExternalId: sourceUriOf(doc.slug),
        namespace: DEMO_SEED_SOURCE_NAMESPACE,
        tenantId: DEMO_TENANT_ID,
      },
    })
    seededDocIds.push(submission.docId)
    report.documents.push({
      slug: doc.slug,
      knowledgeBaseId: doc.knowledgeBaseId,
      sourceUri: sourceUriOf(doc.slug),
      contentDigest: sha256(doc.content),
      outcome: submission.status === "unchanged" ? "unchanged" : "submitted",
      documentId: submission.docId,
    })
  }
  // Drain to ACTIVATION and verify: the seed promises a usable namespace,
  // so an ingestion that cannot deliver (ES/embedding down) must fail the
  // seed loudly instead of printing success over stuck/failed documents.
  await drainLifecycleUntilCompleted(db, lifecycle, seededDocIds)

  // 3. FAQ entries: skip when THIS entry's deterministic row already exists
  //    (any status — a disabled or edited seed entry must not explode the
  //    re-seed with a primary-key collision). A fresh row conflicts with an
  //    operator-created active entry by normalized question → actionable
  //    error, never a raw 409.
  const faqRepo = new SqliteFaqEntryRepo(db)
  for (const faq of DEMO_FAQ_ENTRIES) {
    const existing = faqRepo.getEntry(faq.id, DEMO_TENANT_ID)
    if (existing) {
      report.faqEntries.push({ id: faq.id, question: faq.question, created: false })
      continue
    }
    const faqService = new FaqEntryServiceImpl({
      repo: faqRepo,
      now,
      generateId: () => faq.id,
    })
    try {
      faqService.create(
        DEMO_TENANT_ID,
        faq.knowledgeBaseId,
        {
          question: faq.question,
          answer: faq.answer,
          source: { title: "演示种子数据", uri: "demo://seed/faq" },
        },
        "demo-seed"
      )
      report.faqEntries.push({ id: faq.id, question: faq.question, created: true })
    } catch (error) {
      if (error instanceof FaqConflictError) {
        throw new Error(
          `seed FAQ "${faq.question}" conflicts with an active entry — resolve or disable it, or run demo:reset first`
        )
      }
      throw error
    }
  }

  // 4. Long-term memory: deterministic id + skip when the exact content
  //    already exists; a full quota is an operator situation, not a crash.
  const memories = new LongTermMemoryStore({
    db,
    now,
    generateId: () => uuidv5("memory/seed", SEED_UUID_NAMESPACE),
  })
  const existingMemories = memories.list(DEMO_TENANT_ID, DEMO_ADMIN_SUBJECT_ID)
  if (!existingMemories.some((memory) => memory.content === DEMO_MEMORY_CONTENT)) {
    try {
      memories.create({
        tenantId: DEMO_TENANT_ID,
        subjectId: DEMO_ADMIN_SUBJECT_ID,
        content: DEMO_MEMORY_CONTENT,
      })
      report.memories.push({
        subjectId: DEMO_ADMIN_SUBJECT_ID,
        contentDigest: sha256(DEMO_MEMORY_CONTENT),
        created: true,
      })
    } catch (error) {
      if (error instanceof MemoryQuotaError) {
        throw new Error(
          `seed memory could not be created: the demo admin's memory quota is full — run demo:reset first`
        )
      }
      throw error
    }
  } else {
    report.memories.push({
      subjectId: DEMO_ADMIN_SUBJECT_ID,
      contentDigest: sha256(DEMO_MEMORY_CONTENT),
      created: false,
    })
  }

  return report
}

/** sha256 of the exact memory content the seed manages (for reset previews). */
export function demoMemoryContentDigest(): string {
  return sha256(DEMO_MEMORY_CONTENT)
}

/** sha256 of one seeded document's content (for reset previews/tests). */
export function demoDocumentDigest(slug: string): string {
  const doc = [...DEMO_PROJECT_DOCUMENTS, ...DEMO_POLICY_DOCUMENTS].find(
    (entry) => entry.slug === slug
  )
  if (!doc) throw new Error(`unknown demo seed document: ${slug}`)
  return sha256(doc.content)
}
