/**
 * Convert the committed TS golden set (src/evaluation/golden/fixtures.ts)
 * into DeepEval ConversationalGoldens at tests/evals/.dataset.json.
 *
 * This is a format migration of an existing reviewed dataset, not new
 * hand-written goldens: every scenario/expected_outcome below is derived
 * mechanically from the TS case fields (category, userMessage,
 * expectedRoute, requiredCoverageCriteria, handoffAcceptable, notes).
 *
 * Usage: npx tsx tests/evals/convert_ts_goldens.mts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GOLDEN_SET } from "../../src/evaluation/golden/fixtures.js";
import type { GoldenCase } from "../../src/evaluation/types.js";

const SITUATION: Record<GoldenCase["category"], string> = {
  direct: "用户向企业知识助手闲聊或询问常识",
  simple: "员工咨询一条公司政策，需要单份资料作答",
  complex: "员工提出需要多份政策交叉分析的复杂问题",
  ambiguous: "用户只发了一句含糊、没有明确主题的消息，其真实需求需要追问才能明确",
  insufficient: "员工询问的政策在知识库中可能缺失、过期或不完整",
  correction: "员工提出复杂问题，并会在多轮对话中追问、纠正、补全细节",
};

function toScenario(c: GoldenCase): string {
  return `[${c.id}] ${SITUATION[c.category]}。用户首句话：“${c.userMessage}”`;
}

function toExpectedOutcome(c: GoldenCase): string {
  const parts: string[] = [];
  if (c.expectedRoute) parts.push(`预期路由为 ${c.expectedRoute}`);
  if (c.requiredCoverageCriteria?.length) {
    parts.push(`回答应覆盖要点：${c.requiredCoverageCriteria.join("、")}`);
  }
  parts.push(
    c.handoffAcceptable
      ? "若证据不足或问题超出知识范围，承认缺口或转人工是可接受的终态"
      : "不应转人工，应直接给出答案",
  );
  if (c.notes) parts.push(`备注：${c.notes}`);
  return parts.join("；");
}

const goldens = GOLDEN_SET.cases.map((c) => ({
  scenario: toScenario(c),
  expected_outcome: toExpectedOutcome(c),
  user_description: "使用中文的企业知识库用户",
}));

const outDir = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(outDir, ".dataset.json"), JSON.stringify(goldens, null, 2), "utf-8");
console.log(`wrote ${goldens.length} conversational goldens (dataset ${GOLDEN_SET.version})`);
