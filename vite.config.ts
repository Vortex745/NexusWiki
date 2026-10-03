import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const repoRoot = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
  root: "frontend",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./frontend/src", import.meta.url)),
      // The chat state core lives with the backend tests; Vite consumes the
      // same TypeScript source directly so there is only one implementation.
      "@core": fileURLToPath(new URL("./src/frontend", import.meta.url)),
    },
  },
  server: {
    port: 3000,
    strictPort: false,
    proxy: {
      // 127.0.0.1, not "localhost": Node resolves localhost to ::1 first and
      // the proxy then hangs against the IPv4-only backend (UT-31 finding).
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
    fs: {
      allow: [repoRoot],
    },
  },
  build: {
    outDir: "../dist/frontend",
    emptyOutDir: true,
  },
})
