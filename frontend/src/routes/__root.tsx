import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router"

import "../styles/index.css"
import "@/components/arc/foundation.css"
import { AppProviders } from "@/App"

const themeBootstrap = `try {
  const dark = localStorage.getItem("kefu-rag-theme") === "dark"
  document.documentElement.classList.toggle("dark", dark)
  document.documentElement.dataset.theme = dark ? "dark" : "light"
} catch {}`

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1.0, viewport-fit=cover" },
      { name: "theme-color", content: "#f8fafc" },
      { title: "NexusWiki · 企业知识智能助手" },
    ],
    links: [
      {
        rel: "icon",
        href: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23111111'/%3E%3Ctext x='16' y='22' font-family='sans-serif' font-size='16' font-weight='600' fill='white' text-anchor='middle'%3EN%3C/text%3E%3C/svg%3E",
      },
    ],
    scripts: [{ children: themeBootstrap }],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <html lang="zh-CN" data-accent="neutral" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body suppressHydrationWarning>
        <AppProviders>
          <Outlet />
        </AppProviders>
        <Scripts />
      </body>
    </html>
  )
}
