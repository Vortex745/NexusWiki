import { useCallback, useState } from "react"

const THEME_STORAGE_KEY = "kefu-rag-theme"

export function useTheme() {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"))

  const toggleTheme = useCallback(() => {
    setIsDark((previous) => {
      const next = !previous
      document.documentElement.classList.toggle("dark", next)
      document.documentElement.dataset.theme = next ? "dark" : "light"
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next ? "dark" : "light")
      } catch {
        // Persisting the preference is best-effort.
      }
      return next
    })
  }, [])

  return { isDark, toggleTheme }
}
