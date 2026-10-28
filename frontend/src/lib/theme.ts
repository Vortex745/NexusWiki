import { useCallback, useRef, useState } from "react"

const THEME_STORAGE_KEY = "kefu-rag-theme"

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<unknown> }
}

export function useTheme() {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"))
  const transitionId = useRef(0)

  const toggleTheme = useCallback(() => {
    const next = !document.documentElement.classList.contains("dark")
    let applied = false
    const apply = () => {
      if (applied) return
      applied = true
      document.documentElement.classList.toggle("dark", next)
      document.documentElement.dataset.theme = next ? "dark" : "light"
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next ? "dark" : "light")
      } catch {
        // Persisting the preference is best-effort.
      }
      setIsDark(next)
    }

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const doc = document as ViewTransitionDocument
    if (reduced || !doc.startViewTransition) {
      apply()
      return
    }

    const id = ++transitionId.current
    document.documentElement.dataset.themeMotion = "reveal"
    const clear = () => {
      if (transitionId.current === id) delete document.documentElement.dataset.themeMotion
    }
    try {
      const transition = doc.startViewTransition(apply)
      void transition.finished.then(clear, clear)
    } catch {
      clear()
      apply()
    }
  }, [])

  return { isDark, toggleTheme }
}
