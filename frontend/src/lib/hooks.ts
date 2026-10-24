import { useEffect, useState } from "react"

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  )

  useEffect(() => {
    const mediaQueryList = window.matchMedia(query)
    const handler = (event: MediaQueryListEvent) => setMatches(event.matches)
    mediaQueryList.addEventListener("change", handler)
    setMatches(mediaQueryList.matches)
    return () => mediaQueryList.removeEventListener("change", handler)
  }, [query])

  return matches
}
