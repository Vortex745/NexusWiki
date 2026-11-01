import { ACCENTS, accentChain, createShader, playSweep } from "glimm"
import type { SweepHandle } from "glimm"
import { useCallback, useEffect, useRef } from "react"
import type { RefObject } from "react"

/**
 * A true full-spectrum chain. glimm's built-in `prism` palette only runs
 * cyan→indigo→magenta, which reads as a blue/purple wipe rather than a rainbow.
 */
const SWEEP_PALETTE = accentChain([
  ACCENTS.red,
  ACCENTS.orange,
  ACCENTS.yellow,
  ACCENTS.green,
  ACCENTS.cyan,
  ACCENTS.blue,
  ACCENTS.purple,
])

const SWEEP_MS = 570
const OUTRO_MS = 80
/** Above 1 so the band briefly goes fully opaque mid-sweep. Drop toward 0.55 for
 *  a tint instead of a flash. */
const PEAK_ALPHA = 1.3
/** Keep lower on dark surfaces, where the iridescent crest reads as harsh white. */
const BRIGHTNESS = 1.4

/**
 * `createShader` seeds its hue phase with `Math.random() * 0.4`, so the same
 * action lands on a different colour order every reload. Pinning it for the
 * construction alone makes the sweep reproducible.
 */
function withPinnedHuePhase<T>(build: () => T): T {
  const random = Math.random
  Math.random = () => 0
  try {
    return build()
  } finally {
    Math.random = random
  }
}

/**
 * Returns a `celebrate` that fires one rainbow band across the given canvas.
 *
 * Both reduced motion and an unavailable WebGL context resolve to "nothing
 * happens" — the interaction that triggered the sweep has already taken effect
 * by then, and neither path may block it.
 */
export function useAccentSweep(canvasRef: RefObject<HTMLCanvasElement | null>): () => void {
  const shaderRef = useRef<ReturnType<typeof createShader>>(null)
  const sweepRef = useRef<SweepHandle | null>(null)

  useEffect(
    () => () => {
      sweepRef.current?.cancel()
      shaderRef.current?.destroy()
      shaderRef.current = null
      sweepRef.current = null
    },
    [],
  )

  return useCallback(() => {
    // glimm's core does not check this itself — its dist reads contain no
    // matchMedia call at all — so the guard belongs here.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const canvas = canvasRef.current
    if (!canvas) return

    // The previous sweep is cancelled rather than waited out. A lock would wedge:
    // `done` only settles on an animation frame, so a tab backgrounded mid-sweep
    // would never accept another celebration. Cancelling also makes the last
    // click win during rapid clicking.
    sweepRef.current?.cancel()
    // Rebuilt per sweep so the shader clock restarts and every celebration is
    // identical, instead of continuing to drift from whenever it was first made.
    shaderRef.current?.destroy()
    const shader = withPinnedHuePhase(() =>
      createShader({
        canvas,
        palette: SWEEP_PALETTE,
        direction: "ltr",
        bandTight: 10,
        swellAmount: 0.85,
      }),
    )
    shaderRef.current = shader
    if (!shader) return

    const sweep = playSweep(shader, {
      palette: SWEEP_PALETTE,
      direction: "ltr",
      sweepMs: SWEEP_MS,
      outroMs: OUTRO_MS,
      peakAlpha: PEAK_ALPHA,
      bandTight: 10,
      brightness: BRIGHTNESS,
      swellAmount: 1,
      waveSpeed: 1.8,
      easing: "easeOutExpo",
    })
    sweepRef.current = sweep
    sweep.done.then(
      () => {
        if (sweepRef.current === sweep) sweepRef.current = null
      },
      () => {
        if (sweepRef.current === sweep) sweepRef.current = null
      },
    )
  }, [canvasRef])
}
