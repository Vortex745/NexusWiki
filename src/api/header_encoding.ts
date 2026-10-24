/**
 * UTF-8 text traveling in an HTTP header. Browser fetch clients must
 * percent-encode header values that can contain non-Latin-1 characters
 * (Chinese file names are the norm here) because the Headers constructor
 * throws on them before a request is ever sent. The decode side tolerates
 * the raw form too, so older or non-browser callers keep working unchanged.
 */
export function decodeUtf8HeaderValue(value: string | undefined): string {
  const raw = value ?? ""
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}
