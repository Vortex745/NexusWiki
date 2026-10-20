/**
 * LO-07/LO-08 content policy for model observations.
 *
 * Two different rules live here, and they must not be confused:
 *   - Runtime LOGS keep an 8 KiB ceiling per record (LO-03).
 *   - Generation CONTENT is the product of the model call: it is recorded in
 *     full (bounded only by the 1 MiB observation ceiling), because a truncated
 *     prompt is worse than no prompt.
 *
 * What is removed, always:
 *   - inline images (`data:image/...;base64,...`) — the reference asks for the
 *     image's presence, not its bytes;
 *   - credentials that leak into prompt text (bearer tokens, sk-/pk- keys,
 *     password/api-key assignments), and private-key blocks.
 *
 * Deliberately NOT here: a general PII cleaner and a chat-length cap. Both are
 * explicitly out of scope (LG-07-AC07).
 */

const IMAGE_DATA_URL = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi
const API_KEY_ASSIGNMENT =
  /\b(api[_-]?key|access[_-]?token|secret[_-]?key|password|passwd|pwd|authorization|cookie)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi
const KNOWN_KEY = /\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g

export function scrubText(text: string): string {
  return text
    .replace(PRIVATE_KEY_BLOCK, "[private key omitted]")
    .replace(IMAGE_DATA_URL, (match) => `[image omitted: ${match.length} chars]`)
    .replace(BEARER, "$1 [redacted]")
    .replace(API_KEY_ASSIGNMENT, "$1=[redacted]")
    .replace(KNOWN_KEY, "[redacted]")
}

/** Serialise any prompt/reply value, scrubbing it on the way out. */
export function scrubModelContent(value: unknown): string {
  if (typeof value === "string") return scrubText(value)
  if (value === undefined) return ""
  try {
    return scrubText(JSON.stringify(value, circularSafeReplacer()) ?? String(value))
  } catch {
    return scrubText(String(value))
  }
}

function circularSafeReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>()
  return (_key, value) => {
    if (value !== null && typeof value === "object") {
      if (seen.has(value as object)) return "[circular]"
      seen.add(value as object)
    }
    return value
  }
}
