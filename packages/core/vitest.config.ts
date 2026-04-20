import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 30000,
    minWorkers: 1,
    maxWorkers: 1,
    // Keep tests in-process by default. Many tests mock the LLM provider and
    // expect runSubAgent to execute in the same process so the mock intercepts
    // the call. Production runs without this env var and gets the new
    // agents.defaultContainerized=true behavior.
    env: {
      STARLINGAI_DEFAULT_CONTAINERIZED: "false",
    },
  },
});
