import { defineConfig } from "vitest/config";
import { resolve } from "path";

// Unit tests for the web package's pure modules (composables written free of Vue and of the
// store, e.g. composables/turnSteps.ts). Kept apart from vite.config.ts so a test run does not
// load the PWA build plugin. Runs with `pnpm --filter @starlingai/web test`, and in CI through
// `pnpm -r --filter '!@starlingai/core' test`.
export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
