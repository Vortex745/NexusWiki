/**
 * Perceptual pacing for streamed answer text.
 *
 * The transport already publishes SSE token deltas; what it cannot control is
 * *when* a whole answer arrives. Knowledge routes withhold draft tokens until
 * the Critic approves, so their replay lands as one frame containing the entire
 * reply, and even the live direct route delivers ~100 deltas inside 150ms.
 * Rendering those verbatim shows the answer all at once, which also defeats the
 * per-word blur-in (`t-stream-w`) that only plays when words mount separately.
 *
 * Revealing one character per frame fixed the burst but paced the wrong unit: a
 * six-letter latin word spent six steps drawing itself, while CJK — one
 * character per token — ran three times faster than the reference cadence. Both
 * effects now advance a whole token per step, and a token is exactly the unit
 * the blur-in animates, so a word never renders half-written.
 */

/**
 * Tokenizes the streamed text for both the reveal cadence and the per-word
 * blur-in. Whitespace runs pass through, latin/digit runs stay whole words, and
 * every other character (CJK, markdown punctuation) becomes its own token —
 * Chinese has no spaces, so a space-split would collapse a whole paragraph into
 * one "word" and neither the pacing nor the effect would ever show.
 */
export const STREAM_TOKEN_PATTERN = /(\s+|[A-Za-z0-9@.#_/\\-]+|.)/gu

/**
 * Milliseconds a token holds the reader before the next one is exposed.
 *
 * This is coupled to `--stream-fade` in styles/index.css: the number of tokens
 * animating at once is `fade / step`, and that ratio — not either value alone —
 * is what makes the arrival read as words appearing. ~6-7 overlapping tokens is a
 * soft cascade; ~16 turns the frontier into one blurred band. Speeding this up
 * without shortening the fade is what breaks the effect, so the two move together.
 */
export const REVEAL_TOKEN_MS = 22

/**
 * Ticks a full reveal is spread over at most. At the bare reference cadence an
 * answer hundreds of tokens long would take tens of seconds to finish typing,
 * so a backlog releases several tokens per tick instead of stretching the
 * window: the step is sized off the *whole* reply, which drains it in roughly
 * this many ticks (~0.4s) whatever its length. Sizing it off what is left instead
 * decays geometrically and spends two minutes on a long answer.
 */
export const REVEAL_MAX_TICKS = 18

/** Whether a streamed token carries no glyph, i.e. it is a whitespace run. */
export function isStreamWhitespace(token: string): boolean {
  return /^\s+$/.test(token)
}

export function streamTokens(text: string): string[] {
  return text.match(STREAM_TOKEN_PATTERN) ?? []
}

/**
 * Character offset at the end of every token, with an immediately following
 * whitespace run absorbed into the token before it. Without the absorption the
 * reveal would spend whole ticks exposing spaces — no new glyph, no visible
 * motion — and the caret would sit on an unwritten word.
 */
export function tokenBoundaries(text: string): number[] {
  const boundaries: number[] = []
  let position = 0
  for (const token of streamTokens(text)) {
    position += token.length
    if (isStreamWhitespace(token)) {
      if (boundaries.length > 0) boundaries[boundaries.length - 1] = position
    } else {
      boundaries.push(position)
    }
  }
  return boundaries
}

function countTokensAtOrAfter(shown: number, boundaries: readonly number[]): number {
  let low = 0
  let high = boundaries.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (boundaries[mid] > shown) high = mid
    else low = mid + 1
  }
  return boundaries.length - low
}

/**
 * The offset to reveal up to after `tokenTicks` tokens are due. Never returns a
 * value ahead of the final boundary, so the last token lands exactly at
 * `target` rather than overshooting the string.
 */
export function revealTo(
  shown: number,
  target: number,
  tokenTicks: number,
  boundaries: readonly number[],
): number {
  const remaining = countTokensAtOrAfter(shown, boundaries)
  if (remaining <= 0 || tokenTicks <= 0) return shown
  const tokens = Math.min(
    remaining,
    Math.max(tokenTicks, Math.ceil(boundaries.length / REVEAL_MAX_TICKS)),
  )
  const index = boundaries.length - remaining + tokens - 1
  return Math.min(boundaries[index], target)
}
