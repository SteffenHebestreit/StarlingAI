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
  },
});
