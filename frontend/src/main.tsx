import { TooltipProvider } from "./components/primitives/tooltip"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "./App"
import "./styles/index.css"
import "@/components/arc/foundation.css"

const container = document.getElementById("root")
if (!container)
  throw new Error("Root container #root is missing from index.html")

createRoot(container).render(
  <StrictMode>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </StrictMode>,
)
