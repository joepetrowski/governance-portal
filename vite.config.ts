import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

// In production, /release-asset is served by the Netlify edge function in
// netlify/edge-functions/release-asset.js. Locally, Vite proxies the same path to GitHub.
const releaseAssetProxy = {
  "/release-asset": {
    target: "https://github.com",
    changeOrigin: true,
    followRedirects: true,
    rewrite: (path: string) =>
      path.replace(/^\/release-asset/, "/polkadot-fellows/runtimes/releases/download"),
  },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: releaseAssetProxy },
  preview: { proxy: releaseAssetProxy },
  // The tests decode recorded calls against the bundled metadata, so they need no network.
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
})
