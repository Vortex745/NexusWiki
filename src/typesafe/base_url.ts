/** The SDK appends `/v1` to its configured API root. Accept either form in settings. */
export function normalizeTypeSafeBaseUrl(baseURL: string): string {
  return baseURL.trim().replace(/\/v1\/?$/i, "")
}
