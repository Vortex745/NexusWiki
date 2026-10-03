// UT-04：联合激活门槛（fail-closed）。
//
// 规格契约（UP-08 / UT-04）：新候选只有在内容完整性凭证与索引核验凭证同时
// 存在且匹配时才允许切换活动身份；缺任一凭证时——阶段成功、自动激活和人工
// 批准都不得激活。凭证由后续票（UT-15 内容凭证、UT-16 索引核验、UT-17 联合
// 激活）产出；本票只安装拒绝路径，不允许伪造凭证让正向路径提前变绿。
//
// 理由码是稳定契约（UT-26 的状态呈现会消费），不得改动语义只可新增。

export const ACTIVATION_EVIDENCE_SCHEMA_VERSION = 1

/** 理由码：缺联合激活证据记录本身。 */
export const ACTIVATION_BLOCKED_EVIDENCE_RECORD_MISSING =
  "activation_evidence_record_missing"
/** 理由码：证据记录的 schema 版本不被当前代码识别。 */
export const ACTIVATION_BLOCKED_EVIDENCE_SCHEMA_MISMATCH =
  "activation_evidence_schema_mismatch"
/** 理由码：缺内容完整性凭证（UT-15 产出）。 */
export const ACTIVATION_BLOCKED_CONTENT_PROOF_MISSING =
  "activation_content_proof_missing"
/** 理由码：缺索引核验凭证（UT-16 产出）。 */
export const ACTIVATION_BLOCKED_INDEX_PROOF_MISSING =
  "activation_index_proof_missing"
/**
 * 理由码：内容完整性待校验（UT-15）。内容凭证存在但其结论不是 pass——
 * 理由码数组随后附内容凭证自身的明细码（漏页/乱码/结构风险等）。
 */
export const ACTIVATION_BLOCKED_CONTENT_PROOF_PENDING_REVIEW =
  "activation_content_proof_pending_review"
/**
 * 理由码：索引核验未通过（UT-16）。索引凭证存在但其结论不是 pass——
 * 理由码数组随后附索引凭证自身的明细码（丢块/正文不匹配/缺向量等）。
 */
export const ACTIVATION_BLOCKED_INDEX_PROOF_FAILED =
  "activation_index_proof_failed"
/**
 * 理由码：凭证核验语义尚未实现（UT-17 引入联合核验）。即使两类凭证都在，
 * 本票也不放行——拒绝路径先行、正向路径由后续票提供，是用户确认的批次设计。
 */
export const ACTIVATION_BLOCKED_VERIFICATION_NOT_IMPLEMENTED =
  "activation_gate_verification_not_implemented"

export interface ActivationEvidenceRecord {
  schemaVersion: number
  /** 内容完整性凭证（提取/清洗/切块证据的联合结论）——UT-15 的产出。 */
  contentProof: unknown
  /** 索引核验凭证（期望条目/哈希/可见性/探针的联合结论）——UT-16 的产出。 */
  indexProof: unknown
}

export interface ActivationGateDecision {
  passed: boolean
  /** 机器可读理由码（稳定契约）。 */
  reasonCodes: string[]
  /** 单条可读摘要（全部理由码拼接）。 */
  reason: string | null
}

function denied(reasonCodes: string[]): ActivationGateDecision {
  return {
    passed: false,
    reasonCodes,
    reason: reasonCodes.join(";"),
  }
}

/**
 * 评估联合激活门槛。evidence 是 documents.candidate_evidence 的解析值
 * （未设置时为 null）。本函数绝不产出"通过"——在 UT-15/16/17 引入真实
 * 凭证产出者之前，一切候选都被拒绝；这是用户已确认的早期护栏顺序
 * （early_guard_then_proofs）：中间票不得临时放开激活。
 */
export function evaluateActivationGate(evidence: unknown): ActivationGateDecision {
  if (evidence === null || evidence === undefined) {
    return denied([ACTIVATION_BLOCKED_EVIDENCE_RECORD_MISSING])
  }
  if (typeof evidence !== "object" || Array.isArray(evidence)) {
    return denied([ACTIVATION_BLOCKED_EVIDENCE_SCHEMA_MISMATCH])
  }
  const record = evidence as Record<string, unknown>
  if (record.schemaVersion !== ACTIVATION_EVIDENCE_SCHEMA_VERSION) {
    return denied([ACTIVATION_BLOCKED_EVIDENCE_SCHEMA_MISMATCH])
  }
  // Ticket UT-15: content verification comes FIRST so the reported reasons
  // stay precise — a pending_review content verdict is the uploader's real
  // blocker, not the (still always-missing) index proof.
  const contentProof = record.contentProof as {
    verdict?: unknown
    reasonCodes?: unknown
  }
  if (record.contentProof === null || record.contentProof === undefined) {
    return denied([ACTIVATION_BLOCKED_CONTENT_PROOF_MISSING])
  }
  if (
    typeof contentProof !== "object" ||
    (contentProof.verdict !== "pass" && contentProof.verdict !== "pending_review")
  ) {
    return denied([ACTIVATION_BLOCKED_EVIDENCE_SCHEMA_MISMATCH])
  }
  if (contentProof.verdict !== "pass") {
    const detailCodes = Array.isArray(contentProof.reasonCodes)
      ? (contentProof.reasonCodes as unknown[]).filter(
          (code): code is string => typeof code === "string"
        )
      : []
    return denied([ACTIVATION_BLOCKED_CONTENT_PROOF_PENDING_REVIEW, ...detailCodes])
  }

  // 内容凭证为 pass：只有进入索引核验资格，绝不直接激活。
  if (record.indexProof === null || record.indexProof === undefined) {
    return denied([ACTIVATION_BLOCKED_INDEX_PROOF_MISSING])
  }
  // Ticket UT-16: index verification. The index proof must be a valid pass —
  // a fail (missing chunks, content mismatch, missing vectors) denies with
  // its own detail codes. 条目核验仍不等于检索可见：可见性/检索探针的联合
  // 语义由 UT-17 加入（当前保持显式拒绝）。
  const indexProof = record.indexProof as {
    verdict?: unknown
    reasonCodes?: unknown
  }
  if (
    typeof indexProof !== "object" ||
    (indexProof.verdict !== "pass" && indexProof.verdict !== "fail")
  ) {
    return denied([ACTIVATION_BLOCKED_EVIDENCE_SCHEMA_MISMATCH])
  }
  if (indexProof.verdict !== "pass") {
    const detailCodes = Array.isArray(indexProof.reasonCodes)
      ? (indexProof.reasonCodes as unknown[]).filter(
          (code): code is string => typeof code === "string"
        )
      : []
    return denied([ACTIVATION_BLOCKED_INDEX_PROOF_FAILED, ...detailCodes])
  }
  return denied([ACTIVATION_BLOCKED_VERIFICATION_NOT_IMPLEMENTED])
}
