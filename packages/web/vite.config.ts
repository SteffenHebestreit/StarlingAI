import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three"],
          markdown: ["marked", "dompurify"],
        },
      },
    },
  },
  server: {
    port: 3001,
    proxy: {
      "/api": { target: "http://localhost:8765", changeOrigin: true },
      "/ws": { target: "ws://localhost:8765", ws: true },
    },
  },
});
