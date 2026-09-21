/**
 * Eval refactor Ticket 04 — built-in sample datasets (static project assets).
 *
 * The page can run one of these without uploading anything (spec US #2
 * "选择内置样例，以便快速验证服务是否可用"). Every passage listed here IS
 * ingested — including the distractors — so the measured precision reflects
 * real ranking, not a corpus of one.
 *
 * Ticket 09 adds the multi-case built-in; until then a single-case sample is
 * the only shape the service accepts.
 */

import { evalDatasetDigest, type EvalDataset } from "./dataset"

export interface BuiltinEvalDataset {
  id: string
  dataset: EvalDataset
  /** One-line page description. */
  description: string
}

const REFUND_SAMPLE: EvalDataset = {
  schemaVersion: 1,
  name: "退款与售后（内置单题）",
  version: "1.0.0",
  corpus: [
    {
      passageId: "refund-policy",
      title: "退款到账时效",
      content:
        "退款政策：客户在签收后 7 天内可以申请无理由退款。审核通过后，退款将在 3 个工作日内按原支付路径返还；如遇节假日，到账时间顺延。超过 7 天的订单不支持无理由退款，但可申请质量问题退换。",
    },
    {
      passageId: "shipping-policy",
      title: "配送时效说明",
      content:
        "配送说明：标准配送需要 2 至 4 个工作日，偏远地区可能延长至 6 个工作日。订单满 99 元免运费，未满则收取 8 元基础运费。",
    },
    {
      passageId: "warranty-policy",
      title: "保修范围",
      content:
        "保修范围：电子产品自购买之日起享有一年保修，人为损坏不在保修范围内。保修需要提供订单号与故障描述。",
    },
    {
      passageId: "invoice-policy",
      title: "发票开具说明",
      content:
        "发票说明：支持开具电子发票，下单时可以选择个人或单位抬头。发票一般在订单完成后 24 小时内发送到预留邮箱。",
    },
  ],
  cases: [
    {
      caseId: "refund-eta",
      question: "退款一般需要多久才能到账？",
      referenceAnswer: "退款在审核通过后 3 个工作日内按原支付路径返还，遇节假日顺延。",
      relevantPassageIds: ["refund-policy"],
      tags: ["售后"],
    },
  ],
}

/**
 * Ticket 09: the same corpus with three questions, so a batch run (bounded
 * concurrency, per-case progress) can be exercised without uploading anything.
 */
const REFUND_BATCH_SAMPLE: EvalDataset = {
  ...REFUND_SAMPLE,
  name: "退款与售后（内置三题）",
  version: "1.1.0",
  cases: [
    ...REFUND_SAMPLE.cases,
    {
      caseId: "shipping-eta",
      question: "标准配送一般需要多久？",
      referenceAnswer: "标准配送需要 2 至 4 个工作日，偏远地区可能延长至 6 个工作日。",
      relevantPassageIds: ["shipping-policy"],
      tags: ["物流"],
    },
    {
      caseId: "warranty-scope",
      question: "电子产品的保修期和保修范围是什么？",
      referenceAnswer: "电子产品自购买之日起享有一年保修，人为损坏不在保修范围内。",
      relevantPassageIds: ["warranty-policy"],
      tags: ["售后"],
    },
  ],
}

export const BUILTIN_EVAL_DATASETS: readonly BuiltinEvalDataset[] = [
  {
    id: "refund-single-case",
    dataset: REFUND_SAMPLE,
    description: "退款政策语料 + 1 个问题，含 3 条干扰段落",
  },
  {
    id: "refund-batch-3",
    dataset: REFUND_BATCH_SAMPLE,
    description: "同一份语料 + 3 个问题，用于批量运行与逐题进度",
  },
]

export function getBuiltinEvalDataset(id: string): BuiltinEvalDataset | undefined {
  return BUILTIN_EVAL_DATASETS.find((entry) => entry.id === id)
}

/** Page-facing descriptors (no corpus/case bodies — keeps the list light). */
export function listBuiltinEvalDatasets(): Array<{
  id: string
  name: string
  version: string
  description: string
  contentDigest: string
  caseCount: number
  passageCount: number
}> {
  return BUILTIN_EVAL_DATASETS.map(({ id, dataset, description }) => ({
    id,
    name: dataset.name,
    version: dataset.version,
    description,
    contentDigest: evalDatasetDigest(dataset),
    caseCount: dataset.cases.length,
    passageCount: dataset.corpus.length,
  }))
}
