/**
 * Build the DeepEval dataset from the live-aligned release gate
 * (golden/demo-release-cases.v1.json, 20 cases over the deterministic demo
 * corpus).
 *
 * Why this source: the TS fixtures (src/evaluation/golden/fixtures.ts)
 * reference synthetic source IDs (source-onboarding-v2, ...) absent from the
 * live index, so knowledge questions over them always end in "insufficient
 * evidence" through no fault of the app. The demo-gate cases carry a real
 * message + knowledgeBaseIds scope + expected-behavior rule each — exactly
 * what a single-turn traced eval needs. Reuse of an existing reviewed
 * dataset, not hand-written goldens.
 *
 * Output Golden fields: name (gate id, for -k filtering), input (message),
 * expected_output (behavior rule), additional_metadata.scope (retrieval
 * scope; [] = explicitly empty and must refuse).
 *
 * Usage: npx tsx tests/evals/convert_demo_gate.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface GateCase {
  id: string;
  kind: "answer" | "refuse" | "memory-not-cited";
  hard: boolean;
  message: string;
  reason: string;
  knowledgeBaseIds: string[];
}

const KIND_OUTCOME: Record<GateCase["kind"], string> = {
  answer: "应在知识范围内作答，引用命中的资料或 FAQ 标准答案",
  refuse: "必须拒绝作答或明确承认超出范围，绝不编造",
  // Mirrors the gate's own rule (release-quality-gate.ts): the ONLY
  // requirement is that memory content never appears in the references.
  // Memory may inform the reply background; a handoff (no references at
  // all) satisfies the rule just as well — do NOT demand an answer.
  "memory-not-cited":
    "引用列表中绝不能出现长期记忆内容（记忆只可作为背景影响回答）；无引用的转人工同样满足要求，不强制作答",
};

const raw = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../golden/demo-release-cases.v1.json"), "utf-8"),
) as { version: number; cases: GateCase[] };

const goldens = raw.cases.map((c) => ({
  name: c.id,
  input: c.message,
  expected_output: `${KIND_OUTCOME[c.kind]}。判定规则：${c.reason}`,
  additional_metadata: {
    gate_id: c.id,
    kind: c.kind,
    hard: c.hard,
    scope: c.knowledgeBaseIds,
  },
}));

const outDir = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(outDir, ".dataset.json"), JSON.stringify(goldens, null, 2), "utf-8");
console.log(`wrote ${goldens.length} goldens (demo gate v${raw.version})`);
