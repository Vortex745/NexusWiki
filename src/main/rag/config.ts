export const SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1'
export const MODEL_OCR = 'deepseek-ai/DeepSeek-OCR'
export const MODEL_LLM = 'deepseek-ai/DeepSeek-V4.1-Flash'
export const MODEL_DECISION = 'SemIf'
export const OCR_MIN_TEXT_CHARS = 50
export const OCR_PROMPT = '<|grounding|>Convert the document to markdown.'
export const CHUNK_MAX_CHARS = 1200
export const SUMMARY_SOURCE_CHARS = 2000
export const JUDGE_EXCERPT_CHARS = 3000
export const K_DOCS = 10
export const TOP_R = 8
export const CHOICE_M = 5
export const MAX_QUESTIONS_PER_REQUEST = 50
// 实测阈值：state ≤6k 字符稳定通过，≥9k 稳定 503 过载（顺序单发亦复现）——分批上限压到 6k
export const MAX_STATE_CHARS = 6000
// SemIf Alpha 实测 TPM ~60k tokens/min：190 段全量打分 ~38 请求必 429，大文档先组筛再打分（论文 §3.4 MTRAG 同款）
export const GROUP_SIZE = 48
export const GROUP_THRESHOLD = 60
export const GROUPS_PER_DOC = 1
