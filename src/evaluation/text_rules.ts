/**
 * Eval refactor Ticket 07/08 — the fixed text rules shared by BLEU (07) and
 * ROUGE (08).
 *
 * One normalization + tokenization contract, version-stamped, so every
 * generation-side metric compares the same token sequences and the page can
 * explain what "similar" means here. Deliberately dependency-free: no Python,
 * no RAGAS, no segmentation service, no per-run configuration.
 *
 * Rules (fixed; both metrics read them):
 *   1. Normalize: Unicode NFKC, then lower-case (case folding), then replace
 *      every punctuation/symbol with a separator and collapse whitespace.
 *   2. Tokenize: each run of latin letters/digits is ONE word token (English
 *      word level); every CJK ideograph / kana / hangul syllable is its own
 *      token (character level — no word segmentation is claimed); anything
 *      else is dropped.
 *
 * Consequence by design: "退款，需要 3 天。" and "退款需要3天" produce the same
 * token sequence, and "Hello, world!" / "hello world" produce the same two
 * word tokens.
 */

export const EVAL_TEXT_RULE_VERSION = "eval-text-v1"

/**
 * One token per match: a latin/digit run (word level) or a single CJK/kana/
 * hangul character (character level).
 */
const TOKEN_PATTERN =
  /[0-9a-z\u00c0-\u024f]+|[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g

/** Lower-cased, punctuation-free text with single spaces between chunks. */
export function normalizeEvalText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** The token sequence both generation metrics score. */
export function tokenizeEvalText(text: string): string[] {
  return normalizeEvalText(text).match(TOKEN_PATTERN) ?? []
}
