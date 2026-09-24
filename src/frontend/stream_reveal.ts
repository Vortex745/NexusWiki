/**
 * Perceptual pacing for streamed answer text.
 *
 * The transport already publishes SSE token deltas; what it cannot control is
 * *when* a whole answer arrives. Knowledge routes withhold draft tokens until
 * the Critic approves, so their replay lands as one frame containing the entire
 * reply, and even the live direct route delivers ~100 deltas inside 150ms.
 * Rendering those verbatim shows the answer all at once, which also defeats the
 * per-word blur-in (`t-stream-w`) that only plays when words mount separately.
 */

/** Reveal one character per animation frame for a literal typing cadence. */
export const MAX_REVEAL_PER_FRAME = 1

/**
 * Characters to reveal on this tick. A fixed one-character step makes both a
 * burst response and live token deltas use the same visible typing cadence.
 */
export function revealStep(
  shown: number,
  target: number,
  elapsedMs: number,
): number {
  const backlog = target - shown
  if (backlog <= 0 || elapsedMs <= 0) return 0
  return Math.min(backlog, MAX_REVEAL_PER_FRAME)
}
