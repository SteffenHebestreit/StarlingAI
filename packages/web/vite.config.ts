import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";
import { resolve } from "path";

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      registerType: "autoUpdate",
      // Cache the SPA shell + Vite-emitted assets so the chat UI loads
      // when the gateway is briefly unreachable. /api/** and /ws are not
      // cached — they always go to the network so live data stays fresh.
      includeAssets: ["swarmLogo.svg"],
      workbox: {
        navigateFallback: "/index.html",
        // Don't intercept gateway traffic.
        navigateFallbackDenylist: [/^\/api\//, /^\/ws/],
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: "NetworkOnly",
          },
          {
            urlPattern: /^\/ws/,
            handler: "NetworkOnly",
          },
        ],
        // Bump cap so the chat chunk (currently ~760 KB after highlight.js
        // languages and cytoscape) precaches without warning.
        maximumFileSizeToCacheInBytes: 4_000_000,
      },
      manifest: {
        name: "StarlingAI",
        short_name: "Starling",
        description: "Self-hosted AI agent swarm — chat, scenes, and operator dashboards.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#0a0512",
        theme_color: "#7c3aed",
        orientation: "any",
        icons: [
          {
            src: "/swarmLogo.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
        // Quick-action shortcuts shown when long-pressing the home-screen
        // icon on Android / iOS. Maps to the existing routes.
        shortcuts: [
          { name: "Chat",    short_name: "Chat",    url: "/",        description: "Start a new chat session" },
          { name: "Jobs",    short_name: "Jobs",    url: "/jobs",    description: "Monitor running scenes and scheduled triggers" },
          { name: "Memory",  short_name: "Memory",  url: "/memory",  description: "Inspect the knowledge graph and memory store" },
          { name: "Sessions", short_name: "Sessions", url: "/sessions", description: "Browse past chat sessions" },
        ],
      },
    }),
  ],
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  build: {
    // es2022 enables top-level await, which @novnc/novnc uses for its WebCodecs
    // H.264 capability probe. Supported by all current evergreen browsers.
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three"],
          markdown: ["marked", "dompurify"],
          novnc: ["@novnc/novnc"],
        },
      },
    },
  },
  optimizeDeps: {
    esbuildOptions: { target: "es2022" },
  },
  server: {
    port: 3001,
    // Lets the containerized Playwright/MCP browser reach the dev server for
    // visual iteration (navigate to http://host.docker.internal:3001).
    allowedHosts: ["host.docker.internal"],
    proxy: {
      "/api": { target: "http://localhost:8765", changeOrigin: true },
      "/ws": { target: "ws://localhost:8765", ws: true },
    },
  },
});
