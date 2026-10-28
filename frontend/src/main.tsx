import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

// The Tailwind entry must load before any component module: its cascade-layer
// pre-declaration (@layer theme, base, components, utilities) has to register
// first, or the first component CSS module (which ships its own
// `@layer components` block) reorders the layers and lets preflight override
// component styles in dev, where every module is a separate stylesheet.
import "./styles/index.css"
import "@/components/arc/foundation.css"
import { App } from "./App"

const container = document.getElementById("root")
if (!container)
  throw new Error("Root container #root is missing from index.html")

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
